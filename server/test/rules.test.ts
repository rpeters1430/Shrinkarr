import { describe, expect, it } from "vitest";
import { LibrarySchema, PresetSchema } from "../src/config/schema.js";
import type { FileRecord } from "../src/db/filesRepo.js";
import type { MediaProbe } from "../src/media/types.js";
import { resolveFileDecision, resolveIndexedFileDecision } from "../src/scanner/rules.js";

const videoPreset = PresetSchema.parse({
  id: "video-hevc",
  name: "Video HEVC",
  mediaKind: "video",
  minFileSizeMb: 0,
  minSavingsPercent: 0,
});

const audioPreset = PresetSchema.parse({
  id: "audio-opus",
  name: "Audio Opus",
  mediaKind: "audio",
  minFileSizeMb: 0,
  minSavingsPercent: 0,
});

const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 600,
  sizeBytes: 2_000_000_000,
  videoCodec: "h264",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 8_000,
  bitDepth: 8,
  isHdr: false,
  fps: 24,
  audioCodec: "aac",
  audioChannels: 2,
  subtitleCount: 1,
};

const makeLibrary = (rules: unknown[] = []) => LibrarySchema.parse({
  id: "movies",
  name: "Movies",
  path: "/media/Movies",
  presetId: videoPreset.id,
  rules,
});

const makeFile = (policyMetadata: FileRecord["policyMetadata"]): FileRecord => ({
  path: "/media/Movies/Film.mkv",
  libraryId: "movies",
  codec: "h264",
  container: "matroska",
  sizeBytes: probe.sizeBytes,
  durationSeconds: probe.durationSeconds,
  resolution: "1080p",
  width: probe.width,
  height: probe.height,
  bitrateKbps: probe.bitrateKbps,
  bitDepth: probe.bitDepth,
  isHdr: probe.isHdr,
  audioCodec: probe.audioCodec,
  audioChannels: probe.audioChannels,
  subtitleCount: probe.subtitleCount,
  estimatedSavingsBytes: 0,
  recommendedAction: "Keep",
  lastScannedAt: "2026-01-01T00:00:00.000Z",
  mtimeMs: 1,
  needsTranscode: false,
  skipReason: null,
  healthStatus: "unchecked",
  healthMode: null,
  healthCheckedAt: null,
  healthError: null,
  ignored: false,
  policyMetadata,
});

