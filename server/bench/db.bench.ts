import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { FilesRepo, type FileRecord } from "../src/db/filesRepo.js";
import { createBench, withCodSpeed } from "./harness.js";
import { makeProbes } from "./fixtures.js";

const bench = withCodSpeed(createBench("db/filesRepo"));

type NewFileRecord = Omit<FileRecord, "lastScannedAt">;

function makeFileRecords(count: number): NewFileRecord[] {
  const probes = makeProbes(count, 2024);
  return probes.map((probe, i) => ({
    path: `/media/library-${i % 8}/videos/Show ${i % 40}/Season ${i % 9}/episode-${i}.mkv`,
    libraryId: `library-${i % 8}`,
    codec: probe.videoCodec,
    container: probe.container,
    sizeBytes: probe.sizeBytes,
    durationSeconds: probe.durationSeconds,
    resolution: probe.resolutionLabel,
    width: probe.width,
    height: probe.height,
    bitrateKbps: probe.bitrateKbps,
    bitDepth: probe.bitDepth,
    isHdr: probe.isHdr,
    audioCodec: probe.audioCodec,
    audioChannels: probe.audioChannels,
    subtitleCount: probe.subtitleCount,
    estimatedSavingsBytes: Math.round(probe.sizeBytes * 0.35),
    recommendedAction: i % 3 === 0 ? "Keep" : "HEVC",
    needsTranscode: i % 3 !== 0,
    skipReason: i % 3 === 0 ? "already target / efficient codec" : null,
  }));
}

const insertBatch = makeFileRecords(250);
const seedRecords = makeFileRecords(2_000);

let writeDb: DatabaseSync | undefined;
let writeRepo: FilesRepo | undefined;

let readDb: DatabaseSync | undefined;
let readRepo: FilesRepo | undefined;

bench.add(
  "upsert 250 scanned files into a fresh database",
  () => {
    for (const record of insertBatch) {
      writeRepo!.upsertFile(record);
    }
  },
  {
    beforeEach: () => {
      writeDb = openDb(":memory:");
      writeRepo = new FilesRepo(writeDb);
    },
    afterEach: () => {
      writeDb?.close();
      writeDb = undefined;
      writeRepo = undefined;
    },
  },
);

const readHooks = {
  beforeAll: () => {
    readDb = openDb(":memory:");
    readRepo = new FilesRepo(readDb);
    for (const record of seedRecords) {
      readRepo.upsertFile(record);
    }
  },
  afterAll: () => {
    readDb?.close();
    readDb = undefined;
    readRepo = undefined;
  },
};

bench.add(
  "getAllFiles over 2000 rows",
  () => {
    return readRepo!.getAllFiles().length;
  },
  readHooks,
);

bench.add(
  "getFilesByLibrary over 2000 rows",
  () => {
    return readRepo!.getFilesByLibrary("library-3").length;
  },
  readHooks,
);

bench.add(
  "getEligibleFiles over 2000 rows",
  () => {
    return readRepo!.getEligibleFiles().length;
  },
  readHooks,
);

export default bench;
