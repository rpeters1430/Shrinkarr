import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo, type NewFileRecord } from "../src/db/filesRepo.js";
import { HistoryRepo } from "../src/db/historyRepo.js";
import { classifyHealthErrors, errorLines, quickSamplePoints } from "../src/media/healthCheck.js";
import { keepTail } from "../src/transcode/runner.js";
import { runMigrations } from "../src/db/migrations.js";
import { excludeGlobs, walkLibrary } from "../src/scanner/walk.js";
import { processJob } from "../src/queue/worker.js";
import type { Config } from "../src/config/schema.js";

let db: DatabaseSync;
let jobsRepo: JobsRepo;
let filesRepo: FilesRepo;
let historyRepo: HistoryRepo;

function fileRecord(path: string, overrides: Partial<NewFileRecord> = {}): NewFileRecord {
  return {
    path,
    libraryId: "movies",
    codec: "h264",
    container: "matroska",
    sizeBytes: 1000,
    durationSeconds: 60,
    resolution: "1080p",
    width: 1920,
    height: 1080,
    bitrateKbps: 8000,
    bitDepth: 8,
    isHdr: false,
    audioCodec: "aac",
    audioChannels: 2,
    subtitleCount: 0,
    estimatedSavingsBytes: 400,
    recommendedAction: "HEVC",
    mtimeMs: 1,
    needsTranscode: true,
    skipReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-health-"));
  db = openDb(join(dir, "test.db"));
  jobsRepo = new JobsRepo(db);
  filesRepo = new FilesRepo(db);
  historyRepo = new HistoryRepo(db);
});

afterEach(() => {
  db.close();
});

describe("ignored and corrupt files", () => {
  it("are left out of automatic queuing, eligibility and savings", () => {
    filesRepo.upsertFiles([fileRecord("/m/a.mkv"), fileRecord("/m/b.mkv"), fileRecord("/m/c.mkv"), fileRecord("/m/d.mkv")]);
    filesRepo.setIgnored(["/m/a.mkv"], true);
    filesRepo.setHealth("/m/b.mkv", "corrupt", "quick", "bad frame");
    filesRepo.setHealth("/m/d.mkv", "unverifiable", "quick", "decoder unavailable");

    const created = jobsRepo.enqueueJobsBatch(
      ["/m/a.mkv", "/m/b.mkv", "/m/c.mkv", "/m/d.mkv"].map((filePath) => ({ filePath, presetId: "balanced", originalSizeBytes: 1000 })),
    );
    expect(created.map((j) => j.filePath)).toEqual(["/m/c.mkv", "/m/d.mkv"]);
    expect(filesRepo.getEligibleFiles().map((f) => f.path)).toEqual(["/m/c.mkv", "/m/d.mkv"]);

    const stats = filesRepo.getAggregatedStats([]);
    expect(stats.recommendedCount).toBe(2);
    expect(stats.ignoredCount).toBe(1);
    expect(stats.corruptCount).toBe(1);
  });

  it("can still be health checked", () => {
    filesRepo.upsertFiles([fileRecord("/m/a.mkv")]);
    filesRepo.setIgnored(["/m/a.mkv"], true);
    const created = jobsRepo.enqueueJobsBatch([{ filePath: "/m/a.mkv", presetId: "quick", originalSizeBytes: 1000 }], "health");
    expect(created).toHaveLength(1);
    expect(jobsRepo.getById(created[0].id)?.kind).toBe("health");
  });

  it("keeps health and the ignore flag across a rescan of an unchanged file", () => {
    filesRepo.upsertFiles([fileRecord("/m/a.mkv")]);
    filesRepo.setHealth("/m/a.mkv", "healthy", "thorough", null);
    filesRepo.setIgnored(["/m/a.mkv"], true);
    filesRepo.upsertFiles([fileRecord("/m/a.mkv")]);

    const file = filesRepo.getFileByPath("/m/a.mkv")!;
    expect(file.healthStatus).toBe("healthy");
    expect(file.healthMode).toBe("thorough");
    expect(file.ignored).toBe(true);
  });

  it("resets health when the file changes on disk", () => {
    filesRepo.upsertFiles([fileRecord("/m/a.mkv")]);
    filesRepo.setHealth("/m/a.mkv", "corrupt", "quick", "bad frame");
    filesRepo.upsertFiles([fileRecord("/m/a.mkv", { sizeBytes: 2000, mtimeMs: 2 })]);

    const file = filesRepo.getFileByPath("/m/a.mkv")!;
    expect(file.healthStatus).toBe("unchecked");
    expect(file.healthError).toBeNull();
  });

  it("lists unchecked files for a library health check", () => {
    filesRepo.upsertFiles([fileRecord("/m/a.mkv"), fileRecord("/m/b.mkv"), fileRecord("/m/c.mkv"), fileRecord("/m/d.mkv")]);
    filesRepo.setHealth("/m/a.mkv", "healthy", "quick", null);
    filesRepo.setHealth("/m/d.mkv", "unverifiable", "quick", "FFmpeg decoder unavailable");
    filesRepo.setIgnored(["/m/c.mkv"], true);
    expect(filesRepo.getFilesForHealthCheck("movies").map((f) => f.path)).toEqual(["/m/b.mkv", "/m/d.mkv"]);
    expect(filesRepo.getFilesForHealthCheck("movies", false).map((f) => f.path)).toEqual(["/m/a.mkv", "/m/b.mkv", "/m/d.mkv"]);
  });
});

