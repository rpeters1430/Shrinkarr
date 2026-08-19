import { useState } from "react";
import { postSimulate, type Preset, type SimulationResult } from "../api/client";

interface Props {
  filePath: string;
  presets: Preset[];
  defaultPresetId?: string;
  onClose: () => void;
  onQueueOptimized?: (filePath: string, presetId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function SimulatorModal({ filePath, presets, defaultPresetId, onClose, onQueueOptimized }: Props) {
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId || presets[0]?.id || "balanced");
  const [sampleSeconds, setSampleSeconds] = useState(30);
  const [simulating, setSimulating] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRunSimulation() {
    setSimulating(true);
    setError(null);
    setResult(null);
    try {
      const sim = await postSimulate(filePath, selectedPresetId, sampleSeconds);
      setResult(sim);
    } catch (err) {
      setError(String(err));
    } finally {
      setSimulating(false);
    }
  }

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">🧪 Savings Simulator</h3>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "0.2rem" }}>
              Sample & test-encode a 30s clip without touching the original file
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div style={{ marginBottom: "1.25rem", padding: "0.75rem 1rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Target Media</div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", wordBreak: "break-all", marginTop: "0.15rem" }}>{fileName}</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.25rem" }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Select Preset</label>
            <select
              className="form-select"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
              disabled={simulating}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.targetCodec.toUpperCase()})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Sample Duration</label>
            <select
              className="form-select"
              value={sampleSeconds}
              onChange={(e) => setSampleSeconds(Number(e.target.value))}
              disabled={simulating}
            >
              <option value={15}>15 seconds (fast test)</option>
              <option value={30}>30 seconds (recommended)</option>
              <option value={60}>60 seconds (high accuracy)</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            onClick={handleRunSimulation}
            disabled={simulating}
          >
            {simulating ? "⚡ Encoding sample & calculating savings..." : "Run Test Encode"}
          </button>
        </div>

        {result && (
          <div
            style={{
              backgroundColor: "rgba(16, 185, 129, 0.08)",
              border: "1px solid rgba(16, 185, 129, 0.25)",
              borderRadius: "var(--radius-md)",
              padding: "1.25rem",
              marginBottom: "1.25rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, color: "var(--accent-emerald)", fontSize: "1.1rem" }}>
                ✓ Test Encode Complete
              </span>
              <span className="badge badge-codec-hevc">
                Encoder: {result.encoderUsed}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
              <div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Current File Size</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>{formatBytes(result.originalSizeBytes)}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
                  {result.sourceCodec.toUpperCase()} • {result.sourceResolution}
                </div>
              </div>

              <div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Projected New Size</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--accent-emerald)" }}>
                  {formatBytes(result.estimatedNewSizeBytes)}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--accent-emerald)", fontWeight: 600 }}>
                  ~{result.measuredSavingsPercent}% Savings ({formatBytes(result.estimatedSavingsBytes)} saved)
                </div>
              </div>
            </div>

            <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "0.75rem" }}>
              ⏱️ Benchmark: Encoded {result.sampleDurationSeconds}s sample in {(result.durationMs / 1000).toFixed(1)}s
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {result && onQueueOptimized && (
            <button
              className="btn btn-emerald"
              onClick={() => {
                onQueueOptimized(filePath, selectedPresetId);
                onClose();
              }}
            >
              Queue Full Optimization Now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
