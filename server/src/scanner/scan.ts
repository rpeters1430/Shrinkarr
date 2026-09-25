import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo, NewFileRecord } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import type { MediaProbe } from "../media/types.js";
import { checkFileLockOrBusyAsync } from "../utils/fileLock.js";
import { runWithConcurrency } from "../utils/pool.js";
import { walkLibraryEntries, type WalkedFile } from "./walk.js";
import { decide, type PolicyDecision } from "./policy.js";
import {
  startScanProgress,
  setScanTotal,
  updateDiscoveryCount,
  updateScanStep,
  completeScanProgress,
} from "./tracker.js";

export interface ScanResultEntry {
  path: string;
  codec: string;
  resolution: string;
  sizeBytes: number;
  estimatedSavingsBytes: number;
  recommendedAction: string;
  shouldTranscode: boolean;
  reason: string;
}

export interface ScanResult {
  entries: ScanResultEntry[];
  discoveredCount: number;
  indexedCount: number;
  failedCount: number;
  skippedCount: number;
  totalScanned: number;
  recommendedCount: number;
  totalPotentialSavingsBytes: number;
  queuedCount: number;
}

export interface ScanOptions {
  autoQueue?: boolean;
  totalLibraries?: number;
  activeLibraryIndex?: number;
  isBatchEnd?: boolean;
  forceScan?: boolean;
  probeConcurrency?: number;
  /** The CLI prints per-file entries; API scans skip them to save memory. */
  collectEntries?: boolean;
}

const DEFAULT_PROBE_CONCURRENCY = 4;
const WRITE_BATCH_SIZE = 200;

/**
 * Size and mtime come from the filesystem, not ffprobe, because ffprobe
 * doesn't always report a size and the unchanged-file check compares them
 * against the next walk.
 */
export function buildFileRecord(
  file: WalkedFile,
  library: Library,
  probe: MediaProbe,
  decision: PolicyDecision,
): NewFileRecord {
  return {
    path: file.path,
    libraryId: library.id,
    codec: probe.mediaKind === "audio" ? probe.audioCodec : probe.videoCodec,
    container: probe.container,
    sizeBytes: file.sizeBytes || probe.sizeBytes,
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
    mtimeMs: file.mtimeMs,
    needsTranscode: decision.shouldTranscode,
    skipReason: decision.shouldTranscode ? null : decision.reason,
  };
}

/** Groups scan writes into transactions; a commit per file dominates large scans. */
export class ScanWriter {
  private files: NewFileRecord[] = [];
  private jobs: Array<{ filePath: string; presetId: string; originalSizeBytes: number }> = [];
  queuedCount = 0;

  constructor(
    private readonly filesRepo: FilesRepo,
    private readonly jobsRepo: JobsRepo,
    private readonly batchSize = WRITE_BATCH_SIZE,
  ) {}

  addFile(record: NewFileRecord): void {
    this.files.push(record);
    this.maybeFlush();
  }

  addJob(filePath: string, presetId: string, originalSizeBytes: number): void {
    this.jobs.push({ filePath, presetId, originalSizeBytes });
    this.maybeFlush();
  }

  flush(): void {
    // Files first so a queued job always has its file row.
    if (this.files.length > 0) {
      const files = this.files;
      this.files = [];
      this.filesRepo.upsertFiles(files);
    }
    if (this.jobs.length > 0) {
      const jobs = this.jobs;
      this.jobs = [];
      this.queuedCount += this.jobsRepo.enqueueJobsBatch(jobs).length;
    }
  }

  private maybeFlush(): void {
    if (this.files.length + this.jobs.length >= this.batchSize) {
      this.flush();
    }
  }
}

/**
 * An empty walk over a library that has indexed files usually means the share
 * is unmounted, so pruning is skipped instead of wiping the index.
 */
