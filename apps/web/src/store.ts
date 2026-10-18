import { create } from "zustand";
import type { Vault } from "./lib/api.js";
import {
  cancelJob as apiCancelJob,
  ConflictError,
  createVault as apiCreateVault,
  deleteVault as apiDeleteVault,
  getHealth,
  getJob as apiGetJob,
  listJobs as apiListJobs,
  listVaults as apiListVaults,
  readFile,
  writeFile,
  type HealthPayload,
  type JobStage,
  type JobSummary,
  type SkippedUnit,
} from "./lib/api.js";
import { readLastTab, writeLastTab, type RightPanelTab } from "./components/rightPanelTab.js";
import { dirOf, EMPTY_TREE, type TreeState } from "./lib/tree/lazyTree.js";

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
  /**
   * What is on disk now, verbatim — shown only if the user asks for it.
   * `null` when the server sent nothing to reload.
   */
  currentContent: string | null;
  /**
   * The base hash that would make a write land. `null` means the file is GONE
   * from disk (`code: "create_conflict"`): there are no server-side bytes, so
   * there is nothing to reload, and `null` is the hash that recreates the file.
   * Never coerce a missing hash to `""` — an empty string can never equal a
   * SHA-256, so the retry would fail forever.
   */
  currentHash: string | null;
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

/** The overlays the shell reserves a slot for. Everything but `settings` and
 *  `jobs` is unpopulated this phase and must resolve to no content, not to a
 *  crash. */
export type OverlayName = "none" | "settings" | "graph" | "search" | "jobs";

/* -------------------------------------------------------------------------
   Jobs slice
   ------------------------------------------------------------------------- */

/**
 * The SSE connection's state, as the detail header reports it.
 *
 * `idle` means there is no source (nothing selected, or the job finished);
 * `open` means one is connected; `reconnecting` means the browser's
 * `EventSource` reported an error and is retrying on the same URL with
 * `Last-Event-ID`.
 */
export type SseState = "idle" | "open" | "reconnecting";

/** One row of the live unit feed. `seq` is the dedupe key for replay + live. */
export interface UnitFeedRow {
  seq: number;
  slug: string;
  stage: string;
  status: string;
  reason?: string;
  detail?: string;
  tier?: number;
}

/** The feed keeps the tail of a long job; the DOM never grows without bound. */
export const UNIT_FEED_LIMIT = 500;

/** The two implemented stages per job kind. S2-S6 are declared, not executable. */
export const LIVE_STAGES: Record<"youtube" | "web", readonly JobStage[]> = {
  youtube: ["S0", "S1"],
  web: ["S0", "S1w"],
};

/** Where the pointer says the job is: earlier live stages are done, one is active. */
export function seedStages(job: JobSummary): {
  stagesDone: JobStage[];
  activeStage: JobStage | null;
} {
  const table = LIVE_STAGES[job.kind];
  if (job.stage === "done") return { stagesDone: [...table], activeStage: null };
  if (job.stage === undefined) return { stagesDone: [], activeStage: null };
  const index = table.indexOf(job.stage);
  if (index < 0) return { stagesDone: [], activeStage: null };
  return {
    stagesDone: table.slice(0, index),
    activeStage: job.stage,
  };
}

/**
 * The stage named by an event payload, or null when the payload is not one of
 * the two live stages. A future stage name must not enter the stepper as an
 * unknown dot; it is ignored here and the stepper keeps its current truth.
 */
