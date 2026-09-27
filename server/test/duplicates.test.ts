import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duplicateRoutes } from "../src/api/routes/duplicates.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo, type NewFileRecord } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { findDuplicates } from "../src/duplicates/finder.js";
import { titleKeyFor } from "../src/duplicates/titleKey.js";

describe("titleKeyFor", () => {
  it("matches the same movie across release names", () => {
    const a = titleKeyFor("/m/The.Matrix.1999.1080p.BluRay.x264-GRP.mkv", "movie");
    const b = titleKeyFor("/m/The Matrix (1999)/The Matrix (1999) 2160p HDR.mp4", "movie");
    expect(a.key).toBe(b.key);
    expect(a.label).toBe("The Matrix (1999)");
  });

  it("keeps a title that is itself a year", () => {
    expect(titleKeyFor("/m/1917 (2019) 1080p.mkv", "movie").key).toBe("movie|1917|2019");
  });

  it("uses the folder when the file name is generic", () => {
    expect(titleKeyFor("/m/Heat (1995)/movie.mkv", "movie").key).toBe("movie|heat|1995");
  });

  it("matches episodes by show and SxxEyy, including bare episode names", () => {
    const a = titleKeyFor("/tv/Show/Season 1/Show.Name.S01E02.720p.mkv", "tv");
    const b = titleKeyFor("/tv/Show Name/Season 01/S01E02.mkv", "tv");
    expect(a.key).toBe("episode|show name|s01e02");
    expect(b.key).toBe(a.key);
    expect(titleKeyFor("/tv/Show Name/Season 01/S01E03.mkv", "tv").key).not.toBe(a.key);
  });

  it("does not match generic file names from different folders", () => {
    const heat = titleKeyFor("/m/Heat/movie.mkv", "movie");
    const alien = titleKeyFor("/m/Alien/movie.mkv", "movie");
    expect(heat.key).not.toBe(alien.key);
    expect(titleKeyFor("/m/Heat/movie.720p.mkv", "movie").key).toBe(heat.key);
  });

  it("scopes music tracks to their album folder", () => {
    const a = titleKeyFor("/music/Album A/01 - Intro.flac", "music");
    const b = titleKeyFor("/music/Album A/01 Intro.mp3", "music");
    const c = titleKeyFor("/music/Album B/01 - Intro.flac", "music");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
});

let root: string;
let db: ReturnType<typeof openDb>;
let filesRepo: FilesRepo;
let jobsRepo: JobsRepo;
let config: Config;

function record(path: string, overrides: Partial<NewFileRecord> = {}): NewFileRecord {
  return {
    path,
    libraryId: "movies",
    codec: "h264",
    container: "matroska",
    sizeBytes: 0,
    durationSeconds: 6000,
    resolution: "1080p",
    width: 1920,
    height: 1080,
    bitrateKbps: 5000,
    bitDepth: 8,
    isHdr: false,
    audioCodec: "aac",
    audioChannels: 2,
    subtitleCount: 0,
    estimatedSavingsBytes: 0,
    recommendedAction: "Keep",
    needsTranscode: false,
    skipReason: null,
    ...overrides,
  };
}

function addFile(relPath: string, content: string, overrides: Partial<NewFileRecord> = {}): string {
  const path = join(root, "movies", relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  filesRepo.upsertFile(record(path, { sizeBytes: content.length, ...overrides }));
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shrinkarr-dupes-"));
  mkdirSync(join(root, "movies"));
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  config = ConfigSchema.parse({
    libraries: [{ id: "movies", name: "Movies", path: join(root, "movies"), presetId: "balanced" }],
    dbPath: ":memory:",
  });
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("findDuplicates", () => {
  it("groups byte-identical files and ignores same-size files with different content", async () => {
    const a = addFile("A/copy.mkv", "same bytes!!");
    const b = addFile("B/other name.mkv", "same bytes!!");
    addFile("C/different.mkv", "diff bytes!!");

    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries, { findSameTitle: false });

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].match).toBe("identical");
    expect(report.groups[0].files.map((f) => f.path).sort()).toEqual([a, b].sort());
  });

  it("does not report hardlinks as duplicates", async () => {
    const a = addFile("A/movie.mkv", "linked content");
    const linked = join(root, "movies", "B.mkv");
    linkSync(a, linked);
    filesRepo.upsertFile(record(linked, { sizeBytes: 14 }));

    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries);
    expect(report.groups).toHaveLength(0);
  });

  it("counts no reclaimable space for a copy that has other hardlinks", async () => {
    const older = addFile("B/copy.mkv", "shared bytes", { mtimeMs: 1 });
    const linkedA = addFile("A/linked.mkv", "shared bytes", { mtimeMs: 2 });
    const linkedB = join(root, "movies", "C", "linked.mkv");
    mkdirSync(join(linkedB, ".."), { recursive: true });
    linkSync(linkedA, linkedB);
    filesRepo.upsertFile(record(linkedB, { sizeBytes: 12, mtimeMs: 2 }));

    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries, { findSameTitle: false });

    expect(report.groups).toHaveLength(1);
    const keep = report.groups[0].files.find((f) => f.keep);
    const extra = report.groups[0].files.find((f) => !f.keep);
    expect(keep?.path).toBe(older);
    expect(extra?.linkCount).toBe(2);
    expect(report.reclaimableBytes).toBe(0);
  });

  it("groups encodes of the same title and keeps the best quality", async () => {
    addFile("Heat.1995.720p.mkv", "small", { width: 1280, height: 720 });
    const best = addFile("Heat (1995) 1080p.mkv", "bigger file", { width: 1920, height: 1080 });

    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries, { findIdentical: false });

    expect(report.groups).toHaveLength(1);
    const keep = report.groups[0].files.find((f) => f.keep);
    expect(keep?.path).toBe(best);
    expect(report.reclaimableBytes).toBe(5);
  });

  it("keeps cuts with different runtimes apart", async () => {
    addFile("Heat (1995) Theatrical.mkv", "one", { durationSeconds: 10_200 });
    addFile("Heat (1995) Extended.mkv", "two", { durationSeconds: 11_000 });

    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries, {
      findIdentical: false,
      durationToleranceSeconds: 90,
    });
    expect(report.groups).toHaveLength(0);
  });

  it("skips rows whose files are gone and files under the size floor", async () => {
    filesRepo.upsertFile(record(join(root, "movies", "Gone (2001).mkv"), { sizeBytes: 5 }));
    addFile("Gone (2001) 720p.mkv", "x".repeat(10));
    const report = await findDuplicates(filesRepo.getAllFiles(), config.libraries, { minSizeMb: 0 });
    expect(report.groups).toHaveLength(0);
    expect(report.filesChecked).toBe(1);
  });
});

