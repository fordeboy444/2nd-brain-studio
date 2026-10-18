import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";
import { useStore, type AppState } from "../store.js";
import type {
  PreviewResult,
  SettingsPayload,
  TestLlmResult,
  Vault,
} from "../lib/api.js";
import { clearToasts, getToasts } from "../lib/toast.js";

/**
 * The Settings cookie block, driven through the real screen and the real store
 * over a stubbed HTTP boundary.
 *
 * The subject is the user path, not the module: a chosen file has to leave the
 * browser as `text/plain` and the screen has to say exactly what happened. The
 * stub records the body so the test can assert the raw Netscape text crossed
 * the boundary without a JSON envelope.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COOKIE_TEXT =
  "www.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tSECRET-COOKIE-VALUE\n";

function settingsPayload(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    settings: {
      llm: { model: "llama", concurrency: 1, requestTimeoutMs: 1000, maxRetries: 3 },
      fetch: { delayMs: 1000, concurrency: 2, language: "en" },
      // The server's default: the expensive sweep is opt-in.
      sweep: { enabled: false },
      ui: { theme: "system" },
    },
    hasYoutubeCookie: false,
    youtubeCookieUpdatedAt: null,
    hasSupadataKey: false,
    llmConfigured: true,
    ...over,
  };
}

const INITIAL: Partial<AppState> = {
  settings: null,
  settingsLoading: false,
  settingsError: null,
  testLlmResult: null,
  previewResult: null,
  previewLoading: false,
  previewError: null,
  ingestStarting: false,
  ingestError: null,
  vaults: [],
  vaultsLoading: false,
  vaultsError: null,
  health: {
    ok: true,
    status: "healthy",
    service: "2nd-brain",
    version: "0.1.0",
    uptimeSec: 10,
    time: "2026-10-18T12:00:00Z",
  },
  healthError: null,
  activeOverlay: "settings",
  overlayOpen: true,
};

const VAULT: Vault = {
  id: "v1",
  name: "Studio",
  path: "/data/vaults/studio",
  sourceKind: "manual",
  createdAt: "2026-10-18T12:00:00Z",
  lastOpenedAt: "2026-10-18T12:00:00Z",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Stub {
  uploadStatus: number;
  deleteStatus: number;
  current: SettingsPayload;
  uploads: Array<{ contentType: string; body: string }>;
  headerUploads: Array<{ contentType: string; body: string }>;
  headerStatus: number;
  deletes: number;
  settingsPuts: number;
  settingsPutStatus: number;
  settingsPatches: Array<Record<string, unknown>>;
  vaults: Vault[];
  tests: number;
  testResult: TestLlmResult;
  previewStatus: number;
  previewResult: PreviewResult;
  previews: Array<Record<string, unknown>>;
  starts: Array<Record<string, unknown>>;
  startStatus: number;
  startHold: { promise: Promise<void>; release: () => void } | null;
}

let stub: Stub;

function stubServer(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings" && method === "GET") return json(stub.current);
    if (url === "/api/settings" && method === "PUT") {
      stub.settingsPuts += 1;
      const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      stub.settingsPatches.push(patch);
      if (stub.settingsPutStatus !== 200) {
        return json({ error: "io", message: "nope" }, stub.settingsPutStatus);
      }
      const sweep = patch.sweep as { enabled?: boolean } | undefined;
      if (sweep?.enabled !== undefined) {
        stub.current = {
          ...stub.current,
          settings: { ...stub.current.settings, sweep: { enabled: sweep.enabled } },
        };
      }
      return json(stub.current);
    }

    if (url === "/api/vaults" && method === "GET") return json(stub.vaults);
    if (url === "/api/vaults" && method === "POST") {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name;
      const created: Vault = {
        id: "v-new",
        name,
        path: `/data/vaults/${name}`,
        sourceKind: "manual",
        createdAt: "2026-10-18T12:00:00Z",
        lastOpenedAt: "2026-10-18T12:00:00Z",
      };
      stub.vaults = [...stub.vaults, created];
      return json(created, 201);
    }

    if (url === "/api/settings/test-llm" && method === "POST") {
      stub.tests += 1;
      return json(stub.testResult);
    }

    if (url === "/api/jobs/preview" && method === "POST") {
      stub.previews.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (stub.previewStatus !== 200) {
        return json({ error: "bad_request", message: "nope" }, stub.previewStatus);
      }
      return json(stub.previewResult);
    }

    if (url === "/api/jobs" && method === "POST") {
      stub.starts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (stub.startHold !== null) await stub.startHold.promise;
      if (stub.startStatus !== 201) {
        return json({ error: "bad_request", message: "nope" }, stub.startStatus);
      }
      return json({ id: "j1", status: "queued" }, 201);
    }

    if (url === "/api/settings/youtube-cookie" && method === "POST") {
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
      stub.uploads.push({
        contentType: headers.get("content-type") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (stub.uploadStatus !== 200) {
        return json(
          { error: "invalid_cookie", message: "The body is not a valid Netscape cookie file." },
          stub.uploadStatus,
        );
      }
      stub.current = settingsPayload({
        hasYoutubeCookie: true,
        youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z",
      });
      return json({
        hasYoutubeCookie: true,
        youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z",
      });
    }

    if (url === "/api/settings/youtube-cookie/header" && method === "POST") {
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
      stub.headerUploads.push({
        contentType: headers.get("content-type") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (stub.headerStatus !== 200) {
        return json(
          {
            error: "invalid_cookie_header",
            message: "The Cookie header is not usable (bad_pair).",
          },
          stub.headerStatus,
        );
      }
      stub.current = settingsPayload({
        hasYoutubeCookie: true,
        youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z",
      });
      return json({ ok: true });
    }

    if (url === "/api/settings/youtube-cookie" && method === "DELETE") {
      stub.deletes += 1;
      if (stub.deleteStatus !== 200) {
        return json({ error: "io", message: "disk" }, stub.deleteStatus);
      }
      stub.current = settingsPayload({ hasYoutubeCookie: false });
      return json({ hasYoutubeCookie: false });
    }

    return json({});
  }) as unknown as typeof fetch;
}

interface Mounted {
  host: HTMLElement;
  render: (fn: () => void) => Promise<void>;
  unmount: () => Promise<void>;
}

const mounted: Array<{ root: Root; host: HTMLElement; done: boolean }> = [];

async function mountSettings(): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host, done: false };
  mounted.push(entry);

  const render = async (fn: () => void) => {
    await act(async () => {
      fn();
    });
  };
  const unmount = async () => {
    if (entry.done) return;
    entry.done = true;
    await render(() => root.unmount());
    host.remove();
  };

  await render(() => root.render(<Settings />));
  return { host, render, unmount };
}

/** Choose a local file, as a real picker would. */
async function chooseCookie(
  host: HTMLElement,
  render: Mounted["render"],
  text = COOKIE_TEXT,
): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no cookie file input");
  const file = new File([text], "cookies.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await render(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function field(host: HTMLElement, id: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) throw new Error(`no field #${id}`);
  return input;
}

