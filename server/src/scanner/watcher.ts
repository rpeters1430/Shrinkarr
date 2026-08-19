import { statSync } from "node:fs";
import type { Config, Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { decide } from "./policy.js";
import { walkLibrary } from "./walk.js";

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

    try {
      for (const library of config.libraries) {
        const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
        if (!preset) continue;

        await this.scanLibraryIncremental(library, preset, filesRepo, jobsRepo, config, options);
      }
    } catch (err) {
      console.warn(`[Watcher] Error during library check: ${(err as Error).message}`);
    } finally {
      this.isScanning = false;
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
    options: { forceScan?: boolean } = {},
  ): Promise<void> {
    const existingFilePaths = new Set(filesRepo.getFilesByLibrary(library.id).map((f) => f.path));
    const diskPaths = await walkLibrary(library.path);

    const shouldAutoOptimize = Boolean(library.autoOptimize || config.watcher?.autoOptimize);
    const settleDelaySeconds = config.watcher?.settleDelaySeconds ?? 15;

    for (const diskPath of diskPaths) {
      const isNew = !existingFilePaths.has(diskPath);
      if (!isNew && !options.forceScan) {
        continue;
      }

      // Check settle delay to make sure file is not being written to right now
      try {
        const stat = statSync(diskPath);
        const now = Date.now();
        const prev = this.pendingFileSizes.get(diskPath);

        if (prev) {
          if (prev.size !== stat.size) {
            // Still growing, update and skip this pass
            this.pendingFileSizes.set(diskPath, { size: stat.size, checkedAt: now });
            continue;
          }
          if (now - prev.checkedAt < settleDelaySeconds * 1000) {
            // Not enough settle time has passed yet
            continue;
          }
          this.pendingFileSizes.delete(diskPath);
        } else if (isNew) {
          // First time seeing this new file, record size and wait for settle delay
          this.pendingFileSizes.set(diskPath, { size: stat.size, checkedAt: now });
          continue;
        }
      } catch {
        continue;
      }

      try {
        const probe = await probeFile(diskPath);
        const decision = decide(probe, preset);

        filesRepo.upsertFile({
          path: diskPath,
          libraryId: library.id,
          codec: probe.videoCodec,
          container: probe.container,
          sizeBytes: probe.sizeBytes,
          durationSeconds: probe.durationSeconds,
          resolution: probe.resolutionLabel,
          width: probe.width,
          height: probe.height,
          bitrateKbps: probe.bitrateKbps,
          bitDepth: probe.bitDepth,
          isHdr: probe.isHdr,
          audioCodec: probe.audioCodec,
          audioChannels: probe.audioChannels,
          subtitleCount: probe.subtitleCount,
          estimatedSavingsBytes: decision.estimatedSavingsBytes,
          recommendedAction: decision.recommendedAction,
          needsTranscode: decision.shouldTranscode,
          skipReason: decision.shouldTranscode ? null : decision.reason,
        });

        this.newFilesFoundLastRun += 1;
        this.totalNewFilesDiscovered += 1;

        if (shouldAutoOptimize && decision.shouldTranscode && !jobsRepo.hasActiveJobForPath(diskPath)) {
          jobsRepo.enqueueJob(diskPath, preset.id, probe.sizeBytes);
          this.autoOptimizedLastRun += 1;
          this.totalAutoOptimized += 1;
          console.log(`[Watcher] Auto-queued new video for optimization: "${diskPath.split(/[/\\]/).pop()}"`);
        }
      } catch (err) {
        console.warn(`[Watcher] Failed to probe new file "${diskPath}": ${(err as Error).message}`);
      }
    }
  }
}
