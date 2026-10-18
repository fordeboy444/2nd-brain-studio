import { useEffect, useState, type ChangeEvent } from "react";
import { Banner } from "../components/Banner.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { useNoticeSlot } from "../components/useNoticeSlot.js";
import { useStore } from "../store.js";

/**
 * Settings, as an overlay over whatever screen is behind it: the ingest form,
 * the LLM and fetch blocks, the YouTube cookie block and one manual Test
 * connection.
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
 *
 * The cookie is the same rule with a file: the picker reads the local `File`
 * into a string, hands that string to the API boundary as a `text/plain` body,
 * and keeps no copy. The status it renders back is `hasYoutubeCookie` and a
 * timestamp; no route returns the body and nothing here could display it.
 */
export function Settings() {
  const closeOverlay = useStore((s) => s.closeOverlay);
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);

  const settings = useStore((s) => s.settings);
  const settingsError = useStore((s) => s.settingsError);
  const loadSettings = useStore((s) => s.loadSettings);
  const uploadCookie = useStore((s) => s.uploadCookie);
  const deleteCookie = useStore((s) => s.deleteCookie);

  const [cookieNotice, setCookieNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The one banner condition this phase has. No `onFade`: a misconfigured
  // server is a fact, not an acknowledgement, so the notice stays until the
  // condition clears (or the user closes the overlay with it).
  const notice = useNoticeSlot("config-degraded", health?.status === "degraded");

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOverlay]);

  /**
   * Read the chosen file and send its text. The input is reset in `finally`, so
   * choosing the same file twice after a failure raises `change` again.
   */
  const onCookieFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    setCookieNotice(null);
    try {
      const text = await file.text();
      await uploadCookie(text);
      setCookieNotice("YouTube cookie saved.");
    } catch {
      // One failure copy: the server's 400 `invalid_cookie` is by far the
      // common case, and the body it rejected is never echoed back.
      setCookieNotice("Cookie must be Netscape format.");
    } finally {
      input.value = "";
    }
  };

  const onDeleteCookie = async () => {
    try {
      await deleteCookie();
      setCookieNotice("YouTube cookie removed.");
    } catch {
      setCookieNotice("Couldn't remove the YouTube cookie. Try again in a moment.");
    } finally {
      setConfirmDelete(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      // A click on the backdrop itself closes; a click inside the card must not.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
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

        <section className="settings-section" aria-label="YouTube cookie">
          <span className="subhead">YouTube cookie</span>
          {settings === null ? (
            <p className="muted" aria-busy="true" style={{ margin: 0 }}>
              Checking…
            </p>
          ) : settings.hasYoutubeCookie ? (
            <p className="muted" style={{ margin: 0 }}>
              Cookie saved{" "}
              {settings.youtubeCookieUpdatedAt === null
                ? "."
                : `${formatWhen(settings.youtubeCookieUpdatedAt)}.`}
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No YouTube cookie uploaded.
            </p>
          )}

          <div className="settings-row" style={{ marginTop: "var(--sp-2)" }}>
            <label className="field-label" htmlFor="youtube-cookie-file">
              Cookie file
            </label>
            <input
              id="youtube-cookie-file"
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => void onCookieFile(e)}
            />
            {settings?.hasYoutubeCookie === true && (
              <button
                type="button"
                className="ghost-pill"
                onClick={() => setConfirmDelete(true)}
              >
                Remove cookie
              </button>
            )}
          </div>
          {settingsError !== null && (
            <p className="muted" role="alert" style={{ margin: "var(--sp-2) 0 0" }}>
              {settingsError}
            </p>
          )}
          <Banner show={cookieNotice !== null} role="status">
            {cookieNotice}
          </Banner>
        </section>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Remove the saved YouTube cookie?"
          confirmLabel="Remove cookie"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={onDeleteCookie}
        >
          <p>The next transcript fetch runs without a signed-in session.</p>
        </ConfirmDialog>
      )}
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

/** An ISO timestamp at minute precision, without the locale's opinion. */
function formatWhen(iso: string): string {
  const at = iso.indexOf("T");
  return at > 0 ? `${iso.slice(0, at)} ${iso.slice(at + 1, at + 6)}` : iso;
}
