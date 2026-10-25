import type { FastifyInstance } from "fastify";
import { basename, extname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkerCapabilities } from "../../db/remoteWorkersRepo.js";
import { finalizeRemoteJob } from "../../queue/remoteFinalize.js";
import { isQueuePaused, isWithinSchedule } from "../../queue/processor.js";

const CreateWorkerSchema = z.object({ name: z.string().trim().min(1).max(80) });
const CapabilitiesSchema = z.object({
  ffmpegAvailable: z.boolean(),
  ffmpegVersion: z.string().max(200).optional(),
  mediaKinds: z.array(z.enum(["video", "audio"])).max(2),
  libraryIds: z.array(z.string().min(1).max(120)).max(100),
  encoders: z.array(z.string().max(100)).max(100).optional(),
});

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function remoteWorkerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/remote-workers", async () => fastify.ctx.remoteWorkersRepo?.list() ?? []);

  fastify.post<{ Body: unknown }>("/api/remote-workers", async (request, reply) => {
    const parsed = CreateWorkerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid worker name" });
    const repo = fastify.ctx.remoteWorkersRepo;
    if (!repo) return reply.code(503).send({ error: "Remote workers are not available" });
    const created = repo.create(parsed.data.name);
    return reply.code(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>("/api/remote-workers/:id", async (request, reply) => {
    const repo = fastify.ctx.remoteWorkersRepo;
    if (!repo) return reply.code(503).send({ error: "Remote workers are not available" });
    if (!repo.revoke(request.params.id)) return reply.code(404).send({ error: "Worker not found or already revoked" });
    return { revoked: true };
  });

  fastify.post<{ Body: unknown }>("/api/remote/heartbeat", async (request, reply) => {
    const repo = fastify.ctx.remoteWorkersRepo;
    if (!repo) return reply.code(503).send({ error: "Remote workers are not available" });
    const token = bearerToken(request.headers.authorization);
    const worker = token ? repo.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    const parsed = CapabilitiesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid worker capabilities" });
    repo.heartbeat(worker.id, parsed.data as WorkerCapabilities);
    fastify.ctx.jobsRepo?.reclaimExpiredRemoteLeases();
    return { workerId: worker.id, heartbeatIntervalSeconds: 15, job: null };
  });

  // Lets node setup show library names and ask where each one is mounted.
  fastify.get("/api/remote/libraries", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const worker = token ? fastify.ctx.remoteWorkersRepo?.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    return fastify.ctx.config.libraries.map((library) => ({ id: library.id, name: library.name, path: library.path }));
  });

  fastify.post("/api/remote/claim", async (request, reply) => {
    const repo = fastify.ctx.remoteWorkersRepo;
    const token = bearerToken(request.headers.authorization);
    const worker = token ? repo?.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    const capabilities = worker.capabilities as Partial<WorkerCapabilities>;
    if (!capabilities.ffmpegAvailable) return { job: null, retryAfterSeconds: 15 };
    if ((fastify.ctx.config.queue.tempDirectory ?? "").trim()) return { job: null, retryAfterSeconds: 15 };
    if (isQueuePaused() || !isWithinSchedule(fastify.ctx.config.queue.schedule)) return { job: null, retryAfterSeconds: 15 };

    fastify.ctx.jobsRepo.reclaimExpiredRemoteLeases();
    if (fastify.ctx.jobsRepo.countJobs("running", "transcode") >= fastify.ctx.config.queue.concurrency) {
      return { job: null, retryAfterSeconds: 15 };
    }
    const candidates = fastify.ctx.jobsRepo.listJobs("pending", 1000, 0, fastify.ctx.config.queue.order)
      .filter((job) => job.kind === "transcode");
    for (const job of candidates) {
      const file = fastify.ctx.filesRepo.getFileByPath(job.filePath);
      if (!file || !capabilities.libraryIds?.includes(file.libraryId)) continue;
      const healthMode = fastify.ctx.config.queue.healthCheck;
      if (healthMode !== "off" && healthMode !== undefined && file.healthStatus !== "healthy") continue;
      if (healthMode === "thorough" && file.healthMode !== "thorough") continue;
      if (!capabilities.mediaKinds?.includes(file.policyMetadata?.mediaKind ?? "video")) continue;
      const library = fastify.ctx.config.libraries.find((item) => item.id === file.libraryId);
      const preset = fastify.ctx.config.presets.find((item) => item.id === job.presetId);
      if (!library || !preset || !capabilities.mediaKinds?.includes(preset.mediaKind ?? "video")) continue;
      const root = resolve(library.path);
      const relPath = relative(root, resolve(job.filePath));
      if (!relPath || relPath === ".." || relPath.startsWith(`..${sep}`) || resolve(root, relPath) !== resolve(job.filePath)) continue;
      const extension = preset.mediaKind === "audio"
        ? preset.targetAudioCodec === "opus" ? ".opus" : preset.targetAudioCodec === "mp3" ? ".mp3" : preset.targetAudioCodec === "flac" ? ".flac" : ".m4a"
        : `.${preset.targetContainer}`;
      const leaseId = randomUUID();
      const claimed = fastify.ctx.jobsRepo.claimRemoteJob(worker.id, leaseId, 90, job.id);
      if (!claimed) continue;
      const dir = relPath.includes(sep) ? relPath.slice(0, relPath.lastIndexOf(sep) + 1) : "";
      const stem = basename(relPath, extname(relPath));
      return {
        job: {
          id: claimed.id,
          leaseId,
          leaseSeconds: 90,
          libraryId: file.libraryId,
          filePath: relPath.split(sep).join("/"),
          tempPath: `${dir}${stem}.shrinkarr-${claimed.id}-${leaseId}${extension}`.split(sep).join("/"),
          preset,
          sourceSizeBytes: file.sizeBytes,
        },
      };
    }
    return { job: null, retryAfterSeconds: 15 };
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>("/api/remote/jobs/:id/heartbeat", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const worker = token ? fastify.ctx.remoteWorkersRepo?.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    const body = request.body as { leaseId?: unknown; progressPercent?: unknown };
    if (typeof body?.leaseId !== "string") return reply.code(400).send({ error: "leaseId is required" });
    if (fastify.ctx.jobsRepo.ownsRemoteLease(request.params.id, worker.id, body.leaseId)
      && (isQueuePaused() || !isWithinSchedule(fastify.ctx.config.queue.schedule))) {
      fastify.ctx.jobsRepo.releaseRemoteLease(request.params.id, worker.id, body.leaseId, "Queue paused or outside its schedule");
      return { owned: false, cancelled: true };
    }
    const owned = fastify.ctx.jobsRepo.ownsRemoteLease(request.params.id, worker.id, body.leaseId);
    if (!owned) return { owned: false, cancelled: true };
    fastify.ctx.jobsRepo.extendRemoteLease(request.params.id, worker.id, body.leaseId, 90);
    fastify.ctx.remoteWorkersRepo?.heartbeat(worker.id, worker.capabilities as WorkerCapabilities);
    if (typeof body.progressPercent === "number" && Number.isFinite(body.progressPercent)) {
      fastify.ctx.jobsRepo.markProgress(request.params.id, Math.min(99, Math.max(0, body.progressPercent)));
    }
    return { owned: true, cancelled: false, leaseSeconds: 90 };
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>("/api/remote/jobs/:id/fail", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const worker = token ? fastify.ctx.remoteWorkersRepo?.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    const body = request.body as { leaseId?: unknown; error?: unknown };
    if (typeof body?.leaseId !== "string" || typeof body.error !== "string") return reply.code(400).send({ error: "leaseId and error are required" });
    const released = fastify.ctx.jobsRepo.releaseRemoteLease(request.params.id, worker.id, body.leaseId, body.error.slice(0, 1000));
    return { released };
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>("/api/remote/jobs/:id/complete", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const worker = token ? fastify.ctx.remoteWorkersRepo?.authenticate(token) : undefined;
    if (!worker) return reply.code(401).send({ error: "Invalid or revoked worker token" });
    const body = request.body as { leaseId?: unknown; encoderUsed?: unknown };
    if (typeof body?.leaseId !== "string") return reply.code(400).send({ error: "leaseId is required" });
    const result = await finalizeRemoteJob(fastify.ctx, {
      jobId: request.params.id,
      workerId: worker.id,
      leaseId: body.leaseId,
      encoderUsed: typeof body.encoderUsed === "string" ? body.encoderUsed.slice(0, 200) : undefined,
    });
    if (!result.ok) return reply.code(result.error.includes("Lease") ? 409 : 422).send({ error: result.error });
    return { completed: true };
  });
}
