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
  hwDecode?: boolean;
  audioCodec?: string;
  isLosslessAudio?: boolean;
  audioChannels?: number;
}

function audioEncoderFor(codec: Preset["targetAudioCodec"]): string {
  switch (codec) {
    case "opus":
      return "libopus";
    case "mp3":
      return "libmp3lame";
    case "flac":
      return "flac";
    default:
      return "aac";
  }
}

// Music files have no video stream to encode, no HDR metadata, and no hardware
// acceleration to pick between - just a straight audio re-encode. Kept separate
// from the video path below rather than threading `-vn`/audio-only branches
// through every encoder-specific case there.
export function buildAudioFfmpegArgs(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  options: Pick<FfmpegOptions, "startTimeSeconds" | "durationSeconds"> = {},
): string[] {
  const args: string[] = [];

  if (options.startTimeSeconds !== undefined && options.startTimeSeconds > 0) {
    args.push("-ss", options.startTimeSeconds.toFixed(2));
  }

  args.push("-i", inputPath);

  if (options.durationSeconds !== undefined && options.durationSeconds > 0) {
    args.push("-t", options.durationSeconds.toFixed(2));
  }

  // Audio only: drop any video (including embedded cover art, which most
  // target containers here can't carry as a stream) and subtitle/data streams.
  args.push("-map", "0:a:0", "-vn", "-sn", "-dn");
  args.push("-map_metadata", "0");

  const encoder = audioEncoderFor(preset.targetAudioCodec);
  args.push("-c:a", encoder);
  if (preset.targetAudioCodec !== "flac") {
    args.push("-b:a", `${preset.targetAudioBitrateKbps}k`);
  }

  args.push("-y", outputPath);
  return args;
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  preset: Preset,
  options: FfmpegOptions = {},
): string[] {
  if (preset.mediaKind === "audio") {
    return buildAudioFfmpegArgs(inputPath, outputPath, preset, options);
  }

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

  // Hardware decoding initialization
  if (encoder.includes("vaapi")) {
    const dev = options.devicePath || "/dev/dri/renderD128";
    if (options.hwDecode) {
      // Decode on the GPU too (not just encode): without this, ffmpeg decodes
      // and color-converts every frame on the CPU before handing it to the
      // encoder, which is the main reason "hardware accelerated" transcodes
      // still peg a weak NAS CPU. Keeping decode+encode both on the VAAPI
      // device avoids that round-trip through system memory entirely.
      args.push("-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-vaapi_device", dev);
    } else {
      args.push("-vaapi_device", dev);
    }
  } else if (encoder.includes("nvenc") && options.hwDecode) {
    args.push("-hwaccel", "cuda");
  } else if (encoder.includes("qsv") && options.hwDecode) {
    args.push("-hwaccel", "qsv");
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
  } else if (preset.targetContainer === "mkv") {
    args.push("-map", "0:v:0", "-map", "0:a?", "-map", "0:s?", "-map", "0:t?", "-dn");
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
    // With hwDecode, frames already arrive as VAAPI surfaces from the decoder,
    // so use scale_vaapi (a GPU-side format convert/no-op) instead of hwupload
    // (which is only for pushing system-memory frames onto the GPU).
    const vfFormat = options.hwDecode
      ? (is10Bit ? "scale_vaapi=format=p010" : "scale_vaapi=format=nv12")
      : (is10Bit ? "format=p010|vaapi,hwupload" : "format=nv12|vaapi,hwupload");
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

  // HDR10 / HLG Metadata Preservation or Tone Mapping
  if (options.isHdr) {
    if (preset.preserveHdr) {
      const transfer = (options.colorTransfer ?? "").toLowerCase();
      if (transfer.includes("arib-std-b67")) {
        // HLG
        args.push("-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc");
      } else {
        // HDR10 default
        args.push("-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc");
      }
    } else {
      // If preset disables HDR preservation on an HDR source (e.g. for SDR/universal compatibility),
      // apply tone mapping to prevent washed-out colors.
      const vfIndex = args.indexOf("-vf");
      if (vfIndex !== -1) {
        args[vfIndex + 1] = `${args[vfIndex + 1]},tonemap=hable,format=yuv420p`;
      } else {
        args.push("-vf", "tonemap=hable,format=yuv420p");
      }
      args.push("-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709");
    }
  }

  // Audio configuration
  if (preset.audioMode === "aac") {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else if (preset.audioMode === "ac3") {
    args.push("-c:a", "ac3", "-b:a", "448k");
  } else if (preset.audioMode === "smart") {
    // If source audio is lossless (TrueHD, DTS-HD MA, FLAC, PCM), re-encode to high-efficiency lossy audio
    // (saves 3-5 GB per movie). If already lossy (AAC, AC-3, Opus), copy as-is.
    if (options.isLosslessAudio) {
      if (options.audioChannels && options.audioChannels > 2) {
        args.push("-c:a", "aac", "-b:a", "384k");
      } else {
        args.push("-c:a", "aac", "-b:a", "192k");
      }
    } else {
      args.push("-c:a", "copy");
    }
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

    if (preset.targetContainer === "mkv") {
      args.push("-c:t", "copy");
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
