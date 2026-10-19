import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Search } from "./Search.js";
import { useStore, type AppState } from "../store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT = {
  id: "v1",
  name: "Studio",
  path: "/data/vaults/studio",
  sourceKind: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

const INITIAL: Partial<AppState> = {
  currentVault: VAULT as never,
  isReadOnly: false,
  targetLine: null,
  jumpToLine: null,
  activeTab: "browse",
  overlayOpen: false,
  activeOverlay: "none",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useStore.setState(INITIAL as Partial<AppState>);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search")) {
      return json({
        groups: {
          concept: [{ file: "concepts/a.md", line: 3, snippet: "Alpha hits here" }],
          source: [{ file: "sources/b.md", line: 7, snippet: "source hit" }],
        },
      });
    }
    return json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("queries, groups results, and navigates with line target", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Search />);
  });

  const input = host.querySelector<HTMLInputElement>("input[type='search']");
  expect(input).toBeTruthy();
  await act(async () => {
    if (!input) return;
    input.value = "hit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 260));
  });

  expect(host.textContent).toContain("concepts/a.md");
  expect(host.textContent).toContain("Alpha hits");
  // group labels
  expect(host.textContent).toContain("Concepts");
  expect(host.textContent).toContain("Sources");

  const row = [...host.querySelectorAll<HTMLButtonElement>(".search-hit")].find((el) =>
    el.textContent?.includes("concepts/a.md"),
  );
  expect(row).toBeTruthy();
  await act(async () => {
    row?.click();
  });

  const state = useStore.getState();
  expect(state.targetLine).toBe(3);
  expect(state.jumpToLine).toBe(3);
  expect(state.activeTab).toBe("browse");
  const selected = state.tabs.find((t) => t.path === "concepts/a.md");
  expect(selected).toBeTruthy();
});

it("shows empty state when no results", async () => {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
    json({ groups: {} }),
  );

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Search />);
  });

  const input = host.querySelector<HTMLInputElement>("input[type='search']");
  await act(async () => {
    if (!input) return;
    input.value = "zzz";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 260));
  });

  expect(host.textContent).toContain("No matching notes found");
});
