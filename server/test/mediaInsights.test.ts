import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { FilesRepo, type NewFileRecord } from "../src/db/filesRepo.js";

let db: DatabaseSync;
let filesRepo: FilesRepo;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-insights-"));
  db = openDb(join(dir, "test.db"));
  filesRepo = new FilesRepo(db);
});

afterEach(() => {
  db.close();
});

function video(path: string, overrides: Partial<NewFileRecord> = {}): NewFileRecord {
  return {
    path,
    libraryId: "movies",
    codec: "h264",
    container: "mkv",
    sizeBytes: 4_000_000_000,
    durationSeconds: 7200,
    resolution: "1080p",
    width: 1920,
    height: 1080,
    bitrateKbps: 4444,
    bitDepth: 8,
    isHdr: false,
    audioCodec: "ac3",
    audioChannels: 6,
    subtitleCount: 2,
    estimatedSavingsBytes: 1_500_000_000,
    recommendedAction: "Transcode",
    needsTranscode: true,
    skipReason: null,
    policyMetadata: { mediaKind: "video", fps: 24, colorTransfer: null },
    ...overrides,
  };
}

describe("FilesRepo.getMediaInsights", () => {
  beforeEach(() => {
    filesRepo.upsertFile(video("/movies/a.mkv"));
    filesRepo.upsertFile(video("/movies/b.mkv", {
      codec: "hevc",
      resolution: "4K",
      width: 3840,
      height: 2160,
      sizeBytes: 20_000_000_000,
      bitrateKbps: 22222,
      bitDepth: 10,
      isHdr: true,
      audioChannels: 8,
      audioCodec: "truehd",
      estimatedSavingsBytes: 0,
      recommendedAction: "Keep",
      needsTranscode: false,
      policyMetadata: { mediaKind: "video", fps: 24, colorTransfer: "arib-std-b67" },
    }));
    filesRepo.upsertFile(video("/movies/c.avi", {
      codec: "mpeg4",
      container: "avi",
      resolution: "SD",
      width: 640,
      height: 352,
      sizeBytes: 700_000_000,
      durationSeconds: 5400,
      bitrateKbps: 1037,
      audioCodec: "mp3",
      audioChannels: 2,
      subtitleCount: 0,
      estimatedSavingsBytes: 200_000_000,
    }));
    filesRepo.upsertFile(video("/tv/s01e01.mkv", { libraryId: "tv", sizeBytes: 1_000_000_000, durationSeconds: 2700 }));
    filesRepo.upsertFile({
      ...video("/music/song.flac", {
        libraryId: "music",
        codec: "flac",
        container: "flac",
        resolution: "SD",
        width: 0,
        height: 0,
        sizeBytes: 30_000_000,
        durationSeconds: 240,
        audioCodec: "flac",
        audioChannels: 2,
        subtitleCount: 0,
        policyMetadata: { mediaKind: "audio", fps: 0 },
      }),
    });
  });

  it("summarizes the whole index and keeps music out of the video breakdowns", () => {
    const insights = filesRepo.getMediaInsights();
    expect(insights.totals.files).toBe(5);
    expect(insights.totals.videoFiles).toBe(4);
    expect(insights.totals.audioFiles).toBe(1);
    expect(insights.totals.hdrCount).toBe(1);
    expect(insights.totals.tenBitCount).toBe(1);
    expect(insights.totals.legacyCodecCount).toBe(1);
    expect(insights.totals.belowHdCount).toBe(1);
    expect(insights.totals.withoutSubtitlesCount).toBe(1);
    expect(insights.videoCodecs.map((b) => b.key).sort()).toEqual(["h264", "hevc", "mpeg4"]);
    expect(insights.dynamicRange.find((b) => b.key === "HLG")?.count).toBe(1);
    expect(insights.resolutions.map((b) => b.key)).toEqual(["4K", "1080p", "SD"]);
    expect(insights.audioChannels.find((b) => b.key === "7.1")?.count).toBe(1);
  });

  it("scopes every number to one library", () => {
    const insights = filesRepo.getMediaInsights("tv");
    expect(insights.libraryId).toBe("tv");
    expect(insights.totals.files).toBe(1);
    expect(insights.largestFiles.map((f) => f.path)).toEqual(["/tv/s01e01.mkv"]);
  });

  it("counts potential savings only for files that can still be queued", () => {
    filesRepo.setHealth("/movies/c.avi", "corrupt", "quick", "broken");
    const insights = filesRepo.getMediaInsights("movies");
    expect(insights.totals.potentialSavingsBytes).toBe(1_500_000_000);
    expect(insights.videoCodecs.find((b) => b.key === "mpeg4")?.potentialSavingsBytes).toBe(0);
  });

  it("ranks files against the average bitrate for their resolution", () => {
    for (const name of ["d", "e"]) filesRepo.upsertFile(video(`/movies/${name}.mkv`));
    filesRepo.upsertFile(video("/movies/bloated.mkv", { bitrateKbps: 13332, sizeBytes: 12_000_000_000 }));
    const insights = filesRepo.getMediaInsights("movies");
    // 1080p files: 4444 x 3 and 13332 -> average 6666, so the bloated one is 2x.
    expect(insights.highestBitrateForSize[0]).toMatchObject({ path: "/movies/bloated.mkv", bitrateVsAverage: 2 });
    // The lone 4K and SD files have no peers to compare against.
    expect(insights.highestBitrateForSize.map((f) => f.resolution)).toEqual(["1080p"]);
    expect(insights.largestFiles[0].path).toBe("/movies/b.mkv");
  });

  it("reports size per hour by codec and resolution", () => {
    const row = filesRepo.getMediaInsights("movies").efficiency.find((r) => r.codec === "h264" && r.resolution === "1080p");
    expect(row?.bytesPerHour).toBe(2_000_000_000);
    expect(row?.avgBitrateKbps).toBe(4444);
  });
});
