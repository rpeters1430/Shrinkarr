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
  mtimeMs?: number;
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
  mtime_ms?: number;
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
    mtimeMs: row.mtime_ms ?? 0,
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
           last_scanned_at, mtime_ms, needs_transcode, skip_reason
         )
         VALUES (
           @path, @libraryId, @codec, @container, @sizeBytes, @durationSeconds,
           @resolution, @width, @height, @bitrateKbps, @bitDepth, @isHdr,
           @audioCodec, @audioChannels, @subtitleCount,
           @estimatedSavingsBytes, @recommendedAction,
           @lastScannedAt, @mtimeMs, @needsTranscode, @skipReason
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
           mtime_ms = excluded.mtime_ms,
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
        mtimeMs: record.mtimeMs ?? 0,
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

  getFileMetadataMap(libraryId: string): Map<string, { sizeBytes: number; mtimeMs: number; needsTranscode: boolean; recommendedAction: string; estimatedSavingsBytes: number; codec: string; resolution: string }> {
    const rows = this.db
      .prepare("SELECT path, size_bytes, mtime_ms, needs_transcode, recommended_action, estimated_savings_bytes, codec, resolution FROM files WHERE library_id = ?")
      .all(libraryId) as unknown as Array<{
        path: string;
        size_bytes: number;
        mtime_ms: number;
        needs_transcode: number;
        recommended_action: string;
        estimated_savings_bytes: number;
        codec: string;
        resolution: string;
      }>;
    const map = new Map<string, { sizeBytes: number; mtimeMs: number; needsTranscode: boolean; recommendedAction: string; estimatedSavingsBytes: number; codec: string; resolution: string }>();
    for (const r of rows) {
      map.set(r.path, {
        sizeBytes: r.size_bytes,
        mtimeMs: r.mtime_ms ?? 0,
        needsTranscode: r.needs_transcode === 1,
        recommendedAction: r.recommended_action ?? "Keep",
        estimatedSavingsBytes: r.estimated_savings_bytes ?? 0,
        codec: r.codec,
        resolution: r.resolution,
      });
    }
    return map;
  }

  deleteFileByPath(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  deleteFilesByLibrary(libraryId: string): number {
    const result = this.db.prepare("DELETE FROM files WHERE library_id = ?").run(libraryId);
    return Number(result.changes);
  }

  pruneMissingFiles(libraryId: string, validPaths: string[]): number {
    const existingRows = this.db
      .prepare("SELECT path FROM files WHERE library_id = ?")
      .all(libraryId) as unknown as Array<{ path: string }>;
    const validSet = new Set(validPaths);
    const toDelete: string[] = [];
    for (const row of existingRows) {
      if (!validSet.has(row.path)) {
        toDelete.push(row.path);
      }
    }
    if (toDelete.length === 0) return 0;
    const deleteStmt = this.db.prepare("DELETE FROM files WHERE path = ?");
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const path of toDelete) {
        deleteStmt.run(path);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return toDelete.length;
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

  getAggregatedStats(libraries: Array<{ id: string; name: string; path: string; mediaType: string; presetId: string; minFileSizeMb?: number }>) {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS filesScanned,
        COALESCE(SUM(size_bytes), 0) AS totalLibrarySizeBytes,
        COALESCE(SUM(CASE WHEN needs_transcode = 1 THEN estimated_savings_bytes ELSE 0 END), 0) AS totalPotentialSavingsBytes,
        COALESCE(SUM(CASE WHEN needs_transcode = 1 THEN 1 ELSE 0 END), 0) AS recommendedCount
      FROM files
    `).get() as {
      filesScanned: number;
      totalLibrarySizeBytes: number;
      totalPotentialSavingsBytes: number;
      recommendedCount: number;
    };

    const codecRows = this.db.prepare(`
      SELECT
        UPPER(codec) AS codec,
        COUNT(*) AS count,
        COALESCE(SUM(size_bytes), 0) AS sizeBytes
      FROM files
      GROUP BY UPPER(codec)
    `).all() as unknown as Array<{ codec: string; count: number; sizeBytes: number }>;

    const codecBreakdown: Record<string, { count: number; sizeBytes: number }> = {};
    for (const row of codecRows) {
      codecBreakdown[row.codec || "UNKNOWN"] = { count: row.count, sizeBytes: row.sizeBytes };
    }

    const resRows = this.db.prepare(`
      SELECT
        resolution,
        COUNT(*) AS count,
        COALESCE(SUM(size_bytes), 0) AS sizeBytes
      FROM files
      GROUP BY resolution
    `).all() as unknown as Array<{ resolution: string; count: number; sizeBytes: number }>;

    const resolutionBreakdown: Record<string, { count: number; sizeBytes: number }> = {};
    for (const row of resRows) {
      resolutionBreakdown[row.resolution || "1080p"] = { count: row.count, sizeBytes: row.sizeBytes };
    }

    const libRows = this.db.prepare(`
      SELECT
        library_id,
        COUNT(*) AS fileCount,
        COALESCE(SUM(size_bytes), 0) AS totalSizeBytes,
        COALESCE(SUM(CASE WHEN needs_transcode = 1 THEN estimated_savings_bytes ELSE 0 END), 0) AS potentialSavingsBytes,
        COALESCE(SUM(CASE WHEN needs_transcode = 1 THEN 1 ELSE 0 END), 0) AS eligibleCount
      FROM files
      GROUP BY library_id
    `).all() as unknown as Array<{
      library_id: string;
      fileCount: number;
      totalSizeBytes: number;
      potentialSavingsBytes: number;
      eligibleCount: number;
    }>;

    const libStatsMap = new Map(libRows.map((r) => [r.library_id, r]));

    const librarySummaries = libraries.map((lib) => {
      const stats = libStatsMap.get(lib.id);
      return {
        id: lib.id,
        name: lib.name,
        path: lib.path,
        mediaType: lib.mediaType,
        presetId: lib.presetId,
        minFileSizeMb: lib.minFileSizeMb,
        fileCount: stats?.fileCount ?? 0,
        totalSizeBytes: stats?.totalSizeBytes ?? 0,
        potentialSavingsBytes: stats?.potentialSavingsBytes ?? 0,
        eligibleCount: stats?.eligibleCount ?? 0,
      };
    });

    return {
      filesScanned: totals.filesScanned,
      totalLibrarySizeBytes: totals.totalLibrarySizeBytes,
      totalPotentialSavingsBytes: totals.totalPotentialSavingsBytes,
      recommendedCount: totals.recommendedCount,
      codecBreakdown,
      resolutionBreakdown,
      librarySummaries,
    };
  }
}
