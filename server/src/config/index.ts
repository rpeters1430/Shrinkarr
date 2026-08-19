import { loadConfig } from "./loader.js";
import type { Config } from "./schema.js";

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) {
    const path = process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
    cached = loadConfig(path);
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export * from "./schema.js";
