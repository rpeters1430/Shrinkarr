import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (r) => r.name,
  );
}

let db: DatabaseSync;

afterEach(() => {
  db?.close();
});

describe("runMigrations", () => {
  it("creates the full schema on a brand-new database", () => {
    db = new DatabaseSyncCtor(":memory:");
    runMigrations(db);

    expect(columnNames(db, "files")).toEqual(
      expect.arrayContaining(["path", "resolution", "bit_depth", "estimated_savings_bytes"]),
    );
    expect(columnNames(db, "jobs")).toEqual(expect.arrayContaining(["id", "fps", "speed", "encoder_used"]));

    const applied = db.prepare("SELECT version FROM _migrations ORDER BY version").all() as unknown as {
      version: number;
    }[];
    expect(applied.map((r) => r.version)).toEqual([1, 2]);
  });

  it("is idempotent across repeated calls on the same connection", () => {
    db = new DatabaseSyncCtor(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const applied = db.prepare("SELECT version FROM _migrations").all() as unknown as { version: number }[];
    expect(applied).toHaveLength(2);
  });

  it("upgrades a v1-shaped database (no _migrations table, original columns only)", () => {
    db = new DatabaseSyncCtor(":memory:");
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        codec TEXT NOT NULL,
        container TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        duration_seconds REAL NOT NULL,
        last_scanned_at TEXT NOT NULL,
        needs_transcode INTEGER NOT NULL,
        skip_reason TEXT
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_percent REAL NOT NULL DEFAULT 0,
        error TEXT,
        original_size_bytes INTEGER,
        new_size_bytes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO files (path, library_id, codec, container, size_bytes, duration_seconds, last_scanned_at, needs_transcode, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("/media/old.mkv", "movies", "h264", "mkv", 1000, 60, new Date().toISOString(), 1, null);

    runMigrations(db);

    expect(columnNames(db, "files")).toEqual(expect.arrayContaining(["resolution", "bit_depth", "is_hdr"]));
    expect(columnNames(db, "jobs")).toEqual(expect.arrayContaining(["fps", "speed", "encoder_used"]));

    // The pre-existing row survives the upgrade with sane defaults for new columns.
    const row = db.prepare("SELECT * FROM files WHERE path = ?").get("/media/old.mkv") as Record<string, unknown>;
    expect(row.resolution).toBe("1080p");
    expect(row.bit_depth).toBe(8);
  });

  it("upgrades a database previously migrated under the old single-version _migrations scheme", () => {
    // The pre-refactor migrations.ts only ever recorded version 2 (via INSERT OR
    // REPLACE, unconditionally) and never recorded version 1. Simulate that state
    // and confirm the new ordered runner backfills version 1 without crashing or
    // duplicating columns.
    db = new DatabaseSyncCtor(":memory:");
    db.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        codec TEXT NOT NULL,
        container TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        duration_seconds REAL NOT NULL,
        resolution TEXT NOT NULL DEFAULT '1080p',
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        bitrate_kbps INTEGER NOT NULL DEFAULT 0,
        bit_depth INTEGER NOT NULL DEFAULT 8,
        is_hdr INTEGER NOT NULL DEFAULT 0,
        audio_codec TEXT NOT NULL DEFAULT 'unknown',
        audio_channels INTEGER NOT NULL DEFAULT 2,
        subtitle_count INTEGER NOT NULL DEFAULT 0,
        estimated_savings_bytes INTEGER NOT NULL DEFAULT 0,
        recommended_action TEXT NOT NULL DEFAULT 'Keep',
        last_scanned_at TEXT NOT NULL,
        needs_transcode INTEGER NOT NULL,
        skip_reason TEXT
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_percent REAL NOT NULL DEFAULT 0,
        fps REAL DEFAULT 0,
        speed TEXT DEFAULT '0x',
        encoder_used TEXT,
        error TEXT,
        original_size_bytes INTEGER,
        new_size_bytes INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    expect(() => runMigrations(db)).not.toThrow();

    const applied = db.prepare("SELECT version FROM _migrations ORDER BY version").all() as unknown as {
      version: number;
    }[];
    expect(applied.map((r) => r.version)).toEqual([1, 2]);
  });
});
