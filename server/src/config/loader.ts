import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { ConfigSchema, DEFAULT_PRESETS, type Config } from "./schema.js";

export function getDefaultConfig(): Config {
  return {
    libraries: [],
    presets: DEFAULT_PRESETS,
    integrations: {},
    queue: {
      concurrency: 1,
      tempSuffix: ".shrinkarr.tmp",
      pauseOnStreaming: false,
      minFreeSpaceGb: 10,
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

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    const defaultConfig = getDefaultConfig();
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, stringify(defaultConfig), "utf-8");
    } catch {
      // If we can't write, return memory default
    }
    return defaultConfig;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config file at "${path}": ${(err as Error).message}`);
  }

  const parsed = parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at "${path}":\n${result.error.format ? JSON.stringify(result.error.format(), null, 2) : result.error.message}`);
  }

  return result.data;
}

export function saveConfigFile(path: string, config: Config): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, stringify(config), "utf-8");
}
