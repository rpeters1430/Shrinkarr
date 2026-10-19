import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";

let db: ReturnType<typeof openDb>;
afterEach(() => db?.close());

describe("remote job leases", () => {
  it("atomically gives a pending transcode to one worker and releases it for local fallback", () => {
    db = openDb(":memory:");
    const repo = new JobsRepo(db);
    const queued = repo.enqueueJob("/media/movie.mkv", "preset", 1000);
    const claimed = repo.claimRemoteJob("worker-a", "lease-a", 90, queued.id);
    expect(claimed).toMatchObject({ id: queued.id, status: "running" });
    expect(repo.claimRemoteJob("worker-b", "lease-b", 90, queued.id)).toBeUndefined();
    expect(repo.isRemoteLeaseCurrent(queued.id, "worker-a", "lease-a")).toBe(true);
    expect(repo.extendRemoteLease(queued.id, "worker-a", "lease-a")).toBe(true);
    expect(repo.releaseRemoteLease(queued.id, "worker-b", "lease-a")).toBe(false);
    expect(repo.releaseRemoteLease(queued.id, "worker-a", "lease-a", "worker error")).toBe(true);
    expect(repo.getById(queued.id)).toMatchObject({ status: "pending", error: "worker error" });
  });

  it("reclaims expired attempts and rejects their late ownership checks", () => {
    db = openDb(":memory:");
    const repo = new JobsRepo(db);
    const queued = repo.enqueueJob("/media/expired.mkv", "preset", 1000);
    repo.claimRemoteJob("worker-a", "lease-a", -1, queued.id);
    expect(repo.reclaimExpiredRemoteLeases()).toBe(1);
    expect(repo.isRemoteLeaseCurrent(queued.id, "worker-a", "lease-a")).toBe(false);
    expect(repo.getById(queued.id)?.status).toBe("pending");
  });
});
