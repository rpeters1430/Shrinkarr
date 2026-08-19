import { useEffect, useState } from "react";
import { getConfig, putConfig, type Config } from "../api/client";

export function Settings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [integrationsJson, setIntegrationsJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c);
        setIntegrationsJson(JSON.stringify(c.integrations, null, 2));
      })
      .catch((err) => setError(String(err)));
  }, []);

  if (!config) {
    return <div style={{ padding: "1rem" }}>{error ?? "Loading..."}</div>;
  }

  function updateLibrary(index: number, field: string, value: string) {
    setConfig((prev) => {
      if (!prev) return prev;
      const libraries = [...prev.libraries];
      libraries[index] = { ...libraries[index], [field]: value };
      return { ...prev, libraries };
    });
  }

  function updatePreset(index: number, field: string, value: string | number) {
    setConfig((prev) => {
      if (!prev) return prev;
      const presets = [...prev.presets];
      presets[index] = { ...presets[index], [field]: value };
      return { ...prev, presets };
    });
  }

  async function handleSave() {
    if (!config) return;
    setError(null);
    setSaved(false);
    try {
      const integrations = JSON.parse(integrationsJson);
      const updated = await putConfig({ ...config, integrations });
      setConfig(updated);
      setSaved(true);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h2>Settings</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {saved && <p style={{ color: "green" }}>Saved.</p>}

      <h3>Libraries</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Path</th>
            <th>Preset</th>
          </tr>
        </thead>
        <tbody>
          {config.libraries.map((lib, i) => (
            <tr key={lib.id}>
              <td>
                <input value={lib.name} onChange={(e) => updateLibrary(i, "name", e.target.value)} />
              </td>
              <td>
                <input value={lib.path} onChange={(e) => updateLibrary(i, "path", e.target.value)} />
              </td>
              <td>
                <select
                  value={lib.presetId}
                  onChange={(e) => updateLibrary(i, "presetId", e.target.value)}
                >
                  {config.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Presets</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Target codec</th>
            <th>CRF</th>
            <th>Hwaccel</th>
            <th>Min savings %</th>
          </tr>
        </thead>
        <tbody>
          {config.presets.map((preset, i) => (
            <tr key={preset.id}>
              <td>
                <input
                  value={preset.name}
                  onChange={(e) => updatePreset(i, "name", e.target.value)}
                />
              </td>
              <td>
                <select
                  value={preset.targetCodec}
                  onChange={(e) => updatePreset(i, "targetCodec", e.target.value)}
                >
                  <option value="hevc">hevc</option>
                  <option value="h264">h264</option>
                </select>
              </td>
              <td>
                <input
                  type="number"
                  value={preset.crf}
                  onChange={(e) => updatePreset(i, "crf", Number(e.target.value))}
                />
              </td>
              <td>
                <select
                  value={preset.hwaccel}
                  onChange={(e) => updatePreset(i, "hwaccel", e.target.value)}
                >
                  <option value="vaapi">vaapi</option>
                  <option value="cpu">cpu</option>
                </select>
              </td>
              <td>
                <input
                  type="number"
                  value={preset.minSavingsPercent}
                  onChange={(e) => updatePreset(i, "minSavingsPercent", Number(e.target.value))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Integrations (Jellyfin / Emby / Plex / Sonarr / Radarr)</h3>
      <textarea
        style={{ width: "100%", height: "200px", fontFamily: "monospace" }}
        value={integrationsJson}
        onChange={(e) => setIntegrationsJson(e.target.value)}
      />

      <div style={{ marginTop: "1rem" }}>
        <button onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}
