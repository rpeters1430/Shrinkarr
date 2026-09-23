import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getJobs,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  postCancelJob,
  postCancelAllJobs,
  clearJobHistory,
  type Job,
  type QueueStatus,
} from "../api/client";
import {
  IconPlay,
  IconPause,
  IconTrash,
  IconClose,
  IconCheck,
  IconBolt,
  IconQueue,
  IconFilm,
} from "../components/Icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function Queue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  function loadQueue() {
    getJobs().then(setJobs).catch((err) => setError(String(err)));
    getQueueStatus().then(setQueueStatus).catch(() => {});
  }

  useEffect(() => {
    loadQueue();
    const interval = setInterval(loadQueue, 1500);
    return () => clearInterval(interval);
  }, []);

  async function handleTogglePause() {
    setError(null);
    try {
      if (queueStatus?.paused) {
        await resumeQueue();
        setSuccessMsg("Queue processing resumed.");
      } else {
        await pauseQueue();
        setSuccessMsg("Queue processing paused.");
      }
      loadQueue();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCancel(id: string) {
    setCancellingId(id);
    setError(null);
    try {
      await postCancelJob(id);
      loadQueue();
    } catch (err) {
      setError(String(err));
    } finally {
      setCancellingId(null);
    }
  }

  async function handleCancelAll() {
    if (!window.confirm("Cancel all pending jobs in the queue?")) return;
    setError(null);
    try {
      const res = await postCancelAllJobs();
      setSuccessMsg(`Cancelled ${res.cancelledCount} pending job(s).`);
      loadQueue();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleClearHistory() {
    setError(null);
    try {
      const res = await clearJobHistory();
      setSuccessMsg(`Cleared ${res.clearedCount} completed/failed job(s).`);
      loadQueue();
    } catch (err) {
      setError(String(err));
    }
  }

  const runningJobs = jobs.filter((j) => j.status === "running");
  const filteredJobs = jobs.filter((j) => {
    if (filterStatus === "all") return true;
    return j.status === filterStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedJobs = filteredJobs.slice(startIndex, startIndex + pageSize);

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Transcode Queue & Activity</h1>
          <p className="page-subtitle">
            Monitor real-time hardware encoding progress, manage active conversions, and view transcode history.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button
            className={`btn ${queueStatus?.paused ? "btn-emerald" : "btn-secondary"}`}
            onClick={handleTogglePause}
          >
            {queueStatus?.paused ? (
              <>
                <IconPlay size={14} />
                <span>Resume Queue</span>
              </>
            ) : (
              <>
                <IconPause size={14} />
                <span>Pause Queue</span>
              </>
            )}
          </button>

          <button
            className="btn btn-secondary"
            onClick={handleCancelAll}
            disabled={!queueStatus?.pending}
          >
            Cancel Pending ({queueStatus?.pending ?? 0})
          </button>

          <button className="btn btn-secondary" onClick={handleClearHistory}>
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

      {/* Weekly Schedule Banner */}
      {queueStatus?.schedule?.enabled && !queueStatus?.schedule?.isWithinSchedule && !queueStatus?.paused && (
        <div className="alert alert-info">
          <div>
            <strong style={{ color: "#fff" }}>Weekly Schedule Waiting: </strong>
            The queue is holding pending items until the next configured active window. You can adjust each day's processing hours in Settings.
            <span style={{ marginLeft: "0.5rem", color: "var(--text-dim)", fontSize: "0.82rem", fontVariantNumeric: "tabular-nums" }}>
              (Current server time: {queueStatus.schedule.serverTime})
            </span>
          </div>
        </div>
      )}

      {/* Active Media Stream Banner */}
      {queueStatus?.streamingPaused && !queueStatus?.paused && (
        <div className="alert alert-warning">
          <div>
            <strong style={{ color: "#fff" }}>Playback In Progress: </strong>
            An active stream was detected on a configured media server (Jellyfin/Plex/Emby), so the queue is
            holding new transcodes to prioritize playback.
          </div>
        </div>
      )}

      {/* Active Running Jobs Banner (Supports all concurrent runners) */}
      {runningJobs.length > 0 && (
        <div style={{ marginBottom: "1.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <IconBolt size={18} color="var(--accent-primary)" />
              <span>Active Transcodes</span>
              <span className="badge badge-status-running">
                {runningJobs.length} {runningJobs.length === 1 ? "Runner Active" : "Runners Active"}
              </span>
            </h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {runningJobs.map((runningJob, idx) => (
              <div
                key={runningJob.id}
                className="card"
                style={{
                  border: "1px solid var(--border-light)",
                  backgroundColor: "var(--bg-card)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem", gap: "1rem" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span className="badge badge-status-running">
                      Runner #{idx + 1} {runningJobs.length > 1 ? `of ${runningJobs.length}` : ""}
                    </span>
                    <h3 className="video-title" style={{ fontSize: "1.1rem", fontWeight: 700, marginTop: "0.4rem" }} title={runningJob.filePath.split(/[/\\]/).pop()}>
                      {runningJob.filePath.split(/[/\\]/).pop()}
                    </h3>
                    <div className="video-path" title={runningJob.filePath}>
                      {runningJob.filePath}
                    </div>
                  </div>

                  <button
                    className="btn btn-danger btn-sm"
                    style={{ flexShrink: 0 }}
                    disabled={cancellingId === runningJob.id}
                    onClick={() => handleCancel(runningJob.id)}
                  >
                    Cancel Job
                  </button>
                </div>

                <div style={{ margin: "1rem 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.88rem", fontWeight: 600, marginBottom: "0.4rem", fontVariantNumeric: "tabular-nums" }}>
                    <span>Progress: {runningJob.progressPercent.toFixed(1)}%</span>
                    <span style={{ color: "var(--accent-primary)" }}>
                      {runningJob.speed || "1.0x"} • {runningJob.fps ? `${runningJob.fps.toFixed(0)} FPS` : "Processing"}
                    </span>
                  </div>

                  <div className="progress-bar-container" style={{ height: "8px" }}>
                    <div className="progress-bar-fill" style={{ width: `${runningJob.progressPercent}%` }} />
                  </div>
                </div>

                <div style={{ display: "flex", gap: "2rem", fontSize: "0.82rem", color: "var(--text-muted)", flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
                  <div>
                    Preset: <strong style={{ color: "var(--text-main)" }}>{runningJob.presetId}</strong>
                  </div>
                  {runningJob.encoderUsed && (
                    <div>
                      Encoder: <strong style={{ color: "var(--accent-primary)" }}>{runningJob.encoderUsed}</strong>
                    </div>
                  )}
                  {runningJob.originalSizeBytes && (
                    <div>
                      Source Size: <strong style={{ color: "var(--text-main)" }}>{formatBytes(runningJob.originalSizeBytes)}</strong>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs-container">
        <button
          className={`tab-btn ${filterStatus === "all" ? "active" : ""}`}
          onClick={() => { setFilterStatus("all"); setPage(1); }}
        >
          All Jobs ({jobs.length})
        </button>
        <button
          className={`tab-btn ${filterStatus === "running" ? "active" : ""}`}
          onClick={() => { setFilterStatus("running"); setPage(1); }}
        >
          Running ({queueStatus?.running ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "pending" ? "active" : ""}`}
          onClick={() => { setFilterStatus("pending"); setPage(1); }}
        >
          Pending ({queueStatus?.pending ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "done" ? "active" : ""}`}
          onClick={() => { setFilterStatus("done"); setPage(1); }}
        >
          Completed ({queueStatus?.done ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "failed" ? "active" : ""}`}
          onClick={() => { setFilterStatus("failed"); setPage(1); }}
        >
          Failed ({queueStatus?.failed ?? 0})
        </button>
      </div>

      {/* Jobs Table & Contextual Empty State (R-27) */}
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: "32%", minWidth: "180px", maxWidth: "360px" }}>File Name</th>
              <th className="nowrap">Preset</th>
              <th className="nowrap">Status</th>
              <th style={{ minWidth: "140px" }} className="nowrap">Progress</th>
              <th className="nowrap">Original Size</th>
              <th className="nowrap">New Size / Savings</th>
              <th className="nowrap">Created</th>
              <th style={{ textAlign: "right" }} className="nowrap">Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 0 }}>
                  <div className="empty-state">
                    <div className="empty-state-icon">
                      <IconQueue size={32} />
                    </div>
                    <h3 className="empty-state-title">
                      {filterStatus === "all"
                        ? "Queue is Currently Empty"
                        : `No ${filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1)} Jobs`}
                    </h3>
                    <p className="empty-state-desc">
                      {filterStatus === "all"
                        ? "No media conversions are currently queued. Check your Library to view candidate files for optimization."
                        : `There are currently no transcode jobs in the ${filterStatus} state.`}
                    </p>
                    {filterStatus === "all" && (
                      <Link to="/library" className="btn btn-primary btn-sm">
                        <IconFilm size={14} />
                        <span>Go to Library</span>
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            )}

            {paginatedJobs.map((job) => {
              const fileName = job.filePath.split(/[/\\]/).pop() || job.filePath;
              const hasOriginalSize = !!job.originalSizeBytes;
              const savedBytes =
                job.status === "done" && hasOriginalSize && job.newSizeBytes != null
                  ? job.originalSizeBytes! - job.newSizeBytes
                  : 0;

              return (
                <tr key={job.id}>
                  <td className="cell-video-info">
                    <div className="video-title" title={fileName}>{fileName}</div>
                    <div className="video-path" title={job.filePath}>
                      {job.filePath}
                    </div>
                  </td>
                  <td className="nowrap">
                    <span className="badge badge-res">{job.presetId}</span>
                  </td>
                  <td className="nowrap">
                    {job.status === "running" && <span className="badge badge-status-running">Running ({job.progressPercent.toFixed(0)}%)</span>}
                    {job.status === "pending" && <span className="badge badge-status-eligible">Pending</span>}
                    {job.status === "done" && <span className="badge badge-status-done"><IconCheck size={12} /> Done</span>}
                    {job.status === "failed" && <span className="badge badge-status-failed"><IconClose size={12} /> Failed</span>}
                    {job.status === "cancelled" && <span className="badge" style={{ backgroundColor: "rgba(255,255,255,0.06)", color: "var(--text-muted)" }}>Cancelled</span>}
                  </td>
                  <td className="nowrap">
                    {job.status === "running" ? (
                      <div>
                        <div style={{ fontSize: "0.8rem", marginBottom: "0.2rem" }}>
                          {job.progressPercent.toFixed(1)}% {job.speed ? `(${job.speed})` : ""}
                        </div>
                        <div className="progress-bar-container" style={{ height: "6px", width: "100px" }}>
                          <div className="progress-bar-fill" style={{ width: `${job.progressPercent}%` }} />
                        </div>
                      </div>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="nowrap">
                    {job.originalSizeBytes ? formatBytes(job.originalSizeBytes) : "-"}
                  </td>
                  <td className="nowrap">
                    {job.status === "done" && job.newSizeBytes != null ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>{formatBytes(job.newSizeBytes)}</div>
                        {hasOriginalSize ? (
                          <div
                            style={{
                              fontSize: "0.78rem",
                              color: savedBytes >= 0 ? "var(--accent-emerald)" : "var(--accent-rose)",
                              fontWeight: 700,
                            }}
                          >
                            {savedBytes >= 0 ? "-" : "+"}
                            {formatBytes(Math.abs(savedBytes))} (
                            {Math.round((savedBytes / job.originalSizeBytes!) * 100)}%)
                          </div>
                        ) : (
                          <div style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
                            Original size unknown
                          </div>
                        )}
                      </div>
                    ) : job.error ? (
                      <span style={{ color: "var(--accent-rose)", fontSize: "0.8rem" }} title={job.error}>
                        {job.error.slice(0, 45)}...
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="nowrap" style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
                    {new Date(job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="nowrap" style={{ textAlign: "right" }}>
                    {(job.status === "pending" || job.status === "running") && (
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={cancellingId === job.id}
                        onClick={() => handleCancel(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredJobs.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "1.25rem",
            padding: "0.5rem 0",
            flexWrap: "wrap",
            gap: "0.75rem",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
          }}
        >
          <div>
            Showing <strong style={{ color: "#fff" }}>{startIndex + 1}</strong>-
            <strong style={{ color: "#fff" }}>{Math.min(startIndex + pageSize, filteredJobs.length)}</strong> of{" "}
            <strong style={{ color: "#fff" }}>{filteredJobs.length}</strong> jobs
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span>Per page:</span>
              <select
                className="form-select"
                style={{ width: "auto", padding: "0.2rem 0.5rem", fontSize: "0.85rem" }}
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <button
              className="btn btn-secondary btn-sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
