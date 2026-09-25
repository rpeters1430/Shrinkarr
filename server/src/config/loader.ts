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
        windows: [
          { day: 0, enabled: false, start: "07:30", end: "17:00" },
          { day: 1, enabled: true, start: "07:30", end: "17:00" },
          { day: 2, enabled: true, start: "07:30", end: "17:00" },
          { day: 3, enabled: true, start: "07:30", end: "17:00" },
          { day: 4, enabled: true, start: "07:30", end: "17:00" },
          { day: 5, enabled: true, start: "07:30", end: "17:00" },
          { day: 6, enabled: false, start: "07:30", end: "17:00" },
        ],
        stopActiveOnExit: true,
      },
    },
    scanner: {
      probeConcurrency: 4,
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
    const defaultConfig: Config = getDefaultConfig();
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

  const finalConfig: Config = {
    ...result.data,
    presets: mergedPresets,
  };

  if (presetsAdded) {
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
