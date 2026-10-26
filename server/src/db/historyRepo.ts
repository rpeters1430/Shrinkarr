import type { DatabaseSync } from "node:sqlite";
import type { MediaProbe } from "../media/types.js";

export type HistoryKind = "transcode" | "remux" | "health";
export type HistoryStatus = "done" | "failed";

// The parts of a probe worth showing side by side for "before" and "after".
export interface MediaSnapshot {
  container: string;
  videoCodec: string;
  resolution: string;
  width: number;
  height: number;
  bitDepth: number;
  isHdr: boolean;
  bitrateKbps: number;
  durationSeconds: number;
  sizeBytes: number;
  audio: SnapshotAudioTrack[];
  subtitles: SnapshotSubtitleTrack[];
}

// index and the flags below are missing from entries recorded before the
// track view existed.
export interface SnapshotAudioTrack {
  index?: number;
  codec: string;
  channels: number;
  language: string;
  title?: string;
  isDefault?: boolean;
  commentary?: boolean;
}

export interface SnapshotSubtitleTrack {
  index?: number;
  codec: string;
  language: string;
  forced: boolean;
  title?: string;
  commentary?: boolean;
  hearingImpaired?: boolean;
}

export function snapshotTracks(probe: Pick<MediaProbe, "audioTracks" | "subtitleTracks">): Pick<MediaSnapshot, "audio" | "subtitles"> {
  return {
    audio: (probe.audioTracks ?? []).map((t) => ({
      index: t.index, codec: t.codec, channels: t.channels, language: t.language, title: t.title, isDefault: t.isDefault, commentary: t.isCommentary,
    })),
    subtitles: (probe.subtitleTracks ?? []).map((t) => ({
      index: t.index, codec: t.codec, language: t.language, forced: t.isForced, title: t.title, commentary: t.isCommentary, hearingImpaired: t.isHearingImpaired,
    })),
  };
}

export function snapshotOf(probe: MediaProbe, sizeBytes = probe.sizeBytes): MediaSnapshot {
  return {
    container: probe.container,
    videoCodec: probe.mediaKind === "audio" ? "none" : probe.videoCodec,
    resolution: probe.mediaKind === "audio" ? "" : probe.resolutionLabel,
    width: probe.width,
    height: probe.height,
    bitDepth: probe.bitDepth,
    isHdr: probe.isHdr,
    bitrateKbps: probe.bitrateKbps,
    durationSeconds: probe.durationSeconds,
    sizeBytes,
    ...snapshotTracks(probe),
  };
}

export interface HistoryEntry {
  id: string;
  filePath: string;
  libraryId: string | null;
  kind: HistoryKind;
  status: HistoryStatus;
  presetId: string | null;
  encoder: string | null;
  error: string | null;
  originalSizeBytes: number | null;
  newSizeBytes: number | null;
  startedAt: string;
  finishedAt: string;
  before: MediaSnapshot | null;
  after: MediaSnapshot | null;
}

export type NewHistoryEntry = HistoryEntry & { log?: string | null };

interface HistoryRow {
  id: string;
  file_path: string;
  library_id: string | null;
  kind: string;
  status: string;
  preset_id: string | null;
  encoder: string | null;
  error: string | null;
  original_size_bytes: number | null;
  new_size_bytes: number | null;
  started_at: string;
  finished_at: string;
  before_json: string | null;
  after_json: string | null;
}

function parseSnapshot(json: string | null): MediaSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as MediaSnapshot;
  } catch {
    return null;
  }
}

function rowToEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    filePath: row.file_path,
    libraryId: row.library_id,
    kind: row.kind as HistoryKind,
    status: row.status as HistoryStatus,
    presetId: row.preset_id,
    encoder: row.encoder,
    error: row.error,
    originalSizeBytes: row.original_size_bytes,
    newSizeBytes: row.new_size_bytes,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    before: parseSnapshot(row.before_json),
    after: parseSnapshot(row.after_json),
  };
}

const ENTRY_COLUMNS = `id, file_path, library_id, kind, status, preset_id, encoder, error,
  original_size_bytes, new_size_bytes, started_at, finished_at, before_json, after_json`;

export interface HistoryFilter {
  status?: HistoryStatus;
  kind?: HistoryKind;
  libraryId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface HistorySummary {
  total: number;
  done: number;
  failed: number;
  savedBytes: number;
  transcodes: number;
  remuxes: number;
  healthChecks: number;
  corruptFound: number;
  // Newest last; only days with activity are listed.
  daily: Array<{ date: string; savedBytes: number; done: number; failed: number }>;
}

export class HistoryRepo {
  constructor(private readonly db: DatabaseSync) {}

  record(entry: NewHistoryEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO history (${ENTRY_COLUMNS}, log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.filePath,
        entry.libraryId,
        entry.kind,
        entry.status,
        entry.presetId,
        entry.encoder,
        entry.error,
        entry.originalSizeBytes,
        entry.newSizeBytes,
        entry.startedAt,
        entry.finishedAt,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.log ?? null,
      );
  }

  list(filter: HistoryFilter = {}): { entries: HistoryEntry[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.libraryId) {
      where.push("library_id = ?");
      params.push(filter.libraryId);
    }
    if (filter.search && filter.search.trim()) {
      where.push("file_path LIKE ? ESCAPE '\\'");
      params.push(`%${filter.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM history${whereSql}`).get(...params) as { count: number }).count;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM history${whereSql} ORDER BY finished_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as HistoryRow[];
    return { entries: rows.map(rowToEntry), total };
  }

  get(id: string): HistoryEntry | undefined {
    const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM history WHERE id = ?`).get(id) as HistoryRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  getLog(id: string): string | null | undefined {
    const row = this.db.prepare("SELECT log FROM history WHERE id = ?").get(id) as { log: string | null } | undefined;
    return row ? row.log : undefined;
  }

  summary(days = 30): HistorySummary {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'done' AND kind != 'health' AND new_size_bytes IS NOT NULL
          THEN original_size_bytes - new_size_bytes ELSE 0 END), 0) AS savedBytes,
        COALESCE(SUM(CASE WHEN kind = 'transcode' THEN 1 ELSE 0 END), 0) AS transcodes,
        COALESCE(SUM(CASE WHEN kind = 'remux' THEN 1 ELSE 0 END), 0) AS remuxes,
        COALESCE(SUM(CASE WHEN kind = 'health' THEN 1 ELSE 0 END), 0) AS healthChecks,
        COALESCE(SUM(CASE WHEN kind = 'health' AND error LIKE 'Corrupt:%' THEN 1 ELSE 0 END), 0) AS corruptFound
      FROM history
    `).get() as Omit<HistorySummary, "daily">;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const daily = this.db.prepare(`
      SELECT
        substr(finished_at, 1, 10) AS date,
        COALESCE(SUM(CASE WHEN status = 'done' AND kind != 'health' AND new_size_bytes IS NOT NULL
          THEN original_size_bytes - new_size_bytes ELSE 0 END), 0) AS savedBytes,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM history
      WHERE finished_at >= ?
      GROUP BY substr(finished_at, 1, 10)
      ORDER BY date ASC
    `).all(since) as unknown as HistorySummary["daily"];

    return { ...totals, savedBytes: Math.max(0, totals.savedBytes), daily };
  }

  clear(): number {
    return Number(this.db.prepare("DELETE FROM history").run().changes);
  }
}