describe("resolveFileDecision", () => {
  it("uses the first enabled rule whose AND conditions all match", () => {
    const library = makeLibrary([
      {
        id: "disabled",
        name: "Disabled",
        enabled: false,
        conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
        action: { type: "keep" },
      },
      {
        id: "wrong-size",
        name: "Wrong size",
        enabled: true,
        conditions: [
          { field: "mediaKind", operator: "equals", value: "video" },
          { field: "sizeBytes", operator: "greaterThan", value: 3_000_000_000 },
        ],
        action: { type: "keep" },
      },
      {
        id: "first-match",
        name: "First match",
        enabled: true,
        conditions: [
          { field: "mediaKind", operator: "equals", value: "video" },
          { field: "videoCodec", operator: "equals", value: "H264" },
        ],
        action: { type: "preset", presetId: videoPreset.id },
      },
      {
        id: "later-match",
        name: "Later match",
        enabled: true,
        conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
        action: { type: "keep" },
      },
    ]);

    const result = resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset]);
    expect(result).toMatchObject({
      status: "ready",
      action: "optimize",
      presetId: videoPreset.id,
      matchedRuleId: "first-match",
      matchedRuleName: "First match",
      fallback: false,
    });
  });

  it("uses Keep when the first matching rule says Keep", () => {
    const library = makeLibrary([{
      id: "keep-hdr",
      name: "Keep HDR",
      enabled: true,
      conditions: [{ field: "isHdr", operator: "equals", value: false }],
      action: { type: "keep" },
    }]);
    expect(resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset])).toMatchObject({
      action: "keep",
      matchedRuleId: "keep-hdr",
      reason: "Kept by rule: Keep HDR",
    });
  });

  it("falls back to the library preset and current policy when no rule matches", () => {
    const library = makeLibrary([{
      id: "audio-only",
      name: "Audio only",
      enabled: true,
      conditions: [{ field: "mediaKind", operator: "equals", value: "audio" }],
      action: { type: "keep" },
    }]);
    expect(resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset])).toMatchObject({
      action: "optimize",
      presetId: videoPreset.id,
      fallback: true,
      decision: { shouldTranscode: true },
    });
  });

  it.each([
    ["equals", "film.MKV"],
    ["oneOf", ["Other.mkv", "Film.mkv"]],
    ["contains", "ilm"],
    ["glob", "**/*.mkv"],
  ] as const)("matches path operator %s", (operator, value) => {
    const library = makeLibrary([{
      id: "path-rule",
      name: "Path rule",
      enabled: true,
      conditions: [{ field: "path", operator, value }],
      action: { type: "keep" },
    }]);
    const result = resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset]);
    expect(result.matchedRuleId).toBe("path-rule");
  });

  it("matches glob paths case-insensitively after normalizing separators", () => {
    const library = makeLibrary([{
      id: "glob-rule",
      name: "Glob rule",
      enabled: true,
      conditions: [{ field: "path", operator: "glob", value: "**/film.MKV" }],
      action: { type: "keep" },
    }]);
    const result = resolveFileDecision("/media/Movies/Season 1\\Film.mkv", probe, library, [videoPreset]);
    expect(result.matchedRuleId).toBe("glob-rule");
  });

  it.each([
    [{ field: "mediaKind", operator: "equals", value: "video" }, true],
    [{ field: "sizeBytes", operator: "greaterThan", value: 1_000_000_000 }, true],
    [{ field: "sizeBytes", operator: "lessThan", value: 3_000_000_000 }, true],
    [{ field: "sizeBytes", operator: "between", value: [2_000_000_000, 2_000_000_000] }, true],
    [{ field: "videoCodec", operator: "oneOf", value: ["hevc", "h264"] }, true],
    [{ field: "audioCodec", operator: "contains", value: "a" }, true],
    [{ field: "width", operator: "equals", value: 1920 }, true],
    [{ field: "height", operator: "equals", value: 1080 }, true],
    [{ field: "bitrateKbps", operator: "greaterThan", value: 7000 }, true],
    [{ field: "bitDepth", operator: "oneOf", value: [8, 10] }, true],
    [{ field: "isHdr", operator: "equals", value: false }, true],
    [{ field: "audioChannels", operator: "equals", value: 2 }, true],
    [{ field: "subtitleCount", operator: "equals", value: 1 }, true],
    [{ field: "durationSeconds", operator: "lessThan", value: 601 }, true],
    [{ field: "container", operator: "contains", value: "mat" }, true],
    [{ field: "sizeBytes", operator: "between", value: [2_000_000_001, 3_000_000_000] }, false],
  ] as const)("evaluates condition %j as %s", (condition, matches) => {
    const library = makeLibrary([{
      id: "condition-rule",
      name: "Condition rule",
      enabled: true,
      conditions: [condition],
      action: { type: "keep" },
    }]);
    const result = resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset]);
    expect(result.matchedRuleId === "condition-rule").toBe(matches);
  });

  it("rejects a preset whose media kind differs from the probe", () => {
    const library = makeLibrary([{
      id: "wrong-kind",
      name: "Wrong kind",
      enabled: true,
      conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
      action: { type: "preset", presetId: audioPreset.id },
    }]);
    expect(resolveFileDecision("/media/Movies/Film.mkv", probe, library, [videoPreset, audioPreset])).toMatchObject({
      status: "invalid",
      action: "keep",
    });
  });

  it("does not evaluate files outside the configured library", () => {
    const library = makeLibrary([]);
    expect(resolveFileDecision("/media/other/Film.mkv", probe, library, [videoPreset])).toMatchObject({
      status: "outsideLibrary",
      action: "keep",
    });
  });
});

describe("resolveIndexedFileDecision", () => {
  it("marks rows without supplemental metadata for a scan instead of guessing policy", () => {
    const result = resolveIndexedFileDecision(makeFile(null), makeLibrary([]), [videoPreset]);
    expect(result).toMatchObject({ status: "needsScan", action: "keep", reason: expect.stringContaining("scan") });
  });

  it("reconstructs the probe fields from indexed metadata", () => {
    const file = makeFile({ mediaKind: "video", fps: 23.976, colorTransfer: "smpte2084" });
    const result = resolveIndexedFileDecision(file, makeLibrary([]), [videoPreset]);
    expect(result).toMatchObject({ status: "ready", decision: { shouldTranscode: true } });
  });

  it("does not match an audio codec against the videoCodec field", () => {
    const audioRule = {
      id: "video-codec-flac", name: "Video codec FLAC", enabled: true,
      conditions: [{ field: "videoCodec", operator: "equals", value: "flac" }],
      action: { type: "keep" },
    };
    const library = LibrarySchema.parse({
      id: "movies", name: "Movies", path: "/media/Movies", presetId: audioPreset.id, rules: [audioRule],
    });
    const file = { ...makeFile({ mediaKind: "audio", fps: 0 }), codec: "flac", audioCodec: "flac" };
    const result = resolveIndexedFileDecision(file, library, [audioPreset]);
    expect(result).toMatchObject({ status: "ready", fallback: true });
    expect(result.matchedRuleId).toBeUndefined();
  });
});
