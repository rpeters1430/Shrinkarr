import { describe, expect, it } from "vitest";
import { decide } from "../src/scanner/policy.js";
import type { Preset } from "../src/config/schema.js";
import type { MediaProbe } from "../src/media/types.js";

const basePreset: Preset = {
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
  minFileSizeMb: 0,
  skipAlreadyTarget: true,
};

const baseProbe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 120,
  sizeBytes: 1_000_000,
  videoCodec: "h264",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 8000,
  bitDepth: 8,
  isHdr: false,
  fps: 24,
  audioCodec: "aac",
  audioChannels: 2,
  subtitleCount: 0,
};

describe("decide", () => {
  it("transcodes h264 source against an hevc target preset", () => {
    const result = decide(baseProbe, basePreset);
    expect(result.shouldTranscode).toBe(true);
    expect(result.recommendedAction).toBe("HEVC");
    expect(result.estimatedSavingsPercent).toBeGreaterThanOrEqual(15);
  });

  it("skips a file already in the target codec", () => {
    const probe: MediaProbe = { ...baseProbe, videoCodec: "hevc" };
    const result = decide(probe, basePreset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.recommendedAction).toBe("Keep");
  });

  it("skips a file below the savings threshold", () => {
    const preset: Preset = { ...basePreset, minSavingsPercent: 90 };
    const result = decide(baseProbe, preset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.recommendedAction).toBe("Keep");
  });

  it("skips files below preset minFileSizeMb by default for movie/tv libraries", () => {
    const preset: Preset = { ...basePreset, minFileSizeMb: 500 };
    const smallProbe: MediaProbe = { ...baseProbe, sizeBytes: 100 * 1024 * 1024 }; // 100MB
    const result = decide(smallProbe, preset, { mediaType: "movie" });
    expect(result.shouldTranscode).toBe(false);
    expect(result.reason).toContain("is below threshold (500MB)");
  });

  it("allows smaller files for non-tv/movie libraries (e.g. models / other / youtube)", () => {
    const preset: Preset = { ...basePreset, minFileSizeMb: 500 };
    const clipProbe: MediaProbe = { ...baseProbe, sizeBytes: 100 * 1024 * 1024 }; // 100MB
    const result = decide(clipProbe, preset, { mediaType: "other" });
    expect(result.shouldTranscode).toBe(true);
    expect(result.recommendedAction).toBe("HEVC");
  });

  it("respects explicit library minFileSizeMb override", () => {
    const preset: Preset = { ...basePreset, minFileSizeMb: 500 };
    const clipProbe: MediaProbe = { ...baseProbe, sizeBytes: 50 * 1024 * 1024 }; // 50MB
    const result = decide(clipProbe, preset, { mediaType: "other", minFileSizeMb: 75 });
    expect(result.shouldTranscode).toBe(false);
    expect(result.reason).toContain("is below threshold (75MB)");
  });

  it("skips a video when source bitrate is already lower than target codec expected bitrate", () => {
    // 1080p source at 1500 kbps (expected 1080p HEVC at CRF 24 is ~2200 kbps)
    const lowBitrateProbe: MediaProbe = {
      ...baseProbe,
      bitrateKbps: 1500,
    };
    const result = decide(lowBitrateProbe, basePreset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.recommendedAction).toBe("Keep");
    expect(result.reason).toContain("is already too low for further savings without quality degradation");
  });

  it("skips when source bitrate provides marginal savings below minSavingsPercent", () => {
    // 1080p source at 2400 kbps vs ~2200 kbps target yields ~8% savings, which is < preset.minSavingsPercent (15%)
    const marginalProbe: MediaProbe = {
      ...baseProbe,
      bitrateKbps: 2400,
    };
    const result = decide(marginalProbe, basePreset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.recommendedAction).toBe("Keep");
    expect(result.reason).toContain("below threshold");
  });
});

describe("decide (music presets)", () => {
  const musicPreset: Preset = {
    ...basePreset,
    id: "music-space-saver",
    mediaKind: "audio",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
    minSavingsPercent: 30,
    minFileSizeMb: 5,
  };

  const flacProbe: MediaProbe = {
    mediaKind: "audio",
    durationSeconds: 240,
    sizeBytes: 30 * 1024 * 1024, // ~30MB FLAC
    videoCodec: "none",
    container: "flac",
    width: 0,
    height: 0,
    resolutionLabel: "SD",
    bitrateKbps: 1000,
    bitDepth: 8,
    isHdr: false,
    fps: 0,
    audioCodec: "flac",
    audioChannels: 2,
    subtitleCount: 0,
    isLosslessAudio: true,
  };

  it("transcodes a lossless FLAC source down to the target Opus bitrate", () => {
    const result = decide(flacProbe, musicPreset);
    expect(result.shouldTranscode).toBe(true);
    expect(result.recommendedAction).toBe("OPUS");
    expect(result.estimatedSavingsPercent).toBeGreaterThanOrEqual(30);
  });

  it("keeps a lossy mp3 source untouched when onlyIfLosslessSource is true", () => {
    const mp3Probe: MediaProbe = { ...flacProbe, audioCodec: "mp3", bitrateKbps: 320, isLosslessAudio: false };
    const result = decide(mp3Probe, musicPreset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.reason).toContain("only touches lossless sources");
  });

  it("re-bitrates a lossy source when onlyIfLosslessSource is disabled and it's above target", () => {
    const preset: Preset = { ...musicPreset, onlyIfLosslessSource: false };
    const mp3Probe: MediaProbe = { ...flacProbe, audioCodec: "mp3", bitrateKbps: 320, isLosslessAudio: false };
    const result = decide(mp3Probe, preset);
    expect(result.shouldTranscode).toBe(true);
    expect(result.estimatedSavingsPercent).toBeGreaterThan(0);
  });

  it("skips a file already on the target audio codec", () => {
    const preset: Preset = { ...musicPreset, onlyIfLosslessSource: false };
    const opusProbe: MediaProbe = { ...flacProbe, audioCodec: "opus", isLosslessAudio: false, bitrateKbps: 160 };
    const result = decide(opusProbe, preset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.reason).toContain("already target audio codec");
  });

  it("skips files below the music preset's minFileSizeMb", () => {
    const tinyProbe: MediaProbe = { ...flacProbe, sizeBytes: 2 * 1024 * 1024 };
    const result = decide(tinyProbe, musicPreset);
    expect(result.shouldTranscode).toBe(false);
    expect(result.reason).toContain("is below threshold (5MB)");
  });
});
