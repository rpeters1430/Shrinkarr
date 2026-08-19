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
  minSavingsPercent: 15,
};

const baseProbe: MediaProbe = {
  durationSeconds: 120,
  sizeBytes: 1_000_000,
  videoCodec: "h264",
  container: "matroska",
  width: 1920,
  height: 1080,
  audioCodec: "aac",
};

describe("decide", () => {
  it("transcodes h264 source against an hevc target preset", () => {
    const result = decide(baseProbe, basePreset);
    expect(result).toEqual({ shouldTranscode: true, reason: "eligible" });
  });

  it("skips a file already in the target codec", () => {
    const probe: MediaProbe = { ...baseProbe, videoCodec: "hevc" };
    const result = decide(probe, basePreset);
    expect(result).toEqual({ shouldTranscode: false, reason: "already target codec" });
  });

  it("skips a file below the savings threshold", () => {
    const preset: Preset = { ...basePreset, minSavingsPercent: 90 };
    const result = decide(baseProbe, preset);
    expect(result).toEqual({ shouldTranscode: false, reason: "below savings threshold" });
  });
});
