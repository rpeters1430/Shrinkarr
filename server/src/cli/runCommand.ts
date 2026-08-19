import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import { startProcessor } from "../queue/processor.js";

const SHUTDOWN_GRACE_PERIOD_MS = 10_000;

export async function runDaemon(): Promise<void> {
  const config = getConfig();
  const db = openDb(config.dbPath);
  const filesRepo = new FilesRepo(db);
  const jobsRepo = new JobsRepo(db);

  console.log(`Shrinkarr daemon starting (concurrency: ${config.queue.concurrency})...`);

  const handle = startProcessor({ config, filesRepo, jobsRepo }, config.queue.concurrency);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\nReceived ${signal}, stopping processor (in-flight jobs get up to ${SHUTDOWN_GRACE_PERIOD_MS / 1000}s to finish)...`);
    handle.stop();
    setTimeout(() => {
      db.close();
      console.log("Shrinkarr daemon stopped.");
      process.exit(0);
    }, SHUTDOWN_GRACE_PERIOD_MS);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive; startProcessor's loop runs in the background.
  await new Promise<void>(() => {});
}
