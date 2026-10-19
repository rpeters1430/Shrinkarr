import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PolicyMetadata } from "../media/types.js";

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
  healthStatus: HealthStatus;
  healthMode: string | null;
  healthCheckedAt: string | null;
  healthError: string | null;
  ignored: boolean;
  policyMetadata: PolicyMetadata | null;
}

// Ignored and corrupt files stay in the index but are never queued automatically.
const ELIGIBLE = "needs_transcode = 1 AND ignored = 0 AND health_status != 'corrupt'";

export type HealthStatus = "unchecked" | "healthy" | "corrupt" | "unverifiable";

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
  health_status?: string | null;
  health_mode?: string | null;
  health_checked_at?: string | null;
  health_error?: string | null;
  ignored?: number | null;
  policy_metadata?: string | null;
}

function parsePolicyMetadata(raw: string | null | undefined): PolicyMetadata | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PolicyMetadata>;
    if ((value.mediaKind !== "video" && value.mediaKind !== "audio") || typeof value.fps !== "number") return null;
    return value as PolicyMetadata;
  } catch {
    return null;
  }
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
    healthStatus: (row.health_status as HealthStatus | null | undefined) ?? "unchecked",
    healthMode: row.health_mode ?? null,
    healthCheckedAt: row.health_checked_at ?? null,
    healthError: row.health_error ?? null,
    ignored: row.ignored === 1,
    policyMetadata: parsePolicyMetadata(row.policy_metadata),
  };
}

const UPSERT_SQL = `INSERT INTO files (
     path, library_id, codec, container, size_bytes, duration_seconds,
     resolution, width, height, bitrate_kbps, bit_depth, is_hdr,
     audio_codec, audio_channels, subtitle_count,
     estimated_savings_bytes, recommended_action,
     last_scanned_at, mtime_ms, needs_transcode, skip_reason, policy_metadata
   )
   VALUES (
     @path, @libraryId, @codec, @container, @sizeBytes, @durationSeconds,
     @resolution, @width, @height, @bitrateKbps, @bitDepth, @isHdr,
     @audioCodec, @audioChannels, @subtitleCount,
     @estimatedSavingsBytes, @recommendedAction,
     @lastScannedAt, @mtimeMs, @needsTranscode, @skipReason, @policyMetadata
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
     skip_reason = excluded.skip_reason,
     policy_metadata = excluded.policy_metadata,
     health_status = CASE
       WHEN files.size_bytes != excluded.size_bytes OR files.mtime_ms != excluded.mtime_ms THEN 'unchecked'
       ELSE files.health_status END,
     health_error = CASE
       WHEN files.size_bytes != excluded.size_bytes OR files.mtime_ms != excluded.mtime_ms THEN NULL
       ELSE files.health_error END`;

// Health and the ignore flag are set by their own calls; a rescan keeps them,
// except that a file whose contents changed goes back to unchecked.
export type NewFileRecord = Omit<FileRecord, "lastScannedAt" | "healthStatus" | "healthMode" | "healthCheckedAt" | "healthError" | "ignored" | "policyMetadata"> & {
  policyMetadata?: PolicyMetadata | null;
};

export interface FileMetadata {
  sizeBytes: number;
  mtimeMs: number;
  needsTranscode: boolean;
  recommendedAction: string;
  estimatedSavingsBytes: number;
  codec: string;
  resolution: string;
  policyMetadata: PolicyMetadata | null;
}

export class FilesRepo {
  private upsertStmt: StatementSync | undefined;

  constructor(private readonly db: DatabaseSync) {}

  private runUpsert(record: NewFileRecord, now: string): void {
    this.upsertStmt ??= this.db.prepare(UPSERT_SQL);
    this.upsertStmt.run({
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
      skipReason: record.skipReason ?? null,
      policyMetadata: record.policyMetadata ? JSON.stringify(record.policyMetadata) : null,
    });
  }

  upsertFile(record: NewFileRecord): FileRecord {
    this.runUpsert(record, new Date().toISOString());
    return this.getFileByPath(record.path)!;
  }

