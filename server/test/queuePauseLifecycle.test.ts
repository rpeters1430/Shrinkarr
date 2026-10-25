import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";

const started = vi.hoisted(() => [] as AbortSignal[]);
vi.mock("../src/queue/worker.js", () => ({
  processJob: vi.fn(async (_job, _deps, signal: AbortSignal) => {
    started.push(signal);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }),
}));
const { startProcessor } = await import("../src/queue/processor.js");

it("retains the running job through pause polling and resume without launching it twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-pause-lifecycle-"));
  const db = openDb(join(dir, "test.db"));
  const jobsRepo = new JobsRepo(db);
  const filesRepo = new FilesRepo(db);
  const job = jobsRepo.enqueueJob("/video.mkv", "balanced", 1000);
  const config = ConfigSchema.parse({ apiKey: "test", dbPath: join(dir, "test.db"), libraries: [] });
  const handle = startProcessor({ config, jobsRepo, filesRepo });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(1));
    handle.pause();
    // Exercise the paused loop as well as the immediate pause handler.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(started[0].aborted).toBe(false);
    expect(jobsRepo.getById(job.id)?.status).toBe("running");
    handle.resume();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(1);
    expect(started[0].aborted).toBe(false);
  } finally {
    handle.resume();
    handle.stop();
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
