import { normalizeIntegrationUrl, type MediaServerClient } from "./types.js";

export interface SonarrConfig {
  url: string;
  apiKey: string;
}

export function createSonarrClient(config: SonarrConfig): MediaServerClient {
  const baseUrl = normalizeIntegrationUrl(config.url);
  const headers: Record<string, string> = {
    "X-Api-Key": config.apiKey,
    "Content-Type": "application/json",
  };

  return {
    async notifyLibraryChanged(): Promise<void> {
      const res = await fetch(`${baseUrl}/api/v3/command`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "RescanSeries" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`Sonarr rescan failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      try {
        const res = await fetch(`${baseUrl}/api/v3/system/status`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(6000),
        });

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message: "Authentication failed (HTTP 401/403): Invalid Sonarr API Key. Check Settings -> General -> Security.",
          };
        }

        if (!res.ok) {
          return {
            ok: false,
            message: `Sonarr returned HTTP ${res.status}: ${res.statusText}`,
          };
        }

        const data = (await res.json()) as { appName?: string; version?: string };
        const name = data.appName || "Sonarr";
        const ver = data.version ? ` v${data.version}` : "";
        return {
          ok: true,
          message: `Connected to ${name}${ver} successfully!`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `Could not connect to Sonarr at ${baseUrl}: ${(err as Error).message}`,
        };
      }
    },
  };
}