  upsertFiles(records: readonly NewFileRecord[]): void {
    if (records.length === 0) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        this.runUpsert(record, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  countFilesByLibrary(libraryId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM files WHERE library_id = ?")
      .get(libraryId) as { count: number };
    return row.count;
  }

  getFileByPath(path: string): FileRecord | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | FileRow
      | undefined;
    return row ? rowToFile(row) : undefined;
  }

  getFileMetadataMap(libraryId: string): Map<string, FileMetadata> {
    const rows = this.db
      .prepare("SELECT path, size_bytes, mtime_ms, needs_transcode, recommended_action, estimated_savings_bytes, codec, resolution, policy_metadata FROM files WHERE library_id = ?")
      .all(libraryId) as unknown as Array<{
        path: string;
        size_bytes: number;
        mtime_ms: number;
        needs_transcode: number;
        recommended_action: string;
        estimated_savings_bytes: number;
        codec: string;
        resolution: string;
        policy_metadata?: string | null;
      }>;
    const map = new Map<string, FileMetadata>();
    for (const r of rows) {
      map.set(r.path, {
        sizeBytes: r.size_bytes,
        mtimeMs: r.mtime_ms ?? 0,
        needsTranscode: r.needs_transcode === 1,
        recommendedAction: r.recommended_action ?? "Keep",
        estimatedSavingsBytes: r.estimated_savings_bytes ?? 0,
        codec: r.codec,
        resolution: r.resolution,
        policyMetadata: parsePolicyMetadata(r.policy_metadata),
      });
    }
    return map;
  }

  setHealth(path: string, status: HealthStatus, mode: string | null, error: string | null): void {
    this.db
      .prepare("UPDATE files SET health_status = ?, health_mode = ?, health_checked_at = ?, health_error = ? WHERE path = ?")
      .run(status, mode, new Date().toISOString(), error, path);
  }

  updateRecommendation(path: string, decision: {
    needsTranscode: boolean;
    recommendedAction: string;
    estimatedSavingsBytes: number;
    reason: string | null;
  }): void {
    this.db.prepare(`
      UPDATE files
      SET needs_transcode = ?, recommended_action = ?, estimated_savings_bytes = ?, skip_reason = ?
      WHERE path = ?
    `).run(
      decision.needsTranscode ? 1 : 0,
      decision.recommendedAction,
      decision.estimatedSavingsBytes,
      decision.reason,
      path,
    );
  }

  setIgnored(paths: readonly string[], ignored: boolean): number {
    if (paths.length === 0) return 0;
    const stmt = this.db.prepare("UPDATE files SET ignored = ? WHERE path = ?");
    let changed = 0;
    this.db.exec("BEGIN");
    try {
      for (const path of paths) changed += Number(stmt.run(ignored ? 1 : 0, path).changes);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }

  // Files a library-wide health check should cover. Ignored files are left out.
  getFilesForHealthCheck(libraryId?: string, onlyUnchecked = true): FileRecord[] {
    let query = "SELECT * FROM files WHERE ignored = 0";
    const params: string[] = [];
    if (libraryId) {
      query += " AND library_id = ?";
      params.push(libraryId);
    }
    if (onlyUnchecked) query += " AND health_status IN ('unchecked', 'unverifiable')";
    query += " ORDER BY path ASC";
    const rows = this.db.prepare(query).all(...params) as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  deleteFileByPath(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  deleteFilesByLibrary(libraryId: string): number {
    const result = this.db.prepare("DELETE FROM files WHERE library_id = ?").run(libraryId);
    return Number(result.changes);
  }

  pruneMissingFiles(libraryId: string, validPaths: Iterable<string>, knownExistingPaths?: Iterable<string>): number {
    const validSet = validPaths instanceof Set ? (validPaths as Set<string>) : new Set(validPaths);
    const toDelete: string[] = [];

    if (knownExistingPaths) {
      for (const p of knownExistingPaths) {
        if (!validSet.has(p)) {
          toDelete.push(p);
        }
      }
    } else {
      const existingRows = this.db
        .prepare("SELECT path FROM files WHERE library_id = ?")
        .all(libraryId) as unknown as Array<{ path: string }>;
      for (const row of existingRows) {
        if (!validSet.has(row.path)) {
          toDelete.push(row.path);
        }
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

  getFilesByLibraryPage(libraryId: string, offset: number, limit: number): FileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM files WHERE library_id = ? ORDER BY path ASC LIMIT ? OFFSET ?")
      .all(libraryId, limit, offset) as unknown as FileRow[];
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
        .prepare(`SELECT * FROM files WHERE library_id = ? AND ${ELIGIBLE} ORDER BY size_bytes DESC`)
        .all(libraryId) as unknown as FileRow[];
      return rows.map(rowToFile);
    }
    const rows = this.db
      .prepare(`SELECT * FROM files WHERE ${ELIGIBLE} ORDER BY size_bytes DESC`)
      .all() as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  getAggregatedStats(libraries: Array<{ id: string; name: string; path: string; mediaType: string; presetId: string; minFileSizeMb?: number }>) {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS filesScanned,
        COALESCE(SUM(size_bytes), 0) AS totalLibrarySizeBytes,
        COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN estimated_savings_bytes ELSE 0 END), 0) AS totalPotentialSavingsBytes,
        COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN 1 ELSE 0 END), 0) AS recommendedCount,
        COALESCE(SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END), 0) AS healthyCount,
        COALESCE(SUM(CASE WHEN health_status = 'corrupt' THEN 1 ELSE 0 END), 0) AS corruptCount,
        COALESCE(SUM(CASE WHEN health_status = 'unverifiable' THEN 1 ELSE 0 END), 0) AS unverifiableCount,
        COALESCE(SUM(CASE WHEN ignored = 1 THEN 1 ELSE 0 END), 0) AS ignoredCount
      FROM files
    `).get() as {
      filesScanned: number;
      totalLibrarySizeBytes: number;
      totalPotentialSavingsBytes: number;
      recommendedCount: number;
      healthyCount: number;
      corruptCount: number;
      unverifiableCount: number;
      ignoredCount: number;
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
        COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN estimated_savings_bytes ELSE 0 END), 0) AS potentialSavingsBytes,
        COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN 1 ELSE 0 END), 0) AS eligibleCount
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
      healthyCount: totals.healthyCount,
      corruptCount: totals.corruptCount,
      unverifiableCount: totals.unverifiableCount,
      ignoredCount: totals.ignoredCount,
      codecBreakdown,
      resolutionBreakdown,
      librarySummaries,
    };
  }
}
