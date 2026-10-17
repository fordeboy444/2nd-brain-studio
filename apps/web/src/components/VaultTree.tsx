import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { useStore } from "../store.js";
import { Spinner } from "./Spinner.js";
import { entryTitle } from "../lib/tree/titles.js";
import {
  EMPTY_TREE,
  ROOT,
  errorAt,
  fetchLevel,
  isBusy,
  isLoaded,
  markFailed,
  markLoaded,
  markLoading,
  treeData,
  type TreeRowData,
  type TreeState,
} from "../lib/tree/lazyTree.js";

/**
 * The vault tree (VAULT-02): one directory level at a time, `react-arborist`.
 *
 * This REPLACES the reference's monolithic file-tree component rather than
 * porting it. That component receives a whole vault in one payload and owns
 * rename/drag/context-menu/sync/presence plumbing; nothing here needs any of it.
 * What is left is the part that is actually load-bearing: a row per entry, the
 * reference's `.tree-*` classes so the stylesheet's selection fill and label
 * truncation apply unchanged, `--accent-soft` + `--text-primary` on the open
 * file's row, and directories before files.
 *
 * Loading indication is PANEL-SCOPED, never a screen loader: while a level's
 * fetch is in flight the spinner renders inside this panel — in place of the
 * rows during the first load, above them while a deeper level loads — and the
 * editor and the right panel stay interactive throughout.
 *
 * A level is fetched at most once. `needsFetch`-style guarding lives in
 * `lib/tree/lazyTree.ts` and is enforced here by a ref of requested directories,
 * because two toggles can land in the same tick and React state is not readable
 * synchronously. A level whose fetch FAILS is left unloaded, so expanding that
 * directory again retries it rather than leaving an empty node forever.
 */

/** Row height. Matches the reference's compact rows; the tree's only sizing. */
const ROW_HEIGHT = 30;
/** Used before the panel has been measured (and under jsdom, which has no
 *  layout). Not a design value — the tree re-renders on the first resize. */
const FALLBACK_HEIGHT = 480;

/** The retry affordance, shared by the root failure and the per-directory
 *  strip. Given its own shape inline because the pruned App.css carries no base
 *  `.ghost-pill` rule (deferred-items.md item 5), so the class alone would
 *  render bare text with a hover-only affordance. */
const RETRY_BUTTON_STYLE: CSSProperties = {
  flex: "none",
  padding: "var(--sp-1) var(--sp-3)",
  borderRadius: "var(--radius-pill)",
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)",
  color: "var(--text-secondary)",
  fontSize: "var(--fs-sm)",
  fontWeight: 600,
  cursor: "pointer",
};

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg {...ICON_PROPS}>
      {open ? (
        <>
          <path d="M3 8a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v1" />
          <path d="M3 8v9a2 2 0 0 0 2 2h13.2a2 2 0 0 0 1.9-1.4l1.6-5A1 1 0 0 0 20.8 11H6.2a1 1 0 0 0-1 .8L3 20" />
        </>
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
    </svg>
  );
}

/**
 * One row. Clicks are handled by `react-arborist`'s own row container (it calls
 * `select()` then `activate()`), so the row itself carries no click handler —
 * the work happens in `onActivate` below, which is also what the keyboard's
 * Enter reaches.
 */
