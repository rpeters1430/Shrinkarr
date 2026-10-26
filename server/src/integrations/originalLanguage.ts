import type { Config } from "../config/schema.js";
import { normalizeLanguage } from "../transcode/streams.js";
import { mapArrPath, type PathMapping } from "./arrWebhook.js";
import { normalizeIntegrationUrl } from "./types.js";

// One movie or series folder, as Shrinkarr sees it, and its original language.
export interface OriginalLanguageEntry {
  root: string;
  language: string | null;
}

interface ArrTitle {
  path?: unknown;
  originalLanguage?: { name?: unknown } | null;
}

const CACHE_MS = 15 * 60_000;
// After a failed fetch, files get "unknown" for this long before trying again.
const RETRY_MS = 60_000;

/**
 * Turns a Sonarr/Radarr language name ("English", "Portuguese (Brazil)")
 * into a three-letter code. Null for "Any", "Original", "Unknown" and names
 * there is no code for.
 */
export function arrLanguageToCode(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const code = normalizeLanguage(name.replace(/\(.*\)/, ""));
  return /^[a-z]{3}$/.test(code) && code !== "und" && code !== "any" ? code : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function fetchTitles(kind: "series" | "movie", service: { url: string; apiKey: string }): Promise<ArrTitle[]> {
  const res = await fetch(`${normalizeIntegrationUrl(service.url)}/api/v3/${kind}`, {
    headers: { "X-Api-Key": service.apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

export function toEntries(titles: ArrTitle[], pathMappings: PathMapping[]): OriginalLanguageEntry[] {
  const entries: OriginalLanguageEntry[] = [];
  for (const title of titles) {
    if (typeof title.path !== "string" || !title.path.trim()) continue;
    entries.push({
      root: normalizePath(mapArrPath(title.path.trim(), pathMappings)),
      language: arrLanguageToCode(title.originalLanguage?.name),
    });
  }
  return entries;
}

/** The original language of the deepest folder holding the file. */
export function findOriginalLanguage(entries: OriginalLanguageEntry[], filePath: string): string | null {
  const path = normalizePath(filePath);
  let best: OriginalLanguageEntry | undefined;
  for (const entry of entries) {
    if (!entry.root || !path.startsWith(`${entry.root}/`)) continue;
    if (!best || entry.root.length > best.root.length) best = entry;
  }
  return best?.language ?? null;
}

let cache: { key: string; expiresAt: number; entries: Promise<OriginalLanguageEntry[]> } | undefined;

type LanguageConfig = Pick<Config, "integrations" | "webhooks">;

// Reads every series and movie once and keeps the list for CACHE_MS, so a
// scan of thousands of files makes two requests, not thousands.
function loadEntries(config: LanguageConfig): Promise<OriginalLanguageEntry[]> {
  const { sonarr, radarr } = config.integrations;
  const pathMappings = config.webhooks?.pathMappings ?? [];
  const key = JSON.stringify([sonarr?.url, sonarr?.apiKey, radarr?.url, radarr?.apiKey, pathMappings]);
  if (cache && cache.key === key && cache.expiresAt > Date.now()) return cache.entries;

  const entries = (async () => {
    const lists = await Promise.all([
      sonarr?.url && sonarr.apiKey ? fetchTitles("series", sonarr).catch((err) => {
        throw new Error(`Sonarr: ${(err as Error).message}`, { cause: err });
      }) : [],
      radarr?.url && radarr.apiKey ? fetchTitles("movie", radarr).catch((err) => {
        throw new Error(`Radarr: ${(err as Error).message}`, { cause: err });
      }) : [],
    ]);
    return toEntries(lists.flat(), pathMappings);
  })();
  const entry = { key, expiresAt: Date.now() + CACHE_MS, entries };
  cache = entry;
  entries.catch((err) => {
    console.warn(`[OriginalLanguage] Could not read original languages: ${(err as Error).message}`);
    entry.expiresAt = Date.now() + RETRY_MS;
  });
  return entries;
}

/**
 * The original language of the movie or series a file belongs to, from
 * Sonarr/Radarr. Null when neither is set up or the file isn't in them;
 * undefined when they couldn't be reached, so the caller can try again later.
 */
export async function lookupOriginalLanguage(filePath: string, config: LanguageConfig): Promise<string | null | undefined> {
  const { sonarr, radarr } = config.integrations;
  if (!(sonarr?.url && sonarr.apiKey) && !(radarr?.url && radarr.apiKey)) return null;
  try {
    return findOriginalLanguage(await loadEntries(config), filePath);
  } catch {
    return undefined;
  }
}

export function resetOriginalLanguageCache(): void {
  cache = undefined;
}
