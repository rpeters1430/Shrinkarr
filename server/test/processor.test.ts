import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { restoreOrphanedBackups, cleanupOrphanedTempFiles } from "../src/queue/processor.js";
import { BACKUP_SUFFIX } from "../src/queue/atomicReplace.js";
import type { Config } from "../src/config/schema.js";
import type { WorkerDeps } from "../src/queue/worker.js";

let db: DatabaseSync;
let dir: string;
let deps: WorkerDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shrinkarr-processor-"));
  db = openDb(join(dir, "test.db"));
  const jobsRepo = new JobsRepo(db);
  const filesRepo = new FilesRepo(db);
  const config: Config = {
    libraries: [{ id: "lib-1", name: "lib", path: dir, mediaType: "movie", presetId: "balanced", autoOptimize: false }],
    presets: [],
    integrations: {},
    queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp", fileStabilityDelaySeconds: 1 },
    dbPath: join(dir, "unused.db"),
  };
  deps = { config, filesRepo, jobsRepo };
});

afterEach(() => {
  db.close();
});

describe("restoreOrphanedBackups", () => {
  it("restores the original when a crash left only the backup behind", async () => {
    const originalPath = join(dir, "movie.mkv");
    const backupPath = `${originalPath}${BACKUP_SUFFIX}`;
    writeFileSync(backupPath, "pre-crash original bytes");

    await restoreOrphanedBackups(deps);

    expect(existsSync(originalPath)).toBe(true);
    expect(readFileSync(originalPath, "utf-8")).toBe("pre-crash original bytes");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("removes a stale backup when the replace already completed", async () => {
    const originalPath = join(dir, "movie2.mkv");
    const backupPath = `${originalPath}${BACKUP_SUFFIX}`;
    writeFileSync(originalPath, "already-replaced content");
    writeFileSync(backupPath, "old original bytes");

    await restoreOrphanedBackups(deps);

    expect(readFileSync(originalPath, "utf-8")).toBe("already-replaced content");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("is a no-op when there are no backup files", async () => {
    await expect(restoreOrphanedBackups(deps)).resolves.toBeUndefined();
  });
});

describe("cleanupOrphanedTempFiles", () => {
  it("removes leftover temp files from a previous run", async () => {
    const tempPath = join(dir, "movie3.shrinkarr.tmp.mkv");
    writeFileSync(tempPath, "incomplete transcode");

    await cleanupOrphanedTempFiles(deps);

    expect(existsSync(tempPath)).toBe(false);
  });
});
