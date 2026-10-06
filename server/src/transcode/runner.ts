import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import { buildFfmpegArgs } from "./ffmpegArgs.js";
import { explainMissingHardware, listAlternateHardwareEncoders, resolveEncoderForPreset } from "./hardware.js";
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
  signal?: AbortSignal;
  startTimeSeconds?: number;
  durationSeconds?: number;
  // fallbackReason is set when a hardware encoder was tried and failed, so the
  // job can show why it ended up on the CPU.
  onEncoderSelected?: (encoderId: string, mode: "gpu-full" | "gpu-encode" | "cpu", fallbackReason?: string) => void;
}

const activeFfmpegProcesses = new Set<ReturnType<typeof spawn>>();

const availableCommands = new Map<string, boolean>();

function commandExists(command: string): boolean {
  const cached = availableCommands.get(command);
  if (cached !== undefined) return cached;

  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        accessSync(join(directory, command), fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  availableCommands.set(command, found);
  return found;
}

function trackProcess(proc: ReturnType<typeof spawn>): void {
  activeFfmpegProcesses.add(proc);
  proc.on("close", () => activeFfmpegProcesses.delete(proc));
  proc.on("error", () => activeFfmpegProcesses.delete(proc));
}

export function killAllActiveTranscodes(): void {
  for (const proc of activeFfmpegProcesses) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may already have terminated
    }
  }
  activeFfmpegProcesses.clear();
}

try {
  process.on("exit", () => killAllActiveTranscodes());
} catch {
  // Not in a standard node environment
}

function attachProcessListeners(
  proc: ReturnType<typeof spawn>,
  sourceDurationSeconds: number,
  onProgress: (info: ProgressInfo) => void,
  resolve: () => void,
  reject: (err: Error) => void,
  signal?: AbortSignal,
): void {
  let stderrTail = "";
  let progressBuffer = "";
  let currentFps: number | undefined;
  let currentSpeed: string | undefined;
  let currentBitrate: string | undefined;

  const onAbort = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may already have terminated
    }
    reject(new Error("Transcode aborted"));
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

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
          } catch {
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
    if (signal) {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error("Transcode aborted"));
        return;
      }
    }
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
  if (options.signal?.aborted) {
    return Promise.reject(new Error("Transcode aborted"));
  }

  return new Promise((resolve, reject) => {
    const lowPriority = options.lowPriority !== false;
    const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];

    let cmd = "ffmpeg";
    let spawnArgs = fullArgs;

    if (lowPriority && process.platform === "linux" && commandExists("ionice") && commandExists("nice")) {
      cmd = "ionice";
      spawnArgs = ["-c", "2", "-n", "7", "nice", "-n", "19", "ffmpeg", ...fullArgs];
    } else if (lowPriority && process.platform === "linux" && commandExists("nice")) {
      cmd = "nice";
      spawnArgs = ["-n", "19", "ffmpeg", ...fullArgs];
    } else if (lowPriority && process.platform === "linux" && commandExists("ionice")) {
      cmd = "ionice";
      spawnArgs = ["-c", "2", "-n", "7", "ffmpeg", ...fullArgs];
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
      trackProcess(proc);
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
      trackProcess(proc);
      if (lowPriority && proc.pid) {
        try {
          os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // ignore priority adjustments
        }
      }
      attachProcessListeners(proc, sourceDurationSeconds, onProgress, resolve, reject, options.signal);
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
          trackProcess(fallbackProc);
          if (lowPriority && fallbackProc.pid) {
            try {
              os.setPriority(fallbackProc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
            } catch {
              // ignore priority adjustments
            }
          }
          attachProcessListeners(fallbackProc, sourceDurationSeconds, onProgress, resolve, reject, options.signal);
          return;
        } catch (fbErr) {
          reject(new Error(`Failed to spawn ffmpeg fallback: ${(fbErr as Error).message}`));
          return;
        }
      }
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    attachProcessListeners(proc, sourceDurationSeconds, onProgress, resolve, reject, options.signal);
  });
}

