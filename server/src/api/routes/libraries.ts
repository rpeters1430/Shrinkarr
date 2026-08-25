import type { FastifyInstance } from "fastify";
import { scanLibrary } from "../../scanner/scan.js";
import { getScanProgress } from "../../scanner/tracker.js";
import { updateConfig } from "../../config/index.js";
import { LibrarySchema, type Library } from "../../config/schema.js";

export async function libraryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/libraries", async () => {
    return fastify.ctx.config.libraries;
  });

  fastify.get("/api/scan/status", async () => {
    return getScanProgress();
  });

  fastify.get("/api/watcher/status", async () => {
    return fastify.ctx.watcher?.getStatus() ?? {
      enabled: false,
      isScanning: false,
      intervalMinutes: 15,
      autoOptimize: false,
      lastRunAt: null,
      nextRunAt: null,
      newFilesFoundLastRun: 0,
      autoOptimizedLastRun: 0,
      totalNewFilesDiscovered: 0,
      totalAutoOptimized: 0,
    };
  });

  fastify.post("/api/watcher/check", async () => {
    if (!fastify.ctx.watcher) {
      return { newFiles: 0, autoQueued: 0 };
    }
    return fastify.ctx.watcher.checkAllLibraries({ forceScan: false });
  });

  fastify.post("/api/libraries/scan-new", async () => {
    if (!fastify.ctx.watcher) {
      return { newFiles: 0, autoQueued: 0 };
    }
    return fastify.ctx.watcher.checkAllLibraries({ forceScan: false });
  });

  fastify.post<{ Body: unknown }>("/api/libraries", async (request, reply) => {
    const parseResult = LibrarySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const newLib = parseResult.data;
    const existing = fastify.ctx.config.libraries.find((l) => l.id === newLib.id);
    if (existing) {
      return reply.code(409).send({ error: `Library with ID "${newLib.id}" already exists` });
    }

    const updatedLibraries = [...fastify.ctx.config.libraries, newLib];
    const newConfig = { ...fastify.ctx.config, libraries: updatedLibraries };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    return reply.code(201).send(newLib);
  });

  fastify.put<{ Params: { id: string }; Body: Partial<Library> }>("/api/libraries/:id", async (request, reply) => {
    const { id } = request.params;
    const index = fastify.ctx.config.libraries.findIndex((l) => l.id === id);
    if (index === -1) {
      return reply.code(404).send({ error: `Library "${id}" not found` });
    }

    const current = fastify.ctx.config.libraries[index];
    const updatedLib = { ...current, ...(request.body || {}), id };
    const parseResult = LibrarySchema.safeParse(updatedLib);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const updatedLibraries = [...fastify.ctx.config.libraries];
    updatedLibraries[index] = parseResult.data;
    const newConfig = { ...fastify.ctx.config, libraries: updatedLibraries };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    return reply.send(parseResult.data);
  });

  fastify.delete<{ Params: { id: string } }>("/api/libraries/:id", async (request, reply) => {
    const { id } = request.params;
    const filtered = fastify.ctx.config.libraries.filter((l) => l.id !== id);
    if (filtered.length === fastify.ctx.config.libraries.length) {
      return reply.code(404).send({ error: `Library "${id}" not found` });
    }

    const newConfig = { ...fastify.ctx.config, libraries: filtered };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    // Prune indexed files for this library from the database
    fastify.ctx.filesRepo.deleteFilesByLibrary(id);

    return reply.send({ success: true, id });
  });

  fastify.post<{ Params: { id: string }; Body: { autoQueue?: boolean } }>("/api/libraries/:id/scan", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
    if (!preset) {
      return reply.code(400).send({ error: `No valid preset found for library "${library.name}"` });
    }

    const autoQueue = Boolean(request.body?.autoQueue);
    // Run scan in background
    void scanLibrary(library, preset, filesRepo, jobsRepo, { autoQueue }).catch((err) => {
      fastify.log.error({ err, libraryId: library.id }, "library scan failed");
    });

    return reply.code(202).send({ status: "scan started", libraryId: library.id });
  });

  fastify.post<{ Params: { id: string } }>("/api/libraries/:id/optimize", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
    if (!preset) {
      return reply.code(400).send({ error: `No valid preset found for library "${library.name}"` });
    }

    const eligible = filesRepo.getEligibleFiles(library.id);
    let queued = 0;
    for (const file of eligible) {
      if (!jobsRepo.hasActiveJobForPath(file.path)) {
        jobsRepo.enqueueJob(file.path, preset.id, file.sizeBytes);
        queued += 1;
      }
    }

    return reply.send({ libraryId: library.id, queued, totalEligible: eligible.length });
  });

  fastify.get<{ Params: { id: string } }>("/api/libraries/:id/files", async (request, reply) => {
    const { config, filesRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    return filesRepo.getFilesByLibrary(library.id);
  });
}
