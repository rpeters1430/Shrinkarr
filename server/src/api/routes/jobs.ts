import type { FastifyInstance } from "fastify";
import type { JobStatus } from "../../db/jobsRepo.js";

const VALID_STATUSES: JobStatus[] = ["pending", "running", "done", "failed", "cancelled"];

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { status?: string } }>("/api/jobs", async (request, reply) => {
    const { status } = request.query;
    if (status && !VALID_STATUSES.includes(status as JobStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}"` });
    }
    return fastify.ctx.jobsRepo.listJobs(status as JobStatus | undefined);
  });

  fastify.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const { jobsRepo } = fastify.ctx;
    const job = jobsRepo.getById(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Unknown job "${request.params.id}"` });
    }
    if (job.status !== "pending") {
      // Cancelling an in-flight ffmpeg process requires the running worker
      // process to observe a cancel signal between progress ticks, which is
      // deferred past v1 (see .plan/task_plan.md Open Questions).
      return reply.code(409).send({ error: `Cannot cancel a job in status "${job.status}"` });
    }
    jobsRepo.markCancelled(job.id);
    return jobsRepo.getById(job.id);
  });

  fastify.post<{ Body: { filePath: string; presetId: string } }>("/api/jobs", async (request, reply) => {
    const { filePath, presetId } = request.body;
    const { config, jobsRepo } = fastify.ctx;

    if (!filePath || !presetId) {
      return reply.code(400).send({ error: "filePath and presetId are required" });
    }
    if (!config.presets.some((p) => p.id === presetId)) {
      return reply.code(400).send({ error: `Unknown preset "${presetId}"` });
    }
    if (jobsRepo.hasActiveJobForPath(filePath)) {
      return reply.code(409).send({ error: `A pending or running job already exists for "${filePath}"` });
    }

    const job = jobsRepo.enqueueJob(filePath, presetId, 0);
    return reply.code(201).send(job);
  });
}
