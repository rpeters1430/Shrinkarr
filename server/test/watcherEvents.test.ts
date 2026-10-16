import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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

const { LibraryWatcher, isIgnoredEventPath, isIgnoredEventType } = await import("../src/scanner/watcher.js");
type WatchFn = import("../src/scanner/watcher.js").WatchFn;

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

interface FakeWatch {
  path: string;
  fire: (filename: string | null) => void;
  fail: (err: Error) => void;
  closed: boolean;
}

function fakeWatchFn(): { watchFn: WatchFn; watches: FakeWatch[] } {
  const watches: FakeWatch[] = [];
  const watchFn: WatchFn = (path, _options, listener) => {
    let onError: (err: Error) => void = () => {};
    const w: FakeWatch = {
      path,
      fire: (filename) => listener("rename", filename),
      fail: (err) => onError(err),
      closed: false,
    };
    watches.push(w);
    return {
      close: () => { w.closed = true; },
      on: (_event, cb) => { onError = cb; },
    };
  };
  return { watchFn, watches };
}

let db: ReturnType<typeof openDb>;
let config: Config;
let filesRepo: FilesRepo;
let jobsRepo: JobsRepo;

// settleDelaySeconds 2 → an event check fires after 3s of quiet, well before
// the 10s initial sweep that start() also schedules.
const QUIET_MS = 3000;

