import type { Config, Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { checkFileLockOrBusyAsync } from "../utils/fileLock.js";
import { runWithConcurrency } from "../utils/pool.js";
import { decide } from "./policy.js";
import { buildFileRecord, pruneLibrary, ScanWriter } from "./scan.js";
import { tryAcquireScanLock } from "./scanLock.js";
import { walkLibraryEntries, type WalkedFile } from "./walk.js";

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
  private isScanning = false;
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private newFilesFoundLastRun = 0;
  private autoOptimizedLastRun = 0;
  private totalNewFilesDiscovered = 0;
  private totalAutoOptimized = 0;

  // Track file sizes over time to ensure they have stopped writing before probing
  private pendingFileSizes = new Map<string, { size: number; checkedAt: number }>();

  constructor(
    private readonly getContext: () => { config: Config; filesRepo: FilesRepo; jobsRepo: JobsRepo },
  ) {}

  start(): void {
    const { config } = this.getContext();
    if (!config.watcher?.enabled) {
      return;
    }

    this.stop();
    const intervalMs = Math.max(1, config.watcher.intervalMinutes || 15) * 60 * 1000;
    this.scheduleNext(intervalMs);

    // Initial check after 10 seconds of startup
    setTimeout(() => {
      void this.checkAllLibraries();
    }, 10_000);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(intervalMs: number): void {
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setTimeout(() => {
      void this.checkAllLibraries().finally(() => {
        const { config } = this.getContext();
        const nextMs = Math.max(1, config.watcher?.intervalMinutes || 15) * 60 * 1000;
        this.scheduleNext(nextMs);
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
    };
  }

  async checkAllLibraries(
    options: { forceScan?: boolean } = {},
  ): Promise<{ newFiles: number; autoQueued: number; busy?: boolean }> {
    if (this.isScanning) {
      return { newFiles: 0, autoQueued: 0, busy: true };
    }
    // A full scan already covers everything a sweep would find, so skip this
    // round rather than wait for it.
    const releaseLock = tryAcquireScanLock();
    if (!releaseLock) {
      return { newFiles: 0, autoQueued: 0, busy: true };
    }

    const { config, filesRepo, jobsRepo } = this.getContext();
    this.isScanning = true;
    this.newFilesFoundLastRun = 0;
    this.autoOptimizedLastRun = 0;
    this.lastRunAt = new Date().toISOString();

    startWatcherScanProgress(config.libraries.length);
    const seenPaths = new Set<string>();

    try {
      for (const [index, library] of config.libraries.entries()) {
        const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
        if (!preset) continue;

        startWatcherLibraryProgress(library.name, index + 1, config.libraries.length);
        try {
          await this.scanLibraryIncremental(library, preset, filesRepo, jobsRepo, config, seenPaths, options);
        } catch (err) {
          // A missing/unreadable library must not prevent the remaining
          // configured libraries from being checked.
          console.warn(`[Watcher] Failed to scan library "${library.name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`[Watcher] Error during library check: ${(err as Error).message}`);
    } finally {
      // Forget files that vanished mid-settle so this map can't grow forever.
      for (const path of this.pendingFileSizes.keys()) {
        if (!seenPaths.has(path)) this.pendingFileSizes.delete(path);
      }
      this.isScanning = false;
      completeWatcherScanProgress(this.newFilesFoundLastRun, this.autoOptimizedLastRun);
      releaseLock();
    }

    return {
      newFiles: this.newFilesFoundLastRun,
      autoQueued: this.autoOptimizedLastRun,
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
  ): Promise<void> {
    const diskFiles = await walkLibraryEntries(
      library.path,
      preset.mediaKind === "audio" ? "audio" : "video",
      updateDiscoveryCount,
    );
    const diskPaths = new Set<string>();
    for (const file of diskFiles) {
      diskPaths.add(file.path);
      seenPaths.add(file.path);
    }
    // Remove any deleted files that are no longer on disk
    pruneLibrary(filesRepo, library, diskPaths);

    const existing = filesRepo.getFileMetadataMap(library.id);

    const shouldAutoOptimize = Boolean(library.autoOptimize || config.watcher?.autoOptimize);
    const settleDelaySeconds = config.watcher?.settleDelaySeconds ?? 15;
    const now = Date.now();

    const toProbe: WalkedFile[] = [];
    for (const file of diskFiles) {
      const known = existing.get(file.path);
      // Catches in-place replacements such as Sonarr/Radarr upgrades. Rows
      // with mtime 0 predate mtime tracking, so only a size change counts.
      const isChanged = known !== undefined
        && (known.sizeBytes !== file.sizeBytes || (known.mtimeMs > 0 && known.mtimeMs !== file.mtimeMs));
      const isNew = known === undefined;
      if (!isNew && !isChanged && !options.forceScan) {
        continue;
      }

      // Check settle delay to make sure file is not being written to right now
      const prev = this.pendingFileSizes.get(file.path);
      if (prev) {
        if (prev.size !== file.sizeBytes) {
          // Still growing, update and skip this pass
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          continue;
        }
        if (now - prev.checkedAt < settleDelaySeconds * 1000) {
          // Not enough settle time has passed yet
          continue;
        }
      } else if (isNew || isChanged) {
        // Files already older than the settle window are established library
        // content, not active downloads. Probe them immediately on the first
        // watcher pass. Only recently modified files need a second observation.
        if (needsSettleObservation(file.mtimeMs, now, settleDelaySeconds)) {
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          continue;
        }
      }

      toProbe.push(file);
    }
    existing.clear();

    setScanTotal(toProbe.length);
    const writer = new ScanWriter(filesRepo, jobsRepo);
    let done = 0;
    await runWithConcurrency(toProbe, config.scanner?.probeConcurrency ?? 4, async (file) => {
      const fileName = file.path.split(/[/\\]/).pop() || file.path;
      if ((await checkFileLockOrBusyAsync(file.path)).locked) {
        // Still being written or held by another process; look again next sweep.
        this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: Date.now() });
        updateScanStep(++done, fileName, false, 0);
        return;
      }
      this.pendingFileSizes.delete(file.path);
      try {
        const probe = await probeFile(file.path);
        const decision = decide(probe, preset, library);
        const fileRecord = buildFileRecord(file, library, probe, decision);
        writer.addFile(fileRecord);

        this.newFilesFoundLastRun += 1;
        this.totalNewFilesDiscovered += 1;

        if (shouldAutoOptimize && decision.shouldTranscode) {
          writer.addJob(file.path, preset.id, fileRecord.sizeBytes);
        }
        updateScanStep(++done, fileName, decision.shouldTranscode, decision.estimatedSavingsBytes);
      } catch (err) {
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
  }
}