describe("JobsRepo kinds and logs", () => {
  it("picks pending jobs per kind", () => {
    jobsRepo.enqueueJob("/m/a.mkv", "quick", 100, "health");
    jobsRepo.enqueueJob("/m/b.mkv", "balanced", 100);
    expect(jobsRepo.getNextPendingJob([], "oldest", "transcode")?.filePath).toBe("/m/b.mkv");
    expect(jobsRepo.getNextPendingJob([], "oldest", "health")?.filePath).toBe("/m/a.mkv");
  });

  it("stores the log apart from the job list and clears it on retry", () => {
    const job = jobsRepo.enqueueJob("/m/a.mkv", "balanced", 100);
    jobsRepo.saveLog(job.id, "ffmpeg said no");
    jobsRepo.markFailed(job.id, "nope");
    expect(jobsRepo.getLog(job.id)).toBe("ffmpeg said no");
    expect(Object.keys(jobsRepo.listJobs()[0])).not.toContain("log");

    expect(jobsRepo.requeueJob(job.id)).toBe(true);
    expect(jobsRepo.getLog(job.id)).toBeNull();
    expect(jobsRepo.getLog("missing")).toBeUndefined();
  });

  it("records when a job started running", () => {
    const job = jobsRepo.enqueueJob("/m/a.mkv", "balanced", 100);
    jobsRepo.markRunning(job.id);
    const startedAt = jobsRepo.getById(job.id)?.startedAt;
    expect(startedAt).toBeTruthy();
    jobsRepo.markRunning(job.id, "libx265 (CPU)");
    expect(jobsRepo.getById(job.id)?.startedAt).toBe(startedAt);
  });

  it("leaves health checks out of space saved", () => {
    const health = jobsRepo.enqueueJob("/m/a.mkv", "quick", 1000, "health");
    jobsRepo.markDone(health.id, 0);
    const transcode = jobsRepo.enqueueJob("/m/b.mkv", "balanced", 1000);
    jobsRepo.markDone(transcode.id, 600);
    const stats = jobsRepo.getJobStats();
    expect(stats.spaceSavedBytes).toBe(400);
    expect(stats.transcodedCount).toBe(1);
  });
});