export function pruneLibrary(filesRepo: FilesRepo, library: Library, diskPaths: Set<string>): number {
  if (diskPaths.size === 0) {
    const indexed = filesRepo.countFilesByLibrary(library.id);
    if (indexed > 0) {
      console.warn(
        `[Scanner] "${library.name}" returned no media files but ${indexed} are indexed; skipping prune in case the share is unmounted.`,
      );
      return 0;
    }
  }
  return filesRepo.pruneMissingFiles(library.id, diskPaths);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export async function scanLibrary(
  library: Library,
  preset: Preset,
  filesRepo: FilesRepo,
  jobsRepo: JobsRepo,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const totalLibs = options.totalLibraries ?? 1;
  const activeIdx = options.activeLibraryIndex ?? 1;
  const isBatchEnd = options.isBatchEnd ?? true;
  const collectEntries = options.collectEntries ?? true;
  const probeConcurrency = options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;

  // Immediately signal to UI that scan has initiated
  startScanProgress(library.id, library.name, totalLibs, activeIdx);

  const discovered = await walkLibraryEntries(
    library.path,
    preset.mediaKind === "audio" ? "audio" : "video",
    updateDiscoveryCount,
  );
  pruneLibrary(filesRepo, library, new Set(discovered.map((f) => f.path)));

  setScanTotal(discovered.length);

  const existingMeta = filesRepo.getFileMetadataMap(library.id);
  const writer = new ScanWriter(filesRepo, jobsRepo);

  const entries: ScanResultEntry[] = [];
  let indexedCount = 0;
  let recommendedCount = 0;
  let totalPotentialSavingsBytes = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let currentIdx = 0;

  const fileNameOf = (path: string) => path.split(/[/\\]/).pop() || path;

  const record = (entry: ScanResultEntry) => {
    indexedCount += 1;
    if (entry.shouldTranscode) {
      recommendedCount += 1;
      totalPotentialSavingsBytes += entry.estimatedSavingsBytes;
      if (options.autoQueue) {
        writer.addJob(entry.path, preset.id, entry.sizeBytes);
      }
    }
    currentIdx += 1;
    updateScanStep(currentIdx, fileNameOf(entry.path), entry.shouldTranscode, entry.estimatedSavingsBytes);
    if (collectEntries) entries.push(entry);
  };

  const recordFailure = (path: string) => {
    currentIdx += 1;
    updateScanStep(currentIdx, fileNameOf(path), false, 0);
  };

  const toProbe: WalkedFile[] = [];
  for (const file of discovered) {
    const cached = !options.forceScan ? existingMeta.get(file.path) : undefined;
    if (cached && cached.sizeBytes === file.sizeBytes && cached.mtimeMs === file.mtimeMs && file.mtimeMs > 0) {
      record({
        path: file.path,
        codec: cached.codec,
        resolution: cached.resolution,
        sizeBytes: file.sizeBytes,
        estimatedSavingsBytes: cached.estimatedSavingsBytes,
        recommendedAction: cached.recommendedAction,
        shouldTranscode: cached.needsTranscode,
        reason: cached.needsTranscode ? "eligible" : "cached / keep",
      });
    } else {
      toProbe.push(file);
    }
  }
  existingMeta.clear();
  writer.flush();

  await runWithConcurrency(toProbe, probeConcurrency, async (file) => {
    const { path } = file;
    const lockCheck = await checkFileLockOrBusyAsync(path);
    if (lockCheck.locked) {
      skippedCount += 1;
      console.warn(`[Scanner] Skipping locked/in-use file "${fileNameOf(path)}": ${lockCheck.reason}`);
      recordFailure(path);
      return;
    }

    try {
      const probe = await probeFile(path);
      const decision = decide(probe, preset, library);
      const fileRecord = buildFileRecord(file, library, probe, decision);
      writer.addFile(fileRecord);
      record({
        path,
        codec: fileRecord.codec,
        resolution: probe.resolutionLabel,
        sizeBytes: fileRecord.sizeBytes,
        estimatedSavingsBytes: decision.estimatedSavingsBytes,
        recommendedAction: decision.recommendedAction,
        shouldTranscode: decision.shouldTranscode,
        reason: decision.reason,
      });
    } catch (err) {
      failedCount += 1;
      console.warn(`Failed to scan file "${path}": ${(err as Error).message}`);
      recordFailure(path);
    }
  });
  writer.flush();

  const issueSummary = failedCount > 0 || skippedCount > 0
    ? ` ${failedCount} failed and ${skippedCount} locked/in-use file(s) were not indexed.`
    : "";
  const summary = `Scan complete for "${library.name}"! Discovered ${discovered.length} file(s), indexed ${indexedCount}, and found ${recommendedCount} eligible for optimization (Potential savings: ${formatBytes(totalPotentialSavingsBytes)}).${issueSummary}`;
  completeScanProgress(summary, isBatchEnd);

  return {
    entries,
    discoveredCount: discovered.length,
    indexedCount,
    failedCount,
    skippedCount,
    totalScanned: discovered.length,
    recommendedCount,
    totalPotentialSavingsBytes,
    queuedCount: writer.queuedCount,
  };
}
