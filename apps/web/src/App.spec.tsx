import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { useStore, type AppState } from "./store.js";
import type { Vault } from "./lib/api.js";

/**
 * The shell's contract, asserted on a real mount: three regions, an overlay slot
 * that renders nothing unless an overlay is open, and the four panel tabs.
 *
 * `vite build` proves the modules compile; it cannot prove that the shell has a
 * sidebar, that the reserved overlay values resolve to no content, or that the
 * header's panel button closes the panel it opened. Those are the behaviours the
 * next plans build on, so they are pinned here.
 */

const VAULT: Vault = {
  id: "v1",
  name: "Studio",
  path: "/data/vaults/studio",
  sourceKind: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

const INITIAL: Partial<AppState> = {
  currentVault: null,
  tabs: [],
  activeTabPath: null,
  rightPanelOpen: false,
  rightPanelTab: "backlinks",
  activeOverlay: "none",
  overlayOpen: false,
  jobs: [],
  jobsLoading: false,
  jobsError: null,
  selectedJobId: null,
  selectedJob: null,
  unitFeed: [],
  lastSeq: 0,
  sseState: "idle",
  stagesDone: [],
  activeStage: null,
  feedCapped: false,
};

async function mount(): Promise<{
  host: HTMLElement;
  render: (fn: () => void) => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (fn: () => void) => {
    await act(async () => {
      fn();
    });
  };
  // The first render must be awaited: the shell's regions are the subject here,
  // so asserting before React commits would test an empty div.
  await render(() => root.render(<App />));
  return { host, render };
}

const originalFetch = globalThis.fetch;

/**
 * The shell now mounts a tree that reads the vault it is showing, so this spec
 * needs a server to answer it — jsdom has no origin, and a real `fetch` of a
 * same-origin relative URL fails outright. The stub is the smallest one that
 * keeps these five assertions about the SHELL honest: an empty vault (so the
 * sidebar's own empty copy is what renders) and one readable file.
 */
function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/vaults/v1/tree")) return body({ dir: ".", entries: [] });
    if (url.includes("/api/vaults")) return body([]);
    if (url.includes("/api/jobs")) return body({ jobs: [] });
    if (url.includes("/api/health")) {
      return body({
        ok: true,
        status: "ok",
        service: "2nd-brain",
        version: "0.1.0",
        uptimeSec: 1,
        time: "t",
      });
    }
    if (url.includes("/api/file")) {
      if ((init?.method ?? "GET") === "PUT") return body({ path: "Notes/Alpha.md", baseHash: "h2" });
      return body({ path: "Notes/Alpha.md", content: "# Alpha", baseHash: "h1" });
    }
    return body({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  useStore.setState(INITIAL);
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it("renders the three regions with no overlay element while none is open", async () => {
  const { host } = await mount();
  expect(host.querySelector(".app-shell")).toBeTruthy();
  expect(host.querySelector(".sidebar")).toBeTruthy();
  expect(host.querySelector(".main-header")).toBeTruthy();
  expect(host.querySelector(".editor-wrap")).toBeTruthy();
  // Toasts live at the shell root, portalled out of it.
  expect(document.querySelector(".toast-viewport")).toBeTruthy();
  expect(host.querySelector(".overlay-slot")).toBeNull();
});

it("fills the sidebar and the tab strip when a vault and a file are open", async () => {
  const { host, render } = await mount();
  await render(() => {
    useStore.setState({
      currentVault: VAULT,
      health: {
        ok: true,
        status: "degraded",
        service: "2nd-brain",
        version: "0.1.0",
        uptimeSec: 125,
        time: "2026-01-01T00:00:00Z",
      },
    });
    useStore.getState().openFile(VAULT.id, "Notes/Alpha.md");
  });
  expect(host.querySelector(".sidebar-header .vault-name")?.textContent).toBe("Studio");
  expect(host.textContent).toContain("No files yet");
  // The label is the file name, extension stripped — one rule, one place.
  expect(host.querySelector(".tab .tab-label")?.textContent).toBe("Alpha");

  await render(() => useStore.getState().closeVault());
  expect(host.querySelector(".sidebar-header")).toBeNull();
  expect(host.querySelector(".tab")).toBeNull();
});

it("shows each right-panel tab's own empty state", async () => {
  const { host, render } = await mount();
  await render(() => useStore.getState().openRightPanel());
  expect(host.querySelector(".right-panel")).toBeTruthy();
  expect(host.textContent).toContain("No backlinks yet");
  await render(() => useStore.getState().setRightPanelTab("outline"));
  expect(host.textContent).toContain("No headings");
  await render(() => useStore.getState().setRightPanelTab("frontmatter"));
  expect(host.textContent).toContain("No frontmatter");
  await render(() => useStore.getState().setRightPanelTab("lint"));
  expect(host.textContent).toContain("No issues");
});

it("closes an open panel in one press of the header's panel button", async () => {
  const { host, render } = await mount();
  await render(() => useStore.getState().openRightPanel());
  const toggle = host.querySelector<HTMLButtonElement>(".panel-btn");
  expect(toggle).toBeTruthy();
  // A real press: pointerdown reaches the document (the panel's outside-click
  // rule) and then the click toggles. The button must be exempt from the first,
  // or the gesture closes and reopens the panel and can never close it.
  await render(() => {
    toggle!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    toggle!.click();
  });
  expect(host.querySelector(".right-panel")).toBeNull();
});

it("renders the settings and jobs overlays, and the reserved ones as an empty slot", async () => {
  const { host, render } = await mount();
  await render(() => {
    useStore.setState({
      health: {
        ok: true,
        status: "degraded",
        service: "2nd-brain",
        version: "0.1.0",
        uptimeSec: 125,
        time: "2026-01-01T00:00:00Z",
      },
    });
    useStore.getState().openOverlay("settings");
  });
  expect(host.querySelector('.overlay-slot[data-overlay="settings"] .modal')).toBeTruthy();
  expect(host.textContent).toContain(
    "Ollama API key is not configured. Paste it in the LLM section below, or set OLLAMA_API_KEY in the deployment environment.",
  );

  // `jobs` is a real screen now, and only its own overlay value renders it.
  await render(() => useStore.getState().openOverlay("jobs"));
  expect(
    host.querySelector('.overlay-slot[data-overlay="jobs"] .jobs-screen'),
  ).toBeTruthy();

  // `graph` is a real screen now; it renders inside its own overlay value.
  await render(() => useStore.getState().openOverlay("graph"));
  const slot = host.querySelector('.overlay-slot[data-overlay="graph"]');
  expect(slot).toBeTruthy();
  expect(host.querySelector(".graph-screen")).toBeTruthy();
  expect(host.querySelector(".jobs-screen")).toBeNull();

  await render(() => useStore.getState().closeOverlay());
  expect(host.querySelector(".overlay-slot")).toBeNull();
});
