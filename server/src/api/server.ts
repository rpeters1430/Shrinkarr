import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import { LibraryWatcher } from "../scanner/watcher.js";
import { detectHardware } from "../transcode/hardware.js";
import type { AppContext } from "./context.js";
import { libraryRoutes } from "./routes/libraries.js";
import { presetRoutes } from "./routes/presets.js";
import { jobRoutes } from "./routes/jobs.js";
import { configRoutes } from "./routes/config.js";
import { statsRoutes } from "./routes/stats.js";
import { hardwareRoutes } from "./routes/hardware.js";
import { simulatorRoutes } from "./routes/simulator.js";
import { systemRoutes } from "./routes/system.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerInstance {
  fastify: FastifyInstance;
  ctx: AppContext;
  db: ReturnType<typeof openDb>;
}

export async function createServer(): Promise<ServerInstance> {
  const config = getConfig();
  const configPath = process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
  const db = openDb(config.dbPath);

  const ctx: AppContext = {
    config,
    configPath,
    filesRepo: new FilesRepo(db),
    jobsRepo: new JobsRepo(db),
  };

  const watcher = new LibraryWatcher(() => ({
    config: ctx.config,
    filesRepo: ctx.filesRepo,
    jobsRepo: ctx.jobsRepo,
  }));
  ctx.watcher = watcher;

  // Start watcher in background if enabled
  if (config.watcher?.enabled) {
    watcher.start();
  }

  // Kick off hardware detection in the background
  void detectHardware().catch((err) => {
    console.warn("Background hardware detection warning:", err);
  });

  const fastify = Fastify({ logger: true });
  fastify.decorate("ctx", ctx);

  // Allow empty or blank JSON body in POST/PUT requests
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const str = (typeof body === "string" ? body : body?.toString("utf-8") || "").trim();
    if (!str || str.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(str));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await fastify.register(cors, { origin: true });

  await fastify.register(libraryRoutes);
  await fastify.register(presetRoutes);
  await fastify.register(jobRoutes);
  await fastify.register(configRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(hardwareRoutes);
  await fastify.register(simulatorRoutes);
  await fastify.register(systemRoutes);

  fastify.get("/api/health", async () => ({ status: "ok" }));

  // Check possible web static directories
  const candidateDirs = [
    resolve(__dirname, "../../web-dist"),
    resolve(__dirname, "../../../web/dist"),
    resolve(__dirname, "../../web/dist"),
    resolve(__dirname, "../web-dist"),
    resolve(process.cwd(), "web/dist"),
    resolve(process.cwd(), "server/web-dist"),
    resolve(process.cwd(), "web-dist"),
  ];

  const staticDir = candidateDirs.find((dir) => existsSync(dir));
  if (staticDir) {
    fastify.log.info(`Serving Web UI from static directory: ${staticDir}`);
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      index: ["index.html"],
      decorateReply: true,
    });

    fastify.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith("/api/")) {
        reply.code(404).send({ error: "Endpoint not found" });
      } else {
        reply.sendFile("index.html");
      }
    });
  } else {
    fastify.log.warn("No static Web UI directory found.");
    fastify.get("/", async (req, reply) => {
      reply.type("text/html").send(`
        <html>
          <body style="font-family: sans-serif; background: #0f172a; color: #fff; padding: 2rem;">
            <h2>Shrinkarr API is running</h2>
            <p>Web UI build not found. Run <code>npm run build</code> or start the Vite dev server with <code>npm run dev -w web</code>.</p>
          </body>
        </html>
      `);
    });
  }

  return { fastify, ctx, db };
}

export async function startServer(port: number): Promise<void> {
  const { fastify } = await createServer();
  await fastify.listen({ port, host: "0.0.0.0" });
}
