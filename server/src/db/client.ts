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
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  return db;
}
