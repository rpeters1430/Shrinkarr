import { useEffect, useState } from "react";
import { getConfig, putConfig, getQueueStatus, testIntegration, updateAccount, type Config, type QueueStatus } from "../api/client";
import { IconCalendar, IconCheck, IconClose, IconShield } from "../components/Icons";

const WEEK_DAYS = [
  { day: 0, short: "Sun", label: "Sunday" },
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
];

type ScheduleWindow = { id?: string; day: number; enabled: boolean; start: string; end: string };

// Matches the per-day cap enforced by ScheduleWindowSchema on the server.
const MAX_WINDOWS_PER_DAY = 8;

function makeWindowId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Legacy configs (and the very first window created for a day) may not carry an id yet.
function withWindowIds(windows: ScheduleWindow[]): ScheduleWindow[] {
  return windows.map((window) => (window.id ? window : { ...window, id: makeWindowId() }));
}

const DEFAULT_WEEKLY_WINDOWS = withWindowIds(WEEK_DAYS.map(({ day }) => ({
  day,
  enabled: day >= 1 && day <= 5,
  start: "07:30",
  end: "17:00",
})));

// A legacy config (saved before weekly windows existed) enforces `startHour`/
// `endHour` every day of the week, with no per-day distinction. Migrating it
// to an equivalent `windows` array must reproduce that exact behavior — every
// day enabled with the same start/end — rather than some unrelated default,
// or turning on the weekly schedule UI would silently change *when*
// processing is allowed the next time anything on this page gets saved.
function legacyHoursToWindows(startHour: number, endHour: number): ScheduleWindow[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = `${pad(startHour)}:00`;
  const end = `${pad(endHour)}:00`;
  return withWindowIds(WEEK_DAYS.map(({ day }) => ({ day, enabled: true, start, end })));
}

