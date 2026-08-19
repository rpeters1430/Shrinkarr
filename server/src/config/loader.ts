import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

export function loadConfig(path: string): Config {
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
