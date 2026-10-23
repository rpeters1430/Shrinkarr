import type { DatabaseSync, SQLInputValue } from "node:sqlite";

// Rolls the scanned file index up into the numbers behind the Media page:
// what the library is made of (codecs, resolutions, HDR, audio...) and which
// files stand out. Everything comes from columns the scanner already stores,
// so no extra probing is needed.

export interface InsightBucket {
  key: string;
  count: number;
  sizeBytes: number;
  durationSeconds: number;
  // Savings the scan estimated for files in this bucket that are queued or
  // could be queued (not ignored, not corrupt).
  potentialSavingsBytes: number;
}

export interface InsightFile {
  path: string;
  libraryId: string;
  codec: string;
  resolution: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationSeconds: number;
  bitrateKbps: number;
  isHdr: boolean;
  recommendedAction: string;
  // Only on highestBitrateForSize: this file's bitrate over the average for
  // files of the same resolution in the same scope.
  bitrateVsAverage?: number;
}

export interface EfficiencyRow {
  codec: string;
  resolution: string;
  count: number;
  // Average size of one hour of video, the easiest way to compare encodes of
  // different lengths.
  bytesPerHour: number;
  avgBitrateKbps: number;
}

export interface MediaInsights {
  libraryId: string | null;
  totals: {
    files: number;
    videoFiles: number;
    audioFiles: number;
    sizeBytes: number;
    durationSeconds: number;
    avgVideoBitrateKbps: number;
    hdrCount: number;
    tenBitCount: number;
    legacyCodecCount: number;
    belowHdCount: number;
    withoutSubtitlesCount: number;
    surroundCount: number;
    potentialSavingsBytes: number;
    lastScannedAt: string | null;
  };
  videoCodecs: InsightBucket[];
  resolutions: InsightBucket[];
  dynamicRange: InsightBucket[];
  bitDepth: InsightBucket[];
  containers: InsightBucket[];
  audioCodecs: InsightBucket[];
  audioChannels: InsightBucket[];
  subtitles: InsightBucket[];
  actions: InsightBucket[];
  health: InsightBucket[];
  efficiency: EfficiencyRow[];
  largestFiles: InsightFile[];
  // Furthest above the average bitrate for their resolution: the files most
  // likely to shrink.
  highestBitrateForSize: InsightFile[];
}

// Codecs a modern player may not direct-play, or that compress poorly.
export const LEGACY_VIDEO_CODECS = [
  "mpeg1video",
  "mpeg2video",
  "mpeg4",
  "msmpeg4v1",
  "msmpeg4v2",
  "msmpeg4v3",
  "wmv1",
  "wmv2",
  "wmv3",
  "vc1",
  "h263",
  "mjpeg",
  "theora",
  "rv40",
  "flv1",
];

const ELIGIBLE = "needs_transcode = 1 AND ignored = 0 AND health_status != 'corrupt'";
const MEDIA_KIND = "COALESCE(json_extract(policy_metadata, '$.mediaKind'), CASE WHEN width > 0 THEN 'video' ELSE 'audio' END)";
const IS_VIDEO = `${MEDIA_KIND} = 'video'`;
const LEGACY_LIST = LEGACY_VIDEO_CODECS.map((codec) => `'${codec}'`).join(", ");
const RESOLUTION_ORDER = ["4K", "1440p", "1080p", "720p", "480p", "SD"];

interface BucketRow {
  key: string | null;
  count: number;
  sizeBytes: number;
  durationSeconds: number;
  potentialSavingsBytes: number;
}

interface FileRow {
  path: string;
  library_id: string;
  codec: string;
  resolution: string;
  width: number;
  height: number;
  size_bytes: number;
  duration_seconds: number;
  bitrate_kbps: number;
  is_hdr: number;
  recommended_action: string;
  ratio?: number;
}

