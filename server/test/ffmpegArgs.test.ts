import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../src/transcode/ffmpegArgs.js";
import type { Preset } from "../src/config/schema.js";

const hevcVaapiPreset: Preset = {
  id: "hevc-save-space",
  name: "H.265 to save space",
  mediaKind: "video",
  targetCodec: "hevc",
  targetContainer: "mkv",
  crf: 24,
  hwaccel: "vaapi",
  bitDepth: 10,
  preserveHdr: true,
  audioMode: "copy",
  subtitleMode: "copy",
  targetAudioCodec: "opus",
  targetAudioBitrateKbps: 160,
  onlyIfLosslessSource: true,
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
      "-map",
      "0:t?",
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
      "-c:t",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("builds a full GPU decode+encode VAAPI pipeline when hwDecode is requested", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset, { hwDecode: true });
    expect(args).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
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
      "-map",
      "0:t?",
      "-dn",
      "-c:v",
      "hevc_vaapi",
      "-vf",
      "scale_vaapi=format=p010",
      "-qp",
      "24",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-c:t",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("uses the render node selected by hardware detection for full VAAPI processing", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset, {
      devicePath: "/dev/dri/renderD129",
      hwDecode: true,
    });
    expect(args.slice(0, 6)).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-vaapi_device",
      "/dev/dri/renderD129",
    ]);
    expect(args).toContain("scale_vaapi=format=p010");
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
      "-map",
      "0:t?",
      "-dn",
      "-c:v",
      "libx264",
      "-crf",
      "24",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      "-c:t",
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
      "-map",
      "0:t?",
      "-dn",
      "-c:v",
      "av1_amf",
      "-usage",
      "transcoding",
      "-rc",
      "cqp",
      "-qp_p",
      "108",
      "-qp_i",
      "108",
      "-quality",
      "balanced",
      "-pix_fmt",
      "p010le",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-c:s",
      "copy",
      "-c:t",
      "copy",
      "-y",
      "/out/movie.mkv",
    ]);
  });

  it("builds safe 8-bit AMF HEVC args with nv12 for SDR inputs", () => {
    const hevcAmfPreset: Preset = {
      ...hevcVaapiPreset,
      targetCodec: "hevc",
      hwaccel: "amf",
      bitDepth: 8,
    };
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcAmfPreset, { bitDepth: 8 });
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("nv12");
    expect(args).toContain("-profile:v");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("main");
  });

  it("passes thread limit to ffmpeg when specified", () => {
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", hevcVaapiPreset, { threads: 4 });
    expect(args).toContain("-threads");
    expect(args[args.indexOf("-threads") + 1]).toBe("4");
  });

  it("applies vbr_peak with bitrate cap on hevc_amf for low-bitrate sources", () => {
    const hevcAmfPreset: Preset = {
      ...hevcVaapiPreset,
      targetCodec: "hevc",
      hwaccel: "amf",
    };
    const args = buildFfmpegArgs("/in/webcam.mkv", "/out/webcam.mkv", hevcAmfPreset, {
      sourceBitrateKbps: 2000,
    });
    expect(args).toContain("-rc");
    expect(args[args.indexOf("-rc") + 1]).toBe("vbr_peak");
    expect(args).toContain("-b:v");
    expect(args[args.indexOf("-b:v") + 1]).toBe("1300k");
    expect(args).toContain("-maxrate");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("1640k");
  });

  it("adds maxrate ceiling to libx265 for source bitrate awareness", () => {
    const cpuPreset: Preset = {
      ...hevcVaapiPreset,
      targetCodec: "hevc",
      hwaccel: "cpu",
    };
    const args = buildFfmpegArgs("/in/video.mkv", "/out/video.mkv", cpuPreset, {
      sourceBitrateKbps: 2000,
    });
    expect(args).toContain("-maxrate");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("1700k");
    expect(args).toContain("-bufsize");
    expect(args[args.indexOf("-bufsize") + 1]).toBe("3400k");
  });

  it("builds a plain audio re-encode for a music preset (no video mapping, no hwaccel)", () => {
    const musicPreset: Preset = {
      ...hevcVaapiPreset,
      mediaKind: "audio",
      targetAudioCodec: "opus",
      targetAudioBitrateKbps: 160,
    };
    const args = buildFfmpegArgs("/in/song.flac", "/out/song.opus", musicPreset);
    expect(args).toEqual([
      "-i",
      "/in/song.flac",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-map_metadata",
      "0",
      "-c:a",
      "libopus",
      "-b:a",
      "160k",
      "-y",
      "/out/song.opus",
    ]);
  });

  it("omits -b:a for a flac (lossless) target", () => {
    const musicPreset: Preset = {
      ...hevcVaapiPreset,
      mediaKind: "audio",
      targetAudioCodec: "flac",
    };
    const args = buildFfmpegArgs("/in/song.wav", "/out/song.flac", musicPreset);
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("flac");
    expect(args).not.toContain("-b:a");
  });

  it("enables -hwaccel cuda when hwDecode is requested on nvenc", () => {
    const nvencPreset: Preset = {
      ...hevcVaapiPreset,
      targetCodec: "hevc",
      hwaccel: "nvenc",
    };
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", nvencPreset, {
      hwDecode: true,
      resolvedEncoder: "hevc_nvenc",
      resolvedHwaccelType: "nvenc",
    });
    expect(args).toContain("-hwaccel");
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("cuda");
  });

  it("enables -hwaccel qsv when hwDecode is requested on qsv", () => {
    const qsvPreset: Preset = {
      ...hevcVaapiPreset,
      targetCodec: "hevc",
      hwaccel: "qsv",
    };
    const args = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", qsvPreset, {
      hwDecode: true,
      resolvedEncoder: "hevc_qsv",
      resolvedHwaccelType: "qsv",
    });
    expect(args).toContain("-hwaccel");
    expect(args[args.indexOf("-hwaccel") + 1]).toBe("qsv");
  });

  it("applies tone mapping filter when preserveHdr is false on HDR source", () => {
    const sdrPreset: Preset = {
      ...h264CpuPreset,
      preserveHdr: false,
    };
    const args = buildFfmpegArgs("/in/hdr.mkv", "/out/sdr.mkv", sdrPreset, {
      isHdr: true,
      colorTransfer: "smpte2084",
    });
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toContain("tonemap=hable");
    expect(args).toContain("-colorspace");
    expect(args[args.indexOf("-colorspace") + 1]).toBe("bt709");
  });

  it("re-encodes lossless surround audio to 384k AAC and stereo to 192k AAC in smart audio mode", () => {
    const smartPreset: Preset = {
      ...hevcVaapiPreset,
      audioMode: "smart",
    };
    // 5.1 / 7.1 TrueHD
    const surroundArgs = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", smartPreset, {
      isLosslessAudio: true,
      audioChannels: 6,
    });
    expect(surroundArgs).toContain("-c:a");
    expect(surroundArgs[surroundArgs.indexOf("-c:a") + 1]).toBe("aac");
    expect(surroundArgs).toContain("-b:a");
    expect(surroundArgs[surroundArgs.indexOf("-b:a") + 1]).toBe("384k");

    // Stereo FLAC
    const stereoArgs = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", smartPreset, {
      isLosslessAudio: true,
      audioChannels: 2,
    });
    expect(stereoArgs[stereoArgs.indexOf("-b:a") + 1]).toBe("192k");

    // Lossy audio (already AC-3 / AAC / Opus)
    const lossyArgs = buildFfmpegArgs("/in/movie.mkv", "/out/movie.mkv", smartPreset, {
      isLosslessAudio: false,
      audioChannels: 6,
    });
    expect(lossyArgs).toContain("-c:a");
    expect(lossyArgs[lossyArgs.indexOf("-c:a") + 1]).toBe("copy");
    expect(lossyArgs).not.toContain("-b:a");
  });
});
