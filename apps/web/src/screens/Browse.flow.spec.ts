import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse.js";
import { isDirty, useStore, type AppState } from "../store.js";
import type { Vault } from "../lib/api.js";

/**
 * The tracer's end-to-end gate: tree → tab → editor → `PUT /api/file`.
 *
 * The first test drives the whole path, because the thing worth pinning is not
 * any single component — it is that the hops between them are still connected. A
 * spec that only asserted "the tree rendered" would stay green if `VaultTree`
 * stopped calling `listTree`, if a row click stopped opening a tab, or if the
 * save shortcut stopped reaching `writeFile`; those are the exact three ways
 * this feature breaks, so each one is asserted on the wire.
 *
 * The network is a stub, and it is a stub of the SERVER's contract, not of our
 * client: it answers the tree route, the read route and the write route with the
 * shapes `apps/server` returns, including a fresh base hash on the write. A real
 * fetch could not complete here — the URLs are same-origin relative paths, which
 * is also the guarantee `api.spec.ts` pins.
 */

// `act` needs to be told it is running in an act environment. Without this flag
// React still queues the work, but it logs "The current testing environment is
// not configured to support act(...)" for every update that lands while a queue
// is open — which is every update these tests make on purpose. There is no
// component-testing library here to set it for us (and none is approved).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT: Vault = {
  id: "v1",
  name: "Studio",
  path: "/data/vaults/studio",
  sourceKind: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

const TREE = {
  dir: ".",
  entries: [
    { id: "Notes", name: "Notes", path: "Notes", isDir: true, childrenLoaded: false },
    { id: "Alpha.md", name: "Alpha.md", path: "Alpha.md", isDir: false, childrenLoaded: false, modified: 1 },
  ],
};

/** The hashes the stub hands out. The write's hash differs from the read's, so
 *  "the returned hash became the new base" is a real assertion and not a
 *  tautology. */
const READ_HASH = "hash-from-read";
const WRITE_HASH = "hash-from-write";

const READ_CONTENT = "# Alpha\n\nfirst line\n";
const EDITED = "# Alpha\n\nfirst line, edited\n";

/** What the stub reports as being on disk when a save conflicts, and the hash
 *  that would make the next write land. Different from both READ_HASH and
 *  WRITE_HASH, so "the conflict's hash was sent" cannot pass by accident. */
const DISK_CONTENT = "# Alpha\n\nsomeone else got there first\n";
const DISK_HASH = "hash-from-the-other-writer";

interface Call {
  url: string;
  method: string;
  body: string;
}

const INITIAL: Partial<AppState> = {
  currentVault: VAULT,
  tabs: [],
  activeTabPath: null,
  rightPanelOpen: false,
  rightPanelTab: "backlinks",
  activeOverlay: "none",
  overlayOpen: false,
  conflict: null,
  saveError: null,
  backlinks: [],
  pendingRevealLine: null,
  pendingTreeRefresh: null,
  // The vaults slice too: it is what the delete tests read off the store, and a
  // list left over from the previous test would answer for the wrong one.
  vaults: [],
  vaultsLoading: false,
  vaultsError: null,
};

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

/** The server's answer to `DELETE /api/vaults/:id`. Replaced by the tests that
 *  need a vault that is already gone. */
let deleteAnswer: () => Response = () => json({ deleted: true, id: VAULT.id });

/** When set, the next write answers 409 with this — the file moved on disk. */
let conflictOnWrite: { currentContent: string; currentHash: string } | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A directory's children are a DIFFERENT listing from the root's — a stub that
 *  answered every level with the root level would describe a vault whose every
 *  folder contains itself, which is not a vault any server returns. */
function treeFor(url: string) {
  if (decodeURIComponent(url).includes("dir=Notes")) {
    return {
      dir: "Notes",
      entries: [
        { id: "Notes/Deep.md", name: "Deep.md", path: "Notes/Deep.md", isDir: false, childrenLoaded: false },
      ],
    };
  }
  return TREE;
}

function route(url: string, method: string): Response {
  if (url.includes("/api/vaults/v1/tree")) return json(treeFor(url));
  if (method === "DELETE" && url.includes("/api/vaults/")) return deleteAnswer();
  if (url.includes("/api/vaults")) return json([VAULT]);
  if (url.includes("/api/health")) {
    return json({ ok: true, status: "ok", service: "2nd-brain", version: "0.1.0", uptimeSec: 1, time: "t" });
  }
  if (url.includes("/api/file")) {
    if (method === "PUT") {
      // The file moved on disk: the server refuses the write and hands back
      // what is there instead. This is the 409 the conflict flow exists for.
      if (conflictOnWrite) {
        return json(
          {
            error: "conflict",
            message: "This file changed on disk since you opened it.",
            ...conflictOnWrite,
          },
          409,
        );
      }
      return json({ path: "Alpha.md", baseHash: WRITE_HASH });
    }
    return json({ path: "Alpha.md", content: READ_CONTENT, baseHash: READ_HASH });
  }
  return json({});
}

