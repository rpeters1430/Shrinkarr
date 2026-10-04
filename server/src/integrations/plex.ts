import { normalizeIntegrationUrl, type MediaServerClient } from "./types.js";

export interface PlexConfig {
  url: string;
  token: string;
  sectionId?: string;
}

async function resolvePlexSectionForPath(baseUrl: string, token: string, filePath: string): Promise<string | null> {
  try {
    const url = `${baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      MediaContainer?: {
        Directory?: Array<{
          key?: string;
          Location?: Array<{ path?: string }>;
        }>;
      };
    };
    const dirs = data.MediaContainer?.Directory;
    if (!Array.isArray(dirs)) return null;

    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();
    for (const d of dirs) {
      if (!d.key || !Array.isArray(d.Location)) continue;
      for (const loc of d.Location) {
        if (!loc.path) continue;
        const normLoc = loc.path.replace(/\\/g, "/").toLowerCase();
        if (normTarget.startsWith(normLoc)) {
          return d.key;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function createPlexClient(config: PlexConfig): MediaServerClient {
  const baseUrl = normalizeIntegrationUrl(config.url);
  const token = config.token;

  return {
    async notifyLibraryChanged(filePath?: string): Promise<void> {
      if (filePath) {
        try {
          let section = config.sectionId;
          if (!section) {
            section = (await resolvePlexSectionForPath(baseUrl, token, filePath)) ?? undefined;
          }
          const targetSection = section ?? "all";
          const partialUrl = `${baseUrl}/library/sections/${encodeURIComponent(targetSection)}/refresh?path=${encodeURIComponent(filePath)}&X-Plex-Token=${encodeURIComponent(token)}`;
          const partialRes = await fetch(partialUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
          });
          if (partialRes.ok) {
            return;
          }
        } catch {
          // Fall back to full section / library refresh below
        }
      }

      const section = config.sectionId ?? "all";
      const url = `${baseUrl}/library/sections/${encodeURIComponent(section)}/refresh?X-Plex-Token=${encodeURIComponent(token)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`Plex refresh failed: ${res.status} ${res.statusText}: ${await res.text()}`);
      }
    },

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      try {
        const url = `${baseUrl}/identity?X-Plex-Token=${encodeURIComponent(token)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "X-Plex-Token": token },
          signal: AbortSignal.timeout(6000),
        });

        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message: "Authentication failed (HTTP 401/403): Invalid Plex Token.",
          };
        }

        if (!res.ok) {
          return {
            ok: false,
            message: `Plex returned HTTP ${res.status}: ${res.statusText}`,
          };
        }

        return {
          ok: true,
          message: "Connected to Plex Media Server successfully!",
        };
      } catch (err) {
        return {
          ok: false,
          message: `Could not connect to Plex at ${baseUrl}: ${(err as Error).message}`,
        };
      }
    },

    async getActiveStreamCount(): Promise<number> {
      try {
        const url = `${baseUrl}/status/sessions?X-Plex-Token=${encodeURIComponent(token)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "X-Plex-Token": token },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return 0;
        const data = (await res.json()) as {
          MediaContainer?: {
            size?: number;
            Metadata?: Array<{
              Player?: { state?: string };
            }>;
          };
        };
        const metadata = data?.MediaContainer?.Metadata;
        if (Array.isArray(metadata)) {
          return metadata.filter((m) => m.Player?.state !== "paused").length;
        }
        return data?.MediaContainer?.size ?? 0;
      } catch {
        return 0;
      }
    },
  };
}

