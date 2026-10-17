import { useEffect } from "react";
import { Toasts } from "./components/Toasts.js";
import { Browse } from "./screens/Browse.js";
import { Settings } from "./screens/Settings.js";
import { useStore } from "./store.js";

/**
 * The shell: one screen, one overlay slot, one toast viewport.
 *
 *   .app-shell            ← the column: screen, overlay slot, toasts
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
 * The overlay slot is structural this phase: the element is rendered for any
 * open overlay, `settings` is the only one with a screen behind it, and the
 * reserved values (`graph`, `search`, `jobs`) resolve to no content rather than
 * a crash.
 */
export function App() {
  const loadHealth = useStore((s) => s.loadHealth);
  const activeOverlay = useStore((s) => s.activeOverlay);
  const overlayOpen = useStore((s) => s.overlayOpen);

  // One probe for the whole shell: the header's indicator and the Settings
  // overlay read the same slice, so they can never disagree about the server.
  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  return (
    <div className="app-shell">
      <Browse />

      {overlayOpen && activeOverlay !== "none" && (
        <div className="overlay-slot" data-overlay={activeOverlay}>
          {activeOverlay === "settings" && <Settings />}
        </div>
      )}

      <Toasts />
    </div>
  );
}