/** A stub that answers everything, and records what it was asked. */
function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    return route(url, method);
  }) as unknown as typeof fetch;
}

/** A stub whose write NEVER settles until the returned `release` is called —
 *  the only way to observe a save that is still in flight. */
function stubFetchHoldingTheWrite() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    if (method === "PUT") {
      await held;
      return json({ path: "Alpha.md", baseHash: WRITE_HASH });
    }
    return route(url, method);
  }) as unknown as typeof fetch;
  return release;
}

beforeEach(() => {
  calls = [];
  conflictOnWrite = null;
  deleteAnswer = () => json({ deleted: true, id: VAULT.id });
  useStore.setState(INITIAL);
  stubFetch();
});

/** Mounted roots, unmounted between tests: a root left alive keeps processing
 *  the previous test's promises and its DOM would still answer `querySelector`
 *  in the next one. */
const roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const { root, host } of roots.splice(0)) {
      root.unmount();
      host.remove();
    }
  });
  globalThis.fetch = originalFetch;
  useStore.setState(INITIAL);
  vi.restoreAllMocks();
});

function callsTo(fragment: string): Call[] {
  return calls.filter((c) => c.url.includes(fragment));
}

/** Mount for real. React 19's `act` comes from `react`; `createRoot` from
 *  `react-dom/client` — no test renderer, no component-testing library. */
async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(createElement(Browse));
  });
  return host;
}

/** A bubbling click, the way a pointer produces one — React listens at the root
 *  container, so the event has to travel from the row up to it. */
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** The platform's save shortcut, as a bubbling keydown on the window. */
async function pressSave() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  });
}

/** Let every pending microtask (and the state updates behind it) land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findRow(host: HTMLElement, label: string): Element {
  const row = Array.from(host.querySelectorAll(".tree-row")).find((r) =>
    r.textContent?.includes(label),
  );
  expect(row, `no tree row labelled ${label}`).toBeTruthy();
  return row!;
}

/** Find a button by its exact label, anywhere under `root`. Labels rather than
 *  classes: the copy IS the contract for these actions. */
function findButton(root: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button, `no button labelled ${label}`).toBeTruthy();
  return button as HTMLButtonElement;
}

