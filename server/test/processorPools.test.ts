import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../src/db/jobsRepo.js";

const started: Job[] = [];
vi.mock("../src/queue/worker.js", () => ({
  // Never finishes, so each job holds its slot for the whole test.
  processJob: vi.fn((job: Job) => {
    started.push(job);
    return new Promise(() => {});
  }),
}));
vi.mock("../src/queue/recovery.js", () => ({ recoverInterruptedWork: vi.fn(async () => {}) }));

const { openDb } = await import("../src/db/client.js");
const { JobsRepo } = await import("../src/db/jobsRepo.js");
const { FilesRepo } = await import("../src/db/filesRepo.js");
const { startProcessor } = await import("../src/queue/processor.js");
const { getDefaultConfig } = await import("../src/config/loader.js");

describe("queue processor pools", () => {
  it("runs health checks in their own pool alongside transcodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-pools-"));
    const db = openDb(join(dir, "test.db"));
    const jobsRepo = new JobsRepo(db);
    const filesRepo = new FilesRepo(db);
    for (const name of ["a", "b", "c"]) jobsRepo.enqueueJob(`/m/${name}.mkv`, "balanced", 100);
    for (const name of ["d", "e", "f"]) jobsRepo.enqueueJob(`/m/${name}.mkv`, "quick", 100, "health");

    const config = getDefaultConfig();
    config.queue.concurrency = 1;
    config.queue.healthCheckConcurrency = 2;
    const handle = startProcessor({ config, filesRepo, jobsRepo }, 1);

    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started.filter((j) => j.kind === "transcode")).toHaveLength(1);
    expect(started.filter((j) => j.kind === "health")).toHaveLength(2);
    expect(handle.getActiveCount()).toBe(3);

    handle.stop();
    db.close();
  });
});
