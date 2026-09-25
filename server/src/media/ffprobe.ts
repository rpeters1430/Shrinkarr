import { spawn } from "node:child_process";
import type { FfprobeOutput, MediaProbe } from "./types.js";

// Codecs that store audio without quality loss. A source using one of these is a
// good transcode candidate (real space savings for a real quality trade); a source
// already on a lossy codec (mp3, aac, opus...) is not, since re-encoding it again
// only compounds generation loss for little or no size benefit.
export const LOSSLESS_AUDIO_CODECS = new Set([
  "flac",
  "alac",
  "wavpack",
  "tta",
  "ape",
  "mlp",
  "truehd",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s24be",
  "pcm_s32le",
  "pcm_s32be",
  "pcm_f32le",
  "pcm_f64le",
]);

function getResolutionLabel(width: number, height: number): "4K" | "1440p" | "1080p" | "720p" | "480p" | "SD" {
  const maxDim = Math.max(width, height);
  if (maxDim >= 3600 || (width >= 2800 && height >= 1500)) return "4K";
  if (maxDim >= 2400 || (width >= 2400 && height >= 1300)) return "1440p";
  if (maxDim >= 1800 || height >= 900) return "1080p";
  if (maxDim >= 1200 || height >= 650) return "720p";
  if (maxDim >= 700 || height >= 400) return "480p";
  return "SD";
}

function parseFps(rateStr?: string): number {
  if (!rateStr) return 24;
  if (rateStr.includes("/")) {
    const [num, den] = rateStr.split("/").map(Number);
    if (den && den > 0) return Math.round((num / den) * 100) / 100;
  }
  const parsed = parseFloat(rateStr);
  return Number.isNaN(parsed) ? 24 : Math.round(parsed * 100) / 100;
}

export function parseFfprobeOutput(raw: FfprobeOutput): MediaProbe {
  const videoStream =
    raw.streams.find((s) => s.codec_type === "video" && (!s.disposition || !s.disposition.attached_pic)) ??
    raw.streams.find((s) => s.codec_type === "video");
  const audioStreams = raw.streams.filter((s) => s.codec_type === "audio");
  const primaryAudio = audioStreams[0];
  const subtitleStreams = raw.streams.filter((s) => s.codec_type === "subtitle");

  const durationSeconds = raw.format.duration ? parseFloat(raw.format.duration) : 0;
  const sizeBytes = raw.format.size ? parseInt(raw.format.size, 10) : 0;

  if (!videoStream) {
    if (!primaryAudio) {
      throw new Error("ffprobe output has no video or audio stream");
    }

    let audioBitrateKbps = 0;
    if (raw.format.bit_rate) {
      audioBitrateKbps = Math.round(parseInt(raw.format.bit_rate, 10) / 1000);
    } else if (primaryAudio.bit_rate) {
      audioBitrateKbps = Math.round(parseInt(primaryAudio.bit_rate, 10) / 1000);
    } else if (durationSeconds > 0 && sizeBytes > 0) {
      audioBitrateKbps = Math.round((sizeBytes * 8) / (durationSeconds * 1000));
    }

    const audioCodec = primaryAudio.codec_name.toLowerCase();

    return {
      mediaKind: "audio",
      durationSeconds,
      sizeBytes,
      videoCodec: "none",
      container: raw.format.format_name?.split(",")[0] ?? "unknown",
      width: 0,
      height: 0,
      resolutionLabel: "SD",
      bitrateKbps: audioBitrateKbps,
      bitDepth: 8,
      isHdr: false,
      fps: 0,
      audioCodec,
      audioChannels: primaryAudio.channels ?? 2,
      subtitleCount: 0,
      isLosslessAudio: LOSSLESS_AUDIO_CODECS.has(audioCodec),
    };
  }

  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;

  let bitrateKbps = 0;
  if (raw.format.bit_rate) {
    bitrateKbps = Math.round(parseInt(raw.format.bit_rate, 10) / 1000);
  } else if (durationSeconds > 0 && sizeBytes > 0) {
    bitrateKbps = Math.round((sizeBytes * 8) / (durationSeconds * 1000));
  }

  // Bit depth check (10-bit if pix_fmt contains 10 or bits_per_raw_sample is 10)
  let bitDepth: 8 | 10 | 12 = 8;
  const pixFmt = (videoStream.pix_fmt ?? "").toLowerCase();
  const rawBits = videoStream.bits_per_raw_sample;
  if (pixFmt.includes("12") || rawBits === "12") {
    bitDepth = 12;
  } else if (pixFmt.includes("10") || rawBits === "10" || (videoStream.profile ?? "").toLowerCase().includes("10")) {
    bitDepth = 10;
  }

  // HDR check
  const transfer = (videoStream.color_transfer ?? "").toLowerCase();
  const isHdr = transfer.includes("smpte2084") || transfer.includes("arib-std-b67") || transfer.includes("hdr");

  return {
    mediaKind: "video",
    durationSeconds,
    sizeBytes,
    videoCodec: videoStream.codec_name.toLowerCase(),
    container: raw.format.format_name?.split(",")[0] ?? "unknown",
    width,
    height,
    resolutionLabel: getResolutionLabel(width, height),
    bitrateKbps,
    bitDepth,
    isHdr,
    colorTransfer: videoStream.color_transfer,
    fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    audioCodec: primaryAudio?.codec_name ?? "none",
    audioChannels: primaryAudio?.channels ?? (primaryAudio ? 2 : 0),
    subtitleCount: subtitleStreams.length,
  };
}

class FfprobeTimeoutError extends Error {}

function runFfprobeOnce(path: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-probesize",
      "10M",
      "-analyzeduration",
      "10M",
      path,
    ];

    const proc = spawn("ffprobe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let completed = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process might already have exited
        }
        reject(new FfprobeTimeoutError(`ffprobe timed out after 25s for "${path}"`));
      }
    }, 25_000);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("error", (err) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ffprobe for "${path}": ${err.message}`));
      }
    });

    proc.on("close", (code) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code} for "${path}": ${stderr.trim()}`));
          return;
        }
        try {
          const raw = JSON.parse(stdout) as FfprobeOutput;
          resolve(parseFfprobeOutput(raw));
        } catch (err) {
          reject(new Error(`Failed to parse ffprobe output for "${path}": ${(err as Error).message}`));
        }
      }
    });
  });
}

export async function probeFile(path: string, retries = 2): Promise<MediaProbe> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await runFfprobeOnce(path);
    } catch (err) {
      lastErr = err as Error;
      // A file that hung once will hang again; retrying doubles the stall.
      if (err instanceof FfprobeTimeoutError) break;
      if (attempt < retries - 1) {
        await new Promise((res) => setTimeout(res, 150));
      }
    }
  }
  throw lastErr ?? new Error(`Failed to probe "${path}"`);
}
