import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { JobStatus } from "../../db/jobsRepo.js";
import {
  isQueuePaused,
  setQueuePaused,
  getActiveProcessor,
  isWithinSchedule,
  getCurrentHourInTimezone,
} from "../../queue/processor.js";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";
import { planTracks, plannedTracks } from "../../scanner/trackPlan.js";
import { snapshotTracks, type MediaSnapshot } from "../../db/historyRepo.js";

const VALID_STATUSES: JobStatus[] = ["pending", "running", "done", "failed", "cancelled"];

function tracksOnly(snapshot: MediaSnapshot): Pick<MediaSnapshot, "audio" | "subtitles"> {
  return { audio: snapshot.audio, subtitles: snapshot.subtitles };
}

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>("/api/jobs", async (request, reply) => {
    const { status, limit, offset } = request.query;
    if (status && !VALID_STATUSES.includes(status as JobStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}"` });
    }
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const offsetNum = offset ? parseInt(offset, 10) : undefined;
    return fastify.ctx.jobsRepo.listJobs(status as JobStatus | undefined, limitNum, offsetNum, fastify.ctx.config.queue.order);
  });

  fastify.get<{ Params: { id: string } }>("/api/jobs/:id/log", async (request, reply) => {
    const log = fastify.ctx.jobsRepo.getLog(request.params.id);
    if (log === undefined) {
      return reply.code(404).send({ error: `Unknown job "${request.params.id}"` });
    }
    return { log: log ?? "" };
  });

  // A job's tracks before and after. Finished jobs return what History
  // recorded; waiting and running ones return the file's indexed tracks and
  // what the job's preset plans to make of them.
  fastify.get<{ Params: { id: string } }>("/api/jobs/:id/tracks", async (request, reply) => {
    const { jobsRepo, filesRepo, historyRepo, config } = fastify.ctx;
    const job = jobsRepo.getById(request.params.id);
    if (!job) return reply.code(404).send({ error: `Unknown job "${request.params.id}"` });
    if (job.kind === "health") return { source: "none", before: null, after: null, removed: [] };
    const recorded = historyRepo?.get(job.id);
    if (recorded?.before) {
      return { source: "recorded", before: tracksOnly(recorded.before), after: recorded.after ? tracksOnly(recorded.after) : null, removed: [] };
    }
    const metadata = filesRepo.getFileByPath(job.filePath)?.policyMetadata;
    const preset = config.presets.find((candidate) => candidate.id === job.presetId);
    const plan = preset ? planTracks(metadata, preset) : null;
    return {
      source: "planned",
      before: metadata?.audioTracks ? snapshotTracks(metadata) : null,
      after: preset ? plannedTracks(metadata, preset) : null,
      removed: plan?.removed ?? [],
    };
  });

  fastify.get("/api/queue/status", async () => {
    // Polled by the UI every few seconds, so count in SQL rather than loading
    // every job row ever recorded.
    const { jobsByStatus } = fastify.ctx.jobsRepo.getJobStats();
    const { pending, running, done, failed } = jobsByStatus;
    const total = Object.values(jobsByStatus).reduce((sum, count) => sum + count, 0);

    const proc = fastify.ctx.processor || getActiveProcessor();
    const concurrency = proc ? proc.getConcurrency() : (fastify.ctx.config?.queue?.concurrency ?? 1);

    const schedule = fastify.ctx.config?.queue?.schedule;
    const isWithin = isWithinSchedule(schedule);
    const tz = schedule?.timezone;
    const currentHour = getCurrentHourInTimezone(tz);

    return {
      paused: isQueuePaused(),
      streamingPaused: proc ? proc.isStreamingPaused() : false,
      pauseOnStreamingEnabled: Boolean(fastify.ctx.config?.queue?.pauseOnStreaming),
      pending,
      running,
      done,
      failed,
      total,
      concurrency,
      schedule: {
        enabled: Boolean(schedule?.enabled),
        isWithinSchedule: isWithin,
        startHour: schedule?.startHour ?? 1,
        endHour: schedule?.endHour ?? 7,
        windows: schedule?.windows ?? [],
        timezone: tz ?? "auto",
        serverHour: currentHour,
        serverTime: new Date().toLocaleTimeString("en-US", {
          timeZone: tz && tz !== "auto" ? tz : undefined,
          hour: "numeric",
          minute: "2-digit",
        }),
      },
    };
  });

  fastify.post("/api/queue/pause", async () => {
    setQueuePaused(true);
    return { paused: true };
  });

  fastify.post("/api/queue/resume", async () => {
    setQueuePaused(false);
    return { paused: false };
  });

  fastify.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const { jobsRepo } = fastify.ctx;
    const job = jobsRepo.getById(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Unknown job "${request.params.id}"` });
    }
    if (job.status !== "pending" && job.status !== "running") {
      return reply.code(409).send({ error: `Job is already ${job.status}` });
    }
    const proc = fastify.ctx.processor || getActiveProcessor();
    if (proc) {
      proc.cancelJob(job.id);
    }
    jobsRepo.markCancelled(job.id);
    return jobsRepo.getById(job.id);
  });

  fastify.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const { jobsRepo } = fastify.ctx;
    const job = jobsRepo.getById(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Unknown job "${request.params.id}"` });
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      return reply.code(409).send({ error: `Only failed or cancelled jobs can be retried; this job is ${job.status}` });
    }
    if (!existsSync(job.filePath)) {
      return reply.code(409).send({ error: `The file no longer exists: ${job.filePath}` });
    }
    if (!jobsRepo.requeueJob(job.id)) {
      return reply.code(409).send({ error: `A pending or running job already exists for "${job.filePath}"` });
    }
    return jobsRepo.getById(job.id);
  });

  // Requeues the newest failed job for each file. Files that have since been
  // deleted or already have a job in the queue are skipped.
  fastify.post("/api/jobs/retry-failed", async () => {
    const { jobsRepo } = fastify.ctx;
    let requeuedCount = 0;
    let skippedCount = 0;
    for (const job of jobsRepo.listJobs("failed")) {
      if (existsSync(job.filePath) && jobsRepo.requeueJob(job.id)) {
        requeuedCount++;
      } else {
        skippedCount++;
      }
    }
    return { requeuedCount, skippedCount };
  });

  fastify.post("/api/jobs/cancel-all", async () => {
    const cancelledCount = fastify.ctx.jobsRepo.cancelAllPending();
    return { cancelledCount };
  });

  fastify.post("/api/jobs/clear-history", async () => {
    const clearedCount = fastify.ctx.jobsRepo.clearHistory();
    return { clearedCount };
  });

  fastify.post<{ Body: { filePath: string; presetId?: string } }>("/api/jobs", async (request, reply) => {
    const { filePath, presetId } = request.body || {};
    const { config, jobsRepo, filesRepo } = fastify.ctx;

    if (!filePath) {
      return reply.code(400).send({ error: "filePath is required" });
    }
    if (!isPathInsideLibraries(filePath, config.libraries)) {
      return reply.code(400).send({ error: "filePath must be inside a configured library" });
    }

    const fileRec = filesRepo.getFileByPath(filePath);
    let targetPresetId = presetId;
    if (!targetPresetId && fileRec) {
      const lib = config.libraries.find((l) => l.id === fileRec.libraryId);
      targetPresetId = lib?.presetId;
    }
    if (!targetPresetId) {
      targetPresetId = config.presets[0]?.id ?? "balanced";
    }

    if (!config.presets.some((p) => p.id === targetPresetId)) {
      return reply.code(400).send({ error: `Unknown preset "${targetPresetId}"` });
    }
    if (jobsRepo.hasActiveJobForPath(filePath)) {
      return reply.code(409).send({ error: `A pending or running job already exists for "${filePath}"` });
    }

    const job = jobsRepo.enqueueJob(filePath, targetPresetId, fileRec?.sizeBytes ?? 0);
    return reply.code(201).send(job);
  });

  fastify.post<{ Body: { filePaths: string[]; presetId?: string } }>("/api/jobs/bulk", async (request, reply) => {
    const { filePaths, presetId } = request.body || {};
    const { config, jobsRepo, filesRepo } = fastify.ctx;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return reply.code(400).send({ error: "filePaths must be a non-empty array of file paths" });
    }

    const itemsToEnqueue: Array<{ filePath: string; presetId: string; originalSizeBytes: number }> = [];
    const skipped: string[] = [];

    for (const filePath of filePaths) {
      if (!isPathInsideLibraries(filePath, config.libraries)) {
        skipped.push(filePath);
        continue;
      }
      if (jobsRepo.hasActiveJobForPath(filePath)) {
        skipped.push(filePath);
        continue;
      }

      const fileRec = filesRepo.getFileByPath(filePath);
      let targetPresetId = presetId;
      if (!targetPresetId && fileRec) {
        const lib = config.libraries.find((l) => l.id === fileRec.libraryId);
        targetPresetId = lib?.presetId;
      }
      if (!targetPresetId) {
        targetPresetId = config.presets[0]?.id ?? "balanced";
      }

      if (!config.presets.some((p) => p.id === targetPresetId)) {
        skipped.push(filePath);
        continue;
      }

      itemsToEnqueue.push({
        filePath,
        presetId: targetPresetId,
        originalSizeBytes: fileRec?.sizeBytes ?? 0,
      });
    }

    const createdJobs = jobsRepo.enqueueJobsBatch(itemsToEnqueue);
    return reply.code(201).send({
      queued: createdJobs.length,
      skippedCount: skipped.length,
      jobs: createdJobs,
    });
  });
}
