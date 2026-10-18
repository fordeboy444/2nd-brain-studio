import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Jobs } from "./Jobs.js";
import { useStore, type AppState } from "../store.js";
import type { JobSummary } from "../lib/api.js";

/**
 * The Jobs screen's contract, driven through a fake `EventSource` and a stub of
 * the server's routes.
 *
 * jsdom has no EventSource, which is exactly what lets these tests own it: the
 * fake records every construction, every close and every frame, so "one source
 * per selection", "closed on done" and "a replayed seq changes nothing" are
 * assertions about the app, not about a browser we cannot run here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOBS_INITIAL: Partial<AppState> = {
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
};

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

type FrameListener = (event: Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<FrameListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    const fn: FrameListener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
    const set = this.listeners.get(type) ?? new Set<FrameListener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    const fn: FrameListener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
  }

  /** A named frame: `id:`, `event:` and `data:` as the server writes them. */
  emit(type: string, data: unknown, seq: number): void {
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
      lastEventId: String(seq),
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /**
   * A keepalive comment. The server writes `:keepalive` every 15 s; a comment
   * frame has no event and no data, so it dispatches nothing to any listener.
   */
  keepalive(): void {
    // Deliberately empty: that is the whole contract of an SSE comment.
  }
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error("no EventSource was opened");
  return source;
}

let serverJobs: JobSummary[] = [];
let listCalls = 0;
let cancelCalls = 0;
let failList = false;

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

function stubServer(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/jobs" || url.startsWith("/api/jobs?")) {
      listCalls += 1;
      if (failList) return json({ message: "server is down" }, 500);
      return json({ jobs: serverJobs });
    }

    const match = /^\/api\/jobs\/([^/?]+)$/.exec(url);
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? "");
      if (method === "DELETE") {
        cancelCalls += 1;
        serverJobs = serverJobs.map((job) =>
          job.id === id ? { ...job, status: "cancelled" } : job,
        );
        return json({ id, status: "cancelled" });
      }
      const job = serverJobs.find((row) => row.id === id);
      return job === undefined ? json({ message: "not found" }, 404) : json(job);
    }

    return json({});
  }) as unknown as typeof fetch;
}

interface Mounted {
  host: HTMLElement;
  render: (fn: () => void) => Promise<void>;
  unmount: () => Promise<void>;
}

const mounted: Array<{ root: Root; host: HTMLElement; done: boolean }> = [];

async function mountJobs(): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entry = { root, host, done: false };
  mounted.push(entry);

  const render = async (fn: () => void) => {
    await act(async () => {
      fn();
    });
  };
  const unmount = async () => {
    if (entry.done) return;
    entry.done = true;
    await render(() => root.unmount());
    host.remove();
  };

  await render(() => root.render(<Jobs />));
  return { host, render, unmount };
}

/** Click a row and let the detail fetch settle. */
async function selectRow(host: HTMLElement, index: number, render: Mounted["render"]) {
  const rows = host.querySelectorAll<HTMLButtonElement>(".job-row");
  const row = rows[index];
  if (row === undefined) throw new Error(`no job row at ${index}`);
  await render(() => row.click());
}

