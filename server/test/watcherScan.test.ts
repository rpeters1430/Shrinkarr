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

  it("defers files modified inside the settle window", async () => {
    await writeFile(join(root, "downloading.mkv"), "partial");

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));
    await watcher.checkAllLibraries();

    expect(probeFile).not.toHaveBeenCalled();
  });
});
