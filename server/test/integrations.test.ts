import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbyClient } from "../src/integrations/emby.js";
import { createJellyfinClient } from "../src/integrations/jellyfin.js";
import { createPlexClient } from "../src/integrations/plex.js";
import { createRadarrClient } from "../src/integrations/radarr.js";
import { createSonarrClient } from "../src/integrations/sonarr.js";
import { normalizeIntegrationUrl } from "../src/integrations/types.js";
import { discoverLocalMediaServers } from "../src/integrations/discovery.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeIntegrationUrl", () => {
  it("prepends http:// if missing and removes trailing slashes", () => {
    expect(normalizeIntegrationUrl("192.168.50.114:8096")).toBe("http://192.168.50.114:8096");
    expect(normalizeIntegrationUrl("http://192.168.50.114:8096/")).toBe("http://192.168.50.114:8096");
    expect(normalizeIntegrationUrl("https://media.example.com///")).toBe("https://media.example.com");
    expect(normalizeIntegrationUrl("")).toBe("");
  });
});

describe("createJellyfinClient", () => {
  it("POSTs to /Library/Refresh with auth headers and query param", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "jf-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.50.114:8096/Library/Refresh?api_key=jf-key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Emby-Token": "jf-key",
          "X-MediaBrowser-Token": "jf-key",
        }),
      }),
    );
  });

  it("POSTs targeted update to /Library/Media/Updated when filePath is provided", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "jf-key" });
    await client.notifyLibraryChanged("/media/movies/movie.mp4");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.50.114:8096/Library/Media/Updated?api_key=jf-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ Updates: [{ Path: "/media/movies/movie.mp4", UpdateType: "Modified" }] }),
      }),
    );
  });

  it("falls back to /Library/Refresh when targeted update fails", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found", text: async () => "" })
      .mockResolvedValueOnce({ ok: true });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "jf-key" });
    await client.notifyLibraryChanged("/media/movies/movie.mp4");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://192.168.50.114:8096/Library/Media/Updated?api_key=jf-key",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://192.168.50.114:8096/Library/Refresh?api_key=jf-key",
      expect.anything(),
    );
  });

  it("testConnection returns ok and server info on 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ServerName: "MyJellyfin", Version: "10.11.11" }),
    });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "jf-key" });
    const res = await client.testConnection?.();
    expect(res?.ok).toBe(true);
    expect(res?.message).toContain("MyJellyfin v10.11.11");
  });

  it("testConnection returns helpful auth error on 401", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "bad-key" });
    const res = await client.testConnection?.();
    expect(res?.ok).toBe(false);
    expect(res?.message).toContain("Invalid Jellyfin API Key");
  });

  it("getActiveStreamCount counts active unpaused streams", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { Id: "s1", NowPlayingItem: { Name: "Movie 1" }, PlayState: { IsPaused: false } },
        { Id: "s2", NowPlayingItem: { Name: "Movie 2" }, PlayState: { IsPaused: true } },
        { Id: "s3" }, // Idle session with no playback
      ],
    });
    const client = createJellyfinClient({ url: "192.168.50.114:8096", apiKey: "jf-key" });
    const count = await client.getActiveStreamCount?.();
    expect(count).toBe(1);
  });
});

describe("createSonarrClient", () => {
  it("POSTs command RescanSeries with X-Api-Key header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createSonarrClient({ url: "192.168.50.114:8989", apiKey: "sonarr-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.50.114:8989/api/v3/command",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Api-Key": "sonarr-key" }),
        body: JSON.stringify({ name: "RescanSeries" }),
      }),
    );
  });

  it("testConnection queries system status", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ appName: "Sonarr", version: "4.0.0" }),
    });
    const client = createSonarrClient({ url: "http://sonarr:8989", apiKey: "sonarr-key" });
    const res = await client.testConnection?.();
    expect(res?.ok).toBe(true);
    expect(res?.message).toContain("Sonarr v4.0.0");
  });
});

describe("createRadarrClient", () => {
  it("POSTs command RescanMovie with X-Api-Key header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createRadarrClient({ url: "192.168.50.114:7878", apiKey: "radarr-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.50.114:7878/api/v3/command",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Api-Key": "radarr-key" }),
        body: JSON.stringify({ name: "RescanMovie" }),
      }),
    );
  });
});