describe("HistoryRepo", () => {
  const base = {
    libraryId: "movies",
    presetId: "balanced",
    encoder: "libx265",
    error: null,
    startedAt: "2026-10-01T10:00:00.000Z",
    before: null,
    after: null,
  };

  it("lists newest first with filters and survives clearing the queue", () => {
    historyRepo.record({ ...base, id: "1", filePath: "/m/Alpha.mkv", kind: "transcode", status: "done", originalSizeBytes: 1000, newSizeBytes: 400, finishedAt: "2026-10-01T11:00:00.000Z" });
    historyRepo.record({ ...base, id: "2", filePath: "/m/Beta_1.mkv", kind: "remux", status: "done", originalSizeBytes: 1000, newSizeBytes: 1010, finishedAt: "2026-10-02T11:00:00.000Z" });
    historyRepo.record({ ...base, id: "3", filePath: "/m/Gamma.mkv", kind: "health", status: "failed", originalSizeBytes: 1000, newSizeBytes: null, error: "Corrupt", finishedAt: "2026-10-03T11:00:00.000Z", log: "decode error" });
    jobsRepo.clearHistory();

    const all = historyRepo.list();
    expect(all.total).toBe(3);
    expect(all.entries.map((e) => e.id)).toEqual(["3", "2", "1"]);
    expect(historyRepo.list({ kind: "remux" }).entries.map((e) => e.id)).toEqual(["2"]);
    expect(historyRepo.list({ status: "failed" }).entries.map((e) => e.id)).toEqual(["3"]);
    // "_" is literal in the search, not a LIKE wildcard.
    expect(historyRepo.list({ search: "a_1" }).total).toBe(1);
    expect(historyRepo.list({ search: "beta_" }).entries.map((e) => e.id)).toEqual(["2"]);
    expect(historyRepo.getLog("3")).toBe("decode error");
  });

  it("summarizes savings, ignoring health checks", () => {
    historyRepo.record({ ...base, id: "1", filePath: "/m/a.mkv", kind: "transcode", status: "done", originalSizeBytes: 1000, newSizeBytes: 400, finishedAt: new Date().toISOString() });
    historyRepo.record({ ...base, id: "2", filePath: "/m/b.mkv", kind: "remux", status: "done", originalSizeBytes: 1000, newSizeBytes: 900, finishedAt: new Date().toISOString() });
    historyRepo.record({ ...base, id: "3", filePath: "/m/c.mkv", kind: "health", status: "failed", error: "Corrupt: invalid data", originalSizeBytes: 1000, newSizeBytes: null, finishedAt: new Date().toISOString() });
    historyRepo.record({ ...base, id: "4", filePath: "/m/d.mkv", kind: "health", status: "failed", error: "Unverifiable: decoder unavailable", originalSizeBytes: 1000, newSizeBytes: null, finishedAt: new Date().toISOString() });

    const summary = historyRepo.summary();
    expect(summary.savedBytes).toBe(700);
    expect(summary.done).toBe(2);
    expect(summary.corruptFound).toBe(1);
    expect(summary.daily).toHaveLength(1);
    expect(summary.daily[0].savedBytes).toBe(700);
  });
});

describe("health check error lines", () => {
  it("only calls known input-data errors corrupt and leaves unclear failures unverifiable", () => {
    expect(classifyHealthErrors([])).toBe("healthy");
    expect(classifyHealthErrors(["[h264 @ 0x1] error while decoding MB 12 34, bytestream -5"])).toBe("corrupt");
    expect(classifyHealthErrors(["Invalid data found when processing input"])).toBe("corrupt");
    expect(classifyHealthErrors([...Array.from({ length: 25 }, () => "Decoder (codec hevc) not found"), "Invalid data found when processing input"])).toBe("corrupt");
    expect(classifyHealthErrors(["Decoder (codec hevc) not found"])).toBe("unverifiable");
    expect(classifyHealthErrors(["Error while decoding stream #0:0: Function not implemented"])).toBe("unverifiable");
    expect(classifyHealthErrors(["Error while opening encoder: out of memory"])).toBe("unverifiable");
  });

  it("ignores the null muxer's timestamp complaints but keeps decoder errors", () => {
    const stderr = [
      "[null @ 0x55de54df5080] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 23948 >= 23948",
      "[out#0/null @ 0x55de54df5080] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5",
      "Last message repeated 3 times",
      "[h264 @ 0x5612] error while decoding MB 12 34, bytestream -5",
      "[matroska,webm @ 0x5613] Element at 0x66ac10 exceeds containing master element",
      "ffmpeg exited with code 0",
    ].join("\n");
    expect(errorLines(stderr)).toEqual([
      "[h264 @ 0x5612] error while decoding MB 12 34, bytestream -5",
      "[matroska,webm @ 0x5613] Element at 0x66ac10 exceeds containing master element",
    ]);
  });

  it("trims kept output on a line boundary", () => {
    expect(keepTail("first line\nsecond line\nthird", 16)).toBe("third");
    expect(keepTail("short", 16)).toBe("short");
  });

  it("clears corrupt verdicts that were only timestamp warnings", () => {
    filesRepo.upsertFiles([fileRecord("/m/stream.mkv"), fileRecord("/m/broken.mkv")]);
    filesRepo.setHealth("/m/stream.mkv", "corrupt", "thorough", "xer in stream 0: 5 >= 5\n[null @ 0x1] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 8 >= 8");
    filesRepo.setHealth("/m/broken.mkv", "corrupt", "quick", "[h264 @ 0x2] error while decoding MB 1 2");
    db.prepare("DELETE FROM _migrations WHERE version = 7").run();
    runMigrations(db);

    expect(filesRepo.getFileByPath("/m/stream.mkv")?.healthStatus).toBe("unchecked");
    expect(filesRepo.getFileByPath("/m/broken.mkv")?.healthStatus).toBe("corrupt");
  });
});

