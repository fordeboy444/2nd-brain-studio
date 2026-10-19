import { useEffect } from "react";
import { ReadOnlyBanner } from "./components/ReadOnlyBanner.js";
import { Toasts } from "./components/Toasts.js";
import { Browse } from "./screens/Browse.js";
import { Search } from "./screens/Search.js";
import { Jobs } from "./screens/Jobs.js";
import { Graph } from "./screens/Graph.js";
import { Settings } from "./screens/Settings.js";
import { useStore } from "./store.js";

/**
 * The shell: one screen, one overlay slot, one toast viewport, plus the
 * read-only banner that appears when this instance is the secondary container.
 *
 *   .app-shell            ← the column: banner, screen, overlay slot, toasts
 *   ├─ ReadOnlyBanner     ← persistent strip when /api/health reports readOnly
 *   ├─ Browse             ← the grid: sidebar | main (see screens/Browse.tsx)
 *   ├─ .overlay-slot      ← overlay screens, only when one is open
 *   └─ Toasts             ← one viewport for the whole app, portalled
 *
 * The grid's interior moved to `Browse` in this plan: every region of it — the
 * tree, the tab strip, the editor, the two panels — is a function of which
 * vault and which file are open, which is that screen's subject, and `App` was
 * reaching into the store for six of those facts to draw it. What is left here
 * is the part that is genuinely outside the grid: the overlay slot has to cover
 * it, and the toast viewport has to outlive it.
 *
 * The overlay slot is structural: the element is rendered for any open overlay,
 * `settings`, `jobs`, `search`, and `graph` each have a screen behind them.
 */
export function App() {
  const loadHealth = useStore((s) => s.loadHealth);
  const activeOverlay = useStore((s) => s.activeOverlay);
  const overlayOpen = useStore((s) => s.overlayOpen);

  // One probe for the whole shell: the header's indicator, the Settings
  // overlay, and the ReadOnlyBanner all read the same slice, so they can never
  // disagree about the server.
  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  return (
    <div className="app-shell">
      <ReadOnlyBanner />
      <Browse />

      {overlayOpen && activeOverlay !== "none" && (
        <div className="overlay-slot" data-overlay={activeOverlay}>
          {activeOverlay === "settings" && <Settings />}
          {activeOverlay === "jobs" && <Jobs />}
          {activeOverlay === "search" && <Search />}
          {activeOverlay === "graph" && <Graph />}
        </div>
      )}

      <Toasts />
    </div>
  );
}