// ffmpeg's stderr tail is mostly banner and stream listing; the cause is
// almost always in the last couple of lines, so keep just those.
export function summarizeFfmpegError(message: string): string {
  const body = message.replace(/^ffmpeg exited with code -?\d+:\s*/, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(frame|size|progress|out_time|speed|bitrate)=/.test(line));
  const tail = lines.slice(-2).join(" | ");
  const summary = tail || message.split(/\r?\n/)[0] || "unknown error";
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
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
  probeContext?: {
    isHdr?: boolean;
    colorTransfer?: string;
    bitDepth?: number;
    sourceBitrateKbps?: number;
    audioCodec?: string;
    isLosslessAudio?: boolean;
    audioChannels?: number;
  },
): Promise<{ usedHwaccel: boolean; encoderUsed: string }> {
  if (runnerOptions.signal?.aborted) {
    throw new Error("Transcode aborted");
  }

  // Music presets skip the GPU/CPU encoder resolution and fallback dance below
  // entirely - audio encoding is cheap on any CPU and has no hardware encoder path.
  if (preset.mediaKind === "audio") {
    const encoderId = `audio:${preset.targetAudioCodec}`;
    try {
      runnerOptions.onEncoderSelected?.(encoderId, "cpu");
    } catch (err) {
      console.warn(`Non-fatal encoder telemetry callback error: ${(err as Error).message}`);
    }
    const args = buildFfmpegArgs(inputPath, outputPath, preset, {
      startTimeSeconds: runnerOptions.startTimeSeconds,
      durationSeconds: runnerOptions.durationSeconds,
    });
    await runTranscode(args, sourceDurationSeconds, onProgress, runnerOptions);
    return { usedHwaccel: false, encoderUsed: encoderId };
  }

  const resolved = await resolveEncoderForPreset(preset.targetCodec, preset.hwaccel);

  function reportEncoder(encoderId: string, mode: "gpu-full" | "gpu-encode" | "cpu", fallbackReason?: string): void {
    try {
      runnerOptions.onEncoderSelected?.(encoderId, mode, fallbackReason);
    } catch (err) {
      console.warn(`Non-fatal encoder telemetry callback error: ${(err as Error).message}`);
    }
  }

  type HardwareEncoder = { encoderId: string; hwaccelType: string; devicePath?: string };

  // Attempt 1: Hardware acceleration with full stream mapping. For VAAPI, NVENC, and QSV,
  // first try decoding *and* encoding on the GPU (hwDecode); if that fails (e.g. source
  // codec/profile isn't supported by hardware decoder), fall back to software decode + GPU encode.
  // Returns null on success, or the ffmpeg error that made this attempt fail.
  async function attemptHardwareEncode(enc: HardwareEncoder, hwDecode: boolean): Promise<string | null> {
    const hwOptions = (p: Preset) => buildFfmpegArgs(inputPath, outputPath, p, {
      resolvedEncoder: enc.encoderId,
      resolvedHwaccelType: enc.hwaccelType,
      devicePath: enc.devicePath,
      threads: runnerOptions.threads,
      isHdr: probeContext?.isHdr,
      colorTransfer: probeContext?.colorTransfer,
      bitDepth: probeContext?.bitDepth,
      sourceBitrateKbps: probeContext?.sourceBitrateKbps,
      audioCodec: probeContext?.audioCodec,
      isLosslessAudio: probeContext?.isLosslessAudio,
      audioChannels: probeContext?.audioChannels,
      hwDecode,
      startTimeSeconds: runnerOptions.startTimeSeconds,
      durationSeconds: runnerOptions.durationSeconds,
    });
    try {
      reportEncoder(enc.encoderId, hwDecode ? "gpu-full" : "gpu-encode");
      await runTranscode(hwOptions(preset), sourceDurationSeconds, onProgress, runnerOptions);
      return null;
    } catch (err) {
      if (runnerOptions.signal?.aborted) {
        throw err;
      }
      let errMsg = (err as Error).message;
      console.warn(`Hardware encoder "${enc.encoderId}"${hwDecode ? " (GPU decode)" : ""} failed for "${inputPath}": ${errMsg}`);

      // If failed due to a stream or subtitle incompatibility, retry hardware with sanitized streams (-sn)
      if (isStreamIncompatibleError(errMsg) && preset.subtitleMode !== "drop") {
        try {
          if (runnerOptions.signal?.aborted) throw err;
          console.warn(`Retrying "${inputPath}" with hardware encoder without incompatible subtitle streams...`);
          const cleanPreset: Preset = { ...preset, subtitleMode: "drop" as const };
          await runTranscode(hwOptions(cleanPreset), sourceDurationSeconds, onProgress, runnerOptions);
          return null;
        } catch (subErr) {
          if (runnerOptions.signal?.aborted) throw subErr;
          errMsg = (subErr as Error).message;
          console.warn(`Stream fallback with hardware encoder${hwDecode ? " (GPU decode)" : ""} also failed: ${errMsg}`);
        }
      }
      return errMsg;
    }
  }

  let lastHardwareError: string | undefined;
  if (resolved.hwaccelType === "cpu" && preset.hwaccel !== "cpu") {
    lastHardwareError = explainMissingHardware(preset.targetCodec);
  }
  if (resolved.hwaccelType !== "cpu") {
    const hardwareChain: HardwareEncoder[] = [
      resolved,
      ...(await listAlternateHardwareEncoders(preset.targetCodec, resolved)),
    ];
    for (const enc of hardwareChain) {
      if (enc !== resolved) {
        console.warn(`Retrying "${inputPath}" with alternate hardware encoder "${enc.encoderId}"${enc.devicePath ? ` on ${enc.devicePath}` : ""}...`);
      }
      const supportsHwDecode = enc.hwaccelType === "vaapi" || enc.hwaccelType === "nvenc" || enc.hwaccelType === "qsv";
      let failure = await attemptHardwareEncode(enc, supportsHwDecode);
      if (failure !== null && supportsHwDecode) {
        console.warn(`Retrying "${inputPath}" with software decode + ${enc.hwaccelType.toUpperCase()} hardware encode only...`);
        failure = await attemptHardwareEncode(enc, false);
      }
      if (failure === null) {
        return { usedHwaccel: true, encoderUsed: enc.encoderId };
      }
      lastHardwareError = `${enc.encoderId}: ${summarizeFfmpegError(failure)}`;
    }
  }

  if (runnerOptions.signal?.aborted) {
    throw new Error("Transcode aborted");
  }

  // Attempt 2: Fallback to CPU encoder
  const cpuPreset: Preset = { ...preset, hwaccel: "cpu" };
  const cpuResolved = await resolveEncoderForPreset(preset.targetCodec, "cpu");
  try {
    reportEncoder(cpuResolved.encoderId, "cpu", lastHardwareError);
    const cpuArgs = buildFfmpegArgs(inputPath, outputPath, cpuPreset, {
      resolvedEncoder: cpuResolved.encoderId,
      resolvedHwaccelType: "cpu",
      threads: runnerOptions.threads,
      isHdr: probeContext?.isHdr,
      colorTransfer: probeContext?.colorTransfer,
      bitDepth: probeContext?.bitDepth,
      sourceBitrateKbps: probeContext?.sourceBitrateKbps,
      startTimeSeconds: runnerOptions.startTimeSeconds,
      durationSeconds: runnerOptions.durationSeconds,
    });
    await runTranscode(cpuArgs, sourceDurationSeconds, onProgress, runnerOptions);
    return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
  } catch (cpuErr) {
    if (runnerOptions.signal?.aborted) {
      throw cpuErr;
    }
    const cpuErrMsg = (cpuErr as Error).message;
    // Attempt 3: CPU with sanitized stream fallback if subtitle or container incompatibility caused the CPU failure
    if (isStreamIncompatibleError(cpuErrMsg) && preset.subtitleMode !== "drop") {
      console.warn(`Retrying "${inputPath}" on CPU without incompatible subtitle streams...`);
      const noSubCpuPreset: Preset = { ...cpuPreset, subtitleMode: "drop" as const };
      const noSubCpuArgs = buildFfmpegArgs(inputPath, outputPath, noSubCpuPreset, {
        resolvedEncoder: cpuResolved.encoderId,
        resolvedHwaccelType: "cpu",
        threads: runnerOptions.threads,
        isHdr: probeContext?.isHdr,
        colorTransfer: probeContext?.colorTransfer,
        bitDepth: probeContext?.bitDepth,
        sourceBitrateKbps: probeContext?.sourceBitrateKbps,
        startTimeSeconds: runnerOptions.startTimeSeconds,
        durationSeconds: runnerOptions.durationSeconds,
      });
      await runTranscode(noSubCpuArgs, sourceDurationSeconds, onProgress, runnerOptions);
      return { usedHwaccel: false, encoderUsed: cpuResolved.encoderId };
    }
    throw cpuErr;
  }
}
