import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";

function writeTempYaml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents, "utf-8");
  return path;
}

const validYaml = `
libraries:
  - id: movies
    name: Movies
    path: /media/movies
    mediaType: movie
    presetId: hevc-save-space
presets:
  - id: hevc-save-space
    name: "H.265 to save space"
    targetCodec: hevc
    targetContainer: mkv
    crf: 24
    hwaccel: vaapi
    minSavingsPercent: 15
`;

describe("loadConfig", () => {
  it("loads a valid config", () => {
    const path = writeTempYaml(validYaml);
    const config = loadConfig(path);
    expect(config.libraries).toHaveLength(1);
    expect(config.presets[0]?.id).toBe("hevc-save-space");
    expect(config.queue.concurrency).toBe(1);
  });

  it("throws when library.path is missing", () => {
    const badYaml = `
libraries:
  - id: movies
    name: Movies
    mediaType: movie
    presetId: hevc-save-space
presets:
  - id: hevc-save-space
    name: "H.265 to save space"
    targetCodec: hevc
    targetContainer: mkv
    crf: 24
    hwaccel: vaapi
    minSavingsPercent: 15
`;
    const path = writeTempYaml(badYaml);
    expect(() => loadConfig(path)).toThrow();
  });

  it("throws when crf is out of range", () => {
    const badYaml = `
libraries:
  - id: movies
    name: Movies
    path: /media/movies
    mediaType: movie
    presetId: hevc-save-space
presets:
  - id: hevc-save-space
    name: "H.265 to save space"
    targetCodec: hevc
    targetContainer: mkv
    crf: 999
    hwaccel: vaapi
    minSavingsPercent: 15
`;
    const path = writeTempYaml(badYaml);
    expect(() => loadConfig(path)).toThrow();
  });

  it("generates and persists an API key when the config file has none", () => {
    const path = writeTempYaml(validYaml);
    const config = loadConfig(path);
    expect(config.apiKey).toBeDefined();
    expect(config.apiKey!.length).toBeGreaterThanOrEqual(16);

    // Reloading from disk should pick up the persisted key rather than generating a new one.
    const reloaded = loadConfig(path);
    expect(reloaded.apiKey).toBe(config.apiKey);
  });

  it("generates an API key for a brand-new config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-config-"));
    const path = join(dir, "config.yaml");
    const config = loadConfig(path);
    expect(config.apiKey).toBeDefined();
    expect(config.apiKey!.length).toBeGreaterThanOrEqual(16);
  });
});
