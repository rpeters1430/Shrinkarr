import { describe, it, expect } from "vitest";
import { detectAvailableDrives, findSuggestedMediaFolders } from "../src/api/routes/system.js";

describe("system drive detection", () => {
  it("returns available drives including Root", () => {
    const drives = detectAvailableDrives();
    expect(drives.length).toBeGreaterThan(0);
    expect(drives.some((d) => d.path === "/" || d.path === "C:\\")).toBe(true);
  });

  it("suggests media folders without throwing", () => {
    const suggestions = findSuggestedMediaFolders();
    expect(Array.isArray(suggestions)).toBe(true);
  }, 15000);
});
