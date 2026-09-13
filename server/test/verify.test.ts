import { describe, expect, it, vi } from "vitest";
import { verifyOutput } from "../src/transcode/verify.js";
import type { MediaProbe } from "../src/media/types.js";

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(async (path: string) => {
    if (path.includes("missing")) {
      throw new Error("ENOENT: no such file");
    }
    if (path.includes("empty")) {
      return { size: 0 };
    }
    return { size: 1024 * 1024 * 50 };
  }),
}));

vi.mock("../src/media/ffprobe.js", () => ({
  probeFile: vi.fn(async (path: string) => {
    if (path.includes("probe-fail")) {
      throw new Error("Failed to parse probe");
    }
    if (path.includes("no-video")) {
      return {
        videoCodec: "",
        durationSeconds: 100,
        audioCodec: "aac",
        audioChannels: 2,
      };
    }
    if (path.includes("no-audio")) {
      return {
        videoCodec: "hevc",
        durationSeconds: 100,
        audioCodec: "none",
        audioChannels: 0,
      };
    }
    if (path.includes("duration-mismatch")) {
      return {
        videoCodec: "hevc",
        durationSeconds: 200,
        audioCodec: "aac",
        audioChannels: 2,
      };
    }
    return {
      videoCodec: "hevc",
      durationSeconds: 100,
      audioCodec: "aac",
      audioChannels: 2,
    };
  }),
}));

const baseSourceProbe: MediaProbe = {
  durationSeconds: 100,
  sizeBytes: 1024 * 1024 * 100,
  videoCodec: "h264",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 8000,
  bitDepth: 8,
  isHdr: false,
  fps: 24,
  audioCodec: "dts",
  audioChannels: 6,
  subtitleCount: 1,
};

describe("verifyOutput", () => {
  it("passes when output has video, audio, and matching duration", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/output.mkv");
    expect(result.ok).toBe(true);
  });

  it("fails when output file is missing", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/missing.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Output file missing");
  });

  it("fails when output file is 0 bytes", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/empty.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Output file is empty");
  });

  it("fails when ffprobe cannot probe output", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/probe-fail.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Failed to probe output");
  });

  it("fails when output has no video stream", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/no-video.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no video stream");
  });

  it("fails when source had audio but output lost audio", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/no-audio.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Audio stream lost during transcode");
  });

  it("passes when source had no audio and output has no audio", async () => {
    const silentSource: MediaProbe = {
      ...baseSourceProbe,
      audioCodec: "none",
      audioChannels: 0,
    };
    const result = await verifyOutput(silentSource, "/media/no-audio.mkv");
    expect(result.ok).toBe(true);
  });

  it("fails when duration delta exceeds tolerance", async () => {
    const result = await verifyOutput(baseSourceProbe, "/media/duration-mismatch.mkv");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Duration mismatch");
  });
});
