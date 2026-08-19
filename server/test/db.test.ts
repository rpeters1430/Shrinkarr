import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";

let db: DatabaseSync;
let jobsRepo: JobsRepo;
let filesRepo: FilesRepo;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-db-"));
  db = openDb(join(dir, "test.db"));
  jobsRepo = new JobsRepo(db);
  filesRepo = new FilesRepo(db);
});

afterEach(() => {
  db.close();
});

describe("JobsRepo", () => {
  it("enqueues, retrieves next pending, and marks done", () => {
    const job = jobsRepo.enqueueJob("/media/movie.mkv", "hevc-save-space", 1000);
    expect(job.status).toBe("pending");

    const next = jobsRepo.getNextPendingJob();
    expect(next?.id).toBe(job.id);

    jobsRepo.markRunning(job.id);
    jobsRepo.markDone(job.id, 600);

    const done = jobsRepo.getById(job.id);
    expect(done?.status).toBe("done");
    expect(done?.newSizeBytes).toBe(600);
  });

  it("resets stuck running jobs back to pending", () => {
    const job = jobsRepo.enqueueJob("/media/movie2.mkv", "hevc-save-space", 1000);
    jobsRepo.markRunning(job.id);
    expect(jobsRepo.getById(job.id)?.status).toBe("running");

    const resetCount = jobsRepo.resetStuckRunningJobs();
    expect(resetCount).toBe(1);
    expect(jobsRepo.getById(job.id)?.status).toBe("pending");
  });
});

describe("FilesRepo", () => {
  it("upserts and retrieves a file by path", () => {
    const record = filesRepo.upsertFile({
      path: "/media/movie.mkv",
      libraryId: "movies",
      codec: "h264",
      container: "mkv",
      sizeBytes: 1000,
      durationSeconds: 120,
      needsTranscode: true,
      skipReason: null,
    });
    expect(record.codec).toBe("h264");

    const fetched = filesRepo.getFileByPath("/media/movie.mkv");
    expect(fetched?.libraryId).toBe("movies");
  });
});
