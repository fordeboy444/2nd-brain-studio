import { useEffect, useState } from "react";

type HealthPayload = {
  ok: boolean;
  status: "healthy" | "degraded";
  service: string;
  version: string;
  uptimeSec: number;
  time: string;
};

/**
 * Tracer shell. Calls GET /api/health on mount and renders the status so the
 * walking skeleton has a visible end-to-end signal. Task 3 swaps the body for
 * the Browse screen but keeps this status indicator.
 */
export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: HealthPayload) => {
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
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
      <h1>2nd Brain Studio</h1>
      <p>
        {err
          ? `health: ${err}`
          : health
            ? `health: ${health.status} (${health.service} v${health.version})`
            : "health: …"}
      </p>
    </div>
  );
}