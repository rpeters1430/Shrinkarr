import type { FastifyInstance } from "fastify";
import { detectHardware, testEncoderWorking } from "../../transcode/hardware.js";

export async function hardwareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/hardware", async (request) => {
    const query = request.query as { refresh?: string };
    const forceRefresh = query.refresh === "true" || query.refresh === "1";
    const report = await detectHardware(forceRefresh);
    return report;
  });

  fastify.post<{ Body: { encoderId: string } }>("/api/hardware/test", async (request, reply) => {
    const { encoderId } = request.body || {};
    if (!encoderId) {
      return reply.code(400).send({ error: "encoderId is required" });
    }
    const result = await testEncoderWorking(encoderId);
    return { encoderId, ...result };
  });
}
