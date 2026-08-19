import { spawn } from "node:child_process";
import { buildFfmpegArgs } from "./ffmpegArgs.js";
import type { Preset } from "../config/schema.js";

const STDERR_TAIL_CHARS = 4000;

export function runTranscode(
  args: string[],
  sourceDurationSeconds: number,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];
    const proc = spawn("ffmpeg", fullArgs);

    let stderrTail = "";
    let progressBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_ms" && value && sourceDurationSeconds > 0) {
          // ffmpeg's "out_time_ms" field is actually microseconds.
          const elapsedSeconds = parseInt(value, 10) / 1_000_000;
          const percent = Math.min(100, (elapsedSeconds / sourceDurationSeconds) * 100);
          if (!Number.isNaN(percent)) {
            onProgress(percent);
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
      onProgress(100);
      resolve();
    });
  });
}

export async function runTranscodeWithFallback(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  sourceDurationSeconds: number,
  onProgress: (percent: number) => void,
): Promise<{ usedHwaccel: boolean }> {
  if (preset.hwaccel === "vaapi") {
    try {
      const args = buildFfmpegArgs(inputPath, outputPath, preset);
      await runTranscode(args, sourceDurationSeconds, onProgress);
      return { usedHwaccel: true };
    } catch (err) {
      console.warn(
        `VAAPI transcode failed for "${inputPath}", falling back to CPU: ${(err as Error).message}`,
      );
    }
  }

  const cpuPreset: Preset = { ...preset, hwaccel: "cpu" };
  const cpuArgs = buildFfmpegArgs(inputPath, outputPath, cpuPreset);
  await runTranscode(cpuArgs, sourceDurationSeconds, onProgress);
  return { usedHwaccel: false };
}
