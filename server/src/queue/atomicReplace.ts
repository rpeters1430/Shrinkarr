import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sleep } from "../utils/fileLock.js";

export interface ReplaceOriginalOptions {
  retryAttempts?: number;
  retryDelaySeconds?: number;
}

/**
 * Atomically replaces the original media file with the transcoded temp file.
 * Includes a timing retry system that gracefully handles transient file locks
 * (e.g. from Plex/Jellyfin active scanning, media playback, or Windows Explorer).
 */
export async function replaceOriginal(
  originalPath: string,
  tempOutputPath: string,
  recycleBinDir?: string,
  options: ReplaceOriginalOptions = {},
): Promise<void> {
  if (resolve(dirname(originalPath)) !== resolve(dirname(tempOutputPath))) {
    throw new Error(
      `Refusing to replace "${originalPath}" with a temp file from a different directory: "${tempOutputPath}"`,
    );
  }

  const maxAttempts = Math.max(1, options.retryAttempts ?? 6);
  const baseDelayMs = Math.max(500, (options.retryDelaySeconds ?? 5) * 1000);
  const backupPath = `${originalPath}.shrinkarr.bak`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Step 1: Move original to backup file
      if (existsSync(backupPath)) {
        try {
          unlinkSync(backupPath);
        } catch (unlinkErr) {
          // If backup file itself is locked, throw to trigger retry
          throw new Error(`Cannot clear previous backup "${backupPath}": ${(unlinkErr as Error).message}`, {
            cause: unlinkErr,
          });
        }
      }
      renameSync(originalPath, backupPath);

      // Step 2: Move new transcoded temp file into place
      try {
        renameSync(tempOutputPath, originalPath);
      } catch (replaceErr) {
        // Attempt rollback
        try {
          if (existsSync(backupPath)) {
            renameSync(backupPath, originalPath);
          }
        } catch {
          // best-effort rollback; the original replace error below is the one that matters
        }
        throw new Error(
          `Failed to move transcoded file to final destination; restored original: ${(replaceErr as Error).message}`,
          { cause: replaceErr },
        );
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

      // Successful replacement!
      return;
    } catch (err) {
      lastError = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      const isLockError =
        code === "EBUSY" ||
        code === "EPERM" ||
        code === "EACCES" ||
        code === "ETXTBSY" ||
        /busy|locked|resource|permission denied/i.test((err as Error).message);

      if (isLockError && attempt < maxAttempts) {
        const delayMs = Math.min(baseDelayMs * Math.pow(1.2, attempt - 1), 15000);
        console.warn(
          `[FileLock Timing] Original file "${basename(originalPath)}" appears locked/in-use by another process (e.g. Plex, Jellyfin, Windows Explorer). Retrying replacement in ${(delayMs / 1000).toFixed(1)}s (Attempt ${attempt}/${maxAttempts})...`,
        );
        await sleep(delayMs);
        continue;
      }

      throw new Error(
        `Failed to replace original file after ${attempt} attempt(s): ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  if (lastError) {
    throw lastError;
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
