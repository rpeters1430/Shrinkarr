import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTranscode } = vi.hoisted(() => ({ runTranscode: vi.fn() }));
vi.mock("../src/transcode/runner.js", () => ({ runTranscode }));

import { buildSsimArgs, parseSsimScore, runVideoQualityGate } from "../src/transcode/qualityGate.js";

const gateOptions = {
  minimumSsim: 0.95,
  sourceWidth: 1920,
  sourceHeight: 1080,
  sourceVideoDurationSeconds: 60,
  outputVideoDurationSeconds: 60,
  frameRate: 24,
};

describe("video quality gate", () => {
  beforeEach(() => runTranscode.mockReset());

  it("parses the final finite SSIM score and rejects absent or invalid metrics", () => {
    expect(parseSsimScore("SSIM Y:0.98 All:0.975 (16.0)\nSSIM Y:0.99 All:0.982 (17.5)")).toBe(0.982);
    expect(parseSsimScore("No metric was emitted")).toBeNull();
    expect(parseSsimScore("All:nan")).toBeNull();
    expect(parseSsimScore("All:1.01")).toBeNull();
    expect(parseSsimScore("metadata: All:0.98 but no SSIM result")).toBeNull();
  });

  it("builds a full-stream comparison that scales output to the source", () => {
    expect(buildSsimArgs("/media/source.mkv", "/tmp/output.mkv", 1920, 1080)).toEqual([
      "-i", "/media/source.mkv", "-i", "/tmp/output.mkv", "-filter_complex",
      expect.stringContaining("[1:v:0]setpts=PTS-STARTPTS,scale=1920:1080"),
      "-an", "-sn", "-f", "null", "-",
    ]);
  });

  it("passes a score at the threshold and returns a readable rejection below it", async () => {
    runTranscode.mockResolvedValueOnce("SSIM Y:0.96 All:0.955 (13.4)");
    await expect(runVideoQualityGate("source.mkv", "output.mkv", 60, gateOptions))
      .resolves.toMatchObject({ ok: true, score: 0.955 });

    runTranscode.mockResolvedValueOnce("SSIM Y:0.90 All:0.91 (10.4)");
    await expect(runVideoQualityGate("source.mkv", "output.mkv", 60, gateOptions))
      .resolves.toMatchObject({ ok: false, score: 0.91, reason: expect.stringContaining("below the minimum") });
  });

  it("fails closed when FFmpeg exits without a parseable metric", async () => {
    runTranscode.mockResolvedValueOnce("filter unavailable");
    await expect(runVideoQualityGate("source.mkv", "output.mkv", 60, gateOptions))
      .resolves.toMatchObject({ ok: false, score: null, reason: expect.stringContaining("valid SSIM") });
  });

  it("rejects unavailable or materially shorter video streams before measuring SSIM", async () => {
    await expect(runVideoQualityGate("source.mkv", "output.mkv", 60, { ...gateOptions, outputVideoDurationSeconds: undefined }))
      .resolves.toMatchObject({ ok: false, score: null, reason: expect.stringContaining("duration is unavailable") });
    await expect(runVideoQualityGate("source.mkv", "output.mkv", 60, { ...gateOptions, outputVideoDurationSeconds: 58 }))
      .resolves.toMatchObject({ ok: false, score: null, reason: expect.stringContaining("Video duration mismatch") });
    expect(runTranscode).not.toHaveBeenCalled();
  });
});
