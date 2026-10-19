import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveStagesFor, seedStages, useStore, type AppState } from "./store.js";
import type { JobSummary, Vault } from "./lib/api.js";
import { clearToasts, getToasts } from "./lib/toast.js";

/**
 * The jobs slice's invariants, asserted without a DOM.
 *
 * `applyJobEvent` is the seam where replay and live frames meet, so the two
 * things that can go wrong there are duplicated rows and a cursor that moves
 * backwards. Both are cheap to state and expensive to discover in a browser.
 */

const INITIAL: Partial<AppState> = {
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
  settings: null,
  settingsLoading: false,
  settingsError: null,
  testLlmResult: null,
  previewResult: null,
  previewLoading: false,
  previewError: null,
  ingestStarting: false,
  ingestError: null,
  activeOverlay: "none",
  overlayOpen: false,
};

const originalFetch = globalThis.fetch;

function makeJob(over: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "j1",
    vaultId: "v1",
    kind: "youtube",
    status: "running",
    stage: "S0",
    input: { url: "https://www.youtube.com/@studio" },
    createdAt: "2026-10-18T12:00:00Z",
    updatedAt: "2026-10-18T12:00:00Z",
    progress: { done: 0, total: 2 },
    skipped: [],
    error: null,
    cancelRequested: false,
    ...over,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useStore.setState(INITIAL);
  clearToasts();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it("ignores a seq at or below the cursor and applies the next one", () => {
  const apply = useStore.getState().applyJobEvent;

  apply(7, "unit", { slug: "u7", stage: "S1", status: "written" });
  apply(5, "unit", { slug: "u5", stage: "S1", status: "written" });
  apply(7, "unit", { slug: "u7-again", stage: "S1", status: "written" });

  expect(useStore.getState().lastSeq).toBe(7);
  expect(useStore.getState().unitFeed.map((row) => row.slug)).toEqual(["u7"]);

  apply(8, "unit", { slug: "u8", stage: "S1", status: "written" });
  expect(useStore.getState().lastSeq).toBe(8);
  expect(useStore.getState().unitFeed.map((row) => row.slug)).toEqual(["u7", "u8"]);
});

it("turns two unit events with the same seq into one row", () => {
  const apply = useStore.getState().applyJobEvent;
  apply(3, "unit", { slug: "same", stage: "S1", status: "written" });
  apply(3, "unit", { slug: "same", stage: "S1", status: "written" });
  expect(useStore.getState().unitFeed.length).toBe(1);
});

it("caps the feed at the last 500 rows and raises feedCapped", () => {
  const apply = useStore.getState().applyJobEvent;
  for (let seq = 1; seq <= 501; seq += 1) {
    apply(seq, "unit", { slug: `u${seq}`, stage: "S1", status: "written" });
  }
  const feed = useStore.getState().unitFeed;
  expect(feed.length).toBe(500);
  expect(feed[0]?.seq).toBe(2);
  expect(feed.at(-1)?.seq).toBe(501);
  expect(useStore.getState().feedCapped).toBe(true);
});

it("derives the stepper from the job's own stage pointer", () => {
  expect(seedStages(makeJob({ stage: "S1" }))).toEqual({
    stagesDone: ["S0"],
    activeStage: "S1",
  });
  expect(seedStages(makeJob({ kind: "web", stage: "S1w" }))).toEqual({
    stagesDone: ["S0"],
    activeStage: "S1w",
  });
  expect(seedStages(makeJob({ stage: "done" }))).toEqual({
    stagesDone: ["S0", "S1", "S2", "S3", "S4", "S5"],
    activeStage: null,
  });
});

it("lists every live stage per kind, and S6 only when the sweep is on", () => {
  expect(liveStagesFor("youtube", false)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5"]);
  expect(liveStagesFor("web", false)).toEqual(["S0", "S1w", "S2", "S3", "S4", "S5"]);
  expect(liveStagesFor("youtube", true)).toEqual([
    "S0",
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
  ]);
  expect(liveStagesFor("web", true)).toEqual(["S0", "S1w", "S2", "S3", "S4", "S5", "S6"]);
});

it("seeds an S3 job from the widened live table, honoring its sweep flag", () => {
  expect(seedStages(makeJob({ stage: "S3", settings: { sweep: { enabled: false } } }))).toEqual({
    stagesDone: ["S0", "S1", "S2"],
    activeStage: "S3",
  });
  expect(seedStages(makeJob({ stage: "done", settings: { sweep: { enabled: true } } }))).toEqual({
    stagesDone: ["S0", "S1", "S2", "S3", "S4", "S5", "S6"],
    activeStage: null,
  });
});

it("merges poll results by job id, so a job never appears twice", async () => {
  const job = makeJob();
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [job, { ...job, updatedAt: "2026-10-18T12:01:00Z" }] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().jobs.length).toBe(1);
  expect(useStore.getState().jobs[0]?.id).toBe("j1");
  expect(useStore.getState().jobsLoading).toBe(false);
});

it("lets a fresher poll replace the stale selected detail", async () => {
  const stale = makeJob({ status: "running", updatedAt: "2026-10-18T12:00:00Z" });
  const fresh = makeJob({
    status: "completed",
    stage: "done",
    updatedAt: "2026-10-18T13:00:00Z",
  });
  useStore.setState({ selectedJobId: "j1", selectedJob: stale, jobs: [stale] });
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [fresh] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  // The poll is the fallback truth while the stream reconnects.
  expect(useStore.getState().selectedJob?.status).toBe("completed");
  expect(useStore.getState().jobs[0]?.status).toBe("completed");
});

it("reseeds the stepper when a poll ends the selected job while the stream is down", async () => {
  const running = makeJob({ status: "running", stage: "S1" });
  const done = makeJob({
    status: "completed",
    stage: "done",
    progress: { done: 2, total: 2 },
    updatedAt: "2026-10-18T12:05:00Z",
  });
  useStore.setState({
    selectedJobId: "j1",
    selectedJob: running,
    jobs: [running],
    sseState: "idle",
    stagesDone: ["S0"],
    activeStage: "S1",
  });
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [done] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().selectedJob?.status).toBe("completed");
  expect(useStore.getState().activeStage).toBeNull();
  expect(useStore.getState().stagesDone).toEqual(["S0", "S1", "S2", "S3", "S4", "S5"]);
});

