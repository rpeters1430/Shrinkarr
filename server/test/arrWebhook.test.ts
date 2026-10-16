import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "../src/api/context.js";
import { webhookRoutes } from "../src/api/routes/webhooks.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { FilesRepo } from "../src/db/filesRepo.js";
import type { JobsRepo } from "../src/db/jobsRepo.js";
import {
  arrWebhookToken,
  findLibraryForPath,
  mapArrPath,
  parseArrWebhook,
} from "../src/integrations/arrWebhook.js";
import type { LibraryWatcher } from "../src/scanner/watcher.js";

const sonarrDownload = {
  eventType: "Download",
  instanceName: "Sonarr",
  series: { id: 1, title: "Show", path: "/tv/Show" },
  episodes: [{ id: 5, episodeNumber: 1, seasonNumber: 1 }],
  episodeFile: {
    id: 10,
    relativePath: "Season 01/Show - S01E01.mkv",
    path: "/tv/Show/Season 01/Show - S01E01.mkv",
  },
  isUpgrade: false,
};

const radarrDownload = {
  eventType: "Download",
  instanceName: "Radarr",
  movie: { id: 1, title: "Movie", year: 2020, folderPath: "/movies/Movie (2020)" },
  movieFile: { id: 3, relativePath: "Movie (2020).mkv", path: "/movies/Movie (2020)/Movie (2020).mkv" },
  isUpgrade: true,
};

describe("parseArrWebhook", () => {
  it("reads the file and folder paths from a Sonarr import", () => {
    expect(parseArrWebhook(sonarrDownload)).toEqual({
      kind: "files",
      eventType: "Download",
      paths: ["/tv/Show/Season 01/Show - S01E01.mkv", "/tv/Show"],
    });
  });

  it("reads the file and folder paths from a Radarr import", () => {
    expect(parseArrWebhook(radarrDownload)).toEqual({
      kind: "files",
      eventType: "Download",
      paths: ["/movies/Movie (2020)/Movie (2020).mkv", "/movies/Movie (2020)"],
    });
  });

  it("recognizes test events and ignores grabs and unknown bodies", () => {
    expect(parseArrWebhook({ eventType: "Test" })).toEqual({ kind: "test" });
    expect(parseArrWebhook({ ...sonarrDownload, eventType: "Grab" })).toEqual({ kind: "ignored", eventType: "Grab" });
    expect(parseArrWebhook("not json")).toEqual({ kind: "ignored", eventType: "" });
  });

  it("uses the series folder for deletes that carry no file", () => {
    expect(parseArrWebhook({ eventType: "SeriesDelete", series: { path: "/tv/Show" } })).toMatchObject({
      paths: ["/tv/Show"],
    });
  });
});

describe("mapArrPath", () => {
  const mappings = [
    { from: "/tv", to: "/media/tv" },
    { from: "/tv/anime", to: "/mnt/anime/" },
  ];

  it("rewrites the longest matching prefix", () => {
    expect(mapArrPath("/tv/Show/S01E01.mkv", mappings)).toBe("/media/tv/Show/S01E01.mkv");
    expect(mapArrPath("/tv/anime/Show/S01E01.mkv", mappings)).toBe("/mnt/anime/Show/S01E01.mkv");
  });

  it("matches whole path segments only", () => {
    expect(mapArrPath("/tvshows/Show.mkv", mappings)).toBe("/tvshows/Show.mkv");
  });

  it("handles Windows-style paths", () => {
    expect(mapArrPath("D:\\TV\\Show\\S01E01.mkv", [{ from: "D:\\TV", to: "/media/tv" }])).toBe("/media/tv/Show/S01E01.mkv");
  });
});

describe("findLibraryForPath", () => {
  it("picks the deepest library containing the path", () => {
    const config = ConfigSchema.parse({
      libraries: [
        { id: "tv", name: "TV", path: "/media/tv" },
        { id: "anime", name: "Anime", path: "/media/tv/anime" },
      ],
    });
    expect(findLibraryForPath("/media/tv/anime/Show/1.mkv", config.libraries)?.id).toBe("anime");
    expect(findLibraryForPath("/media/tv/Show/1.mkv", config.libraries)?.id).toBe("tv");
    expect(findLibraryForPath("/media/movies/1.mkv", config.libraries)).toBeUndefined();
  });
});

