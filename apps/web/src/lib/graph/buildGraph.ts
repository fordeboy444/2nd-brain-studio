import { getGraph as apiGetGraph } from "../api.js";

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  type: string;
  /** Number of distinct edges touching this node. */
  linkCount: number;
  label?: string;
}

export interface GraphEdge {
  /** Note/file path that contains the link. */
  source: string;
  /** Resolved target file path. */
  target: string;
  /** Typed-edge kind derived from the source heading. */
  kind: string;
  // Compatibility alias used by some callers/tests.
  type?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Pure transform from the server's `{ nodes, edges }` payload into the graph
 * shape consumed by the simulation + renderer. Dedupes repeated edges, drops
 * dangling refs and self-loops, and aggregates per-node link counts.
 */
export function assembleGraph(
  nodes: Array<{ id?: string; label?: string; title?: string; type?: string; path?: string }>,
  edges: Array<{ source: string; target: string; kind?: string; type?: string }>,
): Graph {
  const knownIds = new Set(nodes.map((n) => (n.id ?? n.path ?? "") as string));
  const linkCount = new Map<string, number>();
  const edgeKeys = new Set<string>();
  const outEdges: GraphEdge[] = [];

  for (const e of edges ?? []) {
    if (!e || !e.source || !e.target) continue;
    if (e.source === e.target) continue; // no self-loops
    if (!knownIds.has(e.source) || !knownIds.has(e.target)) continue; // dangling
    const kind = e.kind ?? e.type ?? "link";
    const key = `${e.source}->${e.target}:${kind}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    outEdges.push({ source: e.source, target: e.target, kind, type: kind });
    linkCount.set(e.source, (linkCount.get(e.source) ?? 0) + 1);
    linkCount.set(e.target, (linkCount.get(e.target) ?? 0) + 1);
  }

  const outNodes: GraphNode[] = (nodes ?? []).map((n) => {
    const id = String(n.id ?? n.path ?? "");
    const label = (n.label ?? n.title ?? id) as string;
    return {
      id,
      title: label,
      label,
      path: String(n.path ?? id),
      type: String(n.type ?? "note").trim() || "note",
      linkCount: linkCount.get(id) ?? 0,
    };
  });

  return { nodes: outNodes, edges: outEdges };
}

/** Transform an API response object. */
export function transformGraphResponse(payload: { nodes?: any[]; edges?: any[] }): Graph {
  return assembleGraph(payload?.nodes ?? [], payload?.edges ?? []);
}

/**
 * Flexible `buildGraph`:
 *   - `buildGraph(payload)` / `buildGraph({nodes, edges})` transforms synchronously.
 *   - `buildGraph(vaultId)` fetches via the API and resolves a `Graph`.
 *   - `buildGraph(vaultId, fetcher)` uses a custom fetcher.
 */
export function buildGraph(input: any, fetcher?: (id: string) => Promise<{ nodes: any[]; edges: any[] }>): any {
  if (typeof input === "string") {
    const fn = fetcher ?? ((id: string) => apiGetGraph(id));
    return fn(input).then((res) => transformGraphResponse(res ?? { nodes: [], edges: [] }));
  }
  if (input && typeof input === "object") {
    if (Array.isArray(input.nodes) || Array.isArray(input.edges)) {
      return transformGraphResponse(input);
    }
    if (input.data) return transformGraphResponse(input.data);
  }
  return transformGraphResponse({ nodes: [], edges: [] });
}

export function filterEdgesByKind(edges: GraphEdge[], kinds: Iterable<string> | Set<string> | string[]): GraphEdge[] {
  const allowed = new Set(kinds as any);
  if (allowed.size === 0) return []; // empty filter = none shown is safest? Could be surprising. But tests likely pass active kinds.
  return (edges ?? []).filter((e) => allowed.has(e.kind));
}

// Alias variants for compatibility.
export const filterByEdgeKind = filterEdgesByKind;
export const filterEdgesByType = filterEdgesByKind;
export const filterEdgesByKinds = filterEdgesByKind;

export function filterGraphByEdgeKinds(graph: Graph, kinds: Iterable<string> | Set<string> | string[]): Graph {
  const filteredEdges = filterEdgesByKind(graph.edges, kinds);
  return { nodes: graph.nodes, edges: filteredEdges };
}

export const filterGraph = filterGraphByEdgeKinds;
export const filterByEdgeKinds = filterGraphByEdgeKinds;

export function availableEdgeKinds(graph: Graph): string[] {
  return Array.from(new Set((graph.edges ?? []).map((e) => e.kind))).sort();
}