/** The per-row delete control, which is a SIBLING of the row's open button. */
function findDeleteButton(host: HTMLElement, vaultName: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="Delete vault ${vaultName}"]`);
  expect(button, `no delete button for ${vaultName}`).toBeTruthy();
  return button!;
}

/** Type into a controlled input the way a person does: set the value through
 *  React's own setter, then fire the event React listens for. Writing
 *  `input.value` directly moves the DOM without React ever hearing about it. */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The confirm dialog is portalled to `document.body`, so it is not inside the
 *  mounted host and cannot be found through it. */
function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".confirm-dialog");
  expect(el, "no confirm dialog is open").toBeTruthy();
  return el!;
}

function confirmInput(): HTMLInputElement {
  const input = dialog().querySelector<HTMLInputElement>('input[aria-label="Confirm vault name"]');
  expect(input, "the confirm dialog has no name input").toBeTruthy();
  return input!;
}

describe("Browse, end to end", () => {
  it("walks tree → tab → editor → PUT /api/file without a hop falling out", async () => {
    const host = await mount();

    // 1. The mount read the tree. This is the hop that fails silently if
    //    `VaultTree` stops asking for the root level.
    const treeCalls = callsTo("/api/vaults/v1/tree");
    expect(treeCalls.length).toBe(1);
    expect(treeCalls[0]!.method).toBe("GET");
    await settle();

    // 2. The rows are real rows, labelled by the path rule (extension hidden).
    await click(findRow(host, "Alpha"));

    // 3. Clicking it opens exactly one tab, holding the server's content.
    const tabs = useStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0]!.path).toBe("Alpha.md");
    expect(tabs[0]!.buffer).toBe(READ_CONTENT);
    expect(useStore.getState().activeTabPath).toBe("Alpha.md");

    // ...and the editor region is showing that content, not merely holding it.
    const content = host.querySelector(".cm-content");
    expect(content).toBeTruthy();
    expect(content!.textContent).toContain("first line");

    // 4. Edit, then the platform's save shortcut.
    await act(async () => {
      useStore.getState().setBuffer(EDITED);
    });
    expect(isDirty(useStore.getState().tabs[0]!)).toBe(true);

    await pressSave();

    const writes = callsTo("/api/file").filter((c) => c.method === "PUT");
    expect(writes.length).toBe(1);
    const body = JSON.parse(writes[0]!.body) as Record<string, unknown>;
    expect(body.vault).toBe("v1");
    expect(body.path).toBe("Alpha.md");
    expect(body.content).toBe(EDITED);
    // The base hash is the one the READ returned — a client-computed hash would
    // agree with the server every time and the conflict check would be a lie.
    expect(body.baseHash).toBe(READ_HASH);

    // 5. The hash the write returned became the tab's new base, and the changed
    //    marker cleared because what is on screen is now what is on disk.
    const after = useStore.getState().tabs[0]!;
    expect(after.baseHash).toBe(WRITE_HASH);
    expect(isDirty(after)).toBe(false);
    expect(host.textContent).not.toContain("Unsaved changes");
  });

  it("refuses a second save for the same keystroke burst", async () => {
    const release = stubFetchHoldingTheWrite();
    const host = await mount();
    await settle();
    await click(findRow(host, "Alpha"));
    await act(async () => {
      useStore.getState().setBuffer(EDITED);
    });

    await pressSave();
    await pressSave();
    await pressSave();

    // Three presses, one write: the store's save is in flight and the second
    // request would send the same bytes for the same document.
    expect(callsTo("/api/file").filter((c) => c.method === "PUT").length).toBe(1);
    release();
    await settle();
    expect(useStore.getState().tabs[0]!.baseHash).toBe(WRITE_HASH);
  });

  it("opens one tab, not two, when the same file is clicked twice", async () => {
    const host = await mount();
    await settle();
    const alpha = findRow(host, "Alpha");
    await click(alpha);
    await click(alpha);

    expect(useStore.getState().tabs.length).toBe(1);
    // And the read happened once: clicking a file that is already open focuses
    // its tab, it does not re-fetch it.
    expect(callsTo("/api/file").length).toBe(1);
  });

  it("asks for a directory's children once, however many times it is expanded", async () => {
    const host = await mount();
    await settle();
    await click(findRow(host, "Notes"));

    const level = callsTo("/api/vaults/v1/tree").filter((c) =>
      decodeURIComponent(c.url).includes("dir=Notes"),
    );
    expect(level.length).toBe(1);
  });

  it("keeps the tree's loading indication inside the sidebar panel", async () => {
    // A root fetch that never settles, so the loading state can be observed.
    globalThis.fetch = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const host = await mount();

    expect(host.querySelector(".sidebar .spinner")).toBeTruthy();
    // Nothing covers the screen, and the editor region is still the editor.
    expect(host.querySelector(".modal-backdrop")).toBeNull();
    expect(host.querySelector(".editor-wrap")).toBeTruthy();
  });
});

/** Save a tab that the server is about to refuse, and land on the conflict. */
async function mountAndConflict(host: HTMLElement) {
  await settle();
  await click(findRow(host, "Alpha"));
  await act(async () => {
    useStore.getState().setBuffer(EDITED);
  });
  await pressSave();
  expect(useStore.getState().conflict).not.toBeNull();
}

describe("Browse, the 409 conflict (D-07)", () => {
  it("keeps the user's text exactly, and offers both answers", async () => {
    conflictOnWrite = { currentContent: DISK_CONTENT, currentHash: DISK_HASH };
    const host = await mount();
    await mountAndConflict(host);

    expect(useStore.getState().conflict).toEqual({
      path: "Alpha.md",
      currentContent: DISK_CONTENT,
      currentHash: DISK_HASH,
    });
    // The heart of D-07: the edit is NEITHER discarded NOR overwritten. Nothing
    // on this path assigns to the buffer, so it is still what the user typed.
    expect(useStore.getState().tabs[0]!.buffer).toBe(EDITED);
    expect(isDirty(useStore.getState().tabs[0]!)).toBe(true);

    expect(host.textContent).toContain("This file changed on disk since you opened it.");
    expect(findButton(host, "Reload from disk")).toBeTruthy();
    expect(findButton(host, "Keep mine")).toBeTruthy();
  });

  it("refuses a second save, so an unanswered question is never stacked on", async () => {
    conflictOnWrite = { currentContent: DISK_CONTENT, currentHash: DISK_HASH };
    const host = await mount();
    await mountAndConflict(host);

    const first = useStore.getState().conflict;
    await pressSave();
    await pressSave();

    // The same pending conflict, not a newer one and not a second banner.
    expect(useStore.getState().conflict).toBe(first);
    expect(host.querySelectorAll(".banner-slot")).toHaveLength(1);
    expect(callsTo("/api/file").filter((c) => c.method === "PUT").length).toBe(1);
  });

  it("Reload from disk is the only thing that replaces the buffer", async () => {
    conflictOnWrite = { currentContent: DISK_CONTENT, currentHash: DISK_HASH };
    const host = await mount();
    await mountAndConflict(host);

    await click(findButton(host, "Reload from disk"));

    const tab = useStore.getState().tabs[0]!;
    expect(tab.buffer).toBe(DISK_CONTENT);
    expect(tab.serverContent).toBe(DISK_CONTENT);
    expect(tab.baseHash).toBe(DISK_HASH);
    expect(isDirty(tab)).toBe(false);
    expect(useStore.getState().conflict).toBeNull();
    expect(host.textContent).not.toContain("This file changed on disk since you opened it.");
    // And the editor is showing what the store holds, not the text it replaced.
    expect(host.querySelector(".cm-content")?.textContent).toContain("someone else got there first");
  });

  it("Keep mine re-sends the user's text against the hash the conflict returned", async () => {
    conflictOnWrite = { currentContent: DISK_CONTENT, currentHash: DISK_HASH };
    const host = await mount();
    await mountAndConflict(host);

    // The file has stopped moving, so the deliberate overwrite can land.
    conflictOnWrite = null;
    await click(findButton(host, "Keep mine"));

    const writes = callsTo("/api/file").filter((c) => c.method === "PUT");
    expect(writes.length).toBe(2);
    const body = JSON.parse(writes[1]!.body) as Record<string, unknown>;
    // DISK_HASH, not READ_HASH: the tab's own base is the hash that just lost,
    // and sending it again is the same 409 twice.
    expect(body.baseHash).toBe(DISK_HASH);
    expect(body.content).toBe(EDITED);
    expect(useStore.getState().conflict).toBeNull();
    expect(useStore.getState().tabs[0]!.baseHash).toBe(WRITE_HASH);
  });
});

describe("Browse, deleting a vault (D-06)", () => {
  /** The vault list is the screen when no vault is open. */
  async function mountVaultList() {
    useStore.setState({ currentVault: null });
    const host = await mount();
    await settle();
    expect(findDeleteButton(host, VAULT.name)).toBeTruthy();
    return host;
  }

  it("offers no way to delete until the typed name is exactly the vault's", async () => {
    const host = await mountVaultList();
    await click(findDeleteButton(host, VAULT.name));

    expect(dialog().textContent).toContain("Delete vault Studio?");
    expect(dialog().textContent).toContain(
      "Type Studio to confirm permanent deletion. This cannot be undone.",
    );
    const confirm = () => findButton(dialog(), "Delete vault permanently");
    const input = confirmInput();

    expect(confirm().disabled).toBe(true);
    await typeInto(input, "studi");
    expect(confirm().disabled).toBe(true);
    // Whitespace around the name is NOT the name, and the server would answer
    // 400 for it — so the button must not offer it as if it would work.
    await typeInto(input, " Studio ");
    expect(confirm().disabled).toBe(true);
    await typeInto(input, "Studio");
    expect(confirm().disabled).toBe(false);
  });

  it("deletes on a matching name and reconciles the list", async () => {
    const host = await mountVaultList();
    await click(findDeleteButton(host, VAULT.name));
    await typeInto(confirmInput(), VAULT.name);
    await click(findButton(dialog(), "Delete vault permanently"));
    await settle();

    const deletes = callsTo("/api/vaults/v1").filter((c) => c.method === "DELETE");
    expect(deletes.length).toBe(1);
    // The key the server's route reads. Anything else is a 400 on every delete.
    expect(JSON.parse(deletes[0]!.body)).toEqual({ confirmName: VAULT.name });
    expect(useStore.getState().vaults).toEqual([]);
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(host.textContent).toContain("No vaults yet");
  });

  it("treats an already-gone vault as success rather than an error", async () => {
    deleteAnswer = () => json({ error: "not_found", message: "No vault with that id." }, 404);
    const host = await mountVaultList();
    await click(findDeleteButton(host, VAULT.name));
    await typeInto(confirmInput(), VAULT.name);
    await click(findButton(dialog(), "Delete vault permanently"));
    await settle();

    // The user asked for it gone and it is gone. A 404 is the same outcome, not
    // a failure — the list reconciles and nothing is reported.
    expect(useStore.getState().vaults).toEqual([]);
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(host.textContent).not.toContain("No vault with that id.");
  });

  it("leaves everything untouched when the server refuses the confirmation", async () => {
    deleteAnswer = () =>
      json({ error: "confirm_mismatch", message: "`confirmName` does not match the vault name." }, 400);
    const host = await mountVaultList();
    await click(findDeleteButton(host, VAULT.name));
    await typeInto(confirmInput(), VAULT.name);
    await click(findButton(dialog(), "Delete vault permanently"));
    await settle();

    // A 400 means nothing was removed: the vault is still listed, the dialog is
    // still up, and the reason is on screen.
    expect(useStore.getState().vaults).toHaveLength(1);
    expect(dialog().textContent).toContain("does not match the vault name");
    expect(host.textContent).not.toContain("No vaults yet");
  });
});
