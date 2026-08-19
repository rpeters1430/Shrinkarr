import type { DatabaseSync } from "node:sqlite";

export interface FileRecord {
  path: string;
  libraryId: string;
  codec: string;
  container: string;
  sizeBytes: number;
  durationSeconds: number;
  lastScannedAt: string;
  needsTranscode: boolean;
  skipReason: string | null;
}

interface FileRow {
  path: string;
  library_id: string;
  codec: string;
  container: string;
  size_bytes: number;
  duration_seconds: number;
  last_scanned_at: string;
  needs_transcode: number;
  skip_reason: string | null;
}

function rowToFile(row: FileRow): FileRecord {
  return {
    path: row.path,
    libraryId: row.library_id,
    codec: row.codec,
    container: row.container,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    lastScannedAt: row.last_scanned_at,
    needsTranscode: row.needs_transcode === 1,
    skipReason: row.skip_reason,
  };
}

export class FilesRepo {
  constructor(private readonly db: DatabaseSync) {}

  upsertFile(record: Omit<FileRecord, "lastScannedAt">): FileRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO files (path, library_id, codec, container, size_bytes, duration_seconds, last_scanned_at, needs_transcode, skip_reason)
         VALUES (@path, @libraryId, @codec, @container, @sizeBytes, @durationSeconds, @lastScannedAt, @needsTranscode, @skipReason)
         ON CONFLICT(path) DO UPDATE SET
           library_id = excluded.library_id,
           codec = excluded.codec,
           container = excluded.container,
           size_bytes = excluded.size_bytes,
           duration_seconds = excluded.duration_seconds,
           last_scanned_at = excluded.last_scanned_at,
           needs_transcode = excluded.needs_transcode,
           skip_reason = excluded.skip_reason`,
      )
      .run({
        path: record.path,
        libraryId: record.libraryId,
        codec: record.codec,
        container: record.container,
        sizeBytes: record.sizeBytes,
        durationSeconds: record.durationSeconds,
        lastScannedAt: now,
        needsTranscode: record.needsTranscode ? 1 : 0,
        skipReason: record.skipReason,
      });
    return this.getFileByPath(record.path)!;
  }

  getFileByPath(path: string): FileRecord | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | FileRow
      | undefined;
    return row ? rowToFile(row) : undefined;
  }

  getFilesByLibrary(libraryId: string): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE library_id = ? ORDER BY path ASC")
      .all(libraryId) as unknown as FileRow[];
    return rows.map(rowToFile);
  }
}
