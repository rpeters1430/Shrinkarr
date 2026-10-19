import type { FastifyInstance } from "fastify";
import type { HistoryKind, HistoryStatus } from "../../db/historyRepo.js";

const KINDS: HistoryKind[] = ["transcode", "remux", "health"];
const STATUSES: HistoryStatus[] = ["done", "failed"];

export async function historyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: { status?: string; kind?: string; libraryId?: string; search?: string; limit?: string; offset?: string };
  }>("/api/history", async (request, reply) => {
    const { status, kind, libraryId, search, limit, offset } = request.query;
    if (status && !STATUSES.includes(status as HistoryStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}"` });
    }
    if (kind && !KINDS.includes(kind as HistoryKind)) {
      return reply.code(400).send({ error: `Invalid kind "${kind}"` });
    }
    return fastify.ctx.historyRepo.list({
      status: status as HistoryStatus | undefined,
      kind: kind as HistoryKind | undefined,
      libraryId: libraryId || undefined,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  });

  fastify.get("/api/history/summary", async () => fastify.ctx.historyRepo.summary());

  fastify.get<{ Params: { id: string } }>("/api/history/:id/log", async (request, reply) => {
    const log = fastify.ctx.historyRepo.getLog(request.params.id);
    if (log === undefined) {
      return reply.code(404).send({ error: `Unknown history entry "${request.params.id}"` });
    }
    return { log: log ?? "" };
  });

  fastify.post("/api/history/clear", async () => ({ clearedCount: fastify.ctx.historyRepo.clear() }));
}
