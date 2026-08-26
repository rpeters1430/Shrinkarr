import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
}));

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

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe("processJob safety", () => {
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
});