beforeEach(() => {
  useStore.setState(JOBS_INITIAL);
  serverJobs = [];
  listCalls = 0;
  cancelCalls = 0;
  failList = false;
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  stubServer();
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    if (entry.done) {
      entry.host.remove();
      continue;
    }
    entry.done = true;
    await act(async () => entry.root.unmount());
    entry.host.remove();
  }
  globalThis.fetch = originalFetch;
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("polls the list every 2 s, keeps it rendered, and stops on unmount", async () => {
  vi.useFakeTimers();
  serverJobs = [makeJob()];
  const { host, unmount } = await mountJobs();

  expect(listCalls).toBe(1);
  expect(host.querySelectorAll(".job-row").length).toBe(1);
  expect(host.textContent).toContain("https://www.youtube.com/@studio");

  serverJobs = [makeJob(), makeJob({ id: "j2", input: { url: "https://example.com/page" } })];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(listCalls).toBe(2);
  expect(host.querySelectorAll(".job-row").length).toBe(2);

  await unmount();
  const callsAtUnmount = listCalls;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(listCalls).toBe(callsAtUnmount);
});

it("opens exactly one EventSource per selection and closes the previous one", async () => {
  serverJobs = [makeJob({ id: "j1" }), makeJob({ id: "j2" })];
  const { host, render, unmount } = await mountJobs();

  await selectRow(host, 0, render);
  expect(FakeEventSource.instances.length).toBe(1);
  expect(lastSource().url).toBe("/api/jobs/j1/events");
  expect(lastSource().closed).toBe(false);

  await selectRow(host, 1, render);
  expect(FakeEventSource.instances.length).toBe(2);
  expect(FakeEventSource.instances[0]?.closed).toBe(true);
  expect(lastSource().url).toBe("/api/jobs/j2/events");

  await unmount();
  expect(lastSource().closed).toBe(true);
});

it("advances the stepper from stage events and keeps S2-S6 visibly pending", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() => source.emit("stage", { stage: "S0", status: "completed" }, 1));
  await render(() => source.emit("stage", { stage: "S1", status: "started" }, 2));

  const at = (name: string): HTMLElement => {
    const cell = [...host.querySelectorAll<HTMLElement>(".job-stage")].find(
      (el) => el.querySelector(".job-stage-name")?.textContent === name,
    );
    if (cell === undefined) throw new Error(`no stage cell ${name}`);
    return cell;
  };

  expect(at("S0").dataset.state).toBe("done");
  expect(at("S1").dataset.state).toBe("active");
  expect(at("S1w").textContent).toContain("Not used for this source");
  expect(at("S2").dataset.state).toBe("pending");
  expect(at("S2").textContent).toContain("Pending Phase 4");
  expect(at("S5").dataset.state).toBe("pending");
  expect(at("S5").textContent).toContain("Pending Phase 5");
});

it("closes the source once on done and leaves no replacement stream", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() => source.emit("done", { status: "completed" }, 3));

  expect(source.closed).toBe(true);
  expect(useStore.getState().sseState).toBe("idle");
  expect(FakeEventSource.instances.length).toBe(1);
  expect(host.querySelector(".job-live")).toBeNull();
});

it("renders the preflight copy with zero unit rows for a failed check", async () => {
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      error: "preflight_failed",
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  expect(host.textContent).toContain(
    "Transcript check failed. Retry with a fresh YouTube cookie.",
  );
  expect(host.querySelectorAll(".job-feed-row").length).toBe(0);
  // A terminal job has nothing to stream, so no source is opened.
  expect(FakeEventSource.instances.length).toBe(0);
});

it("ignores a keepalive comment and shows Live only while the source is open", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();

  await render(() => source.open());
  expect(host.querySelector(".job-live")).toBeTruthy();
  expect(useStore.getState().sseState).toBe("open");

  await render(() => source.keepalive());
  expect(useStore.getState().unitFeed.length).toBe(0);
  expect(useStore.getState().sseState).toBe("open");
  expect(host.querySelectorAll(".job-feed-row").length).toBe(0);

  await render(() => source.emit("unit", { slug: "u1", stage: "S1", status: "written" }, 1));
  expect(useStore.getState().unitFeed.length).toBe(1);
  expect(host.querySelectorAll(".job-feed-row").length).toBe(1);

  await render(() => source.fail());
  expect(host.querySelector(".job-live")).toBeNull();
  expect(host.textContent).toContain("Live updates paused. Reconnecting…");
  expect(useStore.getState().sseState).toBe("reconnecting");
});

it("puts the strongest emphasis on exactly one element: the progress fill", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const strong = host.querySelectorAll('.job-detail [data-emphasis="strongest"]');
  expect(strong.length).toBe(1);
  expect(strong[0]?.classList.contains("job-progress-fill")).toBe(true);
});
