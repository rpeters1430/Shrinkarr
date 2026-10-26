import { dirname, extname, basename, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import type { Config, Preset } from "../config/schema.js";
import type { FilesRepo, FileRecord } from "../db/filesRepo.js";
import type { Job, JobsRepo } from "../db/jobsRepo.js";
import { snapshotOf, type HistoryKind, type HistoryRepo, type MediaSnapshot } from "../db/historyRepo.js";
import { probeFile, detectMidStreamResolutionChanges } from "../media/ffprobe.js";
import { runHealthCheck, type HealthCheckMode } from "../media/healthCheck.js";
import type { MediaProbe } from "../media/types.js";
import { decide } from "../scanner/policy.js";
import { runTranscodeWithFallback } from "../transcode/runner.js";
import { verifyOutput } from "../transcode/verify.js";
import { runVideoQualityGate } from "../transcode/qualityGate.js";
import { resolveVaapiDecodeDevice } from "../transcode/hardware.js";
import { replaceOriginal, cleanupTemp } from "./atomicReplace.js";
import { schedulePostJobHooks } from "./postJobHooks.js";
import { buildStagedSourcePath, copyFileSequential } from "./stageSource.js";
import { holdSelfWritePaths } from "../scanner/selfWrites.js";
import { waitForFileStable } from "../utils/fileLock.js";
import { getFreeDiskSpaceBytes } from "../utils/diskSpace.js";
import { lookupOriginalLanguage } from "../integrations/originalLanguage.js";
import { usesOriginalLanguage } from "../transcode/streams.js";

// The video path keys off preset.targetContainer (mkv/mp4); music presets pick
// their extension from the target audio codec instead, since targetContainer
// isn't meaningful for an audio-only preset.
function presetTargetExtension(preset: Preset): string | undefined {
  if (preset.mediaKind === "audio") {
    switch (preset.targetAudioCodec) {
      case "opus":
        return "opus";
      case "mp3":
        return "mp3";
      case "flac":
        return "flac";
      default:
        return "m4a";
    }
  }
  return preset.targetContainer;
}

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
  historyRepo?: HistoryRepo;
}

// Timestamped lines for the job's log, saved to the jobs row (and the
// history row) when the job ends.
class JobLog {
  private readonly entries: string[] = [];

  add(text: string): void {
    this.entries.push(`[${new Date().toISOString()}] ${text}`);
  }

  toString(): string {
    return this.entries.join("\n");
  }
}

interface JobOutcome {
  kind: HistoryKind;
  status: "done" | "failed";
  error?: string | null;
  encoder?: string | null;
  before?: MediaSnapshot | null;
  after?: MediaSnapshot | null;
  newSizeBytes?: number | null;
  filePath?: string;
}

/**
 * Ends a job: writes its log and, for a finished or failed job, a history
 * row. Cancelled and rescheduled jobs leave no history.
 */
function finishJob(job: Job, deps: WorkerDeps, log: JobLog, startedAt: string, fileRec: FileRecord | undefined, outcome?: JobOutcome): void {
  try {
    deps.jobsRepo.saveLog(job.id, log.toString());
  } catch (err) {
    console.warn(`[Worker] Could not save the log for job ${job.id}: ${(err as Error).message}`);
  }
  if (!outcome || !deps.historyRepo) return;
  try {
    deps.historyRepo.record({
      id: job.id,
      filePath: outcome.filePath ?? job.filePath,
      libraryId: fileRec?.libraryId ?? null,
      kind: outcome.kind,
      status: outcome.status,
      presetId: job.presetId,
      encoder: outcome.encoder ?? null,
      error: outcome.error ?? null,
      originalSizeBytes: outcome.before?.sizeBytes ?? job.originalSizeBytes ?? fileRec?.sizeBytes ?? null,
      newSizeBytes: outcome.newSizeBytes ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      before: outcome.before ?? null,
      after: outcome.after ?? null,
      log: log.toString(),
    });
  } catch (err) {
    console.warn(`[Worker] Could not record history for job ${job.id}: ${(err as Error).message}`);
  }
}

function stopForSignal(job: Job, jobsRepo: JobsRepo, signal: AbortSignal): void {
  if (signal.reason === "reschedule") {
    jobsRepo.resetJobToPending(job.id);
  } else {
    jobsRepo.markCancelled(job.id);
  }
}

