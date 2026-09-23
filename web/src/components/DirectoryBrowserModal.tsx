import { useEffect, useState } from "react";
import { browsePath, type BrowseResult } from "../api/client";
import { IconFolder, IconHardDrive, IconClose } from "./Icons";

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function DirectoryBrowserModal({ initialPath, onSelect, onClose }: Props) {
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [manualInput, setManualInput] = useState(initialPath || "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function loadDir(path?: string) {
    setLoading(true);
    setError(null);
    browsePath(path)
      .then((res) => {
        setBrowseData(res);
        setManualInput(res.currentPath);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    browsePath(initialPath)
      .then((res) => {
        if (!cancelled) {
          setBrowseData(res);
          setManualInput(res.currentPath);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialPath]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "700px" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">
              <IconFolder size={18} color="var(--accent-primary)" /> Choose Media Library Folder
            </h3>
            <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
              Select your local drive, NAS mapped drive, or network share
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close browser">
            <IconClose size={14} />
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Available Drives Switcher Bar */}
        {browseData?.availableDrives && browseData.availableDrives.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "0.4rem", fontWeight: 600 }}>
              Available Drives & Storage
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {browseData.availableDrives.map((d) => {
                const isActive = browseData.currentPath.toLowerCase().startsWith(d.path.toLowerCase());
                return (
                  <button
                    key={d.path}
                    type="button"
                    className={`btn btn-sm ${isActive ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => loadDir(d.path)}
                    style={{ fontSize: "0.85rem" }}
                  >
                    <IconHardDrive size={13} /> {d.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Suggested Media Folders */}
        {browseData?.suggestedMediaFolders && browseData.suggestedMediaFolders.length > 0 && (
          <div style={{ marginBottom: "1.25rem", padding: "0.75rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.78rem", color: "var(--accent-primary)", fontWeight: 700, textTransform: "uppercase", marginBottom: "0.4rem" }}>
              Detected Media Folders (Quick Jump)
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
              {browseData.suggestedMediaFolders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: "0.82rem", fontFamily: "ui-monospace, monospace" }}
                  onClick={() => loadDir(folder)}
                >
                  <IconFolder size={12} /> {folder}
                </button>
              ))}
            </div>
          </div>
        )}

        {browseData && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
              <input
                className="form-input"
                style={{ fontFamily: "ui-monospace, monospace" }}
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    loadDir(manualInput);
                  }
                }}
              />
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => loadDir(manualInput)}
                title="Go to entered path"
              >
                Go
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => loadDir(browseData.parentPath)}
                title="Go up one level"
                disabled={browseData.currentPath === browseData.parentPath}
              >
                Up
              </button>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                maxHeight: "260px",
                overflowY: "auto",
                backgroundColor: "var(--bg-surface)",
              }}
            >
              {loading && <div style={{ padding: "1rem", color: "var(--text-muted)" }}>Loading folder contents...</div>}
              {!loading && browseData.directories.length === 0 && (
                <div style={{ padding: "1.25rem", color: "var(--text-dim)", textAlign: "center" }}>
                  No subdirectories inside this folder.
                </div>
              )}
              {!loading &&
                browseData.directories.map((dir) => (
                  <div
                    key={dir.path}
                    style={{
                      padding: "0.65rem 1rem",
                      borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      fontSize: "0.92rem",
                    }}
                    onClick={() => loadDir(dir.path)}
                  >
                    <IconFolder size={15} color="var(--accent-primary)" />
                    <span style={{ fontWeight: 600, color: "#fff" }}>{dir.name}</span>
                    <span style={{ color: "var(--text-dim)", fontSize: "0.78rem", marginLeft: "auto", fontFamily: "ui-monospace, monospace" }}>
                      {dir.path}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1.25rem" }}>
          <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
            Selected: <code style={{ color: "var(--accent-primary)" }}>{browseData?.currentPath}</code>
          </div>

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!browseData}
              onClick={() => {
                if (browseData) {
                  onSelect(browseData.currentPath);
                  onClose();
                }
              }}
            >
              Select This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
