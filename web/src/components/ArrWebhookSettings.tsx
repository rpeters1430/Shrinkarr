import { useEffect, useState } from "react";
import { getArrWebhookInfo, type Config } from "../api/client";

interface Props {
  config: Config;
  setConfig: (config: Config) => void;
}

export default function ArrWebhookSettings({ config, setConfig }: Props) {
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mappings = config.webhooks?.pathMappings ?? [];

  useEffect(() => {
    getArrWebhookInfo()
      .then((info) => setWebhookUrl(`${window.location.origin}${info.path}`))
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  function setMappings(next: Array<{ from: string; to: string }>) {
    setConfig({ ...config, webhooks: { ...config.webhooks, pathMappings: next } });
  }

  async function copyUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs HTTPS or localhost; the field stays selectable.
    }
  }

  return (
    <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
      <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: "0.25rem" }}>Import Webhook</div>
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "1rem" }}>
        Sonarr and Radarr call this URL after each import, so Shrinkarr picks up new files even on network shares that never report changes.
        In each app, go to Settings → Connect → Webhook, paste the URL, and turn on On Import, On Upgrade, On Rename and On File Delete.
      </p>

      <div className="form-group">
        <label className="form-label" htmlFor="arr-webhook-url">Webhook URL</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="arr-webhook-url"
            className="form-input"
            readOnly
            value={webhookUrl ?? (loadError ? "" : "Loading…")}
            onFocus={(e) => e.target.select()}
            style={{ flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: "0.8rem" }}
          />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!webhookUrl} onClick={copyUrl}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {loadError && (
          <div style={{ fontSize: "0.75rem", color: "var(--accent-rose)", marginTop: "0.2rem" }}>
            Could not load the webhook URL: {loadError}
          </div>
        )}
        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
          The token in the URL only allows calling this webhook. If Sonarr or Radarr reach Shrinkarr by another address, keep the path and token and change the host.
        </div>
      </div>

      <div className="form-group" style={{ margin: 0 }}>
        <label className="form-label">Path Mappings</label>
        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: "0.5rem" }}>
          Only needed when Sonarr or Radarr see your media at a different path than Shrinkarr, such as /tv in their container and /media/tv here.
        </div>
        {mappings.map((mapping, index) => (
          <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="form-input"
              aria-label="Path in Sonarr or Radarr"
              placeholder="/tv"
              value={mapping.from}
              onChange={(e) => setMappings(mappings.map((m, i) => (i === index ? { ...m, from: e.target.value } : m)))}
              style={{ flex: "1 1 10rem", minWidth: 0 }}
            />
            <span style={{ color: "var(--text-dim)" }}>→</span>
            <input
              className="form-input"
              aria-label="Path in Shrinkarr"
              placeholder="/media/tv"
              value={mapping.to}
              onChange={(e) => setMappings(mappings.map((m, i) => (i === index ? { ...m, to: e.target.value } : m)))}
              style={{ flex: "1 1 10rem", minWidth: 0 }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setMappings(mappings.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMappings([...mappings, { from: "", to: "" }])}>
          Add Mapping
        </button>
      </div>
    </div>
  );
}
