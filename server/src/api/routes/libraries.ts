import type { FastifyInstance } from "fastify";
import { scanLibrary } from "../../scanner/scan.js";

export async function libraryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/libraries", async () => {
    return fastify.ctx.config.libraries;
  });

  fastify.post<{ Params: { id: string } }>("/api/libraries/:id/scan", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    const preset = config.presets.find((p) => p.id === library.presetId);
    if (!preset) {
      return reply.code(400).send({ error: `Library references unknown preset "${library.presetId}"` });
    }

    void scanLibrary(library, preset, filesRepo, jobsRepo).catch((err) => {
      fastify.log.error({ err, libraryId: library.id }, "library scan failed");
    });

    return reply.code(202).send({ status: "scan started" });
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
