import { useEffect, useState } from "react";
import { createLibrary, browsePath, type Library, type Preset } from "../api/client";
import { DirectoryBrowserModal } from "./DirectoryBrowserModal";

interface Props {
  presets: Preset[];
  onAdded: (lib: Library) => void;
  onClose: () => void;
}

export function AddLibraryModal({ presets, onAdded, onClose }: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [mediaType, setMediaType] = useState<"movie" | "tv" | "youtube" | "web" | "other">("movie");
  const [presetId, setPresetId] = useState(presets[0]?.id || "balanced");
  const [suggestedFolders, setSuggestedFolders] = useState<string[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    browsePath()
      .then((res) => {
        if (res.suggestedMediaFolders && res.suggestedMediaFolders.length > 0) {
          setSuggestedFolders(res.suggestedMediaFolders);
        }
      })
      .catch(() => {});
  }, []);

  function handlePickSuggestion(folderPath: string) {
    setPath(folderPath);
    const lower = folderPath.toLowerCase();
    if (lower.includes("youtube") || lower.includes("yt") || lower.includes("clip")) {
      setName("YouTube Videos");
      setMediaType("youtube");
      const ytPreset = presets.find((p) => p.id === "web-youtube" || p.id === "max-savings");
      if (ytPreset) setPresetId(ytPreset.id);
    } else if (lower.includes("movie")) {
      setName("Movies (NAS)");
      setMediaType("movie");
    } else if (lower.includes("tv") || lower.includes("show")) {
      setName("TV Shows (NAS)");
      setMediaType("tv");
    } else {
      const folderName = folderPath.split(/[/\\]/).filter(Boolean).pop() || "Media";
      setName(folderName);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !path.trim()) {
      setError("Name and Path are required");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
      const newLib = await createLibrary({
        id: `${id}-${Date.now().toString().slice(-4)}`,
        name: name.trim(),
        path: path.trim(),
        mediaType,
        presetId,
      });
      onAdded(newLib);
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
            <h3 className="modal-title">➕ Add Media Library</h3>
            <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          {/* Quick-Pick NAS Folders */}
          {suggestedFolders.length > 0 && (
            <div style={{ marginBottom: "1.25rem", padding: "0.85rem 1rem", backgroundColor: "rgba(99, 102, 241, 0.08)", borderRadius: "var(--radius-md)", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
              <div style={{ fontSize: "0.8rem", color: "#818cf8", fontWeight: 700, textTransform: "uppercase", marginBottom: "0.4rem" }}>
                💾 Detected NAS & Media Folders (Click to Auto-fill)
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {suggestedFolders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: "0.82rem", fontFamily: "monospace" }}
                    onClick={() => handlePickSuggestion(folder)}
                  >
                    📁 {folder}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                  placeholder="e.g. Z:\Movies or Z:\youtube or C:\Downloads\YouTube"
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
                  onChange={(e) => setMediaType(e.target.value as any)}
                >
                  <option value="movie">🎬 Movies</option>
                  <option value="tv">📺 TV Shows</option>
                  <option value="youtube">📹 YouTube / Web Videos</option>
                  <option value="other">📁 Other Videos</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Default Preset</label>
                <select
                  className="form-select"
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Adding Library..." : "Add Library"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {showBrowser && (
        <DirectoryBrowserModal
          initialPath={path || undefined}
          onSelect={(selected) => handlePickSuggestion(selected)}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}
