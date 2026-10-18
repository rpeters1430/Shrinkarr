import { useState } from "react";
import { testNotifications, type Config, type NotificationsConfig } from "../api/client";

interface Props {
  config: Config;
  setConfig: (config: Config) => void;
}

const DEFAULTS: NotificationsConfig = { onJobDone: false, onJobFailed: true, onQueueEmpty: true };

const EVENTS: Array<{ key: "onJobFailed" | "onQueueEmpty" | "onJobDone"; label: string; hint: string }> = [
  { key: "onJobFailed", label: "A job fails", hint: "Includes the file name and the error." },
  { key: "onQueueEmpty", label: "The queue runs out of work", hint: "One summary: jobs finished, jobs failed, space saved." },
  { key: "onJobDone", label: "Each job finishes", hint: "One message per file. Noisy on a large backlog." },
];

const hintStyle = { fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" };

export default function NotificationSettings({ config, setConfig }: Props) {
  const settings = { ...DEFAULTS, ...config.notifications };
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  function update(patch: Partial<NotificationsConfig>) {
    setConfig({ ...config, notifications: { ...settings, ...patch } });
    setTestResult(null);
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testNotifications(settings);
      setTestResult(res.ok
        ? { ok: true, text: "Sent. Check that it arrived." }
        : { ok: false, text: res.errors.join("; ") });
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const hasTarget = Boolean(settings.discordWebhookUrl?.trim() || settings.ntfyUrl?.trim() || settings.webhookUrl?.trim());

  return (
    <div className="card" style={{ marginBottom: "1.75rem" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Notifications</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
        Get a message when jobs fail or the queue finishes. Fill in any of the targets below; leave the rest blank.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1.25rem" }}>
        <div className="form-group">
          <label className="form-label" htmlFor="notify-discord">Discord Webhook URL</label>
          <input
            id="notify-discord"
            type="password"
            className="form-input"
            placeholder="https://discord.com/api/webhooks/…"
            value={settings.discordWebhookUrl ?? ""}
            onChange={(e) => update({ discordWebhookUrl: e.target.value })}
          />
          <div style={hintStyle}>In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL.</div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="notify-ntfy">ntfy Topic URL</label>
          <input
            id="notify-ntfy"
            className="form-input"
            placeholder="https://ntfy.sh/your-topic"
            value={settings.ntfyUrl ?? ""}
            onChange={(e) => update({ ntfyUrl: e.target.value })}
          />
          <div style={hintStyle}>Works with ntfy.sh or your own ntfy server.</div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="notify-ntfy-token">ntfy Access Token</label>
          <input
            id="notify-ntfy-token"
            type="password"
            className="form-input"
            placeholder="Optional"
            value={settings.ntfyToken ?? ""}
            onChange={(e) => update({ ntfyToken: e.target.value })}
          />
          <div style={hintStyle}>Only needed when the topic requires a login.</div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="notify-webhook">Generic Webhook URL</label>
          <input
            id="notify-webhook"
            className="form-input"
            placeholder="https://example.com/hook"
            value={settings.webhookUrl ?? ""}
            onChange={(e) => update({ webhookUrl: e.target.value })}
          />
          <div style={hintStyle}>Receives a JSON POST with event, title, message and the job record. Use it for Home Assistant, Gotify bridges or scripts.</div>
        </div>
      </div>

      <div className="form-label" style={{ marginTop: "0.5rem", marginBottom: "0.75rem" }}>Send a message when</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", marginBottom: "1.25rem" }}>
        {EVENTS.map(({ key, label, hint }) => (
          <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              style={{ width: "1.2rem", height: "1.2rem", accentColor: "var(--accent-primary)", flexShrink: 0 }}
              checked={settings[key]}
              onChange={(e) => update({ [key]: e.target.checked })}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span style={{ display: "block", fontSize: "0.8rem", color: "var(--text-dim)" }}>{hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!hasTarget || testing} onClick={sendTest}>
          {testing ? "Sending…" : "Send Test"}
        </button>
        {testResult && (
          <span style={{ fontSize: "0.85rem", color: testResult.ok ? "var(--accent-emerald)" : "var(--accent-rose)", overflowWrap: "anywhere" }}>
            {testResult.text}
          </span>
        )}
      </div>
    </div>
  );
}
