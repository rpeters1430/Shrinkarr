import type { MediaServerClient } from "./types.js";

export interface EmbyConfig {
  url: string;
  apiKey: string;
}

export function createEmbyClient(config: EmbyConfig): MediaServerClient {
  return {
    async notifyLibraryChanged(): Promise<void> {
      const res = await fetch(`${config.url}/Library/Refresh`, {
        method: "POST",
        headers: { "X-Emby-Token": config.apiKey },
      });
      if (!res.ok) {
        throw new Error(`Emby refresh failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },
  };
}
