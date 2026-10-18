import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedStages, useStore, type AppState } from "./store.js";
import type { JobSummary } from "./lib/api.js";

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
    stagesDone: ["S0", "S1"],
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
