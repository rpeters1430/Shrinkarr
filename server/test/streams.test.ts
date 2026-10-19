import { describe, expect, it } from "vitest";
import { downscaleTarget, normalizeLanguage, selectStreams } from "../src/transcode/streams.js";
import { buildFfmpegArgs } from "../src/transcode/ffmpegArgs.js";
import { decide, remuxReasonsFor } from "../src/scanner/policy.js";
import { DEFAULT_PRESETS, type Preset } from "../src/config/schema.js";
import type { AudioTrack, MediaProbe, SubtitleTrack } from "../src/media/types.js";

const preset: Preset = {
  ...DEFAULT_PRESETS[0],
  hwaccel: "cpu",
  minFileSizeMb: 0,
  minSavingsPercent: 15,
};

const audio = (index: number, language: string, channels = 6, isDefault = false): AudioTrack => ({
  index,
  codec: "eac3",
  channels,
  language,
  isDefault,
});

const sub = (index: number, language: string): SubtitleTrack => ({ index, codec: "subrip", language, isForced: false });

const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 3600,
  sizeBytes: 4_000_000_000,
  videoCodec: "hevc",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 6000,
  bitDepth: 10,
  isHdr: false,
  fps: 24,
  audioCodec: "eac3",
  audioChannels: 6,
  subtitleCount: 3,
  audioTracks: [audio(1, "eng", 6, true), audio(2, "fre"), audio(3, "ger")],
  subtitleTracks: [sub(4, "eng"), sub(5, "spa"), sub(6, "und")],
};

describe("normalizeLanguage", () => {
  it("folds two-letter, bibliographic and spelled-out codes onto one code", () => {
    expect(normalizeLanguage("en")).toBe("eng");
    expect(normalizeLanguage("English")).toBe("eng");
    expect(normalizeLanguage("ger")).toBe("deu");
    expect(normalizeLanguage("fre")).toBe("fra");
    expect(normalizeLanguage("")).toBe("und");
    expect(normalizeLanguage("unknown")).toBe("und");
  });
});

describe("selectStreams", () => {
  it("keeps everything when no languages are set", () => {
    const selection = selectStreams(probe, preset)!;
    expect(selection.audio).toHaveLength(3);
    expect(selection.subtitles).toHaveLength(3);
    expect(selection.droppedAudio).toBe(0);
  });

  it("keeps matching and untagged tracks", () => {
    const selection = selectStreams(probe, { ...preset, keepAudioLanguages: ["en"], keepSubtitleLanguages: ["eng"] })!;
    expect(selection.audio.map((t) => t.index)).toEqual([1]);
    expect(selection.subtitles.map((t) => t.index)).toEqual([4, 6]);
    expect(selection.droppedAudio).toBe(2);
    expect(selection.droppedSubtitles).toBe(1);
  });

  it("keeps all audio rather than none when nothing matches", () => {
    const selection = selectStreams(probe, { ...preset, keepAudioLanguages: ["jpn"] })!;
    expect(selection.audio).toHaveLength(3);
    expect(selection.droppedAudio).toBe(0);
  });

  it("picks the default surround track for the stereo downmix", () => {
    const selection = selectStreams(probe, { ...preset, addStereoAudio: true })!;
    expect(selection.stereoSource?.index).toBe(1);
  });

  it("skips the stereo track when a stereo track is already kept", () => {
    const withStereo = { ...probe, audioTracks: [audio(1, "eng", 6), audio(2, "eng", 2)] };
    expect(selectStreams(withStereo, { ...preset, addStereoAudio: true })!.stereoSource).toBeUndefined();
  });

  it("returns null for probes without per-track info", () => {
    expect(selectStreams({}, preset)).toBeNull();
  });
});

describe("downscaleTarget", () => {
  it("fits 4K into 1080p", () => {
    expect(downscaleTarget(3840, 2160, "1080p")).toEqual({ width: 1920, height: 1080 });
  });

  it("bounds ultra-wide sources by width", () => {
    expect(downscaleTarget(3840, 1600, "1080p")).toEqual({ width: 1920, height: 800 });
  });

  it("leaves sources that already fit alone", () => {
    expect(downscaleTarget(1920, 1080, "1080p")).toBeNull();
    expect(downscaleTarget(1920, 1088, "1080p")).toBeNull();
    expect(downscaleTarget(3840, 2160, "none")).toBeNull();
  });
});

