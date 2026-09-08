import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { statsRoutes } from "../src/api/routes/stats.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema } from "../src/config/schema.js";
import { createBench, withCodSpeed } from "./harness.js";
import { makeLibraries, makeProbes } from "./fixtures.js";

const bench = withCodSpeed(createBench("api/stats"));

const LIBRARY_COUNT = 8;
const FILE_COUNT = 1_500;
const JOB_COUNT = 200;

let db: DatabaseSync | undefined;
let app: FastifyInstance | undefined;

async function setup(): Promise<void> {
  db = openDb(":memory:");
  const filesRepo = new FilesRepo(db);
  const jobsRepo = new JobsRepo(db);

  const probes = makeProbes(FILE_COUNT, 7);
  probes.forEach((probe, i) => {
    filesRepo.upsertFile({
      path: `/media/library-${i % LIBRARY_COUNT}/videos/Show ${i % 40}/episode-${i}.mkv`,
      libraryId: `library-${i % LIBRARY_COUNT}`,
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
      skipReason: null,
    });
  });

  for (let i = 0; i < JOB_COUNT; i += 1) {
    const job = jobsRepo.enqueueJob(
      `/media/library-${i % LIBRARY_COUNT}/videos/Show ${i % 40}/episode-${i}.mkv`,
      "hevc-save-space",
      probes[i].sizeBytes,
    );
    if (i % 2 === 0) {
      jobsRepo.markDone(job.id, Math.round(probes[i].sizeBytes * 0.6));
    } else if (i % 5 === 0) {
      jobsRepo.markFailed(job.id, "ffmpeg exited with code 1");
    }
  }

  const ctx: AppContext = {
    config: ConfigSchema.parse({ libraries: makeLibraries(LIBRARY_COUNT), dbPath: ":memory:" }),
    configPath: "config/config.yaml",
    filesRepo,
    jobsRepo,
  };

  const fastify = Fastify({ logger: false });
  fastify.decorate("ctx", ctx);
  await fastify.register(statsRoutes);
  await fastify.ready();
  app = fastify;
}

async function teardown(): Promise<void> {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
}

bench.add(
  "GET /api/stats over 1500 files and 200 jobs",
  async () => {
    const response = await app!.inject({ method: "GET", url: "/api/stats" });
    return response.statusCode;
  },
  { beforeAll: setup, afterAll: teardown },
);

export default bench;
