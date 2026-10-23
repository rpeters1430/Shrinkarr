import { extname } from "node:path";
import type { Preset } from "../config/schema.js";
import type { AudioTrack, SubtitleTrack } from "../media/types.js";
import { downscaleTarget, selectStreams } from "./streams.js";

export interface FfmpegOptions {
  resolvedEncoder?: string;
  resolvedHwaccelType?: string;
  devicePath?: string;
  lowPower?: boolean;
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
  // Per-track info from the probe. With it, tracks are mapped one by one so
  // the preset's language filter and stereo track apply; without it every
  // audio and subtitle track is mapped as before.
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
  sourceWidth?: number;
  sourceHeight?: number;
  // Remux: copy the video stream instead of encoding it.
  copyVideo?: boolean;
}

// Appends a filter to an existing -vf chain, or starts one.
function addVideoFilter(args: string[], filter: string, position: "start" | "end" = "end"): void {
  const vfIndex = args.indexOf("-vf");
  if (vfIndex === -1) {
    args.push("-vf", filter);
  } else {
    args[vfIndex + 1] = position === "start" ? `${filter},${args[vfIndex + 1]}` : `${args[vfIndex + 1]},${filter}`;
  }
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

  const copyVideo = options.copyVideo === true;
  const encoder = copyVideo ? "copy" : options.resolvedEncoder || (
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

  // HDR source on a preset that doesn't keep HDR: tone map down to SDR.
  const toneMap = options.isHdr === true && !preset.preserveHdr && !copyVideo;

  // QSV and NVENC can keep decoded frames on the GPU all the way into the
  // encoder. Without that, every frame is copied back to system memory and
  // pixel-format converted on the CPU, which costs nearly as much CPU as
  // decoding there. The software tone map below needs frames in system memory,
  // so HDR-to-SDR jobs still take the copy.
  const isNvenc = encoder.includes("nvenc");
  const isQsv = encoder.includes("qsv");
  const gpuFrames = options.hwDecode === true && !toneMap
    && (isNvenc || (isQsv && process.platform === "linux"));

  // With gpuFrames, the pixel format is set by a GPU-side scaler instead of
  // -pix_fmt, which would insert a software conversion the GPU frames can't
  // go through. QSV frames arrive as VAAPI surfaces (see below) and are mapped
  // across first.
  const pixFmtArgs = (format: string): string[] => {
    if (!gpuFrames) return ["-pix_fmt", format];
    return ["-vf", isNvenc
      ? `scale_cuda=format=${format}`
      : `hwmap=derive_device=qsv,format=qsv,scale_qsv=format=${format}`];
  };

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
  } else if (isNvenc && options.hwDecode) {
    args.push("-hwaccel", "cuda");
    if (gpuFrames) args.push("-hwaccel_output_format", "cuda");
  } else if (isQsv && options.hwDecode) {
    if (process.platform === "linux") {
      // "-hwaccel qsv" only decodes on the GPU when a *_qsv decoder is picked
      // by hand; with ffmpeg's default decoders it quietly decodes on the CPU.
      // Decode through VAAPI on the same iGPU instead, and map the surfaces
      // to QSV in the filter chain.
      const dev = options.devicePath || "/dev/dri/renderD128";
      if (gpuFrames) {
        args.push(
          "-init_hw_device", `vaapi=va:${dev}`,
          "-init_hw_device", "qsv=qs@va",
          "-filter_hw_device", "qs",
          "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi",
        );
      } else {
        args.push("-hwaccel", "vaapi", "-hwaccel_device", dev);
      }
    } else {
      args.push("-hwaccel", "qsv");
    }
  }

  // Input
  args.push("-i", inputPath);

  // Duration limit for sample simulations
  if (options.durationSeconds !== undefined && options.durationSeconds > 0) {
    args.push("-t", options.durationSeconds.toFixed(2));
  }

  // Stream mapping: primary video, then audio and subtitles, then MKV
  // attachments (fonts). Data streams are always dropped.
  const selection = options.audioTracks && options.subtitleTracks
    ? selectStreams({ audioTracks: options.audioTracks, subtitleTracks: options.subtitleTracks }, preset)
    : null;
  args.push("-map", "0:v:0");
  if (selection) {
    for (const track of selection.audio) args.push("-map", `0:${track.index}`);
    if (selection.stereoSource) args.push("-map", `0:${selection.stereoSource.index}`);
    for (const track of selection.subtitles) args.push("-map", `0:${track.index}`);
  } else {
    args.push("-map", "0:a?");
    if (preset.subtitleMode !== "drop") args.push("-map", "0:s?");
  }
  if (preset.subtitleMode === "drop" || (selection && selection.subtitles.length === 0)) {
    args.push("-sn");
  }
  if (preset.subtitleMode !== "drop" && preset.targetContainer === "mkv") {
    args.push("-map", "0:t?");
  }
  args.push("-dn");

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
      args.push("-profile:v", "main10", ...pixFmtArgs("p010le"));
    } else {
      args.push(...pixFmtArgs("nv12"));
    }
  } else if (encoder === "h264_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium", ...pixFmtArgs("nv12"));
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.90)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.8)}k`);
    }
  } else if (encoder === "av1_qsv") {
    args.push("-global_quality", String(crf), "-preset", "medium");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.75)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.5)}k`);
    }
    args.push(...pixFmtArgs(is10Bit ? "p010le" : "nv12"));
  } else if (encoder === "hevc_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.7)}k`);
    }
    if (is10Bit) {
      args.push("-profile:v", "main10", ...pixFmtArgs("p010le"));
    } else {
      args.push(...pixFmtArgs("nv12"));
    }
  } else if (encoder === "h264_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq", ...pixFmtArgs("nv12"));
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.90)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.8)}k`);
    }
  } else if (encoder === "av1_nvenc") {
    args.push("-cq", String(crf), "-preset", "p5", "-tune", "hq");
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.75)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.5)}k`);
    }
    args.push(...pixFmtArgs(is10Bit ? "p010le" : "nv12"));
  } else if (encoder.includes("vaapi")) {
    // With hwDecode, frames already arrive as VAAPI surfaces from the decoder,
    // so use scale_vaapi (a GPU-side format convert/no-op) instead of hwupload
    // (which is only for pushing system-memory frames onto the GPU).
    //
    // An HDR source going to SDR has to be tone mapped before the frames reach
    // the encoder. On GPU frames that's tonemap_vaapi; on system-memory frames
    // the software tonemap has to run ahead of hwupload, since it can't read a
    // VAAPI surface. Appending it after the upload (as the CPU path does) made
    // both GPU attempts fail and sent every HDR-to-SDR job to the CPU.
    const surfaceFormat = is10Bit && !toneMap ? "p010" : "nv12";
    const vfFormat = options.hwDecode
      ? (toneMap ? `tonemap_vaapi=format=${surfaceFormat}:t=bt709:m=bt709:p=bt709` : `scale_vaapi=format=${surfaceFormat}`)
      : `${toneMap ? "tonemap=hable,format=yuv420p," : ""}format=${surfaceFormat}|vaapi,hwupload`;
    args.push("-vf", vfFormat, "-qp", String(crf));
    if (sourceBitrate) {
      args.push("-maxrate", `${Math.round(sourceBitrate * 0.85)}k`, "-bufsize", `${Math.round(sourceBitrate * 1.7)}k`);
    }
    if (options.lowPower) {
      args.push("-low_power", "1");
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

  // Downscale. Frames that stay on the GPU have to be scaled there, by the
  // scaler already in the chain; everything else uses the software scaler
  // ahead of any upload.
  const scaleTo = copyVideo ? null : downscaleTarget(options.sourceWidth ?? 0, options.sourceHeight ?? 0, preset.maxResolution);
  if (scaleTo) {
    const vfIndex = args.indexOf("-vf");
    const gpuScaler = encoder.includes("vaapi") && options.hwDecode
      ? "scale_vaapi"
      : gpuFrames ? (isNvenc ? "scale_cuda" : "scale_qsv") : null;
    if (gpuScaler && vfIndex !== -1) {
      const chain = args[vfIndex + 1];
      args[vfIndex + 1] = chain.includes(`${gpuScaler}=`)
        ? chain.replace(`${gpuScaler}=`, `${gpuScaler}=w=${scaleTo.width}:h=${scaleTo.height}:`)
        : `${gpuScaler}=w=${scaleTo.width}:h=${scaleTo.height},${chain}`;
    } else {
      addVideoFilter(args, `scale=${scaleTo.width}:${scaleTo.height}`, "start");
    }
  }

  // HDR10 / HLG Metadata Preservation or Tone Mapping
  if (options.isHdr && !copyVideo) {
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
      // apply tone mapping to prevent washed-out colors. VAAPI already put
      // it in its filter chain above.
      if (!encoder.includes("vaapi")) addVideoFilter(args, "tonemap=hable,format=yuv420p");
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

  // The added stereo track is always the last audio output. ffmpeg applies
  // the most specific matching option, so these override the -c:a above.
  if (selection?.stereoSource) {
    const n = selection.audio.length;
    args.push(
      `-c:a:${n}`, "aac",
      `-b:a:${n}`, "192k",
      `-ac:a:${n}`, "2",
      `-metadata:s:a:${n}`, "title=Stereo",
      `-disposition:a:${n}`, "0",
    );
  }

  // Subtitle configuration:
  if (preset.subtitleMode !== "drop" && !(selection && selection.subtitles.length === 0)) {
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