function Row({ node, style, dragHandle }: NodeRendererProps<TreeRowData>) {
  const activePath = useStore((s) => s.activeTabPath);
  const isOpenFile = !node.data.isDir && node.data.path === activePath;
  const className = [
    "tree-row",
    node.data.isDir ? "is-dir" : "",
    isOpenFile ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Inline rather than stylesheet rules: the pruned App.css styles a fold
  // toggle that lives in the reference's toolbar, and this plan owns no
  // App.css change. Every value is still a token.
  const toggleStyle: CSSProperties = {
    width: 14,
    height: 14,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-tertiary)",
    transform: node.isOpen ? "rotate(90deg)" : "none",
    transition: "transform var(--t-fast) var(--ease)",
    visibility: node.isLeaf ? "hidden" : "visible",
  };

  return (
    <div ref={dragHandle} style={style} className={className} title={node.data.path}>
      <span
        className="tree-fold-toggle"
        style={toggleStyle}
        role="button"
        aria-label={node.isOpen ? "Collapse folder" : "Expand folder"}
        onClick={(e) => {
          // Stop here: the row container's click would otherwise select and
          // activate, and activation toggles a directory — one gesture, one
          // toggle, not two.
          e.stopPropagation();
          node.toggle();
        }}
      >
        <svg {...ICON_PROPS} width={10} height={10}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
      <span className="tree-glyph">
        {node.data.isDir ? <FolderIcon open={node.isOpen} /> : <FileIcon />}
      </span>
      {/* The display title derives from the path, never the raw filename: a note
          hides its extension, a directory keeps its name (lib/tree/titles.ts). */}
      <span className="tree-label">{entryTitle(node.data)}</span>
    </div>
  );
}

