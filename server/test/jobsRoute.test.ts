import { describe, expect, it, afterEach, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
});
