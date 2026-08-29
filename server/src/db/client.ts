import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSyncCtor(dbPath);
  
  // Configure SQLite for high concurrency, fast writes, and busy retry resilience
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000"); // 10s automatic retry on concurrent write contention
  db.exec("PRAGMA synchronous = NORMAL");  // Optimal performance and reduced disk sync contention with WAL
  db.exec("PRAGMA cache_size = -64000");   // 64MB memory cache
  db.exec("PRAGMA temp_store = MEMORY");

  runMigrations(db);
  return db;
}
