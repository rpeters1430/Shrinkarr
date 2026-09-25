import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import {
  getStats,
  getHardware,
  getPresets,
  getScanStatus,
  getWatcherStatus,
  scanNewItems,
  deleteLibrary,
  postScan,
  postScanAll,
  postOptimizeLibrary,
  optimizeAll,
  type Stats,
  type HardwareReport,
  type Preset,
  type Library,
  type LibrarySummary,
  type ScanProgress,
  type WatcherStatus,
} from "../api/client";
import { AddLibraryModal } from "../components/AddLibraryModal";
import { EditLibraryModal } from "../components/EditLibraryModal";
import {
  IconPlus,
  IconRefresh,
  IconSearch,
  IconBolt,
  IconCheck,
  IconClose,
  IconFolder,
  IconEdit,
  IconTrash,
  IconHardDrive,
  IconCpu,
  IconFilm,
  IconActivity,
  IconQueue,
} from "../components/Icons";

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
  const [editingLibrary, setEditingLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);

  const prevScanningRef = useRef<boolean>(false);

  async function handleDeleteLibrary(lib: LibrarySummary) {
    if (!window.confirm(`Are you sure you want to delete the library "${lib.name}" (${lib.path})? This removes the library from Shrinkarr but does NOT delete files from disk.`)) {
      return;
    }
    setError(null);
    setSuccessMsg(null);
    try {
      await deleteLibrary(lib.id);
      setSuccessMsg(`Library "${lib.name}" deleted.`);
      loadData();
    } catch (err) {
      setError(String(err));
    }
  }

  function loadData() {
    getStats().then(setStats).catch((err) => setError(String(err)));
    getHardware().then(setHardware).catch(() => {});
    getPresets().then(setPresets).catch(() => {});
    getScanStatus().then((sp) => {
      setScanProgress(sp);
      if (prevScanningRef.current && !sp.isScanning && sp.lastSummary) {
        setScanNotice(sp.lastSummary);
        getStats().then(setStats);
      }
      prevScanningRef.current = sp.isScanning;
    }).catch(() => {});
    getWatcherStatus().then(setWatcherStatus).catch(() => {});
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      loadData();
    }, scanProgress?.isScanning ? 750 : 3000);
    return () => clearInterval(interval);
  }, [scanProgress?.isScanning]);

  async function handleScan(libraryId?: string) {
    setError(null);
    setSuccessMsg(null);
    setScanNotice(null);
    try {
      if (libraryId) {
        await postScan(libraryId);
      } else {
        await postScanAll();
      }
      const sp = await getScanStatus();
      setScanProgress(sp);
      prevScanningRef.current = true;
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleScanNew() {
    setError(null);
    setSuccessMsg(null);
    setScanningNew(true);
    setScanNotice(null);
    try {
      const res = await scanNewItems();
      setSuccessMsg(
        res.busy
          ? "A scan is already running. New files will be picked up when it finishes."
          : `Discovered ${res.newFiles} new media file(s)${res.autoQueued > 0 ? ` and automatically queued ${res.autoQueued} for optimization.` : "."}`,
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
      setSuccessMsg(`Queued ${res.queued} recommended file(s) across all libraries.`);
      loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setOptimizing(null);
    }
  }

  const activeJobsCount = (stats?.jobsByStatus.running ?? 0) + (stats?.jobsByStatus.pending ?? 0);
  const totalCodecFiles = stats
    ? Object.values(stats.codecBreakdown).reduce((acc, curr) => acc + curr.count, 0)
    : 0;

  const isScanningActive = Boolean(scanProgress?.isScanning);
  const isMultiLibScan = Boolean(scanProgress?.totalLibraries && scanProgress.totalLibraries > 1);
  const scanPercent = scanProgress?.percent ?? 0;

  return (
    <div className="main-content">
      {/* Top Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Library Overview</h1>
          <p className="page-subtitle">
            Media library compression metrics, live hardware transcode telemetry, and library management.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button
            className="btn btn-secondary"
            onClick={handleScanNew}
            disabled={scanningNew || isScanningActive}
            title="Perform a fast check for newly added or modified videos"
          >
            <IconRefresh size={14} />
            <span>{scanningNew ? "Checking for New..." : "Scan New Files"}</span>
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleScan()}
            disabled={isScanningActive || !stats?.librarySummaries?.length}
          >
            <IconSearch size={14} />
            <span>{isScanningActive ? "Scanning..." : "Full Scan"}</span>
          </button>

          <button
            className="btn btn-emerald"
            onClick={handleOptimizeAll}
            disabled={optimizing !== null || !stats?.recommendedCount}
          >
            <IconBolt size={14} />
            <span>{optimizing === "all" ? "Queueing..." : `Optimize Recommended (${stats?.recommendedCount ?? 0})`}</span>
          </button>

          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <IconPlus size={14} />
            <span>Add Library</span>
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

      {/* Completed Scan Summary Banner */}
      {scanNotice && !isScanningActive && (
        <div
          className="card"
          style={{
            marginBottom: "1.5rem",
            padding: "0.85rem 1.25rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            border: "1px solid rgba(16, 185, 129, 0.35)",
            backgroundColor: "rgba(16, 185, 129, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ color: "var(--accent-emerald)" }}>
              <IconCheck size={18} />
            </span>
            <div>
              <strong style={{ color: "#fff", fontSize: "0.95rem" }}>Library Scan Completed</strong>
              <div style={{ color: "var(--text-main)", fontSize: "0.85rem", marginTop: "0.15rem" }}>
                {scanNotice}
              </div>
            </div>
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setScanNotice(null)}
            title="Dismiss notification"
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      {/* Live Scan Progress Banner */}
      {isScanningActive && (
        <div className="card" style={{ marginBottom: "1.5rem", border: "1px solid var(--accent-primary)", backgroundColor: "rgba(59, 130, 246, 0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
              <strong style={{ color: "#fff", fontSize: "1.05rem" }}>
                {isMultiLibScan
                  ? `Scanning Library [${scanProgress?.activeLibraryIndex || 1} of ${scanProgress?.totalLibraries}]: ${scanProgress?.libraryName || "Media Library"}`
                  : `Scanning Library: ${scanProgress?.libraryName || "Media Library"}`}
              </strong>
            </div>
            <span style={{ fontWeight: 700, color: "var(--accent-primary)", fontSize: "1.05rem", fontVariantNumeric: "tabular-nums" }}>
              {scanProgress?.phase === "discovering"
                ? (scanProgress?.current ?? 0) > 0
                  ? `${(scanProgress?.current ?? 0)} files found`
                  : "Listing files..."
                : `${scanPercent}% (${scanProgress?.current ?? 0} / ${scanProgress?.total ?? 0} files)`}
            </span>
          </div>

          <div style={{ width: "100%", height: 6, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden", marginBottom: "0.75rem" }}>
            <div
              style={{
                width: scanProgress?.phase === "discovering" ? "100%" : `${scanPercent}%`,
                height: "100%",
                backgroundColor: "var(--accent-primary)",
                transition: "width 0.3s ease",
                opacity: scanProgress?.phase === "discovering" ? 0.6 : 1,
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.82rem", flexWrap: "wrap", gap: "0.5rem" }}>
            <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>
              {scanProgress?.phase === "discovering" ? (
                <span>Crawling directories and looking for media files...</span>
              ) : (
                <>
                  Probing: <span style={{ color: "#fff", fontFamily: "ui-monospace, monospace" }}>{scanProgress?.currentFile || "Reading video streams..."}</span>
                </>
              )}
            </div>
            <div style={{ color: "var(--accent-emerald)", fontWeight: 600 }}>
              Found {scanProgress?.recommendedCount ?? 0} eligible for optimization
              {scanProgress?.totalSavingsBytes ? ` (~${formatBytes(scanProgress.totalSavingsBytes)})` : ""}
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
            border: "1px solid var(--border)",
            backgroundColor: "var(--bg-surface)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{ color: "var(--accent-primary)" }}>
              <IconActivity size={18} />
            </span>
            <div>
              <div style={{ fontWeight: 600, color: "#fff", fontSize: "0.92rem" }}>
                Background Library Watcher: <span style={{ color: "var(--accent-emerald)" }}>Active</span> (Sweeping every {watcherStatus.intervalMinutes}m)
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
              Configure Watcher
            </Link>
          </div>
        </div>
      )}

      {/* Hardware Acceleration Banner */}
      {hardware && (
        <div className="hw-banner">
          <div className="hw-info">
            <span style={{ color: "var(--accent-primary)" }}>
              <IconCpu size={20} />
            </span>
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
            Configure Hardware
          </Link>
        </div>
      )}

      {/* Primary Storage Metrics (R-14: Hierarchical prominence for Space Reclaimed & Potential Savings) */}
      <div className="grid-4">
        <div className="card stat-card hero-stat">
          <span className="stat-label">
            <IconBolt size={14} color="var(--accent-emerald)" /> Total Space Reclaimed
          </span>
          <span className="stat-value savings">
            {stats ? formatBytes(stats.spaceSavedBytes) : "..."}
          </span>
          <span className="stat-subtext">{stats?.transcodedCount ?? 0} files optimized</span>
        </div>

        <div className="card stat-card hero-stat">
          <span className="stat-label">
            <IconHardDrive size={14} color="var(--accent-emerald)" /> Potential Space Savings
          </span>
          <span className="stat-value savings">
            {stats ? formatBytes(stats.totalPotentialSavingsBytes) : "..."}
          </span>
          <span className="stat-subtext">
            {stats?.recommendedCount ?? 0} files eligible for compression
          </span>
        </div>

        <div className="card stat-card">
          <span className="stat-label">
            <IconFilm size={14} /> Total Library Storage
          </span>
          <span className="stat-value">{stats ? formatBytes(stats.totalLibrarySizeBytes) : "..."}</span>
          <span className="stat-subtext">{stats?.filesScanned ?? 0} media files indexed</span>
        </div>

        <div className="card stat-card">
          <span className="stat-label">
            <IconQueue size={14} /> Transcode Queue
          </span>
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
            <span style={{ color: "var(--text-muted)", fontSize: "0.85rem", fontVariantNumeric: "tabular-nums" }}>{totalCodecFiles} files</span>
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
                  <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color, display: "inline-block" }} />
                  <span style={{ fontWeight: 600 }}>{codec}</span>
                  <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {data.count} ({pct}%) • {formatBytes(data.sizeBytes)}
                  </span>
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
        <div className="card empty-state">
          <div className="empty-state-icon">
            <IconFolder size={36} />
          </div>
          <h3 className="empty-state-title">No Libraries Added Yet</h3>
          <p className="empty-state-desc">
            Point Shrinkarr at your movie, TV show, or video folders to index files and calculate storage savings.
          </p>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <IconPlus size={15} />
            <span>Add Your First Library</span>
          </button>
        </div>
      )}

      <div className="grid-2">
        {stats?.librarySummaries?.map((lib) => {
          const presetObj = presets.find((p) => p.id === lib.presetId);
          const isThisLibScanning = scanProgress?.isScanning && scanProgress.libraryId === lib.id;

          let categoryBadge = "Other";
          if (lib.mediaType === "movie") categoryBadge = "Movies";
          else if (lib.mediaType === "tv") categoryBadge = "TV Shows";
          else if (lib.mediaType === "youtube" || lib.mediaType === "web") categoryBadge = "YouTube / Web";

          return (
            <div key={lib.id} className="card library-card">
              <div>
                <div className="library-card-header">
                  <div>
                    <span className="library-title">
                      <IconFolder size={18} color="var(--accent-primary)" />
                      {lib.name}
                    </span>
                    <div className="library-path">{lib.path}</div>
                  </div>
                  <span className="badge badge-res">
                    {categoryBadge}
                  </span>
                </div>

                <div className="library-stats-row">
                  <div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Files</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{lib.fileCount}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Current Size</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{formatBytes(lib.totalSizeBytes)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Potential Savings</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--accent-emerald)" }}>
                      {formatBytes(lib.potentialSavingsBytes)}
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: lib.totalDiskBytes ? "0.5rem" : "1rem" }}>
                  Active Preset: <strong style={{ color: "var(--text-main)" }}>{presetObj?.name ?? lib.presetId}</strong> ({presetObj?.targetCodec.toUpperCase() ?? "HEVC"})
                </div>

                {Boolean(lib.totalDiskBytes && lib.freeBytes !== undefined && lib.freeBytes !== null) && (
                  <div style={{ marginBottom: "1rem", backgroundColor: "var(--bg-surface)", padding: "0.5rem 0.75rem", borderRadius: "6px", border: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                      <span>Volume Free Space</span>
                      <span style={{ fontWeight: 600, color: "var(--text-main)", fontVariantNumeric: "tabular-nums" }}>
                        {formatBytes(lib.freeBytes!)} free of {formatBytes(lib.totalDiskBytes!)}
                      </span>
                    </div>
                    <div style={{ height: "6px", backgroundColor: "rgba(255,255,255,0.08)", borderRadius: "3px", overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, Math.max(0, ((lib.totalDiskBytes! - lib.freeBytes!) / lib.totalDiskBytes!) * 100))}%`,
                          backgroundColor: ((lib.totalDiskBytes! - lib.freeBytes!) / lib.totalDiskBytes!) > 0.9 ? "var(--accent-rose)" : "var(--accent-emerald)",
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="library-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleScan(lib.id)}
                  disabled={Boolean(scanProgress?.isScanning)}
                >
                  <IconSearch size={13} />
                  <span>{isThisLibScanning ? `Scanning (${scanProgress?.percent}%)...` : "Scan Library"}</span>
                </button>

                <button
                  className="btn btn-emerald btn-sm"
                  onClick={() => handleOptimizeLibrary(lib)}
                  disabled={optimizing === lib.id || lib.eligibleCount === 0 || Boolean(scanProgress?.isScanning)}
                >
                  <IconBolt size={13} />
                  <span>{optimizing === lib.id ? "Queueing..." : `Optimize (${lib.eligibleCount})`}</span>
                </button>

                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    setEditingLibrary({
                      id: lib.id,
                      name: lib.name,
                      path: lib.path,
                      mediaType: lib.mediaType,
                      presetId: lib.presetId,
                    })
                  }
                  title="Edit folder name, path, or quality preset"
                >
                  <IconEdit size={13} />
                  <span>Edit</span>
                </button>

                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDeleteLibrary(lib)}
                  title="Delete folder from Shrinkarr"
                >
                  <IconTrash size={13} />
                </button>

                <Link to={`/library?id=${lib.id}`} className="btn btn-secondary btn-sm" style={{ marginLeft: "auto" }}>
                  View Files
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

      {editingLibrary && (
        <EditLibraryModal
          library={editingLibrary}
          presets={presets}
          onUpdated={(updated) => {
            loadData();
            setSuccessMsg(`Library "${updated.name}" updated successfully!`);
          }}
          onClose={() => setEditingLibrary(null)}
        />
      )}
    </div>
  );
}
