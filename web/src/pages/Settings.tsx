import { useEffect, useState } from "react";
import { getConfig, putConfig, testIntegration, type Config } from "../api/client";

export function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [testingService, setTestingService] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message?: string; error?: string } | undefined>>({});
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) => setError(String(err)));
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

      {error && <div className="alert alert-error">{error}</div>}
      {saved && <div className="alert alert-success">Settings saved successfully!</div>}

      <form onSubmit={handleSave}>
        {/* Automated Library Watcher & Scheduler Card */}
        <div className="card" style={{ marginBottom: "1.75rem", border: "1px solid rgba(99, 102, 241, 0.4)" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            🤖 Automated Library Watcher & Scheduler
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
                <strong style={{ color: "var(--accent-emerald)", fontSize: "0.95rem" }}>⚡ Auto-Optimize Eligible New Videos</strong>
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
            🔗 Media Server & *Arr Integrations
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Shrinkarr notifies your media stack immediately after a transcode finishes so your libraries stay synced without manual rescanning.
          </p>

          {/* Jellyfin */}
          <div style={{ padding: "1.25rem", backgroundColor: "var(--bg-surface)", borderRadius: "var(--radius-md)", marginBottom: "1.25rem", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>🍇 Jellyfin</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "jellyfin"}
                onClick={() => handleTestService("jellyfin")}
              >
                {testingService === "jellyfin" ? "Testing..." : "⚡ Test Connection"}
              </button>
            </div>

            {testResults.jellyfin && (
              <div className={`alert ${testResults.jellyfin.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
                {testResults.jellyfin.success ? (testResults.jellyfin.message || "✓ Connected to Jellyfin successfully!") : testResults.jellyfin.error}
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
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>🟢 Emby</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "emby"}
                onClick={() => handleTestService("emby")}
              >
                {testingService === "emby" ? "Testing..." : "⚡ Test Connection"}
              </button>
            </div>

            {testResults.emby && (
              <div className={`alert ${testResults.emby.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
                {testResults.emby.success ? (testResults.emby.message || "✓ Connected to Emby successfully!") : testResults.emby.error}
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
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>🎭 Plex</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "plex"}
                onClick={() => handleTestService("plex")}
              >
                {testingService === "plex" ? "Testing..." : "⚡ Test Connection"}
              </button>
            </div>

            {testResults.plex && (
              <div className={`alert ${testResults.plex.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
                {testResults.plex.success ? (testResults.plex.message || "✓ Connected to Plex successfully!") : testResults.plex.error}
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
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>📺 Sonarr (TV Shows)</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "sonarr"}
                onClick={() => handleTestService("sonarr")}
              >
                {testingService === "sonarr" ? "Testing..." : "⚡ Test Connection"}
              </button>
            </div>

            {testResults.sonarr && (
              <div className={`alert ${testResults.sonarr.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
                {testResults.sonarr.success ? (testResults.sonarr.message || "✓ Connected to Sonarr successfully!") : testResults.sonarr.error}
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
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>🎬 Radarr (Movies)</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={testingService === "radarr"}
                onClick={() => handleTestService("radarr")}
              >
                {testingService === "radarr" ? "Testing..." : "⚡ Test Connection"}
              </button>
            </div>

            {testResults.radarr && (
              <div className={`alert ${testResults.radarr.success ? "alert-success" : "alert-error"}`} style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}>
                {testResults.radarr.success ? (testResults.radarr.message || "✓ Connected to Radarr successfully!") : testResults.radarr.error}
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

        {/* Safety & Queue Settings Card */}
        <div className="card" style={{ marginBottom: "1.75rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            🛡️ Safety & Queue Guard
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Configure multi-stage verification and disk protection parameters.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
            <div className="form-group">
              <label className="form-label">Transcode Concurrency</label>
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
                Number of simultaneous transcode jobs (1-2 recommended for GPU hardware)
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
