import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "./MarkdownView.js";
import { useStore, type AppState, type Tab } from "../store.js";
import { EMPTY_TREE, markLoaded } from "../lib/tree/lazyTree.js";
import type { TreeEntry, Vault } from "../lib/api.js";

/**
 * The read view's one security-shaped promise (UI-09): no anchor the renderer
 * produced can take the browser out of the app shell for an in-vault target.
 *
 * `linkResolve.spec.ts` proves the CLASSIFIER and `markdown.spec.ts` proves the
 * SANITIZER, and neither proves the thing that actually matters here: that this
 * component consults them and calls `preventDefault` before the browser gets the
 * click. A `MarkdownView` that rendered anchors and never intercepted would keep
 * every one of those tests green while replacing the shell with a file listing
 * the moment a note linked to a sibling — so the click itself is asserted, on a
 * real (bubbling) event, the way a pointer produces one.
 *
 * The document is real markdown, the tree is real `TreeState`, and `openFile` is
 * the store's own action: the assertion is that a tab opens, not that a spy was
 * called.
 */

// No component-testing library here (and none approved): `act` is told about the
// environment by hand, as in the tracer's flow spec.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT: Vault = {
  id: "v1",
  name: "Studio",
  path: "/data/vaults/studio",
  sourceKind: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

const DOC = [
  "---",
  "title: Alpha",
  "tags: [draft]",
  "---",
  "# Heading One",
  "",
  "A [vault note](notes/other.md), an [external](https://example.com/x), an [anchor](#heading-one) and a [gone note](gone.md).",
  "",
  "BODY SENTINEL",
].join("\n");

/** What the server last acknowledged. Different from the buffer in both halves,
 *  so "renders the buffer" is a real assertion: this content must NOT appear. */
const SERVER_CONTENT = "# Old heading\n\nSERVER SENTINEL\n";

/** The root level has been READ and lists `notes/` and `Alpha.md` — and nothing
 *  else. That is what makes `gone.md` definitively missing, while `notes/other.md`
 *  (in a directory nobody has opened) stays a link that may well be fine. */
function entry(name: string, isDir: boolean): TreeEntry {
  return { id: name, name, path: name, isDir, childrenLoaded: false };
}
const TREE = markLoaded(EMPTY_TREE, "", [entry("notes", true), entry("Alpha.md", false)]);

const TAB: Tab = {
  path: "Alpha.md",
  vaultId: VAULT.id,
  baseHash: "base-hash",
  serverContent: SERVER_CONTENT,
  buffer: DOC,
  loading: false,
  error: null,
  saving: false,
};

const INITIAL: Partial<AppState> = {
  currentVault: VAULT,
  tabs: [TAB],
  activeTabPath: TAB.path,
  treeState: TREE,
  activeOverlay: "none",
  overlayOpen: false,
  conflict: null,
  saveError: null,
  pendingRevealLine: null,
  pendingTreeRefresh: null,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useStore.setState(INITIAL);
  // `openFile` reads the file it opened, so the click's effect lands on the wire:
  // the stub answers the read route with a shape `apps/server` returns.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    const path = url.includes("path=") ? (url.split("path=")[1] ?? "") : "Alpha.md";
    return new Response(JSON.stringify({ path, content: "# Other\n", baseHash: "read-hash" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  unmountAll();
  globalThis.fetch = originalFetch;
  useStore.setState(INITIAL);
  vi.restoreAllMocks();
});

const roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

function unmountAll() {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(createElement(MarkdownView));
  });
  return host;
}

/** A bubbling, cancelable click — React listens at the root container, so the
 *  event has to travel from the anchor up to it. The return value is the DOM's
 *  own answer to "did anything call preventDefault". */
async function click(el: Element): Promise<boolean> {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function anchorFor(host: HTMLElement, text: string): HTMLAnchorElement {
  const anchor = Array.from(host.querySelectorAll("a")).find((a) =>
    a.textContent?.includes(text),
  );
  expect(anchor, `no anchor reading ${text}`).toBeTruthy();
  return anchor as HTMLAnchorElement;
}

describe("MarkdownView", () => {
  it("opens an in-vault link in a tab and never hands the click to the browser", async () => {
    const host = await mount();
    const prevented = await click(anchorFor(host, "vault note"));

    // The whole point: the browser was told to stand down.
    expect(prevented).toBe(true);
    expect(useStore.getState().activeTabPath).toBe("notes/other.md");
    expect(useStore.getState().tabs.map((t) => t.path)).toEqual(["Alpha.md", "notes/other.md"]);
  });

  it("leaves an external link to the browser, with the new-tab pair the sanitizer added", async () => {
    const host = await mount();
    const anchor = anchorFor(host, "external");

    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toContain("noopener");
    expect(anchor.getAttribute("rel")).toContain("noreferrer");
    expect(await click(anchor)).toBe(false);
  });

  it("leaves an in-document anchor to the browser", async () => {
    const host = await mount();
    expect(await click(anchorFor(host, "anchor"))).toBe(false);
  });

  it("renders a definitively missing link as a span with nothing to navigate to", async () => {
    const host = await mount();

    // `gone.md` is in a directory that HAS been read, and it is not there.
    expect(Array.from(host.querySelectorAll("a")).some((a) => a.textContent?.includes("gone"))).toBe(
      false,
    );
    const span = Array.from(host.querySelectorAll("span.md-link-broken")).find((s) =>
      s.textContent?.includes("gone note"),
    );
    expect(span, "no tolerated span for the missing note").toBeTruthy();
    expect(span?.getAttribute("href")).toBeNull();
    expect(span?.getAttribute("title")).toContain("gone.md");
  });

  it("renders the buffer, not the last server content, with the frontmatter left out", async () => {
    const host = await mount();
    const text = host.textContent ?? "";

    expect(text).toContain("BODY SENTINEL");
    expect(text).not.toContain("SERVER SENTINEL");
    expect(text).not.toContain("Old heading");
    // The block is the Frontmatter tab's subject, not the read view's.
    expect(text).not.toContain("title: Alpha");
    expect(host.querySelector("h1")?.textContent).toBe("Heading One");
  });

  it("refuses a hand-written javascript: anchor in the buffer", async () => {
    // Raw HTML in a note reaches the DOM only through the sanitizer — the second
    // pass, the one this component supplies. Both routes end the same way: no
    // anchor survives.
    useStore.setState({
      tabs: [{ ...TAB, buffer: 'See <a href="javascript:alert(1)">this</a>.\n' }],
    });
    const host = await mount();

    expect(host.querySelectorAll("a").length).toBe(0);
    expect(host.innerHTML).not.toContain("javascript:");
    expect(host.textContent).toContain("this");
  });
});
