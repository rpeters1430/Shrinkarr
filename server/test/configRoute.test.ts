import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config/index.js";
import { createServer, type ServerInstance } from "../src/api/server.js";

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-configroute-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `dbPath: ":memory:"\nwatcher:\n  enabled: false\nqueue:\n  concurrency: 1\n  tempSuffix: ".shrinkarr.tmp"\n  recycleBinPath: "/media/.recycle"\n  pauseOnStreaming: true\n  minFreeSpaceGb: 25\n`,
    "utf-8",
  );
  return path;
}

describe("PUT /api/config", () => {
  let instance: ServerInstance;
  let apiKey: string;

  beforeEach(async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfig();
    instance = await createServer();
    apiKey = instance.ctx.config.apiKey!;
  });

  afterEach(async () => {
    instance.ctx.watcher?.stop();
    await instance.fastify.close();
    instance.db.close();
    delete process.env.SHRINKARR_CONFIG;
    resetConfigCache();
  });

  it("deep-merges a partial queue update instead of resetting sibling fields to schema defaults", async () => {
    const res = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { "x-api-key": apiKey },
      payload: { queue: { concurrency: 5 } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queue.concurrency).toBe(5);
    // These weren't in the PUT body -- they must survive from the existing config,
    // not silently reset to ConfigSchema's defaults.
    expect(body.queue.recycleBinPath).toBe("/media/.recycle");
    expect(body.queue.pauseOnStreaming).toBe(true);
    expect(body.queue.minFreeSpaceGb).toBe(25);
  });

  it("deep-merges a partial watcher update instead of resetting sibling fields", async () => {
    const res = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { "x-api-key": apiKey },
      payload: { watcher: { intervalMinutes: 60 } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.watcher.intervalMinutes).toBe(60);
    expect(body.watcher.enabled).toBe(false);
  });
});