describe("buildFfmpegArgs track handling", () => {
  it("maps only the kept tracks and adds a stereo downmix last", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", { ...preset, keepAudioLanguages: ["eng"], keepSubtitleLanguages: ["eng"], addStereoAudio: true }, {
      resolvedEncoder: "libx265",
      audioTracks: probe.audioTracks,
      subtitleTracks: probe.subtitleTracks,
    });
    const maps = args.flatMap((arg, i) => (arg === "-map" ? [args[i + 1]] : []));
    expect(maps).toEqual(["0:v:0", "0:1", "0:1", "0:4", "0:6", "0:t?"]);
    expect(args.join(" ")).toContain("-c:a:1 aac -b:a:1 192k -ac:a:1 2");
    expect(args.indexOf("-c:a:1")).toBeGreaterThan(args.indexOf("-c:a"));
  });

  it("drops subtitles with -sn when none are kept", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", { ...preset, keepSubtitleLanguages: ["jpn"] }, {
      resolvedEncoder: "libx265",
      audioTracks: probe.audioTracks,
      subtitleTracks: [sub(4, "eng")],
    });
    expect(args).toContain("-sn");
    expect(args).not.toContain("-c:s");
  });

  it("copies the video for a remux and skips encoder flags", () => {
    const args = buildFfmpegArgs("/in.avi", "/out.mkv", preset, { copyVideo: true, sourceWidth: 3840, sourceHeight: 2160 });
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
    expect(args).not.toContain("-crf");
    expect(args).not.toContain("-vf");
  });

  it("scales in software ahead of the encoder", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", { ...preset, maxResolution: "1080p" }, {
      resolvedEncoder: "libx265",
      sourceWidth: 3840,
      sourceHeight: 2160,
    });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=1920:1080");
  });

  it("scales on the GPU when VAAPI decodes", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", { ...preset, hwaccel: "vaapi", maxResolution: "1080p" }, {
      resolvedEncoder: "hevc_vaapi",
      hwDecode: true,
      bitDepth: 10,
      sourceWidth: 3840,
      sourceHeight: 2160,
    });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale_vaapi=w=1920:h=1080:format=p010");
  });

  it("scales before uploading to VAAPI without GPU decode", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out.mkv", { ...preset, hwaccel: "vaapi", maxResolution: "720p" }, {
      resolvedEncoder: "hevc_vaapi",
      bitDepth: 8,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=1280:720,format=nv12|vaapi,hwupload");
  });
});

describe("decide with remux and downscale", () => {
  it("remuxes an HEVC file that only needs foreign tracks removed", () => {
    const result = decide(probe, { ...preset, keepAudioLanguages: ["eng"] });
    expect(result.shouldTranscode).toBe(true);
    expect(result.recommendedAction).toBe("Remux");
    expect(result.reason).toBe("remux: drop 2 audio tracks");
  });

  it("keeps an HEVC file with nothing to fix", () => {
    const result = decide(probe, preset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.recommendedAction).toBe("Keep");
  });

  it("does not remux when the preset turns it off", () => {
    const result = decide(probe, { ...preset, keepAudioLanguages: ["eng"], remuxWhenVideoIsFine: false });
    expect(result.shouldTranscode).toBe(false);
  });

  it("remuxes a legacy container whose video can't be shrunk further", () => {
    const avi: MediaProbe = { ...probe, container: "avi", videoCodec: "mpeg4", bitrateKbps: 550, width: 720, height: 400, resolutionLabel: "480p" };
    expect(remuxReasonsFor(avi, preset)).toEqual(["AVI to MKV"]);
    expect(decide(avi, preset).recommendedAction).toBe("Remux");
  });

  it("won't remux video MP4 can't carry", () => {
    const wmv: MediaProbe = { ...probe, container: "asf", videoCodec: "wmv3" };
    expect(remuxReasonsFor(wmv, { ...preset, targetContainer: "mp4" })).toEqual([]);
  });

  it("re-encodes a 4K HEVC file when the preset caps the resolution", () => {
    const uhd: MediaProbe = { ...probe, width: 3840, height: 2160, resolutionLabel: "4K", bitrateKbps: 20000 };
    const result = decide(uhd, { ...preset, maxResolution: "1080p" });
    expect(result.shouldTranscode).toBe(true);
    expect(result.recommendedAction).toBe("HEVC 1080p");
    expect(result.estimatedSavingsPercent).toBeGreaterThan(50);
  });
});
