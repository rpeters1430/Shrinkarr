import fg from "fast-glob";
import { unlinkSync } from "node:fs";
import { createJellyfinClient } from "../integrations/jellyfin.js";
import { createEmbyClient } from "../integrations/emby.js";
import { createPlexClient } from "../integrations/plex.js";
import type { WorkerDeps } from "./worker.js";
import { processJob } from "./worker.js";

const IDLE_POLL_INTERVAL_MS = 1500;

async function cleanupOrphanedTempFiles(deps: WorkerDeps): Promise<void> {
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

export function isWithinSchedule(schedule?: { enabled: boolean; startHour: number; endHour: number }): boolean {
  if (!schedule || !schedule.enabled) return true;
  const currentHour = new Date().getHours();
  const { startHour, endHour } = schedule;

  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  // Overnight schedule spanning midnight (e.g. 23:00 to 07:00)
  return currentHour >= startHour || currentHour < endHour;
}

export async function checkMediaServerStreaming(deps: WorkerDeps): Promise<boolean> {
  const { config } = deps;
  if (!config.queue.pauseOnStreaming) return false;

  const checks: Promise<number>[] = [];

  if (config.integrations?.jellyfin?.url && config.integrations?.jellyfin?.apiKey) {
    const client = createJellyfinClient(config.integrations.jellyfin);
    if (client.getActiveStreamCount) checks.push(client.getActiveStreamCount());
  }
  if (config.integrations?.emby?.url && config.integrations?.emby?.apiKey) {
    const client = createEmbyClient(config.integrations.emby);
    if (client.getActiveStreamCount) checks.push(client.getActiveStreamCount());
  }
  if (config.integrations?.plex?.url && config.integrations?.plex?.token) {
    const client = createPlexClient(config.integrations.plex);
    if (client.getActiveStreamCount) checks.push(client.getActiveStreamCount());
  }

  if (checks.length === 0) return false;

  const results = await Promise.allSettled(checks);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value > 0) {
      return true;
    }
  }
  return false;
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
  let lastStreamingLogTime = 0;

  const resetCount = jobsRepo.resetStuckRunningJobs();
  if (resetCount > 0) {
    console.warn(`Reset ${resetCount} stuck "running" job(s) back to pending after restart.`);
  }

  void cleanupOrphanedTempFiles(deps);

  async function loop(): Promise<void> {
    while (!stopped) {
      if (globalPaused || activeCount >= concurrency) {
        await sleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      if (!isWithinSchedule(deps.config.queue.schedule)) {
        await sleep(IDLE_POLL_INTERVAL_MS * 4);
        continue;
      }

      if (deps.config.queue.pauseOnStreaming) {
        const isStreaming = await checkMediaServerStreaming(deps);
        if (isStreaming) {
          const now = Date.now();
          if (now - lastStreamingLogTime > 30000) {
            lastStreamingLogTime = now;
            console.log(`[Queue] Active media stream detected on media server (Jellyfin/Plex/Emby). Pausing transcode processing to prioritize playback...`);
          }
          await sleep(5000);
          continue;
        }
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
