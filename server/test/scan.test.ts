import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Library, Preset } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import type { MediaProbe } from "../src/media/types.js";

const probeFile = vi.fn<(path: string) => Promise<MediaProbe>>();
vi.mock("../src/media/ffprobe.js", () => ({ probeFile: (path: string) => probeFile(path) }));

const { scanLibrary } = await import("../src/scanner/scan.js");

const preset: Preset = {
  id: "hevc",
  name: "HEVC",
  mediaKind: "video",
  targetCodec: "hevc",
  targetContainer: "mkv",
  crf: 24,
  hwaccel: "cpu",
  bitDepth: 10,
  preserveHdr: true,
  audioMode: "copy",
  subtitleMode: "copy",
  targetAudioCodec: "opus",
  targetAudioBitrateKbps: 160,
  onlyIfLosslessSource: true,
  minSavingsPercent: 15,
  minFileSizeMb: 0,
  skipAlreadyTarget: true,
};

function h264Probe(): MediaProbe {
  return {
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
}

let root: string;
let library: Library;
let db: ReturnType<typeof openDb>;
let filesRepo: FilesRepo;
let jobsRepo: JobsRepo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shrinkarr-scan-"));
  library = { id: "lib", name: "Lib", path: root, mediaType: "movie", presetId: "hevc", autoOptimize: false };
  db = openDb(":memory:");
  filesRepo = new FilesRepo(db);
  jobsRepo = new JobsRepo(db);
  probeFile.mockReset();
  probeFile.mockImplementation(async () => h264Probe());
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

async function writeVideos(count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(root, `movie-${i}.mkv`);
    await writeFile(path, `video-${i}`);
    paths.push(path);
  }
  return paths;
}

describe("scanLibrary", () => {
  it("probes files in parallel up to the configured limit", async () => {
    await writeVideos(12);
    let inFlight = 0;
    let peak = 0;
    probeFile.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return h264Probe();
    });

    const result = await scanLibrary(library, preset, filesRepo, jobsRepo, { probeConcurrency: 3 });

    expect(peak).toBe(3);
    expect(result.indexedCount).toBe(12);
    expect(filesRepo.countFilesByLibrary("lib")).toBe(12);
  });

  it("skips ffprobe for files whose size and mtime are unchanged", async () => {
    await writeVideos(5);
    await scanLibrary(library, preset, filesRepo, jobsRepo);
    probeFile.mockClear();

    const result = await scanLibrary(library, preset, filesRepo, jobsRepo);

    expect(probeFile).not.toHaveBeenCalled();
    expect(result.indexedCount).toBe(5);
    expect(result.recommendedCount).toBe(5);
  });

  it("auto-queues each eligible file once across repeated scans", async () => {
    await writeVideos(4);

    const first = await scanLibrary(library, preset, filesRepo, jobsRepo, { autoQueue: true });
    const second = await scanLibrary(library, preset, filesRepo, jobsRepo, { autoQueue: true });

    expect(first.queuedCount).toBe(4);
    expect(second.queuedCount).toBe(0);
    expect(jobsRepo.countJobs("pending")).toBe(4);
  });

  it("keeps the index when a library that had files comes back empty", async () => {
    const [path] = await writeVideos(1);
    await scanLibrary(library, preset, filesRepo, jobsRepo);
    await rm(path);

    await scanLibrary(library, preset, filesRepo, jobsRepo);

    expect(filesRepo.countFilesByLibrary("lib")).toBe(1);
  });

  it("prunes deleted files when others remain", async () => {
    const [first] = await writeVideos(2);
    await scanLibrary(library, preset, filesRepo, jobsRepo);
    await rm(first);

    await scanLibrary(library, preset, filesRepo, jobsRepo);

    expect(filesRepo.countFilesByLibrary("lib")).toBe(1);
    expect(filesRepo.getFileByPath(first)).toBeUndefined();
  });

  it("omits per-file entries when collectEntries is false", async () => {
    await mkdir(join(root, "nested"));
    await writeVideos(3);

    const result = await scanLibrary(library, preset, filesRepo, jobsRepo, { collectEntries: false });

    expect(result.entries).toEqual([]);
    expect(result.indexedCount).toBe(3);
  });
});
