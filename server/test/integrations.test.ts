import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbyClient } from "../src/integrations/emby.js";
import { createJellyfinClient } from "../src/integrations/jellyfin.js";
import { createPlexClient } from "../src/integrations/plex.js";
import { createRadarrClient } from "../src/integrations/radarr.js";
import { createSonarrClient } from "../src/integrations/sonarr.js";
import { normalizeIntegrationUrl } from "../src/integrations/types.js";

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
