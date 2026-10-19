import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { getGraph, type GraphNode as ApiNode, type GraphEdge as ApiEdge } from "../lib/api.js";
import { buildGraph, availableEdgeKinds, filterGraphByEdgeKinds } from "../lib/graph/buildGraph.js";
import type { Graph } from "../lib/graph/buildGraph.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS, type GraphSettings } from "../lib/graph/graphSettings.js";
import { assignColors } from "../lib/graph/graphColor.js";
import { GraphView } from "../components/GraphView.js";
import { GraphControls } from "../components/GraphControls.js";

export function Graph(): React.JSX.Element {
  const closeOverlay = useStore((s) => s.closeOverlay);
  const currentVault = useStore((s) => s.currentVault);
  const openFile = useStore((s) => s.openFile);

  const [raw, setRaw] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<GraphSettings>(() => loadSettings());
  const [activeEdgeKinds, setActiveEdgeKinds] = useState<Set<string>>(new Set());

  const vaultId = currentVault?.id ?? null;

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getGraph(vaultId)
      .then((res) => {
        if (cancelled) return;
        const g = buildGraph(res as any) as Graph;
        setRaw(g);
        const kinds = availableEdgeKinds(g);
        setActiveEdgeKinds(new Set(kinds));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load graph");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  const kinds = useMemo(() => (raw ? availableEdgeKinds(raw) : []), [raw]);
  const filtered = useMemo(() => {
    if (!raw) return null;
    if (activeEdgeKinds.size === 0) return { ...raw, edges: [] };
    return filterGraphByEdgeKinds(raw, activeEdgeKinds);
  }, [raw, activeEdgeKinds]);

  const colorResult = useMemo(() => {
    if (!filtered) return null;
    return assignColors(filtered.nodes as any, settings.colorMode, "#7f73ff");
  }, [filtered, settings.colorMode]);

  function handleNodeClick(node: Graph["nodes"][number]) {
    if (vaultId) openFile(vaultId, node.path);
    closeOverlay();
  }

  function handleToggleEdgeKind(kind: string) {
    setActiveEdgeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function handleSettingsChange(patch: Partial<GraphSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  }

  function handleReset() {
    setSettings({ ...DEFAULT_SETTINGS });
    saveSettings({ ...DEFAULT_SETTINGS });
  }

  return (
    <div className="graph-screen" data-screen="graph">
      <header className="graph-header">
        <span className="graph-title">Graph</span>
      </header>
      <div className="graph-body">
        <GraphView
          graph={filtered}
          loading={loading}
          error={error}
          settings={settings}
          activeEdgeKinds={activeEdgeKinds}
          onNodeClick={handleNodeClick}
        />
        {filtered && (
          <GraphControls
            settings={settings}
            onChange={handleSettingsChange}
            onReset={handleReset}
            legend={colorResult?.legend ?? []}
            edgeKinds={kinds}
            activeEdgeKinds={activeEdgeKinds}
            onToggleEdgeKind={handleToggleEdgeKind}
          />
        )}
      </div>
    </div>
  );
}
