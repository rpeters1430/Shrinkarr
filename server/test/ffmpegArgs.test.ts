import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../src/transcode/ffmpegArgs.js";
import type { Preset } from "../src/config/schema.js";

const hevcVaapiPreset: Preset = {
  id: "hevc-save-space",
  name: "H.265 to save space",
  targetCodec: "hevc",
  targetContainer: "mkv",
  crf: 24,
  hwaccel: "vaapi",
  minSavingsPercent: 15,
};

const h264CpuPreset: Preset = {
  ...hevcVaapiPreset,
  targetCodec: "h264",
  hwaccel: "cpu",
};

describe("buildFfmpegArgs", () => {
  it("builds VAAPI args for an hevc target preset", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset);
    expect(args).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "/dev/dri/renderD128",
      "-hwaccel_output_format",
      "vaapi",
      "-i",
      "/in/movie.mkv",
      "-c:v",
      "hevc_vaapi",
      "-qp",
      "24",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("builds CPU args for an h264 target preset", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", h264CpuPreset);
    expect(args).toEqual([
      "-i",
      "/in/movie.mkv",
      "-c:v",
      "libx264",
      "-crf",
      "24",
      "-preset",
      "faster",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });
});
