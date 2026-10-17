import { create } from "zustand";
import type { Vault } from "./lib/api.js";
import {
  ConflictError,
  createVault as apiCreateVault,
  deleteVault as apiDeleteVault,
  getHealth,
  listVaults as apiListVaults,
  readFile,
  writeFile,
  type HealthPayload,
} from "./lib/api.js";
import { readLastTab, writeLastTab, type RightPanelTab } from "./components/rightPanelTab.js";
import { dirOf } from "./lib/tree/lazyTree.js";

/**
 * The app store. Baalda's panel model — `sidebar`, `editor`, `rightPanel` plus
 * the `activeOverlay` slot — with the vaults slice that powers the Browse screen
 * and the document slice the tree and the editor share.
 *
 * Two rules kept from the reference: the store holds *view state* (what is open,
 * which pane, which tab), never derived document data, and every async call goes
 * through `lib/api.ts` — no component calls `fetch`.
 *
 * The document slice is ONE value, not one per component. The tree, the editor,
 * the Outline tab and the Frontmatter tab all read the same `tabs` entry, so the
 * panels cannot drift from the buffer the editor is showing.
 */

/**
 * A file open in the editor's tab strip, plus the document facts a save needs.
 *
 * `baseHash` is ALWAYS a hash the SERVER produced — the one the read returned, or
 * the one a previous successful write returned. It is never recomputed in the
 * browser: a client-computed hash would agree with the server every time and the
 * conflict check would be unfalsifiable. `null` means "the server has not
 * acknowledged this file existing yet", which is the create form.
 */
export interface Tab {
  path: string;
  vaultId: string;
  baseHash: string | null;
  /** The last content the server acknowledged; `null` until the read lands. */
  serverContent: string | null;
  /** What the editor shows. Equal to `serverContent` when there is nothing to save. */
  buffer: string;
  /** The read is in flight. The editor shows an indicator, never another tab's text. */
  loading: boolean;
  /** The read failed. Drives the editor region's load-failure message. */
  error: string | null;
  /** A write is in flight. Second save while true is refused. */
  saving: boolean;
}

/** A save the server refused because the file moved on disk (D-07). */
export interface PendingConflict {
  path: string;
  /** What is on disk now, verbatim — shown only if the user asks for it. */
  currentContent: string;
  /** The base hash that would make a write land. */
  currentHash: string;
}

/** A save that failed for any other reason. The buffer is untouched. */
export interface SaveFailure {
  path: string;
  message: string;
}

/** One note that links to the open one. Filled by the backlinks API (Phase 5). */
export interface BacklinkRef {
  id: string;
  path: string;
  /** The raw `[[…]]` target, shown only when it differs from the file name. */
  linkText?: string;
}

/** The overlays the shell reserves a slot for. Everything but `settings` is
 *  unpopulated this phase and must resolve to no content, not to a crash. */
export type OverlayName = "none" | "settings" | "graph" | "search" | "jobs";

export interface AppState {
  // Panel model.
  sidebar: "tree" | "vaults";
  editor: "browse" | "edit";
  activeOverlay: OverlayName;
  /** Whether the overlay slot is showing. Kept apart from `activeOverlay` so the
   *  shell remembers which screen to reopen without rendering it. */
  overlayOpen: boolean;
  openOverlay: (name: Exclude<OverlayName, "none">) => void;
  closeOverlay: () => void;

  // Right panel: which of the four tabs is showing, and whether the panel is
  // out at all. The panel is a pop-out over the editor, so these are two facts.
  rightPanelTab: RightPanelTab;
  rightPanelOpen: boolean;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openRightPanel: () => void;
  closeRightPanel: () => void;

  // Health slice — one source for the settings overlay and the header indicator.
  health: HealthPayload | null;
  healthError: string | null;
  loadHealth: () => Promise<void>;

  // Vault selection. No vault open means the Browse vault list is the screen.
  currentVault: Vault | null;
  openVault: (vault: Vault) => void;
  closeVault: () => void;

  // Open documents. `openFile` focuses an existing tab for the same path instead
  // of adding a duplicate — two tabs onto one path are two buffers for one note,
  // and one of them loses.
  tabs: Tab[];
  activeTabPath: string | null;
  openFile: (vaultId: string, path: string) => void;
  closeTab: (path: string) => void;
  setBuffer: (text: string) => void;
  saveActive: () => Promise<void>;
  /** A refused save, held until the user chooses one of the two actions. */
  conflict: PendingConflict | null;
  /** A save that failed for any reason other than a conflict. */
  saveError: SaveFailure | null;
  backlinks: BacklinkRef[];

  // Requests the panels raise and the editor/tree consume exactly once.
  /** An outline click asks the editor to reveal a one-based line. */
  pendingRevealLine: number | null;
  requestReveal: (line: number) => void;
  consumeReveal: () => number | null;
  /** A create asks the tree to re-read one level so the new row appears. */
  pendingTreeRefresh: string | null;
  requestTreeRefresh: (dir: string) => void;
  consumeTreeRefresh: () => string | null;

