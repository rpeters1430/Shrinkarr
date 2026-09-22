import { describe, expect, it } from "vitest";
import { needsSettleObservation } from "../src/scanner/watcher.js";

describe("watcher settle detection", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");

  it("indexes established library files on their first discovery pass", () => {
    const oneHourOld = now - 60 * 60 * 1000;

    expect(needsSettleObservation(oneHourOld, now, 15)).toBe(false);
  });

  it("defers files modified inside the settle window", () => {
    const fiveSecondsOld = now - 5 * 1000;

    expect(needsSettleObservation(fiveSecondsOld, now, 15)).toBe(true);
  });
});
