import { normalizeIntegrationUrl, type MediaServerClient } from "./types.js";

export interface JellyfinConfig {
  url: string;
  apiKey: string;
}

export function createJellyfinClient(config: JellyfinConfig): MediaServerClient {
  const baseUrl = normalizeIntegrationUrl(config.url);
  const authHeaders: Record<string, string> = {
    "X-Emby-Token": config.apiKey,
    "X-MediaBrowser-Token": config.apiKey,
    "Authorization": `MediaBrowser Token="${config.apiKey}", Client="Shrinkarr", Device="Server", DeviceId="shrinkarr-auto", Version="0.1.0"`,
  };

  return {
    async notifyLibraryChanged(): Promise<void> {
      const url = `${baseUrl}/Library/Refresh?api_key=${encodeURIComponent(config.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`Jellyfin refresh failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      try {
        const url = `${baseUrl}/System/Info?api_key=${encodeURIComponent(config.apiKey)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: authHeaders,
          signal: AbortSignal.timeout(6000),
        });

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message: "Authentication failed (HTTP 401/403): Invalid Jellyfin API Key. Check Jellyfin Dashboard -> API Keys.",
          };
        }

        if (!res.ok) {
          return {
            ok: false,
            message: `Jellyfin server returned HTTP ${res.status}: ${res.statusText}`,
          };
        }

        const data = (await res.json()) as { ServerName?: string; Version?: string; ProductName?: string };
        const name = data.ServerName || data.ProductName || "Jellyfin Server";
        const ver = data.Version ? ` v${data.Version}` : "";
        return {
          ok: true,
          message: `Connected to ${name}${ver} successfully!`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `Could not connect to Jellyfin at ${baseUrl}: ${(err as Error).message}`,
        };
      }
    },
  };
}

