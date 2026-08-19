import type { Preset } from "../config/schema.js";

export function buildFfmpegArgs(inputPath: string, outputPath: string, preset: Preset): string[] {
  const videoEncoder =
    preset.hwaccel === "vaapi"
      ? preset.targetCodec === "hevc"
        ? "hevc_vaapi"
        : "h264_vaapi"
      : preset.targetCodec === "hevc"
        ? "libx265"
        : "libx264";

  if (preset.hwaccel === "vaapi") {
    return [
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "/dev/dri/renderD128",
      "-hwaccel_output_format",
      "vaapi",
      "-i",
      inputPath,
      "-c:v",
      videoEncoder,
      "-qp",
      String(preset.crf),
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-y",
      outputPath,
    ];
  }

  return [
    "-i",
    inputPath,
    "-c:v",
    videoEncoder,
    "-crf",
    String(preset.crf),
    "-preset",
    "faster",
    "-c:a",
    "copy",
    "-c:s",
    "copy",
    "-y",
    outputPath,
  ];
}