function liveStageOf(value: unknown): JobStage | null {
  return value === "S0" || value === "S1" || value === "S1w" ? value : null;
}

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
  /**
   * Take the server's version (D-07, action 1). The ONLY path that replaces the
   * buffer: the user asked for it, in as many words.
   */
  reloadFromDisk: () => void;
  /**
   * Send the user's text over the server's (D-07, action 2), rebased on the hash
   * the CONFLICT returned — not the tab's original base hash, which is the one
   * that just lost.
   */
  keepMine: () => Promise<void>;
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

  /**
   * What the sidebar has actually read, mirrored here for readers that are not
   * the sidebar (UI-10).
   *
   * The tree OWNS this: `VaultTree` holds the real state and publishes every
   * change through `setTreeState`, and nothing else ever writes it. It is in the
   * store because `MarkdownView` has to answer "does this link's target exist?"
   * while rendering a document, and the only honest answer is the set of
   * directories that have been read (`lib/linkResolve.ts`). Passing it down
   * through the editor region would mean four intermediate components learning
   * about the tree; a read-only projection is the smaller lie.
   */
  treeState: TreeState;
  setTreeState: (state: TreeState) => void;

  // Vaults slice.
  vaults: Vault[];
  vaultsLoading: boolean;
  vaultsError: string | null;
  loadVaults: () => Promise<void>;
  createVault: (name: string) => Promise<Vault>;
  deleteVault: (vaultId: string, confirmName: string) => Promise<void>;

  // Jobs slice. The list polls; the detail owns one SSE source. Both write the
  // same `jobs` array keyed by id, so a job can never appear twice.
  jobs: JobSummary[];
  jobsLoading: boolean;
  jobsError: string | null;
  selectedJobId: string | null;
  selectedJob: JobSummary | null;
  unitFeed: UnitFeedRow[];
  /** The highest `seq` applied. Replay frames at or below it are ignored. */
  lastSeq: number;
  sseState: SseState;
  /** Live stages whose `stage` event completed, in arrival order. */
  stagesDone: JobStage[];
  /** The live stage the job is in, or null when nothing is running. */
  activeStage: JobStage | null;
  /** True once more than `UNIT_FEED_LIMIT` rows have arrived. */
  feedCapped: boolean;
  loadJobs: () => Promise<void>;
  selectJob: (id: string) => Promise<void>;
  /**
   * Apply one SSE frame. `seq` is the dedupe key: a replayed frame at or below
   * the last applied seq is ignored, so reconnect cannot duplicate a row.
   */
  applyJobEvent: (seq: number, type: string, data: Record<string, unknown>) => void;
  cancelSelectedJob: () => Promise<void>;
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
        treeState: EMPTY_TREE,
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
        treeState: EMPTY_TREE,
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
                currentContent: e.currentContent,
                currentHash: e.currentHash,
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

    // The two answers to a 409 (D-07). Nothing else in the store replaces the
    // buffer, and nothing else writes without a base hash the server produced.
    reloadFromDisk: () => {
      const { conflict } = get();
      if (!conflict) return;
      // A create conflict carries no server-side bytes — the file was deleted,
      // so there is nothing to reload. Letting this run would assign `null` to
      // both the buffer and the base hash, blanking the editor and marking the
      // tab clean with the user's text gone.
      //
      // Bound to LOCALS first: TypeScript drops a narrowing on an object's
      // property once that property is read inside a callback, because the
      // callback can run long after the guard. The locals keep the narrowing.
      const { path, currentContent, currentHash } = conflict;
      if (currentContent === null || currentHash === null) return;
      // The server's bytes become both the reference content and what is on
      // screen, and the hash that came with them becomes the base — so after
      // this the tab is clean, and the next save is guarded by the hash that
      // actually matches the disk rather than the one that just lost.
      set((s) => ({
        tabs: patchTabs(s.tabs, path, {
          buffer: currentContent,
          serverContent: currentContent,
          baseHash: currentHash,
          error: null,
          loading: false,
        }),
        conflict: null,
      }));
    },

    keepMine: async () => {
      const { conflict, tabs } = get();
      if (!conflict) return;
      const tab = tabs.find((t) => t.path === conflict.path);
      if (!tab || tab.saving) return;
      const sending = tab.buffer;
      setTab(conflict.path, { saving: true });
      try {
        // `conflict.currentHash`, never `tab.baseHash`: the tab's base is the
        // hash that just lost, and sending it again is the same 409 twice.
        // `null` is correct for a create conflict: the file is gone, so `null`
        // is the hash that recreates it.
        const res = await writeFile(tab.vaultId, conflict.path, sending, conflict.currentHash);
        set((s) => ({
          tabs: patchTabs(s.tabs, conflict.path, {
            saving: false,
            baseHash: res.baseHash,
            serverContent: sending,
          }),
          conflict: null,
        }));
      } catch (e) {
        set((s) => {
          const tabsNow = patchTabs(s.tabs, conflict.path, { saving: false });
          if (e instanceof ConflictError) {
            // It moved again while the user was deciding. One banner carrying
            // the fresher server state — not a second banner stacked on it.
            return {
              tabs: tabsNow,
              conflict: {
                path: conflict.path,
                currentContent: e.currentContent,
                currentHash: e.currentHash,
              },
            };
          }
          // Failed for some other reason: the question the conflict asked is
          // still unanswered, so it stays up, and the failure is reported
          // beside it.
          return {
            tabs: tabsNow,
            saveError: { path: conflict.path, message: (e as Error).message },
          };
        });
      }
    },

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

    treeState: EMPTY_TREE,
    setTreeState: (state) => set({ treeState: state }),

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
              treeState: EMPTY_TREE,
            }
          : {}),
      }));
    },

    /* ---- Jobs slice ---- */

    jobs: [],
    jobsLoading: false,
    jobsError: null,
    selectedJobId: null,
    selectedJob: null,
    unitFeed: [],
    lastSeq: 0,
    sseState: "idle",
    stagesDone: [],
    activeStage: null,
    feedCapped: false,

    /**
     * Poll the list. A failure keeps the previous rows and records the error,
     * so the screen can say "Checking…" or show a banner without ever blanking
     * the list the user is reading.
     */
    loadJobs: async () => {
      set({ jobsLoading: true, jobsError: null });
      try {
        const { jobs } = await apiListJobs();
        set((s) => {
          // Dedupe by id, first occurrence's position wins. The route already
          // returns unique ids; this keeps the invariant local to the store.
          const byId = new Map<string, JobSummary>();
          for (const job of jobs) byId.set(job.id, job);
          const selected = s.selectedJob;
          const merged = [...byId.values()].map((job) =>
            // The stream may be ahead of the poll. For the SAME id the stream's
            // fields win, because they are the newer observation.
            selected !== null && selected.id === job.id ? { ...job, ...selected } : job,
          );
          const selectedJob =
            selected !== null
              ? (merged.find((job) => job.id === selected.id) ?? selected)
              : null;
          return { jobs: merged, selectedJob, jobsLoading: false };
        });
      } catch (e) {
        set({ jobsError: (e as Error).message, jobsLoading: false });
      }
    },

    /**
     * Select one job. The feed and the seq cursor belong to the selection, so
     * they reset here: a row from the previous job must never appear under the
     * new one, and `lastSeq` must not suppress the new job's first frames.
     */
    selectJob: async (id) => {
      set({
        selectedJobId: id,
        selectedJob: null,
        unitFeed: [],
        lastSeq: 0,
        sseState: "idle",
        stagesDone: [],
        activeStage: null,
        feedCapped: false,
      });
      try {
        const job = await apiGetJob(id);
        // A slower response for a job the user already left must not win.
        if (get().selectedJobId !== id) return;
        const seeded = seedStages(job);
        set((s) => ({
          selectedJob: job,
          stagesDone: seeded.stagesDone,
          activeStage: seeded.activeStage,
          jobs: s.jobs.map((row) => (row.id === id ? { ...row, ...job } : row)),
        }));
      } catch (e) {
        if (get().selectedJobId !== id) return;
        set({ jobsError: (e as Error).message, selectedJob: null });
      }
    },

    applyJobEvent: (seq, type, data) => {
      const s = get();
      // Replay and live frames share one cursor. `<=` makes a replayed frame
      // idempotent and turns two copies of one event into one row.
      if (!Number.isFinite(seq) || seq <= s.lastSeq) return;

      let selectedJob = s.selectedJob;
      let stagesDone = s.stagesDone;
      let activeStage = s.activeStage;
      let unitFeed = s.unitFeed;
      let feedCapped = s.feedCapped;
      let sseState = s.sseState;

      if (type === "job") {
        const patch = (
          typeof data.job === "object" && data.job !== null ? data.job : data
        ) as Partial<JobSummary>;
        if (selectedJob !== null) {
          selectedJob = { ...selectedJob, ...patch };
          const seeded = seedStages(selectedJob);
          stagesDone = seeded.stagesDone;
          activeStage = seeded.activeStage;
        }
      } else if (type === "stage") {
        const stage = liveStageOf(data.stage);
        if (stage !== null) {
          if (data.status === "started") {
            activeStage = stage;
            stagesDone = stagesDone.filter((done) => done !== stage);
            if (selectedJob !== null) selectedJob = { ...selectedJob, stage };
          } else if (data.status === "completed") {
            if (!stagesDone.includes(stage)) stagesDone = [...stagesDone, stage];
            if (activeStage === stage) activeStage = null;
          }
        }
      } else if (type === "unit") {
        const row: UnitFeedRow = {
          seq,
          slug: typeof data.slug === "string" ? data.slug : "",
          stage: typeof data.stage === "string" ? data.stage : "",
          status: typeof data.status === "string" ? data.status : "",
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
          ...(typeof data.detail === "string" ? { detail: data.detail } : {}),
          ...(typeof data.tier === "number" ? { tier: data.tier } : {}),
        };
        const next = [...unitFeed, row];
        if (next.length > UNIT_FEED_LIMIT) {
          unitFeed = next.slice(next.length - UNIT_FEED_LIMIT);
          feedCapped = true;
        } else {
          unitFeed = next;
        }
      } else if (type === "done") {
        activeStage = null;
        sseState = "idle";
        const status = data.status;
        if (
          selectedJob !== null &&
          (status === "completed" || status === "failed" || status === "cancelled")
        ) {
          selectedJob = { ...selectedJob, status, stage: "done" };
          if (status === "completed") stagesDone = [...LIVE_STAGES[selectedJob.kind]];
        }
      }

      // The list and the detail are one job by id: a stream update is reflected
      // in the row the poll last returned instead of creating a second entry.
      const selected = selectedJob;
      const jobs =
        selected !== null && s.selectedJobId === selected.id
          ? s.jobs.map((row) => (row.id === selected.id ? { ...row, ...selected } : row))
          : s.jobs;

      set({
        lastSeq: seq,
        selectedJob,
        stagesDone,
        activeStage,
        unitFeed,
        feedCapped,
        sseState,
        jobs,
      });
    },

    cancelSelectedJob: async () => {
      const id = get().selectedJobId;
      if (id === null) return;
      try {
        const res = await apiCancelJob(id);
        set((s) => ({
          selectedJob:
            s.selectedJob !== null && s.selectedJob.id === id
              ? { ...s.selectedJob, status: res.status }
              : s.selectedJob,
          jobs: s.jobs.map((job) => (job.id === id ? { ...job, status: res.status } : job)),
        }));
      } catch (e) {
        set({ jobsError: (e as Error).message });
      }
      // The runner's own record is the authority on the status that follows the
      // cancel flag, so refresh the list rather than inventing one here.
      await get().loadJobs();
    },
  };
});