it("does not let a slow poll reopen a job the stream already finished", async () => {
  const completed = makeJob({ status: "completed", stage: "done" });
  const stale = makeJob({ status: "running", stage: "S1" });
  useStore.setState({
    selectedJobId: "j1",
    selectedJob: completed,
    jobs: [completed],
    sseState: "open",
    stagesDone: ["S0", "S1"],
    activeStage: null,
  });
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [stale] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().selectedJob?.status).toBe("completed");
  expect(useStore.getState().activeStage).toBeNull();
  // The list and the detail are one job: the kept row shows the stream's truth.
  expect(useStore.getState().jobs[0]?.status).toBe("completed");
});

it("keeps a terminal job when the poll snapshot is not newer", async () => {
  const cancelled = makeJob({ status: "cancelled", stage: "done" });
  const stale = makeJob({ status: "running", stage: "S1" });
  useStore.setState({
    selectedJobId: "j1",
    selectedJob: cancelled,
    jobs: [cancelled],
    sseState: "idle",
    activeStage: null,
  });
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [stale] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().selectedJob?.status).toBe("cancelled");
  expect(useStore.getState().jobs[0]?.status).toBe("cancelled");
});

it("revives a completed job when a retry bumped the poll's updatedAt", async () => {
  const completed = makeJob({
    status: "completed",
    stage: "done",
    updatedAt: "2026-10-18T12:00:00Z",
  });
  const retried = makeJob({
    status: "queued",
    stage: "S2",
    updatedAt: "2026-10-18T12:05:00Z",
  });
  useStore.setState({
    selectedJobId: "j1",
    selectedJob: completed,
    jobs: [completed],
    sseState: "idle",
    stagesDone: ["S0", "S1", "S2", "S3", "S4", "S5", "S6"],
    activeStage: null,
  });
  globalThis.fetch = vi.fn(async () =>
    json({ jobs: [retried] }),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().selectedJob?.status).toBe("queued");
  expect(useStore.getState().selectedJob?.stage).toBe("S2");
  expect(useStore.getState().jobs[0]?.status).toBe("queued");
  // The stepper reseeds from the revived record.
  expect(useStore.getState().activeStage).toBe("S2");
});

const SETTINGS_PAYLOAD = {
  settings: {
    llm: { model: "m", concurrency: 1, requestTimeoutMs: 1000, maxRetries: 3 },
    fetch: { delayMs: 1000, concurrency: 2, language: "en" },
    sweep: { enabled: true },
    ui: { theme: "system" as const },
  },
  hasYoutubeCookie: false,
  youtubeCookieUpdatedAt: null,
  hasSupadataKey: false,
  llmConfigured: true,
};

