import { stat } from "node:fs/promises";
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

// Media trees are rarely more than a dozen levels deep. The cap bounds the
// walk when followed symlinks form a loop.
const MAX_DEPTH = 24;
const PROGRESS_EVERY = 250;

/**
 * Size and mtime come from the walk itself, saving a stat() per file.
 * Unreadable subdirectories are skipped instead of failing the walk.
 */
export async function walkLibraryEntries(
  libraryPath: string,
  kind: "video" | "audio" = "video",
  onProgress?: (found: number) => void,
): Promise<WalkedFile[]> {
  // Async so a hung network mount blocks a libuv worker, not the event loop.
  const rootStat = await stat(libraryPath).catch(() => null);
  if (!rootStat) {
    throw new Error(`Library path does not exist: "${libraryPath}"`);
  }
  const normalizedPath = libraryPath.replace(/\\/g, "/");
  const extensions = kind === "audio" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
  const pattern = `**/*.{${extensions.join(",")}}`;
  const files: WalkedFile[] = [];
  try {
    const stream = fg.stream(pattern, {
      cwd: normalizedPath,
      absolute: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      stats: true,
      suppressErrors: true,
      deep: MAX_DEPTH,
      ignore: IGNORE_PATTERNS,
    });
    for await (const raw of stream) {
      const entry = raw as unknown as fg.Entry;
      files.push({
        path: resolve(entry.path),
        sizeBytes: entry.stats?.size ?? 0,
        mtimeMs: Math.floor(entry.stats?.mtimeMs ?? 0),
      });
      if (onProgress && files.length % PROGRESS_EVERY === 0) {
        onProgress(files.length);
      }
    }
  } catch (err) {
    throw new Error(`Unable to walk library "${libraryPath}": ${(err as Error).message}`, {
      cause: err,
    });
  }
  onProgress?.(files.length);
  return files;
}

export async function walkLibrary(libraryPath: string, kind: "video" | "audio" = "video"): Promise<string[]> {
  const entries = await walkLibraryEntries(libraryPath, kind);
  return entries.map((entry) => entry.path);
}
