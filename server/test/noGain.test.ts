import { describe, expect, it } from "vitest";
import { decide, encodeFingerprint } from "../src/scanner/policy.js";
import { unchangedFileMarkers } from "../src/scanner/scan.js";
import { recordNoGainEncode } from "../src/queue/noGain.js";
import { ConfigSchema, DEFAULT_PRESETS, type Preset } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import type { MediaProbe } from "../src/media/types.js";

const preset: Preset = { ...DEFAULT_PRESETS[0], minFileSizeMb: 0 };

// A 6 Mbps H.264 webcam recording: the scan expects HEVC to roughly halve it.
const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 2619,
  sizeBytes: 2_021_000_000,
  videoCodec: "h264",
  container: "matroska",
  width: 1080,
  height: 1440,
  resolutionLabel: "1080p",
  bitrateKbps: 6174,
  bitDepth: 8,
  isHdr: false,
  fps: 59.94,
  audioCodec: "aac",
  audioChannels: 2,
  subtitleCount: 0,
  audioTracks: [{ index: 1, codec: "aac", channels: 2, language: "eng", isDefault: true }],
  subtitleTracks: [],
};

describe("files an encode made larger", () => {
  it("are kept instead of encoded again with the same settings", () => {
    expect(decide(probe, preset).recommendedAction).toBe("HEVC");
    const marked = { ...probe, noGainEncodes: [encodeFingerprint(preset)] };
    expect(decide(marked, preset)).toMatchObject({ shouldTranscode: false, recommendedAction: "Keep" });
  });

  it("still get their tracks fixed", () => {
    const marked = { ...probe, noGainEncodes: [encodeFingerprint(preset)], audioTracks: [...probe.audioTracks!, { index: 2, codec: "aac", channels: 2, language: "fre", isDefault: false }] };
    expect(decide(marked, { ...preset, keepAudioLanguages: ["eng"] }).recommendedAction).toBe("Remux");
  });

  it("get another try when the preset's quality changes", () => {
    const marked = { ...probe, noGainEncodes: [encodeFingerprint(preset)] };
    expect(decide(marked, { ...preset, crf: 28 }).recommendedAction).toBe("HEVC");
  });

  it("keep the marker through a re-probe only while the file is unchanged", () => {
    const indexed = new Map([
      ["/a.mkv", { sizeBytes: 10, mtimeMs: 5, policyMetadata: { noGainEncodes: ["x"] } }],
      ["/b.mkv", { sizeBytes: 10, mtimeMs: 5, policyMetadata: { noGainEncodes: ["x"] } }],
    ]);
    const markers = unchangedFileMarkers([
      { path: "/a.mkv", sizeBytes: 10, mtimeMs: 5 },
      { path: "/b.mkv", sizeBytes: 11, mtimeMs: 6 },
    ], indexed);
    expect([...markers.keys()]).toEqual(["/a.mkv"]);
  });

  it("are no longer recommended once recorded", () => {
    const db = openDb(":memory:");
    const filesRepo = new FilesRepo(db);
    const config = ConfigSchema.parse({ libraries: [{ id: "cams", name: "Cams", path: "/media/cams", presetId: "balanced", minFileSizeMb: 0 }] });
    filesRepo.upsertFile({
      path: "/media/cams/a.mkv", libraryId: "cams", codec: "h264", container: "matroska", sizeBytes: probe.sizeBytes,
      durationSeconds: probe.durationSeconds, resolution: "1080p", width: 1080, height: 1440, bitrateKbps: 6174, bitDepth: 8,
      isHdr: false, audioCodec: "aac", audioChannels: 2, subtitleCount: 0, estimatedSavingsBytes: 1_000_000_000,
      recommendedAction: "HEVC", mtimeMs: 1, needsTranscode: true, skipReason: null,
      policyMetadata: { mediaKind: "video", fps: 59.94, audioTracks: probe.audioTracks, subtitleTracks: [] },
    });
    const balanced = config.presets.find((p) => p.id === "balanced")!;
    recordNoGainEncode(filesRepo, "/media/cams/a.mkv", balanced, config.libraries[0], config.presets);
    const file = filesRepo.getFileByPath("/media/cams/a.mkv")!;
    expect(file.needsTranscode).toBe(false);
    expect(file.recommendedAction).toBe("Keep");
    expect(file.policyMetadata?.noGainEncodes).toEqual([encodeFingerprint(balanced)]);
    db.close();
  });
});
