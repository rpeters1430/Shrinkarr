import { useEffect, useState } from "react";
import {
  getJobs,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  postCancelJob,
  postCancelAllJobs,
  clearJobHistory,
  type Job,
} from "../api/client";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function Queue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueStatus, setQueueStatus] = useState<{ paused: boolean; pending: number; running: number; done: number; failed: number } | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
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

  const runningJob = jobs.find((j) => j.status === "running");
  const filteredJobs = jobs.filter((j) => {
    if (filterStatus === "all") return true;
    return j.status === filterStatus;
  });

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Transcode Queue & Activity</h1>
          <p className="page-subtitle">
            Monitor real-time hardware encoding progress, manage active conversions, and view history.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            className={`btn ${queueStatus?.paused ? "btn-emerald" : "btn-secondary"}`}
            onClick={handleTogglePause}
          >
            {queueStatus?.paused ? "▶️ Resume Queue" : "⏸️ Pause Queue"}
          </button>

          <button
            className="btn btn-secondary"
            onClick={handleCancelAll}
            disabled={!queueStatus?.pending}
          >
            Cancel Pending ({queueStatus?.pending ?? 0})
          </button>

          <button className="btn btn-secondary" onClick={handleClearHistory}>
            🧹 Clear History
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Active Running Job Banner */}
      {runningJob && (
        <div
          className="card"
          style={{
            marginBottom: "1.75rem",
            borderLeft: "4px solid var(--accent-cyan)",
            backgroundColor: "rgba(21, 29, 48, 0.9)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
            <div>
              <span className="badge badge-status-running">⚡ ACTIVE TRANSCODE</span>
              <h3 style={{ fontSize: "1.15rem", fontWeight: 700, marginTop: "0.4rem", color: "#fff" }}>
                {runningJob.filePath.split(/[/\\]/).pop()}
              </h3>
              <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
                {runningJob.filePath}
              </div>
            </div>

            <button
              className="btn btn-danger btn-sm"
              disabled={cancellingId === runningJob.id}
              onClick={() => handleCancel(runningJob.id)}
            >
              Cancel Job
            </button>
          </div>

          <div style={{ margin: "1rem 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.88rem", fontWeight: 600, marginBottom: "0.4rem" }}>
              <span>Progress: {runningJob.progressPercent.toFixed(1)}%</span>
              <span style={{ color: "var(--accent-cyan)" }}>
                {runningJob.speed || "1.0x"} • {runningJob.fps ? `${runningJob.fps.toFixed(0)} FPS` : "Processing"}
              </span>
            </div>

            <div className="progress-bar-container" style={{ height: "10px" }}>
              <div className="progress-bar-fill" style={{ width: `${runningJob.progressPercent}%` }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: "2rem", fontSize: "0.82rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
            <div>
              Preset: <strong style={{ color: "var(--text-main)" }}>{runningJob.presetId}</strong>
            </div>
            {runningJob.encoderUsed && (
              <div>
                Encoder: <strong style={{ color: "var(--accent-cyan)" }}>{runningJob.encoderUsed}</strong>
              </div>
            )}
            {runningJob.originalSizeBytes && (
              <div>
                Source Size: <strong style={{ color: "var(--text-main)" }}>{formatBytes(runningJob.originalSizeBytes)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs-container">
        <button
          className={`tab-btn ${filterStatus === "all" ? "active" : ""}`}
          onClick={() => setFilterStatus("all")}
        >
          All Jobs ({jobs.length})
        </button>
        <button
          className={`tab-btn ${filterStatus === "running" ? "active" : ""}`}
          onClick={() => setFilterStatus("running")}
        >
          Running ({queueStatus?.running ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "pending" ? "active" : ""}`}
          onClick={() => setFilterStatus("pending")}
        >
          Pending ({queueStatus?.pending ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "done" ? "active" : ""}`}
          onClick={() => setFilterStatus("done")}
        >
          Completed ({queueStatus?.done ?? 0})
        </button>
        <button
          className={`tab-btn ${filterStatus === "failed" ? "active" : ""}`}
          onClick={() => setFilterStatus("failed")}
        >
          Failed ({queueStatus?.failed ?? 0})
        </button>
      </div>

      {/* Jobs Table */}
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>File Name</th>
              <th>Preset</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Original Size</th>
              <th>New Size / Savings</th>
              <th>Created</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: "2.5rem", color: "var(--text-dim)" }}>
                  No transcode jobs in this view.
                </td>
              </tr>
            )}

            {filteredJobs.map((job) => {
              const fileName = job.filePath.split(/[/\\]/).pop() || job.filePath;
              const savedBytes =
                job.status === "done" && job.originalSizeBytes && job.newSizeBytes
                  ? job.originalSizeBytes - job.newSizeBytes
                  : 0;

              return (
                <tr key={job.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: "#fff" }}>{fileName}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
                      {job.filePath}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-res">{job.presetId}</span>
                  </td>
                  <td>
                    {job.status === "running" && <span className="badge badge-status-running">Running ({job.progressPercent.toFixed(0)}%)</span>}
                    {job.status === "pending" && <span className="badge badge-status-eligible">Pending</span>}
                    {job.status === "done" && <span className="badge badge-status-done">✓ Done</span>}
                    {job.status === "failed" && <span className="badge badge-status-failed">✕ Failed</span>}
                    {job.status === "cancelled" && <span className="badge badge-status-keep">Cancelled</span>}
                  </td>
                  <td style={{ minWidth: "140px" }}>
                    {job.status === "running" ? (
                      <div>
                        <div className="progress-bar-container">
                          <div className="progress-bar-fill" style={{ width: `${job.progressPercent}%` }} />
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--accent-cyan)", marginTop: "0.2rem" }}>
                          {job.speed} • {job.fps ? `${job.fps.toFixed(0)} fps` : ""}
                        </div>
                      </div>
                    ) : job.status === "done" ? (
                      <span style={{ color: "var(--accent-emerald)", fontSize: "0.85rem", fontWeight: 600 }}>100%</span>
                    ) : (
                      <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>—</span>
                    )}
                  </td>
                  <td>{job.originalSizeBytes ? formatBytes(job.originalSizeBytes) : "—"}</td>
                  <td>
                    {job.status === "done" && job.newSizeBytes ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>{formatBytes(job.newSizeBytes)}</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--accent-emerald)", fontWeight: 700 }}>
                          -{formatBytes(savedBytes)} (
                          {job.originalSizeBytes ? Math.round((savedBytes / job.originalSizeBytes) * 100) : 0}%)
                        </div>
                      </div>
                    ) : job.error ? (
                      <span style={{ color: "var(--accent-rose)", fontSize: "0.8rem" }} title={job.error}>
                        {job.error.slice(0, 45)}...
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
                    {new Date(job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{ textAlign: "right" }}>
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
    </div>
  );
}
