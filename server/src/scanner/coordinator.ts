import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { scanLibrary, type ScanOptions, type ScanResult } from "./scan.js";
import { startScanProgress, completeScanProgress } from "./tracker.js";

interface QueuedScan {
  library: Library;
  preset: Preset;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
  options: ScanOptions;
  resolve?: (result: ScanResult) => void;
  reject?: (err: Error) => void;
}

class ScanCoordinator {
  private queue: QueuedScan[] = [];
  private isRunning = false;
  private currentBatchTotal = 1;
  private currentBatchIndex = 1;

  async enqueueScan(
    library: Library,
    preset: Preset,
    filesRepo: FilesRepo,
    jobsRepo: JobsRepo,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      // Avoid duplicate enqueue for the same library if already queued
      const alreadyQueued = this.queue.some((item) => item.library.id === library.id);
      if (alreadyQueued) {
        return resolve({
          entries: [],
          totalScanned: 0,
          recommendedCount: 0,
          totalPotentialSavingsBytes: 0,
          queuedCount: 0,
        });
      }

      this.queue.push({
        library,
        preset,
        filesRepo,
        jobsRepo,
        options,
        resolve,
        reject,
      });

      if (!this.isRunning) {
        this.currentBatchTotal = this.queue.length;
        this.currentBatchIndex = 1;
        void this.processNext();
      }
    });
  }

  async enqueueScanAll(
    libraries: Library[],
    presets: Preset[],
    filesRepo: FilesRepo,
    jobsRepo: JobsRepo,
    options: { autoQueue?: boolean } = {},
  ): Promise<void> {
    if (libraries.length === 0) return;

    this.currentBatchTotal = libraries.length;
    this.currentBatchIndex = 1;

    for (let i = 0; i < libraries.length; i++) {
      const lib = libraries[i];
      const preset = presets.find((p) => p.id === lib.presetId) ?? presets[0];
      if (!preset) continue;

      const isBatchEnd = i === libraries.length - 1;
      void this.enqueueScan(lib, preset, filesRepo, jobsRepo, {
        ...options,
        totalLibraries: libraries.length,
        activeLibraryIndex: i + 1,
        isBatchEnd,
      });
    }
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isRunning = false;
      return;
    }

    this.isRunning = true;
    const item = this.queue.shift()!;

    try {
      const isBatchEnd = this.queue.length === 0;
      const opts: ScanOptions = {
        ...item.options,
        totalLibraries: item.options.totalLibraries ?? this.currentBatchTotal,
        activeLibraryIndex: item.options.activeLibraryIndex ?? this.currentBatchIndex,
        isBatchEnd: item.options.isBatchEnd ?? isBatchEnd,
      };

      const result = await scanLibrary(
        item.library,
        item.preset,
        item.filesRepo,
        item.jobsRepo,
        opts,
      );
      this.currentBatchIndex += 1;
      item.resolve?.(result);
    } catch (err) {
      console.error(`[ScanCoordinator] Error scanning library "${item.library.name}":`, err);
      item.reject?.(err as Error);
    } finally {
      if (this.queue.length > 0) {
        void this.processNext();
      } else {
        this.isRunning = false;
      }
    }
  }
}

export const scanCoordinator = new ScanCoordinator();
