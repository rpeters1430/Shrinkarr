import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getLibraries,
  getLibraryFiles,
  getPresets,
  postJob,
  postScan,
  postOptimizeLibrary,
  type FileRecord,
  type Library,
  type Preset,
} from "../api/client";
import { SimulatorModal } from "../components/SimulatorModal";
import { AddLibraryModal } from "../components/AddLibraryModal";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

type TabType = "recommended" | "keep" | "all";

export function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [libraries, setLibraries] = useState<Library[]>([]);
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
  const [scanning, setScanning] = useState(false);
  const [simulatingFile, setSimulatingFile] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    getPresets().then((res) => {
      setPresets(res);
      if (res.length > 0) setBatchPresetId(res[0].id);
    }).catch(() => {});
    
    getLibraries().then((libs) => {
      setLibraries(libs);
      const urlLibId = searchParams.get("id");
      if (urlLibId && libs.some((l) => l.id === urlLibId)) {
        setSelectedLibraryId(urlLibId);
      } else if (libs.length > 0) {
        setSelectedLibraryId(libs[0].id);
      }
    });
  }, []);

  function loadFiles(libId: string) {
    if (!libId) return;
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
    }
  }, [selectedLibraryId]);

  const currentLibrary = libraries.find((l) => l.id === selectedLibraryId);
  const currentPreset = presets.find((p) => p.id === currentLibrary?.presetId) ?? presets[0];

  async function handleScan() {
    if (!selectedLibraryId) return;
    setScanning(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await postScan(selectedLibraryId);
      setSuccessMsg("Scan triggered. Refreshing library files...");
      setTimeout(() => loadFiles(selectedLibraryId), 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  async function handleTranscodeSingle(filePath: string, customPresetId?: string) {
    const chosenPresetId = customPresetId || rowPresetMap[filePath] || currentLibrary?.presetId || "balanced";
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
      } catch {}
    }
    setSuccessMsg(`Queued ${queued} selected file(s) using preset "${presetObj?.name || presetToUse}".`);
    setSelectedPaths(new Set());
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

  const totalPotentialSavings = recommendedFiles.reduce((acc, f) => acc + f.estimatedSavingsBytes, 0);

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

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Library Explorer</h1>
          <p className="page-subtitle">
            Inspect individual video streams, choose custom encoding presets per show/file, and test simulations.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <select
            className="form-select"
            style={{ width: "auto", minWidth: "200px" }}
            value={selectedLibraryId}
            onChange={(e) => setSelectedLibraryId(e.target.value)}
          >
            {libraries.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name} ({lib.path})
              </option>
            ))}
          </select>

          <button className="btn btn-secondary" onClick={handleScan} disabled={scanning || !selectedLibraryId}>
            {scanning ? "🔍 Scanning..." : "🔍 Scan Library"}
          </button>

          <button
            className="btn btn-emerald"
            onClick={handleOptimizeAllRecommended}
            disabled={recommendedFiles.length === 0}
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

      {/* Library Summary Bar */}
      {currentLibrary && (
        <div
          className="card"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.25rem",
            padding: "1rem 1.25rem",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", textTransform: "uppercase" }}>
              Library Default Policy
            </div>
            <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
              Target: <span style={{ color: "var(--accent-cyan)" }}>{currentPreset?.targetCodec.toUpperCase()}</span> (Preset: {currentPreset?.name})
            </div>
          </div>

          <div style={{ display: "flex", gap: "1.5rem" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Total Scanned</div>
              <div style={{ fontWeight: 700 }}>{files.length} files</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Recommended</div>
              <div style={{ fontWeight: 700, color: "var(--accent-primary)" }}>{recommendedFiles.length} files</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Potential Recovery</div>
              <div style={{ fontWeight: 700, color: "var(--accent-emerald)" }}>{formatBytes(totalPotentialSavings)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
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
              if (codecUpper.includes("HEVC") || codecUpper.includes("H265")) codecBadgeClass = "badge-codec-hevc";
              else if (codecUpper.includes("AV1")) codecBadgeClass = "badge-codec-av1";
              else if (codecUpper.includes("MPEG2") || codecUpper.includes("VC1")) codecBadgeClass = "badge-codec-mpeg2";

              const is4k = file.resolution === "4K" || file.width >= 3000;
              const is1440 = file.resolution === "1440p";
              const selectedRowPreset = rowPresetMap[file.path] || currentLibrary?.presetId || presets[0]?.id || "balanced";

              return (
                <tr key={file.path} style={{ backgroundColor: isSelected ? "rgba(99, 102, 241, 0.08)" : undefined }}>
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelectFile(file.path)}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "#fff" }}>{fileName}</div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", fontFamily: "monospace" }}>
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
                          backgroundColor: is4k ? "rgba(168, 85, 247, 0.25)" : is1440 ? "rgba(6, 182, 212, 0.2)" : "rgba(255, 255, 255, 0.08)",
                          color: is4k ? "#c084fc" : is1440 ? "#22d3ee" : "#fff",
                          fontWeight: is4k ? 700 : 500,
                          border: is4k ? "1px solid rgba(168, 85, 247, 0.4)" : "1px solid var(--border)",
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
                  <td>
                    <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                      {file.audioCodec.toUpperCase()} {file.audioChannels > 2 ? `${file.audioChannels}ch` : "Stereo"}
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
                        onChange={(e) => setRowPresetMap({ ...rowPresetMap, [file.path]: e.target.value })}
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
            getLibraries().then(setLibraries);
            setSelectedLibraryId(newLib.id);
            setSuccessMsg("Library added successfully!");
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