describe("createEmbyClient", () => {
  it("POSTs to /Library/Refresh with X-Emby-Token header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createEmbyClient({ url: "http://emby:8096", apiKey: "emby-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://emby:8096/Library/Refresh?api_key=emby-key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Emby-Token": "emby-key" }),
      }),
    );
  });

  it("POSTs targeted update to /Library/Media/Updated when filePath is provided", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createEmbyClient({ url: "http://emby:8096", apiKey: "emby-key" });
    await client.notifyLibraryChanged("/media/tv/show.mkv");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://emby:8096/Library/Media/Updated?api_key=emby-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ Updates: [{ Path: "/media/tv/show.mkv", UpdateType: "Modified" }] }),
      }),
    );
  });

  it("falls back to /Library/Refresh when targeted update fails in Emby", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error", text: async () => "" })
      .mockResolvedValueOnce({ ok: true });
    const client = createEmbyClient({ url: "http://emby:8096", apiKey: "emby-key" });
    await client.notifyLibraryChanged("/media/tv/show.mkv");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://emby:8096/Library/Media/Updated?api_key=emby-key",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://emby:8096/Library/Refresh?api_key=emby-key",
      expect.anything(),
    );
  });

  it("getActiveStreamCount counts active unpaused streams in Emby", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { Id: "s1", NowPlayingItem: { Name: "Movie 1" }, PlayState: { IsPaused: false } },
        { Id: "s2", NowPlayingItem: { Name: "Movie 2" }, PlayState: { IsPaused: false } },
      ],
    });
    const client = createEmbyClient({ url: "http://emby:8096", apiKey: "emby-key" });
    const count = await client.getActiveStreamCount?.();
    expect(count).toBe(2);
  });
});

describe("createPlexClient", () => {
  it("GETs the section refresh URL with token query param", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createPlexClient({ url: "http://plex:32400", token: "plex-token", sectionId: "1" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://plex:32400/library/sections/1/refresh?X-Plex-Token=plex-token",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("GETs targeted section refresh with path parameter when filePath and sectionId are provided", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createPlexClient({ url: "http://plex:32400", token: "plex-token", sectionId: "2" });
    await client.notifyLibraryChanged("/data/movies/avatar.mkv");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://plex:32400/library/sections/2/refresh?path=%2Fdata%2Fmovies%2Favatar.mkv&X-Plex-Token=plex-token",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("auto-resolves matching section from /library/sections when sectionId is not set", async () => {
    fetchMock
      // Call 1: resolve section
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          MediaContainer: {
            Directory: [
              { key: "10", Location: [{ path: "/data/tv" }] },
              { key: "12", Location: [{ path: "/data/movies" }] },
            ],
          },
        }),
      })
      // Call 2: targeted refresh on section 12
      .mockResolvedValueOnce({ ok: true });

    const client = createPlexClient({ url: "http://plex:32400", token: "plex-token" });
    await client.notifyLibraryChanged("/data/movies/avatar.mkv");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://plex:32400/library/sections?X-Plex-Token=plex-token",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://plex:32400/library/sections/12/refresh?path=%2Fdata%2Fmovies%2Favatar.mkv&X-Plex-Token=plex-token",
      expect.anything(),
    );
  });

  it("getActiveStreamCount counts active playing sessions in Plex", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          size: 2,
          Metadata: [
            { title: "Movie 1", Player: { state: "playing" } },
            { title: "Movie 2", Player: { state: "paused" } },
          ],
        },
      }),
    });
    const client = createPlexClient({ url: "http://plex:32400", token: "plex-token" });
    const count = await client.getActiveStreamCount?.();
    expect(count).toBe(1);
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error", text: async () => "oops" });
    const client = createPlexClient({ url: "http://plex:32400", token: "bad", sectionId: "1" });
    await expect(client.notifyLibraryChanged()).rejects.toThrow(/500/);
  });
});

describe("discoverLocalMediaServers", () => {
  it("detects local Jellyfin, Emby, and Plex servers when responding", async () => {
    const customFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("32400/identity")) {
        return {
          ok: true,
          json: async () => ({
            MediaContainer: { version: "1.40.2.8395", machineIdentifier: "plex-id-123" },
          }),
        } as unknown as Response;
      }
      if (urlStr.includes("8096/System/Info/Public")) {
        if (urlStr.includes("emby")) {
          return {
            ok: true,
            json: async () => ({
              ServerName: "My Emby",
              Version: "4.8.8.0",
              ProductName: "Emby Server",
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            ServerName: "My Jellyfin",
            Version: "10.10.3",
            ProductName: "Jellyfin Server",
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const discovered = await discoverLocalMediaServers(customFetch as unknown as typeof fetch);
    expect(discovered.length).toBeGreaterThanOrEqual(2);

    const plex = discovered.find((s) => s.service === "plex");
    expect(plex).toBeDefined();
    expect(plex?.version).toBe("1.40.2.8395");

    const jellyfin = discovered.find((s) => s.service === "jellyfin");
    expect(jellyfin).toBeDefined();
    expect(jellyfin?.name).toBe("My Jellyfin");

    const emby = discovered.find((s) => s.service === "emby");
    expect(emby).toBeDefined();
    expect(emby?.name).toBe("My Emby");
  });

  it("returns empty array when no servers are reachable", async () => {
    const customFetch = vi.fn(async () => {
      throw new Error("Connection refused");
    });
    const discovered = await discoverLocalMediaServers(customFetch as unknown as typeof fetch);
    expect(discovered).toEqual([]);
  });
});
