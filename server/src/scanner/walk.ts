import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "m4v", "ts", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "vob"];
const AUDIO_EXTENSIONS = ["flac", "mp3", "m4a", "aac", "wav", "ogg", "opus", "wma", "ape", "wv"];

export async function walkLibrary(libraryPath: string, kind: "video" | "audio" = "video"): Promise<string[]> {
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
      ignore: [
        "**/*.shrinkarr.tmp*",
        "**/*.sim-*",
        "**/*.bak",
        "**/.recycle/**",
        "**/#recycle/**",
        "**/.shrinkarr/**",
        "**/.deletedByTMM/**",
        "**/.stversions/**",
        "**/$RECYCLE.BIN/**",
      ],
    });
    return entries.map((entry) => resolve(entry));
  } catch (err) {
    throw new Error(`Unable to walk library "${libraryPath}": ${(err as Error).message}`, {
      cause: err,
    });
  }
}

