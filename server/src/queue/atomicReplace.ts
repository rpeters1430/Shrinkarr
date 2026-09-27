import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { sleep } from "../utils/fileLock.js";

export interface ReplaceOriginalOptions {
  retryAttempts?: number;
  retryDelaySeconds?: number;
  destinationPath?: string;
}

/**
 * Atomically replaces the original media file with the transcoded temp file.
 * Includes a timing retry system that gracefully handles transient file locks
 * (e.g. from Plex/Jellyfin active scanning, media playback, or Windows Explorer).
 * Supports same-directory atomic renames or cross-volume staging (e.g. NVMe scratch disk to HDD pool).
 * Also supports cross-container replacements (e.g. replacing .mkv with .mp4).
 */
export async function replaceOriginal(
  originalPath: string,
  tempOutputPath: string,
  recycleBinDir?: string,
  options: ReplaceOriginalOptions = {},
): Promise<void> {
  const finalDestination = options.destinationPath ? resolve(options.destinationPath) : resolve(originalPath);
  const isSameDir = resolve(dirname(finalDestination)) === resolve(dirname(tempOutputPath));
  const maxAttempts = Math.max(1, options.retryAttempts ?? 6);
  const baseDelayMs = Math.max(500, (options.retryDelaySeconds ?? 5) * 1000);
  const backupPath = `${originalPath}.shrinkarr.bak`;
  const stagingPath = `${finalDestination}.shrinkarr.staging.${Date.now()}`;
  const changesPath = finalDestination !== resolve(originalPath);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Step 1: If cross-directory or cross-volume, stage the temp file onto the destination filesystem
      if (!isSameDir) {
        if (existsSync(stagingPath)) {
          await cleanupTemp(stagingPath);
        }
        await copyFile(tempOutputPath, stagingPath);
      }

      const fileToSwap = isSameDir ? tempOutputPath : stagingPath;

      if (existsSync(backupPath)) {
        try {
          await unlink(backupPath);
        } catch (unlinkErr) {
          if (!isSameDir) await cleanupTemp(stagingPath);
          throw new Error(`Cannot clear previous backup "${backupPath}": ${(unlinkErr as Error).message}`, {
            cause: unlinkErr,
          });
        }
      }

      if (changesPath) {
        // Container change (movie.mkv -> movie.mp4): install the new file
        // first, refusing to overwrite anything already at that name, and
        // only then move the original aside. A crash in between leaves both
        // files, never neither.
        try {
          await installWithoutOverwrite(fileToSwap, finalDestination);
        } catch (installErr) {
          if (!isSameDir) await cleanupTemp(stagingPath);
          throw installErr;
        }
        await writeReplaceMarker(backupPath, { phase: "installed", originalPath, destination: finalDestination });
        try {
          await rename(originalPath, backupPath);
        } catch (backupErr) {
          // Undo the install so a retry starts from the same state.
          await removeReplaceMarker(backupPath);
          try {
            await rename(finalDestination, fileToSwap);
          } catch {
            // leave the new file in place; the original is untouched either way
          }
          throw backupErr;
        }
      } else {
        await writeReplaceMarker(backupPath, { phase: "backed-up", originalPath, destination: finalDestination });
        await rename(originalPath, backupPath);

        try {
          await rename(fileToSwap, finalDestination);
        } catch (replaceErr) {
          // Attempt rollback
          try {
            if (existsSync(backupPath)) {
              await rename(backupPath, originalPath);
            }
          } catch {
            // best-effort rollback; the original replace error below is the one that matters
          }
          await removeReplaceMarker(backupPath);
          if (!isSameDir) await cleanupTemp(stagingPath);
          const wrappedErr = new Error(
            `Failed to move transcoded file to final destination; restored original: ${(replaceErr as Error).message}`,
            { cause: replaceErr },
          );
          (wrappedErr as NodeJS.ErrnoException).code = (replaceErr as NodeJS.ErrnoException).code;
          throw wrappedErr;
        }
        await writeReplaceMarker(backupPath, { phase: "installed", originalPath, destination: finalDestination });
      }

      // Cleanup original temp file if staged from another volume
      if (!isSameDir) {
        await cleanupTemp(tempOutputPath);
      }

      // Step 4: Handle backup (recycle bin or unlink)
      await disposeBackup(backupPath, originalPath, recycleBinDir);
      await removeReplaceMarker(backupPath);

      // Successful replacement!
      return;
    } catch (err) {
      lastError = err as Error;
      const code = (err as NodeJS.ErrnoException).code || (err as { cause?: NodeJS.ErrnoException }).cause?.code;
      const isLockError =
        code === "EBUSY" ||
        code === "EPERM" ||
        code === "EACCES" ||
        code === "ETXTBSY" ||
        /busy|locked|resource|permission denied/i.test((err as Error).message);

      if (isLockError && code !== "EEXIST" && attempt < maxAttempts) {
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

export type ReplacePhase = "backed-up" | "installed";

export interface ReplaceMarker {
  phase: ReplacePhase;
  originalPath: string;
  destination: string;
}

/** Marker beside "<file>.shrinkarr.bak" recording how far a replacement got, for crash recovery. */
export function replaceMarkerPath(backupPath: string): string {
  return `${backupPath}.txn`;
}

async function writeReplaceMarker(backupPath: string, marker: ReplaceMarker): Promise<void> {
  const target = replaceMarkerPath(backupPath);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(marker));
  await rename(tmp, target);
}

async function removeReplaceMarker(backupPath: string): Promise<void> {
  await cleanupTemp(replaceMarkerPath(backupPath));
}

export async function readReplaceMarker(backupPath: string): Promise<ReplaceMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(replaceMarkerPath(backupPath), "utf-8")) as Partial<ReplaceMarker>;
    if ((parsed.phase === "backed-up" || parsed.phase === "installed") && typeof parsed.originalPath === "string") {
      return parsed as ReplaceMarker;
    }
  } catch {
    // missing or unreadable
  }
  return null;
}

