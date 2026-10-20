import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { resetConfigCache } from "../src/config/index.js";
import { createServer, type ServerInstance } from "../src/api/server.js";
import { hashPassword } from "../src/auth/password.js";
import { getDefaultConfig } from "../src/config/loader.js";

let instance: ServerInstance;
let buildInfoPath: string;
let configPath: string;
const username = "release-notes-admin";
const password = "test-password-123";

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-release-notes-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, stringify({
    ...getDefaultConfig(),
    dbPath: ":memory:",
    watcher: { enabled: false, intervalMinutes: 15, autoOptimize: false, settleDelaySeconds: 15 },
    auth: { username, passwordHash: hashPassword(password), sessionSecret: "r".repeat(32) },
  }), "utf8");
  return path;
}

async function signIn(): Promise<string> {
  const login = await instance.fastify.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(login.statusCode).toBe(200);
  return (login.headers["set-cookie"] as string).split(";")[0];
}

describe("GET /api/release-notes", () => {
  beforeEach(async () => {
    resetConfigCache();
    configPath = writeTempConfig();
    process.env.SHRINKARR_CONFIG = configPath;
  });

  afterEach(async () => {
    instance?.ctx.watcher?.stop();
    await instance?.fastify.close();
    instance?.db.close();
    delete process.env.SHRINKARR_CONFIG;
    resetConfigCache();
  });

  it("returns baked metadata without caching it and requires login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-build-info-"));
    buildInfoPath = join(dir, "build-info.json");
    writeFileSync(buildInfoPath, JSON.stringify({ version: "1.2.3", revision: "abcdef0123456789", notes: "## Fixes\n- Faster scan" }));
    instance = await createServer({ buildInfoPath });

    expect((await instance.fastify.inject({ method: "GET", url: "/api/release-notes" })).statusCode).toBe(401);
    const cookie = await signIn();
    const response = await instance.fastify.inject({ method: "GET", url: "/api/release-notes", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ version: "1.2.3", revision: "abcdef0123456789", notes: "## Fixes\n- Faster scan" });
  });

  it("uses empty defaults when metadata is missing or malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-build-info-"));
    buildInfoPath = join(dir, "build-info.json");
    instance = await createServer({ buildInfoPath });
    const cookie = await signIn();
    const request = () => instance.fastify.inject({ method: "GET", url: "/api/release-notes", headers: { cookie } });

    expect((await request()).json()).toEqual({ version: "", revision: "", notes: "" });
    writeFileSync(buildInfoPath, "{invalid json");
    expect((await request()).json()).toEqual({ version: "", revision: "", notes: "" });
  });
});
