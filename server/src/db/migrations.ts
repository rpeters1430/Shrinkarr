import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db
    .prepare("SELECT version FROM _migrations WHERE version = ?")
    .get(SCHEMA_VERSION);

  if (applied) {
    return;
  }

  const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schemaSql);
  db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
}
