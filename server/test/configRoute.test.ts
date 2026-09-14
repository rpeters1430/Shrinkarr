import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../src/config/index.js";
import { createServer, type ServerInstance } from "../src/api/server.js";
import { hashPassword } from "../src/auth/password.js";

const USERNAME = "test-admin";
// Generated at test-run time rather than hardcoded so it isn't a static credential in source.
const PASSWORD = randomBytes(16).toString("base64url");

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "shrinkarr-configroute-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `dbPath: ":memory:"\nwatcher:\n  enabled: false\nqueue:\n  concurrency: 1\n  tempSuffix: ".shrinkarr.tmp"\n  recycleBinPath: "/media/.recycle"\n  pauseOnStreaming: true\n  minFreeSpaceGb: 25\nauth:\n  username: "${USERNAME}"\n  passwordHash: "${hashPassword(PASSWORD)}"\n  sessionSecret: "${"a".repeat(32)}"\n`,
    "utf-8",
  );
  return path;
}

describe("PUT /api/config", () => {
  let instance: ServerInstance;
  let cookie: string;

  beforeEach(async () => {
    resetConfigCache();
    process.env.SHRINKARR_CONFIG = writeTempConfig();
    instance = await createServer();

    const loginRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    const setCookie = loginRes.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0];
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
      headers: { cookie },
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
      headers: { cookie },
      payload: { watcher: { intervalMinutes: 60 } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.watcher.intervalMinutes).toBe(60);
    expect(body.watcher.enabled).toBe(false);
  });

  it("deep-merges partial queue.schedule updates correctly", async () => {
    // First set a full schedule
    const res1 = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { cookie },
      payload: {
        queue: {
          schedule: {
            enabled: true,
            startHour: 2,
            endHour: 6,
            timezone: "America/New_York",
            stopActiveOnExit: true,
          },
        },
      },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.queue.schedule.enabled).toBe(true);
    expect(body1.queue.schedule.startHour).toBe(2);
    expect(body1.queue.schedule.endHour).toBe(6);
    expect(body1.queue.schedule.timezone).toBe("America/New_York");
    expect(body1.queue.schedule.stopActiveOnExit).toBe(true);

    // Now send partial update: toggle enabled to false only
    const res2 = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { cookie },
      payload: {
        queue: {
          schedule: {
            enabled: false,
          },
        },
      },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.queue.schedule.enabled).toBe(false);
    expect(body2.queue.schedule.startHour).toBe(2);
    expect(body2.queue.schedule.endHour).toBe(6);
    expect(body2.queue.schedule.timezone).toBe("America/New_York");
    expect(body2.queue.schedule.stopActiveOnExit).toBe(true);
  });

  it("redacts the server's own credentials on GET", async () => {
    const res = await instance.fastify.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().auth.passwordHash).toBe("********");
    expect(res.json().auth.sessionSecret).toBe("********");
    expect(res.json().auth.username).toBe(USERNAME);
  });

  it("ignores a client-supplied auth block on PUT and keeps the real credentials usable for auth", async () => {
    const putRes = await instance.fastify.inject({
      method: "PUT",
      url: "/api/config",
      headers: { cookie },
      payload: { auth: { username: "attacker", passwordHash: "attacker-hash", sessionSecret: "b".repeat(32) } },
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().auth.username).toBe(USERNAME);

    // The real session must still work -- the auth block was not overwritten.
    const followUp = await instance.fastify.inject({
      method: "GET",
      url: "/api/libraries",
      headers: { cookie },
    });
    expect(followUp.statusCode).toBe(200);

    // The attacker-supplied username must not be able to log in with the original password.
    const attackerRes = await instance.fastify.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "attacker", password: PASSWORD },
    });
    expect(attackerRes.statusCode).toBe(401);
  });
});
