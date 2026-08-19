import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function replaceOriginal(
  originalPath: string,
  tempOutputPath: string,
  recycleBinDir?: string,
): void {
  if (resolve(dirname(originalPath)) !== resolve(dirname(tempOutputPath))) {
    throw new Error(
      `Refusing to replace "${originalPath}" with a temp file from a different directory: "${tempOutputPath}"`,
    );
  }

  const backupPath = `${originalPath}.shrinkarr.bak`;

  // Step 1: Move original to backup file
  try {
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
    renameSync(originalPath, backupPath);
  } catch (err) {
    throw new Error(`Failed to stage original file to backup before replacing: ${(err as Error).message}`);
  }

  // Step 2: Move new transcoded temp file into place
  try {
    renameSync(tempOutputPath, originalPath);
  } catch (replaceErr) {
    // Attempt rollback
    try {
      if (existsSync(backupPath)) {
        renameSync(backupPath, originalPath);
      }
    } catch {}
    throw new Error(`Failed to move transcoded file to final destination; restored original: ${(replaceErr as Error).message}`);
  }

  // Step 3: Handle backup (recycle bin or unlink)
  if (recycleBinDir) {
    try {
      if (!existsSync(recycleBinDir)) {
        mkdirSync(recycleBinDir, { recursive: true });
      }
      const recycledDest = join(recycleBinDir, `${basename(originalPath)}.${Date.now()}.bak`);
      renameSync(backupPath, recycledDest);
    } catch {
      // If move to recycle bin fails across volumes, fallback to unlink
      cleanupTemp(backupPath);
    }
  } else {
    cleanupTemp(backupPath);
  }
}

export function cleanupTemp(tempPath: string): void {
  try {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Best effort cleanup
    }
  }
}
