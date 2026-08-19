import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  filePath: string;
  presetId: string;
  status: JobStatus;
  progressPercent: number;
  fps: number;
  speed: string;
  encoderUsed: string | null;
  error: string | null;
  originalSizeBytes: number | null;
  newSizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  file_path: string;
  preset_id: string;
  status: JobStatus;
  progress_percent: number;
  fps: number | null;
  speed: string | null;
  encoder_used: string | null;
  error: string | null;
  original_size_bytes: number | null;
  new_size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    filePath: row.file_path,
    presetId: row.preset_id,
    status: row.status,
    progressPercent: row.progress_percent,
    fps: row.fps ?? 0,
    speed: row.speed ?? "0x",
    encoderUsed: row.encoder_used ?? null,
    error: row.error,
    originalSizeBytes: row.original_size_bytes,
    newSizeBytes: row.new_size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobsRepo {
  constructor(private readonly db: DatabaseSync) {}

  enqueueJob(filePath: string, presetId: string, originalSizeBytes: number): Job {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, file_path, preset_id, status, progress_percent, fps, speed, encoder_used, original_size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, 0, '0x', NULL, ?, ?, ?)`,
      )
      .run(id, filePath, presetId, originalSizeBytes, now, now);
    return this.getById(id)!;
  }

  hasActiveJobForPath(filePath: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM jobs WHERE file_path = ? AND status IN ('pending', 'running')`)
      .get(filePath);
    return row !== undefined;
  }

  getById(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  getNextPendingJob(): Job | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
      .get() as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  listJobs(status?: JobStatus): Job[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC")
          .all(status) as unknown as JobRow[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as unknown as JobRow[]);
    return rows.map(rowToJob);
  }

  markRunning(id: string, encoderUsed?: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'running', encoder_used = COALESCE(?, encoder_used), updated_at = ? WHERE id = ?")
      .run(encoderUsed ?? null, new Date().toISOString(), id);
  }

  markProgress(id: string, percent: number, fps?: number, speed?: string): void {
    this.db
      .prepare("UPDATE jobs SET progress_percent = ?, fps = COALESCE(?, fps), speed = COALESCE(?, speed), updated_at = ? WHERE id = ?")
      .run(percent, fps ?? null, speed ?? null, new Date().toISOString(), id);
  }

  markDone(id: string, newSizeBytes: number): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'done', progress_percent = 100, new_size_bytes = ?, updated_at = ? WHERE id = ?",
      )
      .run(newSizeBytes, new Date().toISOString(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  markCancelled(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  cancelAllPending(): number {
    const result = this.db
      .prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE status = 'pending'")
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  clearHistory(): number {
    const result = this.db
      .prepare("DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled')")
      .run();
    return Number(result.changes);
  }

  resetStuckRunningJobs(): number {
    const result = this.db
      .prepare("UPDATE jobs SET status = 'pending', progress_percent = 0, fps = 0, speed = '0x', updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    return Number(result.changes);
  }
}
