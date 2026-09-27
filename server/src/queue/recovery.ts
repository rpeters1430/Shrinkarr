import fg from "fast-glob";
import { existsSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { cleanupTemp, disposeBackup, readReplaceMarker, replaceMarkerPath } from "./atomicReplace.js";

const BACKUP_SUFFIX = ".shrinkarr.bak";
const STAGING_MARKER = ".shrinkarr.staging.";

export interface RecoveryReport {
  restored: string[];
  discardedBackups: string[];
  keptBackups: string[];
  removedTempFiles: string[];
}

function toGlobCwd(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Repairs what a crash in the middle of replaceOriginal can leave behind:
 * - "<file>.shrinkarr.bak" with nothing at <file>: the original was moved
 *   aside but the new encode never landed, so the original is put back.
 * - "<file>.shrinkarr.bak" whose marker says the new file was installed: only
 *   the backup cleanup was missed, so it goes to the recycle bin (or is
 *   deleted), exactly as a normal job would have done.
 * - "<file>.shrinkarr.bak" with something at <file> but no such marker: both
 *   are kept and a warning is logged.
 * - "*.shrinkarr.staging.*": partial cross-volume copies, always deleted.
 * - "*<tempSuffix>.*": unfinished encodes in library folders and in
 *   queue.tempDirectory, always deleted.
 *
 * Must run before the queue starts any job, since those files are only
 * orphans while nothing is transcoding.
 */
export async function recoverInterruptedWork(config: Config): Promise<RecoveryReport> {
  const report: RecoveryReport = { restored: [], discardedBackups: [], keptBackups: [], removedTempFiles: [] };
  const tempSuffix = config.queue.tempSuffix;
  const tempPattern = `**/*${fg.escapePath(tempSuffix)}.*`;

  for (const library of config.libraries) {
    if (!library.path || !existsSync(library.path)) continue;
    let found: string[];
    try {
      found = await fg([`**/*${BACKUP_SUFFIX}`, `**/*${BACKUP_SUFFIX}.txn*`, `**/*${STAGING_MARKER}*`, tempPattern], {
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
    const markers = found.filter((p) => p.includes(`${BACKUP_SUFFIX}.txn`));
    const leftovers = found.filter((p) => !p.endsWith(BACKUP_SUFFIX) && !p.includes(`${BACKUP_SUFFIX}.txn`));

    for (const backupPath of backups) {
      const originalPath = backupPath.slice(0, -BACKUP_SUFFIX.length);
      try {
        // The marker written by replaceOriginal is the only evidence trusted
        // that the new file was installed; file names and mtimes are not.
        const marker = await readReplaceMarker(backupPath);
        if (marker?.phase === "installed") {
          await disposeBackup(backupPath, originalPath, config.queue.recycleBinPath);
          report.discardedBackups.push(backupPath);
          console.warn(`[Recovery] Replacement of "${originalPath}" had finished; cleared its leftover backup.`);
        } else if (!existsSync(originalPath)) {
          await rename(backupPath, originalPath);
          report.restored.push(originalPath);
          console.warn(`[Recovery] Restored "${originalPath}" from a backup left by an interrupted job.`);
        } else {
          // Something is at the original path but nothing says it is our
          // encode. Keep both rather than guess.
          report.keptBackups.push(backupPath);
          console.warn(`[Recovery] Kept "${backupPath}": "${originalPath}" exists but the replacement was not confirmed. Check both files and delete one.`);
          continue;
        }
        await cleanupTemp(replaceMarkerPath(backupPath));
      } catch (err) {
        console.warn(`[Recovery] Could not recover "${backupPath}": ${(err as Error).message}`);
      }
    }

    // Markers whose backup is gone (the job finished or was just recovered).
    for (const marker of markers) {
      const backupPath = marker.replace(/\.txn(\.tmp)?$/, "");
      if (!existsSync(backupPath) || marker.endsWith(".tmp")) await cleanupTemp(marker);
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
