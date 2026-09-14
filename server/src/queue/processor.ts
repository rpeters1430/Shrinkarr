import fg from "fast-glob";
import { unlinkSync } from "node:fs";
import type { Config } from "../config/schema.js";
import type { Job } from "../db/jobsRepo.js";
import { createJellyfinClient } from "../integrations/jellyfin.js";
import { createEmbyClient } from "../integrations/emby.js";
import { createPlexClient } from "../integrations/plex.js";
import type { WorkerDeps } from "./worker.js";
import { processJob } from "./worker.js";
import { flushPostJobHooks } from "./postJobHooks.js";

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

export interface ZonedScheduleTime {
  day: number;
  hour: number;
  minute: number;
}

export function getCurrentTimeInTimezone(timezone?: string, date = new Date()): ZonedScheduleTime {
  if (timezone && timezone !== "auto") {
    try {
      // Derive the weekday from numeric calendar parts. Some minimal container
      // ICU builds return localized or unexpected weekday labels, which made a
      // valid Monday window appear inactive even though the displayed time was right.
      const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
        timeZone: timezone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(date);
      const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value);
      const year = value("year");
      const month = value("month");
      const dayOfMonth = value("day");
      const rawHour = value("hour");
      const minute = value("minute");
      if ([year, month, dayOfMonth, rawHour, minute].every(Number.isFinite)) {
        const day = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
        return { day, hour: rawHour, minute };
      }
    } catch {
      // Invalid timezone string; use the host clock.
    }
  }
  return { day: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
}

export function getCurrentHourInTimezone(timezone?: string, date = new Date()): number {
  return getCurrentTimeInTimezone(timezone, date).hour;
}

type ScheduleWindow = { day: number; enabled: boolean; start: string; end: string };
type QueueSchedule = {
  enabled: boolean;
  startHour?: number;
  endHour?: number;
  windows?: ScheduleWindow[];
  timezone?: string;
};

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isWithinSchedule(
  schedule?: QueueSchedule,
  currentHourOverride?: number,
  currentDayOverride?: number,
  currentMinuteOverride?: number,
): boolean {
  if (!schedule || !schedule.enabled) return true;

  const current = getCurrentTimeInTimezone(schedule.timezone);
  const day = currentDayOverride ?? current.day;
  const minuteOfDay =
    (currentHourOverride ?? current.hour) * 60 + (currentMinuteOverride ?? (currentHourOverride === undefined ? current.minute : 0));

  if (schedule.windows?.length) {
    const today = schedule.windows.find((window) => window.day === day && window.enabled);
    if (today) {
      const start = timeToMinutes(today.start);
      const end = timeToMinutes(today.end);
      if (start === end) return true;
      if (start < end && minuteOfDay >= start && minuteOfDay < end) return true;
      if (start > end && minuteOfDay >= start) return true;
    }

    // An overnight window belongs to the day on which it starts.
    const previousDay = (day + 6) % 7;
    const previous = schedule.windows.find((window) => window.day === previousDay && window.enabled);
    if (previous) {
      const start = timeToMinutes(previous.start);
      const end = timeToMinutes(previous.end);
      if (start > end && minuteOfDay < end) return true;
    }
    return false;
  }

  const startHour = schedule.startHour ?? 1;
  const endHour = schedule.endHour ?? 7;
  const currentHour = currentHourOverride ?? current.hour;
  if (startHour === endHour) return true;
  return startHour < endHour
    ? currentHour >= startHour && currentHour < endHour
    : currentHour >= startHour || currentHour < endHour;
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
  drain: (timeoutMs?: number) => Promise<void>;
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
      void flushPostJobHooks();
      if (activeProcessor === handle) {
        activeProcessor = undefined;
      }
    },
    drain: async (timeoutMs = 10_000): Promise<void> => {
      stopped = true;
      wake();
      if (activeRunners.size === 0) {
        await flushPostJobHooks();
        if (activeProcessor === handle) {
          activeProcessor = undefined;
        }
        return;
      }

      console.log(`[Queue] Draining processor: waiting up to ${timeoutMs / 1000}s for ${activeRunners.size} active runner(s) to complete...`);

      const startTime = Date.now();
      while (activeRunners.size > 0 && Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (activeRunners.size > 0) {
        console.log(`[Queue] Drain timeout reached with ${activeRunners.size} runner(s) still active; aborting and rescheduling.`);
        for (const [, runner] of activeRunners) {
          runner.abortController.abort("reschedule");
        }
        activeRunners.clear();
      }

      await flushPostJobHooks();
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
