import { useEffect, useState } from "react";
import {
  getHardware,
  testHardwareEncoder,
  getPresets,
  createPreset,
  updatePreset,
  deletePreset,
  restoreDefaultPresets,
  type HardwareReport,
  type Preset,
  type HwAccelType,
} from "../api/client";

export function HardwareAndPresets() {
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [testingEncoder, setTestingEncoder] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; speedMultiplier?: number }>>({});
  
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [isNewPreset, setIsNewPreset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  function loadAll() {
    getHardware().then(setHardware).catch((err) => setError(String(err)));
    getPresets().then(setPresets).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleTestEncoder(encoderId: string) {
    setTestingEncoder(encoderId);
    setError(null);
    try {
      const res = await testHardwareEncoder(encoderId);
      setTestResults((prev) => ({ ...prev, [encoderId]: { ok: res.ok, speedMultiplier: res.speedMultiplier } }));
      if (res.ok) {
        setSuccessMsg(`Encoder "${encoderId}" verified successfully (${res.speedMultiplier ? `${res.speedMultiplier.toFixed(1)}x speed` : "Ready"})!`);
      } else {
        setError(`Encoder "${encoderId}" failed test encode.`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setTestingEncoder(null);
    }
  }

  async function handleRefreshHardware() {
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await getHardware(true);
      setHardware(res);
      setSuccessMsg("Hardware re-probed successfully!");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRestoreDefaults() {
    if (!window.confirm("Restore all built-in default presets (YouTube/Web, Jellyfin Direct-Play, Plex Universal, Anime, Max Savings, 4K HDR)? Custom presets will be preserved.")) return;
    setError(null);
    try {
      const res = await restoreDefaultPresets();
      setPresets(res);
      setSuccessMsg("Default presets restored successfully!");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSavePreset(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPreset) return;

    setError(null);
    try {
      if (isNewPreset) {
        await createPreset(editingPreset);
        setSuccessMsg(`Preset "${editingPreset.name}" created.`);
      } else {
        await updatePreset(editingPreset.id, editingPreset);
        setSuccessMsg(`Preset "${editingPreset.name}" updated.`);
      }
      setEditingPreset(null);
      getPresets().then(setPresets);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDeletePreset(id: string) {
    if (!window.confirm("Are you sure you want to delete this preset?")) return;
    setError(null);
    try {
      await deletePreset(id);
      setSuccessMsg("Preset deleted.");
      getPresets().then(setPresets);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Hardware Acceleration & Presets</h1>
          <p className="page-subtitle">
            Inspect detected GPU hardware, benchmark video encoders, and configure optimization presets.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={handleRefreshHardware}>
            🔄 Re-probe Hardware
          </button>
          <button className="btn btn-secondary" onClick={handleRestoreDefaults} title="Restore all built-in standard presets">
            ✨ Restore Default Presets
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditingPreset({
                id: `preset-${Date.now().toString().slice(-4)}`,
                name: "Custom Preset",
                targetCodec: "hevc",
                targetContainer: "mkv",
                crf: 24,
                hwaccel: "auto",
                bitDepth: 10,
                preserveHdr: true,
                audioMode: "copy",
                subtitleMode: "copy",
                minSavingsPercent: 20,
                minFileSizeMb: 500,
                skipAlreadyTarget: true,
              });
              setIsNewPreset(true);
            }}
          >
            ➕ New Preset
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}

      {/* Hardware Acceleration Section */}
      <div className="card" style={{ marginBottom: "2rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>⚡ Detected GPU & Hardware Transcoders</h2>
            <div style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginTop: "0.2rem" }}>
              Shrinkarr probes OS devices and runs micro-benchmarks against available FFmpeg hardware encoders.
            </div>
          </div>
          {hardware && (
            <span className="badge badge-codec-hevc">
              {hardware.os}
            </span>
          )}
        </div>

        {hardware && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
              {hardware.gpus.map((gpu) => (
                <div
                  key={gpu.name}
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    padding: "1rem",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontSize: "0.8rem", color: "var(--accent-cyan)", fontWeight: 700, textTransform: "uppercase" }}>
                    {gpu.vendor.toUpperCase()} GPU
                  </div>
                  <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "#fff", marginTop: "0.2rem" }}>
                    {gpu.name}
                  </div>
                  {gpu.driverVersion && (
                    <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                      Driver: {gpu.driverVersion}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem", color: "var(--text-muted)" }}>
              Verified Encoder Modules
            </h3>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Encoder</th>
                    <th>Codec</th>
                    <th>Type</th>
                    <th>Description</th>
                    <th>Benchmark Status</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {hardware.encoders.map((enc) => {
                    const test = testResults[enc.id];
                    return (
                      <tr key={enc.id}>
                        <td>
                          <code style={{ fontWeight: 700, color: "#fff", fontSize: "0.95rem" }}>{enc.id}</code>
                        </td>
                        <td>
                          <span className={`badge ${enc.codec === "hevc" ? "badge-codec-hevc" : enc.codec === "av1" ? "badge-codec-av1" : "badge-codec-h264"}`}>
                            {enc.codec.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <span className="badge badge-res">
                            {enc.hwaccelType.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{enc.description}</td>
                        <td>
                          {test ? (
                            test.ok ? (
                              <span style={{ color: "var(--accent-emerald)", fontWeight: 600 }}>
                                ✓ Verified {test.speedMultiplier ? `(${test.speedMultiplier.toFixed(1)}x speed)` : ""}
                              </span>
                            ) : (
                              <span style={{ color: "var(--accent-rose)", fontWeight: 600 }}>✕ Failed</span>
                            )
                          ) : (
                            <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Ready</span>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={testingEncoder === enc.id}
                            onClick={() => handleTestEncoder(enc.id)}
                          >
                            {testingEncoder === enc.id ? "Benchmarking..." : "⚡ Test Encode"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Presets Section */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Conversion Presets</h2>
            <div style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>
              Define target codecs, quality factors, and threshold rules for each library.
            </div>
          </div>
        </div>

        <div className="grid-2">
          {presets.map((preset) => (
            <div key={preset.id} className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                  <div>
                    <h3 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#fff" }}>{preset.name}</h3>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", fontFamily: "monospace" }}>ID: {preset.id}</div>
                  </div>
                  <span className={`badge ${preset.targetCodec === "hevc" ? "badge-codec-hevc" : preset.targetCodec === "av1" ? "badge-codec-av1" : "badge-codec-h264"}`}>
                    {preset.targetCodec.toUpperCase()} • {preset.targetContainer.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", margin: "1rem 0", fontSize: "0.85rem" }}>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>CRF / Quality:</span>{" "}
                    <strong>{preset.crf}</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Hardware Mode:</span>{" "}
                    <strong>{preset.hwaccel.toUpperCase()}</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Bit Depth:</span>{" "}
                    <strong>{preset.bitDepth ?? 10}-bit</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Audio Mode:</span>{" "}
                    <strong>{preset.audioMode?.toUpperCase() ?? "COPY"}</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Min Savings:</span>{" "}
                    <strong>{preset.minSavingsPercent}%</strong>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Min File Size:</span>{" "}
                    <strong>{preset.minFileSizeMb ?? 500} MB</strong>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.5rem" }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setEditingPreset(preset);
                    setIsNewPreset(false);
                  }}
                >
                  ✏️ Edit Preset
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDeletePreset(preset.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Preset Edit Modal */}
      {editingPreset && (
        <div className="modal-overlay" onClick={() => setEditingPreset(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{isNewPreset ? "➕ New Preset" : "✏️ Edit Preset"}</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditingPreset(null)}>✕</button>
            </div>

            <form onSubmit={handleSavePreset}>
              <div className="form-group">
                <label className="form-label">Preset Name</label>
                <input
                  className="form-input"
                  value={editingPreset.name}
                  onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="form-group">
                  <label className="form-label">Target Codec</label>
                  <select
                    className="form-select"
                    value={editingPreset.targetCodec}
                    onChange={(e) => setEditingPreset({ ...editingPreset, targetCodec: e.target.value as "hevc" | "av1" | "h264" })}
                  >
                    <option value="hevc">HEVC (H.265)</option>
                    <option value="av1">AV1 (Next-Gen)</option>
                    <option value="h264">H.264 / AVC</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Hardware Acceleration</label>
                  <select
                    className="form-select"
                    value={editingPreset.hwaccel}
                    onChange={(e) => setEditingPreset({ ...editingPreset, hwaccel: e.target.value as HwAccelType })}
                  >
                    <option value="auto">Auto (Best Available Hardware)</option>
                    <option value="amf">AMD AMF</option>
                    <option value="qsv">Intel QuickSync (QSV)</option>
                    <option value="nvenc">NVIDIA NVENC</option>
                    <option value="vaapi">Linux VAAPI</option>
                    <option value="videotoolbox">Apple VideoToolbox</option>
                    <option value="cpu">Software / CPU Only</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="form-group">
                  <label className="form-label">Quality CRF / QP (0-51)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={editingPreset.crf}
                    min={0}
                    max={51}
                    onChange={(e) => setEditingPreset({ ...editingPreset, crf: Number(e.target.value) })}
                    required
                  />
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                    Lower = higher quality (20-24 recommended for HEVC, 26-28 for AV1)
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Bit Depth</label>
                  <select
                    className="form-select"
                    value={editingPreset.bitDepth ?? 10}
                    onChange={(e) => setEditingPreset({ ...editingPreset, bitDepth: Number(e.target.value) as 8 | 10 })}
                  >
                    <option value={10}>10-bit (Recommended for HDR/HEVC/AV1)</option>
                    <option value={8}>8-bit (Standard SDR)</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div className="form-group">
                  <label className="form-label">Audio Handling</label>
                  <select
                    className="form-select"
                    value={editingPreset.audioMode ?? "copy"}
                    onChange={(e) => setEditingPreset({ ...editingPreset, audioMode: e.target.value as "copy" | "aac" | "ac3" })}
                  >
                    <option value="copy">Copy Original Streams (Passthrough)</option>
                    <option value="aac">Re-encode to AAC Stereo/5.1 (Direct-play safe)</option>
                    <option value="ac3">Re-encode to AC3 (Surround compatible)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Minimum Savings Threshold (%)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={editingPreset.minSavingsPercent}
                    min={0}
                    max={100}
                    onChange={(e) => setEditingPreset({ ...editingPreset, minSavingsPercent: Number(e.target.value) })}
                    required
                  />
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                    Skip transcoding if projected savings are below this %
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingPreset(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Preset
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
