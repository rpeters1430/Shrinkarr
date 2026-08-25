import { unlinkSync, statSync, existsSync } from "node:fs";
import { dirname, join, basename, extname } from "node:path";
import type { Preset } from "../config/schema.js";
import { probeFile } from "../media/ffprobe.js";
import { buildFfmpegArgs } from "./ffmpegArgs.js";
import { resolveEncoderForPreset } from "./hardware.js";
import { runTranscode } from "./runner.js";

export interface SimulationResult {
  filePath: string;
  sourceCodec: string;
  sourceResolution: string;
  originalSizeBytes: number;
  originalSampleSizeBytes: number;
  encodedSampleSizeBytes: number;
  sampleDurationSeconds: number;
  compressionRatio: number;
  measuredSavingsPercent: number;
  estimatedNewSizeBytes: number;
  estimatedSavingsBytes: number;
  encoderUsed: string;
  durationMs: number;
}

export async function simulateSavings(
  filePath: string,
  preset: Preset,
  sampleDurationSeconds = 30,
): Promise<SimulationResult> {
  const probe = await probeFile(filePath);
  const totalDuration = probe.durationSeconds;

  // Pick a position at 30% into the file
  const startTimeSeconds = totalDuration > sampleDurationSeconds * 2
    ? Math.floor(totalDuration * 0.3)
    : 0;

  const dir = dirname(filePath);
  const base = basename(filePath, extname(filePath));
  const ext = preset.targetContainer ? `.${preset.targetContainer}` : ".mkv";
  const tempSimPath = join(dir, `${base}.sim-${Date.now()}${ext}`);

  const resolved = await resolveEncoderForPreset(preset.targetCodec, preset.hwaccel);
  const args = buildFfmpegArgs(filePath, tempSimPath, preset, {
    resolvedEncoder: resolved.encoderId,
    resolvedHwaccelType: resolved.hwaccelType,
    devicePath: resolved.devicePath,
    startTimeSeconds,
    durationSeconds: sampleDurationSeconds,
  });

  const startTime = Date.now();
  try {
    await runTranscode(args, sampleDurationSeconds, () => {});
    const elapsedMs = Date.now() - startTime;

    if (!existsSync(tempSimPath)) {
      throw new Error("Simulation sample file was not created");
    }

    const encodedSampleSizeBytes = statSync(tempSimPath).size;
    // Calculate approximate original sample size based on average bitrate
    const originalSampleSizeBytes = probe.bitrateKbps > 0
      ? Math.round((probe.bitrateKbps * 1000 * sampleDurationSeconds) / 8)
      : Math.round((probe.sizeBytes / totalDuration) * sampleDurationSeconds);

    const compressionRatio = originalSampleSizeBytes > 0
      ? encodedSampleSizeBytes / originalSampleSizeBytes
      : 0.6;

    const measuredSavingsPercent = Math.max(0, Math.min(95, Math.round((1 - compressionRatio) * 100)));
    const estimatedNewSizeBytes = Math.round(probe.sizeBytes * Math.min(1, compressionRatio));
    const estimatedSavingsBytes = Math.max(0, probe.sizeBytes - estimatedNewSizeBytes);

    return {
      filePath,
      sourceCodec: probe.videoCodec,
      sourceResolution: probe.resolutionLabel,
      originalSizeBytes: probe.sizeBytes,
      originalSampleSizeBytes,
      encodedSampleSizeBytes,
      sampleDurationSeconds,
      compressionRatio: Math.round(compressionRatio * 100) / 100,
      measuredSavingsPercent,
      estimatedNewSizeBytes,
      estimatedSavingsBytes,
      encoderUsed: resolved.encoderId,
      durationMs: elapsedMs,
    };
  } finally {
    if (existsSync(tempSimPath)) {
      try {
        unlinkSync(tempSimPath);
      } catch {
        // best-effort cleanup of the sample file
      }
    }
  }
}
