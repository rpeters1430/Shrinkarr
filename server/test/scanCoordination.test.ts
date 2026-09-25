import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../src/config/loader.js";
import type { Config, Library } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import type { MediaProbe } from "../src/media/types.js";

const probeFile = vi.fn<(path: string) => Promise<MediaProbe>>();
vi.mock("../src/media/ffprobe.js", () => ({ probeFile: (path: string) => probeFile(path) }));

const { scanCoordinator } = await import("../src/scanner/coordinator.js");
const { LibraryWatcher } = await import("../src/scanner/watcher.js");
const { getScanProgress } = await import("../src/scanner/tracker.js");
const { isScanLockHeld } = await import("../src/scanner/scanLock.js");

const probe: MediaProbe = {
  mediaKind: "video",
  durationSeconds: 120,
  sizeBytes: 1_000_000,
  videoCodec: "h264",
  container: "matroska",
  width: 1920,
  height: 1080,
  resolutionLabel: "1080p",
  bitrateKbps: 8000,
  bitDepth: 8,
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

async function makeLibrary(name: string, files: number): Promise<Library> {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(dir));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < files; i++) {
    const path = join(dir, `${name}-${i}.mkv`);
    await writeFile(path, `video-${i}`);
    await utimes(path, old, old);
  }
  return { id: name, name, path: dir, mediaType: "movie", presetId: config.presets[0].id, autoOptimize: false };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shrinkarr-coord-"));
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  config = getDefaultConfig();
  probeFile.mockReset();
  probeFile.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 2));
    return probe;
  });
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("scan coordination", () => {
  it("finishes a multi-library batch with progress marked complete", async () => {
    const libs = [await makeLibrary("a", 3), await makeLibrary("b", 2), await makeLibrary("c", 4)];
    const preset = config.presets[0];

    const results = await Promise.all(libs.map((lib) => scanCoordinator.enqueueScan(lib, preset, filesRepo, jobsRepo)));

    expect(results.map((r) => r.indexedCount)).toEqual([3, 2, 4]);
    const progress = getScanProgress();
    expect(progress.isScanning).toBe(false);
    expect(progress.phase).toBe("complete");
    expect(isScanLockHeld()).toBe(false);
  });

  it("ignores a second request for a library that is already scanning", async () => {
    const lib = await makeLibrary("dup", 3);
    const preset = config.presets[0];

    const first = scanCoordinator.enqueueScan(lib, preset, filesRepo, jobsRepo);
    const second = await scanCoordinator.enqueueScan(lib, preset, filesRepo, jobsRepo);

    expect(second.indexedCount).toBe(0);
    expect((await first).indexedCount).toBe(3);
    expect(getScanProgress().isScanning).toBe(false);
  });

  it("skips a watcher sweep while a full scan is running", async () => {
    const lib = await makeLibrary("full", 5);
    config.libraries = [lib];
    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));

    const scan = scanCoordinator.enqueueScan(lib, config.presets[0], filesRepo, jobsRepo);
    const sweep = await watcher.checkAllLibraries();
    await scan;

    expect(sweep.busy).toBe(true);
    expect(probeFile).toHaveBeenCalledTimes(5);
  });

  it("makes a full scan wait for a running watcher sweep", async () => {
    const lib = await makeLibrary("sweep", 4);
    config.libraries = [lib];
    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }));

    const sweep = watcher.checkAllLibraries();
    await vi.waitFor(() => expect(isScanLockHeld()).toBe(true));
    const scan = scanCoordinator.enqueueScan(lib, config.presets[0], filesRepo, jobsRepo);

    expect((await sweep).newFiles).toBe(4);
    const result = await scan;

    // The sweep indexed everything, so the full scan resolves from the cache.
    expect(probeFile).toHaveBeenCalledTimes(4);
    expect(result.indexedCount).toBe(4);
    expect(getScanProgress().isScanning).toBe(false);
  });
});
