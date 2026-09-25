import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "m4v", "ts", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "vob"];
const AUDIO_EXTENSIONS = ["flac", "mp3", "m4a", "aac", "wav", "ogg", "opus", "wma", "ape", "wv"];

const IGNORE_PATTERNS = [
  "**/*.shrinkarr.tmp*",
  "**/*.sim-*",
  "**/*.bak",
  "**/.recycle/**",
  "**/#recycle/**",
  "**/.shrinkarr/**",
  "**/.deletedByTMM/**",
  "**/.stversions/**",
  "**/$RECYCLE.BIN/**",
  // Synology stores generated preview videos here.
  "**/@eaDir/**",
  "**/.Trash-*/**",
  "**/.Trashes/**",
  "**/lost+found/**",
  "**/.snapshot/**",
  "**/.zfs/**",
  "**/System Volume Information/**",
];

export interface WalkedFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Size and mtime come from the walk itself, saving a stat() per file.
 * Unreadable subdirectories are skipped instead of failing the walk.
 */
export async function walkLibraryEntries(
  libraryPath: string,
  kind: "video" | "audio" = "video",
): Promise<WalkedFile[]> {
  if (!existsSync(libraryPath)) {
    throw new Error(`Library path does not exist: "${libraryPath}"`);
  }
  const normalizedPath = libraryPath.replace(/\\/g, "/");
  const extensions = kind === "audio" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
  const pattern = `**/*.{${extensions.join(",")}}`;
  try {
    const entries = await fg(pattern, {
      cwd: normalizedPath,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      stats: true,
      suppressErrors: true,
      ignore: IGNORE_PATTERNS,
    });
    return entries.map((entry) => ({
      path: resolve(entry.path),
      sizeBytes: entry.stats?.size ?? 0,
      mtimeMs: Math.floor(entry.stats?.mtimeMs ?? 0),
    }));
  } catch (err) {
    throw new Error(`Unable to walk library "${libraryPath}": ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export async function walkLibrary(libraryPath: string, kind: "video" | "audio" = "video"): Promise<string[]> {
  const entries = await walkLibraryEntries(libraryPath, kind);
  return entries.map((entry) => entry.path);
}
