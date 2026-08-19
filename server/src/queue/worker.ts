import { dirname, extname, basename, join } from "node:path";
import { statSync } from "node:fs";
import type { Config } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { Job, JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { runTranscodeWithFallback } from "../transcode/runner.js";
import { verifyOutput } from "../transcode/verify.js";
import { replaceOriginal, cleanupTemp } from "./atomicReplace.js";
import { runPostJobHooks } from "./postJobHooks.js";

export function buildTempOutputPath(originalPath: string, tempSuffix: string): string {
  const dir = dirname(originalPath);
  const ext = extname(originalPath);
  const base = basename(originalPath, ext);
  return join(dir, `${base}${tempSuffix}${ext}`);
}

export interface WorkerDeps {
  config: Config;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
}

export async function processJob(job: Job, deps: WorkerDeps): Promise<void> {
  const { config, filesRepo, jobsRepo } = deps;
  const preset = config.presets.find((p) => p.id === job.presetId);
  if (!preset) {
    jobsRepo.markFailed(job.id, `Unknown preset "${job.presetId}"`);
    return;
  }

  jobsRepo.markRunning(job.id);

  const tempOutputPath = buildTempOutputPath(job.filePath, config.queue.tempSuffix);

  let originalProbe;
  try {
    originalProbe = await probeFile(job.filePath);
  } catch (err) {
    jobsRepo.markFailed(job.id, `Failed to probe source file: ${(err as Error).message}`);
    return;
  }

  try {
    await runTranscodeWithFallback(
      job.filePath,
      tempOutputPath,
      preset,
      originalProbe.durationSeconds,
      (percent) => jobsRepo.markProgress(job.id, percent),
    );
  } catch (err) {
    cleanupTemp(tempOutputPath);
    jobsRepo.markFailed(job.id, `Transcode failed: ${(err as Error).message}`);
    return;
  }

  const verifyResult = await verifyOutput(originalProbe, tempOutputPath);
  if (!verifyResult.ok) {
    cleanupTemp(tempOutputPath);
    jobsRepo.markFailed(job.id, `Verification failed: ${verifyResult.reason}`);
    return;
  }

  const newSizeBytes = statSync(tempOutputPath).size;
  replaceOriginal(job.filePath, tempOutputPath);

  filesRepo.upsertFile({
    path: job.filePath,
    libraryId: filesRepo.getFileByPath(job.filePath)?.libraryId ?? "unknown",
    codec: preset.targetCodec,
    container: preset.targetContainer,
    sizeBytes: newSizeBytes,
    durationSeconds: originalProbe.durationSeconds,
    needsTranscode: false,
    skipReason: "already target codec",
  });

  jobsRepo.markDone(job.id, newSizeBytes);

  const finishedJob = jobsRepo.getById(job.id)!;
  await runPostJobHooks(finishedJob, config);
}
