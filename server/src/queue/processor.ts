import fg from "fast-glob";
import { unlinkSync } from "node:fs";
import type { Config } from "../config/schema.js";
import type { Job } from "../db/jobsRepo.js";
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

export function getCurrentHourInTimezone(timezone?: string, date = new Date()): number {
  if (timezone && timezone !== "auto") {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      const hourPart = parts.find((p) => p.type === "hour");
      if (hourPart) {
        const val = parseInt(hourPart.value, 10);
        return val === 24 ? 0 : val;
      }
    } catch {
      // Invalid timezone string, fallback to system local hour
    }
  }
  return date.getHours();
}

export function isWithinSchedule(
  schedule?: { enabled: boolean; startHour: number; endHour: number; timezone?: string },
  currentHourOverride?: number,
): boolean {
  if (!schedule || !schedule.enabled) return true;
  const currentHour = currentHourOverride ?? getCurrentHourInTimezone(schedule.timezone);
  const { startHour, endHour } = schedule;

  if (startHour === endHour) {
    return true;
  }

  if (startHour < endHour) {
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
  setConcurrency: (concurrency: number) => void;
  getConcurrency: () => number;
  getActiveCount: () => number;
  cancelJob: (jobId: string) => boolean;
  updateConfig: (config: Config) => void;
}

let globalPaused = false;
let activeProcessor: ProcessorHandle | undefined;

export function isQueuePaused(): boolean {
  return globalPaused;
}

export function setQueuePaused(paused: boolean): void {
  globalPaused = paused;
  if (activeProcessor) {
    if (paused) {
      activeProcessor.pause();
    } else {
      activeProcessor.resume();
    }
  }
}

export function getActiveProcessor(): ProcessorHandle | undefined {
  return activeProcessor;
}

export function startProcessor(deps: WorkerDeps, initialConcurrency?: number): ProcessorHandle {
  const { jobsRepo } = deps;
  let currentConcurrency = Math.max(1, initialConcurrency ?? deps.config.queue.concurrency ?? 1);
  let stopped = false;
  let lastStreamingLogTime = 0;
  const activeRunners = new Map<string, { job: Job; abortController: AbortController; startTime: number }>();
  let wakeResolve: (() => void) | null = null;

  function wake(): void {
    if (wakeResolve) {
      const r = wakeResolve;
      wakeResolve = null;
      r();
    }
  }

  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const onWake = () => {
        if (timer) clearTimeout(timer);
        wakeResolve = null;
        resolve();
      };
      wakeResolve = onWake;
      timer = setTimeout(() => {
        wakeResolve = null;
        resolve();
      }, ms);
    });
  }

  const resetCount = jobsRepo.resetStuckRunningJobs();
  if (resetCount > 0) {
    console.warn(`Reset ${resetCount} stuck "running" job(s) back to pending after restart.`);
  }

  void cleanupOrphanedTempFiles(deps);

  async function loop(): Promise<void> {
    while (!stopped) {
      if (globalPaused) {
        if (activeRunners.size > 0) {
          console.log(`[Queue] Queue is paused: aborting and rescheduling ${activeRunners.size} active runner(s).`);
          for (const [, runner] of activeRunners) {
            runner.abortController.abort("reschedule");
          }
        }
        await interruptibleSleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      if (!isWithinSchedule(deps.config.queue.schedule)) {
        const stopActive = deps.config.queue.schedule?.stopActiveOnExit ?? true;
        if (stopActive && activeRunners.size > 0) {
          const tz = deps.config.queue.schedule?.timezone;
          const currentHour = getCurrentHourInTimezone(tz);
          console.log(
            `[Queue] Outside transcode schedule window (${currentHour}:00${tz && tz !== "auto" ? ` ${tz}` : ""}). Aborting and rescheduling ${activeRunners.size} active runner(s) to protect system resources.`
          );
          for (const [, runner] of activeRunners) {
            runner.abortController.abort("reschedule");
          }
        }
        await interruptibleSleep(IDLE_POLL_INTERVAL_MS * 4);
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
          if (activeRunners.size > 0) {
            console.log(`[Queue] Aborting and rescheduling ${activeRunners.size} active runner(s) to prioritize playback stream.`);
            for (const [, runner] of activeRunners) {
              runner.abortController.abort("reschedule");
            }
          }
          await interruptibleSleep(5000);
          continue;
        }
      }

      if (activeRunners.size >= currentConcurrency) {
        await interruptibleSleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      const availableSlots = currentConcurrency - activeRunners.size;
      if (availableSlots <= 0) {
        await interruptibleSleep(IDLE_POLL_INTERVAL_MS);
        continue;
      }

      let launchedCount = 0;
      for (let i = 0; i < availableSlots; i++) {
        if (stopped || globalPaused || activeRunners.size >= currentConcurrency) break;

        const job = jobsRepo.getNextPendingJob();
        if (!job) break;

        if (activeRunners.has(job.id)) break;

        const abortController = new AbortController();
        activeRunners.set(job.id, {
          job,
          abortController,
          startTime: Date.now(),
        });
        launchedCount++;

        console.log(`[Queue] Started transcode runner [${activeRunners.size}/${currentConcurrency}] for "${job.filePath.split(/[/\\]/).pop()}" (Job ID: ${job.id})`);

        processJob(job, deps, abortController.signal)
          .catch((err) => {
            console.error(`Unexpected error processing job ${job.id}:`, err);
          })
          .finally(() => {
            activeRunners.delete(job.id);
            wake();
          });
      }

      if (launchedCount === 0) {
        await interruptibleSleep(IDLE_POLL_INTERVAL_MS);
      }
    }
  }

  void loop();

  const handle: ProcessorHandle = {
    stop: () => {
      stopped = true;
      wake();
      for (const [, runner] of activeRunners) {
        runner.abortController.abort("reschedule");
      }
      activeRunners.clear();
      if (activeProcessor === handle) {
        activeProcessor = undefined;
      }
    },
    pause: () => {
      globalPaused = true;
      if (activeRunners.size > 0) {
        console.log(`[Queue] Pausing queue: aborting and rescheduling ${activeRunners.size} active runner(s).`);
        for (const [, runner] of activeRunners) {
          runner.abortController.abort("reschedule");
        }
      }
      wake();
    },
    resume: () => {
      globalPaused = false;
      wake();
    },
    isPaused: () => globalPaused,
    setConcurrency: (newConcurrency: number) => {
      const prev = currentConcurrency;
      const target = Math.max(1, newConcurrency);
      currentConcurrency = target;
      deps.config.queue.concurrency = target;
      console.log(`[Queue] Concurrency setting updated: ${prev} -> ${target} runner(s)`);

      // If concurrency was reduced below activeRunners.size, remove excess running processes
      if (activeRunners.size > target) {
        const excessCount = activeRunners.size - target;
        // Sort active runners newest first (most recently started)
        const sortedRunners = Array.from(activeRunners.entries())
          .sort((a, b) => b[1].startTime - a[1].startTime);

        for (let i = 0; i < excessCount; i++) {
          const [jobId, runner] = sortedRunners[i];
          console.log(`[Queue] Removing excess runner for job ${jobId} ("${runner.job.filePath.split(/[/\\]/).pop()}") to match new concurrency limit of ${target}; returning job to pending.`);
          runner.abortController.abort("reschedule");
        }
      }

      // If concurrency was increased or slots opened, wake loop immediately to launch new runner(s)
      wake();
    },
    getConcurrency: () => currentConcurrency,
    getActiveCount: () => activeRunners.size,
    cancelJob: (jobId: string) => {
      const runner = activeRunners.get(jobId);
      if (runner) {
        console.log(`[Queue] Cancelling active runner for job ${jobId} ("${runner.job.filePath.split(/[/\\]/).pop()}").`);
        runner.abortController.abort("cancelled");
        return true;
      }
      return false;
    },
    updateConfig: (newConfig: Config) => {
      deps.config = newConfig;
      if (typeof newConfig.queue?.concurrency === "number") {
        handle.setConcurrency(newConfig.queue.concurrency);
      }
      if (!isWithinSchedule(newConfig.queue?.schedule)) {
        const stopActive = newConfig.queue?.schedule?.stopActiveOnExit ?? true;
        if (stopActive && activeRunners.size > 0) {
          console.log(`[Queue] Config updated: now outside schedule window; aborting and rescheduling ${activeRunners.size} active runner(s).`);
          for (const [, runner] of activeRunners) {
            runner.abortController.abort("reschedule");
          }
        }
      }
      wake();
    },
  };

  activeProcessor = handle;
  return handle;
}
