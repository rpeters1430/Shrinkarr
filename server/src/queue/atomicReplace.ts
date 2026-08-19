import { renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function replaceOriginal(originalPath: string, tempOutputPath: string): void {
  if (resolve(dirname(originalPath)) !== resolve(dirname(tempOutputPath))) {
    throw new Error(
      `Refusing to replace "${originalPath}" with a temp file from a different directory: "${tempOutputPath}"`,
    );
  }
  renameSync(tempOutputPath, originalPath);
}

export function cleanupTemp(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
