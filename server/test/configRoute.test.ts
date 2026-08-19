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

  it("redacts the server's own apiKey on GET", async () => {
    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/config",
      headers: { "x-api-key": apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey).toBe("********");
  });

  it("ignores a client-supplied apiKey on PUT and keeps the real one usable for auth", async () => {
    const putRes = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { "x-api-key": apiKey },
      payload: { apiKey: "attacker-supplied-key" },
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().apiKey).toBe("********");

    // The real key must still work -- it was not overwritten.
    const followUp = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { "x-api-key": apiKey },
    });
    expect(followUp.statusCode).toBe(200);

    // The attacker-supplied value must not have become valid.
    const attackerRes = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { "x-api-key": "attacker-supplied-key" },
    });
    expect(attackerRes.statusCode).toBe(401);
  });
});
