import { describe, expect, it } from "vitest";
import { isWithinSchedule } from "../src/queue/processor.js";

describe("Queue schedule time window", () => {
  it("returns true if schedule is undefined or not enabled", () => {
    expect(isWithinSchedule(undefined)).toBe(true);
    expect(isWithinSchedule({ enabled: false, startHour: 1, endHour: 7 })).toBe(true);
  });

  it("handles daylight / daytime window correctly", () => {
    const currentHour = new Date().getHours();
    const activeSchedule = {
      enabled: true,
      startHour: currentHour,
      endHour: (currentHour + 1) % 24,
    };
    expect(isWithinSchedule(activeSchedule)).toBe(true);

    const inactiveSchedule = {
      enabled: true,
      startHour: (currentHour + 2) % 24,
      endHour: (currentHour + 3) % 24,
    };
    expect(isWithinSchedule(inactiveSchedule)).toBe(false);
  });

  it("handles overnight window spanning midnight", () => {
    const schedule = {
      enabled: true,
      startHour: 23,
      endHour: 6,
    };
    const currentHour = new Date().getHours();
    const expected = currentHour >= 23 || currentHour < 6;
    expect(isWithinSchedule(schedule)).toBe(expected);
  });
});
