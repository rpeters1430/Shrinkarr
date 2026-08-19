import { spawn } from "node:child_process";
import { buildFfmpegArgs } from "./ffmpegArgs.js";
import { resolveEncoderForPreset } from "./hardware.js";
import type { Preset } from "../config/schema.js";

const STDERR_TAIL_CHARS = 4000;

export interface ProgressInfo {
  percent: number;
  fps?: number;
  speed?: string;
  bitrate?: string;
}

export function runTranscode(
  args: string[],
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];
    const proc = spawn("ffmpeg", fullArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    let progressBuffer = "";
    let currentFps: number | undefined;
    let currentSpeed: string | undefined;
    let currentBitrate: string | undefined;

    proc.stdout.on("data", (chunk: Buffer) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const [key, value] = line.split("=");
        if (!key || !value) continue;

        if (key === "fps") {
          currentFps = parseFloat(value.trim()) || undefined;
        } else if (key === "speed") {
          currentSpeed = value.trim();
        } else if (key === "bitrate") {
          currentBitrate = value.trim();
        } else if (key === "out_time_ms" && sourceDurationSeconds > 0) {
          // ffmpeg's "out_time_ms" field is in microseconds
          const elapsedSeconds = parseInt(value, 10) / 1_000_000;
          const percent = Math.min(100, Math.max(0, (elapsedSeconds / sourceDurationSeconds) * 100));
          if (!Number.isNaN(percent)) {
            onProgress({
              percent: Math.round(percent * 10) / 10,
              fps: currentFps,
              speed: currentSpeed,
              bitrate: currentBitrate,
            });
          }
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail}`));
        return;
      }
      onProgress({ percent: 100, speed: "1.0x" });
      resolve();
    });
  });
}

function isSubtitleError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("subtitle") ||
    lower.includes("mov_text") ||
    lower.includes("subrip") ||
    lower.includes("pgssub") ||
    lower.includes("hdmv_pgs") ||
    lower.includes("sost") ||
    lower.includes("incorrect codec parameters")
  );
}

export async function runTranscodeWithFallback(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
): Promise<{ usedHwaccel: boolean; encoderUsed: string }> {
  const resolved = await resolveEncoderForPreset(preset.targetCodec, preset.hwaccel);

  // Attempt 1: Hardware acceleration with full stream mapping
  if (resolved.hwaccelType !== "cpu") {
    try {
      const hwArgs = buildFfmpegArgs(inputPath, outputPath, preset, {
        resolvedEncoder: resolved.encoderId,
        resolvedHwaccelType: resolved.hwaccelType,
      });
      await runTranscode(hwArgs, sourceDurationSeconds, onProgress);
      return { usedHwaccel: true, encoderUsed: resolved.encoderId };
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn(`Hardware encoder "${resolved.encoderId}" failed for "${inputPath}": ${errMsg}`);

      // If failed due to a malformed or incompatible subtitle stream, retry hardware with -sn
      if (isSubtitleError(errMsg) && preset.subtitleMode !== "drop") {
        try {
          console.warn(`Retrying "${inputPath}" with hardware encoder without corrupted subtitle stream...`);
          const noSubPreset = { ...preset, subtitleMode: "drop" as const };
          const noSubArgs = buildFfmpegArgs(inputPath, outputPath, noSubPreset, {
            resolvedEncoder: resolved.encoderId,
            resolvedHwaccelType: resolved.hwaccelType,
          });
          await runTranscode(noSubArgs, sourceDurationSeconds, onProgress);
          return { usedHwaccel: true, encoderUsed: resolved.encoderId };
        } catch (subErr) {
          console.warn(`Subtitle fallback also failed: ${(subErr as Error).message}`);
        }
      }
    }
  }

  // Attempt 2: Fallback to CPU encoder
  const cpuPreset: Preset = { ...preset, hwaccel: "cpu" };
  const cpuResolved = await resolveEncoderForPreset(preset.targetCodec, "cpu");
  try {
    const cpuArgs = buildFfmpegArgs(inputPath, outputPath, cpuPreset, {
      resolvedEncoder: cpuResolved.encoderId,
      resolvedHwaccelType: "cpu",
    });
    await runTranscode(cpuArgs, sourceDurationSeconds, onProgress);
    return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
  } catch (cpuErr) {
    const cpuErrMsg = (cpuErr as Error).message;
    // Attempt 3: CPU with clean subtitle fallback if subtitle corruption caused the CPU failure
    if (isSubtitleError(cpuErrMsg) && preset.subtitleMode !== "drop") {
      console.warn(`Retrying "${inputPath}" on CPU without corrupted subtitle stream...`);
      const noSubCpuPreset = { ...cpuPreset, subtitleMode: "drop" as const };
      const noSubCpuArgs = buildFfmpegArgs(inputPath, outputPath, noSubCpuPreset, {
        resolvedEncoder: cpuResolved.encoderId,
        resolvedHwaccelType: "cpu",
      });
      await runTranscode(noSubCpuArgs, sourceDurationSeconds, onProgress);
      return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
    }
    throw cpuErr;
  }
}
