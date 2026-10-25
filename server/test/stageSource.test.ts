import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import type { Config } from "../src/config/schema.js";
import { copyFileSequential, buildStagedSourcePath } from "../src/queue/stageSource.js";
import { holdSelfWritePaths, isSelfWritePath, resetSelfWritePaths } from "../src/scanner/selfWrites.js";

vi.mock("../src/media/ffprobe.js", () => ({
  probeFile: vi.fn(async () => ({
    mediaKind: "video",
    durationSeconds: 10,
    sizeBytes: 200,
    videoCodec: "h264",
    container: "matroska",
    width: 100,
    height: 100,
    audioCodec: "aac",
  })),
  detectMidStreamResolutionChanges: vi.fn(async () => ({ hasMultipleResolutions: false, resolutions: [] })),
}));

const { runTranscodeWithFallback } = vi.hoisted(() => ({
  runTranscodeWithFallback: vi.fn(async (_input: string, output: string) => {
    writeFileSync(output, "small encode");
    return { encoderUsed: "libx265" };
  }),
}));
vi.mock("../src/transcode/runner.js", () => ({ runTranscodeWithFallback }));

vi.mock("../src/transcode/verify.js", () => ({
  verifyOutput: vi.fn(async () => ({ ok: true })),
}));

const { processJob } = await import("../src/queue/worker.js");

let db: DatabaseSync;
let jobsRepo: JobsRepo;
let filesRepo: FilesRepo;
let dir: string;
let libraryDir: string;
let cacheDir: string;

function configWith(queue: Partial<Config["queue"]>): Config {
  return {
    libraries: [],
    presets: [{ id: "p", name: "test", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", minSavingsPercent: 0 }],
    integrations: {},
    queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 2, minFreeSpaceGb: 0, healthCheck: "off", ...queue },
    dbPath: join(dir, "unused.db"),
  } as Config;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shrinkarr-stage-"));
  libraryDir = join(dir, "library");
  cacheDir = join(dir, "cache");
  mkdirSync(libraryDir);
  db = openDb(join(dir, "test.db"));
  jobsRepo = new JobsRepo(db);
  filesRepo = new FilesRepo(db);
  resetSelfWritePaths();
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("staging the source in the local cache", () => {
  it("encodes from a local copy, installs the output, and removes the copy", async () => {
    const originalPath = join(libraryDir, "movie.mkv");
    writeFileSync(originalPath, "x".repeat(200));
    const job = jobsRepo.enqueueJob(originalPath, "p", 200);

    await processJob(job, { config: configWith({ tempDirectory: cacheDir, stageSource: true }), filesRepo, jobsRepo });

    expect(jobsRepo.getById(job.id)?.status).toBe("done");
    const encodedFrom = runTranscodeWithFallback.mock.calls[0]![0];
    expect(encodedFrom).toBe(buildStagedSourcePath(originalPath, job.id, ".shrinkarr.tmp", cacheDir));
    expect(readFileSync(originalPath, "utf-8")).toBe("small encode");
    expect(readdirSync(cacheDir)).toEqual([]);
  }, 30_000);

  it("reads the library file directly when no tempDirectory is set", async () => {
    const originalPath = join(libraryDir, "show.mkv");
    writeFileSync(originalPath, "x".repeat(200));
    const job = jobsRepo.enqueueJob(originalPath, "p", 200);

    await processJob(job, { config: configWith({ stageSource: true }), filesRepo, jobsRepo });

    expect(runTranscodeWithFallback.mock.calls[0]![0]).toBe(originalPath);
    expect(jobsRepo.getById(job.id)?.status).toBe("done");
  }, 30_000);

  it("keeps a source that changed during the encode", async () => {
    const originalPath = join(libraryDir, "upgraded.mkv");
    writeFileSync(originalPath, "x".repeat(200));
    runTranscodeWithFallback.mockImplementationOnce(async (_input: string, output: string) => {
      writeFileSync(output, "small encode");
      writeFileSync(originalPath, "an upgrade arrived from Sonarr, longer than before");
      return { encoderUsed: "libx265" };
    });
    const job = jobsRepo.enqueueJob(originalPath, "p", 200);

    await processJob(job, { config: configWith({ tempDirectory: cacheDir, stageSource: true }), filesRepo, jobsRepo });

    expect(jobsRepo.getById(job.id)?.status).toBe("failed");
    expect(readFileSync(originalPath, "utf-8")).toBe("an upgrade arrived from Sonarr, longer than before");
    expect(readdirSync(cacheDir)).toEqual([]);
  }, 30_000);

  it("holds the job's paths so the watcher ignores them until shortly after it ends", async () => {
    const originalPath = join(libraryDir, "held.mkv");
    writeFileSync(originalPath, "x".repeat(200));
    let heldDuringEncode = false;
    runTranscodeWithFallback.mockImplementationOnce(async (_input: string, output: string) => {
      heldDuringEncode = isSelfWritePath(originalPath);
      writeFileSync(output, "small encode");
      return { encoderUsed: "libx265" };
    });
    const job = jobsRepo.enqueueJob(originalPath, "p", 200);

    await processJob(job, { config: configWith({}), filesRepo, jobsRepo });

    expect(heldDuringEncode).toBe(true);
    expect(isSelfWritePath(originalPath)).toBe(true);
    expect(isSelfWritePath(originalPath, Date.now() + 120_000)).toBe(false);
  }, 30_000);
});

describe("copyFileSequential", () => {
  it("copies the whole file", async () => {
    const source = join(dir, "a.bin");
    writeFileSync(source, Buffer.alloc(20 * 1024 * 1024, 7));
    const copied = await copyFileSequential(source, join(dir, "b.bin"));
    expect(copied).toBe(20 * 1024 * 1024);
    expect(readFileSync(join(dir, "b.bin")).equals(readFileSync(source))).toBe(true);
  });

  it("refuses to overwrite an existing file and leaves it alone", async () => {
    const source = join(dir, "a.bin");
    const dest = join(dir, "b.bin");
    writeFileSync(source, "new");
    writeFileSync(dest, "someone else's");
    await expect(copyFileSequential(source, dest)).rejects.toThrow();
    expect(readFileSync(dest, "utf-8")).toBe("someone else's");
  });

  it("removes the partial copy when cancelled", async () => {
    const source = join(dir, "a.bin");
    const dest = join(dir, "b.bin");
    writeFileSync(source, Buffer.alloc(64 * 1024 * 1024, 1));
    const controller = new AbortController();
    await expect(copyFileSequential(source, dest, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });
});

describe("self-write paths", () => {
  it("stays held while any holder still has the path", () => {
    const path = join(dir, "x.mkv");
    const releaseA = holdSelfWritePaths([path]);
    const releaseB = holdSelfWritePaths([path]);
    releaseA();
    expect(isSelfWritePath(path, Date.now() + 120_000)).toBe(true);
    releaseB();
    expect(isSelfWritePath(path, Date.now() + 120_000)).toBe(false);
  });
});
