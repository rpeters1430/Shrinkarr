import type { FastifyInstance } from "fastify";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";

export async function fileRoutes(fastify: FastifyInstance): Promise<void> {
  // Ignored files stay listed but are never queued by scans, the watcher or
  // "Optimize". Queuing one by hand still works.
  fastify.post<{ Body: { paths?: string[]; ignored?: boolean } }>("/api/files/ignore", async (request, reply) => {
    const { paths, ignored } = request.body || {};
    if (!Array.isArray(paths) || paths.length === 0 || typeof ignored !== "boolean") {
      return reply.code(400).send({ error: "paths (a non-empty array) and ignored (true or false) are required" });
    }
    const { filesRepo, jobsRepo } = fastify.ctx;
    const updated = filesRepo.setIgnored(paths, ignored);
    // Ignoring a file also takes it out of the queue if it's waiting there.
    let cancelled = 0;
    if (ignored) {
      const wanted = new Set(paths);
      for (const job of jobsRepo.listJobs("pending")) {
        if (job.kind === "transcode" && wanted.has(job.filePath)) {
          jobsRepo.markCancelled(job.id);
          cancelled++;
        }
      }
    }
    return { updated, cancelled };
  });

  // Queues health checks for the given files, or for every file in a library
  // (or every library) that hasn't been checked yet.
  fastify.post<{ Body: { filePaths?: string[]; libraryId?: string; mode?: string; recheck?: boolean } }>(
    "/api/health/check",
    async (request, reply) => {
      const { filePaths, libraryId, mode = "quick", recheck = false } = request.body || {};
      if (mode !== "quick" && mode !== "thorough") {
        return reply.code(400).send({ error: 'mode must be "quick" or "thorough"' });
      }
      const { config, filesRepo, jobsRepo } = fastify.ctx;

      let targets: Array<{ path: string; sizeBytes: number }>;
      if (Array.isArray(filePaths) && filePaths.length > 0) {
        targets = filePaths
          .filter((path) => isPathInsideLibraries(path, config.libraries))
          .map((path) => ({ path, sizeBytes: filesRepo.getFileByPath(path)?.sizeBytes ?? 0 }));
      } else {
        if (libraryId && !config.libraries.some((lib) => lib.id === libraryId)) {
          return reply.code(404).send({ error: `Unknown library "${libraryId}"` });
        }
        targets = filesRepo.getFilesForHealthCheck(libraryId, !recheck);
      }

      const queued = jobsRepo.enqueueJobsBatch(
        targets.map((file) => ({ filePath: file.path, presetId: mode, originalSizeBytes: file.sizeBytes })),
        "health",
      ).length;
      return reply.code(201).send({ queued, skipped: targets.length - queued });
    },
  );
}
