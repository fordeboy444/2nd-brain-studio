import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";
import { useStore, type AppState } from "../store.js";
import type { SettingsPayload } from "../lib/api.js";

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
      sweep: { enabled: true },
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
  deletes: number;
}

let stub: Stub;

function stubServer(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings" && method === "GET") return json(stub.current);

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

beforeEach(() => {
  useStore.setState(INITIAL);
  stub = {
    uploadStatus: 200,
    deleteStatus: 200,
    current: settingsPayload(),
    uploads: [],
    deletes: 0,
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