describe("POST /api/webhooks/arr", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  const requestLibraryCheck = vi.fn<(libraryId: string) => void>();
  const sessionSecret = "s".repeat(32);
  const token = arrWebhookToken(sessionSecret);

  beforeEach(async () => {
    requestLibraryCheck.mockReset();
    const config = ConfigSchema.parse({
      libraries: [
        { id: "tv", name: "TV", path: "/media/tv" },
        { id: "movies", name: "Movies", path: "/media/movies" },
      ],
      webhooks: { pathMappings: [{ from: "/tv", to: "/media/tv" }, { from: "/movies", to: "/media/movies" }] },
      auth: { username: "admin", passwordHash: "x", sessionSecret },
    });
    ctx = {
      config,
      configPath: "config/config.yaml",
      filesRepo: {} as FilesRepo,
      jobsRepo: {} as JobsRepo,
      watcher: { requestLibraryCheck } as unknown as LibraryWatcher,
    };
    app = Fastify();
    app.decorate("ctx", ctx);
    await app.register(webhookRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects a missing or wrong token", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/webhooks/arr", payload: sonarrDownload });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({ method: "POST", url: "/api/webhooks/arr?token=nope", payload: sonarrDownload });
    expect(wrong.statusCode).toBe(401);
    expect(requestLibraryCheck).not.toHaveBeenCalled();
  });

  it("checks the library an import landed in", async () => {
    const res = await app.inject({ method: "POST", url: `/api/webhooks/arr?token=${token}`, payload: sonarrDownload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, libraries: ["TV"], unmatched: [] });
    expect(requestLibraryCheck).toHaveBeenCalledTimes(1);
    expect(requestLibraryCheck).toHaveBeenCalledWith("tv");
  });

  it("accepts the token as a header or a basic-auth password", async () => {
    const header = await app.inject({
      method: "POST",
      url: "/api/webhooks/arr",
      headers: { "x-api-key": token },
      payload: radarrDownload,
    });
    expect(header.json()).toMatchObject({ libraries: ["Movies"] });

    const basic = await app.inject({
      method: "POST",
      url: "/api/webhooks/arr",
      headers: { authorization: `Basic ${Buffer.from(`radarr:${token}`).toString("base64")}` },
      payload: radarrDownload,
    });
    expect(basic.json()).toMatchObject({ libraries: ["Movies"] });
  });

  it("reports paths outside every library", async () => {
    ctx.config.webhooks.pathMappings = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.inject({ method: "POST", url: `/api/webhooks/arr?token=${token}`, payload: sonarrDownload });
    expect(res.json()).toEqual({
      ok: true,
      libraries: [],
      unmatched: ["/tv/Show/Season 01/Show - S01E01.mkv", "/tv/Show"],
    });
    expect(requestLibraryCheck).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("answers test events without checking anything", async () => {
    const res = await app.inject({ method: "POST", url: `/api/webhooks/arr?token=${token}`, payload: { eventType: "Test" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(requestLibraryCheck).not.toHaveBeenCalled();
  });

  it("hands out the webhook path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/webhooks/arr/info" });
    expect(res.json()).toEqual({ path: `/api/webhooks/arr?token=${token}` });
  });
});

describe("webhooks config", () => {
  it("drops path mapping rows left blank in the form", () => {
    const config = ConfigSchema.parse({
      webhooks: { pathMappings: [{ from: "/tv", to: "/media/tv" }, { from: "", to: "" }, { from: "/movies", to: " " }] },
    });
    expect(config.webhooks.pathMappings).toEqual([{ from: "/tv", to: "/media/tv" }]);
  });

  it("defaults to no mappings", () => {
    expect(ConfigSchema.parse({}).webhooks.pathMappings).toEqual([]);
  });
});
