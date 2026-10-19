import { useEffect, useState } from "react";
import { IconClose } from "./Icons";

interface LogModalProps {
  title: string;
  subtitle?: string;
  load: () => Promise<{ log: string }>;
  onClose: () => void;
}

export function LogModal({ title, subtitle, load, onClose }: LogModalProps) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then((res) => setLog(res.log))
      .catch((err) => setError(String(err)));
    // Loaded once per open; `load` is a fresh closure on every parent render.
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "960px" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 className="modal-title">{title}</h3>
            {subtitle && (
              <div className="video-path" style={{ marginTop: "0.2rem" }} title={subtitle}>
                {subtitle}
              </div>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close log">
            <IconClose size={14} />
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {log === null && !error && <div style={{ color: "var(--text-muted)" }}>Loading log...</div>}
        {log !== null && (
          <pre className="log-view">{log.trim() ? log : "No log was recorded for this job."}</pre>
        )}
      </div>
    </div>
  );
}
