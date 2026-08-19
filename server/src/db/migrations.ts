import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

// Migrations run in order, oldest first. Each one is applied and recorded at
// most once (tracked in _migrations). To change the schema, add a new entry
// here rather than editing an existing one -- existing installs may have
// already applied it.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial files/jobs schema",
    up: (db) => {
      const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
      db.exec(schemaSql);
    },
  },
  {
    version: 2,
    description: "add media metadata columns to files, progress columns to jobs",
    up: (db) => {
      if (tableColumns(db, "files").size === 0) return; // table doesn't exist yet on a fresh install

      addColumnIfMissing(db, "files", "resolution", "TEXT NOT NULL DEFAULT '1080p'");
      addColumnIfMissing(db, "files", "width", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "height", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "bitrate_kbps", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "bit_depth", "INTEGER NOT NULL DEFAULT 8");
      addColumnIfMissing(db, "files", "is_hdr", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "audio_codec", "TEXT NOT NULL DEFAULT 'unknown'");
      addColumnIfMissing(db, "files", "audio_channels", "INTEGER NOT NULL DEFAULT 2");
      addColumnIfMissing(db, "files", "subtitle_count", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "estimated_savings_bytes", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "files", "recommended_action", "TEXT NOT NULL DEFAULT 'Keep'");

      if (tableColumns(db, "jobs").size === 0) return;
      addColumnIfMissing(db, "jobs", "fps", "REAL DEFAULT 0");
      addColumnIfMissing(db, "jobs", "speed", "TEXT DEFAULT '0x'");
      addColumnIfMissing(db, "jobs", "encoder_used", "TEXT");
    },
  },
];

export function runMigrations(db: DatabaseSync): void {
  // Keep this table's shape stable (version, applied_at only) -- existing installs
  // already have it in this exact shape from earlier releases, and CREATE TABLE
  // IF NOT EXISTS won't retroactively add columns to it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM _migrations").all() as unknown as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    migration.up(db);
    db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(
      migration.version,
      new Date().toISOString(),
    );
  }
}
