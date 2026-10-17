import { useEffect } from "react";
import { Banner } from "../components/Banner.js";
import { useNoticeSlot } from "../components/useNoticeSlot.js";
import { useStore } from "../store.js";

/**
 * Settings, as an overlay over whatever screen is behind it: the first and only
 * populated overlay this phase reserves a slot for.
 *
 * It reads the health slice — never the raw environment. One degraded condition
 * exists today: the server has no Ollama API key, so the LLM calls the whole
 * pipeline is built on cannot run. The server says so as `status: "degraded"`
 * and this screen says it back through the notice slot, in the approved words.
 *
 * The key itself is never fetched, rendered, echoed or referenced: the health
 * payload is a fixed set of non-secret fields (`apps/web/src/lib/api.ts`
 * `HealthPayload`), and the notice names the environment VARIABLE a deployment
 * sets. A reader of this screen learns that a key is missing and nothing else.
 */
export function Settings() {
  const closeOverlay = useStore((s) => s.closeOverlay);
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);

  // The one banner condition this phase has. No `onFade`: a misconfigured
  // server is a fact, not an acknowledgement, so the notice stays until the
  // condition clears (or the user closes the overlay with it).
  const notice = useNoticeSlot("config-degraded", health?.status === "degraded");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOverlay]);

  return (
    <div
      className="modal-backdrop"
      // A click on the backdrop itself closes; a click inside the card must not.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-header">
          <span>Settings</span>
          <button
            className="icon-btn"
            autoFocus
            onClick={closeOverlay}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <Banner show={notice} role="status">
          Ollama API key is not configured. Set OLLAMA_API_KEY and restart.
        </Banner>

        <section aria-label="Server">
          <span className="subhead">Server</span>
          {healthError ? (
            <p className="muted" role="alert" style={{ marginBottom: 0 }}>
              Couldn't reach the server. Try again in a moment.
            </p>
          ) : health ? (
            <dl style={{ margin: "var(--sp-2) 0 0" }}>
              <HealthRow label="Status" value={health.status} />
              <HealthRow label="Service" value={`${health.service} v${health.version}`} />
              <HealthRow label="Uptime" value={formatUptime(health.uptimeSec)} />
            </dl>
          ) : (
            <p className="muted" aria-busy="true" style={{ marginBottom: 0 }}>
              Checking…
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function HealthRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: "var(--sp-3)", alignItems: "baseline" }}>
      <dt className="muted" style={{ minWidth: 64 }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

/** Seconds as the shortest honest form: "42 s", "3 min", "2 h 5 min". */
function formatUptime(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}
