import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Graph } from "./Graph.js";
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
  activeTab: "browse",
  overlayOpen: true,
  activeOverlay: "graph",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GRAPH_PAYLOAD = {
  nodes: [
    { id: "a", path: "concepts/a.md", type: "concept", label: "Alpha" },
    { id: "b", path: "sources/b.md", type: "source", label: "Beta" },
    { id: "c", path: "entities/c.md", type: "entity", label: "Gamma" },
  ],
  edges: [
    { source: "a", target: "b", kind: "concept" },
    { source: "a", target: "c", kind: "related" },
  ],
};

beforeEach(() => {
  useStore.setState(INITIAL as Partial<AppState>);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/graph")) return json(GRAPH_PAYLOAD);
    return json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Render Graph and wait for the fetch + paint to settle. */
async function renderGraph(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Graph />);
  });
  // Let the fetch promise resolve and the state update flush.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return host;
}

it("renders nodes from the API payload with type-coloured circles", async () => {
  const host = await renderGraph();

  const nodes = host.querySelectorAll<SVGGElement>(".graph-node");
  expect(nodes.length).toBe(3);

  const byPath = new Map<string, SVGGElement>();
  nodes.forEach((g) => byPath.set(g.getAttribute("data-node-path") ?? "", g));

  // Each node carries its OKF type as a data attribute.
  expect(byPath.get("concepts/a.md")?.getAttribute("data-node-type")).toBe("concept");
  expect(byPath.get("sources/b.md")?.getAttribute("data-node-type")).toBe("source");
  expect(byPath.get("entities/c.md")?.getAttribute("data-node-type")).toBe("entity");

  // The circle fill matches the type palette.
  const circleA = byPath.get("concepts/a.md")?.querySelector("circle");
  const circleB = byPath.get("sources/b.md")?.querySelector("circle");
  const circleC = byPath.get("entities/c.md")?.querySelector("circle");
  expect(circleA?.getAttribute("fill")).toBe("#a78bfa"); // concept
  expect(circleB?.getAttribute("fill")).toBe("#fbbf24"); // source
  expect(circleC?.getAttribute("fill")).toBe("#34d399"); // entity
});

it("renders edge lines for each edge kind from the payload", async () => {
  const host = await renderGraph();

  const lines = host.querySelectorAll<SVGLineElement>(".graph-canvas line[data-edge-kind]");
  // Two edges in the payload: one 'concept', one 'related'.
  expect(lines.length).toBe(2);
  const kinds = new Set(Array.from(lines).map((l) => l.getAttribute("data-edge-kind")));
  expect(kinds.has("concept")).toBe(true);
  expect(kinds.has("related")).toBe(true);
});

it("shows edge-kind filter toggles and toggling hides edges of that kind", async () => {
  const host = await renderGraph();

  const filters = host.querySelectorAll<HTMLButtonElement>(".graph-edge-filter");
  // Two distinct kinds appear as toggle pills.
  expect(filters.length).toBe(2);
  const labels = Array.from(filters).map((b) => b.textContent);
  expect(labels).toContain("concept");
  expect(labels).toContain("related");

  // Both start active (is-active class).
  const conceptBtn = Array.from(filters).find((b) => b.textContent === "concept");
  expect(conceptBtn?.classList.contains("is-active")).toBe(true);

  // Deactivate 'concept' filter.
  await act(async () => {
    conceptBtn?.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  // The 'concept' edge is now gone; only 'related' remains.
  const remaining = host.querySelectorAll<SVGLineElement>(".graph-canvas line[data-edge-kind]");
  expect(remaining.length).toBe(1);
  expect(remaining[0]!.getAttribute("data-edge-kind")).toBe("related");
  expect(conceptBtn?.classList.contains("is-active")).toBe(false);
});

it("navigates to the Browse screen with the file open when a node is clicked", async () => {
  const host = await renderGraph();

  const nodeG = host.querySelector<SVGGElement>('.graph-node[data-node-path="concepts/a.md"]');
  expect(nodeG).toBeTruthy();

  await act(async () => {
    nodeG?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  const state = useStore.getState();
  // openFile added a tab for the clicked path.
  const tab = state.tabs.find((t) => t.path === "concepts/a.md");
  expect(tab).toBeTruthy();
  expect(state.activeTabPath).toBe("concepts/a.md");
  // closeOverlay closed the overlay.
  expect(state.overlayOpen).toBe(false);
});

it("shows a loading state before the fetch resolves", async () => {
  // A fetch that never resolves keeps loading true long enough to assert.
  globalThis.fetch = vi.fn(async () => new Promise(() => {})) as unknown as typeof fetch;
  useStore.setState(INITIAL as Partial<AppState>);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Graph />);
  });

  expect(host.textContent).toContain("Loading");
});

it("shows an empty state when the vault has no nodes", async () => {
  globalThis.fetch = vi.fn(async () => json({ nodes: [], edges: [] })) as unknown as typeof fetch;
  useStore.setState(INITIAL as Partial<AppState>);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Graph />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  expect(host.textContent).toContain("Empty graph");
});

it("shows an error message when the graph fetch fails", async () => {
  globalThis.fetch = vi.fn(async () =>
    json({ message: "vault not found" }, 404),
  ) as unknown as typeof fetch;
  useStore.setState(INITIAL as Partial<AppState>);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Graph />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  expect(host.textContent).toContain("vault not found");
});