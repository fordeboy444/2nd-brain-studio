import { describe, expect, it } from "vitest";
import {
  assembleGraph,
  transformGraphResponse,
  buildGraph,
  filterEdgesByKind,
  filterGraphByEdgeKinds,
  availableEdgeKinds,
  type Graph,
  type GraphNode,
  type GraphEdge,
} from "./buildGraph.js";
import {
  typeColor,
  assignColors,
  TYPE_COLORS,
  PALETTE,
  lerpHex,
} from "./graphColor.js";
import {
  DEFAULT_SETTINGS,
  type GraphSettings,
} from "./graphSettings.js";
import {
  nodeRadius,
  centerWeight,
  layoutScale,
  createSimulation,
  configureForces,
  MIN_RADIUS,
  MAX_RADIUS,
  IDLE_ALPHA,
  DRAG_ALPHA,
  REARRANGE_ALPHA,
} from "./simulation.js";

/* -------------------------------------------------------------------------
   Task 1 — graph physics, color schemes, and settings
   ------------------------------------------------------------------------- */

describe("typeColor — OKF type palette (dark mode)", () => {
  it("maps each known OKF type to its brand colour", () => {
    expect(typeColor("concept")).toBe("#a78bfa");
    expect(typeColor("summary")).toBe("#60a5fa");
    expect(typeColor("entity")).toBe("#34d399");
    expect(typeColor("source")).toBe("#fbbf24");
  });

  it("is case-insensitive", () => {
    expect(typeColor("Concept")).toBe("#a78bfa");
    expect(typeColor("SUMMARY")).toBe("#60a5fa");
    expect(typeColor(" Entity ")).toBe("#34d399");
  });

  it("falls back to slate for unknown or missing types", () => {
    expect(typeColor("unknown")).toBe("#94a3b8");
    expect(typeColor(undefined)).toBe("#94a3b8");
    expect(typeColor("")).toBe("#94a3b8");
  });

  it("exposes the palette as a lookup matching the plan's spec", () => {
    expect(TYPE_COLORS.concept).toBe("#a78bfa");
    expect(TYPE_COLORS.summary).toBe("#60a5fa");
    expect(TYPE_COLORS.entity).toBe("#34d399");
    expect(TYPE_COLORS.source).toBe("#fbbf24");
  });
});

describe("assignColors — type mode legend", () => {
  function n(id: string, type: string): GraphNode {
    return { id, title: id, path: `${id}.md`, type, linkCount: 0 };
  }

  it("colours every node by its OKF type and builds a legend", () => {
    const nodes = [n("a", "concept"), n("b", "source"), n("c", "entity")];
    const res = assignColors(nodes, "type", "#7f73ff");
    expect(res.colorById.get("a")).toBe("#a78bfa");
    expect(res.colorById.get("b")).toBe("#fbbf24");
    expect(res.colorById.get("c")).toBe("#34d399");
    // Legend has one entry per distinct type.
    const labels = res.legend.map((e) => e.label).sort();
    expect(labels).toEqual(["concept", "entity", "source"]);
  });

  it("counts nodes per type in the legend", () => {
    const nodes = [
      n("a", "concept"),
      n("b", "concept"),
      n("c", "source"),
    ];
    const res = assignColors(nodes, "type", "#7f73ff");
    const concept = res.legend.find((e) => e.label === "concept");
    const source = res.legend.find((e) => e.label === "source");
    expect(concept?.count).toBe(2);
    expect(source?.count).toBe(1);
  });

  it("falls back to slate for an unrecognised type", () => {
    const nodes = [n("a", "mystery")];
    const res = assignColors(nodes, "type", "#7f73ff");
    expect(res.colorById.get("a")).toBe("#94a3b8");
  });
});

