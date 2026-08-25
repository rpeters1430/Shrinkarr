import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { checkFileLockOrBusy } from "../utils/fileLock.js";
import { walkLibrary } from "./walk.js";
import { decide } from "./policy.js";
import { startScanProgress, updateScanStep, completeScanProgress } from "./tracker.js";

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
  totalScanned: number;
  recommendedCount: number;
  totalPotentialSavingsBytes: number;
  queuedCount: number;
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
  options: { autoQueue?: boolean } = {},
): Promise<ScanResult> {
  const paths = await walkLibrary(library.path);
  // Prune any files that were deleted or upgraded externally from the database
  filesRepo.pruneMissingFiles(library.id, paths);

  const entries: ScanResultEntry[] = [];
  let queuedCount = 0;
  let recommendedCount = 0;
  let totalPotentialSavingsBytes = 0;

  startScanProgress(library.id, library.name, paths.length);

  let currentIdx = 0;
  for (const path of paths) {
    currentIdx += 1;
    const fileName = path.split(/[/\\]/).pop() || path;
    const lockCheck = checkFileLockOrBusy(path);
    if (lockCheck.locked) {
      console.warn(`[Scanner] Skipping locked/in-use file "${fileName}": ${lockCheck.reason}`);
      updateScanStep(currentIdx, fileName, false);
      continue;
    }

    try {
      const probe = await probeFile(path);
      const decision = decide(probe, preset);

      filesRepo.upsertFile({
        path,
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

      if (decision.shouldTranscode) {
        recommendedCount += 1;
        totalPotentialSavingsBytes += decision.estimatedSavingsBytes;

        if (options.autoQueue && !jobsRepo.hasActiveJobForPath(path)) {
          jobsRepo.enqueueJob(path, preset.id, probe.sizeBytes);
          queuedCount += 1;
        }
      }

      updateScanStep(currentIdx, fileName, decision.shouldTranscode);

      entries.push({
        path,
        codec: probe.videoCodec,
        resolution: probe.resolutionLabel,
        sizeBytes: probe.sizeBytes,
        estimatedSavingsBytes: decision.estimatedSavingsBytes,
        recommendedAction: decision.recommendedAction,
        shouldTranscode: decision.shouldTranscode,
        reason: decision.reason,
      });
    } catch (err) {
      console.warn(`Failed to scan file "${path}": ${(err as Error).message}`);
      updateScanStep(currentIdx, fileName, false);
    }
  }

  const summary = `Scan complete for "${library.name}"! Indexed ${paths.length} file(s), found ${recommendedCount} eligible for optimization (Potential savings: ${formatBytes(totalPotentialSavingsBytes)}).`;
  completeScanProgress(summary);

  return {
    entries,
    totalScanned: paths.length,
    recommendedCount,
    totalPotentialSavingsBytes,
    queuedCount,
  };
}