describe("health check sampling", () => {
  it("decodes short files whole and samples long ones at start, middle and end", () => {
    expect(quickSamplePoints(30)).toEqual([0]);
    expect(quickSamplePoints(3600)).toEqual([0, 1795, 3585]);
  });
});

describe("health worker stability guard", () => {
  it("records a missing file as unverifiable before probing it", async () => {
    const missingPath = join(tmpdir(), `shrinkarr-missing-${Date.now()}.mkv`);
    filesRepo.upsertFiles([fileRecord(missingPath)]);
    const job = jobsRepo.enqueueJob(missingPath, "quick", 1000, "health");
    const config = {
      libraries: [], presets: [],
      queue: { fileStabilityDelaySeconds: 2, lowPriority: false, healthCheck: "off" },
    } as Config;

    await processJob(job, { config, filesRepo, jobsRepo, historyRepo });

    expect(filesRepo.getFileByPath(missingPath)?.healthStatus).toBe("unverifiable");
    expect(filesRepo.getFileByPath(missingPath)?.healthError).toMatch(/^Unverifiable:/);
    expect(jobsRepo.getById(job.id)?.status).toBe("failed");
    expect(historyRepo.list({ kind: "health" }).entries[0]?.error).toMatch(/^Unverifiable:/);
  });

  it("saves the running log when cancelled during file stability polling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shrinkarr-health-cancel-"));
    const filePath = join(dir, "unstable.mkv");
    await writeFile(filePath, "still being written");
    filesRepo.upsertFiles([fileRecord(filePath)]);
    const job = jobsRepo.enqueueJob(filePath, "quick", 1000, "health");
    const config = {
      libraries: [], presets: [],
      queue: { fileStabilityDelaySeconds: 300, lowPriority: false, healthCheck: "off" },
    } as Config;
    const controller = new AbortController();
    setTimeout(() => controller.abort("cancelled"), 30);

    await processJob(job, { config, filesRepo, jobsRepo, historyRepo }, controller.signal);

    expect(jobsRepo.getById(job.id)?.status).toBe("cancelled");
    expect(jobsRepo.getLog(job.id)).toContain("Running a quick health check");
  });
});

describe("library exclude patterns", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("turns bare names into any-depth globs and keeps paths relative", () => {
    expect(excludeGlobs(["Extras", " ./Movies/Old/ ", ""])).toEqual(["**/Extras", "**/Extras/**", "Movies/Old", "Movies/Old/**"]);
  });

  it("leaves excluded files and folders out of the walk", async () => {
    const root = await mkdtemp(join(tmpdir(), "shrinkarr-exclude-"));
    tempDirs.push(root);
    await mkdir(join(root, "Film", "extras"), { recursive: true });
    await mkdir(join(root, "Old"), { recursive: true });
    await writeFile(join(root, "Film", "Film.mkv"), "video");
    await writeFile(join(root, "Film", "Film-Sample.mkv"), "video");
    await writeFile(join(root, "Film", "extras", "Interview.mkv"), "video");
    await writeFile(join(root, "Old", "Thing.mkv"), "video");

    const { walkLibraryEntries } = await import("../src/scanner/walk.js");
    const entries = await walkLibraryEntries(root, "video", undefined, ["Extras", "*sample*", "Old"]);
    expect(entries.map((e) => e.path)).toEqual([join(root, "Film", "Film.mkv")]);
    expect((await walkLibrary(root)).length).toBe(4);
  });
});
