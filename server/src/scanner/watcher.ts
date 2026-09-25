import type { Config, Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { checkFileLockOrBusy } from "../utils/fileLock.js";
import { runWithConcurrency } from "../utils/pool.js";
import { decide } from "./policy.js";
import { buildFileRecord, pruneLibrary, ScanWriter } from "./scan.js";
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

import { startWatcherScanProgress, completeWatcherScanProgress } from "./tracker.js";

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

  async checkAllLibraries(options: { forceScan?: boolean } = {}): Promise<{ newFiles: number; autoQueued: number }> {
    if (this.isScanning) {
      return { newFiles: 0, autoQueued: 0 };
    }

    const { config, filesRepo, jobsRepo } = this.getContext();
    this.isScanning = true;
    this.newFilesFoundLastRun = 0;
    this.autoOptimizedLastRun = 0;
    this.lastRunAt = new Date().toISOString();

    startWatcherScanProgress(config.libraries.length);
    const seenPaths = new Set<string>();

    try {
      for (const library of config.libraries) {
        const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
        if (!preset) continue;

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
      // Drop settle tracking for files that were deleted or moved away so the
      // map doesn't grow without bound on a busy library.
      for (const path of this.pendingFileSizes.keys()) {
        if (!seenPaths.has(path)) this.pendingFileSizes.delete(path);
      }
      this.isScanning = false;
      completeWatcherScanProgress(this.newFilesFoundLastRun, this.autoOptimizedLastRun);
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
    const diskFiles = await walkLibraryEntries(library.path, preset.mediaKind === "audio" ? "audio" : "video");
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
      // Files replaced in place (e.g. a Sonarr/Radarr upgrade) keep their path
      // but change size or mtime. Rows without a recorded mtime predate
      // mtime tracking and are only treated as changed if the size differs.
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
        if (checkFileLockOrBusy(file.path).locked) {
          // Still locked by another process
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          continue;
        }
        this.pendingFileSizes.delete(file.path);
      } else if (isNew || isChanged) {
        // Files already older than the settle window are established library
        // content, not active downloads. Probe them immediately on the first
        // watcher pass. Only recently modified files need a second observation.
        if (needsSettleObservation(file.mtimeMs, now, settleDelaySeconds)) {
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          continue;
        }
        if (checkFileLockOrBusy(file.path).locked) {
          this.pendingFileSizes.set(file.path, { size: file.sizeBytes, checkedAt: now });
          continue;
        }
      }

      toProbe.push(file);
    }
    existing.clear();

    const writer = new ScanWriter(filesRepo, jobsRepo);
    await runWithConcurrency(toProbe, config.scanner?.probeConcurrency ?? 4, async (file) => {
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
      } catch (err) {
        console.warn(`[Watcher] Failed to probe new file "${file.path}": ${(err as Error).message}`);
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
