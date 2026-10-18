import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { ConfigSchema } from "../src/config/schema.js";
import {
  buildQualityArgs,
  parseQualityFilters,
  parseQualityScore,
  sampleWindows,
} from "../src/transcode/quality.js";

const { measureQualityMock, detectMock } = vi.hoisted(() => ({
  measureQualityMock: vi.fn(),
  detectMock: vi.fn(),
}));

vi.mock("../src/media/ffprobe.js", () => ({
  probeFile: vi.fn(async () => ({
    mediaKind: "video",
    durationSeconds: 600,
    sizeBytes: 1000,
    videoCodec: "h264",
    container: "matroska",
    width: 1920,
    height: 1080,
    resolutionLabel: "1080p",
    audioCodec: "aac",
    audioChannels: 2,
  })),
  detectMidStreamResolutionChanges: vi.fn(async () => ({ hasMultipleResolutions: false, resolutions: [] })),
}));

vi.mock("../src/transcode/runner.js", () => ({
  trackProcess: vi.fn(),
  runTranscodeWithFallback: vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, "small encode");
    return { encoderUsed: "libx265" };
  }),
}));

vi.mock("../src/transcode/verify.js", () => ({
  verifyOutput: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../src/transcode/quality.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/transcode/quality.js")>()),
  detectQualityMetrics: detectMock,
  measureQuality: measureQualityMock,
}));

const { processJob } = await import("../src/queue/worker.js");

describe("quality output parsing", () => {
  it("finds the metric filters in ffmpeg -filters output", () => {
    const output = [
      " ... libvmaf           VV->V      Calculate the VMAF between two video streams.",
      " TS. ssim              VV->V      Calculate the SSIM between two video streams.",
      " ... vmafmotion        V->V       Calculate the VMAF Motion score.",
    ].join("\n");
    expect(parseQualityFilters(output)).toEqual({ vmaf: true, ssim: true });
    expect(parseQualityFilters(output.split("\n").slice(2).join("\n"))).toEqual({ vmaf: false, ssim: false });
  });

  it("reads the score line for each metric", () => {
    expect(parseQualityScore("vmaf", "[Parsed_libvmaf_4 @ 0x5] VMAF score: 94.612345\n")).toBeCloseTo(94.612345);
    expect(
      parseQualityScore("ssim", "[Parsed_ssim_4 @ 0x5] SSIM Y:0.991 (20.4) U:0.99 (20) V:0.99 (20) All:0.987654 (19.08)\n"),
    ).toBeCloseTo(0.987654);
    expect(parseQualityScore("vmaf", "no score here")).toBeUndefined();
  });

  it("samples three clips from long files and the whole file when short", () => {
    expect(sampleWindows(600)).toEqual([
      { start: 90, length: 10 },
      { start: 300, length: 10 },
      { start: 510, length: 10 },
    ]);
    expect(sampleWindows(20)).toEqual([{ start: 0, length: 20 }]);
  });

  it("puts the encode first, as libvmaf and ssim expect", () => {
    const args = buildQualityArgs("vmaf", "/src.mkv", "/out.mkv", { start: 5, length: 10 }, { width: 1920, height: 1080, threads: 4 });
    expect(args.indexOf("/out.mkv")).toBeLessThan(args.indexOf("/src.mkv"));
    expect(args.join(" ")).toContain("[dist][ref]libvmaf=n_threads=4");
    expect(args.join(" ")).toContain("scale=1920:1080");
  });
});

const hasFfmpegSsim = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf-8" }).stdout?.includes(" ssim ") ?? false;