it("uploads the cookie text as text/plain and refreshes the redacted status", async () => {
  const cookieText = "www.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tSECRET\n";
  let sentContentType = "";
  let sentBody = "";
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/youtube-cookie" && init?.method === "POST") {
      sentContentType = (init.headers as Headers).get("content-type") ?? "";
      sentBody = typeof init.body === "string" ? init.body : "";
      return json({ hasYoutubeCookie: true, youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z" });
    }
    if (url === "/api/settings") {
      return json({
        ...SETTINGS_PAYLOAD,
        hasYoutubeCookie: true,
        youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z",
      });
    }
    return json({});
  }) as unknown as typeof fetch;

  await useStore.getState().uploadCookie(cookieText);

  expect(sentContentType).toContain("text/plain");
  expect(sentBody).toBe(cookieText);
  expect(useStore.getState().settings?.hasYoutubeCookie).toBe(true);
  expect(useStore.getState().settingsError).toBeNull();
  // The body itself is never stored: one screen render away is too close.
  expect(JSON.stringify(useStore.getState().settings)).not.toContain("SECRET");
});

it("deletes the cookie and clears the presence flag", async () => {
  useStore.setState({ settings: { ...SETTINGS_PAYLOAD, hasYoutubeCookie: true } });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/youtube-cookie" && init?.method === "DELETE") {
      return json({ hasYoutubeCookie: false });
    }
    if (url === "/api/settings") return json(SETTINGS_PAYLOAD);
    return json({});
  }) as unknown as typeof fetch;

  await useStore.getState().deleteCookie();

  expect(useStore.getState().settings?.hasYoutubeCookie).toBe(false);
});

it("resolves true after a settings write and false instead of throwing", async () => {
  globalThis.fetch = vi.fn(async () => json(SETTINGS_PAYLOAD)) as unknown as typeof fetch;
  await expect(
    useStore.getState().saveSettings({ sweep: { enabled: true } }),
  ).resolves.toBe(true);
  expect(useStore.getState().settingsError).toBeNull();

  globalThis.fetch = vi.fn(async () =>
    json({ error: "io", message: "down" }, 500),
  ) as unknown as typeof fetch;
  // The switch needs a value, not a rejection: false is the whole failure signal.
  await expect(
    useStore.getState().saveSettings({ sweep: { enabled: false } }),
  ).resolves.toBe(false);
  expect(useStore.getState().settingsError).toBe("down");
});

it("starts one job when two calls race in the same tick", async () => {
  let calls = 0;
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = vi.fn(async () => {
    calls += 1;
    await hold;
    return json({ id: "j1", status: "queued" });
  }) as unknown as typeof fetch;

  const input = { vaultId: "v1", kind: "web" as const, url: "https://example.com" };
  const first = useStore.getState().startIngest(input);
  const second = useStore.getState().startIngest(input);

  // The flag is set before the await, so the second call never reaches fetch.
  expect(useStore.getState().ingestStarting).toBe(true);
  release();
  await Promise.all([first, second]);

  expect(calls).toBe(1);
  expect(useStore.getState().ingestStarting).toBe(false);
  expect(useStore.getState().ingestError).toBeNull();
  expect(useStore.getState().activeOverlay).toBe("jobs");
});

it("keeps the approved start-failure copy and releases the guard", async () => {
  globalThis.fetch = vi.fn(async () =>
    json({ error: "bad_request", message: "nope" }, 400),
  ) as unknown as typeof fetch;

  await useStore
    .getState()
    .startIngest({ vaultId: "v1", kind: "web", url: "https://example.com" });

  expect(useStore.getState().ingestError).toBe(
    "Couldn't start the job. Check the source URL and try again.",
  );
  expect(useStore.getState().ingestStarting).toBe(false);
});

