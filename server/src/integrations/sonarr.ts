import type { MediaServerClient } from "./types.js";

export interface SonarrConfig {
  url: string;
  apiKey: string;
}

export function createSonarrClient(config: SonarrConfig): MediaServerClient {
  return {
    async notifyLibraryChanged(): Promise<void> {
      const res = await fetch(`${config.url}/api/v3/command`, {
        method: "POST",
        headers: { "X-Api-Key": config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "RescanSeries" }),
      });
      if (!res.ok) {
        throw new Error(`Sonarr rescan failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },
  };
}