  // Vaults slice.
  vaults: Vault[];
  vaultsLoading: boolean;
  vaultsError: string | null;
  loadVaults: () => Promise<void>;
  createVault: (name: string) => Promise<Vault>;
  deleteVault: (vaultId: string, confirmName: string) => Promise<void>;
}

/** Is there anything to save? Only meaningful once the read has landed: a tab
 *  whose server content is still unknown is loading, not dirty. */
export function isDirty(tab: Tab): boolean {
  return tab.serverContent !== null && tab.buffer !== tab.serverContent;
}

/** Replace one tab immutably; every other tab keeps its identity. */
function patchTabs(tabs: Tab[], path: string, patch: Partial<Tab>): Tab[] {
  return tabs.map((t) => (t.path === path ? { ...t, ...patch } : t));
}

/** A fresh tab for a path nobody has read yet. */
function freshTab(vaultId: string, path: string): Tab {
  return {
    path,
    vaultId,
    baseHash: null,
    serverContent: null,
    buffer: "",
    loading: true,
    error: null,
    saving: false,
  };
}

export const useStore = create<AppState>((set, get) => {
  /** Patch one tab by path, wherever it is. */
  const setTab = (path: string, patch: Partial<Tab>) =>
    set((s) => ({ tabs: patchTabs(s.tabs, path, patch) }));

  /**
   * Read a file into its tab. A failure records the message on the tab and
   * leaves the tab in place, so the editor region can say what happened while
   * the tree stays usable.
   */
  const loadDocument = async (vaultId: string, path: string) => {
    try {
      const file = await readFile(vaultId, path);
      setTab(path, {
        baseHash: file.baseHash,
        serverContent: file.content,
        buffer: file.content,
        loading: false,
        error: null,
      });
    } catch (e) {
      setTab(path, { loading: false, error: (e as Error).message });
    }
  };

  return {
    sidebar: "vaults",
    editor: "browse",
    activeOverlay: "none",
    overlayOpen: false,
    openOverlay: (name) => set({ activeOverlay: name, overlayOpen: true }),
    closeOverlay: () => set({ overlayOpen: false }),

    // The remembered tab is a per-device convenience; the registry validates the
    // stored value, so this can never come back as an unknown tab. Choosing a tab
    // also opens the panel — a click inside a closed panel is not a thing.
    rightPanelTab: readLastTab(),
    rightPanelOpen: false,
    setRightPanelTab: (tab) => {
      writeLastTab(tab);
      set({ rightPanelTab: tab, rightPanelOpen: true });
    },
    openRightPanel: () => set({ rightPanelOpen: true }),
    closeRightPanel: () => set({ rightPanelOpen: false }),

    health: null,
    healthError: null,
    loadHealth: async () => {
      try {
        const health = await getHealth();
        set({ health, healthError: null });
      } catch (e) {
        set({ healthError: (e as Error).message });
      }
    },

    currentVault: null,
    openVault: (vault) => {
      // A different vault has different files: never carry a tab, a backlink list
      // or a conflict banner across, the tree and the editor would both be
      // describing the old one. The tree is remounted by the vault id changing,
      // so its levels reset with it.
      set({
        currentVault: vault,
        tabs: [],
        activeTabPath: null,
        backlinks: [],
        conflict: null,
        saveError: null,
        pendingRevealLine: null,
        pendingTreeRefresh: null,
      });
    },
    closeVault: () =>
      set({
        currentVault: null,
        tabs: [],
        activeTabPath: null,
        backlinks: [],
        conflict: null,
        saveError: null,
        pendingRevealLine: null,
        pendingTreeRefresh: null,
      }),

    tabs: [],
    activeTabPath: null,
    openFile: (vaultId, path) => {
      const existing = get().tabs.find((t) => t.path === path);
      if (existing) {
        // Focusing beats duplicating. A tab whose read failed gets one more try
        // from the same gesture — clicking the file again is the obvious retry,
        // and it is the only way back without reloading the vault.
        set({ activeTabPath: path });
        if (existing.error !== null && !existing.loading) {
          setTab(path, { loading: true, error: null });
          void loadDocument(vaultId, path);
        }
        return;
      }
      set((s) => ({ tabs: [...s.tabs, freshTab(vaultId, path)], activeTabPath: path }));
      void loadDocument(vaultId, path);
    },
    closeTab: (path) => {
      const { tabs, activeTabPath } = get();
      const index = tabs.findIndex((t) => t.path === path);
      if (index === -1) return;
      const next = tabs.filter((t) => t.path !== path);
      // Closing the active tab hands the editor to its left neighbour (the
      // browser's rule), or to whatever slid into its place, or to nothing.
      const nextActive =
        path !== activeTabPath ? activeTabPath : (next[index - 1]?.path ?? next[index]?.path ?? null);
      set((s) => ({
        tabs: next,
        activeTabPath: nextActive,
        // A conflict belongs to the tab it was raised on.
        conflict: s.conflict?.path === path ? null : s.conflict,
        saveError: s.saveError?.path === path ? null : s.saveError,
      }));
    },

    setBuffer: (text) => {
      const { activeTabPath, tabs } = get();
      if (!activeTabPath) return;
      const tab = tabs.find((t) => t.path === activeTabPath);
      if (!tab || tab.buffer === text) return;
      setTab(activeTabPath, { buffer: text });
      // Editing is the answer to a save failure: what the banner was reporting
      // ("your edit is still here") is still true, but the user has moved on.
      const failed = get().saveError;
      if (failed && failed.path === activeTabPath) set({ saveError: null });
    },

    saveActive: async () => {
      const { activeTabPath, tabs, conflict } = get();
      if (!activeTabPath) return;
      const tab = tabs.find((t) => t.path === activeTabPath);
      if (!tab) return;
      // A conflict is resolved by the user's choice, never by another save: a
      // second banner stacked on an unanswered one answers nothing (D-07).
      if (conflict && conflict.path === tab.path) return;
      if (tab.saving || tab.loading || tab.serverContent === null) return;
      if (!isDirty(tab)) return;

      // Capture the exact text being sent. A keystroke landing while the request
      // is in flight must not be recorded as saved, or the dirty marker would
      // clear over text the server never received.
      const sending = tab.buffer;
      const wasCreate = tab.baseHash === null;
      setTab(tab.path, { saving: true });
      try {
        const res = await writeFile(tab.vaultId, tab.path, sending, tab.baseHash);
        set((s) => ({
          tabs: patchTabs(s.tabs, tab.path, {
            saving: false,
            baseHash: res.baseHash,
            serverContent: sending,
          }),
          saveError: s.saveError?.path === tab.path ? null : s.saveError,
          // A file the server did not know about now exists, and the tree is
          // the only place that shows it. One level is re-read — the directory
          // the file landed in — rather than the whole tree: the sidebar shows
          // a row for a file the moment its level comes back.
          pendingTreeRefresh: wasCreate ? dirOf(tab.path) : s.pendingTreeRefresh,
        }));
      } catch (e) {
        // The BUFFER IS NEVER TOUCHED on either path below. Not on a conflict,
        // not on a failure: the user's text is still on screen and still in the
        // store, and only an explicit choice replaces it.
        set((s) => {
          const tabsNow = patchTabs(s.tabs, tab.path, { saving: false });
          if (e instanceof ConflictError) {
            // One banner at a time: an unresolved conflict keeps the first one.
            if (s.conflict && s.conflict.path === tab.path) return { tabs: tabsNow };
            return {
              tabs: tabsNow,
              conflict: {
                path: tab.path,
                currentContent: e.currentContent ?? "",
                currentHash: e.currentHash ?? "",
              },
            };
          }
          return {
            tabs: tabsNow,
            saveError: { path: tab.path, message: (e as Error).message },
          };
        });
      }
    },
    conflict: null,
    saveError: null,
    backlinks: [],

    pendingRevealLine: null,
    requestReveal: (line) => set({ pendingRevealLine: line }),
    consumeReveal: () => {
      const line = get().pendingRevealLine;
      if (line !== null) set({ pendingRevealLine: null });
      return line;
    },
    pendingTreeRefresh: null,
    requestTreeRefresh: (dir) => set({ pendingTreeRefresh: dir }),
    consumeTreeRefresh: () => {
      const dir = get().pendingTreeRefresh;
      if (dir !== null) set({ pendingTreeRefresh: null });
      return dir;
    },

    vaults: [],
    vaultsLoading: false,
    vaultsError: null,

    loadVaults: async () => {
      set({ vaultsLoading: true, vaultsError: null });
      try {
        const vaults = await apiListVaults();
        set({ vaults: vaults, vaultsLoading: false });
      } catch (e) {
        set({ vaultsError: (e as Error).message, vaultsLoading: false });
      }
    },

    createVault: async (name: string) => {
      const created = await apiCreateVault(name);
      // Append the created vault; previous entries stay intact.
      set((s) => ({ vaults: [...s.vaults, created] }));
      return created;
    },

    deleteVault: async (vaultId: string, confirmName: string) => {
      const { currentVault } = get();
      try {
        await apiDeleteVault(vaultId, confirmName);
      } catch (e) {
        // A vault the server no longer knows about is not a failure to report:
        // the user asked for it gone, and it is gone. Reconcile the local list
        // instead of showing an error for a state the user wanted.
        const status = (e as { status?: number }).status;
        if (status !== 404) throw e;
      }
      set((s) => ({
        vaults: s.vaults.filter((v) => v.id !== vaultId),
        // Leaving the deleted vault's screen behind: its tab set, its tree and
        // its conflict banner all describe a directory that no longer exists.
        ...(currentVault?.id === vaultId
          ? {
              currentVault: null,
              tabs: [],
              activeTabPath: null,
              conflict: null,
              saveError: null,
            }
          : {}),
      }));
    },
  };
});
