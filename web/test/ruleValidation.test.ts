import { describe, expect, it } from "vitest";
import type { LibraryRule, Preset } from "../src/api/client";
import { validateLibraryRules } from "../src/ruleValidation";

const presets: Preset[] = [
  { id: "video-balanced", name: "Video Balanced", mediaKind: "video", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", minSavingsPercent: 20 },
  { id: "audio-small", name: "Audio Small", mediaKind: "audio", targetCodec: "hevc", targetContainer: "mkv", crf: 24, hwaccel: "cpu", minSavingsPercent: 20 },
];

function rule(condition: LibraryRule["conditions"][number], action: LibraryRule["action"] = { type: "keep" }): LibraryRule {
  return { id: "rule-1", name: "Example", enabled: true, conditions: [condition], action };
}

describe("library rule editor validation", () => {
  it("accepts valid numeric ranges and path globs", () => {
    expect(validateLibraryRules([
      rule({ field: "sizeBytes", operator: "between", value: [100, 500] }),
      { ...rule({ field: "path", operator: "glob", value: "**/*.mkv" }), id: "rule-2" },
    ], presets)).toBeNull();
  });

  it("rejects malformed values before previewing or saving", () => {
    expect(validateLibraryRules([rule({ field: "width", operator: "between", value: [2160, 1080] })], presets)).toContain("two ordered bounds");
    expect(validateLibraryRules([rule({ field: "sizeBytes", operator: "greaterThan", value: Number.NaN })], presets)).toContain("non-negative numeric values");
    expect(validateLibraryRules([rule({ field: "container", operator: "oneOf", value: ["", "mkv"] })], presets)).toContain("non-empty text");
    expect(validateLibraryRules([rule({ field: "mediaKind", operator: "equals", value: "music" as "audio" })], presets)).toContain("video” or “audio");
  });

  it("requires a media-kind compatible preset action", () => {
    expect(validateLibraryRules([rule({ field: "path", operator: "contains", value: "Film" }, { type: "preset", presetId: "video-balanced" })], presets)).toContain("media kind condition");
    expect(validateLibraryRules([rule({ field: "mediaKind", operator: "equals", value: "audio" }, { type: "preset", presetId: "video-balanced" })], presets)).toContain("does not index");
    expect(validateLibraryRules([rule({ field: "mediaKind", operator: "equals", value: "video" }, { type: "preset", presetId: "video-balanced" })], presets)).toBeNull();
    expect(validateLibraryRules([rule({ field: "mediaKind", operator: "oneOf", value: ["video", "audio"] }, { type: "preset", presetId: "video-balanced" })], presets)).toBeNull();
    expect(validateLibraryRules([rule({ field: "mediaKind", operator: "equals", value: "audio" }, { type: "preset", presetId: "audio-small" })], presets, "audio")).toBeNull();
  });
});
