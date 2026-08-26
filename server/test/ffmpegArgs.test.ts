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
  bitDepth: 10,
  preserveHdr: true,
  audioMode: "copy",
  subtitleMode: "copy",
  minSavingsPercent: 15,
  minFileSizeMb: 500,
  skipAlreadyTarget: true,
};

const h264CpuPreset: Preset = {
  ...hevcVaapiPreset,
  targetCodec: "h264",
  hwaccel: "cpu",
};

const av1AmfPreset: Preset = {
  ...hevcVaapiPreset,
  targetCodec: "av1",
  hwaccel: "amf",
  audioMode: "aac",
};

describe("buildFfmpegArgs", () => {
  it("builds VAAPI args for an hevc target preset with MKV subtitle copy", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset);
    expect(args).toEqual([
      "-vaapi_device",
      "/dev/dri/renderD128",
      "-i",
      "/in/movie.mkv",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-map",
      "0:s?",
      "-dn",
      "-c:v",
      "hevc_vaapi",
      "-vf",
      "format=p010|vaapi,hwupload",
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
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-map",
      "0:s?",
      "-dn",
      "-c:v",
      "libx264",
      "-crf",
      "24",
      "-preset",
      "medium",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("converts mov_text to srt when input is mp4 and target is mkv", () => {
    const args = buildFfmpegArgs("/in/video.mp4", "/out/video.mkv", hevcVaapiPreset);
    expect(args).toContain("-c:s");
    expect(args[args.indexOf("-c:s") + 1]).toBe("srt");
  });

  it("builds AMF hardware args for an av1 target preset with AAC audio", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", av1AmfPreset);
    expect(args).toEqual([
      "-i",
      "/in/movie.mkv",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-map",
      "0:s?",
      "-dn",
      "-c:v",
      "av1_amf",
      "-rc",
      "cqp",
      "-qp_p",
      "24",
      "-qp_i",
      "24",
      "-quality",
      "quality",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-c:s",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("passes thread limit to ffmpeg when specified", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset, { threads: 4 });
    expect(args).toContain("-threads");
    expect(args[args.indexOf("-threads") + 1]).toBe("4");
  });
});
