import { useEffect, useState } from "react";
import { getAuthStatus, login, setupAccount, UNAUTHORIZED_EVENT } from "../api/client";

type Status = "checking" | "authed" | "anon" | "needsSetup";

const MIN_PASSWORD_LENGTH = 8;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getAuthStatus()
      .then(({ needsSetup }) => {
        if (needsSetup) {
          setStatus("needsSetup");
          return;
        }
        return fetch("/api/auth/me", { credentials: "same-origin" }).then((res) =>
          setStatus(res.ok ? "authed" : "anon"),
        );
      })
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

  async function handleLoginSubmit(e: React.FormEvent) {
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

  async function handleSetupSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await setupAccount(trimmedUsername, password);
      setPassword("");
      setConfirmPassword("");
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

  if (status === "needsSetup") {
    return (
      <div className="auth-gate">
        <form className="auth-gate-card card" onSubmit={handleSetupSubmit}>
          <h1 className="auth-gate-title">⚡ Shrinkarr</h1>
          <p className="page-subtitle" style={{ marginBottom: "1.25rem" }}>
            Create the admin account used to sign in to this server.
          </p>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="form-group">
            <label className="form-label" htmlFor="setup-username-input">
              Username
            </label>
            <input
              id="setup-username-input"
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
            <label className="form-label" htmlFor="setup-password-input">
              Password
            </label>
            <input
              id="setup-password-input"
              type="password"
              className="form-input"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="setup-confirm-password-input">
              Confirm Password
            </label>
            <input
              id="setup-confirm-password-input"
              type="password"
              className="form-input"
              placeholder="Re-enter password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !username.trim() || !password || !confirmPassword}
            style={{ width: "100%" }}
          >
            {submitting ? "Creating account..." : "Create Account"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card card" onSubmit={handleLoginSubmit}>
        <h1 className="auth-gate-title">⚡ Shrinkarr</h1>
        <p className="page-subtitle" style={{ marginBottom: "1.25rem" }}>
          Sign in with your admin username and password.
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
