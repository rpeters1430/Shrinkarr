import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInsideLibraries } from "../src/scanner/pathGuard.js";
import type { Library } from "../src/config/schema.js";

const libraries: Library[] = [
  { id: "movies", name: "Movies", path: resolve("/media/movies"), mediaType: "movie", presetId: "balanced" },
  { id: "tv", name: "TV", path: resolve("/media/tv"), mediaType: "tv", presetId: "balanced" },
];

describe("isPathInsideLibraries", () => {
  it("allows a file directly inside a library", () => {
    expect(isPathInsideLibraries(resolve("/media/movies/Inception.mkv"), libraries)).toBe(true);
  });

  it("allows a file nested in a subdirectory of a library", () => {
    expect(isPathInsideLibraries(resolve("/media/tv/Show/Season 1/e01.mkv"), libraries)).toBe(true);
  });

  it("rejects a file outside any configured library", () => {
    expect(isPathInsideLibraries(resolve("/etc/passwd"), libraries)).toBe(false);
  });

  it("rejects a sibling directory that merely shares a path prefix", () => {
    expect(isPathInsideLibraries(resolve("/media/movies-private/secret.mkv"), libraries)).toBe(false);
  });

  it("rejects path traversal attempts out of a library root", () => {
    expect(isPathInsideLibraries(resolve("/media/movies/../../etc/passwd"), libraries)).toBe(false);
  });

  it("returns false when no libraries are configured", () => {
    expect(isPathInsideLibraries(resolve("/media/movies/Inception.mkv"), [])).toBe(false);
  });
});
