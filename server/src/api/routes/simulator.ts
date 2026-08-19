import type { FastifyInstance } from "fastify";
import { simulateSavings } from "../../transcode/simulator.js";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";

export async function simulatorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Body: { filePath: string; presetId?: string; sampleDurationSeconds?: number };
  }>("/api/simulate", async (request, reply) => {
    const { filePath, presetId, sampleDurationSeconds } = request.body || {};
    if (!filePath) {
      return reply.code(400).send({ error: "filePath is required" });
    }

    const { config, filesRepo } = fastify.ctx;
    if (!isPathInsideLibraries(filePath, config.libraries)) {
      return reply.code(400).send({ error: "filePath must be inside a configured library" });
    }
    let preset = config.presets.find((p) => p.id === presetId);
    if (!preset) {
      const file = filesRepo.getFileByPath(filePath);
      if (file) {
        const lib = config.libraries.find((l) => l.id === file.libraryId);
        preset = config.presets.find((p) => p.id === lib?.presetId);
      }
    }
    if (!preset) {
      preset = config.presets[0];
    }
    if (!preset) {
      return reply.code(400).send({ error: "No preset available for simulation" });
    }

    try {
      const result = await simulateSavings(filePath, preset, sampleDurationSeconds ?? 30);
      return reply.send(result);
    } catch (err) {
      fastify.log.error({ err, filePath }, "Simulation failed");
      return reply.code(500).send({ error: `Simulation failed: ${(err as Error).message}` });
    }
  });
}
