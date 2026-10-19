import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface WorkerCapabilities {
  ffmpegVersion?: string;
  ffmpegAvailable: boolean;
  mediaKinds: Array<"video" | "audio">;
  libraryIds: string[];
  encoders?: string[];
}

export interface RemoteWorker {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  status: "online" | "offline" | "revoked";
  capabilities: WorkerCapabilities | Record<string, unknown>;
  lastError: string | null;
}

interface RemoteWorkerRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  capabilities_json: string;
  last_error: string | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToWorker(row: RemoteWorkerRow): RemoteWorker {
  const online = row.last_seen_at !== null && Date.now() - Date.parse(row.last_seen_at) <= 45_000;
  let capabilities: WorkerCapabilities | Record<string, unknown> = {};
  try {
    capabilities = JSON.parse(row.capabilities_json) as WorkerCapabilities;
  } catch {
    // Malformed capability state should not break the admin status endpoint.
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    status: row.revoked_at ? "revoked" : online ? "online" : "offline",
    capabilities,
    lastError: row.last_error,
  };
}

export class RemoteWorkersRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(name: string): { worker: RemoteWorker; token: string } {
    const cleanName = name.trim();
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare("INSERT INTO remote_workers (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, cleanName, tokenHash(token), now);
    return { worker: this.get(id)!, token };
  }

  list(): RemoteWorker[] {
    const rows = this.db.prepare("SELECT * FROM remote_workers ORDER BY created_at ASC")
      .all() as unknown as RemoteWorkerRow[];
    return rows.map(rowToWorker);
  }

  get(id: string): RemoteWorker | undefined {
    const row = this.db.prepare("SELECT * FROM remote_workers WHERE id = ?").get(id) as RemoteWorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  authenticate(token: string): RemoteWorker | undefined {
    if (!token) return undefined;
    const row = this.db.prepare("SELECT * FROM remote_workers WHERE token_hash = ? AND revoked_at IS NULL")
      .get(tokenHash(token)) as RemoteWorkerRow | undefined;
    return row ? rowToWorker(row) : undefined;
  }

  heartbeat(id: string, capabilities: WorkerCapabilities, error: string | null = null): void {
    this.db.prepare(`UPDATE remote_workers SET last_seen_at = ?, capabilities_json = ?, last_error = ?
      WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), JSON.stringify(capabilities), error, id);
  }

  revoke(id: string): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE remote_workers SET revoked_at = ?, last_error = NULL WHERE id = ? AND revoked_at IS NULL")
        .run(now, id);
      if (Number(result.changes) > 0) {
        this.db.prepare(`UPDATE jobs SET status = 'pending', progress_percent = 0, fps = 0, speed = '0x',
          worker_id = NULL, lease_id = NULL, lease_expires_at = NULL, error = 'Worker token revoked', updated_at = ?
          WHERE status = 'running' AND worker_id = ?`).run(now, id);
      }
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