export function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [testingService, setTestingService] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message?: string; error?: string } | undefined>>({});
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [accountForm, setAccountForm] = useState({ currentPassword: "", newUsername: "", newPassword: "", confirmPassword: "" });
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountSaved, setAccountSaved] = useState(false);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        const schedule = cfg.queue?.schedule;
        const windows = schedule?.windows;
        if (windows === undefined) {
          // A legacy config saved before weekly windows existed has no `windows`
          // array; the day/time grid would otherwise fall back to unrelated
          // defaults purely for display. Materialize the equivalent of the
          // existing startHour/endHour enforcement into real windows instead,
          // so what's shown (and what Save persists) matches what's already
          // actually running rather than silently changing it.
          const startHour = schedule?.startHour ?? 1;
          const endHour = schedule?.endHour ?? 7;
          setConfig({
            ...cfg,
            queue: {
              ...cfg.queue,
              schedule: {
                enabled: false,
                startHour,
                endHour,
                stopActiveOnExit: true,
                ...(schedule || {}),
                windows: legacyHoursToWindows(startHour, endHour),
              },
            },
          });
          return;
        }
        if (!windows.length) {
          setConfig(cfg);
          return;
        }
        setConfig({
          ...cfg,
          queue: { ...cfg.queue, schedule: { ...schedule!, windows: withWindowIds(windows) } },
        });
      })
      .catch((err) => setError(String(err)));
    getQueueStatus()
      .then(setQueueStatus)
      .catch(() => {});
  }, []);

  if (!config) {
    return <div className="main-content">{error ?? "Loading settings..."}</div>;
  }

  async function handleTestService(service: "jellyfin" | "emby" | "plex" | "sonarr" | "radarr") {
    if (!config) return;
    setTestingService(service);
    setError(null);
    setTestResults((prev) => ({ ...prev, [service]: undefined }));

    const integration = config.integrations[service] as { url?: string; apiKey?: string; token?: string } | undefined;
    if (!integration?.url) {
      setTestResults((prev) => ({ ...prev, [service]: { success: false, error: "Please enter a server URL first." } }));
      setTestingService(null);
      return;
    }

    const key = (service === "plex" ? integration.token : integration.apiKey) || "";
    try {
      const res = await testIntegration(service, integration.url, key);
      setTestResults((prev) => ({ ...prev, [service]: res }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [service]: { success: false, error: String(err) } }));
    } finally {
      setTestingService(null);
    }
  }

  async function handleAccountSave(e: React.FormEvent) {
    e.preventDefault();
    setAccountError(null);
    setAccountSaved(false);

    if (!accountForm.currentPassword) {
      setAccountError("Enter your current password to confirm changes.");
      return;
    }
    if (!accountForm.newUsername.trim() && !accountForm.newPassword) {
      setAccountError("Enter a new username or new password.");
      return;
    }
    if (accountForm.newPassword && accountForm.newPassword !== accountForm.confirmPassword) {
      setAccountError("New password and confirmation do not match.");
      return;
    }

    setAccountSaving(true);
    try {
      const updated = await updateAccount({
        currentPassword: accountForm.currentPassword,
        newUsername: accountForm.newUsername.trim() || undefined,
        newPassword: accountForm.newPassword || undefined,
      });
      setConfig((prev) => (prev ? { ...prev, auth: { username: updated.username } } : prev));
      setAccountForm({ currentPassword: "", newUsername: "", newPassword: "", confirmPassword: "" });
      setAccountSaved(true);
      setTimeout(() => setAccountSaved(false), 3000);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountSaving(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!config) return;

    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await putConfig(config);
      setConfig(updated);
      setSaved(true);
      getQueueStatus().then(setQueueStatus).catch(() => {});
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Application Settings</h1>
          <p className="page-subtitle">
            Configure automated library watchers, media server webhooks (Jellyfin, Emby, Plex, Sonarr, Radarr), and safety limits.
          </p>
        </div>
      </div>

      {/* Account Card */}
      <div className="card" style={{ marginBottom: "1.75rem" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
          Account Credentials
        </h2>
        <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
          Signed in as <strong>{config.auth?.username ?? "admin"}</strong>. Change your username or password below.
        </p>

        {accountError && <div className="alert alert-error">{accountError}</div>}
        {accountSaved && <div className="alert alert-success">Account updated successfully!</div>}

        <form onSubmit={handleAccountSave} style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" htmlFor="account-current-password">Current Password</label>
            <input
              id="account-current-password"
              type="password"
              className="form-input"
              autoComplete="current-password"
              placeholder="Required to confirm changes"
              value={accountForm.currentPassword}
              onChange={(e) => setAccountForm({ ...accountForm, currentPassword: e.target.value })}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="account-new-username">New Username (Optional)</label>
              <input
                id="account-new-username"
                className="form-input"
                autoComplete="username"
                placeholder={config.auth?.username ?? "admin"}
                value={accountForm.newUsername}
                onChange={(e) => setAccountForm({ ...accountForm, newUsername: e.target.value })}
              />
            </div>
            <div />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="account-new-password">New Password (Optional)</label>
              <input
                id="account-new-password"
                type="password"
                className="form-input"
                autoComplete="new-password"
                placeholder="Leave blank to keep current password"
                value={accountForm.newPassword}
                onChange={(e) => setAccountForm({ ...accountForm, newPassword: e.target.value })}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="account-confirm-password">Confirm New Password</label>
              <input
                id="account-confirm-password"
                type="password"
                className="form-input"
                autoComplete="new-password"
                placeholder="Repeat new password"
                value={accountForm.confirmPassword}
                onChange={(e) => setAccountForm({ ...accountForm, confirmPassword: e.target.value })}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="btn btn-primary" disabled={accountSaving}>
              {accountSaving ? "Saving..." : "Update Account"}
            </button>
          </div>
        </form>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {saved && <div className="alert alert-success">Settings saved successfully!</div>}

      <form onSubmit={handleSave}>
        {/* Automated Library Watcher & Scheduler Card */}
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            Automated Library Watcher & Scheduler
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Automatically detect newly downloaded or copied videos from Radarr, Sonarr, or yt-dlp, and optionally auto-queue them for optimization.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.75rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                style={{ width: "1.2rem", height: "1.2rem", accentColor: "var(--accent-primary)" }}
                checked={config.watcher?.enabled ?? true}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    watcher: {
                      enabled: e.target.checked,
                      intervalMinutes: config.watcher?.intervalMinutes ?? 15,
                      autoOptimize: config.watcher?.autoOptimize ?? false,
                      settleDelaySeconds: config.watcher?.settleDelaySeconds ?? 15,
                    },
                  })
                }
              />
              <div>
                <strong style={{ color: "#fff", fontSize: "0.95rem" }}>Enable Automated Background Watcher</strong>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Periodically sweeps all configured library directories to index newly added videos.
                </div>
              </div>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Sweep Schedule / Polling Frequency</label>
                <select
                  className="form-select"
                  value={config.watcher?.intervalMinutes ?? 15}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      watcher: {
                        enabled: config.watcher?.enabled ?? true,
                        intervalMinutes: Number(e.target.value),
                        autoOptimize: config.watcher?.autoOptimize ?? false,
                        settleDelaySeconds: config.watcher?.settleDelaySeconds ?? 15,
                      },
                    })
                  }
                >
                  <option value={5}>Every 5 Minutes (Fastest)</option>
                  <option value={15}>Every 15 Minutes (Recommended)</option>
                  <option value={30}>Every 30 Minutes</option>
                  <option value={60}>Every 1 Hour</option>
                  <option value={360}>Every 6 Hours</option>
                  <option value={1440}>Every 24 Hours</option>
                </select>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Write Settle Delay (Seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={600}
                  className="form-input"
                  value={config.watcher?.settleDelaySeconds ?? 15}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      watcher: {
                        enabled: config.watcher?.enabled ?? true,
                        intervalMinutes: config.watcher?.intervalMinutes ?? 15,
                        autoOptimize: config.watcher?.autoOptimize ?? false,
                        settleDelaySeconds: Number(e.target.value),
                      },
                    })
                  }
                />
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                  Waits until a file stops growing for this duration before probing (prevents probing mid-download)
                </div>
              </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "0.75rem", cursor: "pointer", padding: "0.75rem 1rem", backgroundColor: "rgba(16, 185, 129, 0.08)", borderRadius: "var(--radius-md)", border: "1px solid rgba(16, 185, 129, 0.25)" }}>
              <input
                type="checkbox"
                style={{ width: "1.2rem", height: "1.2rem", accentColor: "var(--accent-emerald)" }}
                checked={config.watcher?.autoOptimize ?? false}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    watcher: {
                      enabled: config.watcher?.enabled ?? true,
                      intervalMinutes: config.watcher?.intervalMinutes ?? 15,
                      autoOptimize: e.target.checked,
                      settleDelaySeconds: config.watcher?.settleDelaySeconds ?? 15,
                    },
                  })
                }
              />
              <div>
                <strong style={{ color: "var(--accent-emerald)", fontSize: "0.95rem" }}>Auto-Optimize Eligible New Videos</strong>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  When newly added media files meet your compression savings threshold, immediately add them to the transcode queue in the background.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Media Integrations Card */}
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            Media Server & *Arr Integrations
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Shrinkarr notifies your media stack immediately after a transcode finishes so your libraries stay synced without manual rescanning.
          </p>

          {/* Jellyfin */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>Jellyfin</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "jellyfin"}
                onClick={() => handleTestService("jellyfin")}
              >
                {testingService === "jellyfin" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testResults.jellyfin && (
              <div className={`alert ${testResults.jellyfin.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {testResults.jellyfin.success && <IconCheck size={14} />}
                <span>{testResults.jellyfin.success ? (testResults.jellyfin.message || "Connected to Jellyfin successfully.") : testResults.jellyfin.error}</span>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Server URL</label>
                <input
                  className="form-input"
                  placeholder="http://jellyfin:8096"
                  value={config.integrations.jellyfin?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        jellyfin: { url: e.target.value, apiKey: config.integrations.jellyfin?.apiKey ?? "" },
                      },
                    })
                  }
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">API Key</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Jellyfin API Key"
                  value={config.integrations.jellyfin?.apiKey ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        jellyfin: { url: config.integrations.jellyfin?.url ?? "", apiKey: e.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          {/* Emby */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>Emby</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "emby"}
                onClick={() => handleTestService("emby")}
              >
                {testingService === "emby" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testResults.emby && (
              <div className={`alert ${testResults.emby.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {testResults.emby.success && <IconCheck size={14} />}
                <span>{testResults.emby.success ? (testResults.emby.message || "Connected to Emby successfully.") : testResults.emby.error}</span>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Server URL</label>
                <input
                  className="form-input"
                  placeholder="http://emby:8096"
                  value={config.integrations.emby?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        emby: { url: e.target.value, apiKey: config.integrations.emby?.apiKey ?? "" },
                      },
                    })
                  }
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">API Key</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Emby API Key"
                  value={config.integrations.emby?.apiKey ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        emby: { url: config.integrations.emby?.url ?? "", apiKey: e.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          {/* Plex */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>Plex</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "plex"}
                onClick={() => handleTestService("plex")}
              >
                {testingService === "plex" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testResults.plex && (
              <div className={`alert ${testResults.plex.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {testResults.plex.success && <IconCheck size={14} />}
                <span>{testResults.plex.success ? (testResults.plex.message || "Connected to Plex successfully.") : testResults.plex.error}</span>
              </div>
            )}


            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Server URL</label>
                <input
                  className="form-input"
                  placeholder="http://plex:32400"
                  value={config.integrations.plex?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        plex: {
                          url: e.target.value,
                          token: config.integrations.plex?.token ?? "",
                          sectionId: config.integrations.plex?.sectionId,
                        },
                      },
                    })
                  }
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Plex Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Plex Token"
                  value={config.integrations.plex?.token ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        plex: {
                          url: config.integrations.plex?.url ?? "",
                          token: e.target.value,
                          sectionId: config.integrations.plex?.sectionId,
                        },
                      },
                    })
                  }
                />
              </div>
            </div>
            <div className="form-group" style={{ margin: "1rem 0 0" }}>
              <label className="form-label">Library Section ID (Optional)</label>
              <input
                className="form-input"
                placeholder="e.g. 1"
                value={config.integrations.plex?.sectionId ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    integrations: {
                      ...config.integrations,
                      plex: {
                        url: config.integrations.plex?.url ?? "",
                        token: config.integrations.plex?.token ?? "",
                        sectionId: e.target.value || undefined,
                      },
                    },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Restricts the post-transcode refresh notification to a single Plex library section.
              </div>
            </div>
          </div>

          {/* Sonarr */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>Sonarr (TV Shows)</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "sonarr"}
                onClick={() => handleTestService("sonarr")}
              >
                {testingService === "sonarr" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testResults.sonarr && (
              <div className={`alert ${testResults.sonarr.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {testResults.sonarr.success && <IconCheck size={14} />}
                <span>{testResults.sonarr.success ? (testResults.sonarr.message || "Connected to Sonarr successfully.") : testResults.sonarr.error}</span>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Server URL</label>
                <input
                  className="form-input"
                  placeholder="http://sonarr:8989"
                  value={config.integrations.sonarr?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        sonarr: { url: e.target.value, apiKey: config.integrations.sonarr?.apiKey ?? "" },
                      },
                    })
                  }
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">API Key</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Sonarr API Key"
                  value={config.integrations.sonarr?.apiKey ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        sonarr: { url: config.integrations.sonarr?.url ?? "", apiKey: e.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          {/* Radarr */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>Radarr (Movies)</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "radarr"}
                onClick={() => handleTestService("radarr")}
              >
                {testingService === "radarr" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testResults.radarr && (
              <div className={`alert ${testResults.radarr.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {testResults.radarr.success && <IconCheck size={14} />}
                <span>{testResults.radarr.success ? (testResults.radarr.message || "Connected to Radarr successfully.") : testResults.radarr.error}</span>
              </div>
            )}


            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Server URL</label>
                <input
                  className="form-input"
                  placeholder="http://radarr:7878"
                  value={config.integrations.radarr?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        radarr: { url: e.target.value, apiKey: config.integrations.radarr?.apiKey ?? "" },
                      },
                    })
                  }
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">API Key</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Radarr API Key"
                  value={config.integrations.radarr?.apiKey ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      integrations: {
                        ...config.integrations,
                        radarr: { url: config.integrations.radarr?.url ?? "", apiKey: e.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        </div>

        {/* File Locking & Timing Protection Card */}
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            File Locking & Timing Protection
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Eliminates errors caused by locked or in-use files from active Plex/Jellyfin playback, Sonarr/Radarr imports, torrent downloads, or Windows Explorer locks.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.25rem" }}>
            <div className="form-group">
              <label className="form-label">Lock Retry Attempts</label>
              <input
                type="number"
                min={1}
                max={20}
                className="form-input"
                value={config.queue.fileLockRetryAttempts ?? 6}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    queue: { ...config.queue, fileLockRetryAttempts: Number(e.target.value) },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Number of retry attempts if a file is held locked during transcode replacement
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Retry Delay Interval (Seconds)</label>
              <input
                type="number"
                min={1}
                max={60}
                className="form-input"
                value={config.queue.fileLockRetryDelaySeconds ?? 5}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    queue: { ...config.queue, fileLockRetryDelaySeconds: Number(e.target.value) },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Base wait time between retries (uses progressive backoff)
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">File Stability Settle Time (Seconds)</label>
              <input
                type="number"
                min={2}
                max={300}
                className="form-input"
                value={config.queue.fileStabilityDelaySeconds ?? 15}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    queue: { ...config.queue, fileStabilityDelaySeconds: Number(e.target.value) },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Duration a file must stay unchanged to confirm writing is finished before transcode begins
              </div>
            </div>
          </div>
        </div>

        {/* Weekly Processing Schedule Card */}
        <div className="card schedule-card" style={{ marginBottom: "1.75rem" }}>
          <div className="schedule-heading">
            <div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <IconCalendar size={18} /> Weekly Processing Schedule
              </h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>
                Choose exactly when Shrinkarr may transcode. Each day can have its own active window, including overnight periods.
              </p>
            </div>
            {queueStatus?.schedule && (
              <span className={`schedule-status ${!config.queue.schedule?.enabled ? "off" : queueStatus.schedule.isWithinSchedule ? "active" : "waiting"}`}>
                {!config.queue.schedule?.enabled
                  ? "Schedule off · runs 24/7"
                  : queueStatus.schedule.isWithinSchedule
                  ? "● Processing allowed now"
                  : "● Waiting for next window"}
              </span>
            )}
          </div>

          <label className="schedule-master-toggle">
            <input
              type="checkbox"
              checked={config.queue.schedule?.enabled ?? false}
              onChange={(e) => setConfig({
                ...config,
                queue: {
                  ...config.queue,
                  schedule: {
                    enabled: e.target.checked,
                    startHour: config.queue.schedule?.startHour ?? 1,
                    endHour: config.queue.schedule?.endHour ?? 7,
                    windows: config.queue.schedule?.windows ?? DEFAULT_WEEKLY_WINDOWS,
                    timezone: config.queue.schedule?.timezone ?? "auto",
                    stopActiveOnExit: config.queue.schedule?.stopActiveOnExit ?? true,
                  },
                },
              })}
            />
            <div>
              <strong>Use weekly schedule</strong>
              <span>When disabled, queued work can run at any time.</span>
            </div>
          </label>

          <div className="weekly-schedule" aria-label="Weekly processing windows">
            {(() => {
              const scheduleEnabled = config.queue.schedule?.enabled ?? false;
              const allWindows = config.queue.schedule?.windows ?? DEFAULT_WEEKLY_WINDOWS;

              const commitWindows = (nextWindows: ScheduleWindow[]) => {
                setConfig({
                  ...config,
                  queue: {
                    ...config.queue,
                    schedule: {
                      enabled: scheduleEnabled,
                      startHour: config.queue.schedule?.startHour ?? 1,
                      endHour: config.queue.schedule?.endHour ?? 7,
                      windows: nextWindows,
                      timezone: config.queue.schedule?.timezone ?? "auto",
                      stopActiveOnExit: config.queue.schedule?.stopActiveOnExit ?? true,
                    },
                  },
                });
              };

              const copyWindowsToDays = (sourceDay: number, targetDays: number[]) => {
                const sourceWindows = allWindows.filter((item) => item.day === sourceDay);
                const targets = new Set(targetDays.filter((d) => d !== sourceDay));
                const kept = allWindows.filter((item) => item.day === sourceDay || !targets.has(item.day));
                const cloned = targetDays
                  .filter((d) => targets.has(d))
                  .flatMap((d) => sourceWindows.map((w) => ({ ...w, id: makeWindowId(), day: d })));
                commitWindows([...kept, ...cloned]);
              };

              return WEEK_DAYS.map(({ day, short, label }) => {
                const dayWindows = allWindows.filter((item) => item.day === day);

                const updateWindow = (id: string | undefined, changes: Partial<ScheduleWindow>) =>
                  commitWindows(allWindows.map((item) => (item.id === id ? { ...item, ...changes } : item)));
                const addWindow = () =>
                  commitWindows([...allWindows, { id: makeWindowId(), day, enabled: true, start: "07:30", end: "17:00" }]);
                const removeWindow = (id: string | undefined) =>
                  commitWindows(allWindows.filter((item) => item.id !== id));

                return (
                  <div className={`schedule-day ${dayWindows.some((w) => w.enabled) ? "enabled" : "disabled"}`} key={day}>
                    <div className="schedule-day-header">
                      <span className="day-short">{short}</span>
                      <span className="day-long">{label}</span>
                      <select className="form-input schedule-copy-day" value="" aria-label={`Copy ${label}'s windows to other days`}
                        disabled={!scheduleEnabled || dayWindows.length === 0}
                        title={dayWindows.length === 0 ? `Add a window to ${label} before copying it to other days` : `Copy ${label}'s windows to other days`}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === "weekdays") copyWindowsToDays(day, [1, 2, 3, 4, 5]);
                          else if (value === "weekend") copyWindowsToDays(day, [0, 6]);
                          else if (value === "all") copyWindowsToDays(day, [0, 1, 2, 3, 4, 5, 6]);
                        }}>
                        <option value="" disabled>Copy to...</option>
                        <option value="weekdays">Weekdays (Mon–Fri)</option>
                        <option value="weekend">Weekend (Sat–Sun)</option>
                        <option value="all">All days</option>
                      </select>
                      <button type="button" className="btn btn-secondary btn-sm schedule-add-window"
                        disabled={!scheduleEnabled || dayWindows.length >= MAX_WINDOWS_PER_DAY} onClick={addWindow}
                        title={dayWindows.length >= MAX_WINDOWS_PER_DAY ? `Maximum ${MAX_WINDOWS_PER_DAY} windows per day` : undefined}>
                        + Add window
                      </button>
                    </div>

                    {dayWindows.length === 0 && <span className="schedule-day-state">No processing</span>}

                  {dayWindows.map((window) => (
                    <div className="schedule-window-row" key={window.id}>
                      <label className="schedule-window-toggle">
                        <input
                          type="checkbox"
                          disabled={!scheduleEnabled}
                          checked={window.enabled}
                          onChange={(e) => updateWindow(window.id, { enabled: e.target.checked })}
                          aria-label={`Enable ${label} window ${window.start}–${window.end}`}
                        />
                      </label>
                      <div className="schedule-times">
                        <label>
                          <span>From</span>
                          <input type="time" className="form-input" step="900" disabled={!scheduleEnabled || !window.enabled}
                            value={window.start} onChange={(e) => updateWindow(window.id, { start: e.target.value })} />
                        </label>
                        <span className="schedule-arrow">→</span>
                        <label>
                          <span>Until</span>
                          <input type="time" className="form-input" step="900" disabled={!scheduleEnabled || !window.enabled}
                            value={window.end} onChange={(e) => updateWindow(window.id, { end: e.target.value })} />
                        </label>
                      </div>
                      <button type="button" className="schedule-remove-window" disabled={!scheduleEnabled}
                        onClick={() => removeWindow(window.id)} aria-label={`Remove ${label} window ${window.start}–${window.end}`} title="Remove window">
                        <IconClose size={12} />
                      </button>
                    </div>
                  ))}
                  </div>
                );
              });
            })()}
          </div>

          <div className="schedule-options">
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Timezone</label>
              <div className="timezone-row">
                <input type="text" className="form-input" disabled={!config.queue.schedule?.enabled}
                  placeholder="auto (server time)" value={config.queue.schedule?.timezone ?? "auto"}
                  onChange={(e) => setConfig({
                    ...config,
                    queue: { ...config.queue, schedule: { ...config.queue.schedule!, timezone: e.target.value } },
                  })} />
                <button type="button" className="btn btn-secondary" disabled={!config.queue.schedule?.enabled}
                  onClick={() => {
                    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    setConfig({ ...config, queue: { ...config.queue, schedule: { ...config.queue.schedule!, timezone } } });
                  }}>
                  Use device timezone
                </button>
              </div>
              <div className="form-help">Current scheduled time: {queueStatus?.schedule?.serverTime ?? "-"}</div>
            </div>

            <label className="schedule-option-toggle">
              <input type="checkbox" disabled={!config.queue.schedule?.enabled}
                checked={config.queue.schedule?.stopActiveOnExit ?? true}
                onChange={(e) => setConfig({
                  ...config,
                  queue: { ...config.queue, schedule: { ...config.queue.schedule!, stopActiveOnExit: e.target.checked } },
                })} />
              <div>
                <strong>Stop work when an active window ends</strong>
                <span>Return an in-progress job to pending so the NAS becomes available immediately.</span>
              </div>
            </label>

            <label className="schedule-option-toggle streaming">
              <input type="checkbox" checked={config.queue.pauseOnStreaming ?? false}
                onChange={(e) => setConfig({ ...config, queue: { ...config.queue, pauseOnStreaming: e.target.checked } })} />
              <div>
                <strong>Also pause while media is streaming</strong>
                <span>Jellyfin, Emby, or Plex playback takes priority even during an active window.</span>
              </div>
            </label>
          </div>
        </div>

        {/* Safety & Queue Settings Card */}
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <IconShield size={18} /> Safety & Queue Guard
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Configure multi-stage verification and disk protection parameters.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
            <div className="form-group">
              <label className="form-label">Transcode Concurrency (Active Runners)</label>
              <input
                type="number"
                min={1}
                max={8}
                className="form-input"
                value={config.queue.concurrency}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    queue: { ...config.queue, concurrency: Number(e.target.value) },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Number of simultaneous transcode runners/processes (1-2 recommended for GPU hardware). Changing and saving this setting dynamically adds or removes runner processes in real time.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Minimum Free Disk Space Guard (GB)</label>
              <input
                type="number"
                min={1}
                className="form-input"
                value={config.queue.minFreeSpaceGb ?? 10}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    queue: { ...config.queue, minFreeSpaceGb: Number(e.target.value) },
                  })
                }
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
                Auto-pause queue if target disk free space drops below this limit
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Recycle Bin / Staging Backup Directory (Optional)</label>
            <input
              className="form-input"
              style={{ fontFamily: "monospace" }}
              placeholder="e.g. C:\Media\.recycle or /media/.recycle (leave blank to delete original on verify pass)"
              value={config.queue.recycleBinPath ?? ""}
              onChange={(e) =>
                setConfig({
                  ...config,
                  queue: { ...config.queue, recycleBinPath: e.target.value || undefined },
                })
              }
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem" }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
