import { useEffect, useState } from "react";
import { updateLibrary, type Library, type Preset } from "../api/client";
import { DirectoryBrowserModal } from "./DirectoryBrowserModal";
import { IconEdit, IconClose, IconSearch } from "./Icons";

interface Props {
  library: Library;
  presets: Preset[];
  onUpdated: (lib: Library) => void;
  onClose: () => void;
}

export function EditLibraryModal({ library, presets, onUpdated, onClose }: Props) {
  const [name, setName] = useState(library.name);
  const [path, setPath] = useState(library.path);
  const [mediaType, setMediaType] = useState<"movie" | "tv" | "youtube" | "web" | "music" | "other">(
    library.mediaType || "movie",
  );
  const [presetId, setPresetId] = useState(library.presetId || presets[0]?.id || "balanced");
  const [minFileSizeMb, setMinFileSizeMb] = useState<number | "">(
    library.minFileSizeMb !== undefined ? library.minFileSizeMb : "",
  );
  const [autoOptimize, setAutoOptimize] = useState(Boolean(library.autoOptimize));
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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
        minFileSizeMb: minFileSizeMb === "" ? undefined : Number(minFileSizeMb),
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
            <h3 className="modal-title">
              <IconEdit size={16} /> Edit Library Folder
            </h3>
            <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close modal">
              <IconClose size={14} />
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
                  style={{ fontFamily: "ui-monospace, monospace" }}
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
                  <IconSearch size={14} />
                  <span>Browse</span>
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group">
                <label className="form-label">Media Type</label>
                <select
                  className="form-select"
                  value={mediaType}
                  onChange={(e) => setMediaType(e.target.value as "movie" | "tv" | "youtube" | "web" | "music" | "other")}
                >
                  <option value="movie">Movies</option>
                  <option value="tv">TV Shows</option>
                  <option value="youtube">YouTube / Web Videos</option>
                  <option value="music">Music</option>
                  <option value="other">Other Videos</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Default Encoding Preset</label>
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

            <div className="form-group">
              <label className="form-label">
                Minimum File Size to Optimize (MB){" "}
                <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>(Optional override)</span>
              </label>
              <input
                type="number"
                min="0"
                className="form-input"
                placeholder={
                  mediaType === "other" || mediaType === "youtube" || mediaType === "web"
                    ? "Leave blank for preset default (25 MB for web/other)"
                    : "Leave blank for preset default (500 MB for movies/TV)"
                }
                value={minFileSizeMb}
                onChange={(e) => setMinFileSizeMb(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>

            <div className="form-group" style={{ backgroundColor: "var(--bg-surface)", padding: "0.85rem 1rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  style={{ width: "1.2rem", height: "1.2rem", marginTop: "0.15rem", accentColor: "var(--accent-primary)" }}
                  checked={autoOptimize}
                  onChange={(e) => setAutoOptimize(e.target.checked)}
                />
                <div>
                  <div style={{ fontWeight: 600, color: "#fff", fontSize: "0.92rem" }}>
                    Auto-Optimize this Folder
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.15rem" }}>
                    Automatically queue newly discovered videos in this folder for background optimization.
                  </div>
                </div>
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {showBrowser && (
        <DirectoryBrowserModal
          initialPath={path}
          onSelect={(selectedPath) => {
            setPath(selectedPath);
            setShowBrowser(false);
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
