import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api/applyConfig.js", () => ({
  applyConfig: (ctx: { config: unknown }, config: unknown) => { ctx.config = config; },
}));
import { libraryRoutes } from "../src/api/routes/libraries.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof Fastify>;
let filesRepo: FilesRepo;
let jobsRepo: JobsRepo;

beforeEach(async () => {
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  const config = ConfigSchema.parse({
    libraries: [{
      id: "movies",
      name: "Movies",
      path: "/media/movies",
      presetId: "balanced",
      rules: [{
        id: "all-video",
        name: "All video",
        enabled: true,
        conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
        action: { type: "preset", presetId: "max-savings" },
      }],
    }],
  });
  const ctx: AppContext = { config, configPath: "config/config.yaml", filesRepo, jobsRepo };
  app = Fastify();
  app.decorate("ctx", ctx);
  await app.register(libraryRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("POST /api/libraries/:id/optimize with rules", () => {
  it("rejects saved rules that reference a missing preset", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/libraries/movies",
      payload: {
        rules: [{
          id: "invalid-preset",
          name: "Invalid preset",
          enabled: true,
          conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
          action: { type: "preset", presetId: "missing-preset" },
        }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("re-resolves indexed files and queues the preset selected by the saved rule", async () => {
    filesRepo.upsertFile({
      path: "/media/movies/movie.mkv",
      libraryId: "movies",
      codec: "h264",
      container: "matroska",
      sizeBytes: 2_000_000_000,
      durationSeconds: 600,
      resolution: "1080p",
      width: 1920,
      height: 1080,
      bitrateKbps: 8000,
      bitDepth: 8,
      isHdr: false,
      audioCodec: "aac",
      audioChannels: 2,
      subtitleCount: 0,
      estimatedSavingsBytes: 0,
      recommendedAction: "Keep",
      needsTranscode: false,
      skipReason: null,
      policyMetadata: { mediaKind: "video", fps: 24 },
    });

    const response = await app.inject({ method: "POST", url: "/api/libraries/movies/optimize" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: 1, totalEligible: 1 });
    expect(jobsRepo.listJobs()[0].presetId).toBe("max-savings");
  });

  it("skips rows that need metadata refresh and rows ignored or marked corrupt", async () => {
    for (const [path, policyMetadata] of [
      ["/media/movies/legacy.mkv", null],
      ["/media/movies/ignored.mkv", { mediaKind: "video", fps: 24 }],
      ["/media/movies/corrupt.mkv", { mediaKind: "video", fps: 24 }],
    ] as const) {
      filesRepo.upsertFile({
        path,
        libraryId: "movies",
        codec: "h264",
        container: "matroska",
        sizeBytes: 2_000_000_000,
        durationSeconds: 600,
        resolution: "1080p",
        width: 1920,
        height: 1080,
        bitrateKbps: 8000,
        bitDepth: 8,
        isHdr: false,
        audioCodec: "aac",
        audioChannels: 2,
        subtitleCount: 0,
        estimatedSavingsBytes: 1000,
        recommendedAction: "HEVC",
        needsTranscode: true,
        skipReason: null,
        policyMetadata,
      });
    }
    filesRepo.setIgnored(["/media/movies/ignored.mkv"], true);
    filesRepo.setHealth("/media/movies/corrupt.mkv", "corrupt", "quick", "decode error");

    const response = await app.inject({ method: "POST", url: "/api/libraries/movies/optimize" });
    expect(response.json()).toMatchObject({ queued: 0, totalEligible: 0 });
  });
});
