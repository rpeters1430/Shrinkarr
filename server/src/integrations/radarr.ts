import type { MediaServerClient } from "./types.js";

export interface RadarrConfig {
  url: string;
  apiKey: string;
}

export function createRadarrClient(config: RadarrConfig): MediaServerClient {
  return {
    async notifyLibraryChanged(): Promise<void> {
      const res = await fetch(`${config.url}/api/v3/command`, {
        method: "POST",
        headers: { "X-Api-Key": config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "RescanMovie" }),
      });
      if (!res.ok) {
        throw new Error(`Radarr rescan failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },
  };
}
