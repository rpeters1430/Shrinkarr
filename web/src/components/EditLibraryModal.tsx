import { useState } from "react";
import { updateLibrary, type Library, type Preset } from "../api/client";
import { DirectoryBrowserModal } from "./DirectoryBrowserModal";

interface Props {
  library: Library;
  presets: Preset[];
  onUpdated: (lib: Library) => void;
  onClose: () => void;
}

export function EditLibraryModal({ library, presets, onUpdated, onClose }: Props) {
  const [name, setName] = useState(library.name);
  const [path, setPath] = useState(library.path);
  const [mediaType, setMediaType] = useState<"movie" | "tv" | "youtube" | "web" | "other">(
    library.mediaType || "movie",
  );
  const [presetId, setPresetId] = useState(library.presetId || presets[0]?.id || "balanced");
  const [autoOptimize, setAutoOptimize] = useState(Boolean(library.autoOptimize));
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError("Name and Path are required");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updatedLib = await updateLibrary(library.id, {
        name: name.trim(),
        path: path.trim(),
        mediaType,
        presetId,
        autoOptimize,
      });
      onUpdated(updatedLib);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3 className="modal-title">✏️ Edit Library Folder</h3>
            <button className="btn btn-secondary btn-sm" onClick={onClose}>
              ✕
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Library Name</label>
              <input
                className="form-input"
                placeholder="e.g. Movies (NAS), TV Shows, YouTube Downloads"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Folder Path (NAS / Local Drive)</label>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  className="form-input"
                  style={{ fontFamily: "monospace" }}
                  placeholder="e.g. /media/movies or Z:\Movies"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowBrowser(true)}
                >
                  📁 Browse Drives
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group">
                <label className="form-label">Media Category</label>
                <select
                  className="form-select"
                  value={mediaType}
                  onChange={(e) =>
                    setMediaType(e.target.value as "movie" | "tv" | "youtube" | "web" | "other")
                  }
                >
                  <option value="movie">🎬 Movies</option>
                  <option value="tv">📺 TV Shows</option>
                  <option value="youtube">📹 YouTube / Web Videos</option>
                  <option value="other">📁 Other Videos</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Default Quality Preset</label>
                <select
                  className="form-select"
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.targetCodec.toUpperCase()} • CRF {p.crf})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Folder-level Auto Optimize Toggle */}
            <div className="form-group" style={{ marginTop: "0.5rem" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  cursor: "pointer",
                  padding: "0.75rem 1rem",
                  backgroundColor: "rgba(16, 185, 129, 0.08)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid rgba(16, 185, 129, 0.25)",
                }}
              >
                <input
                  type="checkbox"
                  style={{ width: "1.2rem", height: "1.2rem", accentColor: "var(--accent-emerald)" }}
                  checked={autoOptimize}
                  onChange={(e) => setAutoOptimize(e.target.checked)}
                />
                <div>
                  <strong style={{ color: "var(--accent-emerald)", fontSize: "0.92rem" }}>
                    ⚡ Auto-Optimize this Folder
                  </strong>
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    Automatically queue new eligible media files detected in this folder for transcode.
                  </div>
                </div>
              </label>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "0.75rem",
                marginTop: "1.5rem",
              }}
            >
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving Changes..." : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {showBrowser && (
        <DirectoryBrowserModal
          initialPath={path || undefined}
          onSelect={(selected) => setPath(selected)}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
