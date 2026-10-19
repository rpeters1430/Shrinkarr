import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const savedRule = {
  id: "video-rule",
  name: "Video rule",
  enabled: true,
  conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
  action: { type: "preset", presetId: "max-savings" },
};

beforeEach(async () => {
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  const config = ConfigSchema.parse({
    libraries: [{ id: "movies", name: "Movies", path: "/media/movies", presetId: "balanced", rules: [savedRule] }],
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

function addFile(path: string, options: { metadata?: boolean; ignored?: boolean; health?: "unchecked" | "corrupt" } = {}) {
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
    estimatedSavingsBytes: 123,
    recommendedAction: "HEVC",
    needsTranscode: true,
    skipReason: null,
    policyMetadata: options.metadata === false ? null : { mediaKind: "video", fps: 24 },
  });
  if (options.ignored) filesRepo.setIgnored([path], true);
  if (options.health === "corrupt") filesRepo.setHealth(path, "corrupt", "quick", "decode error");
}

describe("library rule preview API", () => {
  it("previews draft rules read-only with a bounded, stable page and complete summary", async () => {
    addFile("/media/movies/a.mkv");
    addFile("/media/movies/b.mkv");
    addFile("/media/movies/c.mkv", { metadata: false });
    const before = filesRepo.getFileByPath("/media/movies/a.mkv");
    const keepDraft = [{
      id: "keep-all",
      name: "Keep all",
      enabled: true,
      conditions: [{ field: "path", operator: "glob", value: "**/*.mkv" }],
      action: { type: "keep" },
    }];

    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/preview",
      payload: { rules: keepDraft, offset: 1, limit: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: {
        total: 3, optimize: 0, keep: 2, fallback: 0, noMatch: 0, needsScan: 1,
        ruleMatches: [{ ruleId: "keep-all", ruleName: "Keep all", matches: 2, optimize: 0, keep: 2 }],
      },
      pagination: { offset: 1, limit: 1, total: 3, hasNext: true },
      files: [{ filePath: "/media/movies/b.mkv", action: "keep", matchedRuleId: "keep-all" }],
    });
    expect(jobsRepo.countJobs()).toBe(0);
    expect(filesRepo.getFileByPath("/media/movies/a.mkv")).toMatchObject({
      recommendedAction: before?.recommendedAction,
      estimatedSavingsBytes: before?.estimatedSavingsBytes,
      lastScannedAt: before?.lastScannedAt,
    });
  });

  it("returns zero savings for outside-library rows", async () => {
    addFile("/media/elsewhere/outside.mkv");
    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/preview",
      payload: { rules: [], limit: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().files[0]).toMatchObject({
      filePath: null,
      status: "outsideLibrary",
      estimatedSavingsBytes: 0,
    });
  });

  it("does not accept a preview page larger than the server limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/preview",
      payload: { rules: [], limit: 201 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("queues only server-resolved saved rules, ignoring client decisions", async () => {
    addFile("/media/movies/queue-me.mkv");
    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/queue",
      payload: {
        filePaths: ["/media/movies/queue-me.mkv"],
        decisions: [{ action: "keep" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: 1, results: [{ filePath: "/media/movies/queue-me.mkv", status: "queued" }] });
    expect(jobsRepo.listJobs()[0].presetId).toBe("max-savings");
  });

  it("rejects unindexed and out-of-library queue paths", async () => {
    addFile("/media/movies/known.mkv");
    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/queue",
      payload: { filePaths: ["/media/elsewhere/private.mkv"] },
    });
    expect(response.statusCode).toBe(400);
    expect(jobsRepo.countJobs()).toBe(0);
  });

  it("skips rows needing a scan, ignored rows, corrupt rows, Keep decisions, and active duplicates", async () => {
    addFile("/media/movies/legacy.mkv", { metadata: false });
    addFile("/media/movies/ignored.mkv", { ignored: true });
    addFile("/media/movies/corrupt.mkv", { health: "corrupt" });
    addFile("/media/movies/active.mkv");
    jobsRepo.enqueueJob("/media/movies/active.mkv", "balanced", 2_000_000_000);
    const response = await app.inject({
      method: "POST",
      url: "/api/libraries/movies/rules/queue",
      payload: { filePaths: [
        "/media/movies/legacy.mkv",
        "/media/movies/ignored.mkv",
        "/media/movies/corrupt.mkv",
        "/media/movies/active.mkv",
      ] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: 0 });
    expect(response.json().results.map((r: { status: string }) => r.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(jobsRepo.countJobs()).toBe(1);
  });
});
