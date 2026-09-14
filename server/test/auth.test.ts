import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { resetConfigCache } from "../src/config/index.js";
import { createServer, type ServerInstance } from "../src/api/server.js";
import { hashPassword } from "../src/auth/password.js";
import { getDefaultConfig } from "../src/config/loader.js";

const USERNAME = "test-admin";
// Generated at test-run time rather than hardcoded so it isn't a static credential in source.
const PASSWORD = randomBytes(16).toString("base64url");

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-auth-"));
  const path = join(dir, "config.yaml");
  const config = {
    ...getDefaultConfig(),
    dbPath: ":memory:",
    watcher: { enabled: false, intervalMinutes: 15, autoOptimize: false, settleDelaySeconds: 15 },
    auth: {
      username: USERNAME,
      passwordHash: hashPassword(PASSWORD),
      sessionSecret: "a".repeat(32),
    },
  };
  writeFileSync(path, stringify(config), "utf-8");
  return path;
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("No set-cookie header returned");
  return header.split(";")[0];
}

describe("username/password auth", () => {
  let instance: ServerInstance;

  beforeEach(async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfig();
    instance = await createServer();
  });

  afterEach(async () => {
    instance.ctx.watcher?.stop();
    await instance.fastify.close();
    instance.db.close();
    delete process.env.SHRINKARR_CONFIG;
    resetConfigCache();
  });

  it("rejects requests to /api/* with no session", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/libraries" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects login with the wrong password", async () => {
    const res = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects login with an unknown username", async () => {
    const res = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "someone-else", password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logs in with correct credentials and allows authenticated requests", async () => {
    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json()).toEqual({ username: USERNAME });

    const cookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests with a tampered session cookie", async () => {
    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    const cookie = extractSessionCookie(loginRes.headers["set-cookie"]);
    const tampered = cookie.replace("shrinkarr_session=", "shrinkarr_session=tampered");

    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { cookie: tampered },
    });
    expect(res.statusCode).toBe(401);
  });

  it("clears the session on logout", async () => {
    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    const cookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const logoutRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);
    const clearedCookie = extractSessionCookie(logoutRes.headers["set-cookie"]);

    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { cookie: clearedCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows /api/health without a session", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("reports that setup is not needed once an account exists", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: false });
  });

  it("rejects account setup once an account already exists", async () => {
    const res = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "someone-else", password: "another-password-123" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("changes the password via /api/auth/account and requires it on next login", async () => {
    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    const cookie = extractSessionCookie(loginRes.headers["set-cookie"]);

    const changeRes = await instance.fastify.inject({
      method: "PUT",
      url: "/api/auth/account",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "a-new-password-123" },
    });
    expect(changeRes.statusCode).toBe(200);

    const oldLoginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(oldLoginRes.statusCode).toBe(401);

    const newLoginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: "a-new-password-123" },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });
});

describe("first-run account setup", () => {
  let instance: ServerInstance;

  function writeTempConfigWithoutAuth(): string {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-setup-"));
    const path = join(dir, "config.yaml");
    const config = {
      ...getDefaultConfig(),
      dbPath: ":memory:",
      watcher: { enabled: false, intervalMinutes: 15, autoOptimize: false, settleDelaySeconds: 15 },
    };
    writeFileSync(path, stringify(config), "utf-8");
    return path;
  }

  beforeEach(async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfigWithoutAuth();
    instance = await createServer();
  });

  afterEach(async () => {
    instance.ctx.watcher?.stop();
    await instance.fastify.close();
    instance.db.close();
    delete process.env.SHRINKARR_CONFIG;
    resetConfigCache();
  });

  it("reports that setup is needed when no account exists", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("rejects requests to /api/* while no account exists", async () => {
    const res = await instance.fastify.inject({ method: "GET", url: "/api/libraries" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects setup with a short password", async () => {
    const res = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates the admin account and signs the caller in", async () => {
    const setupRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "new-admin", password: "a-fresh-password-123" },
    });
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.json()).toEqual({ username: "new-admin" });

    const cookie = extractSessionCookie(setupRes.headers["set-cookie"]);
    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const statusRes = await instance.fastify.inject({ method: "GET", url: "/api/auth/status" });
    expect(statusRes.json()).toEqual({ needsSetup: false });
  });

  it("rejects a second setup attempt once an account exists", async () => {
    await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "new-admin", password: "a-fresh-password-123" },
    });

    const res = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "someone-else", password: "another-password-123" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("SHRINKARR_RESET_ADMIN", () => {
  let instance: ServerInstance | undefined;

  afterEach(async () => {
    instance?.ctx.watcher?.stop();
    await instance?.fastify.close();
    instance?.db.close();
    delete process.env.SHRINKARR_CONFIG;
    delete process.env.SHRINKARR_RESET_ADMIN;
    resetConfigCache();
  });

  it("clears an existing admin account and drops the server back into setup mode", async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfig();
    process.env.SHRINKARR_RESET_ADMIN = "true";
    instance = await createServer();

    const statusRes = await instance.fastify.inject({ method: "GET", url: "/api/auth/status" });
    expect(statusRes.json()).toEqual({ needsSetup: true });

    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(loginRes.statusCode).toBe(401);

    const setupRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "recovered-admin", password: "a-recovered-password-123" },
    });
    expect(setupRes.statusCode).toBe(200);
  });

  it("leaves an existing admin account alone when unset", async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfig();
    instance = await createServer();

    const statusRes = await instance.fastify.inject({ method: "GET", url: "/api/auth/status" });
    expect(statusRes.json()).toEqual({ needsSetup: false });
  });
});
