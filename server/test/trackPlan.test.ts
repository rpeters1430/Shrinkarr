import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { planTracks, plannedTracks } from "../src/scanner/trackPlan.js";
import { libraryRoutes } from "../src/api/routes/libraries.js";
import { jobRoutes } from "../src/api/routes/jobs.js";
import { HistoryRepo } from "../src/db/historyRepo.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema, DEFAULT_PRESETS, type Preset } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo, type NewFileRecord } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import type { PolicyMetadata } from "../src/media/types.js";

const preset: Preset = { ...DEFAULT_PRESETS[0], minFileSizeMb: 0 };

const metadata: PolicyMetadata = {
  mediaKind: "video",
  fps: 24,
  originalLanguage: "jpn",
  audioTracks: [
    { index: 1, codec: "eac3", channels: 6, language: "eng", isDefault: true, title: "English DD+ 5.1" },
    { index: 2, codec: "aac", channels: 2, language: "jpn", isDefault: false },
    { index: 3, codec: "ac3", channels: 2, language: "eng", isDefault: false, isCommentary: true },
  ],
  subtitleTracks: [
    { index: 4, codec: "subrip", language: "eng", isForced: false },
    { index: 5, codec: "subrip", language: "fre", isForced: false },
  ],
};

function file(path: string, policyMetadata: PolicyMetadata | null): NewFileRecord {
  return {
    path,
    libraryId: "movies",
    codec: "hevc",
    container: "matroska",
    sizeBytes: 4_000_000_000,
    durationSeconds: 3600,
    resolution: "1080p",
    width: 1920,
    height: 1080,
    bitrateKbps: 6000,
    bitDepth: 10,
    isHdr: false,
    audioCodec: "eac3",
    audioChannels: 6,
    subtitleCount: 2,
    estimatedSavingsBytes: 0,
    recommendedAction: "Remux",
    needsTranscode: true,
    skipReason: null,
    policyMetadata,
  };
}

describe("planTracks", () => {
  it("lists removed tracks, the new order, default and renames", () => {
    const plan = planTracks(metadata, {
      ...preset,
      keepAudioLanguages: ["original", "eng"],
      keepSubtitleLanguages: ["eng"],
      removeCommentaryTracks: true,
      reorderTracks: true,
      cleanTrackNames: true,
    })!;
    expect(plan.removed).toEqual([3, 5]);
    expect(plan.order).toEqual([2, 1, 4]);
    expect(plan.defaultAudio).toBe(2);
    expect(plan.renamed).toEqual({ 1: null });
    expect(plan.changes).toBe(true);
  });

  it("reports no changes when the preset keeps everything as is", () => {
    const plan = planTracks(metadata, preset)!;
    expect(plan.removed).toEqual([]);
    expect(plan.changes).toBe(false);
  });

  it("has no plan for audio files or rows without track info", () => {
    expect(planTracks({ mediaKind: "audio", fps: 0 }, preset)).toBeNull();
    expect(planTracks({ mediaKind: "video", fps: 24 }, preset)).toBeNull();
    expect(planTracks(null, preset)).toBeNull();
  });
});

describe("GET /api/libraries/:id/files", () => {
  let db: ReturnType<typeof openDb>;
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("adds the track plan of the preset each file resolves to", async () => {
    db = openDb(":memory:");
    const filesRepo = new FilesRepo(db);
    filesRepo.upsertFile(file("/media/movies/a.mkv", metadata));
    filesRepo.upsertFile(file("/media/movies/b.mkv", null));
    const config = ConfigSchema.parse({
      libraries: [{ id: "movies", name: "Movies", path: "/media/movies", presetId: "cleanup" }],
      presets: [{ ...preset, id: "cleanup", keepSubtitleLanguages: ["eng"] }],
    });
    const ctx: AppContext = { config, configPath: "config/config.yaml", filesRepo, jobsRepo: new JobsRepo(db) };
    app = Fastify();
    app.decorate("ctx", ctx);
    await app.register(libraryRoutes);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/libraries/movies/files" });
    expect(response.statusCode).toBe(200);
    const files = response.json() as Array<{ path: string; trackPlan: { presetId: string; removed: number[] } | null }>;
    const byPath = new Map(files.map((f) => [f.path, f.trackPlan]));
    expect(byPath.get("/media/movies/a.mkv")).toMatchObject({ presetId: "cleanup", removed: [5] });
    expect(byPath.get("/media/movies/b.mkv")).toBeNull();
  });
});

