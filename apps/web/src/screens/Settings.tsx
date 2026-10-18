import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AsyncButton } from "../components/AsyncButton.js";
import { Banner } from "../components/Banner.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { MenuSelect } from "../components/MenuSelect.js";
import { Switch } from "../components/Switch.js";
import { useNoticeSlot } from "../components/useNoticeSlot.js";
import { toast } from "../lib/toast.js";
import { useStore } from "../store.js";
import type { JobKind, PreviewInput, SettingsPatch, StartJobInput } from "../lib/api.js";

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
 *
 * The typed form values live HERE, not in the store. The store holds the
 * SERVER's copy; that split is what makes "a failed preview keeps every value"
 * true by construction — a rejected request cannot clear component state.
 */
export function Settings() {
  const closeOverlay = useStore((s) => s.closeOverlay);
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);

  const settings = useStore((s) => s.settings);
  const settingsError = useStore((s) => s.settingsError);
  const loadSettings = useStore((s) => s.loadSettings);
  const saveSettings = useStore((s) => s.saveSettings);
  const uploadCookie = useStore((s) => s.uploadCookie);
  const saveCookieHeader = useStore((s) => s.saveCookieHeader);
  const deleteCookie = useStore((s) => s.deleteCookie);

  const testLlmResult = useStore((s) => s.testLlmResult);
  const runTestConnection = useStore((s) => s.runTestConnection);
  const previewResult = useStore((s) => s.previewResult);
  const previewLoading = useStore((s) => s.previewLoading);
  const previewError = useStore((s) => s.previewError);
  const runPreview = useStore((s) => s.runPreview);
  const ingestStarting = useStore((s) => s.ingestStarting);
  const ingestError = useStore((s) => s.ingestError);
  const startIngest = useStore((s) => s.startIngest);

  const vaults = useStore((s) => s.vaults);
  const loadVaults = useStore((s) => s.loadVaults);
  const createVault = useStore((s) => s.createVault);

  // Ingest form. Local by design: a failed preview or start must not lose a
  // single typed character.
  const [kind, setKind] = useState<JobKind>("youtube");
  const [sourceUrl, setSourceUrl] = useState("");
  const [maxVideos, setMaxVideos] = useState("50");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minDurationSec, setMinDurationSec] = useState("");
  const [language, setLanguage] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [newVaultName, setNewVaultName] = useState("");
  const [vaultError, setVaultError] = useState<string | null>(null);

  // Settings fields, seeded from the server copy. Kept separately so a refresh
  // of `settings` (a cookie upload, a save) does not fight the field in use.
  const seeded = useRef(false);
  const [llmModel, setLlmModel] = useState("");
  const [fetchDelayMs, setFetchDelayMs] = useState("");
  const [fetchConcurrency, setFetchConcurrency] = useState("");
  const [fetchLanguage, setFetchLanguage] = useState("");
  const [sweepOn, setSweepOn] = useState(false);

  const [cookieNotice, setCookieNotice] = useState<string | null>(null);
  // The pasted header lives here and nowhere else: a store copy would be one
  // render away from the screen, and a successful save clears this field.
  const [cookieHeader, setCookieHeader] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The one banner condition this phase has. No `onFade`: a misconfigured
  // server is a fact, not an acknowledgement, so the notice stays until the
  // condition clears (or the user closes the overlay with it).
  const notice = useNoticeSlot("config-degraded", health?.status === "degraded");

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);

  // A first vault is selected as soon as the list lands, so Start ingest is
  // reachable without a second decision. The user can still choose another.
  const vaultList = Array.isArray(vaults) ? vaults : [];
  useEffect(() => {
    const list = Array.isArray(vaults) ? vaults : [];
    if (vaultId === "" && list.length > 0) setVaultId(list[0]?.id ?? "");
  }, [vaults, vaultId]);

  // Seed the settings fields from the server's copy. Optional chaining because
  // a stub or a future server shape may omit a block; an absent block renders
  // as empty, never as a crash.
  const server = settings?.settings;
  useEffect(() => {
    if (server === undefined) return;
    // Seed once. A later refresh (a save, a cookie upload) must not overwrite
    // text the user typed while it was in flight (WR-08).
    if (!seeded.current) {
      seeded.current = true;
      setLlmModel(server?.llm?.model ?? "");
      setFetchDelayMs(
        server?.fetch?.delayMs === undefined ? "" : String(server.fetch.delayMs),
      );
      setFetchConcurrency(
        server?.fetch?.concurrency === undefined ? "" : String(server.fetch.concurrency),
      );
      setFetchLanguage(server?.fetch?.language ?? "");
    }
    // The sweep switch saves on click, so its server value is always current.
    setSweepOn(server?.sweep?.enabled === true);
  }, [server]);

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

  /**
   * Send a pasted Cookie header. The server accepts one shape, so a rejection
   * has one copy; the pasted text stays in the textarea so it can be corrected,
   * and a success clears it — the credential is not left on screen.
   */
  const onSaveCookieHeader = async () => {
    const text = cookieHeader.trim();
    if (text === "") {
      setCookieNotice("Paste a Cookie header first.");
      return;
    }
    setCookieNotice(null);
    try {
      await saveCookieHeader(text);
      setCookieHeader("");
      setCookieNotice("YouTube cookie saved.");
    } catch {
      setCookieNotice("Cookie header must look like name=value; name=value.");
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

  /**
   * The exact filter set both routes receive. A web job carries no video-only
   * field: its server arm is `.strict()`, so a stray `maxVideos` would turn a
   * valid click into a 400.
   */
  const filters = (): Omit<PreviewInput, "kind"> => {
    const body: Omit<PreviewInput, "kind"> = {};
    if (kind === "web") {
      body.url = sourceUrl.trim();
    } else {
      body.channelUrl = sourceUrl.trim();
      const max = Number(maxVideos);
      if (maxVideos !== "" && Number.isFinite(max)) body.maxVideos = max;
      if (dateFrom !== "") body.dateFrom = dateFrom;
      if (dateTo !== "") body.dateTo = dateTo;
      const minDuration = Number(minDurationSec);
      if (minDurationSec !== "" && Number.isFinite(minDuration)) {
        body.minDurationSec = minDuration;
      }
    }
    if (language.trim() !== "") body.language = language.trim();
    return body;
  };

  const onPreview = () => runPreview({ kind, ...filters() });

  const onStart = () => {
    const input: StartJobInput = { vaultId, kind, ...filters() };
    return startIngest(input);
  };

  const onCreateVault = async () => {
    const name = newVaultName.trim();
    if (name === "") return;
    setVaultError(null);
    try {
      const created = await createVault(name);
      setVaultId(created.id);
      setNewVaultName("");
    } catch (e) {
      setVaultError((e as Error).message);
    }
  };

  /**
   * Persist one settings field on blur. The server merges the patch; a failure
   * is reported through `settingsError`, and the field keeps what the user
   * typed rather than snapping back.
   */
  const saveLlm = () => {
    const model = llmModel.trim();
    if (model === "" || model === (server?.llm?.model ?? "")) return;
    void saveSettings({ llm: { model } });
  };

  const saveFetch = () => {
    const patch: NonNullable<SettingsPatch["fetch"]> = {};
    const delayMs = Number(fetchDelayMs);
    if (fetchDelayMs !== "" && Number.isFinite(delayMs)) patch.delayMs = delayMs;
    const concurrency = Number(fetchConcurrency);
    if (fetchConcurrency !== "" && Number.isFinite(concurrency)) {
      patch.concurrency = concurrency;
    }
    const lang = fetchLanguage.trim();
    if (lang !== "" && lang !== (server?.fetch?.language ?? "")) patch.language = lang;
    if (Object.keys(patch).length > 0) void saveSettings({ fetch: patch });
  };

  /**
   * The sweep is a switch, so it moves before the request lands. A refused save
   * puts it back: the screen must never show a setting the server did not keep.
   */
  const onToggleSweep = async (next: boolean) => {
    setSweepOn(next);
    const saved = await saveSettings({ sweep: { enabled: next } });
    if (!saved) {
      setSweepOn(!next);
      toast("Couldn't save the sweep setting. Try again in a moment.", "error");
    }
  };

  // The server decides whether a key exists. An unconfigured server says so
  // before the button is pressed: the probe cannot succeed, so inviting the
  // press would only produce a worse version of the same sentence.
  const testMessage =
    settings === null || settings === undefined
      ? null
      : settings.llmConfigured === false
        ? "Set OLLAMA_API_KEY and restart."
        : testLlmResult === null
          ? null
          : testLlmResult.ok
            ? `Ollama replied in ${testLlmResult.latencyMs ?? 0} ms.`
            : `Test failed: ${testLlmResult.reason ?? "unknown error"}.`;
  const testFailed =
    settings?.llmConfigured === false || (testLlmResult !== null && !testLlmResult.ok);

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

        {/* One error slot for every settings save. It lives at the top of the
            page rather than in the cookie section, so a failed sweep toggle is
            not reported far below the switch that failed. */}
        <Banner show={settingsError !== null} role="alert">
          {settingsError}
        </Banner>

        <section aria-label="Ingest">
          <span className="subhead">Ingest</span>
          <div className="settings-form" style={{ marginTop: "var(--sp-2)" }}>
            <div className="settings-grid">
              <div className="settings-field">
                <span className="field-label">Source kind</span>
                <MenuSelect<JobKind>
                  value={kind}
                  options={[
                    { value: "youtube", label: "YouTube channel" },
                    { value: "web", label: "Web page" },
                  ]}
                  onSelect={(next) => {
                    setKind(next);
                    setSourceUrl("");
                  }}
                  ariaLabel="Source kind"
                  triggerClassName="ghost-pill"
                  direction="down"
                />
              </div>
              <div className="settings-field">
                <label className="field-label" htmlFor="ingest-source-url">
                  {kind === "youtube" ? "Channel URL" : "Page URL"}
                </label>
                <input
                  id="ingest-source-url"
                  type="url"
                  value={sourceUrl}
                  placeholder={
                    kind === "youtube"
                      ? "https://www.youtube.com/@studio"
                      : "https://example.com/article"
                  }
                  onChange={(e) => setSourceUrl(e.target.value)}
                />
              </div>
            </div>

            {kind === "youtube" && (
              <div className="settings-grid">
                <div className="settings-field">
                  <label className="field-label" htmlFor="ingest-max-videos">
                    Max videos
                  </label>
                  <input
                    id="ingest-max-videos"
                    type="number"
                    min={1}
                    value={maxVideos}
                    onChange={(e) => setMaxVideos(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label className="field-label" htmlFor="ingest-date-from">
                    Date from
                  </label>
                  <input
                    id="ingest-date-from"
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label className="field-label" htmlFor="ingest-date-to">
                    Date to
                  </label>
                  <input
                    id="ingest-date-to"
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label className="field-label" htmlFor="ingest-min-duration">
                    Min duration (sec)
                  </label>
                  <input
                    id="ingest-min-duration"
                    type="number"
                    min={0}
                    value={minDurationSec}
                    onChange={(e) => setMinDurationSec(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="settings-field">
              <label className="field-label" htmlFor="ingest-language">
                Language
              </label>
              <input
                id="ingest-language"
                type="text"
                value={language}
                placeholder="en"
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>

            <div className="settings-actions">
              <AsyncButton
                onClick={onPreview}
                disabled={previewLoading}
                spinnerTone="neutral"
              >
                Preview selection
              </AsyncButton>
            </div>

            {previewResult !== null && (
              <p className="settings-result">
                Estimated {previewResult.estimatedCalls} LLM calls, about{" "}
                {previewResult.estimatedMinutes} min after commit.
              </p>
            )}
            <Banner show={previewError !== null} role="alert">
              {previewError}
            </Banner>

            <div className="settings-grid">
              <div className="settings-field">
                <span className="field-label">Vault</span>
                {vaultList.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No vaults yet.
                  </p>
                ) : (
                  <MenuSelect<string>
                    value={vaultId}
                    options={vaultList.map((v) => ({ value: v.id, label: v.name }))}
                    onSelect={setVaultId}
                    ariaLabel="Vault"
                    triggerClassName="ghost-pill"
                    direction="down"
                  />
                )}
              </div>
              <div className="settings-field">
                <label className="field-label" htmlFor="ingest-new-vault">
                  New vault
                </label>
                <div className="settings-row">
                  <input
                    id="ingest-new-vault"
                    type="text"
                    value={newVaultName}
                    placeholder="Studio notes"
                    onChange={(e) => setNewVaultName(e.target.value)}
                  />
                  <AsyncButton
                    onClick={onCreateVault}
                    disabled={newVaultName.trim() === ""}
                    spinnerTone="neutral"
                  >
                    Create vault
                  </AsyncButton>
                </div>
              </div>
            </div>
            {vaultError !== null && (
              <p className="muted" role="alert" style={{ margin: 0 }}>
                {vaultError}
              </p>
            )}

            <div className="settings-actions">
              <AsyncButton
                className="primary"
                onClick={onStart}
                disabled={vaultId === "" || ingestStarting}
              >
                Start ingest
              </AsyncButton>
            </div>
            <Banner show={ingestError !== null} role="alert">
              {ingestError}
            </Banner>
          </div>
        </section>

        <section className="settings-section" aria-label="LLM">
          <span className="subhead">LLM</span>
          <div className="settings-form" style={{ marginTop: "var(--sp-2)" }}>
            <div className="settings-field">
              <label className="field-label" htmlFor="llm-model">
                Model
              </label>
              <input
                id="llm-model"
                type="text"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                onBlur={saveLlm}
              />
            </div>
            <div className="settings-actions">
              <AsyncButton onClick={runTestConnection} spinnerTone="neutral">
                Test connection
              </AsyncButton>
            </div>
            <Banner show={testMessage !== null} role={testFailed ? "alert" : "status"}>
              {testMessage}
            </Banner>
          </div>
        </section>

        <section className="settings-section" aria-label="Deep quality sweep">
          <span className="subhead">Deep quality sweep</span>
          <div className="settings-form" style={{ marginTop: "var(--sp-2)" }}>
            <div className="settings-row" style={{ alignItems: "center" }}>
              <Switch
                checked={sweepOn}
                onChange={(next) => void onToggleSweep(next)}
                ariaLabel="Deep quality sweep"
              />
              <span className="field-label">Deep quality sweep</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Fills gaps and triages notability. Adds LLM calls. Off by default.
            </p>
            {/* The UI-SPEC declares this as a separate line, so it repeats the
                sentence above by contract, not by accident. */}
            <p className="muted" style={{ margin: 0 }}>
              Off by default.
            </p>
          </div>
        </section>

        <section className="settings-section" aria-label="Fetch">
          <span className="subhead">Fetch</span>
          <div className="settings-grid" style={{ marginTop: "var(--sp-2)" }}>
            <div className="settings-field">
              <label className="field-label" htmlFor="fetch-delay">
                Delay (ms)
              </label>
              <input
                id="fetch-delay"
                type="number"
                min={0}
                value={fetchDelayMs}
                onChange={(e) => setFetchDelayMs(e.target.value)}
                onBlur={saveFetch}
              />
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="fetch-concurrency">
                Concurrency
              </label>
              <input
                id="fetch-concurrency"
                type="number"
                min={1}
                value={fetchConcurrency}
                onChange={(e) => setFetchConcurrency(e.target.value)}
                onBlur={saveFetch}
              />
            </div>
            <div className="settings-field">
              <label className="field-label" htmlFor="fetch-language">
                Language
              </label>
              <input
                id="fetch-language"
                type="text"
                value={fetchLanguage}
                onChange={(e) => setFetchLanguage(e.target.value)}
                onBlur={saveFetch}
              />
            </div>
          </div>
        </section>

        <section className="settings-section" aria-label="YouTube cookie">
          <span className="subhead">YouTube cookie</span>
          {settings === null || settings === undefined ? (
            <p className="muted" aria-busy="true" style={{ margin: 0 }}>
              Checking…
            </p>
          ) : settings.hasYoutubeCookie ? (
            <p className="muted" style={{ margin: 0 }}>
              Cookie saved{" "}
              {settings.youtubeCookieUpdatedAt === null ||
              settings.youtubeCookieUpdatedAt === undefined
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

          <div className="settings-field" style={{ marginTop: "var(--sp-2)" }}>
            <label className="field-label" htmlFor="youtube-cookie-header">
              Cookie header
            </label>
            <textarea
              id="youtube-cookie-header"
              rows={3}
              value={cookieHeader}
              placeholder="SID=...; HSID=...; SSID=..."
              onChange={(e) => setCookieHeader(e.target.value)}
            />
            <div className="settings-actions">
              <AsyncButton onClick={onSaveCookieHeader} spinnerTone="neutral">
                Save pasted cookies
              </AsyncButton>
            </div>
          </div>

          <Banner show={cookieNotice !== null} role="status">
            {cookieNotice}
          </Banner>
        </section>

        <section className="settings-section" aria-label="Server">
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
