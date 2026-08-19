import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import { startProcessor } from "../queue/processor.js";
import type { AppContext } from "../api/context.js";
import { libraryRoutes } from "../api/routes/libraries.js";
import { jobRoutes } from "../api/routes/jobs.js";
import { configRoutes } from "../api/routes/config.js";
import { statsRoutes } from "../api/routes/stats.js";

const SHUTDOWN_GRACE_PERIOD_MS = 10_000;

export async function runStart(port: number): Promise<void> {
  const config = getConfig();
  const configPath = process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
  const db = openDb(config.dbPath);

  const ctx: AppContext = {
    config,
    configPath,
    filesRepo: new FilesRepo(db),
    jobsRepo: new JobsRepo(db),
  };

  console.log(`Shrinkarr starting (queue concurrency: ${config.queue.concurrency})...`);
  const processorHandle = startProcessor(
    { config: ctx.config, filesRepo: ctx.filesRepo, jobsRepo: ctx.jobsRepo },
    config.queue.concurrency,
  );

  const fastify = Fastify({ logger: true });
  fastify.decorate("ctx", ctx);
  await fastify.register(libraryRoutes);
  await fastify.register(jobRoutes);
  await fastify.register(configRoutes);
  await fastify.register(statsRoutes);
  fastify.get("/api/health", async () => ({ status: "ok" }));

  const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web-dist");
  if (existsSync(webDist)) {
    await fastify.register(fastifyStatic, { root: webDist });
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith("/api")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  await fastify.listen({ port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down (in-flight jobs get up to ${SHUTDOWN_GRACE_PERIOD_MS / 1000}s)...`);
    processorHandle.stop();
    setTimeout(async () => {
      await fastify.close();
      db.close();
      console.log("Shrinkarr stopped.");
      process.exit(0);
    }, SHUTDOWN_GRACE_PERIOD_MS);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
