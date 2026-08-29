import { extname } from "node:path";
import type { Preset } from "../config/schema.js";

export interface FfmpegOptions {
  resolvedEncoder?: string;
  resolvedHwaccelType?: string;
  devicePath?: string;
  startTimeSeconds?: number;
  durationSeconds?: number;
  isHdr?: boolean;
  colorTransfer?: string;
  threads?: number;
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  options: FfmpegOptions = {},
): string[] {
  const args: string[] = [];

  if (options.threads !== undefined && options.threads > 0) {
    args.push("-threads", String(options.threads));
  }

  const encoder = options.resolvedEncoder || (
    preset.hwaccel === "cpu"
      ? (preset.targetCodec === "hevc" ? "libx265" : preset.targetCodec === "av1" ? "libsvtav1" : "libx264")
      : preset.hwaccel === "amf"
        ? (preset.targetCodec === "hevc" ? "hevc_amf" : preset.targetCodec === "av1" ? "av1_amf" : "h264_amf")
        : preset.hwaccel === "qsv"
          ? (preset.targetCodec === "hevc" ? "hevc_qsv" : preset.targetCodec === "av1" ? "av1_qsv" : "h264_qsv")
          : preset.hwaccel === "nvenc"
            ? (preset.targetCodec === "hevc" ? "hevc_nvenc" : preset.targetCodec === "av1" ? "av1_nvenc" : "h264_nvenc")
            : preset.hwaccel === "vaapi"
              ? (preset.targetCodec === "hevc" ? "hevc_vaapi" : preset.targetCodec === "av1" ? "av1_vaapi" : "h264_vaapi")
              : (preset.targetCodec === "hevc" ? "libx265" : preset.targetCodec === "av1" ? "libsvtav1" : "libx264")
  );

  // Fast seeking before input if simulating a sample
  if (options.startTimeSeconds !== undefined && options.startTimeSeconds > 0) {
    args.push("-ss", options.startTimeSeconds.toFixed(2));
  }

  // VAAPI hardware device initialization if VAAPI is explicitly used
  if (encoder.includes("vaapi")) {
    const dev = options.devicePath || "/dev/dri/renderD128";
    args.push("-vaapi_device", dev);
  }

  // Input
  args.push("-i", inputPath);

  // Duration limit for sample simulations
  if (options.durationSeconds !== undefined && options.durationSeconds > 0) {
    args.push("-t", options.durationSeconds.toFixed(2));
  }

  // Stream mapping: map primary video, all audio, all subtitles (or drop if drop mode), drop incompatible data streams
  if (preset.subtitleMode === "drop") {
    args.push("-map", "0:v:0", "-map", "0:a?", "-sn", "-dn");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-dn");
  }

  // Video Codec & Quality flags
  args.push("-c:v", encoder);

  const crf = preset.crf || 24;

  if (encoder === "hevc_amf") {
    args.push("-rc", "cqp", "-qp_p", String(crf), "-qp_i", String(crf), "-quality", "quality");
    if (preset.bitDepth === 10) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-profile:v", "main", "-pix_fmt", "yuv420p");
    }
  } else if (encoder === "h264_amf") {
    args.push("-rc", "cqp", "-qp_p", String(crf), "-qp_i", String(crf), "-quality", "quality", "-pix_fmt", "yuv420p");
  } else if (encoder === "av1_amf") {
    args.push("-rc", "cqp", "-qp_p", String(crf), "-qp_i", String(crf), "-quality", "quality");
  } else if (encoder === "hevc_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium");
    if (preset.bitDepth === 10) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder === "h264_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium", "-pix_fmt", "nv12");
  } else if (encoder === "av1_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium");
  } else if (encoder === "hevc_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
    if (preset.bitDepth === 10) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
  } else if (encoder === "h264_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq", "-pix_fmt", "yuv420p");
  } else if (encoder === "av1_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
  } else if (encoder.includes("vaapi")) {
    const vfFormat = preset.bitDepth === 10 ? "format=p010|vaapi,hwupload" : "format=nv12|vaapi,hwupload";
    args.push("-vf", vfFormat, "-qp", String(crf));
  } else if (encoder === "hevc_videotoolbox" || encoder === "h264_videotoolbox") {
    args.push("-q:v", String(Math.max(1, Math.min(100, Math.round((51 - crf) * 2)))));
  } else if (encoder === "libsvtav1") {
    args.push("-crf", String(crf), "-preset", "6");
    if (preset.bitDepth === 10) {
      args.push("-pix_fmt", "yuv420p10le");
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
  } else if (encoder === "libx265") {
    args.push("-crf", String(crf), "-preset", "medium");
    if (preset.bitDepth === 10) {
      args.push("-pix_fmt", "yuv420p10le");
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
  } else if (encoder === "libx264") {
    args.push("-crf", String(crf), "-preset", "medium", "-pix_fmt", "yuv420p");
  }

  // HDR10 / HLG Metadata Preservation (e.g. 4K HDR Remuxes and Web-DLs)
  if (preset.preserveHdr && options.isHdr) {
    const transfer = (options.colorTransfer ?? "").toLowerCase();
    if (transfer.includes("arib-std-b67")) {
      // HLG
      args.push("-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc");
    } else {
      // HDR10 default
      args.push("-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc");
    }
  }

  // Audio configuration
  if (preset.audioMode === "aac") {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else if (preset.audioMode === "ac3") {
    args.push("-c:a", "ac3", "-b:a", "448k");
  } else {
    args.push("-c:a", "copy");
  }

  // Subtitle configuration:
  if (preset.subtitleMode !== "drop") {
    const inputExt = extname(inputPath).toLowerCase();
    const isMp4Input = inputExt === ".mp4" || inputExt === ".m4v" || inputExt === ".mov";

    if (preset.targetContainer === "mp4") {
      args.push("-c:s", "mov_text");
    } else if (isMp4Input) {
      args.push("-c:s", "srt");
    } else {
      args.push("-c:s", "copy");
    }
  }

  // MP4 faststart for web / streaming compatibility
  if (preset.targetContainer === "mp4") {
    args.push("-movflags", "+faststart");
  }

  // Always overwrite output
  args.push("-y", outputPath);

  return args;
}
