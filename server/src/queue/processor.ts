import fg from "fast-glob";
import { unlinkSync } from "node:fs";
import type { WorkerDeps } from "./worker.js";
import { processJob } from "./worker.js";

const IDLE_POLL_INTERVAL_MS = 2000;

async function cleanupOrphanedTempFiles(deps: WorkerDeps): Promise<void> {
  const { config } = deps;
  for (const library of config.libraries) {
    const pattern = `**/*${config.queue.tempSuffix}.*`;
    const orphans = await fg(pattern, { cwd: library.path, absolute: true, onlyFiles: true });
    for (const orphan of orphans) {
      try {
        unlinkSync(orphan);
        console.warn(`Removed orphaned temp file from a previous run: ${orphan}`);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

export interface ProcessorHandle {
  stop: () => void;
}

export function startProcessor(deps: WorkerDeps, concurrency: number): ProcessorHandle {
  const { jobsRepo } = deps;
  let stopped = false;
  let activeCount = 0;

  const resetCount = jobsRepo.resetStuckRunningJobs();
  if (resetCount > 0) {
    console.warn(`Reset ${resetCount} stuck "running" job(s) back to pending after restart.`);
  }

  void cleanupOrphanedTempFiles(deps);

  async function loop(): Promise<void> {
    while (!stopped) {
      if (activeCount >= concurrency) {
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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