it("drops a read from the previous vault when it lands after a vault switch", async () => {
  const vaultA: Vault = {
    id: "a",
    name: "Vault A",
    path: "a",
    sourceKind: "manual",
    createdAt: "2026-10-18T12:00:00Z",
    lastOpenedAt: "2026-10-18T12:00:00Z",
  };
  const vaultB: Vault = { ...vaultA, id: "b", name: "Vault B", path: "b" };

  let releaseRead = () => {};
  const heldRead = new Promise<Response>((resolve) => {
    releaseRead = () =>
      resolve(json({ path: "index.md", content: "A content", baseHash: "hash-a" }));
  });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.includes("vault=a")
      ? heldRead
      : json({ path: "index.md", content: "B content", baseHash: "hash-b" });
  }) as unknown as typeof fetch;

  useStore.setState({ ...INITIAL, currentVault: null, tabs: [], activeTabPath: null });
  useStore.getState().openVault(vaultA);
  useStore.getState().openFile("a", "index.md");
  // Switch while A's read is still in flight, then open the same path in B.
  useStore.getState().openVault(vaultB);
  useStore.getState().openFile("b", "index.md");
  await vi.waitFor(() => {
    expect(useStore.getState().tabs[0]?.serverContent).toBe("B content");
  });
  // Unsaved text typed into B's tab must survive A's late read.
  useStore.getState().setBuffer("B unsaved text");

  releaseRead();
  await heldRead;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const tab = useStore.getState().tabs[0]!;
  expect(tab.vaultId).toBe("b");
  expect(tab.serverContent).toBe("B content");
  expect(tab.buffer).toBe("B unsaved text");
});

const VAULT_FOR_TABS: Vault = {
  id: "v1",
  name: "Studio",
  path: "v1",
  sourceKind: "manual",
  createdAt: "2026-10-18T12:00:00Z",
  lastOpenedAt: "2026-10-18T12:00:00Z",
};

it("refuses to open a file for a vault that is no longer current", () => {
  useStore.setState({
    ...INITIAL,
    currentVault: VAULT_FOR_TABS,
    tabs: [],
    activeTabPath: null,
  });

  useStore.getState().openFile("another-vault", "index.md");

  expect(useStore.getState().tabs).toEqual([]);
  expect(useStore.getState().activeTabPath).toBeNull();
});

function conflictedState() {
  useStore.setState({
    ...INITIAL,
    currentVault: VAULT_FOR_TABS,
    tabs: [
      {
        path: "a.md",
        vaultId: VAULT_FOR_TABS.id,
        baseHash: "old-hash",
        serverContent: "old",
        buffer: "new",
        loading: false,
        error: null,
        saving: false,
      },
    ],
    activeTabPath: "a.md",
    conflict: {
      vaultId: VAULT_FOR_TABS.id,
      path: "a.md",
      currentContent: "disk",
      currentHash: "disk-hash",
    },
    saveError: { vaultId: VAULT_FOR_TABS.id, path: "a.md", message: "save failed" },
  });
}

it("clears the save-failure banner when reload from disk lands", () => {
  conflictedState();
  useStore.getState().reloadFromDisk();
  expect(useStore.getState().conflict).toBeNull();
  expect(useStore.getState().saveError).toBeNull();
});

it("clears the save-failure banner when keep mine lands", async () => {
  conflictedState();
  globalThis.fetch = vi.fn(async () =>
    json({ path: "a.md", baseHash: "new-hash" }),
  ) as unknown as typeof fetch;

  await useStore.getState().keepMine();

  expect(useStore.getState().conflict).toBeNull();
  expect(useStore.getState().saveError).toBeNull();
});

it("ignores a conflict that belongs to a vault no longer open", () => {
  const vaultB: Vault = { ...VAULT_FOR_TABS, id: "v2", name: "Other", path: "v2" };
  useStore.setState({
    ...INITIAL,
    currentVault: vaultB,
    tabs: [
      {
        path: "a.md",
        vaultId: vaultB.id,
        baseHash: "b-old",
        serverContent: "b old",
        buffer: "b unsaved",
        loading: false,
        error: null,
        saving: false,
      },
    ],
    activeTabPath: "a.md",
    conflict: {
      vaultId: VAULT_FOR_TABS.id,
      path: "a.md",
      currentContent: "A disk",
      currentHash: "a-hash",
    },
    saveError: null,
  });

  useStore.getState().reloadFromDisk();

  const tab = useStore.getState().tabs[0]!;
  // B's unsaved text and its base hash are untouched: A's bytes never land.
  expect(tab.buffer).toBe("b unsaved");
  expect(tab.baseHash).toBe("b-old");
});

