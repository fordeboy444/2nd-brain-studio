import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { BacklinksPanel } from "../components/BacklinksPanel.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { MarkdownEditor } from "../components/MarkdownEditor.js";
import { RightPanel } from "../components/RightPanel.js";
import { SidebarHeader } from "../components/SidebarHeader.js";
import { Spinner } from "../components/Spinner.js";
import { TabBar } from "../components/TabBar.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { VaultTree } from "../components/VaultTree.js";
import { useSidebarWidth } from "../lib/useSidebarWidth.js";
import { useStore } from "../store.js";

/**
 * The Browse screen: the shell, filled in.
 *
 *   .app                  ← the grid: sidebar | main
 *   ├─ aside.sidebar      ← SidebarHeader + VaultTree (a vault open) or nothing
 *   └─ main.main          ← .main-header, .editor-wrap, the two panels
 *
 * The grid lives here rather than in `App.tsx` because every one of its regions
 * depends on which vault and which file are open, and that is this screen's
 * subject. `App` keeps the two things that sit OUTSIDE the grid — the overlay
 * slot and the toast viewport — so an overlay covers the grid without being
 * inside it.
 *
 * With no vault open the editor region holds the vault list, which is also where
 * a vault is created. With one open it holds the editor, and the sidebar holds
 * the tree. There is no third state and no router: this is the same panel model
 * the reference uses.
 *
 * The sidebar width is a CSS variable on the grid, not a React width on a child,
 * so dragging only repaints the row that moved (`lib/useSidebarWidth.ts`).
 */
export function Browse() {
  const { width } = useSidebarWidth();
  const currentVault = useStore((s) => s.currentVault);
  const health = useStore((s) => s.health);
  const healthError = useStore((s) => s.healthError);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const openRightPanel = useStore((s) => s.openRightPanel);
  const closeRightPanel = useStore((s) => s.closeRightPanel);

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
    <div className="app" style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      <aside className="sidebar">
        <SidebarHeader />
        {/* The tree region. The boundary means a broken tree can never take the
            sidebar — or the editor next to it — down with it. */}
        {currentVault && (
          <div className="sidebar-tree-wrap">
            <ErrorBoundary label="File tree">
              <VaultTree />
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
                style={{ width: 8, height: 8, borderRadius: "50%", background: healthTone }}
              />
              {healthLabel}
            </span>
            {/* `panel-btn` is load-bearing: the panel closes on an outside
                pointerdown and exempts this class, or the press would close it
                and the click would reopen it in the same gesture. */}
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
              onClick={() => useStore.getState().openOverlay("settings")}
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

        <div className="editor-wrap">
          <div className="editor-host" style={{ overflow: "auto" }}>
            <EditorRegion />
          </div>
        </div>

        <BacklinksPanel />
        <RightPanel />
      </main>
    </div>
  );
}

/** What the middle region shows, in the one order the states can be in: no
 *  vault, then no file, then a file that is still loading, then a file whose
 *  read failed, then the editor. */
function EditorRegion() {
  const currentVault = useStore((s) => s.currentVault);
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) ?? null);

  if (!currentVault) return <VaultList />;

  if (!tab) {
    return (
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
          <p style={{ margin: 0 }}>Open a file from the sidebar to start editing.</p>
        </div>
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="editor-empty">
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <p style={{ margin: "0 0 var(--sp-1)", color: "var(--text-secondary)", fontWeight: 600 }}>
            Couldn't load this file. Try reloading the vault.
          </p>
          {/* The reason, in the server's own words: the sentence above says what
              to do, this says what happened. */}
          <p style={{ margin: 0, fontSize: "var(--fs-sm)", color: "var(--text-tertiary)" }}>
            {tab.error}
          </p>
        </div>
      </div>
    );
  }

  if (tab.loading) {
    return (
      <div className="editor-empty">
        <Spinner size="md" tone="neutral" />
      </div>
    );
  }

  return <MarkdownEditor />;
}

/** The vault list and the create form. Copy strings match the approved UI-SPEC
 *  verbatim; the only state this screen owns is the form's own. */
function VaultList() {
  const vaults = useStore((s) => s.vaults);
  const loading = useStore((s) => s.vaultsLoading);
  const error = useStore((s) => s.vaultsError);
  const loadVaults = useStore((s) => s.loadVaults);
  const createVault = useStore((s) => s.createVault);
  const openVault = useStore((s) => s.openVault);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);

  const trimmed = name.trim();
  const canSubmit = trimmed !== "" && !creating;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createVault(trimmed);
      setName("");
      // Creating a vault is how a vault gets opened the first time — the same
      // one gesture the vault rows make.
      openVault(created);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "var(--sp-8) var(--sp-5)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-4)",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "var(--fs-xl)", color: "var(--text-primary)" }}>Vaults</h2>

      {loading ? (
        <p aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <Spinner size="sm" tone="neutral" />
          Loading…
        </p>
      ) : error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          Couldn't load your vaults. Try reloading the page.
        </p>
      ) : vaults.length === 0 ? (
        <div>
          <h3 style={{ margin: "0 0 var(--sp-1)", fontSize: "var(--fs-md)", color: "var(--text-secondary)" }}>
            No vaults yet
          </h3>
          <p style={{ margin: 0, color: "var(--text-tertiary)" }}>Create a vault to get started.</p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {vaults.map((v) => (
            <li key={v.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                type="button"
                className="ghost-pill"
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "var(--sp-3) var(--sp-2)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
                onClick={() => openVault(v)}
              >
                <span>{v.name}</span>
                <span style={{ fontWeight: 400, fontSize: "var(--fs-sm)", color: "var(--text-tertiary)" }}>
                  {v.lastOpenedAt ? new Date(v.lastOpenedAt).toLocaleString() : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: "var(--sp-2)" }}
        aria-label="Create vault"
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Vault name"
          aria-label="Vault name"
          style={{
            flex: 1,
            padding: "var(--sp-2) var(--sp-3)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            fontSize: "var(--fs-md)",
          }}
        />
        <button
          type="submit"
          className="ghost-pill"
          disabled={!canSubmit}
          style={{ padding: "var(--sp-2) var(--sp-4)" }}
        >
          {creating ? "Creating…" : "Create vault"}
        </button>
      </form>

      {createError ? (
        <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>
          {createError}
        </p>
      ) : null}
    </div>
  );
}
