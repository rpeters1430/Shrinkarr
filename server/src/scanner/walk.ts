import { existsSync } from "node:fs";
import fg from "fast-glob";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "m4v", "ts", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "vob"];

export async function walkLibrary(libraryPath: string): Promise<string[]> {
  if (!existsSync(libraryPath)) {
    return [];
  }
  const normalizedPath = libraryPath.replace(/\\/g, "/");
  const pattern = `**/*.{${VIDEO_EXTENSIONS.join(",")}}`;
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
    return entries;
  } catch (err) {
    console.warn(`Error walking directory "${libraryPath}": ${(err as Error).message}`);
    return [];
  }
}
