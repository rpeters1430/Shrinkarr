import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJellyfinClient } from "../src/integrations/jellyfin.js";
import { createEmbyClient } from "../src/integrations/emby.js";
import { createPlexClient } from "../src/integrations/plex.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createJellyfinClient", () => {
  it("POSTs to /Library/Refresh with the X-Emby-Token header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createJellyfinClient({ url: "http://jellyfin:8096", apiKey: "jf-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith("http://jellyfin:8096/Library/Refresh", {
      method: "POST",
      headers: { "X-Emby-Token": "jf-key" },
    });
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad key" });
    const client = createJellyfinClient({ url: "http://jellyfin:8096", apiKey: "bad" });
    await expect(client.notifyLibraryChanged()).rejects.toThrow(/401/);
  });
});

describe("createEmbyClient", () => {
  it("POSTs to /Library/Refresh with the X-Emby-Token header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createEmbyClient({ url: "http://emby:8096", apiKey: "emby-key" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith("http://emby:8096/Library/Refresh", {
      method: "POST",
      headers: { "X-Emby-Token": "emby-key" },
    });
  });
});

describe("createPlexClient", () => {
  it("GETs the section refresh URL with the token as a query param", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = createPlexClient({ url: "http://plex:32400", token: "plex-token", sectionId: "1" });
    await client.notifyLibraryChanged();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://plex:32400/library/sections/1/refresh?X-Plex-Token=plex-token",
      { method: "GET" },
    );
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error", text: async () => "oops" });
    const client = createPlexClient({ url: "http://plex:32400", token: "bad", sectionId: "1" });
    await expect(client.notifyLibraryChanged()).rejects.toThrow(/500/);
  });
});