beforeEach(() => {
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  config = getDefaultConfig();
  config.watcher = { ...config.watcher, enabled: true, events: true, settleDelaySeconds: 2 };
  config.libraries = [
    { id: "movies", name: "Movies", path: "/media/movies", mediaType: "movie", presetId: config.presets[0].id, autoOptimize: false },
    { id: "tv", name: "TV", path: "/media/tv", mediaType: "tv", presetId: config.presets[0].id, autoOptimize: false },
  ];
  probeFile.mockReset();
  probeFile.mockResolvedValue(probe);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("isIgnoredEventPath", () => {
  it("ignores our own temp files, partial downloads and sidecars", () => {
    expect(isIgnoredEventPath("Movie (2020)/Movie.shrinkarr.tmp.mkv")).toBe(true);
    expect(isIgnoredEventPath("Movie (2020)/Movie.mkv.shrinkarr.bak")).toBe(true);
    expect(isIgnoredEventPath("Movie (2020)/Movie.mkv.part")).toBe(true);
    expect(isIgnoredEventPath("Movie (2020)/Movie.nfo")).toBe(true);
    expect(isIgnoredEventPath("Movie (2020)/@eaDir/Movie.mkv")).toBe(true);
  });

  it("passes media files and directories", () => {
    expect(isIgnoredEventPath("Movie (2020)/Movie.mkv")).toBe(false);
    expect(isIgnoredEventPath("Show/Season 1")).toBe(false);
  });
});

describe("isIgnoredEventType", () => {
  it("ignores folder metadata changes but not new folders or media writes", () => {
    expect(isIgnoredEventType("change", "New Movie")).toBe(true);
    expect(isIgnoredEventType("rename", "New Movie")).toBe(false);
    expect(isIgnoredEventType("change", "New Movie/New Movie.mkv")).toBe(false);
    expect(isIgnoredEventType("rename", "New Movie/New Movie.mkv.part")).toBe(true);
  });
});

describe("LibraryWatcher filesystem events", () => {
  function startWatcher() {
    vi.useFakeTimers();
    const { watchFn, watches } = fakeWatchFn();
    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }), watchFn);
    const check = vi.spyOn(watcher, "checkLibraries").mockResolvedValue({ newFiles: 0, autoQueued: 0, deferred: 0 });
    watcher.start();
    return { watcher, watches, check };
  }

  it("opens one recursive watch per library", () => {
    const { watcher, watches } = startWatcher();
    expect(watches.map((w) => w.path)).toEqual(["/media/movies", "/media/tv"]);
    expect(watcher.getStatus().eventWatchedLibraries).toBe(2);
    watcher.stop();
  });

  it("checks only the changed library once it has been quiet", async () => {
    const { watcher, watches, check } = startWatcher();

    watches[0].fire("New Movie/New Movie.mkv");
    await vi.advanceTimersByTimeAsync(QUIET_MS - 500);
    watches[0].fire("New Movie/New Movie.mkv");
    await vi.advanceTimersByTimeAsync(QUIET_MS - 500);
    expect(check).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(["movies"]);
    watcher.stop();
  });

  it("ignores events for temp and partial files", async () => {
    const { watcher, watches, check } = startWatcher();
    watches[0].fire("Movie/Movie.shrinkarr.tmp.mkv");
    watches[0].fire("Movie/Movie.mkv.part");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(check).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("looks again while files are still settling, up to a limit", async () => {
    const { watcher, watches, check } = startWatcher();
    check.mockResolvedValueOnce({ newFiles: 0, autoQueued: 0, deferred: 1 });

    watches[0].fire("Movie/Movie.mkv");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(check).toHaveBeenCalledTimes(2);

    // Nothing deferred on the second pass, so no third.
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(check).toHaveBeenCalledTimes(2);

    // A file that never unlocks stops being retried.
    check.mockClear();
    check.mockResolvedValue({ newFiles: 0, autoQueued: 0, deferred: 1 });
    watches[1].fire("Show/S01E01.mkv");
    await vi.advanceTimersByTimeAsync(QUIET_MS * 30);
    expect(check.mock.calls.filter(([ids]) => ids?.[0] === "tv")).toHaveLength(21);
    watcher.stop();
  });

  it("retries when a full scan holds the lock", async () => {
    const { watcher, watches, check } = startWatcher();
    check.mockResolvedValueOnce({ newFiles: 0, autoQueued: 0, deferred: 0, busy: true });
    watches[0].fire("Movie/Movie.mkv");
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(check).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("falls back to interval sweeps when a watch errors or cannot start", () => {
    vi.useFakeTimers();
    const { watchFn, watches } = fakeWatchFn();
    const failing: WatchFn = (path, options, listener) => {
      if (path === "/media/tv") throw new Error("ENOSPC: System limit for number of file watchers reached");
      return watchFn(path, options, listener);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }), failing);
    watcher.start();
    expect(watcher.getStatus().eventWatchedLibraries).toBe(1);

    watches[0].fail(new Error("EPERM"));
    expect(watches[0].closed).toBe(true);
    expect(watcher.getStatus().eventWatchedLibraries).toBe(0);
    expect(watcher.getStatus().nextRunAt).not.toBeNull();
    watcher.stop();
    warn.mockRestore();
  });

  it("does not open watches when events are off", () => {
    config.watcher = { ...config.watcher, events: false };
    const { watcher, watches } = startWatcher();
    expect(watches).toHaveLength(0);
    watcher.stop();
  });

  it("closes watches and drops pending checks on stop", async () => {
    const { watcher, watches, check } = startWatcher();
    watches[0].fire("Movie/Movie.mkv");
    watcher.stop();
    expect(watches.every((w) => w.closed)).toBe(true);
    await vi.advanceTimersByTimeAsync(QUIET_MS * 5);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("LibraryWatcher.checkLibraries", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "shrinkarr-events-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans only the requested libraries", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await mkdir(join(root, "movies"));
    await mkdir(join(root, "tv"));
    await writeFile(join(root, "movies", "a.mkv"), "a");
    await writeFile(join(root, "tv", "b.mkv"), "b");
    await utimes(join(root, "movies", "a.mkv"), hourAgo, hourAgo);
    await utimes(join(root, "tv", "b.mkv"), hourAgo, hourAgo);
    config.libraries[0].path = join(root, "movies");
    config.libraries[1].path = join(root, "tv");

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }), fakeWatchFn().watchFn);
    const result = await watcher.checkLibraries(["movies"]);

    expect(result.newFiles).toBe(1);
    expect(probeFile).toHaveBeenCalledTimes(1);
    expect(probeFile).toHaveBeenCalledWith(join(root, "movies", "a.mkv"));
  });

  it("reports files still inside the settle window as deferred", async () => {
    await mkdir(join(root, "movies"));
    await writeFile(join(root, "movies", "downloading.mkv"), "partial");
    config.libraries[0].path = join(root, "movies");

    const watcher = new LibraryWatcher(() => ({ config, filesRepo, jobsRepo }), fakeWatchFn().watchFn);
    const result = await watcher.checkLibraries(["movies"]);

    expect(result.deferred).toBe(1);
    expect(probeFile).not.toHaveBeenCalled();
  });
});
