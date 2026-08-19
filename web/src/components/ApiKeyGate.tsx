import { useEffect, useState } from "react";
import { getApiKey, setApiKey } from "../auth";
import { UNAUTHORIZED_EVENT } from "../api/client";

export function ApiKeyGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => Boolean(getApiKey()));
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    function handleUnauthorized() {
      setUnlocked(false);
      setError("Your API key was rejected. Please enter it again.");
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;

    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/config", { headers: { "X-Api-Key": trimmed } });
      if (!res.ok) {
        throw new Error(res.status === 401 ? "Invalid API key." : `Unexpected error (HTTP ${res.status}).`);
      }
      setApiKey(trimmed);
      setInput("");
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  if (unlocked) {
    return <>{children}</>;
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card card" onSubmit={handleSubmit}>
        <h1 className="auth-gate-title">⚡ Shrinkarr</h1>
        <p className="page-subtitle" style={{ marginBottom: "1.25rem" }}>
          Enter the API key shown in your server startup logs or in <code>config.yaml</code>.
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="api-key-input">
            API Key
          </label>
          <input
            id="api-key-input"
            type="password"
            className="form-input"
            placeholder="Paste your API key"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={checking || !input.trim()} style={{ width: "100%" }}>
          {checking ? "Checking..." : "Unlock"}
        </button>
      </form>
    </div>
  );
}
