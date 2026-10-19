import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { buildTempOutputPath, processJob } from "../src/queue/worker.js";
import type { Config } from "../src/config/schema.js";

vi.mock("../src/media/ffprobe.js", () => ({
  probeFile: vi.fn(async () => ({
    mediaKind: "video",
    durationSeconds: 10,
    sizeBytes: 100,
    videoCodec: "h264",
    container: "matroska",
    width: 100,
    height: 100,
    audioCodec: "aac",
  })),
}));

vi.mock("../src/transcode/runner.js", () => ({
  runTranscodeWithFallback: vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, "bogus transcoded content");
    return { usedHwaccel: false };
  }),
  runTranscode: vi.fn(async () => "SSIM Y:0.99 All:0.99 (20.0)"),
}));

const { runVideoQualityGate } = vi.hoisted(() => ({ runVideoQualityGate: vi.fn(async () => ({ ok: true, score: 0.99 })) }));
vi.mock("../src/transcode/qualityGate.js", () => ({ runVideoQualityGate }));

vi.mock("../src/transcode/verify.js", () => ({
  verifyOutput: vi.fn(async () => ({ ok: false, reason: "simulated verify failure" })),
}));

let db: DatabaseSync;
let jobsRepo: JobsRepo;
let filesRepo: FilesRepo;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shrinkarr-atomic-"));
  db = openDb(join(dir, "test.db"));
  jobsRepo = new JobsRepo(db);
  filesRepo = new FilesRepo(db);
});

afterEach(async () => {
  db.close();
  vi.clearAllMocks();
  const { verifyOutput } = await import("../src/transcode/verify.js");
  vi.mocked(verifyOutput).mockReset().mockResolvedValue({ ok: false, reason: "simulated verify failure" });
});

