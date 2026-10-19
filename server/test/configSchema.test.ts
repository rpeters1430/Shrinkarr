import { describe, expect, it } from "vitest";
import { ConfigSchema, QueueScheduleSchema } from "../src/config/schema.js";

describe("QueueScheduleSchema windows", () => {
  it("accepts up to 8 windows on the same day", () => {
    const windows = Array.from({ length: 8 }, (_, i) => ({
      day: 1,
      enabled: true,
      start: `0${i}:00`.slice(-5),
      end: `0${i}:30`.slice(-5),
    }));
    expect(QueueScheduleSchema.safeParse({ enabled: true, windows }).success).toBe(true);
  });

  it("rejects more than 8 windows on the same day even under the 56 total cap", () => {
    const windows = Array.from({ length: 9 }, (_, i) => ({
      day: 1,
      enabled: true,
      start: `0${i}:00`.slice(-5),
      end: `0${i}:30`.slice(-5),
    }));
    const result = QueueScheduleSchema.safeParse({ enabled: true, windows });
    expect(result.success).toBe(false);
  });

  it("allows 8-per-day windows spread across multiple days", () => {
    const windows = Array.from({ length: 40 }, (_, i) => ({
      day: i % 5,
      enabled: true,
      start: "07:00",
      end: "09:00",
    }));
    expect(QueueScheduleSchema.safeParse({ enabled: true, windows }).success).toBe(true);
  });
});

describe("optional video quality gate", () => {
  it("defaults to disabled and accepts a bounded SSIM threshold", () => {
    const result = ConfigSchema.parse({});
    expect(result.queue.qualityGate).toEqual({ enabled: false, minimumSsim: 0.95 });
    expect(ConfigSchema.safeParse({ queue: { qualityGate: { enabled: true, minimumSsim: 0.97 } } }).success).toBe(true);
  });

  it("rejects SSIM thresholds outside zero to one", () => {
    expect(ConfigSchema.safeParse({ queue: { qualityGate: { enabled: true, minimumSsim: 1.1 } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ queue: { qualityGate: { enabled: true, minimumSsim: -0.1 } } }).success).toBe(false);
  });
});

describe("library rules", () => {
  const matchingRule = {
    id: "large-video",
    name: "Large video",
    enabled: true,
    conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
    action: { type: "preset", presetId: "balanced" },
  };
  const library = (rules: unknown[]) => ({
    libraries: [{ id: "movies", name: "Movies", path: "/media/movies", rules }],
  });

  it("preserves an ordered library rule with a compatible preset", () => {
    const result = ConfigSchema.safeParse(library([matchingRule]));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.libraries[0].rules).toEqual([matchingRule]);
  });

  it("rejects duplicate rule IDs and empty conditions", () => {
    expect(ConfigSchema.safeParse(library([matchingRule, matchingRule])).success).toBe(false);
    expect(ConfigSchema.safeParse(library([{ ...matchingRule, conditions: [] }])).success).toBe(false);
  });

  it("rejects operator/value combinations that do not match a field", () => {
    expect(ConfigSchema.safeParse(library([{
      ...matchingRule,
      conditions: [{ field: "sizeBytes", operator: "contains", value: "large" }],
    }])).success).toBe(false);
    expect(ConfigSchema.safeParse(library([{
      ...matchingRule,
      conditions: [{ field: "durationSeconds", operator: "between", value: [120, 60] }],
    }])).success).toBe(false);
  });

  it("requires preset rules to include a media kind compatible with the preset", () => {
    expect(ConfigSchema.safeParse(library([{
      ...matchingRule,
      conditions: [{ field: "mediaKind", operator: "equals", value: "audio" }],
    }])).success).toBe(false);
    expect(ConfigSchema.safeParse(library([{
      ...matchingRule,
      conditions: [{ field: "container", operator: "equals", value: "mkv" }],
    }])).success).toBe(false);
  });

  it("rejects rules that target media kinds the library scan does not index", () => {
    const audioPreset = { id: "audio-opus", name: "Audio Opus", mediaKind: "audio" };
    const audioAction = {
      id: "audio-rule", name: "Audio rule", enabled: true,
      conditions: [{ field: "mediaKind", operator: "equals", value: "audio" }],
      action: { type: "preset", presetId: "audio-opus" },
    };
    const audioKeep = {
      id: "audio-keep", name: "Audio keep", enabled: true,
      conditions: [{ field: "mediaKind", operator: "equals", value: "audio" }],
      action: { type: "keep" },
    };
    expect(ConfigSchema.safeParse({
      ...library([audioAction]),
      presets: [{ id: "balanced", name: "Balanced", mediaKind: "video" }, audioPreset],
    }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...library([audioKeep]) }).success).toBe(false);
    expect(ConfigSchema.safeParse(library([{
      ...matchingRule,
      conditions: [{ field: "mediaKind", operator: "oneOf", value: ["video", "audio"] }],
    }])).success).toBe(true);
  });

  it("accepts Keep rules without a preset-kind condition", () => {
    expect(ConfigSchema.safeParse(library([{
      id: "keep-samples",
      name: "Keep samples",
      enabled: true,
      conditions: [{ field: "path", operator: "glob", value: "**/*sample*" }],
      action: { type: "keep" },
    }])).success).toBe(true);
  });

  it("caps rules and conditions to keep evaluation work bounded", () => {
    const rule = {
      ...matchingRule,
      conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
    };
    expect(ConfigSchema.safeParse(library(Array.from({ length: 101 }, (_, index) => ({ ...rule, id: `rule-${index}` })))).success).toBe(false);
    expect(ConfigSchema.safeParse(library([{ ...rule, conditions: Array.from({ length: 17 }, () => rule.conditions[0]) }])).success).toBe(false);
  });
});