// A file already found healthy by a check at least as thorough as the one
// configured doesn't need checking again before a transcode.
function needsPreTranscodeCheck(mode: Config["queue"]["healthCheck"], fileRec: FileRecord | undefined): mode is HealthCheckMode {
  if (mode === "off" || mode === undefined) return false;
  if (fileRec?.healthStatus !== "healthy") return true;
  return !(fileRec.healthMode === "thorough" || fileRec.healthMode === mode);
}

// Render node for the decode-only checks (health check, SSIM gate), looked up
// once per job. The job log says where the decode ran either way.
function checkDecodeDevice(log: JobLog, allowGpu: boolean): () => Promise<string | undefined> {
  let pending: Promise<string | undefined> | undefined;
  return () => {
    pending ??= (allowGpu ? resolveVaapiDecodeDevice().catch(() => undefined) : Promise.resolve(undefined))
      .then((device) => {
        log.add(device
          ? `Checks decode on the GPU (${device})`
          : allowGpu
            ? "Checks decode on the CPU: no VAAPI device passed hardware detection"
            : "Checks decode on the CPU: the preset is set to CPU");
        return device;
      });
    return pending;
  };
}

export async function processJob(job: Job, deps: WorkerDeps, signal?: AbortSignal): Promise<void> {
  if (job.kind === "health") {
    return processHealthJob(job, deps, signal);
  }
  const resources: JobResources = {};
  try {
    await processTranscodeJob(job, deps, resources, signal);
  } finally {
    if (resources.stagedSourcePath) await cleanupTemp(resources.stagedSourcePath);
    resources.releasePaths?.();
  }
}

