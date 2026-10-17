import { useEffect, useState } from "react";
import { Browse } from "./screens/Browse.js";
import { getHealth, type HealthPayload } from "./lib/api.js";

/**
 * App shell. Renders the Browse screen as the body and keeps the health-status
 * indicator from the tracer task so the end-to-end signal stays visible. The
 * health probe goes through the lib/api boundary — no direct fetch in views.
 */
export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <header style={{ padding: "0.5rem 1rem", borderBottom: "1px solid #eee", fontSize: 13, color: "#666" }}>
        2nd Brain Studio —{" "}
        {err
          ? `health: ${err}`
          : health
            ? `health: ${health.status} (${health.service} v${health.version})`
            : "health: …"}
      </header>
      <main>
        <Browse />
      </main>
    </div>
  );
}