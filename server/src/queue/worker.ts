import { dirname, extname, basename, join } from "node:path";
import { stat } from "node:fs/promises";
import type { Config } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { Job, JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { runTranscodeWithFallback } from "../transcode/runner.js";
import { verifyOutput } from "../transcode/verify.js";
import { replaceOriginal, cleanupTemp } from "./atomicReplace.js";
import { schedulePostJobHooks } from "./postJobHooks.js";
import { waitForFileStable } from "../utils/fileLock.js";
import { getFreeDiskSpaceBytes } from "../utils/diskSpace.js";

export function buildTempOutputPath(
  originalPath: string,
  tempSuffix: string,
  tempDirectory?: string,
  targetContainer?: string,
): string {
  const originalExt = extname(originalPath);
  const targetExt = targetContainer ? `.${targetContainer.replace(/^\./, "")}` : originalExt;
  const base = basename(originalPath, originalExt);
  if (tempDirectory && tempDirectory.trim().length > 0) {
    return join(tempDirectory.trim(), `${base}-${Date.now()}${tempSuffix}${targetExt}`);
  }
  const dir = dirname(originalPath);
  return join(dir, `${base}${tempSuffix}${targetExt}`);
}

export interface WorkerDeps {
  config: Config;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
}

export async function processJob(job: Job, deps: WorkerDeps, signal?: AbortSignal): Promise<void> {
  const { config, filesRepo, jobsRepo } = deps;
  const preset = config.presets.find((p) => p.id === job.presetId);
  if (!preset) {
    jobsRepo.markFailed(job.id, `Unknown preset "${job.presetId}"`);
    return;
  }

  if (signal?.aborted) {
    if (signal.reason === "reschedule") {
      jobsRepo.resetJobToPending(job.id);
    } else {
      jobsRepo.markCancelled(job.id);
    }
    return;
  }

  jobsRepo.markRunning(job.id);

  // File Lock & Stability Timing Guard
  const stabilityDelaySeconds = config.queue.fileStabilityDelaySeconds ?? 15;
  const lockRetryAttempts = config.queue.fileLockRetryAttempts ?? 6;
  const lockRetryDelaySeconds = config.queue.fileLockRetryDelaySeconds ?? 5;

  const stabilityCheck = await waitForFileStable(job.filePath, {
    settleDelaySeconds: stabilityDelaySeconds,
    timeoutSeconds: Math.max(30, stabilityDelaySeconds * 3),
  });

  if (signal?.aborted) {
    if (signal.reason === "reschedule") {
      jobsRepo.resetJobToPending(job.id);
    } else {
      jobsRepo.markCancelled(job.id);
    }
    return;
  }

  if (!stabilityCheck.stable) {
    jobsRepo.markFailed(
      job.id,
      `File locked or in-use: ${stabilityCheck.reason || "Source file is actively being written or locked by another process"}`,
    );
    return;
  }

  const originalExt = extname(job.filePath);
  const targetExt = preset.targetContainer ? `.${preset.targetContainer.replace(/^\./, "")}` : originalExt;
  const isContainerChanging = originalExt.toLowerCase() !== targetExt.toLowerCase();
  const finalDestinationPath = isContainerChanging
    ? join(dirname(job.filePath), `${basename(job.filePath, originalExt)}${targetExt}`)
    : job.filePath;

  const tempOutputPath = buildTempOutputPath(
    job.filePath,
    config.queue.tempSuffix,
    config.queue.tempDirectory,
    preset.targetContainer,
  );

  // Free Disk Space Safety Guard
  const minFreeSpaceGb = config.queue.minFreeSpaceGb ?? 10;
  if (minFreeSpaceGb > 0) {
    const minFreeBytes = minFreeSpaceGb * 1024 * 1024 * 1024;
    const destDir = dirname(finalDestinationPath);
    const tempDir = config.queue.tempDirectory && config.queue.tempDirectory.trim().length > 0
      ? config.queue.tempDirectory.trim()
      : dirname(job.filePath);

    const destFreeBytes = await getFreeDiskSpaceBytes(destDir);
    if (destFreeBytes < minFreeBytes) {
      const freeGb = (destFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
      jobsRepo.markFailed(
        job.id,
        `Insufficient disk space on destination volume: ${freeGb} GB available, but minFreeSpaceGb is set to ${minFreeSpaceGb} GB`,
      );
      return;
    }

    if (tempDir !== destDir) {
      const tempFreeBytes = await getFreeDiskSpaceBytes(tempDir);
      if (tempFreeBytes < minFreeBytes) {
        const freeGb = (tempFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
        jobsRepo.markFailed(
          job.id,
          `Insufficient disk space on scratch temp volume: ${freeGb} GB available, but minFreeSpaceGb is set to ${minFreeSpaceGb} GB`,
        );
        return;
      }
    }
  }

  let originalProbe;
  try {
    originalProbe = await probeFile(job.filePath);
  } catch (err) {
    jobsRepo.markFailed(job.id, `Failed to probe source file: ${(err as Error).message}`);
    return;
  }

  let encoderUsed: string;
  try {
    const result = await runTranscodeWithFallback(
      job.filePath,
      tempOutputPath,
      preset,
      originalProbe.durationSeconds,
      (progress) => {
        jobsRepo.markProgress(job.id, progress.percent, progress.fps, progress.speed);
      },
      {
        lowPriority: config.queue.lowPriority,
        threads: config.queue.threads,
        signal,
      },
      {
        isHdr: originalProbe.isHdr,
        colorTransfer: originalProbe.colorTransfer,
        bitDepth: originalProbe.bitDepth,
        sourceBitrateKbps: originalProbe.bitrateKbps,
      },
    );
    encoderUsed = result.encoderUsed;
  } catch (err) {
    await cleanupTemp(tempOutputPath);
    if (signal?.aborted) {
      if (signal.reason === "reschedule") {
        jobsRepo.resetJobToPending(job.id);
        console.log(`[Worker] Transcode job ${job.id} aborted/rescheduled; returned to pending queue.`);
        return;
      }
      jobsRepo.markCancelled(job.id);
      console.log(`[Worker] Transcode job ${job.id} cancelled.`);
      return;
    }
    jobsRepo.markFailed(job.id, `Transcode failed: ${(err as Error).message}`);
    return;
  }

  if (signal?.aborted) {
    await cleanupTemp(tempOutputPath);
    if (signal.reason === "reschedule") {
      jobsRepo.resetJobToPending(job.id);
    } else {
      jobsRepo.markCancelled(job.id);
    }
    return;
  }

  const verifyResult = await verifyOutput(originalProbe, tempOutputPath);
  if (!verifyResult.ok) {
    await cleanupTemp(tempOutputPath);
    jobsRepo.markFailed(job.id, `Verification failed: ${verifyResult.reason}`);
    return;
  }

  const outputStat = await stat(tempOutputPath);
  const newSizeBytes = outputStat.size;

  try {
    await replaceOriginal(job.filePath, tempOutputPath, config.queue.recycleBinPath, {
      retryAttempts: lockRetryAttempts,
      retryDelaySeconds: lockRetryDelaySeconds,
      destinationPath: finalDestinationPath,
    });
  } catch (replaceErr) {
    jobsRepo.markFailed(job.id, `Atomic replace failed: ${(replaceErr as Error).message}`);
    return;
  }

  const existingFile = filesRepo.getFileByPath(job.filePath);
  const libraryId = existingFile?.libraryId ?? "unknown";

  // If container extension changed (e.g. .mkv -> .mp4), clean up the previous file path in the DB
  if (isContainerChanging) {
    filesRepo.deleteFileByPath(job.filePath);
  }

  filesRepo.upsertFile({
    path: finalDestinationPath,
    libraryId,
    codec: preset.targetCodec,
    container: preset.targetContainer,
    sizeBytes: newSizeBytes,
    durationSeconds: originalProbe.durationSeconds,
    resolution: originalProbe.resolutionLabel,
    width: originalProbe.width,
    height: originalProbe.height,
    bitrateKbps: Math.round((newSizeBytes * 8) / (originalProbe.durationSeconds * 1000)),
    bitDepth: preset.bitDepth ?? 10,
    isHdr: originalProbe.isHdr,
    audioCodec: preset.audioMode === "aac" ? "aac" : preset.audioMode === "ac3" ? "ac3" : originalProbe.audioCodec,
    audioChannels: originalProbe.audioChannels,
    subtitleCount: preset.subtitleMode === "drop" ? 0 : originalProbe.subtitleCount,
    estimatedSavingsBytes: 0,
    recommendedAction: "Keep",
    mtimeMs: Math.floor(outputStat.mtimeMs),
    needsTranscode: false,
    skipReason: `Transcoded to ${preset.targetCodec.toUpperCase()} via ${encoderUsed}`,
  });

  jobsRepo.markDone(job.id, newSizeBytes);

  const finishedJob = jobsRepo.getById(job.id);
  if (finishedJob) {
    schedulePostJobHooks(finishedJob, config);
  }
}