export function VaultTree() {
  const vaultId = useStore((s) => s.currentVault?.id ?? null);
  const openFile = useStore((s) => s.openFile);
  const pendingRefresh = useStore((s) => s.pendingTreeRefresh);
  const consumeTreeRefresh = useStore((s) => s.consumeTreeRefresh);
  const setTreeState = useStore((s) => s.setTreeState);

  const [state, setState] = useState<TreeState>(EMPTY_TREE);
  /** Directories in flight or already landed, per mount. The synchronous truth
   *  behind the "one request per level" rule. */
  const requested = useRef<Set<string>>(new Set());
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  /** The rows' own scroll box, held in state rather than a ref so the measuring
   *  effect re-attaches the moment that box mounts. It mounts LATE — the first
   *  paint is the spinner, and the box appears only when the root level lands.
   *  Measuring the panel instead was the earlier shape and it over-sized the
   *  virtualised list by whatever the panel carried above the rows. */
  const [treeBox, setTreeBox] = useState<HTMLDivElement | null>(null);

  const loadLevel = useCallback(
    async (dir: string, force = false) => {
      if (!vaultId) return;
      if (force) requested.current.delete(dir);
      if (requested.current.has(dir)) return;
      requested.current.add(dir);
      setState((s) => markLoading(s, dir));
      try {
        const entries = await fetchLevel(vaultId, dir);
        setState((s) => markLoaded(s, dir, entries));
      } catch (e) {
        // Leave the level unloaded: the next expand retries it.
        requested.current.delete(dir);
        setState((s) => markFailed(s, dir, (e as Error).message));
      }
    },
    [vaultId],
  );

  // A different vault is a different tree, and nothing about the old one — a
  // level, an expansion, an error — should survive into it.
  useEffect(() => {
    requested.current = new Set();
    setState(EMPTY_TREE);
    if (vaultId) void loadLevel(ROOT);
  }, [vaultId, loadLevel]);

  // A create inside the vault asks for one level to be re-read, so the new file's
  // row appears without a full page reload. The request is consumed once.
  useEffect(() => {
    if (pendingRefresh === null) return;
    const dir = consumeTreeRefresh();
    if (dir === null) return;
    void loadLevel(dir, true);
  }, [pendingRefresh, consumeTreeRefresh, loadLevel]);

  // Measure the rows' scroll box so the virtualised list knows its viewport.
  // Under jsdom there is no layout and no ResizeObserver; the fallback keeps
  // rows rendering.
  useEffect(() => {
    if (!treeBox || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(treeBox.clientHeight || FALLBACK_HEIGHT);
    const ro = new ResizeObserver(measure);
    ro.observe(treeBox);
    measure();
    return () => ro.disconnect();
  }, [treeBox, vaultId]);

  // Publish the levels this tree has read into the store (UI-10). The tree stays
  // the owner: this is a one-way projection so `MarkdownView` can tell a link
  // into a directory nobody has opened from a link into one that was read and
  // does not hold the target (`lib/linkResolve.ts`). Publishing is cheap — the
  // object identity changes only when a level lands, fails or is forgotten.
  useEffect(() => {
    setTreeState(state);
  }, [state, setTreeState]);

  const data = useMemo(() => treeData(state), [state]);
  const busy = isBusy(state);
  const rootLoaded = isLoaded(state, ROOT);
  const rootError = errorAt(state, ROOT);
  /** Failures BELOW the root. These had nowhere to render before: the panel
   *  branch below tests the ROOT's error only, so a subdirectory that failed to
   *  load left its row closed and said nothing at all. The row is a fixed 30px,
   *  so the message cannot live inside it — this list feeds the strip above the
   *  rows. `markLoading` clears an entry, so a retry empties the strip. */
  const childErrors = Object.keys(state.errors).filter((dir) => dir !== ROOT);

  const onToggle = useCallback(
    (id: string) => {
      // `id` is the node's vault-relative path. Re-expanding a loaded directory
      // is free: `loadLevel` refuses a directory already requested.
      void loadLevel(id);
    },
    [loadLevel],
  );

  const onActivate = useCallback(
    (node: NodeApi<TreeRowData>) => {
      if (node.data.isDir) {
        // Activating a directory opens it — the same thing the toggle does, so
        // clicking the row and clicking the arrow agree.
        node.toggle();
        return;
      }
      if (vaultId) openFile(vaultId, node.data.path);
    },
    [openFile, vaultId],
  );

  const emptyState = (
    <div
      style={{
        padding: "var(--sp-4) var(--sp-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--fs-sm)",
      }}
    >
      <p style={{ margin: "0 0 var(--sp-1)", color: "var(--text-secondary)", fontWeight: 600 }}>
        No files yet
      </p>
      <p style={{ margin: 0 }}>Files and folders you create in this vault appear here.</p>
    </div>
  );

  const loadingRow = (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--fs-sm)",
      }}
    >
      <Spinner size="xs" tone="neutral" />
      <span>Loading files…</span>
    </div>
  );

  return (
    <div
      className="vault-tree"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      {childErrors.length > 0 && (
        <div
          role="alert"
          className="tree-error-strip"
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            borderBottom: "1px solid var(--border)",
            background: "var(--danger-soft)",
            flex: "none",
            maxHeight: "40%",
            overflowY: "auto",
          }}
        >
          {childErrors.map((dir) => (
            <div
              key={dir}
              style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", margin: "var(--sp-1) 0" }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflowWrap: "anywhere",
                  color: "var(--danger)",
                  fontSize: "var(--fs-sm)",
                }}
              >
                {`Couldn't open ${dir}. `}
                {errorAt(state, dir)}
              </span>
              <button
                type="button"
                className="ghost-pill"
                style={RETRY_BUTTON_STYLE}
                onClick={() => void loadLevel(dir, true)}
              >
                Try again
              </button>
            </div>
          ))}
        </div>
      )}
      {rootError ? (
        <div
          role="alert"
          style={{ padding: "var(--sp-4) var(--sp-3)", color: "var(--text-tertiary)", fontSize: "var(--fs-sm)" }}
        >
          <p style={{ margin: "0 0 var(--sp-2)", color: "var(--danger)" }}>{rootError}</p>
          <button
            type="button"
            className="ghost-pill"
            style={RETRY_BUTTON_STYLE}
            onClick={() => void loadLevel(ROOT, true)}
          >
            Try again
          </button>
        </div>
      ) : !rootLoaded && busy ? (
        // The first level: the spinner occupies the space the rows will take.
        loadingRow
      ) : rootLoaded && data.length === 0 ? (
        emptyState
      ) : (
        <div className="filetree-scroll" ref={setTreeBox} style={{ flex: 1, minHeight: 0 }}>
          {busy && loadingRow}
          <Tree<TreeRowData>
            aria-label="Vault files"
            data={data}
            width="100%"
            height={height}
            rowHeight={ROW_HEIGHT}
            indent={14}
            paddingTop={4}
            paddingBottom={8}
            openByDefault={false}
            disableDrag
            disableDrop
            rowClassName="tree-rowwrap"
            onToggle={onToggle}
            onActivate={onActivate}
          >
            {Row}
          </Tree>
        </div>
      )}
    </div>
  );
}
