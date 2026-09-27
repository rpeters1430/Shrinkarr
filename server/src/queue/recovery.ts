import fg from "fast-glob";
import { existsSync } from "node:fs";
import { readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config/schema.js";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "../scanner/walk.js";
import { cleanupTemp, disposeBackup } from "./atomicReplace.js";

const BACKUP_SUFFIX = ".shrinkarr.bak";
const STAGING_MARKER = ".shrinkarr.staging.";

export interface RecoveryReport {
  restored: string[];
  discardedBackups: string[];
  removedTempFiles: string[];
}

function toGlobCwd(path: string): string {
  return path.replace(/\\/g, "/");
}

function isShrinkarrWorkFile(name: string, tempSuffix: string): boolean {
  return name.endsWith(BACKUP_SUFFIX) || name.includes(STAGING_MARKER) || name.includes(`${tempSuffix}.`);
}

const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].map((ext) => `.${ext}`));

/**
 * A container change (movie.mkv -> movie.mp4) leaves the new file under a
 * different extension. The worker refuses such a job when the new name is
 * already taken, so a same-stem media file written after the original counts
 * as the finished replacement. Sidecars (.srt, .nfo) never count.
 */
async function hasReplacementSibling(originalPath: string, backupMtimeMs: number, tempSuffix: string): Promise<boolean> {
  const dir = dirname(originalPath);
  const originalName = basename(originalPath);
  const stem = basename(originalPath, extname(originalPath));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const ext = extname(name);
    if (name === originalName || isShrinkarrWorkFile(name, tempSuffix)) continue;
    if (!MEDIA_EXTENSIONS.has(ext.toLowerCase()) || basename(name, ext) !== stem) continue;
    try {
      if ((await stat(join(dir, name))).mtimeMs >= backupMtimeMs) return true;
    } catch {
      // vanished while looking; ignore
    }
  }
  return false;
}

/**
 * Repairs what a crash in the middle of replaceOriginal can leave behind:
 * - "<file>.shrinkarr.bak" with nothing at <file>: the original was moved
 *   aside but the new encode never landed, so the original is put back.
 * - "<file>.shrinkarr.bak" next to the finished file: the swap completed and
 *   only the backup cleanup was missed, so it goes to the recycle bin (or is
 *   deleted), exactly as a normal job would have done.
 * - "*.shrinkarr.staging.*": partial cross-volume copies, always deleted.
 * - "*<tempSuffix>.*": unfinished encodes in library folders and in
 *   queue.tempDirectory, always deleted.
 *
 * Must run before the queue starts any job, since those files are only
 * orphans while nothing is transcoding.
 */
export async function recoverInterruptedWork(config: Config): Promise<RecoveryReport> {
  const report: RecoveryReport = { restored: [], discardedBackups: [], removedTempFiles: [] };
  const tempSuffix = config.queue.tempSuffix;
  const tempPattern = `**/*${fg.escapePath(tempSuffix)}.*`;

  for (const library of config.libraries) {
    if (!library.path || !existsSync(library.path)) continue;
    let found: string[];
    try {
      found = await fg([`**/*${BACKUP_SUFFIX}`, `**/*${STAGING_MARKER}*`, tempPattern], {
        cwd: toGlobCwd(library.path),
        absolute: true,
        onlyFiles: true,
        dot: true,
      });
    } catch (err) {
      console.warn(`[Recovery] Could not search "${library.path}": ${(err as Error).message}`);
      continue;
    }

    // Backups first, so a restored original is in place before anything else is touched.
    const backups = found.filter((p) => p.endsWith(BACKUP_SUFFIX));
    const leftovers = found.filter((p) => !p.endsWith(BACKUP_SUFFIX));

    for (const backupPath of backups) {
      const originalPath = backupPath.slice(0, -BACKUP_SUFFIX.length);
      try {
        const backupMtimeMs = (await stat(backupPath)).mtimeMs;
        if (existsSync(originalPath) || (await hasReplacementSibling(originalPath, backupMtimeMs, tempSuffix))) {
          await disposeBackup(backupPath, originalPath, config.queue.recycleBinPath);
          report.discardedBackups.push(backupPath);
          console.warn(`[Recovery] Replacement of "${originalPath}" had finished; cleared its leftover backup.`);
        } else {
          await rename(backupPath, originalPath);
          report.restored.push(originalPath);
          console.warn(`[Recovery] Restored "${originalPath}" from a backup left by an interrupted job.`);
        }
      } catch (err) {
        console.warn(`[Recovery] Could not recover "${backupPath}": ${(err as Error).message}`);
      }
    }

    for (const leftover of leftovers) {
      await cleanupTemp(leftover);
      if (!existsSync(leftover)) {
        report.removedTempFiles.push(leftover);
        console.warn(`[Recovery] Removed unfinished work file from a previous run: ${leftover}`);
      }
    }
  }

  const tempDirectory = config.queue.tempDirectory?.trim();
  if (tempDirectory && existsSync(tempDirectory)) {
    // Only the top level: buildTempOutputPath never writes into subfolders,
    // and this folder may be shared with other tools.
    let entries: string[] = [];
    try {
      entries = await readdir(tempDirectory);
    } catch (err) {
      console.warn(`[Recovery] Could not read temp directory "${tempDirectory}": ${(err as Error).message}`);
    }
    for (const name of entries) {
      if (!name.includes(`${tempSuffix}.`)) continue;
      const fullPath = join(tempDirectory, name);
      await cleanupTemp(fullPath);
      if (!existsSync(fullPath)) {
        report.removedTempFiles.push(fullPath);
        console.warn(`[Recovery] Removed unfinished encode from temp directory: ${fullPath}`);
      }
    }
  }

  return report;
}