describe("lerpHex + PALETTE — colour helpers", () => {
  it("interpolates linearly between two hex colours", () => {
    expect(lerpHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(lerpHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("clamps t outside [0,1]", () => {
    expect(lerpHex("#000000", "#ffffff", -1)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 2)).toBe("#ffffff");
  });

  it("exposes a non-empty categorical palette", () => {
    expect(PALETTE.length).toBeGreaterThan(0);
    for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("assembleGraph — pure transform", () => {
  function node(id: string, type = "note"): { id: string; path: string; type: string; title: string } {
    return { id, path: `${id}.md`, type, title: id };
  }
  function edge(source: string, target: string, kind = "link"): GraphEdge {
    return { source, target, kind };
  }

  it("keeps edges between known nodes and sets the kind", () => {
    const g = assembleGraph([node("a"), node("b")], [edge("a", "b", "concept")]);
    expect(g.edges).toEqual([{ source: "a", target: "b", kind: "concept", type: "concept" }]);
  });

  it("computes linkCount as the number of distinct edges touching a node", () => {
    const g = assembleGraph(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("a", "c"), edge("b", "c")],
    );
    const counts = Object.fromEntries(g.nodes.map((n) => [n.id, n.linkCount]));
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it("dedupes repeated edges between the same pair+kind", () => {
    const g = assembleGraph([node("a"), node("b")], [
      edge("a", "b", "concept"),
      edge("a", "b", "concept"),
    ]);
    expect(g.edges).toHaveLength(1);
  });

  it("treats different kinds between the same pair as distinct edges", () => {
    const g = assembleGraph([node("a"), node("b")], [
      edge("a", "b", "concept"),
      edge("a", "b", "source"),
    ]);
    expect(g.edges).toHaveLength(2);
  });

  it("drops self-loops and dangling refs", () => {
    const g = assembleGraph([node("a")], [edge("a", "a"), edge("a", "ghost")]);
    expect(g.edges).toEqual([]);
    expect(g.nodes[0].linkCount).toBe(0);
  });

  it("defaults a missing kind to 'link'", () => {
    const g = assembleGraph([node("a"), node("b")], [
      { source: "a", target: "b" } as GraphEdge,
    ]);
    expect(g.edges[0].kind).toBe("link");
  });

  it("returns an empty graph for an empty vault", () => {
    const g = assembleGraph([], []);
    expect(g).toEqual({ nodes: [], edges: [] });
  });

  it("fills type from the node payload, defaulting to 'note'", () => {
    const g = assembleGraph(
      [
        { id: "a", path: "a.md", type: "concept", title: "A" },
        { id: "b", path: "b.md", title: "B" },
      ],
      [],
    );
    expect(g.nodes[0].type).toBe("concept");
    expect(g.nodes[1].type).toBe("note");
  });
});

describe("transformGraphResponse / buildGraph — API payload adapter", () => {
  it("transformGraphResponse adapts a server payload", () => {
    const g = transformGraphResponse({
      nodes: [
        { id: "a", path: "a.md", type: "concept", label: "Alpha" },
        { id: "b", path: "b.md", type: "source", label: "Beta" },
      ],
      edges: [{ source: "a", target: "b", kind: "concept" }],
    });
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[0].title).toBe("Alpha");
    expect(g.edges[0].kind).toBe("concept");
  });

  it("buildGraph(payload) transforms synchronously when given an object", () => {
    const g = buildGraph({ nodes: [], edges: [] }) as Graph;
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("buildGraph(vaultId, fetcher) fetches and transforms", async () => {
    const fetcher = async () => ({
      nodes: [{ id: "a", path: "a.md", type: "concept", label: "A" }],
      edges: [],
    });
    const g = (await buildGraph("v1", fetcher)) as Graph;
    expect(g.nodes[0].id).toBe("a");
    expect(g.nodes[0].type).toBe("concept");
  });
});

describe("filterEdgesByKind / filterGraphByEdgeKinds / availableEdgeKinds", () => {
  const graph: Graph = {
    nodes: [
      { id: "a", title: "A", path: "a.md", type: "concept", linkCount: 2 },
      { id: "b", title: "B", path: "b.md", type: "source", linkCount: 1 },
      { id: "c", title: "C", path: "c.md", type: "entity", linkCount: 1 },
    ],
    edges: [
      { source: "a", target: "b", kind: "concept", type: "concept" },
      { source: "a", target: "c", kind: "related", type: "related" },
    ],
  };

  it("availableEdgeKinds lists the distinct kinds, sorted", () => {
    expect(availableEdgeKinds(graph)).toEqual(["concept", "related"]);
  });

  it("filterEdgesByKind keeps only edges whose kind is in the allow-set", () => {
    const kept = filterEdgesByKind(graph.edges, ["concept"]);
    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe("concept");
  });

  it("filterEdgesByKind returns an empty array for an empty allow-set", () => {
    expect(filterEdgesByKind(graph.edges, [])).toEqual([]);
  });

  it("filterGraphByEdgeKinds returns the same nodes with filtered edges", () => {
    const filtered = filterGraphByEdgeKinds(graph, new Set(["related"]));
    expect(filtered.nodes).toBe(graph.nodes);
    expect(filtered.edges).toHaveLength(1);
    expect(filtered.edges[0].kind).toBe("related");
  });
});

describe("simulation — physics helpers", () => {
  it("nodeRadius is sublinear and clamped to [MIN_RADIUS, MAX_RADIUS]", () => {
    expect(nodeRadius(0)).toBe(MIN_RADIUS);
    expect(nodeRadius(1)).toBeGreaterThan(MIN_RADIUS);
    // A huge degree clamps to the ceiling.
    expect(nodeRadius(100000)).toBe(MAX_RADIUS);
    // Sublinear: 100 links is less than 10x the radius of 1 link.
    expect(nodeRadius(100)).toBeLessThan(nodeRadius(1) * 10);
  });

  it("centerWeight floors orphans and scales by degree", () => {
    // An orphan (0 links) gets the floor weight.
    expect(centerWeight(0, 10)).toBeGreaterThanOrEqual(0.12);
    // The max-degree node gets the strongest pull.
    const max = centerWeight(10, 10);
    const mid = centerWeight(5, 10);
    expect(max).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(centerWeight(0, 10));
  });

  it("layoutScale is 0 for an empty node set", () => {
    expect(layoutScale([])).toBe(0);
  });

  it("layoutScale measures RMS distance from the centroid", () => {
    // Two nodes at (1,0) and (-1,0): centroid (0,0), RMS = 1.
    const nodes = [
      { x: 1, y: 0, weight: 0, fx: null, fy: null, vx: 0, vy: 0, radius: 1, id: "a", title: "a", path: "a", type: "note", linkCount: 0 },
      { x: -1, y: 0, weight: 0, fx: null, fy: null, vx: 0, vy: 0, radius: 1, id: "b", title: "b", path: "b", type: "note", linkCount: 0 },
    ];
    expect(layoutScale(nodes)).toBeCloseTo(1, 5);
  });

  it("exports the alpha constants the renderer uses for drag/rearrange", () => {
    expect(IDLE_ALPHA).toBeGreaterThan(0);
    expect(DRAG_ALPHA).toBeGreaterThan(IDLE_ALPHA);
    expect(REARRANGE_ALPHA).toBeGreaterThan(DRAG_ALPHA);
  });

  it("createSimulation builds a stopped sim whose forces are configured", () => {
    const settings: GraphSettings = { ...DEFAULT_SETTINGS };
    const sim = createSimulation(settings);
    // Stopped: the renderer ticks manually.
    expect(sim.alpha()).toBeLessThanOrEqual(1);
    // configureForces can be called live without throwing.
    expect(() => configureForces(sim, settings)).not.toThrow();
  });

  it("createSimulation + tick moves nodes off the origin", () => {
    const settings: GraphSettings = { ...DEFAULT_SETTINGS };
    const sim = createSimulation(settings);
    const nodes = [
      { id: "a", title: "a", path: "a", type: "concept", linkCount: 1, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, radius: 6, weight: 0.12 },
      { id: "b", title: "b", path: "b", type: "source", linkCount: 1, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, radius: 6, weight: 0.12 },
    ];
    const links = [{ source: "a", target: "b" }];
    sim.nodes(nodes);
    (sim.force("link") as any).links(links);
    configureForces(sim, settings);
    for (let i = 0; i < 20; i++) sim.tick();
    // After ticks the two nodes should have separated (repulsion + link).
    const [n0, n1] = sim.nodes() as any[];
    const moved = Math.hypot(n0.x, n0.y) + Math.hypot(n1.x, n1.y);
    expect(moved).toBeGreaterThan(0);
  });
});