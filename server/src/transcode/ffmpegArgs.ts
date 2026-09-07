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
  bitDepth?: number;
  threads?: number;
  sourceBitrateKbps?: number;
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
  const is10Bit = options.bitDepth === 10
    || (options.bitDepth === undefined && preset.bitDepth === 10)
    || (options.isHdr === true && preset.preserveHdr);

  const hasLowSourceBitrate = options.sourceBitrateKbps !== undefined && options.sourceBitrateKbps > 0 && options.sourceBitrateKbps <= 4500;
  const sourceBitrate = options.sourceBitrateKbps && options.sourceBitrateKbps > 0 ? options.sourceBitrateKbps : undefined;

  if (encoder === "hevc_amf") {
    if (hasLowSourceBitrate) {
      // For low/medium-bitrate inputs (e.g. webcam streams, clips), unconstrained CQP bloats due to sensor noise.
      // Use peak-constrained VBR with bitrate limits proportional to input to guarantee compression.
      const targetBitrate = Math.max(400, Math.round(sourceBitrate! * 0.65));
      const maxBitrate = Math.max(500, Math.round(sourceBitrate! * 0.82));
      args.push("-usage", "transcoding", "-rc", "vbr_peak", "-b:v", `${targetBitrate}k`, "-maxrate", `${maxBitrate}k`, "-quality", "balanced");
    } else {
      args.push("-usage", "transcoding", "-rc", "cqp", "-qp_p", String(crf), "-qp_i", String(crf), "-quality", "balanced");
    }
    if (is10Bit) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-profile:v", "main", "-pix_fmt", "nv12");
    }
  } else if (encoder === "h264_amf") {
    if (hasLowSourceBitrate) {
      const targetBitrate = Math.max(500, Math.round(sourceBitrate! * 0.75));
      const maxBitrate = Math.max(600, Math.round(sourceBitrate! * 0.90));
      args.push("-usage", "transcoding", "-rc", "vbr_peak", "-b:v", `${targetBitrate}k`, "-maxrate", `${maxBitrate}k`, "-quality", "balanced", "-profile:v", "high", "-pix_fmt", "nv12");
    } else {
      args.push("-usage", "transcoding", "-rc", "cqp", "-qp_p", String(crf), "-qp_i", String(crf), "-quality", "balanced", "-profile:v", "high", "-pix_fmt", "nv12");
    }
  } else if (encoder === "av1_amf") {
    // AMF AV1 uses a 0-255 QP scale rather than standard 0-51 CRF.
    // Map standard CRF (0-51) to AMF AV1 range (roughly * 4.5).
    let av1Qp = Math.min(255, Math.max(0, Math.round(crf * 4.5)));
    if (hasLowSourceBitrate) {
      av1Qp = Math.max(av1Qp, 130);
    }
    args.push("-usage", "transcoding", "-rc", "cqp", "-qp_p", String(av1Qp), "-qp_i", String(av1Qp), "-quality", "balanced");
    if (is10Bit) {
      args.push("-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder === "hevc_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.7)}k`);
    }
    if (is10Bit) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder === "h264_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium", "-pix_fmt", "nv12");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.90)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.8)}k`);
    }
  } else if (encoder === "av1_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.75)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.5)}k`);
    }
    if (is10Bit) {
      args.push("-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder === "hevc_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.7)}k`);
    }
    if (is10Bit) {
      args.push("-profile:v", "main10", "-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder === "h264_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq", "-pix_fmt", "nv12");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.90)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.8)}k`);
    }
  } else if (encoder === "av1_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.75)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.5)}k`);
    }
    if (is10Bit) {
      args.push("-pix_fmt", "p010le");
    } else {
      args.push("-pix_fmt", "nv12");
    }
  } else if (encoder.includes("vaapi")) {
    const vfFormat = is10Bit ? "format=p010|vaapi,hwupload" : "format=nv12|vaapi,hwupload";
    args.push("-vf", vfFormat, "-qp", String(crf));
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`);
    }
  } else if (encoder === "hevc_videotoolbox" || encoder === "h264_videotoolbox") {
    args.push("-q:v", String(Math.max(1, Math.min(100, Math.round((51 - crf) * 2)))));
  } else if (encoder === "libsvtav1") {
    args.push("-crf", String(crf), "-preset", "6");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.75)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.5)}k`);
    }
    if (is10Bit) {
      args.push("-pix_fmt", "yuv420p10le");
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
  } else if (encoder === "libx265") {
    args.push("-crf", String(crf), "-preset", "medium");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.7)}k`);
    }
    if (is10Bit) {
      args.push("-pix_fmt", "yuv420p10le");
    } else {
      args.push("-pix_fmt", "yuv420p");
    }
  } else if (encoder === "libx264") {
    args.push("-crf", String(crf), "-preset", "medium", "-pix_fmt", "yuv420p");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.90)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.8)}k`);
    }
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
