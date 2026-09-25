import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/utils/pool.js";

describe("runWithConcurrency", () => {
  it("visits every item once and never exceeds the limit", async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(item);
      inFlight -= 1;
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(runWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
  });
});
