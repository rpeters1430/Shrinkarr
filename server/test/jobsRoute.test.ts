import { describe, expect, it, afterEach, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { jobRoutes } from "../src/api/routes/jobs.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema } from "../src/config/schema.js";

let db: ReturnType<typeof openDb>;
let app: FastifyInstance;
let jobsRepo: JobsRepo;
let filesRepo: FilesRepo;

beforeEach(async () => {
  db = openDb(":memory:");
  jobsRepo = new JobsRepo(db);
  filesRepo = new FilesRepo(db);

  const config = ConfigSchema.parse({
    libraries: [{ id: "movies", name: "Movies", path: "/media/movies", presetId: "balanced" }],
    dbPath: ":memory:",
  });

  const ctx: AppContext = {
    config,
    configPath: "config/config.yaml",
    filesRepo,
    jobsRepo,
  };

  app = Fastify();
  app.decorate("ctx", ctx);
  await app.register(jobRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("Jobs Routes", () => {
  it("enqueues multiple jobs atomically with POST /api/jobs/bulk", async () => {
    filesRepo.upsertFile({
      path: "/media/movies/file1.mkv",
      libraryId: "movies",
      codec: "h264",
      container: "matroska",
      sizeBytes: 1000,
      durationSeconds: 10,
      resolution: "1080p",
      width: 1920,
      height: 1080,
      bitrateKbps: 5000,
      bitDepth: 8,
      isHdr: false,
      audioCodec: "aac",
      audioChannels: 2,
      subtitleCount: 0,
      estimatedSavingsBytes: 400,
      recommendedAction: "HEVC",
      needsTranscode: true,
      skipReason: null,
    });

    filesRepo.upsertFile({
      path: "/media/movies/file2.mkv",
      libraryId: "movies",
      codec: "h264",
      container: "matroska",
      sizeBytes: 2000,
      durationSeconds: 20,
      resolution: "1080p",
      width: 1920,
      height: 1080,
      bitrateKbps: 5000,
      bitDepth: 8,
      isHdr: false,
      audioCodec: "aac",
      audioChannels: 2,
      subtitleCount: 0,
      estimatedSavingsBytes: 800,
      recommendedAction: "HEVC",
      needsTranscode: true,
      skipReason: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/bulk",
      payload: {
        filePaths: ["/media/movies/file1.mkv", "/media/movies/file2.mkv", "/outside/file3.mkv"],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { queued: number; skippedCount: number };
    expect(body.queued).toBe(2);
    expect(body.skippedCount).toBe(1);

    const jobs = jobsRepo.listJobs();
    expect(jobs).toHaveLength(2);
  });

  it("supports limit and offset pagination on GET /api/jobs", async () => {
    for (let i = 1; i <= 10; i++) {
      jobsRepo.enqueueJob(`/media/movies/movie-${i}.mkv`, "balanced", 1000 * i);
    }

    const resPage1 = await app.inject({
      method: "GET",
      url: "/api/jobs?limit=4&offset=0",
    });
    expect(resPage1.statusCode).toBe(200);
    const jobsPage1 = JSON.parse(resPage1.body) as Array<{ filePath: string }>;
    expect(jobsPage1).toHaveLength(4);

    const resPage2 = await app.inject({
      method: "GET",
      url: "/api/jobs?limit=4&offset=4",
    });
    expect(resPage2.statusCode).toBe(200);
    const jobsPage2 = JSON.parse(resPage2.body) as Array<{ filePath: string }>;
    expect(jobsPage2).toHaveLength(4);
    expect(jobsPage2[0].filePath).not.toBe(jobsPage1[0].filePath);
  });

  it("refuses to cancel a job that already finished", async () => {
    const job = jobsRepo.enqueueJob("/media/movies/done.mkv", "balanced", 1000);
    jobsRepo.markDone(job.id, 500);

    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(jobsRepo.getById(job.id)?.status).toBe("done");
  });

  it("cancels a pending job", async () => {
    const job = jobsRepo.enqueueJob("/media/movies/pending.mkv", "balanced", 1000);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(jobsRepo.getById(job.id)?.status).toBe("cancelled");
  });

  it("counts jobs by status on GET /api/queue/status", async () => {
    jobsRepo.enqueueJob("/media/movies/a.mkv", "balanced", 1000);
    const done = jobsRepo.enqueueJob("/media/movies/b.mkv", "balanced", 1000);
    jobsRepo.markDone(done.id, 500);
    const failed = jobsRepo.enqueueJob("/media/movies/c.mkv", "balanced", 1000);
    jobsRepo.markFailed(failed.id, "boom");

    const res = await app.inject({ method: "GET", url: "/api/queue/status" });
    const body = JSON.parse(res.body) as { pending: number; done: number; failed: number; total: number };
    expect(body).toMatchObject({ pending: 1, done: 1, failed: 1, total: 3 });
  });
});

describe("Job retry routes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shrinkarr-retry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function failedJobFor(name: string, error = "Transcode failed: boom") {
    const filePath = join(dir, name);
    writeFileSync(filePath, "video");
    const job = jobsRepo.enqueueJob(filePath, "balanced", 100);
    jobsRepo.markRunning(job.id, "hevc_vaapi");
    jobsRepo.markFailed(job.id, error);
    return job;
  }

  it("requeues a failed job and clears its error", async () => {
    const job = failedJobFor("a.mkv");
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: job.id, status: "pending", error: null, encoderUsed: null });
  });

  it("refuses to retry a job that is not failed or cancelled", async () => {
    const job = jobsRepo.enqueueJob(join(dir, "b.mkv"), "balanced", 100);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it("refuses to retry when the file is gone", async () => {
    const job = failedJobFor("c.mkv");
    rmSync(job.filePath);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(jobsRepo.getById(job.id)?.status).toBe("failed");
  });

  it("refuses to retry when the file already has a job in the queue", async () => {
    const job = failedJobFor("d.mkv");
    jobsRepo.enqueueJob(job.filePath, "balanced", 100);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await app.inject({ method: "POST", url: "/api/jobs/nope/retry" });
    expect(res.statusCode).toBe(404);
  });

  it("retries every failed file once and skips missing files", async () => {
    const first = failedJobFor("e.mkv", "first try");
    const second = failedJobFor("e.mkv", "second try");
    const other = failedJobFor("f.mkv");
    const missing = failedJobFor("g.mkv");
    rmSync(missing.filePath);
    const cancelled = jobsRepo.enqueueJob(join(dir, "h.mkv"), "balanced", 100);
    jobsRepo.markCancelled(cancelled.id);

    const res = await app.inject({ method: "POST", url: "/api/jobs/retry-failed" });
    expect(JSON.parse(res.body)).toEqual({ requeuedCount: 2, skippedCount: 2 });
    expect([first, second].map((j) => jobsRepo.getById(j.id)?.status).sort()).toEqual(["failed", "pending"]);
    expect(jobsRepo.getById(other.id)?.status).toBe("pending");
    expect(jobsRepo.getById(missing.id)?.status).toBe("failed");
    expect(jobsRepo.getById(cancelled.id)?.status).toBe("cancelled");
  });
});
