import { useState, type FormEvent } from "react";
import { useStore } from "../store.js";

/**
 * The login gate.
 *
 * One field and one button on purpose: the only browser credential is the
 * admin token, and the server sets an HttpOnly cookie from it. The token is
 * held in this component's state for the duration of the submit and is never
 * written to local or session storage — a copy there would outlive the session
 * and be readable by any script on the page.
 */
export function Login() {
  const login = useStore((s) => s.login);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const value = token.trim();
    if (value === "") {
      setError("Enter the admin token.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await login(value);
      // The shell replaces this screen; clear the field first so the value
      // does not linger in a component that is about to unmount.
      setToken("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">2nd Brain Studio</h1>
        <p className="login-hint">
          Enter the admin token for this deployment.
        </p>
        <form className="login-form" onSubmit={onSubmit}>
          <label className="login-label" htmlFor="login-token">
            Admin token
          </label>
          <input
            id="login-token"
            className="login-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={pending}
          />
          <button className="login-submit primary" type="submit" disabled={pending}>
            {pending ? "Checking…" : "Log in"}
          </button>
        </form>
        {error !== null && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