describe("media insights languages", () => {
  it("counts each file once per language and folds language codes", () => {
    const db = openDb(":memory:");
    const filesRepo = new FilesRepo(db);
    filesRepo.upsertFile(file("/media/movies/a.mkv", metadata));
    filesRepo.upsertFile(file("/media/movies/b.mkv", {
      mediaKind: "video",
      fps: 24,
      audioTracks: [{ index: 1, codec: "aac", channels: 2, language: "en", isDefault: true }],
      subtitleTracks: [],
    }));
    const insights = filesRepo.getMediaInsights();
    expect(insights.audioLanguages.map((b) => [b.key, b.count])).toEqual([["eng", 2], ["jpn", 1]]);
    expect(insights.subtitleLanguages.map((b) => [b.key, b.count])).toEqual([["eng", 1], ["fra", 1]]);
    db.close();
  });
});

describe("plannedTracks", () => {
  it("lists the output tracks in order with new titles, default and codecs", () => {
    const after = plannedTracks(metadata, {
      ...preset,
      keepAudioLanguages: ["original", "eng"],
      keepSubtitleLanguages: ["eng"],
      removeCommentaryTracks: true,
      reorderTracks: true,
      cleanTrackNames: true,
      audioMode: "aac",
    })!;
    expect(after.audio).toEqual([
      expect.objectContaining({ index: 1, language: "jpn", codec: "aac", isDefault: true }),
      expect.objectContaining({ index: 2, language: "eng", codec: "aac", isDefault: false, title: undefined }),
    ]);
    expect(after.subtitles).toEqual([expect.objectContaining({ index: 3, language: "eng", codec: "subrip" })]);
  });
});

describe("GET /api/jobs/:id/tracks", () => {
  let db: ReturnType<typeof openDb>;
  let app: ReturnType<typeof Fastify>;
  let jobsRepo: JobsRepo;
  let historyRepo: HistoryRepo;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  async function setup() {
    db = openDb(":memory:");
    const filesRepo = new FilesRepo(db);
    jobsRepo = new JobsRepo(db);
    historyRepo = new HistoryRepo(db);
    filesRepo.upsertFile(file("/media/movies/a.mkv", metadata));
    const config = ConfigSchema.parse({
      libraries: [{ id: "movies", name: "Movies", path: "/media/movies", presetId: "cleanup" }],
      presets: [{ ...preset, id: "cleanup", keepSubtitleLanguages: ["eng"] }],
    });
    const ctx: AppContext = { config, configPath: "config/config.yaml", filesRepo, jobsRepo, historyRepo };
    app = Fastify();
    app.decorate("ctx", ctx);
    await app.register(jobRoutes);
    await app.ready();
  }

  it("plans the tracks of a waiting job", async () => {
    await setup();
    const job = jobsRepo.enqueueJob("/media/movies/a.mkv", "cleanup", 4_000_000_000);
    const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/tracks` });
    const body = response.json();
    expect(body.source).toBe("planned");
    expect(body.removed).toEqual([5]);
    expect(body.before.subtitles.map((t: { index: number }) => t.index)).toEqual([4, 5]);
    expect(body.after.subtitles).toHaveLength(1);
  });

  it("returns what History recorded for a finished job", async () => {
    await setup();
    const job = jobsRepo.enqueueJob("/media/movies/a.mkv", "cleanup", 4_000_000_000);
    const snapshot = {
      container: "matroska", videoCodec: "hevc", resolution: "1080p", width: 1920, height: 1080, bitDepth: 10,
      isHdr: false, bitrateKbps: 6000, durationSeconds: 3600, sizeBytes: 1,
      audio: [{ codec: "eac3", channels: 6, language: "eng" }], subtitles: [],
    };
    historyRepo.record({
      id: job.id, filePath: job.filePath, libraryId: "movies", kind: "remux", status: "done", presetId: "cleanup",
      encoder: "copy", error: null, originalSizeBytes: 2, newSizeBytes: 1, startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z", before: snapshot, after: { ...snapshot, audio: [] },
    });
    const body = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/tracks` })).json();
    expect(body.source).toBe("recorded");
    expect(body.before.audio).toHaveLength(1);
    expect(body.after.audio).toHaveLength(0);
  });

  it("404s for an unknown job", async () => {
    await setup();
    expect((await app.inject({ method: "GET", url: "/api/jobs/nope/tracks" })).statusCode).toBe(404);
  });
});
