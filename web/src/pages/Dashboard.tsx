import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getStats,
  getHardware,
  getPresets,
  getScanStatus,
  getWatcherStatus,
  scanNewItems,
  postScan,
  postOptimizeLibrary,
  optimizeAll,
  type Stats,
  type HardwareReport,
  type Preset,
  type LibrarySummary,
  type ScanProgress,
  type WatcherStatus,
} from "../api/client";
import { AddLibraryModal } from "../components/AddLibraryModal";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<WatcherStatus | null>(null);
  const [optimizing, setOptimizing] = useState<string | null>(null);
  const [scanningNew, setScanningNew] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  function loadData() {
    getStats().then(setStats).catch((err) => setError(String(err)));
    getHardware().then(setHardware).catch(() => {});
    getPresets().then(setPresets).catch(() => {});
    getScanStatus().then(setScanProgress).catch(() => {});
    getWatcherStatus().then(setWatcherStatus).catch(() => {});
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      loadData();
    }, scanProgress?.isScanning ? 1000 : 3500);
    return () => clearInterval(interval);
  }, [scanProgress?.isScanning]);

  async function handleScan(libraryId?: string) {
    setError(null);
    setSuccessMsg(null);
    try {
      if (libraryId) {
        await postScan(libraryId);
      } else if (stats?.librarySummaries) {
        for (const lib of stats.librarySummaries) {
          await postScan(lib.id);
        }
      }
      getScanStatus().then(setScanProgress);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleScanNew() {
    setError(null);
    setSuccessMsg(null);
    setScanningNew(true);
    try {
      const res = await scanNewItems();
      setSuccessMsg(
        `Discovered ${res.newFiles} new media file(s)${res.autoQueued > 0 ? ` and automatically queued ${res.autoQueued} for optimization!` : "."}`,
      );
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setScanningNew(false);
    }
  }

  async function handleOptimizeLibrary(lib: LibrarySummary) {
    setError(null);
    setSuccessMsg(null);
    setOptimizing(lib.id);
    try {
      const res = await postOptimizeLibrary(lib.id);
      setSuccessMsg(`Queued ${res.queued} recommended file(s) for "${lib.name}".`);
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setOptimizing(null);
    }
  }

  async function handleOptimizeAll() {
    setError(null);
    setSuccessMsg(null);
    setOptimizing("all");
    try {
      const res = await optimizeAll();
      setSuccessMsg(`Queued ${res.queued} recommended file(s) across all libraries!`);
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setOptimizing(null);
    }
  }

  const activeJobsCount = stats
    ? (stats.jobsByStatus.pending ?? 0) + (stats.jobsByStatus.running ?? 0)
    : 0;

  const totalCodecFiles = stats
    ? Object.values(stats.codecBreakdown || {}).reduce((acc, curr) => acc + curr.count, 0)
    : 0;

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Media Storage Analyzer</h1>
          <p className="page-subtitle">
            Inspect media libraries, monitor for new video additions, and optimize automatically.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="btn btn-secondary"
            onClick={handleScanNew}
            disabled={scanningNew || scanProgress?.isScanning}
            title="Perform a fast check for newly added or modified videos"
          >
            {scanningNew ? "🔍 Checking for New..." : "✨ Scan for New Videos"}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleScan()}
            disabled={scanProgress?.isScanning || !stats?.librarySummaries?.length}
          >
            {scanProgress?.isScanning ? "🔍 Full Scan in Progress..." : "🔍 Full Scan"}
          </button>

          <button
            className="btn btn-emerald"
            onClick={handleOptimizeAll}
            disabled={optimizing !== null || !stats?.recommendedCount}
          >
            {optimizing === "all" ? "⚡ Queueing..." : `⚡ Optimize All Recommended (${stats?.recommendedCount ?? 0})`}
          </button>

          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            ➕ Add Library
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Live Scan Progress Banner */}
      {scanProgress?.isScanning && (
        <div className="card" style={{ marginBottom: "1.5rem", border: "1px solid var(--accent-cyan)", backgroundColor: "rgba(6, 182, 212, 0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
              <strong style={{ color: "#fff", fontSize: "1.05rem" }}>
                Scanning Library: {scanProgress.libraryName || "Media Library"}
              </strong>
            </div>
            <span style={{ fontWeight: 700, color: "var(--accent-cyan)", fontSize: "1.1rem" }}>
              {scanProgress.percent}% ({scanProgress.current} / {scanProgress.total} files)
            </span>
          </div>

          <div style={{ width: "100%", height: 8, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden", marginBottom: "0.75rem" }}>
            <div
              style={{
                width: `${scanProgress.percent}%`,
                height: "100%",
                backgroundColor: "var(--accent-cyan)",
                transition: "width 0.3s ease",
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.82rem" }}>
            <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>
              Probing: <span style={{ color: "#fff", fontFamily: "monospace" }}>{scanProgress.currentFile || "Reading directory..."}</span>
            </div>
            <div style={{ color: "var(--accent-emerald)", fontWeight: 600 }}>
              ⭐ Found {scanProgress.recommendedCount} eligible for optimization
            </div>
          </div>
        </div>
      )}

      {/* Automated Watcher Status Bar */}
      {watcherStatus?.enabled && (
        <div
          className="card"
          style={{
            marginBottom: "1.5rem",
            padding: "0.85rem 1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.75rem",
            border: "1px solid rgba(99, 102, 241, 0.3)",
            backgroundColor: "rgba(99, 102, 241, 0.05)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{ fontSize: "1.2rem" }}>🤖</span>
            <div>
              <div style={{ fontWeight: 600, color: "#fff", fontSize: "0.92rem" }}>
                Background Library Watcher: <span style={{ color: "var(--accent-cyan)" }}>Active</span> (Sweeping every {watcherStatus.intervalMinutes}m)
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                Auto-Optimize:{" "}
                <strong style={{ color: watcherStatus.autoOptimize ? "var(--accent-emerald)" : "var(--text-dim)" }}>
                  {watcherStatus.autoOptimize ? "Enabled (Auto-Queues eligible new videos)" : "Disabled (Index only)"}
                </strong>
                {watcherStatus.totalNewFilesDiscovered > 0 && ` • Discovered ${watcherStatus.totalNewFilesDiscovered} new items`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-secondary btn-sm" onClick={handleScanNew} disabled={scanningNew}>
              Check Now
            </button>
            <Link to="/settings" className="btn btn-secondary btn-sm">
              Configure Watcher →
            </Link>
          </div>
        </div>
      )}

      {/* Hardware Acceleration Banner */}
      {hardware && (
        <div className="hw-banner">
          <div className="hw-info">
            <span style={{ fontSize: "1.25rem" }}>⚡</span>
            <div>
              <div style={{ fontWeight: 700, color: "#fff" }}>
                {hardware.gpus.length > 0 ? hardware.gpus.map((g) => g.name).join(" • ") : "Software Encoding Engine"}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                Active Encoders: {hardware.encoders.map((e) => e.name).join(", ")}
              </div>
            </div>
          </div>
          <Link to="/presets" className="btn btn-secondary btn-sm">
            Configure Encoders & Presets →
          </Link>
        </div>
      )}

      {/* Primary Storage Metrics */}
      <div className="grid-4">
        <div className="card stat-card">
          <span className="stat-label">Total Library Storage</span>
          <span className="stat-value">{stats ? formatBytes(stats.totalLibrarySizeBytes) : "..."}</span>
          <span className="stat-subtext">{stats?.filesScanned ?? 0} media files indexed</span>
        </div>

        <div className="card stat-card">
          <span className="stat-label">Potential Space Savings</span>
          <span className="stat-value savings">
            {stats ? formatBytes(stats.totalPotentialSavingsBytes) : "..."}
          </span>
          <span className="stat-subtext">
            {stats?.recommendedCount ?? 0} files eligible for compression
          </span>
        </div>

        <div className="card stat-card">
          <span className="stat-label">Total Space Reclaimed</span>
          <span className="stat-value" style={{ color: "var(--accent-cyan)" }}>
            {stats ? formatBytes(stats.spaceSavedBytes) : "..."}
          </span>
          <span className="stat-subtext">{stats?.transcodedCount ?? 0} files optimized</span>
        </div>

        <div className="card stat-card">
          <span className="stat-label">Transcode Queue</span>
          <span className="stat-value active">
            {activeJobsCount}
          </span>
          <span className="stat-subtext">
            {stats?.jobsByStatus.running ?? 0} active, {stats?.jobsByStatus.pending ?? 0} pending
          </span>
        </div>
      </div>

      {/* Codec Distribution Bar */}
      {stats && totalCodecFiles > 0 && (
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Library Codec Breakdown</span>
            <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{totalCodecFiles} files</span>
          </div>

          <div className="dist-bar">
            {Object.entries(stats.codecBreakdown).map(([codec, data]) => {
              const pct = (data.count / totalCodecFiles) * 100;
              let bg = "var(--text-dim)";
              if (codec.includes("H264") || codec.includes("AVC")) bg = "var(--accent-amber)";
              else if (codec.includes("HEVC") || codec.includes("H265")) bg = "var(--accent-emerald)";
              else if (codec.includes("AV1")) bg = "var(--accent-purple)";
              else if (codec.includes("MPEG2") || codec.includes("VC1")) bg = "var(--accent-rose)";

              return (
                <div
                  key={codec}
                  className="dist-seg"
                  style={{ width: `${pct}%`, backgroundColor: bg }}
                  title={`${codec}: ${data.count} files (${pct.toFixed(1)}%) - ${formatBytes(data.sizeBytes)}`}
                />
              );
            })}
          </div>

          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.82rem" }}>
            {Object.entries(stats.codecBreakdown).map(([codec, data]) => {
              const pct = ((data.count / totalCodecFiles) * 100).toFixed(1);
              let color = "var(--text-main)";
              if (codec.includes("H264") || codec.includes("AVC")) color = "var(--accent-amber)";
              else if (codec.includes("HEVC") || codec.includes("H265")) color = "var(--accent-emerald)";
              else if (codec.includes("AV1")) color = "var(--accent-purple)";
              else if (codec.includes("MPEG2") || codec.includes("VC1")) color = "var(--accent-rose)";

              return (
                <div key={codec} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color, display: "inline-block" }} />
                  <span style={{ fontWeight: 600 }}>{codec}</span>
                  <span style={{ color: "var(--text-muted)" }}>{data.count} ({pct}%) • {formatBytes(data.sizeBytes)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Libraries Section */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <h2 style={{ fontSize: "1.35rem", fontWeight: 700 }}>Configured Libraries</h2>
      </div>

      {(!stats?.librarySummaries || stats.librarySummaries.length === 0) && (
        <div className="card" style={{ textAlign: "center", padding: "3rem 1.5rem" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>📂</div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>No Libraries Added Yet</h3>
          <p style={{ color: "var(--text-muted)", maxWidth: "450px", margin: "0 auto 1.5rem" }}>
            Point Shrinkarr at your movie, TV show, or YouTube folders to begin scanning for space savings.
          </p>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            ➕ Add Your First Library
          </button>
        </div>
      )}

      <div className="grid-2">
        {stats?.librarySummaries?.map((lib) => {
          const presetObj = presets.find((p) => p.id === lib.presetId);
          const isThisLibScanning = scanProgress?.isScanning && scanProgress.libraryId === lib.id;

          let categoryBadge = "📁 Other";
          if (lib.mediaType === "movie") categoryBadge = "🎬 Movies";
          else if (lib.mediaType === "tv") categoryBadge = "📺 TV Shows";
          else if (lib.mediaType === "youtube" || lib.mediaType === "web") categoryBadge = "📹 YouTube / Web";

          return (
            <div key={lib.id} className="card library-card">
              <div>
                <div className="library-card-header">
                  <div>
                    <span className="library-title">{lib.name}</span>
                    <div className="library-path">{lib.path}</div>
                  </div>
                  <span className="badge badge-res">
                    {categoryBadge}
                  </span>
                </div>

                <div className="library-stats-row">
                  <div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Files</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{lib.fileCount}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Current Size</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{formatBytes(lib.totalSizeBytes)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Potential Savings</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--accent-emerald)" }}>
                      {formatBytes(lib.potentialSavingsBytes)}
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
                  Active Preset: <strong style={{ color: "var(--text-main)" }}>{presetObj?.name ?? lib.presetId}</strong> ({presetObj?.targetCodec.toUpperCase() ?? "HEVC"})
                </div>
              </div>

              <div className="library-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleScan(lib.id)}
                  disabled={Boolean(scanProgress?.isScanning)}
                >
                  {isThisLibScanning ? `Scanning (${scanProgress?.percent}%)...` : "🔍 Scan Library"}
                </button>

                <button
                  className="btn btn-emerald btn-sm"
                  onClick={() => handleOptimizeLibrary(lib)}
                  disabled={optimizing === lib.id || lib.eligibleCount === 0 || Boolean(scanProgress?.isScanning)}
                >
                  {optimizing === lib.id ? "Queueing..." : `⚡ Optimize (${lib.eligibleCount})`}
                </button>

                <Link to={`/library?id=${lib.id}`} className="btn btn-secondary btn-sm" style={{ marginLeft: "auto" }}>
                  View Files →
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {showAddModal && (
        <AddLibraryModal
          presets={presets}
          onAdded={() => {
            loadData();
            setSuccessMsg("Library added successfully!");
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
