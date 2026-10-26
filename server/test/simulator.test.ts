import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbe } from "../src/media/types.js";

const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 3600,
  sizeBytes: 1_000_000_000,
  videoCodec: "hevc",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 2200,
  bitDepth: 10,
  isHdr: false,
  fps: 24,
  audioCodec: "eac3",
  audioChannels: 6,
  subtitleCount: 0,
  audioTracks: [
    { index: 1, codec: "eac3", channels: 6, language: "eng", isDefault: true },
    { index: 2, codec: "eac3", channels: 6, language: "fre", isDefault: false },
  ],
  subtitleTracks: [],
};

vi.mock("../src/media/ffprobe.js", () => ({ probeFile: vi.fn(async () => ({ ...probe })) }));
const { runTranscodeWithFallback } = vi.hoisted(() => ({
  runTranscodeWithFallback: vi.fn(async (..._args: unknown[]) => ({ usedHwaccel: false, encoderUsed: "copy" })),
}));
vi.mock("../src/transcode/runner.js", () => ({ runTranscodeWithFallback }));

const { simulateSavings } = await import("../src/transcode/simulator.js");
const { DEFAULT_PRESETS } = await import("../src/config/schema.js");

describe("simulateSavings", () => {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-sim-"));
  const filePath = join(dir, "movie.mkv");
  const cleanup = { ...DEFAULT_PRESETS[0], minFileSizeMb: 0, remuxOnly: true };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    runTranscodeWithFallback.mockClear();
    runTranscodeWithFallback.mockImplementation(async (...args: unknown[]) => {
      writeFileSync(args[1] as string, Buffer.alloc(1000));
      return { usedHwaccel: false, encoderUsed: "copy" };
    });
  });

  it("remuxes the sample with the preset's track rules instead of re-encoding", async () => {
    const result = await simulateSavings(filePath, { ...cleanup, keepAudioLanguages: ["eng"] }, 30, dir);
    expect(result.remux).toBe(true);
    const probeContext = runTranscodeWithFallback.mock.calls[0][6] as { copyVideo?: boolean; audioTracks?: unknown[] };
    expect(probeContext.copyVideo).toBe(true);
    expect(probeContext.audioTracks).toHaveLength(2);
  });

  it("refuses a remux-only preset that would leave the file alone", async () => {
    await expect(simulateSavings(filePath, cleanup, 30, dir)).rejects.toThrow(/only remuxes/);
    expect(runTranscodeWithFallback).not.toHaveBeenCalled();
  });

  it("still encodes with a normal preset", async () => {
    const result = await simulateSavings(filePath, { ...DEFAULT_PRESETS[0], skipAlreadyTarget: false, minFileSizeMb: 0 }, 30, dir);
    expect(result.remux).toBe(false);
    expect((runTranscodeWithFallback.mock.calls[0][6] as { copyVideo?: boolean }).copyVideo).toBe(false);
  });
});
