import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { ConfigSchema, DEFAULT_PRESETS, type Config } from "./schema.js";

function generateApiKey(): string {
  return randomBytes(24).toString("base64url");
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

function announceGeneratedApiKey(apiKey: string, path: string): void {
  console.log(
    `\n=================================================================\n` +
      `  Generated a new Shrinkarr API key. Save it now:\n\n` +
      `    ${apiKey}\n\n` +
      `  It's required to access the web UI and API, and is stored in\n` +
      `  "${path}". You can also copy it from that file any time.\n` +
      `=================================================================\n`,
  );
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    const defaultConfig: Config = { ...getDefaultConfig(), apiKey: generateApiKey() };
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, stringify(defaultConfig), "utf-8");
    } catch {
      // If we can't write, return memory default
    }
    announceGeneratedApiKey(defaultConfig.apiKey!, path);
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

  if (!finalConfig.apiKey) {
    finalConfig = { ...finalConfig, apiKey: generateApiKey() };
    needSave = true;
    announceGeneratedApiKey(finalConfig.apiKey!, path);
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
