import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../src/config/loader.js";
import type { Config } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import type { MediaProbe } from "../src/media/types.js";

const probeFile = vi.fn<(path: string) => Promise<MediaProbe>>();
vi.mock("../src/media/ffprobe.js", () => ({ probeFile: (path: string) => probeFile(path) }));

const { LibraryWatcher } = await import("../src/scanner/watcher.js");

const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 120,
  sizeBytes: 1_000_000,
  videoCodec: "hevc",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 4000,
  bitDepth: 10,
  isHdr: false,
  fps: 24,
  audioCodec: "aac",
  audioChannels: 2,
  subtitleCount: 0,
};

let root: string;
let db: ReturnType<typeof openDb>;
let config: Config;
let filesRepo: FilesRepo;
let jobsRepo: JobsRepo;

const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shrinkarr-watch-"));
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  config = getDefaultConfig();
  config.libraries = [
    { id: "lib", name: "Lib", path: root, mediaType: "movie", presetId: config.presets[0].id, autoOptimize: false },
  ];
  probeFile.mockReset();
  probeFile.mockResolvedValue(probe);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("LibraryWatcher incremental scan", () => {
  it("re-probes files replaced in place and leaves unchanged files alone", async () => {
    const kept = join(root, "kept.mkv");
    const upgraded = join(root, "upgraded.mkv");
    await writeFile(kept, "a");
    await writeFile(upgraded, "b");
    await utimes(kept, hourAgo(), hourAgo());
    await utimes(upgraded, hourAgo(), hourAgo());

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
    await watcher.checkAllLibraries();
    expect(probeFile).toHaveBeenCalledTimes(2);

    probeFile.mockClear();
    await writeFile(upgraded, "a larger replacement file");
    await utimes(upgraded, hourAgo(), hourAgo());
    const result = await watcher.checkAllLibraries();

    expect(probeFile).toHaveBeenCalledTimes(1);
    expect(probeFile).toHaveBeenCalledWith(upgraded);
    expect(result.newFiles).toBe(1);
    expect(filesRepo.getFileByPath(upgraded)?.sizeBytes).toBe(25);
  });

  it("uses the matched rule preset for watcher auto-queueing", async () => {
    const filePath = join(root, "rule-match.mkv");
    await writeFile(filePath, "settled video");
    await utimes(filePath, hourAgo(), hourAgo());
    config.presets[0] = { ...config.presets[0], minFileSizeMb: 0, minSavingsPercent: 0 };
    const alternatePreset = { ...config.presets[0], id: "watcher-rule-preset", name: "Watcher rule preset" };
    config.presets.push(alternatePreset);
    config.libraries[0] = {
      ...config.libraries[0],
      autoOptimize: true,
      rules: [{
        id: "all-video",
        name: "All video",
        enabled: true,
        conditions: [{ field: "mediaKind", operator: "equals", value: "video" }],
        action: { type: "preset", presetId: alternatePreset.id },
      }],
    };
    probeFile.mockResolvedValue({ ...probe, videoCodec: "h264" });

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
    const result = await watcher.checkAllLibraries();

    expect(result.autoQueued).toBe(1);
    expect(jobsRepo.listJobs()[0].presetId).toBe(alternatePreset.id);
    expect(filesRepo.getFileByPath(filePath)?.policyMetadata?.mediaKind).toBe("video");
  });

  it("defers files modified inside the settle window", async () => {
    await writeFile(join(root, "downloading.mkv"), "partial");

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
    await watcher.checkAllLibraries();

    expect(probeFile).not.toHaveBeenCalled();
  });

  it("does not re-probe files that failed ffprobe on subsequent sweeps unless modified or forced", async () => {
    const corrupt = join(root, "corrupt.mkv");
    await writeFile(corrupt, "broken video data");
    await utimes(corrupt, hourAgo(), hourAgo());

    probeFile.mockRejectedValueOnce(new Error("ffprobe exited with code 1: moov atom not found"));

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
    await watcher.checkAllLibraries();

    expect(probeFile).toHaveBeenCalledTimes(1);

    // Second sweep: file is unchanged, so it should not be re-probed
    probeFile.mockClear();
    await watcher.checkAllLibraries();
    expect(probeFile).not.toHaveBeenCalled();

    // Forced sweep: should re-probe
    await watcher.checkAllLibraries({ forceScan: true });
    expect(probeFile).toHaveBeenCalledTimes(1);
  });
});

describe("LibraryWatcher lifecycle", () => {
  it("does not schedule another sweep after being stopped", () => {
    vi.useFakeTimers();
    try {
      config.watcher = { ...config.watcher, enabled: true, intervalMinutes: 1 };
      const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
      const sweep = vi.spyOn(watcher, "checkAllLibraries").mockResolvedValue({ newFiles: 0, autoQueued: 0 });

      watcher.start();
      watcher.stop();
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(sweep).not.toHaveBeenCalled();
      expect(watcher.getStatus().nextRunAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a single sweep loop when restarted while a sweep is running", async () => {
    vi.useFakeTimers();
    try {
      config.watcher = { ...config.watcher, enabled: true, intervalMinutes: 1 };
      const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
      let release: () => void = () => {};
      const sweep = vi.spyOn(watcher, "checkAllLibraries").mockImplementation(() => {
        if (sweep.mock.calls.length === 2) {
          return new Promise((resolve) => {
            release = () => resolve({ newFiles: 0, autoQueued: 0 });
          });
        }
        return Promise.resolve({ newFiles: 0, autoQueued: 0 });
      });

      watcher.start();
      await vi.advanceTimersByTimeAsync(60_000); // startup sweep (1) + first scheduled sweep (2), still running
      expect(sweep).toHaveBeenCalledTimes(2);

      watcher.stop();
      watcher.start();
      release();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60_000); // startup sweep (3) + scheduled sweep (4)
      await vi.advanceTimersByTimeAsync(60_000); // one scheduled sweep (5)
      expect(sweep).toHaveBeenCalledTimes(5);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
