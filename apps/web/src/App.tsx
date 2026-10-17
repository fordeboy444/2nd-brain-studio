import { useEffect, type CSSProperties } from "react";
import { BacklinksPanel } from "./components/BacklinksPanel.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { RightPanel } from "./components/RightPanel.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { SidebarHeader } from "./components/SidebarHeader.js";
import { TabBar } from "./components/TabBar.js";
import { Toasts } from "./components/Toasts.js";
import { useSidebarWidth } from "./lib/useSidebarWidth.js";
import { Browse } from "./screens/Browse.js";
import { Settings } from "./screens/Settings.js";
import { useStore } from "./store.js";

/**
 * The shell: one grid, three regions, and the slots around them.
 *
 *   .app-shell            ← the column: shell, overlay slot, toasts
 *   ├─ .app               ← the grid: sidebar | main
 *   │  ├─ aside.sidebar   ← SidebarHeader + the tree region
 *   │  └─ main.main       ← the editor sheet: header, editor, floating panels
 *   ├─ .overlay-slot      ← overlay screens, only when one is open
 *   └─ Toasts             ← one viewport for the whole app, portalled
 *
 * The sidebar width is a CSS variable on the grid rather than a React width on
 * a child, so dragging only repaints the row that moved (`useSidebarWidth`).
 * The right panel is a pop-out over the editor, exactly as the reference has
 * it, so it lives inside `.main` — that element is its positioning context.
 *
 * The overlay slot is structural this phase: the element is rendered for any
 * open overlay, `settings` is the only one with a screen behind it, and the
 * reserved values (`graph`, `search`, `jobs`) resolve to no content rather than
 * a crash. The vault create/delete dialogs belong to the Browse screen, not
 * here — they are part of the vault switcher.
 */
export function App() {
  const { width } = useSidebarWidth();
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);
  const loadHealth = useStore((s) => s.loadHealth);
  const currentVault = useStore((s) => s.currentVault);
  const activeOverlay = useStore((s) => s.activeOverlay);
  const overlayOpen = useStore((s) => s.overlayOpen);
  const openOverlay = useStore((s) => s.openOverlay);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const openRightPanel = useStore((s) => s.openRightPanel);
  const closeRightPanel = useStore((s) => s.closeRightPanel);

  // One probe for the whole shell: the indicator here and the Settings overlay
  // read the same slice, so they can never disagree about the server.
  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const healthLabel = healthError
    ? "Server unreachable"
    : health
      ? health.status === "degraded"
        ? "Server degraded"
        : "Server healthy"
      : "Checking…";
  const healthTone = healthError
    ? "var(--danger)"
    : health
      ? health.status === "degraded"
        ? "var(--warning)"
        : "var(--success)"
      : "var(--text-tertiary)";

  return (
    <div className="app-shell">
      <div className="app" style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
        <aside className="sidebar">
          <SidebarHeader />
          {/* The tree region. Phase 2 fills it; the empty state is the approved
              copy, and the boundary means a broken tree can never take the
              sidebar down with it. */}
          {currentVault && (
            <div className="sidebar-tree-wrap">
              <ErrorBoundary label="File tree">
                <div
                  style={{
                    padding: "var(--sp-4) var(--sp-3)",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--fs-sm)",
                  }}
                >
                  <p
                    style={{
                      margin: "0 0 var(--sp-1)",
                      color: "var(--text-secondary)",
                      fontWeight: 600,
                    }}
                  >
                    No files yet
                  </p>
                  <p style={{ margin: 0 }}>
                    Files and folders you create in this vault appear here.
                  </p>
                </div>
              </ErrorBoundary>
            </div>
          )}
        </aside>

        <main className="main">
          <header className="main-header">
            <TabBar />
            <div className="header-actions">
              <span
                title={healthError ?? undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  fontSize: "var(--fs-sm)",
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: healthTone,
                  }}
                />
                {healthLabel}
              </span>
              {/* `panel-btn` is load-bearing: the panel closes on an outside
                  pointerdown and exempts this class, or the press would close
                  it and the click would reopen it in the same gesture. */}
              <button
                className={`icon-btn panel-btn${rightPanelOpen ? " active" : ""}`}
                aria-pressed={rightPanelOpen}
                aria-label="Panel"
                title="Panel"
                onClick={() => {
                  if (rightPanelOpen) closeRightPanel();
                  else openRightPanel();
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M15 4v16" />
                </svg>
              </button>
              <ThemeToggle />
              <button
                className="icon-btn"
                aria-label="Settings"
                title="Settings"
                onClick={() => openOverlay("settings")}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 11a2 2 0 1 1 0 4z" />
                </svg>
              </button>
            </div>
          </header>

          {/* The editor sheet. With no vault open the screen is the vault list
              (Browse, which is also what creates a vault); with one open, the
              editor's empty state until a file is. */}
          <div className="editor-wrap">
            <div className="editor-host" style={{ overflow: "auto" }}>
              {currentVault ? (
                <div className="editor-empty">
                  <div style={{ textAlign: "center" }}>
                    <p
                      style={{
                        margin: "0 0 var(--sp-1)",
                        fontSize: "var(--fs-lg)",
                        color: "var(--text-secondary)",
                        fontWeight: 600,
                      }}
                    >
                      Select a file
                    </p>
                    <p style={{ margin: 0 }}>
                      Open a file from the sidebar to start editing.
                    </p>
                  </div>
                </div>
              ) : (
                <Browse />
              )}
            </div>
          </div>

          <BacklinksPanel />
          <RightPanel />
        </main>
      </div>

      {overlayOpen && activeOverlay !== "none" && (
        <div className="overlay-slot" data-overlay={activeOverlay}>
          {activeOverlay === "settings" && <Settings />}
        </div>
      )}

      <Toasts />
    </div>
  );
}
