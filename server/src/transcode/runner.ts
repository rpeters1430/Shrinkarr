import { spawn } from "node:child_process";
import os from "node:os";
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

export interface TranscodeRunnerOptions {
  lowPriority?: boolean;
  threads?: number;
}

function attachProcessListeners(
  proc: ReturnType<typeof spawn>,
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  let stderrTail = "";
  let progressBuffer = "";
  let currentFps: number | undefined;
  let currentSpeed: string | undefined;
  let currentBitrate: string | undefined;

  proc.stdout?.on("data", (chunk: Buffer) => {
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
          try {
            onProgress({
              percent: Math.round(percent * 10) / 10,
              fps: currentFps,
              speed: currentSpeed,
              bitrate: currentBitrate,
            });
          } catch (err) {
            // Non-fatal telemetry callback error
          }
        }
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail}`));
      return;
    }
    try {
      onProgress({ percent: 100, speed: "1.0x" });
    } catch {
      // Non-fatal telemetry callback error
    }
    resolve();
  });
}

export function runTranscode(
  args: string[],
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
  options: TranscodeRunnerOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const lowPriority = options.lowPriority !== false;
    const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];

    let cmd = "ffmpeg";
    let spawnArgs = fullArgs;

    if (lowPriority && process.platform === "linux") {
      cmd = "nice";
      spawnArgs = ["-n", "19", "ionice", "-c", "2", "-n", "7", "ffmpeg", ...fullArgs];
    } else if (lowPriority && process.platform === "darwin") {
      cmd = "nice";
      spawnArgs = ["-n", "19", "ffmpeg", ...fullArgs];
    }

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, spawnArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (lowPriority && proc.pid) {
        try {
          os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // ignore priority adjustments
        }
      }
    } catch {
      proc = spawn("ffmpeg", fullArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (lowPriority && proc.pid) {
        try {
          os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // ignore priority adjustments
        }
      }
      attachProcessListeners(proc, sourceDurationSeconds, onProgress, resolve, reject);
      return;
    }

    let handledFallback = false;
    proc.on("error", (err) => {
      if (!handledFallback && cmd !== "ffmpeg") {
        handledFallback = true;
        try {
          const fallbackProc = spawn("ffmpeg", fullArgs, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (lowPriority && fallbackProc.pid) {
            try {
              os.setPriority(fallbackProc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
            } catch {
              // ignore priority adjustments
            }
          }
          attachProcessListeners(fallbackProc, sourceDurationSeconds, onProgress, resolve, reject);
          return;
        } catch (fbErr) {
          reject(new Error(`Failed to spawn ffmpeg fallback: ${(fbErr as Error).message}`));
          return;
        }
      }
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    attachProcessListeners(proc, sourceDurationSeconds, onProgress, resolve, reject);
  });
}

function isStreamIncompatibleError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("subtitle") ||
    lower.includes("mov_text") ||
    lower.includes("subrip") ||
    lower.includes("pgssub") ||
    lower.includes("hdmv_pgs") ||
    lower.includes("sost") ||
    lower.includes("tag for codec") ||
    lower.includes("not supported in container") ||
    lower.includes("not supported by") ||
    lower.includes("matroska") ||
    lower.includes("mp4") ||
    lower.includes("codec parameters") ||
    lower.includes("opening encoder for output stream") ||
    lower.includes("error initializing output stream") ||
    lower.includes("invalid argument") ||
    lower.includes("not valid")
  );
}

export async function runTranscodeWithFallback(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
  runnerOptions: TranscodeRunnerOptions = {},
): Promise<{ usedHwaccel: boolean; encoderUsed: string }> {
  const resolved = await resolveEncoderForPreset(preset.targetCodec, preset.hwaccel);

  // Attempt 1: Hardware acceleration with full stream mapping
  if (resolved.hwaccelType !== "cpu") {
    try {
      const hwArgs = buildFfmpegArgs(inputPath, outputPath, preset, {
        resolvedEncoder: resolved.encoderId,
        resolvedHwaccelType: resolved.hwaccelType,
        devicePath: resolved.devicePath,
        threads: runnerOptions.threads,
      });
      await runTranscode(hwArgs, sourceDurationSeconds, onProgress, runnerOptions);
      return { usedHwaccel: true, encoderUsed: resolved.encoderId };
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn(`Hardware encoder "${resolved.encoderId}" failed for "${inputPath}": ${errMsg}`);

      // If failed due to a stream or subtitle incompatibility, retry hardware with sanitized streams (-sn)
      if (isStreamIncompatibleError(errMsg) && preset.subtitleMode !== "drop") {
        try {
          console.warn(`Retrying "${inputPath}" with hardware encoder without incompatible subtitle streams...`);
          const cleanPreset: Preset = { ...preset, subtitleMode: "drop" as const };
          const retryArgs = buildFfmpegArgs(inputPath, outputPath, cleanPreset, {
            resolvedEncoder: resolved.encoderId,
            resolvedHwaccelType: resolved.hwaccelType,
            devicePath: resolved.devicePath,
            threads: runnerOptions.threads,
          });
          await runTranscode(retryArgs, sourceDurationSeconds, onProgress, runnerOptions);
          return { usedHwaccel: true, encoderUsed: resolved.encoderId };
        } catch (subErr) {
          console.warn(`Stream fallback with hardware encoder also failed: ${(subErr as Error).message}`);
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
      threads: runnerOptions.threads,
    });
    await runTranscode(cpuArgs, sourceDurationSeconds, onProgress, runnerOptions);
    return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
  } catch (cpuErr) {
    const cpuErrMsg = (cpuErr as Error).message;
    // Attempt 3: CPU with sanitized stream fallback if subtitle or container incompatibility caused the CPU failure
    if (isStreamIncompatibleError(cpuErrMsg) && preset.subtitleMode !== "drop") {
      console.warn(`Retrying "${inputPath}" on CPU without incompatible subtitle streams...`);
      const noSubCpuPreset: Preset = { ...cpuPreset, subtitleMode: "drop" as const };
      const noSubCpuArgs = buildFfmpegArgs(inputPath, outputPath, noSubCpuPreset, {
        resolvedEncoder: cpuResolved.encoderId,
        resolvedHwaccelType: "cpu",
        threads: runnerOptions.threads,
      });
      await runTranscode(noSubCpuArgs, sourceDurationSeconds, onProgress, runnerOptions);
      return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
    }
    throw cpuErr;
  }
}
