import { useStore } from "../store.js";
import { noteLabel } from "../lib/notePath.js";

/**
 * The tab strip: one tab per open file, the active one carrying the pill
 * (`.tab-active-bg`) that makes the current note legible at a glance.
 *
 * Middle-click closes, matching every tabbed surface the user already uses.
 *
 * PORTED NOTE: the reference's strip also carried virtual tabs (Review changes,
 * graph, search), the `+` new-note button, a right-click context menu and a
 * `motion` shared-layout card that slid between tabs. None of those have a
 * counterpart this phase: virtual tabs belong to features that do not exist
 * yet, note creation belongs to the tree (Phase 2), and `motion` is not a
 * dependency of this app — so the active card is a plain element that moves by
 * re-rendering. The tab, its label and its × are the reference's, unchanged.
 */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activePath = useStore((s) => s.activeTabPath);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const label = noteLabel(tab.path);
        return (
          <div
            key={tab.path}
            className={`tab${active ? " active" : ""}`}
            role="tab"
            aria-selected={active}
            title={tab.path}
            onAuxClick={(e) => {
              if (e.button === 1) useStore.getState().closeTab(tab.vaultId, tab.path);
            }}
          >
            {active && <span className="tab-active-bg" aria-hidden="true" />}
            <button
              className="tab-label"
              tabIndex={active ? 0 : -1}
              onClick={() => {
                if (!active) useStore.getState().openFile(tab.vaultId, tab.path);
              }}
            >
              {label}
            </button>
            <button
              className="tab-close"
              title="Close tab"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().closeTab(tab.vaultId, tab.path);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
