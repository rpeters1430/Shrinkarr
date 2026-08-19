import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config/index.js";
import { createServer, type ServerInstance } from "../src/api/server.js";

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-auth-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `dbPath: ":memory:"\nwatcher:\n  enabled: false\n`,
    "utf-8",
  );
  return path;
}

describe("API key auth", () => {
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

  it("auto-generates an API key on first run", () => {
    expect(apiKey).toBeDefined();
    expect(apiKey.length).toBeGreaterThanOrEqual(16);
  });

  it("rejects requests to /api/* with no key", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/libraries" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with the wrong key", async () => {
    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { "x-api-key": "wrong-key-wrong-key-wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows requests with the correct key", async () => {
    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows /api/health without a key", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });
});
