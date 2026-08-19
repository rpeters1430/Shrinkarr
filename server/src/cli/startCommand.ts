import { createServer } from "../api/server.js";
import { startProcessor } from "../queue/processor.js";

const SHUTDOWN_GRACE_PERIOD_MS = 10_000;

export async function runStart(port: number): Promise<void> {
  const { fastify, ctx, db } = await createServer();

  console.log(`Shrinkarr starting (queue concurrency: ${ctx.config.queue.concurrency})...`);
  const processorHandle = startProcessor(
    { config: ctx.config, filesRepo: ctx.filesRepo, jobsRepo: ctx.jobsRepo },
    ctx.config.queue.concurrency,
  );

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
