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

const VALID_STATUSES: JobStatus[] = ["pending", "running", "done", "failed", "cancelled"];

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>("/api/jobs", async (request, reply) => {
    const { status, limit, offset } = request.query;
    if (status && !VALID_STATUSES.includes(status as JobStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}"` });
    }
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const offsetNum = offset ? parseInt(offset, 10) : undefined;
    return fastify.ctx.jobsRepo.listJobs(status as JobStatus | undefined, limitNum, offsetNum);
  });

  fastify.get("/api/queue/status", async () => {
    const jobs = fastify.ctx.jobsRepo.listJobs();
    const pending = jobs.filter((j) => j.status === "pending").length;
    const running = jobs.filter((j) => j.status === "running").length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;

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
      total: jobs.length,
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
    const proc = fastify.ctx.processor || getActiveProcessor();
    if (proc) {
      proc.cancelJob(job.id);
    }
    jobsRepo.markCancelled(job.id);
    return jobsRepo.getById(job.id);
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