/** Set a controlled input through React's own value setter, then raise `input`. */
async function typeInto(
  render: Mounted["render"],
  host: HTMLElement,
  id: string,
  value: string,
): Promise<HTMLInputElement> {
  const input = field(host, id);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no input value setter");
  await render(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

/** The same controlled-value trick, for a textarea (its prototype's setter). */
async function typeIntoTextarea(
  render: Mounted["render"],
  host: HTMLElement,
  id: string,
  value: string,
): Promise<HTMLTextAreaElement> {
  const area = host.querySelector<HTMLTextAreaElement>(`#${id}`);
  if (area === null) throw new Error(`no textarea #${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no textarea value setter");
  await render(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return area;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function holdStart(): void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  stub.startHold = { promise, release };
}

beforeEach(() => {
  useStore.setState(INITIAL);
  clearToasts();
  stub = {
    uploadStatus: 200,
    deleteStatus: 200,
    current: settingsPayload(),
    uploads: [],
    headerUploads: [],
    headerStatus: 200,
    deletes: 0,
    settingsPuts: 0,
    settingsPutStatus: 200,
    settingsPatches: [],
    vaults: [VAULT],
    tests: 0,
    testResult: { ok: true, latencyMs: 42 },
    previewStatus: 200,
    previewResult: {
      found: 12,
      selected: 5,
      skipped: [],
      estimatedCalls: 9,
      estimatedMinutes: 4,
    },
    previews: [],
    starts: [],
    startStatus: 201,
    startHold: null,
  };
  stubServer();
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    if (entry.done) {
      entry.host.remove();
      continue;
    }
    entry.done = true;
    await act(async () => entry.root.unmount());
    entry.host.remove();
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const originalFetch = globalThis.fetch;

it("sends the chosen file as a raw text/plain body and says it was saved", async () => {
  const { host, render } = await mountSettings();

  expect(stub.uploads.length).toBe(0);
  await chooseCookie(host, render);

  expect(stub.uploads.length).toBe(1);
  expect(stub.uploads[0]?.contentType).toContain("text/plain");
  expect(stub.uploads[0]?.body).toBe(COOKIE_TEXT);
  expect(host.textContent).toContain("YouTube cookie saved.");
  // The body is never rendered, and never held anywhere a render could reach.
  expect(host.textContent).not.toContain("SECRET-COOKIE-VALUE");
});

it("renders the exact failure copy when the server rejects the cookie", async () => {
  stub.uploadStatus = 400;
  const { host, render } = await mountSettings();

  await chooseCookie(host, render, "not a cookie file");

  expect(host.textContent).toContain("Cookie must be Netscape format.");
  expect(host.textContent).not.toContain("YouTube cookie saved.");
});

it("says no cookie is uploaded when the status reports none", async () => {
  const { host } = await mountSettings();
  expect(host.textContent).toContain("No YouTube cookie uploaded.");
});

it("asks the exact confirmation before deleting and reports success", async () => {
  stub.current = settingsPayload({ hasYoutubeCookie: true, youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z" });
  const { host, render } = await mountSettings();

  const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Remove cookie",
  );
  expect(remove).toBeTruthy();
  await render(() => remove!.click());

  // The confirm is portalled out of the settings card.
  expect(document.body.textContent).toContain("Remove the saved YouTube cookie?");
  expect(stub.deletes).toBe(0);

  const confirm = document.querySelector<HTMLButtonElement>(".confirm-actions .primary");
  expect(confirm).toBeTruthy();
  await render(() => confirm!.click());

  expect(stub.deletes).toBe(1);
  expect(host.textContent).toContain("YouTube cookie removed.");
  expect(host.textContent).toContain("No YouTube cookie uploaded.");
});

it("renders the exact delete failure copy", async () => {
  stub.current = settingsPayload({ hasYoutubeCookie: true });
  stub.deleteStatus = 500;
  const { host, render } = await mountSettings();

  const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Remove cookie",
  );
  await render(() => remove!.click());
  const confirm = document.querySelector<HTMLButtonElement>(".confirm-actions .primary");
  await render(() => confirm!.click());

  expect(host.textContent).toContain("Couldn't remove the YouTube cookie. Try again in a moment.");
});

it("renders the ingest form, the LLM block, the fetch block and both CTAs", async () => {
  const { host } = await mountSettings();

  for (const id of [
    "ingest-source-url",
    "ingest-max-videos",
    "ingest-date-from",
    "ingest-date-to",
    "ingest-min-duration",
    "ingest-language",
    "llm-model",
    "fetch-delay",
    "fetch-concurrency",
    "fetch-language",
  ]) {
    expect(field(host, id)).toBeTruthy();
  }
  expect(host.textContent).toContain("Preview selection");
  expect(host.textContent).toContain("Start ingest");
  expect(host.textContent).toContain("Test connection");
});

it("renders the server's estimate verbatim after a preview", async () => {
  const { host, render } = await mountSettings();
  await typeInto(render, host, "ingest-source-url", "https://www.youtube.com/@studio");

  await render(() => buttonByText(host, "Preview selection").click());

  expect(stub.previews.length).toBe(1);
  expect(stub.previews[0]?.kind).toBe("youtube");
  expect(stub.previews[0]?.channelUrl).toBe("https://www.youtube.com/@studio");
  expect(host.textContent).toContain("Estimated 9 LLM calls, about 4 min after commit.");
});

it("keeps every value and shows the exact copy when a preview fails", async () => {
  stub.previewStatus = 500;
  const { host, render } = await mountSettings();
  await typeInto(render, host, "ingest-source-url", "https://www.youtube.com/@studio");
  await typeInto(render, host, "ingest-max-videos", "10");
  await typeInto(render, host, "ingest-date-from", "2026-01-01");

  await render(() => buttonByText(host, "Preview selection").click());

  expect(host.textContent).toContain(
    "Couldn't preview this source. Check the URL and try again.",
  );
  expect(field(host, "ingest-source-url").value).toBe("https://www.youtube.com/@studio");
  expect(field(host, "ingest-max-videos").value).toBe("10");
  expect(field(host, "ingest-date-from").value).toBe("2026-01-01");
  expect(host.textContent).not.toContain("Estimated");
});

it("disables Start ingest while a submit is in flight and starts one job", async () => {
  holdStart();
  const { host, render } = await mountSettings();
  const start = buttonByText(host, "Start ingest");
  expect(start.disabled).toBe(false);

  await render(() => {
    start.click();
    // The second press is in the same tick: the guard must see the first.
    start.click();
  });

  expect(start.disabled).toBe(true);
  expect(start.getAttribute("aria-busy")).toBe("true");
  expect(stub.starts.length).toBe(1);
  expect(useStore.getState().ingestStarting).toBe(true);

  await render(() => stub.startHold?.release());

  expect(stub.starts.length).toBe(1);
  expect(useStore.getState().ingestStarting).toBe(false);
  expect(useStore.getState().activeOverlay).toBe("jobs");
});

it("shows the exact start-failure copy and keeps the typed values", async () => {
  stub.startStatus = 400;
  const { host, render } = await mountSettings();
  await typeInto(render, host, "ingest-source-url", "https://www.youtube.com/@studio");
  await typeInto(render, host, "ingest-min-duration", "300");

  await render(() => buttonByText(host, "Start ingest").click());

  expect(stub.starts.length).toBe(1);
  expect(host.textContent).toContain(
    "Couldn't start the job. Check the source URL and try again.",
  );
  expect(field(host, "ingest-source-url").value).toBe("https://www.youtube.com/@studio");
  expect(field(host, "ingest-min-duration").value).toBe("300");
});

it("shows the exact Test connection success copy", async () => {
  stub.testResult = { ok: true, latencyMs: 37 };
  const { host, render } = await mountSettings();

  await render(() => buttonByText(host, "Test connection").click());

  expect(stub.tests).toBe(1);
  expect(host.textContent).toContain("Ollama replied in 37 ms.");
});

it("shows the exact Test connection failure copy", async () => {
  stub.testResult = { ok: false, reason: "timeout" };
  const { host, render } = await mountSettings();

  await render(() => buttonByText(host, "Test connection").click());

  expect(host.textContent).toContain("Test failed: timeout.");
});

it("says the key is missing when the server is unconfigured", async () => {
  stub.current = settingsPayload({ llmConfigured: false });
  const { host } = await mountSettings();

  expect(host.textContent).toContain("Set OLLAMA_API_KEY and restart.");
});

/* -------------------------------------------------------------------------
   Pasted Cookie header
   ------------------------------------------------------------------------- */

const PASTED = "SID=MARKER-paste-7a1e2c-do-not-render; PREF=en-US";

it("sends a pasted Cookie header as text/plain, then clears it and never renders it", async () => {
  const { host, render } = await mountSettings();

  const area = await typeIntoTextarea(render, host, "youtube-cookie-header", `  ${PASTED}  `);
  expect(stub.headerUploads.length).toBe(0);

  await render(() => buttonByText(host, "Save pasted cookies").click());

  expect(stub.headerUploads.length).toBe(1);
  expect(stub.headerUploads[0]?.contentType).toContain("text/plain");
  expect(stub.headerUploads[0]?.contentType).not.toContain("json");
  expect(stub.headerUploads[0]?.body).toBe(PASTED);
  expect(host.textContent).toContain("YouTube cookie saved.");
  expect(area.value).toBe("");
  // The credential is in the request body and nowhere the user can read it.
  expect(host.textContent).not.toContain("MARKER-paste-7a1e2c-do-not-render");
});

it("keeps the pasted text and shows the exact copy when the header is rejected", async () => {
  stub.headerStatus = 400;
  const { host, render } = await mountSettings();

  await typeIntoTextarea(render, host, "youtube-cookie-header", PASTED);
  await render(() => buttonByText(host, "Save pasted cookies").click());

  expect(stub.headerUploads.length).toBe(1);
  expect(host.textContent).toContain(
    "Cookie header must look like name=value; name=value.",
  );
  expect(host.textContent).not.toContain("YouTube cookie saved.");
  expect(host.querySelector<HTMLTextAreaElement>("#youtube-cookie-header")?.value).toBe(
    PASTED,
  );
});

it("sends nothing and asks for a header when the textarea is empty", async () => {
  const { host, render } = await mountSettings();

  await typeIntoTextarea(render, host, "youtube-cookie-header", "   ");
  await render(() => buttonByText(host, "Save pasted cookies").click());

  expect(stub.headerUploads.length).toBe(0);
  expect(host.textContent).toContain("Paste a Cookie header first.");
  expect(host.textContent).not.toContain("YouTube cookie saved.");
});

/* -------------------------------------------------------------------------
   Deep quality sweep
   ------------------------------------------------------------------------- */

function payloadWithSweep(enabled: boolean): SettingsPayload {
  const base = settingsPayload();
  return { ...base, settings: { ...base.settings, sweep: { enabled } } };
}

function sweepSwitch(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Deep quality sweep"]',
  );
  if (input === null) throw new Error("no sweep switch");
  return input;
}

async function toggleSweep(
  host: HTMLElement,
  render: Mounted["render"],
): Promise<HTMLInputElement> {
  const input = sweepSwitch(host);
  await render(() => input.click());
  // The toggle starts an async save; let its continuation land before asserting.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return input;
}

it("renders the sweep switch off by default with the exact label, help and off line", async () => {
  const { host } = await mountSettings();

  const section = host.querySelector('section[aria-label="Deep quality sweep"]');
  expect(section).toBeTruthy();
  expect(section?.textContent).toContain("Deep quality sweep");
  expect(section?.textContent).toContain(
    "Fills gaps and triages notability. Adds LLM calls. Off by default.",
  );
  expect(
    [...(section?.querySelectorAll("p") ?? [])].some(
      (p) => p.textContent === "Off by default.",
    ),
  ).toBe(true);
  expect(sweepSwitch(host).checked).toBe(false);
});

it("shows the value the server persisted", async () => {
  stub.current = payloadWithSweep(true);
  const { host } = await mountSettings();

  expect(sweepSwitch(host).checked).toBe(true);
});

it("saves the sweep toggle and leaves the new value in place on success", async () => {
  const { host, render } = await mountSettings();

  const input = await toggleSweep(host, render);

  expect(stub.settingsPuts).toBe(1);
  expect(stub.settingsPatches[0]).toEqual({ sweep: { enabled: true } });
  expect(input.checked).toBe(true);
  expect(getToasts()).toEqual([]);
});

it("keeps typed fields when a settings save refreshes the server copy", async () => {
  const { host, render } = await mountSettings();
  await typeInto(render, host, "llm-model", "typed-model");
  await typeInto(render, host, "fetch-language", "fr");

  // The sweep save replaces the store's settings object with the server copy.
  await toggleSweep(host, render);

  expect(field(host, "llm-model").value).toBe("typed-model");
  expect(field(host, "fetch-language").value).toBe("fr");
  expect(sweepSwitch(host).checked).toBe(true);
});

it("reverts the sweep switch and shows the exact toast when the save fails", async () => {
  stub.settingsPutStatus = 500;
  const { host, render } = await mountSettings();

  const input = await toggleSweep(host, render);

  expect(stub.settingsPuts).toBe(1);
  // The switch never shows a value the server did not accept.
  expect(input.checked).toBe(false);
  const toasts = getToasts();
  expect(toasts.map((t) => t.text)).toEqual([
    "Couldn't save the sweep setting. Try again in a moment.",
  ]);
  expect(toasts[0]?.tone).toBe("error");
});
