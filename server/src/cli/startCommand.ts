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
  ctx.processor = processorHandle;

  await fastify.listen({ port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, gracefully shutting down (in-flight jobs get up to ${SHUTDOWN_GRACE_PERIOD_MS / 1000}s)...`);
    try {
      await processorHandle.drain(SHUTDOWN_GRACE_PERIOD_MS);
    } catch (err) {
      console.warn("Error during processor drain:", err);
    }
    await fastify.close();
    db.close();
    console.log("Shrinkarr stopped.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