const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Moves src to dest but fails instead of replacing an existing dest. link()
 * refuses an existing target atomically; filesystems without hardlinks fall
 * back to a check right before the rename.
 */
async function installWithoutOverwrite(src: string, dest: string): Promise<void> {
  const exists = () => {
    const err = new Error(`"${basename(dest)}" already exists; refusing to overwrite it`);
    (err as NodeJS.ErrnoException).code = "EEXIST";
    return err;
  };
  try {
    await link(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw exists();
    if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
    if (existsSync(dest)) throw exists();
    await rename(src, dest);
    return;
  }
  await cleanupTemp(src);
}

/**
 * Moves a replaced original into the recycle bin when one is configured,
 * otherwise deletes it. Falls back to deleting if the recycle bin is unusable.
 */
export async function disposeBackup(backupPath: string, originalPath: string, recycleBinDir?: string): Promise<void> {
  if (!recycleBinDir) {
    await cleanupTemp(backupPath);
    return;
  }
  try {
    if (!existsSync(recycleBinDir)) {
      await mkdir(recycleBinDir, { recursive: true });
    }
    // The random part keeps two same-named files recycled in one millisecond apart.
    const recycledDest = join(recycleBinDir, `${basename(originalPath)}.${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
    try {
      await rename(backupPath, recycledDest);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "EXDEV") {
        await copyFile(backupPath, recycledDest);
        await cleanupTemp(backupPath);
      } else {
        throw renameErr;
      }
    }
  } catch {
    // If move to recycle bin fails across volumes/permissions, fallback to unlink
    await cleanupTemp(backupPath);
  }
}

export async function cleanupTemp(tempPath: string): Promise<void> {
  try {
    if (existsSync(tempPath)) {
      await unlink(tempPath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Best effort cleanup
    }
  }
}

export function cleanupTempSync(tempPath: string): void {
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
