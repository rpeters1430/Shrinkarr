import { spawn } from "node:child_process";
import type { FfprobeOutput, MediaProbe } from "./types.js";

export function parseFfprobeOutput(raw: FfprobeOutput): MediaProbe {
  const videoStream = raw.streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new Error("ffprobe output has no video stream");
  }
  const audioStream = raw.streams.find((s) => s.codec_type === "audio");

  return {
    durationSeconds: raw.format.duration ? parseFloat(raw.format.duration) : 0,
    sizeBytes: raw.format.size ? parseInt(raw.format.size, 10) : 0,
    videoCodec: videoStream.codec_name,
    container: raw.format.format_name?.split(",")[0] ?? "unknown",
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    audioCodec: audioStream?.codec_name ?? "none",
  };
}

export function probeFile(path: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path];
    const proc = spawn("ffprobe", args);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffprobe for "${path}": ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code} for "${path}": ${stderr}`));
        return;
      }
      try {
        const raw = JSON.parse(stdout) as FfprobeOutput;
        resolve(parseFfprobeOutput(raw));
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output for "${path}": ${(err as Error).message}`));
      }
    });
  });
}