it("drops a save failure that lands after a vault switch", async () => {
  const vaultB: Vault = { ...VAULT_FOR_TABS, id: "v2", name: "Other", path: "v2" };
  useStore.setState({
    ...INITIAL,
    currentVault: VAULT_FOR_TABS,
    tabs: [
      {
        path: "a.md",
        vaultId: VAULT_FOR_TABS.id,
        baseHash: "a-old",
        serverContent: "a old",
        buffer: "a unsaved",
        loading: false,
        error: null,
        saving: false,
      },
    ],
    activeTabPath: "a.md",
    conflict: null,
    saveError: null,
  });

  let release = () => {};
  const heldWrite = new Promise<Response>((_, reject) => {
    release = () => reject(new Error("network down"));
  });
  globalThis.fetch = vi.fn(() => heldWrite) as unknown as typeof fetch;

  const saving = useStore.getState().saveActive();
  // The vault switch clears the tab set; open the same path in B with unsaved
  // text while A's write is still in flight.
  useStore.getState().openVault(vaultB);
  useStore.setState({
    tabs: [
      {
        path: "a.md",
        vaultId: vaultB.id,
        baseHash: "b-old",
        serverContent: "b old",
        buffer: "b unsaved",
        loading: false,
        error: null,
        saving: false,
      },
    ],
    activeTabPath: "a.md",
  });

  release();
  await saving;

  expect(useStore.getState().conflict).toBeNull();
  expect(useStore.getState().saveError).toBeNull();
  expect(useStore.getState().tabs[0]!.buffer).toBe("b unsaved");
});

it("retries the selected job, refreshes the list and reselects the reset record", async () => {
  const terminal = makeJob({
    status: "completed",
    stage: "done",
    skipped: [{ slug: "video-a", stage: "S1", reason: "timeout" }],
  });
  useStore.setState({
    selectedJobId: "j1",
    selectedJob: terminal,
    jobs: [terminal],
    unitFeed: [{ seq: 1, slug: "video-a", stage: "S1", status: "skipped", reason: "timeout" }],
    lastSeq: 1,
  });
  const queued = makeJob({ status: "queued", stage: "S0", skipped: [] });
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/jobs/j1/retry") return json({ id: "j1", status: "queued" }, 202);
    if (url === "/api/jobs") return json({ jobs: [queued] });
    if (url === "/api/jobs/j1") return json(queued);
    return json({});
  }) as unknown as typeof fetch;

  await useStore.getState().retrySelectedJob();

  // One mutation, then the list and the detail; no third write is invented.
  expect(calls).toEqual(["POST /api/jobs/j1/retry", "GET /api/jobs", "GET /api/jobs/j1"]);
  expect(useStore.getState().selectedJob?.status).toBe("queued");
  // The feed and the cursor belong to the old run, so the reset record clears them.
  expect(useStore.getState().unitFeed).toEqual([]);
  expect(useStore.getState().lastSeq).toBe(0);
  expect(getToasts()).toEqual([]);
});

it("toasts the approved retry failure copy and leaves the record untouched", async () => {
  const refused = makeJob({
    status: "failed",
    stage: "done",
    skipped: [{ slug: "video-a", stage: "S2", reason: "validator" }],
  });
  useStore.setState({ selectedJobId: "j1", selectedJob: refused, jobs: [refused] });
  globalThis.fetch = vi.fn(async () =>
    json({ error: "retry_running", message: "Retry after the job finishes." }, 409),
  ) as unknown as typeof fetch;

  await expect(useStore.getState().retrySelectedJob()).resolves.toBeUndefined();

  const toasts = getToasts();
  expect(toasts.map((t) => t.text)).toEqual([
    "Couldn't retry the failed units. Try again in a moment.",
  ]);
  expect(toasts[0]?.tone).toBe("error");
  // No status, stage or skipped row was invented from a request that failed.
  expect(useStore.getState().selectedJob).toBe(refused);
  expect(useStore.getState().jobs).toEqual([refused]);
});

it("does nothing when no job is selected", async () => {
  const fetchSpy = vi.fn(async () => json({}));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  await useStore.getState().retrySelectedJob();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getToasts()).toEqual([]);
});

it("keeps the last list on a failed load and records the error", async () => {
  const job = makeJob();
  useStore.setState({ jobs: [job] });
  globalThis.fetch = vi.fn(async () =>
    json({ message: "down" }, 500),
  ) as unknown as typeof fetch;

  await useStore.getState().loadJobs();

  expect(useStore.getState().jobs).toEqual([job]);
  expect(useStore.getState().jobsError).toBe("down");
  expect(useStore.getState().jobsLoading).toBe(false);
});
