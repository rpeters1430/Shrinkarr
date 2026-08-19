import Fastify from "fastify";
import cors from "@fastify/cors";
import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import type { AppContext } from "./context.js";
import { libraryRoutes } from "./routes/libraries.js";
import { jobRoutes } from "./routes/jobs.js";
import { configRoutes } from "./routes/config.js";
import { statsRoutes } from "./routes/stats.js";

export async function startServer(port: number): Promise<void> {
  const config = getConfig();
  const configPath = process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
  const db = openDb(config.dbPath);

  const ctx: AppContext = {
    config,
    configPath,
    filesRepo: new FilesRepo(db),
    jobsRepo: new JobsRepo(db),
  };

  const fastify = Fastify({ logger: true });
  fastify.decorate("ctx", ctx);

  if (process.env.NODE_ENV !== "production") {
    await fastify.register(cors, { origin: true });
  }

  await fastify.register(libraryRoutes);
  await fastify.register(jobRoutes);
  await fastify.register(configRoutes);
  await fastify.register(statsRoutes);

  fastify.get("/api/health", async () => ({ status: "ok" }));

  await fastify.listen({ port, host: "0.0.0.0" });
}
