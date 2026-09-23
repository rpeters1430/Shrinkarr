import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getLibraries,
  getLibraryFiles,
  getPresets,
  getScanStatus,
  deleteLibrary,
  postJob,
  postBulkJobs,
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
import {
  IconPlus,
  IconSearch,
  IconBolt,
  IconEdit,
  IconTrash,
  IconClose,
  IconFolder,
  IconCheck,
} from "../components/Icons";

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
  const [sortField, setSortField] = useState<"savings" | "size" | "duration" | "name">("savings");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

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
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && showDeleteModal) {
        setShowDeleteModal(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showDeleteModal]);

  function handleSelectLibrary(id: string) {
    setSelectedLibraryId(id);
    setSearchParams({ id });
    const currentLib = libraries.find((l) => l.id === id);
    if (currentLib?.presetId) {
      setBatchPresetId(currentLib.presetId);
    }
  }

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
    getPresets()
      .then((res) => {
        setPresets(res);
        if (res.length > 0) setBatchPresetId(res[0].id);
      })
      .catch(() => {});

    getLibraries().then((libs) => {
      setLibraries(libs);
      const urlLibId = searchParams.get("id");
      const targetLib = (urlLibId && libs.find((l) => l.id === urlLibId)) || libs[0];
      if (targetLib) {
        setSelectedLibraryId(targetLib.id);
        if (targetLib.presetId) {
          setBatchPresetId(targetLib.presetId);
        }
      }
    });
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedLibraryId) return;

    getLibraryFiles(selectedLibraryId)
      .then((res) => {
        if (!cancelled) {
          setFiles(res);
          setSelectedPaths(new Set());
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLibraryId]);

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
    const presetToUse = batchPresetId || currentLibrary?.presetId || "balanced";
    const presetObj = presets.find((p) => p.id === presetToUse);

    try {
      const res = await postBulkJobs(Array.from(selectedPaths), presetToUse);
      setSuccessMsg(`Queued ${res.queued} selected file(s) using preset "${presetObj?.name || presetToUse}".`);
      setSelectedPaths(new Set());
    } catch (err) {
      setError(`Failed to bulk queue files: ${(err as Error).message}`);
    }
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
        handleSelectLibrary(updatedLibs[0].id);
      } else {
        setSelectedLibraryId("");
        setSearchParams({});
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

  const sortedFiles = [...filteredFiles].sort((a, b) => {
    let diff = 0;
    if (sortField === "name") {
      const nameA = a.path.split(/[/\\]/).pop() || a.path;
      const nameB = b.path.split(/[/\\]/).pop() || b.path;
      diff = nameA.localeCompare(nameB);
    } else if (sortField === "size") {
      diff = a.sizeBytes - b.sizeBytes;
    } else if (sortField === "savings") {
      diff = a.estimatedSavingsBytes - b.estimatedSavingsBytes;
    } else if (sortField === "duration") {
      diff = a.durationSeconds - b.durationSeconds;
    }
    return sortAsc ? diff : -diff;
  });

  const totalPages = Math.max(1, Math.ceil(sortedFiles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedFiles = sortedFiles.slice(startIndex, startIndex + pageSize);

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

  let mediaTypeLabel = "Other";
  if (currentLibrary?.mediaType === "movie") mediaTypeLabel = "Movies";
  else if (currentLibrary?.mediaType === "tv") mediaTypeLabel = "TV Shows";
  else if (currentLibrary?.mediaType === "youtube" || currentLibrary?.mediaType === "web")
    mediaTypeLabel = "YouTube / Web";

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Library Explorer</h1>
          <p className="page-subtitle">
            Inspect individual video streams, manage folder presets and quality, and batch optimize.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          {libraries.length > 0 && (
            <select
              className="form-select"
              style={{ width: "auto", minWidth: "220px" }}
              value={selectedLibraryId}
              onChange={(e) => handleSelectLibrary(e.target.value)}
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
                <IconEdit size={14} />
                <span>Edit Folder</span>
              </button>

              <button
                className="btn btn-danger"
                onClick={() => setShowDeleteModal(true)}
                title="Delete this folder from Shrinkarr"
              >
                <IconTrash size={14} />
                <span>Delete Folder</span>
              </button>
            </>
          )}

          <button
            className="btn btn-secondary"
            onClick={handleScan}
            disabled={Boolean(scanProgress?.isScanning) || !selectedLibraryId}
          >
            <IconSearch size={14} />
            <span>
              {Boolean(scanProgress?.isScanning) && scanProgress?.libraryId === selectedLibraryId
                ? `Scanning (${scanProgress?.percent ?? 0}%)...`
                : "Scan Library"}
            </span>
          </button>

          <button
            className="btn btn-emerald"
            onClick={handleOptimizeAllRecommended}
            disabled={recommendedFiles.length === 0 || Boolean(scanProgress?.isScanning)}
          >
            <IconBolt size={14} />
            <span>Optimize Recommended ({recommendedFiles.length})</span>
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

      {/* Live Scan Progress Banner */}
      {scanProgress?.isScanning && (!scanProgress.libraryId || scanProgress.libraryId === selectedLibraryId) && (
        <div className="card" style={{ marginBottom: "1.25rem", border: "1px solid var(--accent-primary)", backgroundColor: "rgba(59, 130, 246, 0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
              <strong style={{ color: "#fff", fontSize: "1.05rem" }}>
                Scanning Library: {scanProgress.libraryName || currentLibrary?.name || "Media Library"}
              </strong>
            </div>
            <span style={{ fontWeight: 700, color: "var(--accent-primary)", fontSize: "1.05rem", fontVariantNumeric: "tabular-nums" }}>
              {scanProgress.phase === "discovering"
                ? "Discovering Files..."
                : `${scanProgress.percent}% (${scanProgress.current} / ${scanProgress.total} files)`}
            </span>
          </div>

          <div style={{ width: "100%", height: 6, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden", marginBottom: "0.75rem" }}>
            <div
              style={{
                width: scanProgress.phase === "discovering" ? "100%" : `${scanProgress.percent}%`,
                height: "100%",
                backgroundColor: "var(--accent-primary)",
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
                  Probing: <span style={{ color: "#fff", fontFamily: "ui-monospace, monospace" }}>{scanProgress.currentFile || "Reading video streams..."}</span>
                </>
              )}
            </div>
            <div style={{ color: "var(--accent-emerald)", fontWeight: 600 }}>
              Found {scanProgress.recommendedCount} eligible for optimization
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
            border: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <IconFolder size={18} color="var(--accent-primary)" />
              <strong style={{ fontSize: "1.1rem", color: "#fff" }}>{currentLibrary.name}</strong>
              <span className="badge badge-res">{mediaTypeLabel}</span>
              {currentLibrary.autoOptimize && (
                <span className="badge badge-status-eligible" title="New files in this folder are auto-queued">
                  Auto-Optimize
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-dim)", fontFamily: "ui-monospace, monospace" }}>
              {currentLibrary.path}
            </div>
            <div style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
              <span style={{ color: "var(--text-muted)" }}>Quality Preset:</span>{" "}
              <strong style={{ color: "var(--accent-primary)" }}>{currentPreset?.name}</strong>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: "0.78rem" }}>
                ({currentPreset?.targetCodec.toUpperCase()} • CRF {currentPreset?.crf} • {currentPreset?.hwaccel.toUpperCase()})
              </span>
              {" • "}
              <span style={{ color: "var(--text-muted)" }}>Min Size:</span>{" "}
              <strong style={{ color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                {currentLibrary.minFileSizeMb !== undefined
                  ? `${currentLibrary.minFileSizeMb} MB`
                  : currentLibrary.mediaType === "other" || currentLibrary.mediaType === "youtube" || currentLibrary.mediaType === "web"
                    ? `${Math.min(currentPreset?.minFileSizeMb ?? 500, 25)} MB`
                    : `${currentPreset?.minFileSizeMb ?? 500} MB`}
              </strong>
            </div>
          </div>

          <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
            <div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Total Scanned</div>
              <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>{files.length} files</div>
            </div>
            <div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Recommended</div>
              <div style={{ fontWeight: 700, fontSize: "1.15rem", color: "var(--accent-primary)" }}>
                {recommendedFiles.length} files
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Potential Recovery</div>
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
                <IconEdit size={13} />
                <span>Edit</span>
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setShowDeleteModal(true)}
                title="Remove folder"
              >
                <IconTrash size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {libraries.length === 0 && (
        <div className="card empty-state" style={{ marginBottom: "1.5rem" }}>
          <div className="empty-state-icon">
            <IconFolder size={36} />
          </div>
          <h3 className="empty-state-title">No Libraries Added Yet</h3>
          <p className="empty-state-desc">
            Add your movie, TV, or web video folders to start inspecting streams and optimizing storage.
          </p>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <IconPlus size={14} />
            <span>Add Media Library</span>
          </button>
        </div>
      )}

      {/* Tabs */}
      {libraries.length > 0 && (
        <>
          <div className="tabs-container">
            <button
              className={`tab-btn ${activeTab === "recommended" ? "active" : ""}`}
              onClick={() => { setActiveTab("recommended"); setPage(1); }}
            >
              Recommended for Transcode ({recommendedFiles.length})
            </button>
            <button
              className={`tab-btn ${activeTab === "keep" ? "active" : ""}`}
              onClick={() => { setActiveTab("keep"); setPage(1); }}
            >
              Efficient / Keep ({keepFiles.length})
            </button>
            <button
              className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
              onClick={() => { setActiveTab("all"); setPage(1); }}
            >
              All Files ({files.length})
            </button>
          </div>

          {/* Search and Filters */}
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <input
              className="form-input"
              style={{ flex: 1, minWidth: "220px" }}
              placeholder="Filter by title or file path..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            />

            <select
              className="form-select"
              style={{ width: "auto" }}
              value={selectedCodec}
              onChange={(e) => { setSelectedCodec(e.target.value); setPage(1); }}
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
              onChange={(e) => { setSelectedRes(e.target.value); setPage(1); }}
            >
              <option value="all">All Resolutions</option>
              <option value="4K">4K UHD</option>
              <option value="1440p">1440p QHD</option>
              <option value="1080p">1080p FHD</option>
              <option value="720p">720p HD</option>
              <option value="480p">480p / SD</option>
            </select>

            <select
              className="form-select"
              style={{ width: "auto" }}
              value={`${sortField}-${sortAsc ? "asc" : "desc"}`}
              onChange={(e) => {
                const parts = e.target.value.split("-");
                setSortField(parts[0] as "savings" | "size" | "duration" | "name");
                setSortAsc(parts[1] === "asc");
                setPage(1);
              }}
            >
              <option value="savings-desc">Sort: Highest Savings</option>
              <option value="savings-asc">Sort: Lowest Savings</option>
              <option value="size-desc">Sort: Largest Files</option>
              <option value="size-asc">Sort: Smallest Files</option>
              <option value="name-asc">Sort: Name (A-Z)</option>
              <option value="name-desc">Sort: Name (Z-A)</option>
              <option value="duration-desc">Sort: Longest Duration</option>
              <option value="duration-asc">Sort: Shortest Duration</option>
            </select>
          </div>

          {/* Batch Optimization Action Bar */}
          {selectedPaths.size > 0 && (
            <div
              className="card"
              style={{
                marginBottom: "1.25rem",
                padding: "0.85rem 1.25rem",
                backgroundColor: "var(--bg-surface)",
                border: "1px solid var(--accent-emerald)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "1rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <IconBolt size={18} color="var(--accent-emerald)" />
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
                  <IconBolt size={14} />
                  <span>Queue {selectedPaths.size} Selected</span>
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
                  <th style={{ width: "28%", minWidth: "180px", maxWidth: "340px" }}>File Name & Path</th>
                  <th className="nowrap">Current Codec</th>
                  <th className="nowrap">Resolution / Video</th>
                  <th className="nowrap">Audio & Subs</th>
                  <th className="nowrap">Current Size</th>
                  <th className="nowrap">Est. Savings</th>
                  <th className="nowrap">Action</th>
                  <th style={{ textAlign: "right", minWidth: "240px" }} className="nowrap">Preset & Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <div className="empty-state">
                        <div className="empty-state-icon">
                          <IconSearch size={28} />
                        </div>
                        <h4 className="empty-state-title">No Media Files Found</h4>
                        <p className="empty-state-desc">
                          {files.length === 0
                            ? "No media files have been indexed yet. Run a library scan to inspect streams."
                            : "No files match the currently selected search query or codec filter."}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}

                {paginatedFiles.map((file) => {
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
                      style={{ backgroundColor: isSelected ? "rgba(59, 130, 246, 0.08)" : undefined }}
                    >
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectFile(file.path)}
                        />
                      </td>
                      <td className="cell-video-info">
                        <div className="video-title" title={fileName}>{fileName}</div>
                        <div className="video-path" title={file.path}>
                          {file.path}
                        </div>
                      </td>
                      <td className="nowrap">
                        <span className={`badge ${codecBadgeClass}`}>{codecUpper}</span>
                      </td>
                      <td className="nowrap">
                        <div style={{ display: "flex", gap: "0.3rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span
                            className="badge"
                            style={{
                              backgroundColor: is4k
                                ? "rgba(139, 92, 246, 0.2)"
                                : is1440
                                  ? "rgba(59, 130, 246, 0.15)"
                                  : "rgba(255, 255, 255, 0.06)",
                              color: is4k ? "#c4b5fd" : is1440 ? "#93c5fd" : "#fff",
                              fontWeight: is4k ? 700 : 500,
                              border: is4k ? "1px solid rgba(139, 92, 246, 0.35)" : "1px solid var(--border)",
                            }}
                          >
                            {file.resolution}
                          </span>
                          {file.bitDepth === 10 && <span className="badge badge-res">10-bit</span>}
                          {file.isHdr && <span className="badge badge-hdr">HDR</span>}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                          {file.width > 0 && file.height > 0 ? `${file.width}×${file.height}` : ""}{" "}
                          {file.bitrateKbps ? `• ${(file.bitrateKbps / 1000).toFixed(1)} Mbps` : ""}
                        </div>
                      </td>
                      <td className="nowrap">
                        <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                          {file.audioCodec.toUpperCase()}{" "}
                          {file.audioChannels > 2 ? `${file.audioChannels}ch` : "Stereo"}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                          {file.subtitleCount} sub track(s)
                        </div>
                      </td>
                      <td className="nowrap" style={{ fontWeight: 600 }}>{formatBytes(file.sizeBytes)}</td>
                      <td className="nowrap">
                        {file.estimatedSavingsBytes > 0 ? (
                          <span style={{ color: "var(--accent-emerald)", fontWeight: 700 }}>
                            ~{formatBytes(file.estimatedSavingsBytes)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>-</span>
                        )}
                      </td>
                      <td className="nowrap">
                        {file.needsTranscode ? (
                          <span className="badge badge-status-eligible">
                            {file.recommendedAction}
                          </span>
                        ) : (
                          <span className="badge badge-status-keep" title={file.skipReason || undefined}>
                            <IconCheck size={11} /> {file.skipReason?.includes("target") ? "Efficient" : file.recommendedAction}
                          </span>
                        )}
                      </td>
                      <td className="nowrap" style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                          <select
                            className="form-select"
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
                            Test
                          </button>

                          <button
                            className="btn btn-primary btn-sm"
                            disabled={queuingPath === file.path}
                            onClick={() => handleTranscodeSingle(file.path, selectedRowPreset)}
                            title={`Queue transcode with ${presets.find((p) => p.id === selectedRowPreset)?.name}`}
                          >
                            {queuingPath === file.path ? "Queueing..." : "Optimize"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredFiles.length > 0 && (
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
                <strong style={{ color: "#fff" }}>{Math.min(startIndex + pageSize, sortedFiles.length)}</strong> of{" "}
                <strong style={{ color: "#fff" }}>{sortedFiles.length}</strong> files
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
                <span style={{ fontWeight: 600, color: "var(--text-main)", fontVariantNumeric: "tabular-nums" }}>
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
              handleSelectLibrary(newLib.id);
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
                <IconTrash size={18} /> Delete Library Folder
              </h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowDeleteModal(false)} aria-label="Close dialog">
                <IconClose size={14} />
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
                  fontFamily: "ui-monospace, monospace",
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
