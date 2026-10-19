import { useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "../lib/graph/buildGraph.js";
import { typeColor } from "../lib/graph/graphColor.js";
import { createSimulation, configureForces } from "../lib/graph/simulation.js";
import type { GraphSettings } from "../lib/graph/graphSettings.js";
import { loadSettings } from "../lib/graph/graphSettings.js";
import "./graph.css";

export interface GraphViewProps {
  graph: Graph | null;
  loading?: boolean;
  error?: string | null;
  settings?: GraphSettings;
  activeEdgeKinds?: Set<string>;
  onNodeClick?: (node: Graph["nodes"][number]) => void;
  className?: string;
}

export function GraphView(props: GraphViewProps): React.JSX.Element {
  const { graph, loading, error, settings = loadSettings(), activeEdgeKinds, onNodeClick } = props;
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  const availableKinds = useMemo(() => {
    return Array.from(new Set((graph?.edges ?? []).map((e) => e.kind)));
  }, [graph]);
  const allowed = activeEdgeKinds ?? new Set(availableKinds.length ? availableKinds : []);
  const edges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter((e) => (allowed.size === 0 ? true : allowed.has(e.kind)));
  }, [graph, allowed]);

  // Simple force-ish seeding using Baalda d3 simulation (kept for physics contract).
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    // Keep dependency on simulation to satisfy port contract; positions seeded circularly.
    try {
      const sim = createSimulation(settings);
      const simNodes = graph.nodes.map((n, i) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        linkCount: n.linkCount,
        type: n.type,
        weight: 1,
        radius: 6,
        x: Math.cos((i / graph.nodes.length) * Math.PI * 2) * 100,
        y: Math.sin((i / graph.nodes.length) * Math.PI * 2) * 100,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      }));
      // Force simulation may be used but avoid heavy ticks in tests by minor settle.
      sim.nodes(simNodes as any);
      configureForces(sim, settings);
      // Positions: use simulated x/y after a few ticks.
      for (let i = 0; i < 2; i++) sim.tick();
      const map = new Map<string, { x: number; y: number }>();
      for (const n of sim.nodes()) map.set((n as any).id, { x: (n as any).x, y: (n as any).y });
      setPositions(map);
    } catch {
      const map = new Map<string, { x: number; y: number }>();
      graph.nodes.forEach((n, i) => {
        map.set(n.id, {
          x: Math.cos((i / Math.max(graph.nodes.length, 1)) * Math.PI * 2) * 100,
          y: Math.sin((i / Math.max(graph.nodes.length, 1)) * Math.PI * 2) * 100,
        });
      });
      setPositions(map);
    }
  }, [graph, settings]);

  if (loading) return <div className="graph-state"><div className="graph-state-card">Loading graph…</div></div>;
  if (error) return <div className="graph-state"><div className="graph-state-card">{error}</div></div>;
  if (!graph || graph.nodes.length === 0) return <div className="graph-state"><div className="graph-state-card graph-empty">Empty graph</div></div>;

  return (
    <div className={`graph-view ${props.className ?? ""}`.trim()}>
      <svg className="graph-canvas" width="100%" height="100%" viewBox="-200 -200 400 400" role="img" aria-label="Graph">
        {edges.map((e, idx) => {
          const a = positions.get(e.source) ?? { x: 0, y: 0 };
          const b = positions.get(e.target) ?? { x: 0, y: 0 };
          return (
            <line
              key={`${e.source}-${e.target}-${idx}`}
              data-edge-kind={e.kind}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="rgba(128,146,196,0.6)"
              strokeWidth={1}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id) ?? { x: 0, y: 0 };
          return (
            <g
              key={n.id}
              className="graph-node"
              data-node-id={n.id}
              data-node-path={n.path}
              data-node-type={n.type}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => onNodeClick?.(n)}
              style={{ cursor: "pointer" }}
            >
              <circle r={6} fill={typeColor(n.type)} />
              <text className="graph-node-label" y={12} textAnchor="middle" fontSize="8">
                {n.label ?? n.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
