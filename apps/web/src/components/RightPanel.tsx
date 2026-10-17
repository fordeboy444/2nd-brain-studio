import { useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { RIGHT_PANEL_TAB_LABEL, RIGHT_PANEL_TABS, type RightPanelTab } from "./rightPanelTab.js";

/**
 * The right panel: Backlinks, Outline, Frontmatter, Lint, in that fixed order.
 *
 * Four tabs over one panel, and every one of them is empty this phase — the
 * data behind them lands with the tree (Phase 2), the document (Phase 4) and the
 * backlink index (Phase 5). The empty copy is the real Phase 1 rendering, not a
 * placeholder: "No backlinks yet" is what a vault with no links in it says.
 *
 * The panel keeps the reference's pop-out geometry (`.version-panel.right-panel`,
 * absolutely positioned over the editor) and its three closing gestures —
 * Escape, the ✕, and a click outside it, with the panel's own menus and
 * dialogs exempt so clicking into them doesn't close the panel under the click.
 *
 * PORTED NOTE: the reference animated the entry with `motion`'s `x: "100%"`.
 * `motion` is not a dependency of this app, so the panel appears without
 * sliding. Nothing else about its shape changed.
 */

/** Portaled UI the panel opens: ConfirmDialog (modal), menus (`.menu-portal`),
 *  toasts. A click there must not close the panel under it. */
const PANEL_SPAWNED = ".panel-btn, .modal-backdrop, .modal, .menu-portal, .toast, .toast-viewport";

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** One icon per tab, each reading as what the tab holds: a link (backlinks),
 *  indented lines (outline), a headed document (frontmatter), a tick (lint). */
const TAB_ICON: Record<RightPanelTab, React.ReactNode> = {
  backlinks: (
    <svg {...ICON_PROPS}>
      <path d="M9 7H6a5 5 0 0 0 0 10h3" />
      <path d="M15 7h3a5 5 0 0 1 0 10h-3" />
      <path d="M8.5 12h7" />
    </svg>
  ),
  outline: (
    <svg {...ICON_PROPS}>
      <path d="M4 6h16M4 12h16M8 18h12" />
    </svg>
  ),
  frontmatter: (
    <svg {...ICON_PROPS}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M7 6.5h3" />
    </svg>
  ),
  lint: (
    <svg {...ICON_PROPS}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
};

/** The tabs' titles and labels, from the registry so the two can never drift. */
const TAB_TITLE = RIGHT_PANEL_TAB_LABEL;

/** What each tab shows while its data source does not exist yet. */
const TAB_EMPTY: Record<RightPanelTab, string> = {
  backlinks: "No backlinks yet",
  outline: "No headings",
  frontmatter: "No frontmatter",
  lint: "No issues",
};

function PanelBody({ tab }: { tab: RightPanelTab }) {
  const ref = useRef<HTMLElement | null>(null);

  // The panel is a dialog: focus it on open so Escape works and the next Tab
  // starts inside. preventScroll because the panel is off-screen right.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest(PANEL_SPAWNED)) return;
      useStore.getState().closeRightPanel();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const close = () => useStore.getState().closeRightPanel();
  return (
    <aside
      ref={ref}
      className="version-panel right-panel"
      tabIndex={-1}
      role="dialog"
      aria-label="Panel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          close();
          e.preventDefault();
        }
      }}
    >
      <header className="right-panel-head">
        <div className="right-panel-tabs" role="tablist" aria-label="Panel">
          {RIGHT_PANEL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              aria-pressed={t === tab}
              aria-label={TAB_TITLE[t]}
              title={TAB_TITLE[t]}
              className={`icon-btn right-panel-tab${t === tab ? " active" : ""}`}
              onClick={() => useStore.getState().setRightPanelTab(t)}
            >
              {TAB_ICON[t]}
            </button>
          ))}
          <span className="right-panel-tab-name">{TAB_TITLE[tab]}</span>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close panel" title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="right-panel-body">
        <ErrorBoundary label={TAB_TITLE[tab]} resetKeys={[tab]}>
          <p className="version-panel-empty">{TAB_EMPTY[tab]}</p>
        </ErrorBoundary>
      </div>
    </aside>
  );
}

export function RightPanel() {
  const open = useStore((s) => s.rightPanelOpen);
  const tab = useStore((s) => s.rightPanelTab);
  return open ? <PanelBody tab={tab} /> : null;
}
