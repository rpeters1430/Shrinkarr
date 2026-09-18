import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { getDefaultConfig, loadConfig } from "../src/config/loader.js";
import { verifyPassword } from "../src/auth/password.js";
import {
  runAuthCreate,
  runAuthReset,
  runAuthStatus,
  MIN_PASSWORD_LENGTH,
} from "../src/cli/authCommand.js";

describe("CLI authCommand", () => {
  let tempConfigPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-authcmd-"));
    tempConfigPath = join(dir, "config.yaml");
    const config = {
      ...getDefaultConfig(),
      dbPath: ":memory:",
      watcher: { enabled: false, intervalMinutes: 15, autoOptimize: false, settleDelaySeconds: 15 },
    };
    writeFileSync(tempConfigPath, stringify(config), "utf-8");
    process.env.SHRINKARR_CONFIG = tempConfigPath;
  });

  afterEach(() => {
    delete process.env.SHRINKARR_CONFIG;
  });

  describe("runAuthStatus", () => {
    it("reports not configured on a clean config", async () => {
      const status = await runAuthStatus();
      expect(status.configured).toBe(false);
      expect(status.username).toBeUndefined();
    });

    it("reports configured with username when auth is present", async () => {
      await runAuthCreate({ username: "myadmin", password: "password123" });
      const status = await runAuthStatus();
      expect(status.configured).toBe(true);
      expect(status.username).toBe("myadmin");
    });
  });

  describe("runAuthCreate", () => {
    it("rejects empty username", async () => {
      await expect(runAuthCreate({ username: "   ", password: "password123" })).rejects.toThrow(
        /Username cannot be empty/i,
      );
    });

    it("rejects empty password", async () => {
      await expect(runAuthCreate({ username: "myadmin", password: "" })).rejects.toThrow(
        /Password cannot be empty/i,
      );
    });

    it("rejects password shorter than minimum length", async () => {
      await expect(runAuthCreate({ username: "myadmin", password: "short" })).rejects.toThrow(
        new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`, "i"),
      );
    });

    it("creates an admin account with scrypt hash and session secret", async () => {
      await runAuthCreate({ username: "testuser", password: "securepassword123" });

      const updated = loadConfig(tempConfigPath);
      expect(updated.auth).toBeDefined();
      expect(updated.auth?.username).toBe("testuser");
      expect(updated.auth?.passwordHash).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
      expect(updated.auth?.sessionSecret.length).toBeGreaterThanOrEqual(32);
      expect(verifyPassword("securepassword123", updated.auth!.passwordHash)).toBe(true);
      expect(verifyPassword("wrongpassword", updated.auth!.passwordHash)).toBe(false);
    });

    it("rejects overwriting an existing account without --force", async () => {
      await runAuthCreate({ username: "user1", password: "password123" });

      await expect(
        runAuthCreate({ username: "user2", password: "password456", force: false }),
      ).rejects.toThrow(/already exists.*--force/i);

      const current = loadConfig(tempConfigPath);
      expect(current.auth?.username).toBe("user1");
    });

    it("overwrites an existing account when --force is specified", async () => {
      await runAuthCreate({ username: "user1", password: "password123" });
      await runAuthCreate({ username: "user2", password: "newpassword456", force: true });

      const updated = loadConfig(tempConfigPath);
      expect(updated.auth?.username).toBe("user2");
      expect(verifyPassword("newpassword456", updated.auth!.passwordHash)).toBe(true);
    });
  });

  describe("runAuthReset", () => {
    it("handles reset when no auth is configured gracefully", async () => {
      await expect(runAuthReset()).resolves.toBeUndefined();
      const current = loadConfig(tempConfigPath);
      expect(current.auth).toBeUndefined();
    });

    it("removes configured auth and preserves all other config", async () => {
      await runAuthCreate({ username: "removetest", password: "password123" });
      expect(loadConfig(tempConfigPath).auth).toBeDefined();

      await runAuthReset();
      const updated = loadConfig(tempConfigPath);
      expect(updated.auth).toBeUndefined();
      expect(updated.dbPath).toBe(":memory:");
      expect(updated.presets.length).toBeGreaterThan(0);
    });
  });
});