function toFile(row: FileRow): InsightFile {
  return {
    path: row.path,
    libraryId: row.library_id,
    codec: row.codec,
    resolution: row.resolution,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    bitrateKbps: row.bitrate_kbps,
    isHdr: row.is_hdr === 1,
    recommendedAction: row.recommended_action,
    ...(row.ratio !== undefined ? { bitrateVsAverage: Math.round(row.ratio * 10) / 10 } : {}),
  };
}

export function getMediaInsights(db: DatabaseSync, libraryId?: string): MediaInsights {
  const scope = libraryId ? "library_id = ?" : "1 = 1";
  const params: SQLInputValue[] = libraryId ? [libraryId] : [];

  const buckets = (keyExpr: string, filter = "1 = 1"): InsightBucket[] => {
    const rows = db.prepare(`
      SELECT
        ${keyExpr} AS key,
        COUNT(*) AS count,
        COALESCE(SUM(size_bytes), 0) AS sizeBytes,
        COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
        COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN estimated_savings_bytes ELSE 0 END), 0) AS potentialSavingsBytes
      FROM files
      WHERE ${scope} AND ${filter}
      GROUP BY key
      ORDER BY sizeBytes DESC
    `).all(...params) as unknown as BucketRow[];
    return rows.map((row) => ({ ...row, key: row.key || "unknown" }));
  };

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS files,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} THEN 1 ELSE 0 END), 0) AS videoFiles,
      COALESCE(SUM(size_bytes), 0) AS sizeBytes,
      COALESCE(SUM(duration_seconds), 0) AS durationSeconds,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND duration_seconds > 0 THEN size_bytes ELSE 0 END), 0) AS videoBytes,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND duration_seconds > 0 THEN duration_seconds ELSE 0 END), 0) AS videoSeconds,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND is_hdr = 1 THEN 1 ELSE 0 END), 0) AS hdrCount,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND bit_depth >= 10 THEN 1 ELSE 0 END), 0) AS tenBitCount,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND LOWER(codec) IN (${LEGACY_LIST}) THEN 1 ELSE 0 END), 0) AS legacyCodecCount,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND resolution IN ('480p', 'SD') THEN 1 ELSE 0 END), 0) AS belowHdCount,
      COALESCE(SUM(CASE WHEN ${IS_VIDEO} AND subtitle_count = 0 THEN 1 ELSE 0 END), 0) AS withoutSubtitlesCount,
      COALESCE(SUM(CASE WHEN audio_channels > 2 THEN 1 ELSE 0 END), 0) AS surroundCount,
      COALESCE(SUM(CASE WHEN ${ELIGIBLE} THEN estimated_savings_bytes ELSE 0 END), 0) AS potentialSavingsBytes,
      MAX(last_scanned_at) AS lastScannedAt
    FROM files
    WHERE ${scope}
  `).get(...params) as Record<string, number> & { lastScannedAt: string | null };

  const videoSeconds = totals.videoSeconds;
  const avgVideoBitrateKbps = videoSeconds > 0 ? Math.round((totals.videoBytes * 8) / videoSeconds / 1000) : 0;

  const resolutions = buckets("resolution", IS_VIDEO).sort(
    (a, b) => rankOf(RESOLUTION_ORDER, a.key) - rankOf(RESOLUTION_ORDER, b.key),
  );

  const efficiencyRows = db.prepare(`
    SELECT
      LOWER(codec) AS codec,
      resolution,
      COUNT(*) AS count,
      SUM(size_bytes) AS sizeBytes,
      SUM(duration_seconds) AS durationSeconds
    FROM files
    WHERE ${scope} AND ${IS_VIDEO} AND duration_seconds > 0
    GROUP BY LOWER(codec), resolution
    HAVING COUNT(*) >= 1
  `).all(...params) as unknown as Array<{ codec: string; resolution: string; count: number; sizeBytes: number; durationSeconds: number }>;

  const efficiency = efficiencyRows
    .map((row) => ({
      codec: row.codec || "unknown",
      resolution: row.resolution,
      count: row.count,
      bytesPerHour: Math.round((row.sizeBytes / row.durationSeconds) * 3600),
      avgBitrateKbps: Math.round((row.sizeBytes * 8) / row.durationSeconds / 1000),
    }))
    .sort((a, b) => rankOf(RESOLUTION_ORDER, a.resolution) - rankOf(RESOLUTION_ORDER, b.resolution) || b.bytesPerHour - a.bytesPerHour);

  const fileColumns = "path, library_id, codec, resolution, width, height, size_bytes, duration_seconds, bitrate_kbps, is_hdr, recommended_action";

  const largestFiles = (db.prepare(`
    SELECT ${fileColumns} FROM files
    WHERE ${scope} AND ${IS_VIDEO}
    ORDER BY size_bytes DESC
    LIMIT 10
  `).all(...params) as unknown as FileRow[]).map(toFile);

  // Compared with the average for the same resolution, because bits per
  // pixel naturally fall as resolution rises: ranking by raw bitrate favours
  // 4K, and ranking by bitrate per pixel favours SD.
  const highestBitrateForSize = (db.prepare(`
    SELECT * FROM (
      SELECT ${fileColumns},
        bitrate_kbps / AVG(CAST(bitrate_kbps AS REAL)) OVER (PARTITION BY resolution) AS ratio,
        COUNT(*) OVER (PARTITION BY resolution) AS peers
      FROM files
      WHERE ${scope} AND ${IS_VIDEO} AND bitrate_kbps > 0
    )
    WHERE peers >= 3 AND ratio > 1
    ORDER BY ratio DESC
    LIMIT 10
  `).all(...params) as unknown as FileRow[]).map(toFile);

  return {
    libraryId: libraryId ?? null,
    totals: {
      files: totals.files,
      videoFiles: totals.videoFiles,
      audioFiles: totals.files - totals.videoFiles,
      sizeBytes: totals.sizeBytes,
      durationSeconds: totals.durationSeconds,
      avgVideoBitrateKbps,
      hdrCount: totals.hdrCount,
      tenBitCount: totals.tenBitCount,
      legacyCodecCount: totals.legacyCodecCount,
      belowHdCount: totals.belowHdCount,
      withoutSubtitlesCount: totals.withoutSubtitlesCount,
      surroundCount: totals.surroundCount,
      potentialSavingsBytes: totals.potentialSavingsBytes,
      lastScannedAt: totals.lastScannedAt,
    },
    videoCodecs: buckets("LOWER(codec)", IS_VIDEO),
    resolutions,
    dynamicRange: buckets(
      "CASE WHEN is_hdr = 0 THEN 'SDR' WHEN LOWER(COALESCE(json_extract(policy_metadata, '$.colorTransfer'), '')) = 'arib-std-b67' THEN 'HLG' ELSE 'HDR10 (PQ)' END",
      IS_VIDEO,
    ),
    bitDepth: buckets("CASE WHEN bit_depth >= 10 THEN '10-bit' ELSE '8-bit' END", IS_VIDEO),
    containers: buckets("LOWER(container)"),
    audioCodecs: buckets("LOWER(audio_codec)"),
    audioChannels: buckets(
      "CASE audio_channels WHEN 1 THEN 'Mono' WHEN 2 THEN 'Stereo' WHEN 6 THEN '5.1' WHEN 8 THEN '7.1' ELSE audio_channels || ' channels' END",
    ),
    subtitles: buckets(
      "CASE WHEN subtitle_count = 0 THEN 'None' WHEN subtitle_count = 1 THEN '1 track' WHEN subtitle_count <= 3 THEN '2-3 tracks' ELSE '4+ tracks' END",
      IS_VIDEO,
    ),
    actions: buckets("CASE WHEN ignored = 1 THEN 'Ignored' ELSE recommended_action END"),
    health: buckets("health_status"),
    efficiency,
    largestFiles,
    highestBitrateForSize,
  };
}

function rankOf(order: string[], key: string): number {
  const index = order.indexOf(key);
  return index === -1 ? order.length : index;
}
