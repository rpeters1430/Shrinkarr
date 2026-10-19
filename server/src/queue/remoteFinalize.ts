import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AppContext } from "../api/context.js";
import { snapshotOf } from "../db/historyRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { runVideoQualityGate } from "../transcode/qualityGate.js";
import { verifyOutput } from "../transcode/verify.js";
import { replaceOriginal, cleanupTemp } from "./atomicReplace.js";
import { schedulePostJobHooks } from "./postJobHooks.js";
import { waitForFileStable } from "../utils/fileLock.js";
import { decide } from "../scanner/policy.js";

function extensionFor(preset: AppContext["config"]["presets"][number]): string {
  if (preset.mediaKind === "audio") {
    return preset.targetAudioCodec === "opus" ? ".opus" : preset.targetAudioCodec === "mp3" ? ".mp3" : preset.targetAudioCodec === "flac" ? ".flac" : ".m4a";
  }
  return `.${preset.targetContainer}`;
}

export async function finalizeRemoteJob(
  ctx: AppContext,
  input: { jobId: string; workerId: string; leaseId: string; encoderUsed?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { jobsRepo, filesRepo, config } = ctx;
  if (!jobsRepo.isRemoteLeaseCurrent(input.jobId, input.workerId, input.leaseId)) {
    return { ok: false, error: "Lease is no longer current" };
  }
  const job = jobsRepo.getById(input.jobId);
  if (!job || job.kind !== "transcode") return { ok: false, error: "Unknown transcode job" };
  const file = filesRepo.getFileByPath(job.filePath);
  const library = config.libraries.find((item) => item.id === file?.libraryId);
  const preset = config.presets.find((item) => item.id === job.presetId);
  if (!file || !library || !preset) return { ok: false, error: "Job configuration is no longer available" };
  const sourceExt = extname(job.filePath);
  const stem = basename(job.filePath, sourceExt);
  const targetExt = extensionFor(preset);
  const tempOutputPath = join(dirname(job.filePath), `${stem}.shrinkarr-${job.id}-${input.leaseId}${targetExt}`);
  const finalPath = sourceExt.toLowerCase() === targetExt.toLowerCase()
    ? job.filePath
    : join(dirname(job.filePath), `${stem}${targetExt}`);
  const fail = async (message: string): Promise<{ ok: false; error: string }> => {
    if (existsSync(job.filePath)) await cleanupTemp(tempOutputPath);
    if (!jobsRepo.isRemoteLeaseCurrent(job.id, input.workerId, input.leaseId)) {
      return { ok: false, error: "Lease is no longer current" };
    }
    jobsRepo.markFailed(job.id, message);
    jobsRepo.saveLog(job.id, `[${new Date().toISOString()}] ${message}`);
    return { ok: false, error: message };
  };

  if (!existsSync(tempOutputPath)) return fail("Remote output file is missing from the shared library mount");
  if (finalPath !== job.filePath && existsSync(finalPath)) return fail(`Cannot convert to ${targetExt}: destination already exists`);
  const stabilityDelay = config.queue.fileStabilityDelaySeconds ?? 15;
  const stable = await waitForFileStable(job.filePath, {
    settleDelaySeconds: stabilityDelay,
    timeoutSeconds: Math.max(30, stabilityDelay * 3),
  });
  if (!stable.stable) return fail(`Source is not stable: ${stable.reason ?? "unknown reason"}`);
  let sourceProbe;
  try { sourceProbe = await probeFile(job.filePath); }
  catch (error) { return fail(`Could not probe source: ${(error as Error).message}`); }
  let sourceStatAtStart;
  try { sourceStatAtStart = await stat(job.filePath); }
  catch (error) { return fail(`Could not stat source: ${(error as Error).message}`); }
  if (sourceProbe.sizeBytes !== file.sizeBytes || Math.floor(sourceStatAtStart.mtimeMs) !== Math.floor(file.mtimeMs ?? 0)) {
    return fail("Source changed since its library scan; refusing to install output encoded from a stale source");
  }
  const decision = decide(sourceProbe, preset, library);
  const isRemux = decision.recommendedAction === "Remux";
  const verified = await verifyOutput(sourceProbe, tempOutputPath, { enforceSizeReduction: !isRemux });
  if (!verified.ok || !verified.probe) return fail(`Remote output verification failed: ${verified.reason ?? "output probe unavailable"}`);
  if (config.queue.qualityGate?.enabled && sourceProbe.mediaKind === "video" && preset.mediaKind !== "audio" && !isRemux) {
    let quality;
    try {
      quality = await runVideoQualityGate(job.filePath, tempOutputPath, sourceProbe.durationSeconds, {
        minimumSsim: config.queue.qualityGate.minimumSsim,
        sourceWidth: sourceProbe.width,
        sourceHeight: sourceProbe.height,
        sourceVideoDurationSeconds: sourceProbe.videoDurationSeconds,
        outputVideoDurationSeconds: verified.probe.videoDurationSeconds,
        frameRate: sourceProbe.fps,
        lowPriority: config.queue.lowPriority,
      });
    } catch (error) {
      return fail(`Quality gate could not run: ${(error as Error).message}`);
    }
    if (!quality.ok) return fail(`Quality gate failed: ${quality.reason ?? "SSIM score unavailable"}`);
  }
  if (!jobsRepo.isRemoteLeaseCurrent(job.id, input.workerId, input.leaseId)) return fail("Lease expired before output replacement");
  let sourceStatBeforeReplace;
  try { sourceStatBeforeReplace = await stat(job.filePath); }
  catch (error) { return fail(`Could not recheck source before replacement: ${(error as Error).message}`); }
  if (sourceStatAtStart.size !== sourceStatBeforeReplace.size || sourceStatAtStart.mtimeMs !== sourceStatBeforeReplace.mtimeMs) {
    return fail("Source changed while the remote output was being verified");
  }
  let outputStat;
  try { outputStat = await stat(tempOutputPath); }
  catch (error) { return fail(`Could not stat verified output: ${(error as Error).message}`); }
  try {
    await replaceOriginal(job.filePath, tempOutputPath, config.queue.recycleBinPath, {
      retryAttempts: config.queue.fileLockRetryAttempts,
      retryDelaySeconds: config.queue.fileLockRetryDelaySeconds,
      destinationPath: finalPath,
    });
  } catch (error) {
    return fail(`Atomic replacement failed: ${(error as Error).message}`);
  }
  if (finalPath !== job.filePath) filesRepo.deleteFileByPath(job.filePath);
  filesRepo.upsertFile({
    path: finalPath,
    libraryId: file.libraryId,
    codec: verified.probe.mediaKind === "audio" ? verified.probe.audioCodec : verified.probe.videoCodec,
    container: verified.probe.container,
    sizeBytes: outputStat.size,
    durationSeconds: verified.probe.durationSeconds,
    resolution: verified.probe.resolutionLabel,
    width: verified.probe.width,
    height: verified.probe.height,
    bitrateKbps: verified.probe.bitrateKbps,
    bitDepth: verified.probe.bitDepth,
    isHdr: verified.probe.isHdr,
    audioCodec: verified.probe.audioCodec,
    audioChannels: verified.probe.audioChannels,
    subtitleCount: verified.probe.subtitleCount,
    estimatedSavingsBytes: 0,
    recommendedAction: "Keep",
    mtimeMs: Math.floor(outputStat.mtimeMs),
    needsTranscode: false,
    skipReason: isRemux ? `Remuxed (${decision.reason.replace(/^remux: /, "")})` : `Transcoded by remote worker${input.encoderUsed ? ` via ${input.encoderUsed}` : ""}`,
    policyMetadata: {
      mediaKind: verified.probe.mediaKind,
      fps: verified.probe.fps,
      colorTransfer: verified.probe.colorTransfer ?? null,
      isLosslessAudio: verified.probe.isLosslessAudio,
      audioTracks: verified.probe.audioTracks,
      subtitleTracks: verified.probe.subtitleTracks,
    },
  });
  if (file.healthStatus === "healthy") filesRepo.setHealth(finalPath, "healthy", file.healthMode, null);
  jobsRepo.setRemoteEncoder(job.id, input.workerId, input.leaseId, input.encoderUsed ?? "remote worker");
  jobsRepo.markDone(job.id, outputStat.size, finalPath);
  const done = jobsRepo.getById(job.id);
  if (ctx.historyRepo) ctx.historyRepo.record({
    id: job.id,
    filePath: finalPath,
    libraryId: file.libraryId,
    kind: isRemux ? "remux" : "transcode",
    status: "done",
    presetId: job.presetId,
    encoder: input.encoderUsed ?? "remote worker",
    error: null,
    originalSizeBytes: sourceProbe.sizeBytes,
    newSizeBytes: outputStat.size,
    startedAt: job.startedAt ?? job.createdAt,
    finishedAt: new Date().toISOString(),
    before: snapshotOf(sourceProbe),
    after: snapshotOf(verified.probe, outputStat.size),
    log: `Remote worker ${input.workerId} completed the encode and coordinator verification passed.`,
  });
  if (done) schedulePostJobHooks(done, config);
  return { ok: true };
}