describe("processJob safety", () => {
  it("persists supplemental metadata from a successfully verified output", async () => {
    const originalPath = join(dir, "metadata-movie.mkv");
    writeFileSync(originalPath, "x".repeat(200));
    const outputProbe = {
      mediaKind: "video" as const,
      durationSeconds: 10,
      sizeBytes: 25,
      videoCodec: "hevc",
      container: "matroska",
      width: 100,
      height: 100,
      resolutionLabel: "SD" as const,
      bitrateKbps: 20,
      bitDepth: 10 as const,
      isHdr: true,
      colorTransfer: "smpte2084",
      fps: 23.976,
      audioCodec: "aac",
      audioChannels: 2,
      subtitleCount: 1,
      isLosslessAudio: false,
      audioTracks: [{ index: 1, codec: "aac", channels: 2, language: "eng", isDefault: true }],
      subtitleTracks: [{ index: 2, codec: "subrip", language: "eng", isForced: false }],
    };
    const { verifyOutput } = await import("../src/transcode/verify.js");
    vi.mocked(verifyOutput).mockResolvedValue({ ok: true, probe: outputProbe });
    const config = {
      libraries: [],
      presets: [{ id: "preset-1", name: "test", mediaKind: "video", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", bitDepth: 10, preserveHdr: true, audioMode: "copy", subtitleMode: "copy", targetAudioCodec: "opus", targetAudioBitrateKbps: 160, onlyIfLosslessSource: true, minSavingsPercent: 0, minFileSizeMb: 0, skipAlreadyTarget: true }],
      integrations: {},
      queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1, minFreeSpaceGb: 0, healthCheck: "off", qualityGate: { enabled: true, minimumSsim: 0.95 } },
      dbPath: join(dir, "unused.db"),
    } as Config;
    const job = jobsRepo.enqueueJob(originalPath, "preset-1", 200);

    await processJob(job, { config, filesRepo, jobsRepo });

    expect(filesRepo.getFileByPath(originalPath)?.policyMetadata).toMatchObject({
      mediaKind: "video",
      fps: 23.976,
      colorTransfer: "smpte2084",
      audioTracks: outputProbe.audioTracks,
      subtitleTracks: outputProbe.subtitleTracks,
    });
    expect(runVideoQualityGate).toHaveBeenCalledOnce();
  });

  it("leaves the original file untouched when verification fails", async () => {
    const originalPath = join(dir, "movie.mkv");
    const originalContent = "original bytes, do not touch";
    writeFileSync(originalPath, originalContent);

    const config: Config = {
      libraries: [],
      presets: [
        {
          id: "preset-1",
          name: "test",
          targetCodec: "hevc",
          targetContainer: "mkv",
          crf: 24,
          hwaccel: "cpu",
          minSavingsPercent: 15,
        },
      ],
      integrations: {},
      queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1 },
      dbPath: join(dir, "unused.db"),
    };

    const job = jobsRepo.enqueueJob(originalPath, "preset-1", originalContent.length);

    await processJob(job, { config, filesRepo, jobsRepo });

    expect(readFileSync(originalPath, "utf-8")).toBe(originalContent);

    const tempPath = buildTempOutputPath(originalPath, config.queue.tempSuffix);
    expect(existsSync(tempPath)).toBe(false);

    const updatedJob = jobsRepo.getById(job.id);
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.error).toContain("simulated verify failure");
  });

  it("preserves the original and removes temp output when the quality gate rejects", async () => {
    const originalPath = join(dir, "low-quality.mkv");
    const originalContent = "original bytes, retain this";
    writeFileSync(originalPath, originalContent);
    const { verifyOutput } = await import("../src/transcode/verify.js");
    vi.mocked(verifyOutput).mockResolvedValue({ ok: true, probe: {
      mediaKind: "video", durationSeconds: 10, sizeBytes: 50, videoCodec: "hevc", container: "matroska",
      width: 100, height: 100, resolutionLabel: "SD", bitrateKbps: 20, bitDepth: 8, isHdr: false,
      fps: 24, audioCodec: "aac", audioChannels: 2, subtitleCount: 0,
    } });
    runVideoQualityGate.mockResolvedValueOnce({ ok: false, score: 0.81, reason: "SSIM 0.81000 is below the minimum 0.95000" });
    const config = {
      libraries: [],
      presets: [{ id: "preset-1", name: "test", mediaKind: "video", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", minSavingsPercent: 0 }],
      integrations: {},
      queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1, minFreeSpaceGb: 0, healthCheck: "off", qualityGate: { enabled: true, minimumSsim: 0.95 } },
      dbPath: join(dir, "unused.db"),
    } as Config;
    const job = jobsRepo.enqueueJob(originalPath, "preset-1", originalContent.length);

    await processJob(job, { config, filesRepo, jobsRepo });

    expect(runVideoQualityGate).toHaveBeenCalledOnce();
    expect(readFileSync(originalPath, "utf-8")).toBe(originalContent);
    expect(existsSync(buildTempOutputPath(originalPath, config.queue.tempSuffix))).toBe(false);
    expect(jobsRepo.getById(job.id)?.status).toBe("failed");
    expect(jobsRepo.getById(job.id)?.error).toContain("below the minimum");
  });

  it("does not replace the original when cancellation arrives during output verification", async () => {
    const originalPath = join(dir, "cancel-during-verify.mkv");
    const originalContent = "original bytes, retain this";
    writeFileSync(originalPath, originalContent);
    const controller = new AbortController();
    const { verifyOutput } = await import("../src/transcode/verify.js");
    vi.mocked(verifyOutput).mockImplementationOnce(async () => {
      controller.abort("cancelled");
      return { ok: true, probe: {
        mediaKind: "video", durationSeconds: 10, sizeBytes: 50, videoCodec: "hevc", container: "matroska",
        width: 100, height: 100, resolutionLabel: "SD", bitrateKbps: 20, bitDepth: 8, isHdr: false,
        fps: 24, audioCodec: "aac", audioChannels: 2, subtitleCount: 0,
      } };
    });
    const config = {
      libraries: [],
      presets: [{ id: "preset-1", name: "test", mediaKind: "video", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", minSavingsPercent: 0 }],
      integrations: {},
      queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1, minFreeSpaceGb: 0, healthCheck: "off" },
      dbPath: join(dir, "unused.db"),
    } as Config;
    const job = jobsRepo.enqueueJob(originalPath, "preset-1", originalContent.length);

    await processJob(job, { config, filesRepo, jobsRepo }, controller.signal);

    expect(readFileSync(originalPath, "utf-8")).toBe(originalContent);
    expect(existsSync(buildTempOutputPath(originalPath, config.queue.tempSuffix))).toBe(false);
    expect(jobsRepo.getById(job.id)?.status).toBe("cancelled");
  });

  it("replaces original with transcoded file successfully and removes temp", async () => {
    const { replaceOriginal } = await import("../src/queue/atomicReplace.js");
    const originalPath = join(dir, "movie2.mkv");
    const tempPath = join(dir, "movie2.shrinkarr.tmp.mkv");

    writeFileSync(originalPath, "original content");
    writeFileSync(tempPath, "new transcoded content");

    await replaceOriginal(originalPath, tempPath);

    expect(readFileSync(originalPath, "utf-8")).toBe("new transcoded content");
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(`${originalPath}.shrinkarr.bak`)).toBe(false);
  });

  it("handles cross-directory / SSD scratch replacement safely", async () => {
    const { replaceOriginal } = await import("../src/queue/atomicReplace.js");
    const scratchDir = mkdtempSync(join(tmpdir(), "shrinkarr-scratch-"));
    const originalPath = join(dir, "movie3.mkv");
    const tempPath = join(scratchDir, "movie3-12345.shrinkarr.tmp.mkv");

    writeFileSync(originalPath, "original HDD content");
    writeFileSync(tempPath, "new SSD transcoded content");

    await replaceOriginal(originalPath, tempPath);

    expect(readFileSync(originalPath, "utf-8")).toBe("new SSD transcoded content");
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(`${originalPath}.shrinkarr.bak`)).toBe(false);
  });

  it("moves original backup to recycle bin when recycleBinDir is configured", async () => {
    const { replaceOriginal } = await import("../src/queue/atomicReplace.js");
    const recycleDir = join(dir, "recycle-bin");
    const originalPath = join(dir, "movie4.mkv");
    const tempPath = join(dir, "movie4.shrinkarr.tmp.mkv");

    writeFileSync(originalPath, "original movie 4 content");
    writeFileSync(tempPath, "transcoded movie 4 content");

    await replaceOriginal(originalPath, tempPath, recycleDir);

    expect(readFileSync(originalPath, "utf-8")).toBe("transcoded movie 4 content");
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(`${originalPath}.shrinkarr.bak`)).toBe(false);
    expect(existsSync(recycleDir)).toBe(true);

    const { readdirSync } = await import("node:fs");
    const recycledFiles = readdirSync(recycleDir);
    expect(recycledFiles.length).toBe(1);
    expect(recycledFiles[0]).toContain("movie4.mkv");
    expect(readFileSync(join(recycleDir, recycledFiles[0]), "utf-8")).toBe("original movie 4 content");
  });

  it("refuses a container change that would overwrite an existing sibling file", async () => {
    const { runTranscodeWithFallback } = await import("../src/transcode/runner.js");
    const originalPath = join(dir, "movie5.mkv");
    const siblingPath = join(dir, "movie5.mp4");
    writeFileSync(originalPath, "original mkv");
    writeFileSync(siblingPath, "unrelated mp4 the user keeps");

    const config: Config = {
      libraries: [],
      presets: [
        {
          id: "to-mp4",
          name: "to mp4",
          targetCodec: "hevc",
          targetContainer: "mp4",
          crf: 24,
          hwaccel: "cpu",
          minSavingsPercent: 15,
        },
      ],
      integrations: {},
      queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1, minFreeSpaceGb: 0 },
      dbPath: join(dir, "unused.db"),
    } as Config;

    const job = jobsRepo.enqueueJob(originalPath, "to-mp4", 12);
    await processJob(job, { config, filesRepo, jobsRepo });

    expect(runTranscodeWithFallback).not.toHaveBeenCalled();
    expect(readFileSync(originalPath, "utf-8")).toBe("original mkv");
    expect(readFileSync(siblingPath, "utf-8")).toBe("unrelated mp4 the user keeps");
    const updatedJob = jobsRepo.getById(job.id);
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.error).toContain("already exists");
  });

  it("replaces across containers without leaving a backup or marker", async () => {
    const { replaceOriginal } = await import("../src/queue/atomicReplace.js");
    const originalPath = join(dir, "movie6.mkv");
    const tempPath = join(dir, "movie6.shrinkarr.tmp.mp4");
    const destination = join(dir, "movie6.mp4");
    writeFileSync(originalPath, "old mkv");
    writeFileSync(tempPath, "new mp4");

    await replaceOriginal(originalPath, tempPath, undefined, { destinationPath: destination });

    expect(readFileSync(destination, "utf-8")).toBe("new mp4");
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(`${originalPath}.shrinkarr.bak`)).toBe(false);
    expect(existsSync(`${originalPath}.shrinkarr.bak.txn`)).toBe(false);
  });

  it("will not overwrite a file that appeared at the new name during the encode", async () => {
    const { replaceOriginal } = await import("../src/queue/atomicReplace.js");
    const originalPath = join(dir, "movie7.mkv");
    const tempPath = join(dir, "movie7.shrinkarr.tmp.mp4");
    const destination = join(dir, "movie7.mp4");
    writeFileSync(originalPath, "old mkv");
    writeFileSync(tempPath, "new mp4");
    writeFileSync(destination, "arrived mid-encode");

    await expect(
      replaceOriginal(originalPath, tempPath, undefined, { destinationPath: destination, retryAttempts: 3 }),
    ).rejects.toThrow(/already exists/);

    expect(readFileSync(destination, "utf-8")).toBe("arrived mid-encode");
    expect(readFileSync(originalPath, "utf-8")).toBe("old mkv");
  });

  it("gives same-named files distinct names in the recycle bin", async () => {
    const { disposeBackup } = await import("../src/queue/atomicReplace.js");
    const recycleDir = join(dir, "bin");
    const a = join(dir, "a", "same.mkv");
    const b = join(dir, "b", "same.mkv");
    for (const p of [a, b]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, p);
    }
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await disposeBackup(a, a, recycleDir);
      await disposeBackup(b, b, recycleDir);
    } finally {
      now.mockRestore();
    }
    expect(readdirSync(recycleDir)).toHaveLength(2);
  });
});
