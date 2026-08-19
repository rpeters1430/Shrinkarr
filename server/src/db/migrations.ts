import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;
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

  // If table already exists from v1, perform column migrations safely
  try {
    const tableInfo = db.prepare("PRAGMA table_info(files)").all() as unknown as { name: string }[];
    const colNames = new Set(tableInfo.map((c) => c.name));

    if (colNames.has("path")) {
      if (!colNames.has("resolution")) db.exec("ALTER TABLE files ADD COLUMN resolution TEXT NOT NULL DEFAULT '1080p'");
      if (!colNames.has("width")) db.exec("ALTER TABLE files ADD COLUMN width INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("height")) db.exec("ALTER TABLE files ADD COLUMN height INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("bitrate_kbps")) db.exec("ALTER TABLE files ADD COLUMN bitrate_kbps INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("bit_depth")) db.exec("ALTER TABLE files ADD COLUMN bit_depth INTEGER NOT NULL DEFAULT 8");
      if (!colNames.has("is_hdr")) db.exec("ALTER TABLE files ADD COLUMN is_hdr INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("audio_codec")) db.exec("ALTER TABLE files ADD COLUMN audio_codec TEXT NOT NULL DEFAULT 'unknown'");
      if (!colNames.has("audio_channels")) db.exec("ALTER TABLE files ADD COLUMN audio_channels INTEGER NOT NULL DEFAULT 2");
      if (!colNames.has("subtitle_count")) db.exec("ALTER TABLE files ADD COLUMN subtitle_count INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("estimated_savings_bytes")) db.exec("ALTER TABLE files ADD COLUMN estimated_savings_bytes INTEGER NOT NULL DEFAULT 0");
      if (!colNames.has("recommended_action")) db.exec("ALTER TABLE files ADD COLUMN recommended_action TEXT NOT NULL DEFAULT 'Keep'");
    }

    const jobTableInfo = db.prepare("PRAGMA table_info(jobs)").all() as unknown as { name: string }[];
    const jobCols = new Set(jobTableInfo.map((c) => c.name));
    if (jobCols.has("id")) {
      if (!jobCols.has("fps")) db.exec("ALTER TABLE jobs ADD COLUMN fps REAL DEFAULT 0");
      if (!jobCols.has("speed")) db.exec("ALTER TABLE jobs ADD COLUMN speed TEXT DEFAULT '0x'");
      if (!jobCols.has("encoder_used")) db.exec("ALTER TABLE jobs ADD COLUMN encoder_used TEXT");
    }
  } catch {
    // If tables don't exist yet, schema.sql will create them
  }

  const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schemaSql);

  db.prepare("INSERT OR REPLACE INTO _migrations (version, applied_at) VALUES (?, ?)").run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
}
