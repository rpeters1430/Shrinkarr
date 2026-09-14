import { describe, expect, it } from "vitest";
import { QueueScheduleSchema } from "../src/config/schema.js";

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
