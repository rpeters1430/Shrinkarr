import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { ConfigSchema, DEFAULT_PRESETS, type Auth, type Config } from "./schema.js";
import { hashPassword } from "../auth/password.js";
import { generateSessionSecret } from "../auth/session.js";

const DEFAULT_USERNAME = "admin";

function generateRandomPassword(): string {
  return randomBytes(9).toString("base64url");
}

function generateAuth(password: string): Auth {
  return {
    username: DEFAULT_USERNAME,
    passwordHash: hashPassword(password),
    sessionSecret: generateSessionSecret(),
  };
}

export function getDefaultConfig(): Config {
  return {
    libraries: [],
    presets: DEFAULT_PRESETS,
    integrations: {},
    queue: {
      concurrency: 1,
      tempSuffix: ".shrinkarr.tmp",
      pauseOnStreaming: false,
      lowPriority: true,
      threads: 0,
      minFreeSpaceGb: 10,
      fileLockRetryAttempts: 6,
      fileLockRetryDelaySeconds: 5,
      fileStabilityDelaySeconds: 15,
      schedule: {
        enabled: false,
        startHour: 1,
        endHour: 7,
        stopActiveOnExit: true,
      },
    },
    watcher: {
      enabled: true,
      intervalMinutes: 15,
      autoOptimize: false,
      settleDelaySeconds: 15,
    },
    dbPath: "data/shrinkarr.db",
    preferredHwAccel: "auto",
  };
}

function announceGeneratedCredentials(username: string, password: string, path: string): void {
  console.log(
    `\n=================================================================\n` +
      `  Generated Shrinkarr admin credentials. Save them now:\n\n` +
      `    Username: ${username}\n` +
      `    Password: ${password}\n\n` +
      `  They're required to access the web UI and API. The password is\n` +
      `  stored only as a hash in "${path}" and cannot be recovered — you\n` +
      `  can change it from Settings once logged in, or delete the "auth"\n` +
      `  section from that file to generate new credentials on restart.\n` +
      `=================================================================\n`,
  );
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    const password = generateRandomPassword();
    const defaultConfig: Config = { ...getDefaultConfig(), auth: generateAuth(password) };
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, stringify(defaultConfig), "utf-8");
    } catch {
      // If we can't write, return memory default
    }
    announceGeneratedCredentials(defaultConfig.auth!.username, password, path);
    return defaultConfig;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config file at "${path}": ${(err as Error).message}`, { cause: err });
  }

  const parsed = parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at "${path}":\n${result.error.format ? JSON.stringify(result.error.format(), null, 2) : result.error.message}`);
  }

  const userPresets = result.data.presets || [];
  const existingIds = new Set(userPresets.map((p) => p.id));
  const mergedPresets = [...userPresets];
  let presetsAdded = false;

  for (const defPreset of DEFAULT_PRESETS) {
    if (!existingIds.has(defPreset.id)) {
      mergedPresets.push(defPreset);
      presetsAdded = true;
    }
  }

  let finalConfig: Config = {
    ...result.data,
    presets: mergedPresets,
  };

  let needSave = false;

  if (!finalConfig.auth) {
    const password = generateRandomPassword();
    finalConfig = { ...finalConfig, auth: generateAuth(password) };
    needSave = true;
    announceGeneratedCredentials(finalConfig.auth!.username, password, path);
  }

  if (needSave || presetsAdded) {
    try {
      writeFileSync(path, stringify(finalConfig), "utf-8");
    } catch {
      // If we can't persist it, still use it for this run
    }
  }

  return finalConfig;
}

export function saveConfigFile(path: string, config: Config): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, stringify(config), "utf-8");
}
