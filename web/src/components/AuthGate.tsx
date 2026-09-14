import { useEffect, useState } from "react";
import { login, UNAUTHORIZED_EVENT } from "../api/client";

type Status = "checking" | "authed" | "anon";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((res) => setStatus(res.ok ? "authed" : "anon"))
      .catch(() => setStatus("anon"));
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      setStatus((prev) => {
        if (prev === "authed") {
          setError("Your session expired. Please log in again.");
        }
        return "anon";
      });
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
      setPassword("");
      setStatus("authed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "checking") {
    return null;
  }

  if (status === "authed") {
    return <>{children}</>;
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card card" onSubmit={handleSubmit}>
        <h1 className="auth-gate-title">⚡ Shrinkarr</h1>
        <p className="page-subtitle" style={{ marginBottom: "1.25rem" }}>
          Sign in with the admin username and password shown in your server startup logs.
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="auth-username-input">
            Username
          </label>
          <input
            id="auth-username-input"
            type="text"
            className="form-input"
            placeholder="admin"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="auth-password-input">
            Password
          </label>
          <input
            id="auth-password-input"
            type="password"
            className="form-input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting || !username.trim() || !password}
          style={{ width: "100%" }}
        >
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}