describe("duplicate routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const ctx = { config, configPath: "x", filesRepo, jobsRepo } as AppContext;
    app = Fastify();
    app.decorate("ctx", ctx);
    await app.register(duplicateRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("finds duplicates over HTTP", async () => {
    addFile("A (2000).mkv", "aaaa");
    addFile("A (2000) copy.mkv", "aaaa");
    const res = await app.inject({ method: "POST", url: "/api/duplicates/find", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).groups.length).toBeGreaterThan(0);
  });

  it("deletes a duplicate while the kept copy exists", async () => {
    const keep = addFile("A (2000).mkv", "aaaa");
    const drop = addFile("A (2000) copy.mkv", "aaaa");
    const res = await app.inject({
      method: "POST",
      url: "/api/duplicates/delete",
      payload: { items: [{ path: drop, keepPath: keep }] },
    });
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([drop]);
    expect(body.freedBytes).toBe(4);
    expect(filesRepo.getFileByPath(drop)).toBeUndefined();
  });

  it("refuses to delete both copies of a pair", async () => {
    const a = addFile("A (2000).mkv", "aaaa");
    const b = addFile("A (2000) copy.mkv", "aaaa");
    const res = await app.inject({
      method: "POST",
      url: "/api/duplicates/delete",
      payload: { items: [{ path: a, keepPath: b }, { path: b, keepPath: a }] },
    });
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([]);
    expect(body.failed).toHaveLength(2);
  });

  it("refuses to delete a file that is not a duplicate of the kept one", async () => {
    const keep = addFile("Heat (1995).mkv", "heat");
    const unrelated = addFile("Alien (1979).mkv", "alien");
    const res = await app.inject({
      method: "POST",
      url: "/api/duplicates/delete",
      payload: { items: [{ path: unrelated, keepPath: keep }] },
    });
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([]);
    expect(body.failed[0].error).toContain("not duplicates");
  });

  it("refuses paths outside the libraries", async () => {
    const keep = addFile("A (2000).mkv", "aaaa");
    const outside = join(root, "outside.mkv");
    writeFileSync(outside, "aaaa");
    const res = await app.inject({
      method: "POST",
      url: "/api/duplicates/delete",
      payload: { items: [{ path: outside, keepPath: keep }] },
    });
    expect(JSON.parse(res.body).failed).toHaveLength(1);
  });

  it("refuses a file with an active transcode job", async () => {
    const keep = addFile("A (2000).mkv", "aaaa");
    const drop = addFile("A (2000) copy.mkv", "aaaa");
    jobsRepo.enqueueJob(drop, "balanced", 4);
    const res = await app.inject({
      method: "POST",
      url: "/api/duplicates/delete",
      payload: { items: [{ path: drop, keepPath: keep }] },
    });
    expect(JSON.parse(res.body).failed[0].error).toContain("transcode job");
  });
});
