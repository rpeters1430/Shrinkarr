import type { MediaServerClient } from "./types.js";

export interface JellyfinConfig {
  url: string;
  apiKey: string;
}

export function createJellyfinClient(config: JellyfinConfig): MediaServerClient {
  return {
    async notifyLibraryChanged(): Promise<void> {
      const res = await fetch(`${config.url}/Library/Refresh`, {
        method: "POST",
        headers: { "X-Emby-Token": config.apiKey },
      });
      if (!res.ok) {
        throw new Error(`Jellyfin refresh failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },
  };
}
