import type { DatabaseSync } from "node:sqlite";

export interface FileRecord {
  path: string;
  libraryId: string;
  codec: string;
  container: string;
  sizeBytes: number;
  durationSeconds: number;
  resolution: string;
  width: number;
  height: number;
  bitrateKbps: number;
  bitDepth: number;
  isHdr: boolean;
  audioCodec: string;
  audioChannels: number;
  subtitleCount: number;
  estimatedSavingsBytes: number;
  recommendedAction: string;
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
  resolution: string;
  width: number;
  height: number;
  bitrate_kbps: number;
  bit_depth: number;
  is_hdr: number;
  audio_codec: string;
  audio_channels: number;
  subtitle_count: number;
  estimated_savings_bytes: number;
  recommended_action: string;
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
    resolution: row.resolution ?? "1080p",
    width: row.width ?? 0,
    height: row.height ?? 0,
    bitrateKbps: row.bitrate_kbps ?? 0,
    bitDepth: row.bit_depth ?? 8,
    isHdr: row.is_hdr === 1,
    audioCodec: row.audio_codec ?? "unknown",
    audioChannels: row.audio_channels ?? 2,
    subtitleCount: row.subtitle_count ?? 0,
    estimatedSavingsBytes: row.estimated_savings_bytes ?? 0,
    recommendedAction: row.recommended_action ?? "Keep",
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
        `INSERT INTO files (
           path, library_id, codec, container, size_bytes, duration_seconds,
           resolution, width, height, bitrate_kbps, bit_depth, is_hdr,
           audio_codec, audio_channels, subtitle_count,
           estimated_savings_bytes, recommended_action,
           last_scanned_at, needs_transcode, skip_reason
         )
         VALUES (
           @path, @libraryId, @codec, @container, @sizeBytes, @durationSeconds,
           @resolution, @width, @height, @bitrateKbps, @bitDepth, @isHdr,
           @audioCodec, @audioChannels, @subtitleCount,
           @estimatedSavingsBytes, @recommendedAction,
           @lastScannedAt, @needsTranscode, @skipReason
         )
         ON CONFLICT(path) DO UPDATE SET
           library_id = excluded.library_id,
           codec = excluded.codec,
           container = excluded.container,
           size_bytes = excluded.size_bytes,
           duration_seconds = excluded.duration_seconds,
           resolution = excluded.resolution,
           width = excluded.width,
           height = excluded.height,
           bitrate_kbps = excluded.bitrate_kbps,
           bit_depth = excluded.bit_depth,
           is_hdr = excluded.is_hdr,
           audio_codec = excluded.audio_codec,
           audio_channels = excluded.audio_channels,
           subtitle_count = excluded.subtitle_count,
           estimated_savings_bytes = excluded.estimated_savings_bytes,
           recommended_action = excluded.recommended_action,
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
        resolution: record.resolution || "1080p",
        width: record.width || 0,
        height: record.height || 0,
        bitrateKbps: record.bitrateKbps || 0,
        bitDepth: record.bitDepth || 8,
        isHdr: record.isHdr ? 1 : 0,
        audioCodec: record.audioCodec || "unknown",
        audioChannels: record.audioChannels || 2,
        subtitleCount: record.subtitleCount || 0,
        estimatedSavingsBytes: record.estimatedSavingsBytes || 0,
        recommendedAction: record.recommendedAction || "Keep",
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

  deleteFileByPath(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  deleteFilesByLibrary(libraryId: string): number {
    const result = this.db.prepare("DELETE FROM files WHERE library_id = ?").run(libraryId);
    return Number(result.changes);
  }

  pruneMissingFiles(libraryId: string, validPaths: string[]): number {
    const existing = this.getFilesByLibrary(libraryId);
    const validSet = new Set(validPaths);
    let pruned = 0;
    for (const file of existing) {
      if (!validSet.has(file.path)) {
        this.deleteFileByPath(file.path);
        pruned += 1;
      }
    }
    return pruned;
  }

  getFilesByLibrary(libraryId: string): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE library_id = ? ORDER BY path ASC")
      .all(libraryId) as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  getAllFiles(): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files ORDER BY path ASC")
      .all() as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  getEligibleFiles(libraryId?: string): FileRecord[] {
    if (libraryId) {
      const rows = this.db
        .prepare("SELECT * FROM files WHERE library_id = ? AND needs_transcode = 1 ORDER BY size_bytes DESC")
        .all(libraryId) as unknown as FileRow[];
      return rows.map(rowToFile);
    }
    const rows = this.db
      .prepare("SELECT * FROM files WHERE needs_transcode = 1 ORDER BY size_bytes DESC")
      .all() as unknown as FileRow[];
    return rows.map(rowToFile);
  }
}
