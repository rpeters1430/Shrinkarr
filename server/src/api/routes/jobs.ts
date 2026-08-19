import type { FastifyInstance } from "fastify";
import type { JobStatus } from "../../db/jobsRepo.js";
import { isQueuePaused, setQueuePaused } from "../../queue/processor.js";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";

const VALID_STATUSES: JobStatus[] = ["pending", "running", "done", "failed", "cancelled"];

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { status?: string } }>("/api/jobs", async (request, reply) => {
    const { status } = request.query;
    if (status && !VALID_STATUSES.includes(status as JobStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}"` });
    }
    return fastify.ctx.jobsRepo.listJobs(status as JobStatus | undefined);
  });

  fastify.get("/api/queue/status", async () => {
    const jobs = fastify.ctx.jobsRepo.listJobs();
    const pending = jobs.filter((j) => j.status === "pending").length;
    const running = jobs.filter((j) => j.status === "running").length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;

    return {
      paused: isQueuePaused(),
      pending,
      running,
      done,
      failed,
      total: jobs.length,
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
}
