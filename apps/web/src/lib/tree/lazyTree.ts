/**
 * The lazy tree's state helpers (VAULT-02).
 *
 * The vault is never walked up front. One directory level is read at a time from
 * `GET /api/vaults/:id/tree?dir=`, and a level is read exactly once: it is
 * marked loaded when its fetch lands, and the component asks `needsFetch` before
 * it requests anything, so re-expanding a directory costs no request. A failed
 * level is NOT marked loaded — expanding it again retries, which is the only way
 * back from a transient failure without a page reload.
 *
 * PORTED SHAPE, not a ported file. The read-only reference
 * (`baalda/app/apps/desktop/src/lib/tree/lazyTree.ts`) keeps the same three
 * ideas — a `{path: children}` map, a loaded-check, and a setter — but every
 * export there takes the reference's Tauri `TreeNode`, knows about its
 * collaboration/presence layer, and carries rename/drag plumbing this app does
 * not have. What was kept is the data shape (`levels` keyed by the directory's
 * vault-relative path, `""` for the root) and the one-shot-per-level rule.
 *
 * LIBRARY ADAPTATION (plan assumption A3, recorded in 01-04-SUMMARY.md):
 * `react-arborist` derives leaf-ness from the data itself, not from a prop —
 * `NodeApi.isLeaf` is `!Array.isArray(this.children)`. An unloaded directory
 * therefore cannot carry `children: undefined`, or it renders as a file with no
 * expand toggle and its children can never be fetched. `treeData` below gives
 * every directory an array: the loaded level when there is one, `[]` when there
 * is not. That is the entire adaptation; the endpoint's node shape is unchanged.
 */
import { listTree, type TreeEntry } from "../api.js";

/** The root level's key. The endpoint's own default dir is `.`; the client's
 *  spelling of "the root" is the empty string, and `listTree` translates. */
export const ROOT = "";

/** Vault-relative directory path → that level's entries, in server order. */
export type Levels = Record<string, TreeEntry[]>;

export interface TreeState {
  levels: Levels;
  /** Directory path → a fetch is in flight for that level. */
  loading: Record<string, boolean>;
  /** Directory path → the last fetch failure's message. Cleared on retry. */
  errors: Record<string, string>;
}

export const EMPTY_TREE: TreeState = { levels: {}, loading: {}, errors: {} };

/** The directory part of a vault-relative path; `""` for a root-level file. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? ROOT : path.slice(0, cut);
}

/** The base name of a vault-relative path. */
export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isLoaded(state: TreeState, dir: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.levels, dir);
}

export function isLoading(state: TreeState, dir: string): boolean {
  return state.loading[dir] === true;
}

/** Any level fetching right now — the panel-scoped loading indication. */
export function isBusy(state: TreeState): boolean {
  return Object.keys(state.loading).some((k) => state.loading[k] === true);
}

export function errorAt(state: TreeState, dir: string): string | null {
  return state.errors[dir] ?? null;
}

/**
 * Whether this level still needs a request: not loaded yet (an empty directory
 * IS loaded — zero entries is a real answer) and no request already in flight.
 */
export function needsFetch(state: TreeState, dir: string): boolean {
  return !isLoaded(state, dir) && !isLoading(state, dir);
}

export function markLoading(state: TreeState, dir: string): TreeState {
  const errors = { ...state.errors };
  delete errors[dir];
  return { ...state, loading: { ...state.loading, [dir]: true }, errors };
}

export function markLoaded(state: TreeState, dir: string, entries: TreeEntry[]): TreeState {
  const loading = { ...state.loading };
  delete loading[dir];
  return {
    levels: { ...state.levels, [dir]: entries },
    loading,
    errors: state.errors,
  };
}

/** A failure leaves the level unloaded, so the next expand retries it. */
export function markFailed(state: TreeState, dir: string, message: string): TreeState {
  const loading = { ...state.loading };
  delete loading[dir];
  return { ...state, loading, errors: { ...state.errors, [dir]: message } };
}

/** Drop a level so the next expand re-reads it (the post-create refresh). */
export function forget(state: TreeState, dir: string): TreeState {
  const levels = { ...state.levels };
  delete levels[dir];
  return { ...state, levels };
}

/**
 * Read one level. The only network call in this module, and the only place a
 * component can reach the tree endpoint.
 */
export async function fetchLevel(vaultId: string, dir: string): Promise<TreeEntry[]> {
  const listing = await listTree(vaultId, dir === ROOT ? undefined : dir);
  return listing.entries;
}

/**
 * A directory row's data plus its loaded children.
 *
 * `children` is ALWAYS an array on a directory (see the adaptation note above).
 * A file has none at all, which is what makes it a leaf and what stops the row
 * offering an expand toggle it could never satisfy.
 */
export interface TreeRowData extends TreeEntry {
  children?: TreeRowData[];
}

/**
 * Build the row for one entry, attaching its level when that level is loaded.
 *
 * `seen` is the directories already on this branch. A listing that hands back a
 * directory already above it — a duplicated entry, a symlink the server followed
 * back on itself — would otherwise recurse until the stack overflows, which is a
 * crashed sidebar rather than a slightly wrong one. The repeat stops here: it
 * keeps its row and gets no children.
 */
function row(state: TreeState, entry: TreeEntry, seen: ReadonlySet<string>): TreeRowData {
  if (!entry.isDir) return entry;
  const level = state.levels[entry.path];
  if (!level || seen.has(entry.path)) return { ...entry, children: [] };
  const branch = new Set(seen).add(entry.path);
  return { ...entry, children: level.map((child) => row(state, child, branch)) };
}

/**
 * The whole loaded tree, nested, rooted at the vault root. Only the levels that
 * have actually been fetched are present — this flattening never invents rows
 * for directories nobody has opened.
 */
export function treeData(state: TreeState): TreeRowData[] {
  const root: ReadonlySet<string> = new Set();
  return (state.levels[ROOT] ?? []).map((entry) => row(state, entry, root));
}

/**
 * Whether a loaded level holds an entry with this base name. `null` when the
 * level has not been loaded — the caller must distinguish "absent" from
 * "unknown", because treating an unloaded directory as absent is how every
 * not-yet-expanded link target turns into a false broken link (UI-10).
 */
export function levelContains(state: TreeState, dir: string, name: string): boolean | null {
  const level = state.levels[dir];
  if (!level) return null;
  return level.some((e) => e.name === name);
}

/** The loaded level for a directory, or null if it has not been fetched. */
export function levelAt(state: TreeState, dir: string): TreeEntry[] | null {
  return state.levels[dir] ?? null;
}
