import { watch } from "node:fs";
import { join } from "node:path";
import type { Config, Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { checkFileLockOrBusyAsync } from "../utils/fileLock.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resolveFileDecision, resolveIndexedFileDecision } from "./rules.js";
import { buildFileRecord, pruneLibrary, ScanWriter } from "./scan.js";
import { tryAcquireScanLock } from "./scanLock.js";
import { isSelfWritePath } from "./selfWrites.js";
import { hasMediaExtension, walkLibraryEntries, type WalkedFile } from "./walk.js";

export interface WatcherStatus {
  enabled: boolean;
  isScanning: boolean;
  intervalMinutes: number;
  autoOptimize: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  newFilesFoundLastRun: number;
  autoOptimizedLastRun: number;
  totalNewFilesDiscovered: number;
  totalAutoOptimized: number;
  // Libraries with a live filesystem watch. The rest rely on the interval sweep.
  eventWatchedLibraries: number;
}

interface FsWatchHandle {
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FsWatchHandle;

// Events for these never mean a new media file is ready: our own temp and
// backup files, partial downloads, and sidecar files. A finished download is
// renamed to its media extension, which fires its own event.
const IGNORED_EVENT_PATH = /\.shrinkarr|\.sim-|@eaDir|\.(part|crdownload|ytdl|!ut|incomplete|downloading|tmp|bak|nfo|jpe?g|png|srt|ass|sub|idx|txt|xml|db)$/i;

// A file that stays locked would otherwise re-walk the library every few
// seconds. After this many follow-ups the interval sweep takes over.
const MAX_EVENT_RETRIES = 20;

export function isIgnoredEventPath(filename: string): boolean {
  return IGNORED_EVENT_PATH.test(filename);
}

// New files and folders arrive as "rename" events. A "change" only matters
// on a media file being written. Windows also reports "change" on a folder
// when a file inside it is opened, which our own probe does, and following
// those would re-walk the library after every check.
export function isIgnoredEventType(eventType: string, filename: string): boolean {
  if (isIgnoredEventPath(filename)) return true;
  return eventType === "change" && !hasMediaExtension(filename);
}

import {
  startWatcherScanProgress,
  completeWatcherScanProgress,
  startWatcherLibraryProgress,
  setScanTotal,
  updateDiscoveryCount,
  updateScanStep,
} from "./tracker.js";

export function needsSettleObservation(
  mtimeMs: number,
  nowMs: number,
  settleDelaySeconds: number,
): boolean {
  return nowMs - mtimeMs < settleDelaySeconds * 1000;
}

export class LibraryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  // Bumped on every start/stop so a sweep that outlives a restart can tell
  // its schedule is no longer the current one.
  private generation = 0;
  private isScanning = false;
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private newFilesFoundLastRun = 0;
  private autoOptimizedLastRun = 0;
  private totalNewFilesDiscovered = 0;
  private totalAutoOptimized = 0;

  // Track file sizes over time to ensure they have stopped writing before probing
  private pendingFileSizes = new Map<string, { size: number; checkedAt: number }>();
  // Track files that failed probing so we do not re-probe them every sweep unless modified
  private failedProbes = new Map<string, { sizeBytes: number; mtimeMs: number }>();

  private fsWatchers = new Map<string, FsWatchHandle>();
  private eventTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly getContext: () => { config: Config; filesRepo: FilesRepo; jobsRepo: JobsRepo },
    private readonly watchFn: WatchFn = watch,
  ) {}

  start(): void {
    const { config } = this.getContext();
    if (!config.watcher?.enabled) {
      return;
    }

    this.stop();
    const generation = this.generation;
    const intervalMs = Math.max(1, config.watcher.intervalMinutes || 15) * 60 * 1000;
    this.scheduleNext(intervalMs, generation);
    if (config.watcher.events) {
      this.startEventWatching(config, generation);
    }

    // Initial check after 10 seconds of startup
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.checkAllLibraries();
    }, 10_000);
  }

  stop(): void {
    // A sweep already in progress finishes, but must not schedule another.
    this.generation++;
    this.nextRunAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    for (const handle of this.fsWatchers.values()) handle.close();
    this.fsWatchers.clear();
    for (const timer of this.eventTimers.values()) clearTimeout(timer);
    this.eventTimers.clear();
  }

  // fs.watch can fail to start (unsupported filesystem, inotify watch limit)
  // or never fire (most SMB/NFS mounts). Either way the interval sweep still
  // runs, so a library without a watch is only slower to notice new files.
  private startEventWatching(config: Config, generation: number): void {
    for (const library of config.libraries) {
      try {
        const handle = this.watchFn(library.path, { recursive: true }, (eventType, filename) => {
          if (filename && isIgnoredEventType(eventType, filename.toString())) return;
          // A job's own reads and its final rename would otherwise re-walk
          // the whole library, which over SMB means listing every folder.
          if (filename && isSelfWritePath(join(library.path, filename.toString()))) return;
          this.queueLibraryCheck(library.id, generation);
        });
        handle.on("error", (err) => {
          console.warn(`[Watcher] Live watch for "${library.name}" stopped, using interval sweeps only: ${err.message}`);
          handle.close();
          if (this.fsWatchers.get(library.id) === handle) this.fsWatchers.delete(library.id);
        });
        this.fsWatchers.set(library.id, handle);
      } catch (err) {
        console.warn(`[Watcher] Could not watch "${library.name}" for changes, using interval sweeps only: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Schedules a check of one library, as a filesystem event would. For
   * sources outside the filesystem, such as Sonarr/Radarr import webhooks.
   */
  requestLibraryCheck(libraryId: string): void {
    this.queueLibraryCheck(libraryId, this.generation);
  }

  // Waits until the library has been quiet for longer than the settle delay,
  // so a finished download is old enough to probe on the first pass instead
  // of waiting for a second observation.
  private queueLibraryCheck(libraryId: string, generation: number, retry = 0): void {
    const { config } = this.getContext();
    const quietMs = (config.watcher?.settleDelaySeconds ?? 15) * 1000 + 1000;
    const existing = this.eventTimers.get(libraryId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.eventTimers.delete(libraryId);
      if (generation !== this.generation) return;
      void this.checkLibraries([libraryId]).then((result) => {
        if (generation !== this.generation) return;
        // Busy: a scan or sweep holds the lock and may have walked before this
        // file arrived. Deferred: files still settling or locked. Both need
        // another look sooner than the next interval.
        if ((result.busy || result.deferred > 0) && retry < MAX_EVENT_RETRIES) {
          this.queueLibraryCheck(libraryId, generation, retry + 1);
        }
      });
    }, quietMs);
    this.eventTimers.set(libraryId, timer);
  }

  private scheduleNext(intervalMs: number, generation: number): void {
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setTimeout(() => {
      void this.checkAllLibraries().finally(() => {
        if (generation !== this.generation) return;
        const { config } = this.getContext();
        const nextMs = Math.max(1, config.watcher?.intervalMinutes || 15) * 60 * 1000;
        this.scheduleNext(nextMs, generation);
      });
    }, intervalMs);
  }

  getStatus(): WatcherStatus {
    const { config } = this.getContext();
    return {
      enabled: Boolean(config.watcher?.enabled),
      isScanning: this.isScanning,
      intervalMinutes: config.watcher?.intervalMinutes ?? 15,
      autoOptimize: Boolean(config.watcher?.autoOptimize),
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      newFilesFoundLastRun: this.newFilesFoundLastRun,
      autoOptimizedLastRun: this.autoOptimizedLastRun,
      totalNewFilesDiscovered: this.totalNewFilesDiscovered,
      totalAutoOptimized: this.totalAutoOptimized,
      eventWatchedLibraries: this.fsWatchers.size,
    };
  }

  async checkAllLibraries(
    options: { forceScan?: boolean } = {},
  ): Promise<{ newFiles: number; autoQueued: number; busy?: boolean }> {
    const { newFiles, autoQueued, busy } = await this.checkLibraries(undefined, options);
    return busy ? { newFiles, autoQueued, busy } : { newFiles, autoQueued };
  }

  /** Sweeps the given libraries, or all of them when no ids are passed. */
  async checkLibraries(
    libraryIds?: string[],
    options: { forceScan?: boolean } = {},
  ): Promise<{ newFiles: number; autoQueued: number; deferred: number; busy?: boolean }> {
    if (this.isScanning) {
      return { newFiles: 0, autoQueued: 0, deferred: 0, busy: true };
    }
    // A full scan already covers everything a sweep would find, so skip this
    // round rather than wait for it.
    const releaseLock = tryAcquireScanLock();
    if (!releaseLock) {
      return { newFiles: 0, autoQueued: 0, deferred: 0, busy: true };
    }

    const { config, filesRepo, jobsRepo } = this.getContext();
    const libraries = libraryIds
      ? config.libraries.filter((l) => libraryIds.includes(l.id))
      : config.libraries;
    this.isScanning = true;
    this.newFilesFoundLastRun = 0;
    this.autoOptimizedLastRun = 0;
    this.lastRunAt = new Date().toISOString();

    startWatcherScanProgress(libraries.length);
    const seenPaths = new Set<string>();
    let deferred = 0;

    try {
      for (const [index, library] of libraries.entries()) {
        const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
        if (!preset) continue;

        startWatcherLibraryProgress(library.name, index + 1, libraries.length);
        try {
          deferred += await this.scanLibraryIncremental(library, preset, filesRepo, jobsRepo, config, seenPaths, options);
        } catch (err) {
          // A missing/unreadable library must not prevent the remaining
          // configured libraries from being checked.
          console.warn(`[Watcher] Failed to scan library "${library.name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`[Watcher] Error during library check: ${(err as Error).message}`);
    } finally {
      // Forget files that vanished mid-settle so these maps can't grow
      // forever. Only a sweep of every library has seen every live path.
      if (!libraryIds) {
        for (const path of this.pendingFileSizes.keys()) {
          if (!seenPaths.has(path)) this.pendingFileSizes.delete(path);
        }
        for (const path of this.failedProbes.keys()) {
          if (!seenPaths.has(path)) this.failedProbes.delete(path);
        }
      }
      this.isScanning = false;
      completeWatcherScanProgress(this.newFilesFoundLastRun, this.autoOptimizedLastRun);
      releaseLock();
    }

    return {
      newFiles: this.newFilesFoundLastRun,
      autoQueued: this.autoOptimizedLastRun,
      deferred,
    };
  }

  private async scanLibraryIncremental(
    library: Library,
    preset: Preset,
    filesRepo: FilesRepo,
    jobsRepo: JobsRepo,
    config: Config,
    seenPaths: Set<string>,
    options: { forceScan?: boolean } = {},
  ): Promise<number> {
    const diskFiles = await walkLibraryEntries(
      library.path,
      preset.mediaKind === "audio" ? "audio" : "video",
      updateDiscoveryCount,
      library.excludePatterns,
    );
    const diskPaths = new Set<string>();
    for (const file of diskFiles) {
      diskPaths.add(file.path);
      seenPaths.add(file.path);
    }
    const existing = filesRepo.getFileMetadataMap(library.id);
    // Remove any deleted files that are no longer on disk
    pruneLibrary(filesRepo, library, diskPaths, existing.keys());

    const shouldAutoOptimize = Boolean(library.autoOptimize || config.watcher?.autoOptimize);
    const settleDelaySeconds = config.watcher?.settleDelaySeconds ?? 15;
    const now = Date.now();
    // Files still settling or held by another process, counted so an
    // event-triggered check knows to look again.
    let deferred = 0;

    const toProbe: WalkedFile[] = [];
    const toReevaluate: Array<{ path: string; sizeBytes: number; record: NonNullable<ReturnType<FilesRepo["getFileByPath"]>> }> = [];
    for (const file of diskFiles) {
      const known = existing.get(file.path);
      // Catches in-place replacements such as Sonarr/Radarr upgrades. Rows
      // with mtime 0 predate mtime tracking, so only a size change counts.
      const isChanged = known !== undefined
        && (known.sizeBytes !== file.sizeBytes || (known.mtimeMs > 0 && known.mtimeMs !== file.mtimeMs));
      const isNew = known === undefined;
      if (!isNew && !isChanged && !options.forceScan) {
        if (!known?.policyMetadata) {
          // Legacy rows need one fresh probe even if size and mtime match.
        } else if ((library.rules?.length ?? 0) > 0) {
          const record = filesRepo.getFileByPath(file.path);
          if (record) toReevaluate.push({ path: file.path, sizeBytes: file.sizeBytes, record });
          else toProbe.push(file);
          continue;
        } else {
          continue;
        }
      }

      // Skip files that previously failed probing unless their size/mtime changed or forceScan
      const failed = this.failedProbes.get(file.path);
      if (failed && failed.sizeBytes === file.sizeBytes && failed.mtimeMs === file.mtimeMs && !options.forceScan) {
        continue;
      }

      // Check settle delay to make sure file is not being written to right now
      const prev = this.pendingFileSizes.get(file.path);
      if (prev) {
        if (prev.size !== file.sizeBytes) {
          // Still growing, update and skip this pass
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          deferred++;
          continue;
        }
        if (now - prev.checkedAt < settleDelaySeconds * 1000) {
          // Not enough settle time has passed yet
          deferred++;
          continue;
        }
      } else if (isNew || isChanged) {
        // Files already older than the settle window are established library
        // content, not active downloads. Probe them immediately on the first
        // watcher pass. Only recently modified files need a second observation.
        if (needsSettleObservation(file.mtimeMs, now, settleDelaySeconds)) {
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          deferred++;
          continue;
        }
      }

      toProbe.push(file);
    }
    existing.clear();

    setScanTotal(toProbe.length + toReevaluate.length);
    const writer = new ScanWriter(filesRepo, jobsRepo);
    let done = 0;
    for (const item of toReevaluate) {
      const resolved = resolveIndexedFileDecision(item.record, library, config.presets);
      if (resolved.status === "ready") {
        const decision = resolved.decision!;
        filesRepo.updateRecommendation(item.path, {
          needsTranscode: decision.shouldTranscode,
          recommendedAction: decision.recommendedAction,
          estimatedSavingsBytes: decision.estimatedSavingsBytes,
          reason: decision.shouldTranscode && decision.recommendedAction !== "Remux" ? null : resolved.reason,
        });
        if (shouldAutoOptimize && decision.shouldTranscode && resolved.presetId) {
          writer.addJob(item.path, resolved.presetId, item.sizeBytes);
        }
        updateScanStep(++done, item.path.split(/[/\\]/).pop() || item.path, decision.shouldTranscode, decision.estimatedSavingsBytes);
      }
    }
    await runWithConcurrency(toProbe, config.scanner?.probeConcurrency ?? 4, async (file) => {
      const fileName = file.path.split(/[/\\]/).pop() || file.path;
      if ((await checkFileLockOrBusyAsync(file.path)).locked) {
        // Still being written or held by another process; look again next sweep.
        this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: Date.now() });
        deferred++;
        updateScanStep(++done, fileName, false, 0);
        return;
      }
      this.pendingFileSizes.delete(file.path);
      try {
        const probe = await probeFile(file.path);
        this.failedProbes.delete(file.path);
        const resolved = resolveFileDecision(file.path, probe, library, config.presets);
        const decision = resolved.decision!;
        const fileRecord = buildFileRecord(file, library, probe, decision);
        writer.addFile(fileRecord);

        this.newFilesFoundLastRun += 1;
        this.totalNewFilesDiscovered += 1;

        if (shouldAutoOptimize && decision.shouldTranscode && resolved.presetId) {
          writer.addJob(file.path, resolved.presetId, fileRecord.sizeBytes);
        }
        updateScanStep(++done, fileName, decision.shouldTranscode, decision.estimatedSavingsBytes);
      } catch (err) {
        this.failedProbes.set(file.path, { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs });
        console.warn(`[Watcher] Failed to probe new file "${file.path}": ${(err as Error).message}`);
        updateScanStep(++done, fileName, false, 0);
      }
    });
    writer.flush();

    if (writer.queuedCount > 0) {
      this.autoOptimizedLastRun += writer.queuedCount;
      this.totalAutoOptimized += writer.queuedCount;
      console.log(`[Watcher] Auto-queued ${writer.queuedCount} file(s) from "${library.name}" for optimization.`);
    }
    return deferred;
  }
}
