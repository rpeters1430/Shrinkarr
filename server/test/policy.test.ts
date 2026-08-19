import { describe, expect, it } from "vitest";
import { decide } from "../src/scanner/policy.js";
import type { Preset } from "../src/config/schema.js";
import type { MediaProbe } from "../src/media/types.js";

const basePreset: Preset = {
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
  minFileSizeMb: 0,
  skipAlreadyTarget: true,
};

const baseProbe: MediaProbe = {
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
});
