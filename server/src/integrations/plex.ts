import type { MediaServerClient } from "./types.js";

export interface PlexConfig {
  url: string;
  token: string;
  sectionId: string;
}

export function createPlexClient(config: PlexConfig): MediaServerClient {
  return {
    async notifyLibraryChanged(): Promise<void> {
      const url = `${config.url}/library/sections/${config.sectionId}/refresh?X-Plex-Token=${config.token}`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`Plex refresh failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },
  };
}
