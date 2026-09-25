import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { scanLibrary, type ScanOptions, type ScanResult } from "./scan.js";
import { acquireScanLock } from "./scanLock.js";
import { failScanProgress } from "./tracker.js";

interface QueuedScan {
  library: Library;
  preset: Preset;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
  options: ScanOptions;
  resolve?: (result: ScanResult) => void;
  reject?: (err: Error) => void;
}

const EMPTY_RESULT: ScanResult = {
  entries: [],
  discoveredCount: 0,
  indexedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  totalScanned: 0,
  recommendedCount: 0,
  totalPotentialSavingsBytes: 0,
  queuedCount: 0,
};

class ScanCoordinator {
  private queue: QueuedScan[] = [];
  private isRunning = false;
  private runningLibraryId: string | null = null;
  private batchTotal = 0;
  private batchIndex = 0;

  enqueueScan(
    library: Library,
    preset: Preset,
    filesRepo: FilesRepo,
    jobsRepo: JobsRepo,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const alreadyQueued =
        this.runningLibraryId === library.id || this.queue.some((item) => item.library.id === library.id);
      if (alreadyQueued) {
        resolve(EMPTY_RESULT);
        return;
      }

      if (!this.isRunning) {
        this.batchTotal = 0;
        this.batchIndex = 0;
      }
      this.batchTotal += 1;
      this.queue.push({ library, preset, filesRepo, jobsRepo, options, resolve, reject });

      if (!this.isRunning) {
        this.isRunning = true;
        void this.drain();
      }
    });
  }

  enqueueScanAll(
    libraries: Library[],
    presets: Preset[],
    filesRepo: FilesRepo,
    jobsRepo: JobsRepo,
    options: Pick<ScanOptions, "autoQueue" | "probeConcurrency" | "collectEntries"> = {},
  ): void {
    for (const lib of libraries) {
      const preset = presets.find((p) => p.id === lib.presetId) ?? presets[0];
      if (!preset) continue;
      // Errors are already logged and reported through the progress tracker.
      this.enqueueScan(lib, preset, filesRepo, jobsRepo, options).catch(() => {});
    }
  }

  isBusy(): boolean {
    return this.isRunning;
  }

  private async drain(): Promise<void> {
    // Holding the lock for the whole batch keeps a watcher sweep from
    // starting between libraries and taking over the progress display.
    const release = await acquireScanLock();
    try {
      let item: QueuedScan | undefined;
      while ((item = this.queue.shift())) {
        this.batchIndex += 1;
        this.runningLibraryId = item.library.id;
        try {
          const result = await scanLibrary(item.library, item.preset, item.filesRepo, item.jobsRepo, {
            ...item.options,
            totalLibraries: this.batchTotal,
            activeLibraryIndex: this.batchIndex,
            isBatchEnd: this.queue.length === 0,
          });
          item.resolve?.(result);
        } catch (err) {
          console.error(`[ScanCoordinator] Error scanning library "${item.library.name}":`, err);
          failScanProgress(item.library.name, (err as Error).message);
          item.reject?.(err as Error);
        }
      }
    } finally {
      this.runningLibraryId = null;
      this.isRunning = false;
      release();
    }
  }
}

export const scanCoordinator = new ScanCoordinator();
