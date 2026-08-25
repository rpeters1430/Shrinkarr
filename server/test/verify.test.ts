import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbe } from "../src/media/types.js";

const probeFileMock = vi.fn<(path: string) => Promise<MediaProbe>>();

vi.mock("../src/media/ffprobe.js", () => ({
  probeFile: (path: string) => probeFileMock(path),
}));

const { verifyOutput } = await import("../src/transcode/verify.js");

function makeProbe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    durationSeconds: 100,
    sizeBytes: 1_000_000,
    videoCodec: "hevc",
    container: "matroska",
    width: 1920,
    height: 1080,
    resolutionLabel: "1080p",
    bitrateKbps: 4000,
    bitDepth: 10,
    isHdr: false,
    fps: 24,
    audioCodec: "aac",
    audioChannels: 2,
    audioTrackCount: 1,
    subtitleCount: 1,
    ...overrides,
  };
}

let dir: string;
let outputPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shrinkarr-verify-"));
  outputPath = join(dir, "output.mkv");
  probeFileMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("verifyOutput", () => {
  it("fails when the output is not smaller than the original", async () => {
    writeFileSync(outputPath, Buffer.alloc(2_000_000));
    const originalProbe = makeProbe({ sizeBytes: 1_000_000 });

    const result = await verifyOutput(originalProbe, outputPath);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not smaller than the original/);
    expect(probeFileMock).not.toHaveBeenCalled();
  });

  it("fails when audio was set to copy but a track was dropped", async () => {
    writeFileSync(outputPath, Buffer.alloc(500_000));
    const originalProbe = makeProbe({ audioTrackCount: 2 });
    probeFileMock.mockResolvedValue(makeProbe({ sizeBytes: 500_000, audioTrackCount: 1 }));

    const result = await verifyOutput(originalProbe, outputPath, { audioCopied: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Audio track count mismatch/);
  });

  it("fails when audio was set to copy but the channel count changed", async () => {
    writeFileSync(outputPath, Buffer.alloc(500_000));
    const originalProbe = makeProbe({ audioChannels: 6 });
    probeFileMock.mockResolvedValue(makeProbe({ sizeBytes: 500_000, audioChannels: 2 }));

    const result = await verifyOutput(originalProbe, outputPath, { audioCopied: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Audio channel count mismatch/);
  });

  it("fails when subtitles were set to copy but a track was dropped", async () => {
    writeFileSync(outputPath, Buffer.alloc(500_000));
    const originalProbe = makeProbe({ subtitleCount: 2 });
    probeFileMock.mockResolvedValue(makeProbe({ sizeBytes: 500_000, subtitleCount: 0 }));

    const result = await verifyOutput(originalProbe, outputPath, { subtitlesCopied: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Subtitle track count mismatch/);
  });

  it("does not fail on dropped subtitles when subtitlesCopied is false (intentional fallback)", async () => {
    writeFileSync(outputPath, Buffer.alloc(500_000));
    const originalProbe = makeProbe({ subtitleCount: 2 });
    probeFileMock.mockResolvedValue(makeProbe({ sizeBytes: 500_000, subtitleCount: 0 }));

    const result = await verifyOutput(originalProbe, outputPath, { subtitlesCopied: false });

    expect(result.ok).toBe(true);
  });

  it("passes when the output is smaller and streams match", async () => {
    writeFileSync(outputPath, Buffer.alloc(500_000));
    const originalProbe = makeProbe();
    probeFileMock.mockResolvedValue(makeProbe({ sizeBytes: 500_000 }));

    const result = await verifyOutput(originalProbe, outputPath, { audioCopied: true, subtitlesCopied: true });

    expect(result.ok).toBe(true);
  });
});
