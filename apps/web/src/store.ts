import { create } from "zustand";
import type { Vault } from "./lib/api.js";
import { createVault as apiCreateVault, listVaults as apiListVaults } from "./lib/api.js";

/**
 * The app store. Baalda panel model — `sidebar`, `editor`, `rightPanel` plus
 * `activeOverlay` reserved for Phases 3-5 (nothing consumes it this phase) —
 * and the vaults slice that powers the Browse screen.
 */
export interface AppState {
  // Panel model (plumbing for later phases).
  sidebar: "tree" | "vaults";
  editor: "browse" | "edit";
  rightPanel: "backlinks" | "outline" | "frontmatter" | "lint";
  activeOverlay: "none" | "settings" | "graph" | "search" | "jobs";

  // Vaults slice.
  vaults: Vault[];
  vaultsLoading: boolean;
  vaultsError: string | null;
  loadVaults: () => Promise<void>;
  createVault: (name: string) => Promise<Vault>;
}

export const useStore = create<AppState>((set) => ({
  sidebar: "vaults",
  editor: "browse",
  rightPanel: "backlinks",
  activeOverlay: "none",

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