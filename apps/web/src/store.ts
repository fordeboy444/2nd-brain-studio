import { create } from "zustand";
import type { Vault } from "./lib/api.js";
import {
  createVault as apiCreateVault,
  getHealth,
  listVaults as apiListVaults,
  type HealthPayload,
} from "./lib/api.js";
import { readLastTab, writeLastTab, type RightPanelTab } from "./components/rightPanelTab.js";

/**
 * The app store. Baalda's panel model — `sidebar`, `editor`, `rightPanel` plus
 * the `activeOverlay` slot — with the vaults slice that powers the Browse screen.
 *
 * Two rules kept from the reference: the store holds *view state* (what is open,
 * which pane, which tab), never derived document data, and every async call goes
 * through `lib/api.ts` — no component calls `fetch`.
 */

/** A file open in the editor's tab strip. The buffer and its base hash are the
 *  document slice's (Phase 4); the shell only needs to know what is open. */
export interface TabRef {
  path: string;
  vaultId: string;
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

  // Open documents: the tab strip's list. `openFile` focuses an existing tab for
  // the same path instead of adding a duplicate. The buffer and its base hash
  // join the tab in Phase 4, with the editor.
  tabs: TabRef[];
  activeTabPath: string | null;
  openFile: (vaultId: string, path: string) => void;
  closeTab: (path: string) => void;
  backlinks: BacklinkRef[];

  // Vaults slice.
  vaults: Vault[];
  vaultsLoading: boolean;
  vaultsError: string | null;
  loadVaults: () => Promise<void>;
  createVault: (name: string) => Promise<Vault>;
}

export const useStore = create<AppState>((set, get) => ({
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
    // A different vault has different files: never carry a tab or a backlink
    // list across, the tree and the editor would both be describing the old one.
    set({ currentVault: vault, tabs: [], activeTabPath: null, backlinks: [] });
  },
  // Going back to the vault list. Same reset: nothing open survives leaving a vault.
  closeVault: () => set({ currentVault: null, tabs: [], activeTabPath: null, backlinks: [] }),

  tabs: [],
  activeTabPath: null,
  openFile: (vaultId, path) => {
    const { tabs } = get();
    // Focusing beats duplicating: a second tab onto the same file is two
    // buffers for one note, and one of them will lose.
    if (tabs.some((t) => t.path === path)) {
      set({ activeTabPath: path });
      return;
    }
    set({ tabs: [...tabs, { vaultId, path }], activeTabPath: path });
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
    set({ tabs: next, activeTabPath: nextActive });
  },
  backlinks: [],

  vaults: [],
  vaultsLoading: false,
  vaultsError: null,

  loadVaults: async () => {
    set({ vaultsLoading: true, vaultsError: null });
    try {
      const vaults = await apiListVaults();
      set({ vaults, vaultsLoading: false });
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
}));