describe.skipIf(!hasFfmpegSsim)("measureQuality with real ffmpeg", () => {
  it("scores a near-lossless encode above a heavily compressed one", async () => {
    const { measureQuality } = await vi.importActual<typeof import("../src/transcode/quality.js")>("../src/transcode/quality.js");
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-quality-"));
    try {
      const source = join(dir, "source.mkv");
      const good = join(dir, "good.mkv");
      const bad = join(dir, "bad.mkv");
      const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
      ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4", "-c:v", "ffv1", source);
      ff("-i", source, "-c:v", "mpeg4", "-q:v", "2", good);
      ff("-i", source, "-c:v", "mpeg4", "-q:v", "31", bad);

      const options = { durationSeconds: 4, width: 320, height: 240, lowPriority: false };
      const goodScore = await measureQuality("ssim", source, good, options);
      const badScore = await measureQuality("ssim", source, bad, options);
      expect(goodScore).toBeGreaterThan(0.95);
      expect(goodScore).toBeLessThanOrEqual(1);
      expect(badScore).toBeLessThan(goodScore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("processJob quality gate", () => {
  let db: DatabaseSync;
  let jobsRepo: JobsRepo;
  let filesRepo: FilesRepo;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shrinkarr-qgate-"));
    db = openDb(join(dir, "test.db"));
    jobsRepo = new JobsRepo(db);
    filesRepo = new FilesRepo(db);
    detectMock.mockResolvedValue({ vmaf: true, ssim: true });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function setup(qualityCheck: "off" | "vmaf" | "ssim") {
    const original = join(dir, "movie.mkv");
    writeFileSync(original, "original bytes that are clearly longer than the encode");
    const config = ConfigSchema.parse({
      presets: [{ id: "p", name: "p", hwaccel: "cpu", qualityCheck, minVmaf: 93, minSsim: 0.97 }],
      queue: { fileStabilityDelaySeconds: 2, minFreeSpaceGb: 0 },
      dbPath: join(dir, "unused.db"),
    });
    const job = jobsRepo.enqueueJob(original, "p", 1000);
    return { original, config, job };
  }

  it("replaces the original when the score meets the minimum", async () => {
    measureQualityMock.mockResolvedValue(95.25);
    const { original, config, job } = setup("vmaf");
    await processJob(job, { config, filesRepo, jobsRepo });

    const done = jobsRepo.getById(job.id);
    expect(done).toMatchObject({ status: "done", qualityMetric: "vmaf", qualityScore: 95.25 });
    expect(readFileSync(original, "utf-8")).toBe("small encode");
  }, 30_000);

  it("keeps the original and stops the watcher re-queueing it when the score is too low", async () => {
    measureQualityMock.mockResolvedValue(0.912);
    const { original, config, job } = setup("ssim");
    await processJob(job, { config, filesRepo, jobsRepo });

    const failed = jobsRepo.getById(job.id);
    expect(failed).toMatchObject({ status: "failed", qualityMetric: "ssim", qualityScore: 0.912 });
    expect(failed?.error).toContain("SSIM 0.9120 is below the preset minimum of 0.97");
    expect(readFileSync(original, "utf-8")).toContain("original bytes");
    expect(existsSync(join(dir, "movie.shrinkarr.tmp.mkv"))).toBe(false);
    expect(filesRepo.getFileByPath(original)?.needsTranscode).toBe(false);
  }, 30_000);

  it("fails with a clear reason when this ffmpeg lacks the metric", async () => {
    detectMock.mockResolvedValue({ vmaf: false, ssim: true });
    const { original, config, job } = setup("vmaf");
    await processJob(job, { config, filesRepo, jobsRepo });

    expect(jobsRepo.getById(job.id)?.error).toContain("no libvmaf filter");
    expect(readFileSync(original, "utf-8")).toContain("original bytes");
    expect(measureQualityMock).not.toHaveBeenCalled();
  }, 30_000);

  it("skips the check when the preset has it off", async () => {
    const { config, job } = setup("off");
    await processJob(job, { config, filesRepo, jobsRepo });
    expect(jobsRepo.getById(job.id)).toMatchObject({ status: "done", qualityScore: null });
    expect(detectMock).not.toHaveBeenCalled();
  }, 30_000);
});
