import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getLibraries,
  getLibraryFiles,
  getPresets,
  getScanStatus,
  deleteLibrary,
  postJob,
  postScan,
  postOptimizeLibrary,
  type FileRecord,
  type Library as LibraryType,
  type Preset,
  type ScanProgress,
} from "../api/client";
import { SimulatorModal } from "../components/SimulatorModal";
import { AddLibraryModal } from "../components/AddLibraryModal";
import { EditLibraryModal } from "../components/EditLibraryModal";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

type TabType = "recommended" | "keep" | "all";

export function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [libraries, setLibraries] = useState<LibraryType[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>("recommended");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCodec, setSelectedCodec] = useState("all");
  const [selectedRes, setSelectedRes] = useState("all");

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchPresetId, setBatchPresetId] = useState<string>("balanced");
  const [rowPresetMap, setRowPresetMap] = useState<Record<string, string>>({});
  const [queuingPath, setQueuingPath] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [simulatingFile, setSimulatingFile] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const prevScanningRef = useRef<boolean>(false);

  useEffect(() => {
    getPresets()
      .then((res) => {
        setPresets(res);
        if (res.length > 0) setBatchPresetId(res[0].id);
      })
      .catch(() => {});

    getLibraries().then((libs) => {
      setLibraries(libs);
      const urlLibId = searchParams.get("id");
      if (urlLibId && libs.some((l) => l.id === urlLibId)) {
        setSelectedLibraryId(urlLibId);
      } else if (libs.length > 0) {
        setSelectedLibraryId(libs[0].id);
      }
    });
  }, [searchParams]);

  function loadFiles(libId: string) {
    if (!libId) {
      setFiles([]);
      return;
    }
    getLibraryFiles(libId)
      .then((res) => {
        setFiles(res);
        setSelectedPaths(new Set());
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    if (selectedLibraryId) {
      loadFiles(selectedLibraryId);
      setSearchParams({ id: selectedLibraryId });
      const currentLib = libraries.find((l) => l.id === selectedLibraryId);
      if (currentLib?.presetId) {
        setBatchPresetId(currentLib.presetId);
      }
    } else {
      setFiles([]);
    }
  }, [selectedLibraryId, libraries, setSearchParams]);

  // Fast scan status polling
  useEffect(() => {
    const checkScan = () => {
      getScanStatus().then((sp) => {
        setScanProgress(sp);
        if (prevScanningRef.current && !sp.isScanning) {
          if (selectedLibraryId) loadFiles(selectedLibraryId);
          if (sp.lastSummary) setSuccessMsg(sp.lastSummary);
        }
        prevScanningRef.current = sp.isScanning;
      }).catch(() => {});
    };

    checkScan();
    const interval = setInterval(checkScan, scanProgress?.isScanning ? 750 : 3000);
    return () => clearInterval(interval);
  }, [scanProgress?.isScanning, selectedLibraryId]);

  const currentLibrary = libraries.find((l) => l.id === selectedLibraryId);
  const currentPreset = presets.find((p) => p.id === currentLibrary?.presetId) ?? presets[0];

  async function handleScan() {
    if (!selectedLibraryId) return;
    setError(null);
    setSuccessMsg(null);
    try {
      await postScan(selectedLibraryId);
      const sp = await getScanStatus();
      setScanProgress(sp);
      prevScanningRef.current = true;
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleTranscodeSingle(filePath: string, customPresetId?: string) {
    const chosenPresetId =
      customPresetId || rowPresetMap[filePath] || currentLibrary?.presetId || "balanced";
    setQueuingPath(filePath);
    setError(null);
    setSuccessMsg(null);
    try {
      await postJob(filePath, chosenPresetId);
      const presetObj = presets.find((p) => p.id === chosenPresetId);
      setSuccessMsg(`Queued transcode job with preset "${presetObj?.name || chosenPresetId}"!`);
    } catch (err) {
      setError(String(err));
    } finally {
      setQueuingPath(null);
    }
  }

  async function handleOptimizeAllRecommended() {
    if (!selectedLibraryId) return;
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await postOptimizeLibrary(selectedLibraryId);
      setSuccessMsg(`Queued ${res.queued} recommended file(s) for transcode!`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleQueueSelected() {
    if (selectedPaths.size === 0) return;
    setError(null);
    setSuccessMsg(null);
    let queued = 0;
    const presetToUse = batchPresetId || currentLibrary?.presetId || "balanced";
    const presetObj = presets.find((p) => p.id === presetToUse);

    for (const path of selectedPaths) {
      try {
        await postJob(path, presetToUse);
        queued++;
      } catch {
        // best-effort batch queue: skip files that fail individually
      }
    }
    setSuccessMsg(`Queued ${queued} selected file(s) using preset "${presetObj?.name || presetToUse}".`);
    setSelectedPaths(new Set());
  }

  async function handleDeleteLibrary() {
    if (!currentLibrary) return;
    setDeleting(true);
    setError(null);
    setSuccessMsg(null);

    const deletedId = currentLibrary.id;
    const deletedName = currentLibrary.name;

    try {
      await deleteLibrary(deletedId);
      const updatedLibs = libraries.filter((l) => l.id !== deletedId);
      setLibraries(updatedLibs);

      if (updatedLibs.length > 0) {
        setSelectedLibraryId(updatedLibs[0].id);
      } else {
        setSelectedLibraryId("");
        setFiles([]);
      }

      setSuccessMsg(`Library folder "${deletedName}" was deleted.`);
      setShowDeleteModal(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }

  // Filter files
  const recommendedFiles = files.filter((f) => f.needsTranscode);
  const keepFiles = files.filter((f) => !f.needsTranscode);

  const filteredFiles = files.filter((file) => {
    if (activeTab === "recommended" && !file.needsTranscode) return false;
    if (activeTab === "keep" && file.needsTranscode) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!file.path.toLowerCase().includes(q)) return false;
    }

    if (selectedCodec !== "all" && file.codec.toLowerCase() !== selectedCodec.toLowerCase()) {
      return false;
    }

    if (selectedRes !== "all") {
      const r = file.resolution.toLowerCase();
      const target = selectedRes.toLowerCase();
      if (!r.includes(target) && target !== r) return false;
    }

    return true;
  });

  const totalPotentialSavings = recommendedFiles.reduce(
    (acc, f) => acc + f.estimatedSavingsBytes,
    0,
  );

  function toggleSelectAll() {
    if (selectedPaths.size === filteredFiles.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(filteredFiles.map((f) => f.path)));
    }
  }

  function toggleSelectFile(path: string) {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedPaths(next);
  }

  let mediaTypeLabel = "📁 Other";
  if (currentLibrary?.mediaType === "movie") mediaTypeLabel = "🎬 Movies";
  else if (currentLibrary?.mediaType === "tv") mediaTypeLabel = "📺 TV Shows";
  else if (currentLibrary?.mediaType === "youtube" || currentLibrary?.mediaType === "web")
    mediaTypeLabel = "📹 YouTube / Web";

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Library Explorer</h1>
          <p className="page-subtitle">
            Inspect individual video streams, manage folder presets and quality, and batch optimize.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          {libraries.length > 0 && (
            <select
              className="form-select"
              style={{ width: "auto", minWidth: "220px" }}
              value={selectedLibraryId}
              onChange={(e) => setSelectedLibraryId(e.target.value)}
            >
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name} ({lib.path})
                </option>
              ))}
            </select>
          )}

          {currentLibrary && (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setShowEditModal(true)}
                title="Edit folder path, name, media type, and default quality preset"
              >
                ✏️ Edit Folder
              </button>

              <button
                className="btn btn-danger"
                onClick={() => setShowDeleteModal(true)}
                title="Delete this folder from Shrinkarr"
              >
                🗑️ Delete Folder
              </button>
            </>
          )}

          <button
            className="btn btn-secondary"
            onClick={handleScan}
            disabled={Boolean(scanProgress?.isScanning) || !selectedLibraryId}
          >
            {Boolean(scanProgress?.isScanning) && scanProgress?.libraryId === selectedLibraryId
              ? `🔍 Scanning (${scanProgress?.percent ?? 0}%)...`
              : "🔍 Scan Library"}
          </button>

          <button
            className="btn btn-emerald"
            onClick={handleOptimizeAllRecommended}
            disabled={recommendedFiles.length === 0 || Boolean(scanProgress?.isScanning)}
          >
            ⚡ Optimize Recommended ({recommendedFiles.length})
          </button>

          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            ➕ Add Library
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Live Scan Progress Banner */}
      {scanProgress?.isScanning && (!scanProgress.libraryId || scanProgress.libraryId === selectedLibraryId) && (
        <div className="card" style={{ marginBottom: "1.25rem", border: "1px solid var(--accent-cyan)", backgroundColor: "rgba(6, 182, 212, 0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
              <strong style={{ color: "#fff", fontSize: "1.05rem" }}>
                Scanning Library: {scanProgress.libraryName || currentLibrary?.name || "Media Library"}
              </strong>
            </div>
            <span style={{ fontWeight: 700, color: "var(--accent-cyan)", fontSize: "1.1rem" }}>
              {scanProgress.phase === "discovering"
                ? "Discovering Files..."
                : `${scanProgress.percent}% (${scanProgress.current} / ${scanProgress.total} files)`}
            </span>
          </div>

          <div style={{ width: "100%", height: 8, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden", marginBottom: "0.75rem" }}>
            <div
              style={{
                width: scanProgress.phase === "discovering" ? "100%" : `${scanProgress.percent}%`,
                height: "100%",
                backgroundColor: "var(--accent-cyan)",
                transition: "width 0.3s ease",
                opacity: scanProgress.phase === "discovering" ? 0.6 : 1,
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.82rem", flexWrap: "wrap", gap: "0.5rem" }}>
            <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>
              {scanProgress.phase === "discovering" ? (
                <span>Crawling folder structure on disk...</span>
              ) : (
                <>
                  Probing: <span style={{ color: "#fff", fontFamily: "monospace" }}>{scanProgress.currentFile || "Reading video streams..."}</span>
                </>
              )}
            </div>
            <div style={{ color: "var(--accent-emerald)", fontWeight: 600 }}>
              ⭐ Found {scanProgress.recommendedCount} eligible for optimization
              {scanProgress.totalSavingsBytes ? ` (~${formatBytes(scanProgress.totalSavingsBytes)})` : ""}
            </div>
          </div>
        </div>
      )}

      {/* Library Summary Bar */}
      {currentLibrary && (
        <div
          className="card"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.25rem",
            padding: "1.1rem 1.25rem",
            flexWrap: "wrap",
            gap: "1rem",
            border: "1px solid rgba(99, 102, 241, 0.25)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <strong style={{ fontSize: "1.1rem", color: "#fff" }}>{currentLibrary.name}</strong>
              <span className="badge badge-res">{mediaTypeLabel}</span>
              {currentLibrary.autoOptimize && (
                <span className="badge badge-status-eligible" title="New files in this folder are auto-queued">
                  ⚡ Auto-Optimize
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
              {currentLibrary.path}
            </div>
            <div style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
              <span style={{ color: "var(--text-muted)" }}>Quality Preset:</span>{" "}
              <strong style={{ color: "var(--accent-cyan)" }}>{currentPreset?.name}</strong>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: "0.78rem" }}>
                ({currentPreset?.targetCodec.toUpperCase()} • CRF {currentPreset?.crf} • {currentPreset?.hwaccel.toUpperCase()})
              </span>
            </div>
          </div>

          <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Total Scanned</div>
              <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>{files.length} files</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Recommended</div>
              <div style={{ fontWeight: 700, fontSize: "1.15rem", color: "var(--accent-primary)" }}>
                {recommendedFiles.length} files
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Potential Recovery</div>
              <div style={{ fontWeight: 700, fontSize: "1.15rem", color: "var(--accent-emerald)" }}>
                {formatBytes(totalPotentialSavings)}
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowEditModal(true)}
                title="Edit quality preset or folder details"
              >
                ✏️ Edit
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setShowDeleteModal(true)}
                title="Remove folder"
              >
                🗑️ Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {libraries.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: "3rem 1.5rem", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>📂</div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>No Libraries Added Yet</h3>
          <p style={{ color: "var(--text-muted)", maxWidth: "450px", margin: "0 auto 1.5rem" }}>
            Add your movie, TV, or web video folders to start inspecting streams and optimizing storage.
          </p>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            ➕ Add Media Library
          </button>
        </div>
      )}

      {/* Tabs */}
      {libraries.length > 0 && (
        <>
          <div className="tabs-container">
            <button
              className={`tab-btn ${activeTab === "recommended" ? "active" : ""}`}
              onClick={() => setActiveTab("recommended")}
            >
              ⭐ Recommended for Transcode ({recommendedFiles.length})
            </button>
            <button
              className={`tab-btn ${activeTab === "keep" ? "active" : ""}`}
              onClick={() => setActiveTab("keep")}
            >
              ✓ Efficient / Keep ({keepFiles.length})
            </button>
            <button
              className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              📁 All Files ({files.length})
            </button>
          </div>

          {/* Search and Filters */}
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <input
              className="form-input"
              style={{ flex: 1, minWidth: "220px" }}
              placeholder="Filter by show name or path (e.g. Reacher, Silo, Spider-Man)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <select
              className="form-select"
              style={{ width: "auto" }}
              value={selectedCodec}
              onChange={(e) => setSelectedCodec(e.target.value)}
            >
              <option value="all">All Codecs</option>
              <option value="h264">H.264</option>
              <option value="hevc">HEVC (H.265)</option>
              <option value="av1">AV1</option>
              <option value="mpeg2video">MPEG-2</option>
              <option value="vc1">VC-1</option>
            </select>

            <select
              className="form-select"
              style={{ width: "auto" }}
              value={selectedRes}
              onChange={(e) => setSelectedRes(e.target.value)}
            >
              <option value="all">All Resolutions</option>
              <option value="4K">4K UHD</option>
              <option value="1440p">1440p QHD</option>
              <option value="1080p">1080p FHD</option>
              <option value="720p">720p HD</option>
              <option value="480p">480p / SD</option>
            </select>
          </div>

          {/* Batch Optimization Action Bar (When Items Selected) */}
          {selectedPaths.size > 0 && (
            <div
              className="card"
              style={{
                marginBottom: "1.25rem",
                padding: "0.85rem 1.25rem",
                backgroundColor: "rgba(16, 185, 129, 0.08)",
                border: "1px solid rgba(16, 185, 129, 0.35)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "1rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ fontSize: "1.25rem" }}>⚡</span>
                <div>
                  <strong style={{ color: "#fff" }}>{selectedPaths.size} file(s) selected</strong>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    Select the target preset to apply to all selected files:
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <select
                  className="form-select"
                  style={{ width: "auto", minWidth: "220px" }}
                  value={batchPresetId}
                  onChange={(e) => setBatchPresetId(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.targetCodec.toUpperCase()} • CRF {p.crf})
                    </option>
                  ))}
                </select>

                <button className="btn btn-emerald" onClick={handleQueueSelected}>
                  ⚡ Queue {selectedPaths.size} Selected
                </button>

                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedPaths(new Set())}>
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          {/* Files Table */}
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: "40px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={filteredFiles.length > 0 && selectedPaths.size === filteredFiles.length}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>File Name & Path</th>
                  <th>Current Codec</th>
                  <th>Resolution / Video</th>
                  <th>Audio & Subs</th>
                  <th>Current Size</th>
                  <th>Est. Savings</th>
                  <th>Action</th>
                  <th style={{ textAlign: "right", minWidth: "260px" }}>Preset & Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: "center", padding: "2.5rem", color: "var(--text-dim)" }}>
                      {files.length === 0 ? (
                        <div>
                          No files indexed yet for this library. Click <strong>"Scan Library"</strong> above.
                        </div>
                      ) : (
                        <div>No media files matching the active filter.</div>
                      )}
                    </td>
                  </tr>
                )}

                {filteredFiles.map((file) => {
                  const fileName = file.path.split(/[/\\]/).pop() || file.path;
                  const isSelected = selectedPaths.has(file.path);
                  const codecUpper = file.codec.toUpperCase();

                  let codecBadgeClass = "badge-codec-h264";
                  if (codecUpper.includes("HEVC") || codecUpper.includes("H265"))
                    codecBadgeClass = "badge-codec-hevc";
                  else if (codecUpper.includes("AV1")) codecBadgeClass = "badge-codec-av1";
                  else if (codecUpper.includes("MPEG2") || codecUpper.includes("VC1"))
                    codecBadgeClass = "badge-codec-mpeg2";

                  const is4k = file.resolution === "4K" || file.width >= 3000;
                  const is1440 = file.resolution === "1440p";
                  const selectedRowPreset =
                    rowPresetMap[file.path] || currentLibrary?.presetId || presets[0]?.id || "balanced";

                  return (
                    <tr
                      key={file.path}
                      style={{ backgroundColor: isSelected ? "rgba(99, 102, 241, 0.08)" : undefined }}
                    >
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectFile(file.path)}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "#fff" }}>{fileName}</div>
                        <div
                          style={{
                            fontSize: "0.78rem",
                            color: "var(--text-dim)",
                            fontFamily: "monospace",
                          }}
                        >
                          {file.path}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${codecBadgeClass}`}>{codecUpper}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.3rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span
                            className="badge"
                            style={{
                              backgroundColor: is4k
                                ? "rgba(168, 85, 247, 0.25)"
                                : is1440
                                  ? "rgba(6, 182, 212, 0.2)"
                                  : "rgba(255, 255, 255, 0.08)",
                              color: is4k ? "#c084fc" : is1440 ? "#22d3ee" : "#fff",
                              fontWeight: is4k ? 700 : 500,
                              border: is4k
                                ? "1px solid rgba(168, 85, 247, 0.4)"
                                : "1px solid var(--border)",
                            }}
                          >
                            {file.resolution}
                          </span>
                          {file.bitDepth === 10 && <span className="badge badge-res">10-bit</span>}
                          {file.isHdr && <span className="badge badge-hdr">HDR</span>}
                        </div>
                        <div
                          style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}
                        >
                          {file.width > 0 && file.height > 0 ? `${file.width}×${file.height}` : ""}{" "}
                          {file.bitrateKbps ? `• ${(file.bitrateKbps / 1000).toFixed(1)} Mbps` : ""}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                          {file.audioCodec.toUpperCase()}{" "}
                          {file.audioChannels > 2 ? `${file.audioChannels}ch` : "Stereo"}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                          {file.subtitleCount} sub track(s)
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>{formatBytes(file.sizeBytes)}</td>
                      <td>
                        {file.estimatedSavingsBytes > 0 ? (
                          <span style={{ color: "var(--accent-emerald)", fontWeight: 700 }}>
                            ~{formatBytes(file.estimatedSavingsBytes)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>—</span>
                        )}
                      </td>
                      <td>
                        {file.needsTranscode ? (
                          <span className="badge badge-status-eligible">
                            ⚡ {file.recommendedAction}
                          </span>
                        ) : (
                          <span className="badge badge-status-keep">
                            ✓ {file.skipReason?.includes("target") ? "Efficient" : file.recommendedAction}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <div style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                          <select
                            className="form-select form-select-sm"
                            style={{ width: "135px", fontSize: "0.78rem", padding: "0.25rem 0.4rem" }}
                            value={selectedRowPreset}
                            onChange={(e) =>
                              setRowPresetMap({ ...rowPresetMap, [file.path]: e.target.value })
                            }
                            title="Choose custom encoding preset for this file"
                          >
                            {presets.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name.split(" ")[0]} ({p.targetCodec.toUpperCase()})
                              </option>
                            ))}
                          </select>

                          <button
                            className="btn btn-secondary btn-sm"
                            title="Sample 30s clip with selected preset"
                            onClick={() => setSimulatingFile(file.path)}
                          >
                            🧪 Test
                          </button>

                          <button
                            className="btn btn-primary btn-sm"
                            disabled={queuingPath === file.path}
                            onClick={() => handleTranscodeSingle(file.path, selectedRowPreset)}
                            title={`Queue transcode with ${presets.find((p) => p.id === selectedRowPreset)?.name}`}
                          >
                            {queuingPath === file.path ? "Queueing..." : "⚡ Optimize"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Simulator Modal */}
      {simulatingFile && (
        <SimulatorModal
          filePath={simulatingFile}
          presets={presets}
          defaultPresetId={rowPresetMap[simulatingFile] || currentLibrary?.presetId}
          onClose={() => setSimulatingFile(null)}
          onQueueOptimized={(p, presetId) => handleTranscodeSingle(p, presetId)}
        />
      )}

      {/* Add Library Modal */}
      {showAddModal && (
        <AddLibraryModal
          presets={presets}
          onAdded={(newLib) => {
            getLibraries().then((updated) => {
              setLibraries(updated);
              setSelectedLibraryId(newLib.id);
            });
            setSuccessMsg(`Library "${newLib.name}" added successfully!`);
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Edit Library Modal */}
      {showEditModal && currentLibrary && (
        <EditLibraryModal
          library={currentLibrary}
          presets={presets}
          onUpdated={(updatedLib) => {
            getLibraries().then(setLibraries);
            loadFiles(updatedLib.id);
            setSuccessMsg(`Library "${updatedLib.name}" updated successfully!`);
          }}
          onClose={() => setShowEditModal(false)}
        />
      )}

      {/* Delete Library Confirmation Modal */}
      {showDeleteModal && currentLibrary && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "480px" }}>
            <div className="modal-header">
              <h3 className="modal-title" style={{ color: "var(--accent-rose)" }}>
                🗑️ Delete Library Folder
              </h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowDeleteModal(false)}>
                ✕
              </button>
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <p style={{ marginBottom: "0.75rem", fontSize: "0.95rem" }}>
                Are you sure you want to remove the library <strong>"{currentLibrary.name}"</strong>?
              </p>
              <div
                style={{
                  padding: "0.75rem 1rem",
                  backgroundColor: "var(--bg-surface)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  color: "var(--text-muted)",
                  marginBottom: "1rem",
                }}
              >
                {currentLibrary.path}
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                This removes the folder from Shrinkarr and clears its scan history.{" "}
                <strong style={{ color: "#fff" }}>Your original video files on disk will NOT be deleted.</strong>
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteLibrary}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete Library"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