// What a transcode job holds that must be let go however it ends.
interface JobResources {
  stagedSourcePath?: string;
  releasePaths?: () => void;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function processTranscodeJob(job: Job, deps: WorkerDeps, resources: JobResources, signal?: AbortSignal): Promise<void> {
  const { config, filesRepo, jobsRepo } = deps;
  const startedAt = new Date().toISOString();
  const log = new JobLog();
  const fileRec = filesRepo.getFileByPath(job.filePath);
  let beforeSnapshot: MediaSnapshot | null = null;
  let historyKind: HistoryKind = "transcode";

  const fail = (error: string): void => {
    log.add(error);
    jobsRepo.markFailed(job.id, error);
    finishJob(job, deps, log, startedAt, fileRec, { kind: historyKind, status: "failed", error, before: beforeSnapshot });
  };
  const stop = (abortSignal: AbortSignal): void => {
    log.add(abortSignal.reason === "reschedule" ? "Stopped; the job goes back in the queue." : "Cancelled.");
    finishJob(job, deps, log, startedAt, fileRec);
    stopForSignal(job, jobsRepo, abortSignal);
  };

  const preset = config.presets.find((p) => p.id === job.presetId);
  if (!preset) {
    fail(`Unknown preset "${job.presetId}"`);
    return;
  }

  if (signal?.aborted) {
    stopForSignal(job, jobsRepo, signal);
    return;
  }

  jobsRepo.markRunning(job.id);
  log.add(`Starting "${job.filePath}" with preset "${preset.name}"`);

  // File Lock & Stability Timing Guard
  const stabilityDelaySeconds = config.queue.fileStabilityDelaySeconds ?? 15;
  const lockRetryAttempts = config.queue.fileLockRetryAttempts ?? 6;
  const lockRetryDelaySeconds = config.queue.fileLockRetryDelaySeconds ?? 5;

  const stabilityCheck = await waitForFileStable(job.filePath, {
    settleDelaySeconds: stabilityDelaySeconds,
    timeoutSeconds: Math.max(30, stabilityDelaySeconds * 3),
    signal,
  });

  if (signal?.aborted) {
    stop(signal);
    return;
  }

  if (!stabilityCheck.stable) {
    fail(`File locked or in-use: ${stabilityCheck.reason || "Source file is actively being written or locked by another process"}`);
    return;
  }

  const targetExtension = presetTargetExtension(preset);
  const originalExt = extname(job.filePath);
  const targetExt = targetExtension ? `.${targetExtension.replace(/^\./, "")}` : originalExt;
  const isContainerChanging = originalExt.toLowerCase() !== targetExt.toLowerCase();
  const finalDestinationPath = isContainerChanging
    ? join(dirname(job.filePath), `${basename(job.filePath, originalExt)}${targetExt}`)
    : job.filePath;

  // Changing container (movie.mkv -> movie.mp4) must never overwrite a
  // different file that already sits at the new name.
  if (isContainerChanging && existsSync(finalDestinationPath)) {
    fail(`Cannot convert to ${targetExt}: "${basename(finalDestinationPath)}" already exists next to the original`);
    return;
  }

  const tempOutputPath = buildTempOutputPath(
    job.filePath,
    config.queue.tempSuffix,
    config.queue.tempDirectory,
    targetExtension,
  );
  resources.releasePaths = holdSelfWritePaths([job.filePath, finalDestinationPath]);

  const stagingDirectory = config.queue.tempDirectory?.trim() || undefined;
  const stageSource = Boolean(config.queue.stageSource && stagingDirectory);
  if (config.queue.stageSource && !stagingDirectory) {
    log.add("stageSource is on but queue.tempDirectory is not set, so the source is read from the library directly");
  }

  // Taken before any work so the replace step can tell whether the source
  // changed (a Sonarr/Radarr upgrade, say) while it was being encoded.
  let sourceStatAtStart;
  try {
    sourceStatAtStart = await stat(job.filePath);
  } catch (err) {
    fail(`Could not stat source file: ${(err as Error).message}`);
    return;
  }

  // Free Disk Space Safety Guard
  const minFreeSpaceGb = config.queue.minFreeSpaceGb ?? 10;
  if (minFreeSpaceGb > 0 || stageSource) {
    const minFreeBytes = minFreeSpaceGb * 1024 * 1024 * 1024;
    const destDir = dirname(finalDestinationPath);
    const tempDir = stagingDirectory ?? dirname(job.filePath);

    const destFreeBytes = await getFreeDiskSpaceBytes(destDir);
    if (destFreeBytes < minFreeBytes) {
      const freeGb = (destFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
      fail(`Insufficient disk space on destination volume: ${freeGb} GB available, but minFreeSpaceGb is set to ${minFreeSpaceGb} GB`);
      return;
    }

    if (tempDir !== destDir) {
      // A staged job keeps a full copy of the source next to its output.
      const neededBytes = minFreeBytes + (stageSource ? sourceStatAtStart.size : 0);
      const tempFreeBytes = await getFreeDiskSpaceBytes(tempDir);
      if (tempFreeBytes < neededBytes) {
        const freeGb = (tempFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
        fail(stageSource
          ? `Insufficient disk space on scratch temp volume: ${freeGb} GB available, but the ${formatBytes(sourceStatAtStart.size)} source copy plus minFreeSpaceGb (${minFreeSpaceGb} GB) is needed`
          : `Insufficient disk space on scratch temp volume: ${freeGb} GB available, but minFreeSpaceGb is set to ${minFreeSpaceGb} GB`);
        return;
      }
    }
  }

  let originalProbe: MediaProbe;
  try {
    originalProbe = await probeFile(job.filePath);
  } catch (err) {
    fail(`Failed to probe source file: ${(err as Error).message}`);
    return;
  }
  beforeSnapshot = snapshotOf(originalProbe);
  // The language the scan looked up, so the job keeps the tracks the scan
  // planned for; looked up now for files queued before it had one.
  if (usesOriginalLanguage(preset)) {
    originalProbe.originalLanguage = fileRec?.policyMetadata?.originalLanguage
      ?? await lookupOriginalLanguage(job.filePath, config);
  }

  // The scan's verdict decides between a full transcode and a remux. A job
  // the user queued by hand for a file the scan would keep is a transcode.
  const library = config.libraries.find((l) => l.id === fileRec?.libraryId);
  const decision = decide(originalProbe, preset, library);
  const isRemux = decision.recommendedAction === "Remux";
  if (isRemux) {
    historyKind = "remux";
    log.add(`Remuxing without re-encoding the video (${decision.reason.replace(/^remux: /, "")})`);
  }

  // Everything that decodes the source reads this path: the library file, or
  // its local copy when staging is on.
  let sourcePath = job.filePath;
  if (stageSource && stagingDirectory) {
    const stagedPath = buildStagedSourcePath(job.filePath, job.id, config.queue.tempSuffix, stagingDirectory);
    jobsRepo.markRunning(job.id, "Copying source to local cache");
    log.add(`Copying the source to "${stagedPath}"`);
    const copyStartedAt = Date.now();
    const totalBytes = sourceStatAtStart.size;
    try {
      await mkdir(stagingDirectory, { recursive: true });
      resources.stagedSourcePath = stagedPath;
      const copied = await copyFileSequential(job.filePath, stagedPath, {
        signal,
        onProgress: (bytes) => {
          if (totalBytes > 0) jobsRepo.markProgress(job.id, Math.min(99, (bytes / totalBytes) * 100));
        },
      });
      const seconds = Math.max(0.001, (Date.now() - copyStartedAt) / 1000);
      log.add(`Copied ${formatBytes(copied)} in ${seconds.toFixed(0)}s (${formatBytes(copied / seconds)}/s)`);
      if (copied !== totalBytes) {
        fail(`Source copy is ${copied} bytes but the source is ${totalBytes} bytes; it may have changed during the copy`);
        return;
      }
    } catch (err) {
      if (signal?.aborted) {
        stop(signal);
        return;
      }
      fail(`Could not copy the source to the local cache: ${(err as Error).message}`);
      return;
    }
    if (signal?.aborted) {
      stop(signal);
      return;
    }
    jobsRepo.markProgress(job.id, 0, undefined, undefined, true);
    sourcePath = stagedPath;
  }

  const decodeDevice = checkDecodeDevice(log, preset.hwaccel !== "cpu");
  const healthMode = config.queue.healthCheck;
  if (needsPreTranscodeCheck(healthMode, fileRec)) {
    jobsRepo.markRunning(job.id, `Health check (${healthMode})`);
    log.add(`Running a ${healthMode} health check on the source`);
    let health;
    try {
      health = await runHealthCheck(sourcePath, healthMode, originalProbe.durationSeconds, {
        signal,
        lowPriority: config.queue.lowPriority,
        onLog: (text) => log.add(text),
        hwDecodeDevice: await decodeDevice(),
      });
    } catch (err) {
      if (signal?.aborted) {
        stop(signal);
        return;
      }
      const error = `Unverifiable: Health check could not run: ${(err as Error).message}`;
      filesRepo.setHealth(job.filePath, "unverifiable", healthMode, error);
      fail(error);
      return;
    }
    if (health.status === "corrupt") {
      filesRepo.setHealth(job.filePath, "corrupt", healthMode, health.errors.join("\n"));
      fail(`Source file failed the ${healthMode} health check, so it was left untouched: ${health.errors[0]}`);
      return;
    }
    if (health.status === "unverifiable") {
      const reason = `Unverifiable: ${health.errors[0] ?? "FFmpeg could not confirm that the source is healthy"}`;
      filesRepo.setHealth(job.filePath, "unverifiable", healthMode, reason);
      fail(`Source file could not be verified by the ${healthMode} health check, so it was left untouched: ${health.errors[0]}`);
      return;
    }
    filesRepo.setHealth(job.filePath, "healthy", healthMode, null);
  }

  let hasMultipleResolutions = false;
  let detectedResolutions: string[] = [];
  if (originalProbe.mediaKind === "video" && preset.hwaccel !== "cpu" && !isRemux) {
    try {
      const resCheck = await detectMidStreamResolutionChanges(sourcePath);
      hasMultipleResolutions = resCheck.hasMultipleResolutions;
      detectedResolutions = resCheck.resolutions;
      if (hasMultipleResolutions) {
        console.warn(
          `[Worker] Video "${job.filePath}" has mid-stream resolution changes (${detectedResolutions.join(" -> ")}). Bypassing GPU decode to prevent pipeline crash.`,
        );
      }
    } catch {
      // Non-fatal pre-flight check
    }
  }

  let encoderUsed: string;
  try {
    const result = await runTranscodeWithFallback(
      sourcePath,
      tempOutputPath,
      preset,
      originalProbe.durationSeconds,
      (progress) => {
        jobsRepo.markProgress(job.id, progress.percent, progress.fps, progress.speed);
      },
      {
        lowPriority: config.queue.lowPriority,
        threads: config.queue.threads,
        allowCpuFallback: config.queue.allowCpuFallback,
        signal,
        onLog: (text) => log.add(text),
        onEncoderSelected: (encoderId, mode, fallbackReason) => {
          const varResSuffix = (mode === "gpu-encode" && hasMultipleResolutions)
            ? " (variable resolution)"
            : "";
          if (encoderId === "copy") {
            jobsRepo.markRunning(job.id, "copy (remux)", null);
            return;
          }
          const modeLabel = mode === "gpu-full"
            ? "GPU decode + encode"
            : mode === "gpu-encode"
              ? `GPU encode${varResSuffix}`
              : preset.hwaccel === "cpu"
                ? "CPU"
                : "CPU fallback";
          const resolvedReason = fallbackReason
            ?? (hasMultipleResolutions ? `Mid-stream resolution change detected (${detectedResolutions.join(" -> ")})` : null);
          jobsRepo.markRunning(job.id, `${encoderId} (${modeLabel})`, resolvedReason);
          log.add(`Encoding with ${encoderId} (${modeLabel})${resolvedReason ? `: ${resolvedReason}` : ""}`);
          if (mode === "cpu" && fallbackReason) {
            console.warn(`[Worker] Job ${job.id} is using the CPU (${encoderId}) for "${job.filePath}": ${fallbackReason}`);
          }
        },
      },
      {
        isHdr: originalProbe.isHdr,
        colorTransfer: originalProbe.colorTransfer,
        bitDepth: originalProbe.bitDepth,
        sourceBitrateKbps: originalProbe.bitrateKbps,
        audioCodec: originalProbe.audioCodec,
        isLosslessAudio: originalProbe.isLosslessAudio,
        audioChannels: originalProbe.audioChannels,
        hasMultipleResolutions,
        detectedResolutions,
        audioTracks: originalProbe.audioTracks,
        subtitleTracks: originalProbe.subtitleTracks,
        originalLanguage: originalProbe.originalLanguage,
        sourceWidth: originalProbe.width,
        sourceHeight: originalProbe.height,
        copyVideo: isRemux,
      },
    );
    encoderUsed = result.encoderUsed;
  } catch (err) {
    await cleanupTemp(tempOutputPath);
    if (signal?.aborted) {
      console.log(signal.reason === "reschedule"
        ? `[Worker] Transcode job ${job.id} aborted/rescheduled; returned to pending queue.`
        : `[Worker] Transcode job ${job.id} cancelled.`);
      stop(signal);
      return;
    }
    fail(`${isRemux ? "Remux" : "Transcode"} failed: ${(err as Error).message}`);
    return;
  }

  if (signal?.aborted) {
    await cleanupTemp(tempOutputPath);
    stop(signal);
    return;
  }

  // A remux can legitimately grow the file (an added stereo track, a
  // container with more overhead), so only re-encodes must come out smaller.
  const verifyResult = await verifyOutput(originalProbe, tempOutputPath, { enforceSizeReduction: !isRemux });
  if (signal?.aborted) {
    await cleanupTemp(tempOutputPath);
    stop(signal);
    return;
  }
  if (!verifyResult.ok) {
    await cleanupTemp(tempOutputPath);

    // If verification failed because output was larger than original, update filesRepo
    // so the background scanner/watcher doesn't re-enqueue it in an infinite loop.
    if (verifyResult.reason?.includes("larger than original")) {
      const existingFile = filesRepo.getFileByPath(job.filePath);
      const libraryId = existingFile?.libraryId ?? "unknown";
      filesRepo.upsertFile({
        path: job.filePath,
        libraryId,
        codec: originalProbe.videoCodec,
        container: originalProbe.container,
        sizeBytes: originalProbe.sizeBytes,
        durationSeconds: originalProbe.durationSeconds,
        resolution: originalProbe.resolutionLabel,
        width: originalProbe.width,
        height: originalProbe.height,
        bitrateKbps: originalProbe.bitrateKbps,
        bitDepth: originalProbe.bitDepth,
        isHdr: originalProbe.isHdr,
        audioCodec: originalProbe.audioCodec,
        audioChannels: originalProbe.audioChannels,
        subtitleCount: originalProbe.subtitleCount,
        estimatedSavingsBytes: 0,
        recommendedAction: "Keep",
        mtimeMs: existingFile?.mtimeMs ?? Date.now(),
        needsTranscode: false,
        skipReason: `Transcode resulted in larger file; preserved original to prevent size increase`,
        policyMetadata: {
          mediaKind: originalProbe.mediaKind,
          fps: originalProbe.fps,
          colorTransfer: originalProbe.colorTransfer ?? null,
          isLosslessAudio: originalProbe.isLosslessAudio,
          audioTracks: originalProbe.audioTracks,
          subtitleTracks: originalProbe.subtitleTracks,
        },
      });
    }

    fail(`Verification failed: ${verifyResult.reason}`);
    return;
  }

  const qualityGate = config.queue.qualityGate;
  const isVideoEncode = !isRemux && originalProbe.mediaKind === "video";
  if (qualityGate?.enabled && isVideoEncode) {
    log.add(`Checking output video quality with SSIM (minimum ${qualityGate.minimumSsim.toFixed(3)})`);
    let qualityResult;
    try {
      qualityResult = await runVideoQualityGate(sourcePath, tempOutputPath, originalProbe.durationSeconds, {
        minimumSsim: qualityGate.minimumSsim,
        sourceWidth: originalProbe.width,
        sourceHeight: originalProbe.height,
        sourceVideoDurationSeconds: originalProbe.videoDurationSeconds,
        outputVideoDurationSeconds: verifyResult.probe?.videoDurationSeconds,
        frameRate: originalProbe.fps,
        signal,
        lowPriority: config.queue.lowPriority,
        onLog: (text) => log.add(text),
        hwDecodeDevice: await decodeDevice(),
      });
    } catch (err) {
      await cleanupTemp(tempOutputPath);
      if (signal?.aborted) {
        stop(signal);
        return;
      }
      fail(`Quality gate failed: ${(err as Error).message}`);
      return;
    }
    if (signal?.aborted) {
      await cleanupTemp(tempOutputPath);
      stop(signal);
      return;
    }
    if (!qualityResult.ok) {
      await cleanupTemp(tempOutputPath);
      fail(`Quality gate failed: ${qualityResult.reason ?? "quality metric unavailable"}`);
      return;
    }
    log.add(`SSIM quality gate passed: ${qualityResult.score?.toFixed(5)}`);
  } else if (qualityGate?.enabled) {
    log.add(originalProbe.mediaKind === "audio"
      ? "SSIM quality gate skipped: audio-only job"
      : "SSIM quality gate skipped: video is copied without re-encoding");
  }

  const outputStat = await stat(tempOutputPath);
  if (signal?.aborted) {
    await cleanupTemp(tempOutputPath);
    stop(signal);
    return;
  }
  const newSizeBytes = outputStat.size;

  if (!isRemux && originalProbe.sizeBytes > 0 && newSizeBytes >= originalProbe.sizeBytes) {
    await cleanupTemp(tempOutputPath);
    fail(`Output size (${(newSizeBytes / (1024 * 1024)).toFixed(1)}MB) was not smaller than original (${(originalProbe.sizeBytes / (1024 * 1024)).toFixed(1)}MB). Kept original file.`);
    return;
  }

  let sourceStatBeforeReplace;
  try {
    sourceStatBeforeReplace = await stat(job.filePath);
  } catch (err) {
    await cleanupTemp(tempOutputPath);
    fail(`Source file disappeared during the encode: ${(err as Error).message}`);
    return;
  }
  if (sourceStatBeforeReplace.size !== sourceStatAtStart.size || sourceStatBeforeReplace.mtimeMs !== sourceStatAtStart.mtimeMs) {
    await cleanupTemp(tempOutputPath);
    fail("Source file changed during the encode, so the output was discarded and the new source kept");
    return;
  }

  try {
    await replaceOriginal(job.filePath, tempOutputPath, config.queue.recycleBinPath, {
      retryAttempts: lockRetryAttempts,
      retryDelaySeconds: lockRetryDelaySeconds,
      destinationPath: finalDestinationPath,
    });
  } catch (replaceErr) {
    // Only discard the encode once the original is confirmed back in place;
    // otherwise the temp file may be the only playable copy.
    if (existsSync(job.filePath)) {
      await cleanupTemp(tempOutputPath);
    }
    fail(`Atomic replace failed: ${(replaceErr as Error).message}`);
    return;
  }

  const libraryId = fileRec?.libraryId ?? "unknown";

  // If container extension changed (e.g. .mkv -> .mp4), clean up the previous file path in the DB
  if (isContainerChanging) {
    filesRepo.deleteFileByPath(job.filePath);
  }

  const isAudioPreset = preset.mediaKind === "audio";
  const outputProbe = verifyResult.probe;
  const summary = isRemux
    ? `Remuxed (${decision.reason.replace(/^remux: /, "")})`
    : isAudioPreset
      ? `Transcoded to ${preset.targetAudioCodec.toUpperCase()} via ${encoderUsed}`
      : `Transcoded to ${preset.targetCodec.toUpperCase()} via ${encoderUsed}`;
  if (outputProbe) {
    filesRepo.upsertFile({
      path: finalDestinationPath,
      libraryId,
      codec: outputProbe.mediaKind === "audio" ? outputProbe.audioCodec : outputProbe.videoCodec,
      container: outputProbe.container,
      sizeBytes: newSizeBytes,
      durationSeconds: outputProbe.durationSeconds || originalProbe.durationSeconds,
      resolution: outputProbe.resolutionLabel,
      width: outputProbe.width,
      height: outputProbe.height,
      bitrateKbps: outputProbe.bitrateKbps,
      bitDepth: outputProbe.bitDepth,
      isHdr: outputProbe.isHdr,
      audioCodec: outputProbe.audioCodec,
      audioChannels: outputProbe.audioChannels,
      subtitleCount: outputProbe.subtitleCount,
      estimatedSavingsBytes: 0,
      recommendedAction: "Keep",
      mtimeMs: Math.floor(outputStat.mtimeMs),
      needsTranscode: false,
      skipReason: summary,
      policyMetadata: {
        mediaKind: outputProbe.mediaKind,
        fps: outputProbe.fps,
        colorTransfer: outputProbe.colorTransfer ?? null,
        isLosslessAudio: outputProbe.isLosslessAudio,
        audioTracks: outputProbe.audioTracks,
        subtitleTracks: outputProbe.subtitleTracks,
        originalLanguage: originalProbe.originalLanguage,
      },
    });
  } else {
    filesRepo.upsertFile({
      path: finalDestinationPath,
      libraryId,
      codec: isAudioPreset ? preset.targetAudioCodec : isRemux ? originalProbe.videoCodec : preset.targetCodec,
      container: isAudioPreset ? (targetExtension ?? "m4a") : preset.targetContainer,
      sizeBytes: newSizeBytes,
      durationSeconds: originalProbe.durationSeconds,
      resolution: originalProbe.resolutionLabel,
      width: originalProbe.width,
      height: originalProbe.height,
      bitrateKbps: Math.round((newSizeBytes * 8) / (originalProbe.durationSeconds * 1000)),
      bitDepth: isAudioPreset ? 8 : (preset.bitDepth ?? 10),
      isHdr: isAudioPreset ? false : originalProbe.isHdr,
      audioCodec: isAudioPreset
        ? preset.targetAudioCodec
        : preset.audioMode === "aac" ? "aac" : preset.audioMode === "ac3" ? "ac3" : originalProbe.audioCodec,
      audioChannels: originalProbe.audioChannels,
      subtitleCount: isAudioPreset || preset.subtitleMode === "drop" ? 0 : originalProbe.subtitleCount,
      estimatedSavingsBytes: 0,
      recommendedAction: "Keep",
      mtimeMs: Math.floor(outputStat.mtimeMs),
      needsTranscode: false,
      skipReason: summary,
    });
  }
  // The output was just decoded end to end by the encode, and the source
  // passed whatever check ran before it.
  if (fileRec?.healthStatus === "healthy" || needsPreTranscodeCheck(healthMode, fileRec)) {
    filesRepo.setHealth(finalDestinationPath, "healthy", fileRec?.healthMode ?? healthMode, null);
  }

  jobsRepo.markDone(job.id, newSizeBytes, finalDestinationPath);
  log.add(`Done: ${(originalProbe.sizeBytes / (1024 * 1024)).toFixed(1)}MB to ${(newSizeBytes / (1024 * 1024)).toFixed(1)}MB`);
  finishJob(job, deps, log, startedAt, fileRec, {
    kind: historyKind,
    status: "done",
    encoder: encoderUsed,
    before: beforeSnapshot,
    after: outputProbe ? snapshotOf(outputProbe, newSizeBytes) : null,
    newSizeBytes,
    filePath: finalDestinationPath,
  });

  const finishedJob = jobsRepo.getById(job.id);
  if (finishedJob) {
    schedulePostJobHooks(finishedJob, config);
  }
}

async function processHealthJob(job: Job, deps: WorkerDeps, signal?: AbortSignal): Promise<void> {
  const { config, filesRepo, jobsRepo } = deps;
  const mode: HealthCheckMode = job.presetId === "thorough" ? "thorough" : "quick";
  const startedAt = new Date().toISOString();
  const log = new JobLog();
  const fileRec = filesRepo.getFileByPath(job.filePath);
  let before: MediaSnapshot | null = null;

  const end = (status: "done" | "failed", error: string | null): void => {
    if (error) log.add(error);
    if (status === "done") {
      jobsRepo.markDone(job.id, job.originalSizeBytes ?? fileRec?.sizeBytes ?? 0);
    } else {
      jobsRepo.markFailed(job.id, error ?? "Health check failed");
    }
    finishJob(job, deps, log, startedAt, fileRec, { kind: "health", status, error, before });
  };

  if (signal?.aborted) {
    stopForSignal(job, jobsRepo, signal);
    return;
  }
  jobsRepo.markRunning(job.id, `Health check (${mode})`);
  log.add(`Running a ${mode} health check on "${job.filePath}"`);

  const stabilityDelaySeconds = config.queue.fileStabilityDelaySeconds ?? 15;
  const stabilityCheck = await waitForFileStable(job.filePath, {
    settleDelaySeconds: stabilityDelaySeconds,
    timeoutSeconds: Math.max(30, stabilityDelaySeconds * 3),
    signal,
  });
  if (signal?.aborted) {
    finishJob(job, deps, log, startedAt, fileRec);
    stopForSignal(job, jobsRepo, signal);
    return;
  }
  if (!stabilityCheck.stable) {
    const error = `Unverifiable: ${stabilityCheck.reason || "File is not stable or is locked"}`;
    filesRepo.setHealth(job.filePath, "unverifiable", mode, error);
    end("failed", error);
    return;
  }

  let probe: MediaProbe;
  try {
    probe = await probeFile(job.filePath);
  } catch (err) {
    const error = `Unverifiable: Could not read the file: ${(err as Error).message}`;
    filesRepo.setHealth(job.filePath, "unverifiable", mode, error);
    end("failed", error);
    return;
  }
  before = snapshotOf(probe);

  try {
    const result = await runHealthCheck(job.filePath, mode, probe.durationSeconds, {
      signal,
      lowPriority: config.queue.lowPriority,
      onProgress: (percent) => jobsRepo.markProgress(job.id, percent),
      onLog: (text) => log.add(text),
      hwDecodeDevice: await checkDecodeDevice(log, true)(),
    });
    if (result.status === "healthy") {
      filesRepo.setHealth(job.filePath, "healthy", mode, null);
      log.add("No decode errors found.");
      end("done", null);
    } else if (result.status === "corrupt") {
      filesRepo.setHealth(job.filePath, "corrupt", mode, result.errors.join("\n"));
      end("failed", `Corrupt: ${result.errors[0]}${result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : ""}`);
    } else {
      const reason = `Unverifiable: ${result.errors[0] ?? "FFmpeg reported an error that does not confirm media corruption"}`;
      filesRepo.setHealth(job.filePath, "unverifiable", mode, reason);
      end("failed", reason);
    }
  } catch (err) {
    if (signal?.aborted) {
      finishJob(job, deps, log, startedAt, fileRec);
      stopForSignal(job, jobsRepo, signal);
      return;
    }
    const error = `Unverifiable: Health check could not run: ${(err as Error).message}`;
    filesRepo.setHealth(job.filePath, "unverifiable", mode, error);
    end("failed", error);
  }
}
