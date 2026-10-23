import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getLibraries,
  getMediaInsights,
  type InsightBucket,
  type InsightFile,
  type Library,
  type MediaInsights as Insights,
} from "../api/client";

type Measure = "count" | "sizeBytes";

const VIDEO_CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1",
  mpeg4: "MPEG-4 Part 2",
  msmpeg4v3: "MS MPEG-4 v3",
  vc1: "VC-1",
  wmv3: "WMV 9",
  wmv2: "WMV 8",
  h263: "H.263",
  mjpeg: "Motion JPEG",
  theora: "Theora",
};

const AUDIO_CODEC_NAMES: Record<string, string> = {
  aac: "AAC",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  opus: "Opus",
  vorbis: "Vorbis",
  mp3: "MP3",
  mp2: "MP2",
  alac: "ALAC",
};

function videoCodecName(codec: string): string {
  return VIDEO_CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase();
}

function audioCodecName(codec: string): string {
  const lower = codec.toLowerCase();
  if (lower.startsWith("pcm_")) return "PCM";
  return AUDIO_CODEC_NAMES[lower] ?? codec.toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

function formatRuntime(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(seconds / 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return "unknown";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`;
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

function BarList({
  title,
  buckets,
  measure,
  label = (key) => key,
  note,
  keepOrder = false,
}: {
  title: string;
  buckets: InsightBucket[];
  measure: Measure;
  label?: (key: string) => string;
  note?: string;
  // For ordered categories (resolutions), keep the server's order instead of
  // sorting by value.
  keepOrder?: boolean;
}) {
  const rows = keepOrder ? buckets : [...buckets].sort((a, b) => b[measure] - a[measure]);
  const total = rows.reduce((sum, row) => sum + row[measure], 0);
  const max = rows.reduce((m, row) => Math.max(m, row[measure]), 0);

  return (
    <div className="card insight-card">
      <h2 className="insight-title">{title}</h2>
      {note && <p className="insight-note">{note}</p>}
      {rows.length === 0 ? (
        <p className="insight-note">No files in this group.</p>
      ) : (
        <ul className="bar-list">
          {rows.map((row) => {
            const value = row[measure];
            const name = label(row.key);
            const detail = `${name}: ${row.count} ${row.count === 1 ? "file" : "files"}, ${formatBytes(row.sizeBytes)}${
              row.potentialSavingsBytes > 0 ? `, could save ${formatBytes(row.potentialSavingsBytes)}` : ""
            }`;
            return (
              <li key={row.key} className="bar-row" title={detail}>
                <span className="bar-label">{name}</span>
                <span className="bar-track" aria-hidden="true">
                  <span className="bar-fill" style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%` }} />
                </span>
                <span className="bar-value">
                  {measure === "count" ? row.count.toLocaleString() : formatBytes(row.sizeBytes)}
                  <span className="bar-share">{percent(value, total)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FileTable({ title, note, files, libraries }: { title: string; note: string; files: InsightFile[]; libraries: Library[] }) {
  const libraryName = (id: string) => libraries.find((lib) => lib.id === id)?.name ?? id;
  const showRatio = files.some((file) => file.bitrateVsAverage !== undefined);
  return (
    <div className="card insight-card insight-block">
      <h2 className="insight-title">{title}</h2>
      <p className="insight-note">{note}</p>
      {files.length === 0 ? (
        <p className="insight-note">Not enough video files to compare yet.</p>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Codec</th>
                <th>Resolution</th>
                <th className="num">Size</th>
                <th className="num">Bitrate</th>
                {showRatio && <th className="num">Vs. average</th>}
                <th>Scan verdict</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.path}>
                  <td>
                    <div className="insight-file" title={file.path}>{fileName(file.path)}</div>
                    <div className="insight-subtle">{libraryName(file.libraryId)}</div>
                  </td>
                  <td>{videoCodecName(file.codec)}</td>
                  <td>
                    {file.resolution}
                    {file.isHdr && <span className="badge badge-hdr insight-badge">HDR</span>}
                  </td>
                  <td className="num">{formatBytes(file.sizeBytes)}</td>
                  <td className="num">{formatBitrate(file.bitrateKbps)}</td>
                  {showRatio && <td className="num">{file.bitrateVsAverage ? `${file.bitrateVsAverage}×` : ""}</td>}
                  <td>{file.recommendedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MediaInsights() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [libraryId, setLibraryId] = useState<string>("");
  const [measure, setMeasure] = useState<Measure>("count");
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLibraries().then(setLibraries).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMediaInsights(libraryId || undefined)
      .then((data) => {
        if (cancelled) return;
        setInsights(data);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  const totals = insights?.totals;
  const videoFiles = totals?.videoFiles ?? 0;

  const flags = totals
    ? [
        { label: "Older codecs", value: totals.legacyCodecCount, hint: "MPEG-2, MPEG-4 Part 2, VC-1, WMV and similar. Many players can't direct-play them, and they compress poorly." },
        { label: "Below 720p", value: totals.belowHdCount, hint: "480p and SD files. Candidates for a better release in Sonarr or Radarr rather than a re-encode." },
        { label: "No subtitles", value: totals.withoutSubtitlesCount, hint: "Video files with no embedded subtitle track. External .srt files are not counted." },
        { label: "HDR", value: totals.hdrCount, hint: "HDR10 or HLG. Presets with HDR preserved keep this metadata." },
        { label: "10-bit", value: totals.tenBitCount, hint: "10-bit video. Encoding it on the GPU needs HEVC Main10 or AV1 support." },
        { label: "Surround audio", value: totals.surroundCount, hint: "More than two audio channels on the main track." },
      ]
    : [];

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Media</h1>
          <p className="page-subtitle">
            What your scanned libraries are made of
            {totals?.lastScannedAt ? `, as of the last scan on ${new Date(totals.lastScannedAt).toLocaleString()}` : ""}.
          </p>
        </div>
      </div>

      <div className="insight-filters">
        <label className="insight-filter">
          <span>Library</span>
          <select className="form-select" value={libraryId} onChange={(e) => setLibraryId(e.target.value)}>
            <option value="">All libraries</option>
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>{lib.name}</option>
            ))}
          </select>
        </label>
        <div className="insight-filter" role="group" aria-label="Measure breakdowns by">
          <span>Measure by</span>
          <div className="segmented">
            <button type="button" className={measure === "count" ? "active" : ""} aria-pressed={measure === "count"} onClick={() => setMeasure("count")}>
              Files
            </button>
            <button type="button" className={measure === "sizeBytes" ? "active" : ""} aria-pressed={measure === "sizeBytes"} onClick={() => setMeasure("sizeBytes")}>
              Storage
            </button>
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {insights && totals && totals.files === 0 && (
        <div className="card empty-state">
          <h3 className="empty-state-title">Nothing scanned yet</h3>
          <p className="empty-state-desc">
            Run a scan from the <Link to="/">Dashboard</Link> and this page fills in from the results.
          </p>
        </div>
      )}

      {insights && totals && totals.files > 0 && (
        <>
          <div className="grid-4">
            <div className="card stat-card">
              <span className="stat-label">Files</span>
              <span className="stat-value">{totals.files.toLocaleString()}</span>
              <span className="stat-subtext">
                {videoFiles.toLocaleString()} video{totals.audioFiles > 0 ? `, ${totals.audioFiles.toLocaleString()} audio` : ""}
              </span>
            </div>
            <div className="card stat-card">
              <span className="stat-label">Storage</span>
              <span className="stat-value">{formatBytes(totals.sizeBytes)}</span>
              <span className="stat-subtext">{formatRuntime(totals.durationSeconds)} of playback</span>
            </div>
            <div className="card stat-card">
              <span className="stat-label">Average video bitrate</span>
              <span className="stat-value">{formatBitrate(totals.avgVideoBitrateKbps)}</span>
              <span className="stat-subtext">Total size over total runtime</span>
            </div>
            <div className="card stat-card">
              <span className="stat-label">Could save</span>
              <span className="stat-value savings">{formatBytes(totals.potentialSavingsBytes)}</span>
              <span className="stat-subtext">Scan estimate for files that can be queued</span>
            </div>
          </div>

          {videoFiles > 0 && (
            <div className="card insight-card insight-block">
              <h2 className="insight-title">Worth a look</h2>
              <ul className="flag-grid">
                {flags.map((flag) => (
                  <li key={flag.label} className="flag-item">
                    <span className="flag-value">{flag.value.toLocaleString()}</span>
                    <span className="flag-label">
                      {flag.label} <span className="insight-subtle">({percent(flag.value, videoFiles)} of video)</span>
                    </span>
                    <span className="insight-note">{flag.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid-2">
            <BarList title="Video codec" buckets={insights.videoCodecs} measure={measure} label={videoCodecName} />
            <BarList title="Resolution" buckets={insights.resolutions} measure={measure} keepOrder />
            <BarList title="Dynamic range" buckets={insights.dynamicRange} measure={measure} note="Dolby Vision is counted under HDR10 (PQ)." />
            <BarList title="Bit depth" buckets={insights.bitDepth} measure={measure} />
            <BarList title="Audio codec" buckets={insights.audioCodecs} measure={measure} label={audioCodecName} note="Main audio track only." />
            <BarList title="Audio channels" buckets={insights.audioChannels} measure={measure} note="Main audio track only." />
            <BarList title="Container" buckets={insights.containers} measure={measure} label={(key) => key.toUpperCase()} />
            <BarList title="Embedded subtitles" buckets={insights.subtitles} measure={measure} />
            <BarList title="Scan verdict" buckets={insights.actions} measure={measure} />
            <BarList
              title="Health check"
              buckets={insights.health}
              measure={measure}
              label={(key) => ({ unchecked: "Not checked", healthy: "Healthy", corrupt: "Corrupt", unverifiable: "Couldn't verify" })[key] ?? key}
            />
          </div>

          {insights.efficiency.length > 0 && (
            <div className="card insight-card insight-block">
              <h2 className="insight-title">Size per hour</h2>
              <p className="insight-note">
                How much one hour of video takes up, by codec and resolution. A group far above its neighbours at the same resolution is where re-encoding saves the most.
              </p>
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Resolution</th>
                      <th>Codec</th>
                      <th className="num">Files</th>
                      <th className="num">Per hour</th>
                      <th className="num">Average bitrate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.efficiency.map((row) => (
                      <tr key={`${row.resolution}-${row.codec}`}>
                        <td>{row.resolution}</td>
                        <td>{videoCodecName(row.codec)}</td>
                        <td className="num">{row.count.toLocaleString()}</td>
                        <td className="num">{formatBytes(row.bytesPerHour)}</td>
                        <td className="num">{formatBitrate(row.avgBitrateKbps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <FileTable
            title="Largest files"
            note="The ten biggest video files."
            files={insights.largestFiles}
            libraries={libraries}
          />
          <FileTable
            title="Highest bitrate for their resolution"
            note="Files with the highest bitrate compared with the average for their resolution (in this view, with at least three files to compare). These usually shrink the most."
            files={insights.highestBitrateForSize}
            libraries={libraries}
          />
        </>
      )}
    </div>
  );
}
