import fg from "fast-glob";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { BACKUP_SUFFIX } from "./atomicReplace.js";
import type { WorkerDeps } from "./worker.js";
import { processJob } from "./worker.js";

const IDLE_POLL_INTERVAL_MS = 1500;

export async function cleanupOrphanedTempFiles(deps: WorkerDeps): Promise<void> {
  const { config } = deps;
  for (const library of config.libraries) {
    if (!library.path) continue;
    const normalized = library.path.replace(/\\/g, "/");
    const pattern = `**/*${config.queue.tempSuffix}.*`;
    try {
      const orphans = await fg(pattern, { cwd: normalized, absolute: true, onlyFiles: true });
      for (const orphan of orphans) {
        try {
          unlinkSync(orphan);
          console.warn(`Removed orphaned temp file from a previous run: ${orphan}`);
        } catch {
          // best-effort cleanup only
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * replaceOriginal() moves the original to a ".shrinkarr.bak" file and then moves the
 * transcoded temp file into the original's place as two separate renames. If the process
 * is killed between those two steps (OOM, SIGKILL, container restart, power loss), the
 * original file is left missing on disk with only the backup remaining. Run this before
 * the queue starts processing jobs so a job never gets requeued against a source file that
 * an interrupted replace has effectively deleted.
 */
export async function restoreOrphanedBackups(deps: WorkerDeps): Promise<void> {
  const { config } = deps;
  for (const library of config.libraries) {
    if (!library.path) continue;
    const normalized = library.path.replace(/\\/g, "/");
    const pattern = `**/*${BACKUP_SUFFIX}`;
    try {
      const backups = await fg(pattern, { cwd: normalized, absolute: true, onlyFiles: true });
      for (const backup of backups) {
        const originalPath = backup.slice(0, -BACKUP_SUFFIX.length);
        try {
          if (existsSync(originalPath)) {
            // The replace fully completed before the crash; this backup is stale.
            unlinkSync(backup);
            console.warn(`Removed stale backup file from a previous run (replace already completed): ${backup}`);
          } else {
            renameSync(backup, originalPath);
            console.warn(
              `Restored "${originalPath}" from its backup after an interrupted replace in a previous run.`,
            );
          }
        } catch (err) {
          console.error(`Failed to reconcile orphaned backup "${backup}": ${(err as Error).message}`);
        }
      }
    } catch {
      // ignore
    }
  }
}

export interface ProcessorHandle {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
}

let globalPaused = false;

export function isQueuePaused(): boolean {
  return globalPaused;
}

export function setQueuePaused(paused: boolean): void {
  globalPaused = paused;
}

export function startProcessor(deps: WorkerDeps, concurrency: number): ProcessorHandle {
  const { jobsRepo } = deps;
  let stopped = false;
  let activeCount = 0;

  const resetCount = jobsRepo.resetStuckRunningJobs();
  if (resetCount > 0) {
    console.warn(`Reset ${resetCount} stuck "running" job(s) back to pending after restart.`);
  }

  async function loop(): Promise<void> {
    // Reconcile any interrupted replace before picking up jobs, so a requeued job never
    // runs against a source file an earlier crash left missing.
    await restoreOrphanedBackups(deps);
    await cleanupOrphanedTempFiles(deps);

    while (!stopped) {
      if (globalPaused || activeCount >= concurrency) {
        await sleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      const job = jobsRepo.getNextPendingJob();
      if (!job) {
        await sleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      activeCount += 1;
      processJob(job, deps)
        .catch((err) => {
          console.error(`Unexpected error processing job ${job.id}:`, err);
        })
        .finally(() => {
          activeCount -= 1;
        });
    }
  }

  void loop();

  return {
    stop: () => {
      stopped = true;
    },
    pause: () => {
      globalPaused = true;
    },
    resume: () => {
      globalPaused = false;
    },
    isPaused: () => globalPaused,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
