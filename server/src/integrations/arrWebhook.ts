import { createHmac, timingSafeEqual } from "node:crypto";
import type { Library } from "../config/schema.js";
import { isPathInsideLibraries } from "../scanner/pathGuard.js";

export interface PathMapping {
  from: string;
  to: string;
}

// Events that add, replace, rename or remove files on disk. "Grab" fires
// before anything is downloaded, so it is not here.
const FILE_EVENTS = new Set([
  "Download",
  "ImportComplete",
  "Rename",
  "EpisodeFileDelete",
  "MovieFileDelete",
  "SeriesDelete",
  "MovieDelete",
]);

interface PathHolder {
  path?: unknown;
  folderPath?: unknown;
}

interface ArrPayload {
  eventType?: unknown;
  series?: PathHolder;
  movie?: PathHolder;
  episodeFile?: PathHolder;
  episodeFiles?: PathHolder[];
  movieFile?: PathHolder;
  renamedEpisodeFiles?: PathHolder[];
  renamedMovieFiles?: PathHolder[];
}

export type ArrWebhookEvent =
  | { kind: "test" }
  | { kind: "ignored"; eventType: string }
  | { kind: "files"; eventType: string; paths: string[] };

/** Reads the event type and every file or folder path a Sonarr/Radarr payload names. */
export function parseArrWebhook(body: unknown): ArrWebhookEvent {
  const payload = (body && typeof body === "object" ? body : {}) as ArrPayload;
  const eventType = typeof payload.eventType === "string" ? payload.eventType : "";
  if (eventType === "Test") return { kind: "test" };
  if (!FILE_EVENTS.has(eventType)) return { kind: "ignored", eventType };

  const holders: Array<PathHolder | undefined> = [
    payload.episodeFile,
    payload.movieFile,
    ...(Array.isArray(payload.episodeFiles) ? payload.episodeFiles : []),
    ...(Array.isArray(payload.renamedEpisodeFiles) ? payload.renamedEpisodeFiles : []),
    ...(Array.isArray(payload.renamedMovieFiles) ? payload.renamedMovieFiles : []),
    // The series or movie folder is the fallback for events without a file,
    // such as SeriesDelete.
    payload.series,
    payload.movie,
  ];
  const paths = new Set<string>();
  for (const holder of holders) {
    for (const value of [holder?.path, holder?.folderPath]) {
      if (typeof value === "string" && value.trim()) paths.add(value.trim());
    }
  }
  return { kind: "files", eventType, paths: [...paths] };
}

/**
 * Rewrites a path as Sonarr/Radarr see it into the path Shrinkarr sees, for
 * setups where they mount the same storage at different places (e.g. "/tv"
 * in the Sonarr container, "/media/tv" here). The longest matching prefix wins.
 */
export function mapArrPath(path: string, mappings: PathMapping[]): string {
  const normalized = path.replace(/\\/g, "/");
  let best: { from: string; to: string } | undefined;
  for (const mapping of mappings) {
    const from = mapping.from.replace(/\\/g, "/").replace(/\/+$/, "");
    const matches = normalized === from || normalized.startsWith(`${from}/`);
    if (matches && (!best || from.length > best.from.length)) {
      best = { from, to: mapping.to.replace(/[\\/]+$/, "") };
    }
  }
  return best ? best.to + normalized.slice(best.from.length) : path;
}

/** The library containing the path. With nested libraries, the deepest one wins. */
export function findLibraryForPath(path: string, libraries: Library[]): Library | undefined {
  return libraries
    .filter((library) => isPathInsideLibraries(path, [library]))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

// Derived from the session secret so there is nothing extra to store or
// leak through the config API; changing the secret changes the token.
export function arrWebhookToken(sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update("shrinkarr-arr-webhook").digest("hex").slice(0, 32);
}

export function isValidArrWebhookToken(candidate: string | undefined, sessionSecret: string): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(arrWebhookToken(sessionSecret));
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
