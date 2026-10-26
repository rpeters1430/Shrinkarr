import { Fragment, useCallback, useEffect, useState } from "react";
import {
  clearHistory,
  getHistory,
  getHistoryLog,
  getHistorySummary,
  getLibraries,
  type HistoryEntry,
  type HistoryKind,
  type HistorySummary,
  type Library,
  type MediaSnapshot,
} from "../api/client";
import { IconCheck, IconClose, IconTrash } from "../components/Icons";
import { LogModal } from "../components/LogModal";
import { TracksBeforeAfter } from "../components/TrackList";

const PAGE_SIZE = 50;

const KIND_LABELS: Record<HistoryKind, string> = {
  transcode: "Transcode",
  remux: "Remux",
  health: "Health check",
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatElapsed(startedAt: string, finishedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function videoSummary(snapshot: MediaSnapshot | null): string {
  if (!snapshot) return "-";
  if (snapshot.videoCodec === "none") return snapshot.audio[0]?.codec.toUpperCase() ?? "-";
  return `${snapshot.videoCodec.toUpperCase()} ${snapshot.resolution}`;
}

function trackLanguages(languages: string[]): string {
  if (languages.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const language of languages) counts.set(language, (counts.get(language) ?? 0) + 1);
  return Array.from(counts, ([language, count]) => (count > 1 ? `${count}× ${language}` : language)).join(", ");
}

function audioLabel(track: MediaSnapshot["audio"][number]): string {
  const layout = track.channels > 2 ? `${track.channels}ch` : track.channels === 1 ? "mono" : "2.0";
  return `${track.language} ${track.codec.toUpperCase()} ${layout}`;
}

// One line per change worth calling out, e.g. "H264 1080p → HEVC 720p".
function describeChanges(entry: HistoryEntry): string[] {
  const { before, after } = entry;
  if (!before || !after) return [];
  const changes: string[] = [];
  const videoBefore = videoSummary(before);
  const videoAfter = videoSummary(after);
  if (videoBefore !== videoAfter) changes.push(`${videoBefore} → ${videoAfter}`);
  if (before.container !== after.container) changes.push(`${before.container} → ${after.container}`);
  const audioBefore = before.audio.map(audioLabel).join(", ");
  const audioAfter = after.audio.map(audioLabel).join(", ");
  if (audioBefore !== audioAfter) changes.push(`Audio: ${audioBefore || "none"} → ${audioAfter || "none"}`);
  const subsBefore = trackLanguages(before.subtitles.map((t) => t.language));
  const subsAfter = trackLanguages(after.subtitles.map((t) => t.language));
  if (subsBefore !== subsAfter) changes.push(`Subtitles: ${subsBefore} → ${subsAfter}`);
  if (before.isHdr && !after.isHdr) changes.push("HDR → SDR");
  return changes;
}

function SnapshotDetails({ title, snapshot }: { title: string; snapshot: MediaSnapshot | null }) {
  if (!snapshot) {
    return (
      <div>
        <div className="history-detail-title">{title}</div>
        <div style={{ color: "var(--text-dim)" }}>Not recorded</div>
      </div>
    );
  }
  const isAudioOnly = snapshot.videoCodec === "none";
  return (
    <div>
      <div className="history-detail-title">{title}</div>
      <dl className="history-detail-list">
        <dt>Size</dt>
        <dd>{formatBytes(snapshot.sizeBytes)}</dd>
        <dt>Container</dt>
        <dd>{snapshot.container}</dd>
        {!isAudioOnly && (
          <>
            <dt>Video</dt>
            <dd>
              {snapshot.videoCodec.toUpperCase()} {snapshot.width}×{snapshot.height}, {snapshot.bitDepth}-bit
              {snapshot.isHdr ? ", HDR" : ""}
            </dd>
          </>
        )}
        <dt>Bitrate</dt>
        <dd>{snapshot.bitrateKbps > 0 ? `${(snapshot.bitrateKbps / 1000).toFixed(1)} Mbps` : "-"}</dd>
        {/* Video entries list their tracks in the before/after tables. */}
        {isAudioOnly && (
          <>
            <dt>Audio</dt>
            <dd>
              {snapshot.audio.length === 0
                ? "none"
                : snapshot.audio.map((track, i) => (
                  <div key={i}>
                    {audioLabel(track)}
                    {track.title ? ` · ${track.title}` : ""}
                  </div>
                ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<HistoryKind | "">("");
  const [status, setStatus] = useState<"done" | "failed" | "">("");
  const [libraryId, setLibraryId] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logEntry, setLogEntry] = useState<HistoryEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    getHistory({
      search,
      kind: kind || undefined,
      status: status || undefined,
      libraryId: libraryId || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((err) => setError(String(err)));
    getHistorySummary().then(setSummary).catch(() => {});
  }, [search, kind, status, libraryId, page]);

  useEffect(() => {
    getLibraries().then(setLibraries).catch(() => {});
  }, []);

  // Debounced so typing in the search box doesn't fire a request per key.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function handleClear() {
    if (!window.confirm("Delete the whole history? This doesn't touch any media files or the queue.")) return;
    setError(null);
    try {
      const res = await clearHistory();
      setSuccessMsg(`Deleted ${res.clearedCount} history entr${res.clearedCount === 1 ? "y" : "ies"}.`);
      setPage(1);
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const libraryName = (id: string | null) => libraries.find((lib) => lib.id === id)?.name ?? "";

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">History</h1>
          <p className="page-subtitle">
            Every transcode, remux and health check, with what changed in each file.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={handleClear} disabled={!summary?.total}>
            <IconTrash size={14} />
            <span>Clear History</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <IconClose size={16} />
          <span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="alert alert-success">
          <IconCheck size={16} />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="grid-4">
        <div className="card stat-card hero-stat">
          <span className="stat-label">Space Saved</span>
          <span className="stat-value savings">{summary ? formatBytes(summary.savedBytes) : "..."}</span>
          <span className="stat-subtext">
            {summary ? `${summary.transcodes} transcodes, ${summary.remuxes} remuxes` : ""}
          </span>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Finished</span>
          <span className="stat-value">{summary?.done ?? "..."}</span>
          <span className="stat-subtext">{summary ? `${summary.total} jobs recorded` : ""}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Failed</span>
          <span className="stat-value">{summary?.failed ?? "..."}</span>
          <span className="stat-subtext">Transcodes, remuxes and checks</span>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Corrupt Files Found</span>
          <span className="stat-value">{summary?.corruptFound ?? "..."}</span>
          <span className="stat-subtext">{summary ? `${summary.healthChecks} health checks run` : ""}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", margin: "1.5rem 0 1rem", flexWrap: "wrap" }}>
        <input
          className="form-input"
          style={{ flex: 1, minWidth: "220px" }}
          placeholder="Search by file name or path..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        <select className="form-select" style={{ width: "auto" }} value={kind} onChange={(e) => { setKind(e.target.value as HistoryKind | ""); setPage(1); }}>
          <option value="">All types</option>
          <option value="transcode">Transcodes</option>
          <option value="remux">Remuxes</option>
          <option value="health">Health checks</option>
        </select>
        <select className="form-select" style={{ width: "auto" }} value={status} onChange={(e) => { setStatus(e.target.value as "done" | "failed" | ""); setPage(1); }}>
          <option value="">Any result</option>
          <option value="done">Succeeded</option>
          <option value="failed">Failed</option>
        </select>
        {libraries.length > 1 && (
          <select className="form-select" style={{ width: "auto" }} value={libraryId} onChange={(e) => { setLibraryId(e.target.value); setPage(1); }}>
            <option value="">All libraries</option>
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>{lib.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: "30%", minWidth: "180px" }}>File</th>
              <th className="nowrap">Type</th>
              <th className="nowrap">Result</th>
              <th style={{ minWidth: "220px" }}>Changes</th>
              <th className="nowrap">Size</th>
              <th className="nowrap">Finished</th>
              <th style={{ textAlign: "right" }} className="nowrap">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 0 }}>
                  <div className="empty-state">
                    <h3 className="empty-state-title">No history yet</h3>
                    <p className="empty-state-desc">
                      {total === 0 && !search && !kind && !status && !libraryId
                        ? "Finished and failed jobs show up here, and stay here when the queue is cleared."
                        : "Nothing matches these filters."}
                    </p>
                  </div>
                </td>
              </tr>
            )}

            {entries.map((entry) => {
              const fileName = entry.filePath.split(/[/\\]/).pop() || entry.filePath;
              const changes = describeChanges(entry);
              const saved = entry.originalSizeBytes != null && entry.newSizeBytes != null
                ? entry.originalSizeBytes - entry.newSizeBytes
                : null;
              const expanded = expandedId === entry.id;
              return (
                <Fragment key={entry.id}>
                  <tr>
                    <td className="cell-video-info">
                      <div className="video-title" title={fileName}>{fileName}</div>
                      <div className="video-path" title={entry.filePath}>
                        {libraryName(entry.libraryId) ? `${libraryName(entry.libraryId)} · ` : ""}{entry.filePath}
                      </div>
                    </td>
                    <td className="nowrap">
                      <span className="badge badge-res">{KIND_LABELS[entry.kind]}</span>
                    </td>
                    <td className="nowrap">
                      {entry.status === "done" ? (
                        <span className="badge badge-status-done"><IconCheck size={12} /> {entry.kind === "health" ? "Healthy" : "Done"}</span>
                      ) : (
                        <span className="badge badge-status-failed"><IconClose size={12} /> {entry.kind === "health" ? "Corrupt" : "Failed"}</span>
                      )}
                    </td>
                    <td style={{ fontSize: "0.82rem" }}>
                      {entry.status === "failed" && entry.error ? (
                        <span style={{ color: "var(--accent-rose)", overflowWrap: "anywhere" }} title={entry.error}>
                          {entry.error.length > 120 ? `${entry.error.slice(0, 120)}...` : entry.error}
                        </span>
                      ) : changes.length > 0 ? (
                        changes.map((change) => <div key={change}>{change}</div>)
                      ) : (
                        <span style={{ color: "var(--text-dim)" }}>{entry.kind === "health" ? "No decode errors" : "-"}</span>
                      )}
                    </td>
                    <td className="nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {saved != null && entry.kind !== "health" ? (
                        <div>
                          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                            {formatBytes(entry.originalSizeBytes!)} → {formatBytes(entry.newSizeBytes!)}
                          </div>
                          <div style={{ fontWeight: 700, color: saved >= 0 ? "var(--accent-emerald)" : "var(--accent-rose)", fontSize: "0.85rem" }}>
                            {saved >= 0 ? "-" : "+"}{formatBytes(Math.abs(saved))}
                            {entry.originalSizeBytes ? ` (${Math.round((Math.abs(saved) / entry.originalSizeBytes) * 100)}%)` : ""}
                          </div>
                        </div>
                      ) : entry.originalSizeBytes ? (
                        formatBytes(entry.originalSizeBytes)
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="nowrap" style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      <div>{new Date(entry.finishedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>
                      <div style={{ color: "var(--text-dim)" }}>took {formatElapsed(entry.startedAt, entry.finishedAt)}</div>
                    </td>
                    <td className="nowrap" style={{ textAlign: "right" }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "Hide" : "Details"}
                      </button>
                      <button className="btn btn-secondary btn-sm" style={{ marginLeft: "0.4rem" }} onClick={() => setLogEntry(entry)}>
                        Log
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="history-detail-row">
                      <td colSpan={7}>
                        <div className="history-detail">
                          <SnapshotDetails title="Before" snapshot={entry.before} />
                          {entry.kind !== "health" && <SnapshotDetails title="After" snapshot={entry.after} />}
                          <div>
                            <div className="history-detail-title">Job</div>
                            <dl className="history-detail-list">
                              <dt>{entry.kind === "health" ? "Check" : "Preset"}</dt>
                              <dd>{entry.presetId ?? "-"}</dd>
                              {entry.encoder && (
                                <>
                                  <dt>Encoder</dt>
                                  <dd>{entry.encoder === "copy" ? "None (video copied)" : entry.encoder}</dd>
                                </>
                              )}
                              <dt>Started</dt>
                              <dd>{new Date(entry.startedAt).toLocaleString()}</dd>
                              <dt>Took</dt>
                              <dd>{formatElapsed(entry.startedAt, entry.finishedAt)}</dd>
                              {entry.error && (
                                <>
                                  <dt>Error</dt>
                                  <dd style={{ color: "var(--accent-rose)", overflowWrap: "anywhere" }}>{entry.error}</dd>
                                </>
                              )}
                            </dl>
                          </div>
                        </div>
                        {entry.kind !== "health" && entry.before?.videoCodec !== "none" && (
                          <div className="detail-pinned" style={{ marginTop: "1rem" }}>
                            <TracksBeforeAfter before={entry.before} after={entry.after} />
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "0.75rem", marginTop: "1.25rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            Page {page} of {totalPages} ({total} entries)
          </span>
          <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </button>
        </div>
      )}

      {logEntry && (
        <LogModal
          title={`Log: ${logEntry.filePath.split(/[/\\]/).pop()}`}
          subtitle={logEntry.filePath}
          load={() => getHistoryLog(logEntry.id)}
          onClose={() => setLogEntry(null)}
        />
      )}
    </div>
  );
}
