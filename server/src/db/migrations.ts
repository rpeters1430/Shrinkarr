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
  {
    version: 3,
    description: "add mtime_ms column to files for fast incremental scanning",
    up: (db) => {
      if (tableColumns(db, "files").size === 0) return;
      addColumnIfMissing(db, "files", "mtime_ms", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 4,
    description: "add composite indexes for queue polling and library filtering performance",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_files_library_needs_transcode ON files(library_id, needs_transcode);
        CREATE INDEX IF NOT EXISTS idx_files_needs_transcode_size ON files(needs_transcode, size_bytes DESC);
      `);
    },
  },
  {
    version: 5,
    description: "add fallback_reason to jobs so a CPU fallback shows why the GPU encode failed",
    up: (db) => {
      if (tableColumns(db, "jobs").size === 0) return;
      addColumnIfMissing(db, "jobs", "fallback_reason", "TEXT");
    },
  },
  {
    version: 6,
    description: "add health checks, ignore flag, job kinds and logs, and the job history table",
    up: (db) => {
      if (tableColumns(db, "files").size > 0) {
        addColumnIfMissing(db, "files", "health_status", "TEXT NOT NULL DEFAULT 'unchecked'");
        addColumnIfMissing(db, "files", "health_mode", "TEXT");
        addColumnIfMissing(db, "files", "health_checked_at", "TEXT");
        addColumnIfMissing(db, "files", "health_error", "TEXT");
        addColumnIfMissing(db, "files", "ignored", "INTEGER NOT NULL DEFAULT 0");
      }
      if (tableColumns(db, "jobs").size > 0) {
        addColumnIfMissing(db, "jobs", "kind", "TEXT NOT NULL DEFAULT 'transcode'");
        addColumnIfMissing(db, "jobs", "log", "TEXT");
        addColumnIfMissing(db, "jobs", "started_at", "TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status)");
      }
      // Kept apart from jobs so clearing the queue doesn't erase the record
      // of what was done to each file.
      db.exec(`
        CREATE TABLE IF NOT EXISTS history (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          library_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          preset_id TEXT,
          encoder TEXT,
          error TEXT,
          original_size_bytes INTEGER,
          new_size_bytes INTEGER,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          before_json TEXT,
          after_json TEXT,
          log TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_history_finished_at ON history(finished_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_file_path ON history(file_path);
      `);
    },
  },
  {
    version: 7,
    description: "clear corrupt verdicts caused by null-muxer timestamp warnings",
    up: (db) => {
      // The first health checks counted the null muxer's complaints about
      // repeated timestamps as decode errors. Those files go back to
      // unchecked; any real errors will show up again on the next check.
      if (!tableColumns(db, "files").has("health_status")) return;
      db.exec(`
        UPDATE files SET health_status = 'unchecked', health_error = NULL
        WHERE health_status = 'corrupt' AND health_error LIKE '%non monotonically increasing dts%'
      `);
    },
  },
  {
    version: 8,
    description: "persist supplemental ffprobe metadata used by scan policy",
    up: (db) => {
      if (tableColumns(db, "files").size === 0) return;
      addColumnIfMissing(db, "files", "policy_metadata", "TEXT");
    },
  },
  {
    version: 9,
    description: "add remote worker registry and job lease fields",
    up: (db) => {
      if (tableColumns(db, "jobs").size > 0) {
        addColumnIfMissing(db, "jobs", "worker_id", "TEXT");
        addColumnIfMissing(db, "jobs", "lease_id", "TEXT");
        addColumnIfMissing(db, "jobs", "lease_expires_at", "TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_worker_lease ON jobs(worker_id, lease_expires_at)");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS remote_workers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_seen_at TEXT,
          revoked_at TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_remote_workers_last_seen ON remote_workers(last_seen_at);
      `);
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
