import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Jobs } from "./Jobs.js";
import { useStore, type AppState } from "../store.js";
import type { JobSummary } from "../lib/api.js";
import { clearToasts, getToasts } from "../lib/toast.js";

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
let retryCalls = 0;
let retryStatus = 202;
let retryHold: { promise: Promise<void>; release: () => void } | null = null;
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

    const retryMatch = /^\/api\/jobs\/([^/?]+)\/retry$/.exec(url);
    if (retryMatch !== null) {
      retryCalls += 1;
      if (retryHold !== null) await retryHold.promise;
      if (retryStatus !== 202) {
        return json({ error: "no_failed_units", message: "No failed units to retry." }, retryStatus);
      }
      const id = decodeURIComponent(retryMatch[1] ?? "");
      serverJobs = serverJobs.map((job) =>
        job.id === id ? { ...job, status: "queued", stage: "S0", skipped: [] } : job,
      );
      return json({ id, status: "queued" }, 202);
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
  retryCalls = 0;
  retryStatus = 202;
  retryHold = null;
  failList = false;
  clearToasts();
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

function stageCell(host: HTMLElement, name: string): HTMLElement {
  const cell = [...host.querySelectorAll<HTMLElement>(".job-stage")].find(
    (el) => el.querySelector(".job-stage-name")?.textContent === name,
  );
  if (cell === undefined) throw new Error(`no stage cell ${name}`);
  return cell;
}

it("advances the stepper through S2-S5 and marks S6 unused when sweep is off", async () => {
  serverJobs = [makeJob({ settings: { sweep: { enabled: false } } })];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() => source.emit("stage", { stage: "S0", status: "completed" }, 1));
  await render(() => source.emit("stage", { stage: "S1", status: "started" }, 2));
  await render(() => source.emit("stage", { stage: "S1", status: "completed" }, 3));
  await render(() => source.emit("stage", { stage: "S2", status: "started" }, 4));

  expect(stageCell(host, "S0").dataset.state).toBe("done");
  expect(stageCell(host, "S1").dataset.state).toBe("done");
  expect(stageCell(host, "S1w").textContent).toContain("Not used for this source");
  expect(stageCell(host, "S2").dataset.state).toBe("active");
  expect(stageCell(host, "S3").dataset.state).toBe("pending");
  expect(stageCell(host, "S4").dataset.state).toBe("pending");
  expect(stageCell(host, "S5").dataset.state).toBe("pending");
  // S6 is not pending: when the sweep is off, that stage will not run.
  expect(stageCell(host, "S6").dataset.state).toBe("unused");
  expect(stageCell(host, "S6").textContent).toContain("Deep quality sweep is off.");
  expect(host.textContent).not.toContain("Pending Phase");

  // A stray S6 frame must not advance a stage this job will never run.
  await render(() => source.emit("stage", { stage: "S6", status: "started" }, 5));
  expect(stageCell(host, "S6").dataset.state).toBe("unused");
  expect(stageCell(host, "S2").dataset.state).toBe("active");
});

it("shows S6 as a live stage when the job was created with sweep on", async () => {
  serverJobs = [makeJob({ settings: { sweep: { enabled: true } } })];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() => source.emit("stage", { stage: "S6", status: "started" }, 1));

  expect(stageCell(host, "S6").dataset.state).toBe("active");
  // The progress denominator is the job's live list, S6 included.
  expect(host.querySelector(".job-progress")?.getAttribute("aria-valuemax")).toBe("7");
});

it("keeps the last known stage and the keepalive indicator while a poll is in flight", async () => {
  serverJobs = [makeJob({ stage: "S2" })];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  // The record's own pointer seeds the stepper before any frame arrives.
  expect(stageCell(host, "S2").dataset.state).toBe("active");
  expect(host.querySelector(".job-live")).toBeTruthy();

  await act(async () => {
    useStore.setState({ jobsLoading: true });
  });
  // A poll in flight is a list hint; it never blanks the stage on screen.
  expect(host.textContent).toContain("Checking…");
  expect(stageCell(host, "S2").dataset.state).toBe("active");
  expect(host.querySelector(".job-live")).toBeTruthy();
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

/* ---- Task 2: the feed, the failed table and honest disabled actions ---- */

it("renders a skipped unit's detail as the feed line 'Skipped: capture present'", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() =>
    source.emit(
      "unit",
      { slug: "video-a", stage: "S1", status: "skipped", detail: "capture present" },
      1,
    ),
  );

  const row = host.querySelector(".job-feed-row");
  expect(row?.textContent).toContain("video-a");
  expect(row?.textContent).toContain("Skipped: capture present");
});

it("shows the failed units as slug, stage and reason, and the empty copy when none", async () => {
  serverJobs = [
    makeJob({
      skipped: [
        { slug: "video-a", stage: "S3", reason: "timeout" },
        { slug: "video-b", stage: "S4", reason: "blocked" },
      ],
    }),
  ];
  const first = await mountJobs();
  await selectRow(first.host, 0, first.render);
  const rows = first.host.querySelectorAll(".job-failed-table tbody tr");
  expect(rows.length).toBe(2);
  expect(rows[0]?.textContent).toContain("video-a");
  expect(rows[0]?.textContent).toContain("S3");
  expect(rows[0]?.textContent).toContain("timeout");
  await first.unmount();

  serverJobs = [makeJob({ id: "j2" })];
  const second = await mountJobs();
  await selectRow(second.host, 0, second.render);
  expect(second.host.textContent).toContain("No failed units");
  expect(second.host.textContent).toContain("Every selected unit completed.");
});

it("keeps non-retryable and informational skips out of the failed table", async () => {
  serverJobs = [
    makeJob({
      skipped: [{ slug: "video-a", stage: "S1", reason: "no_captions" }],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  // A resumed unit reports a skip with no reason: it is not a failure.
  await render(() =>
    source.emit(
      "unit",
      { slug: "video-b", stage: "S1", status: "skipped", detail: "capture present" },
      1,
    ),
  );

  expect(host.querySelectorAll(".job-failed-table tbody tr").length).toBe(0);
  expect(actionButton(host, "Retry failed").disabled).toBe(true);
});

it("renders the empty jobs list copy while never showing a blank list", async () => {
  serverJobs = [];
  const { host } = await mountJobs();
  expect(host.textContent).toContain("No jobs yet");
  expect(host.textContent).toContain("Start an ingest from Settings to see progress here.");
});

function actionButton(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".job-actions button")].find(
    (el) => el.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no action button ${label}`);
  return found;
}

it("shows Retry disabled while the job runs, with the server's own reason", async () => {
  serverJobs = [makeJob({ status: "running" })];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  expect(actionButton(host, "Retry failed").disabled).toBe(true);
  expect(host.textContent).toContain("Retry after the job finishes.");

  // Lint is a later phase and keeps its own honest note.
  expect(actionButton(host, "Lint bundle").disabled).toBe(true);
  expect(host.textContent).toContain("Lint is available in Phase 5.");
  expect(host.textContent).not.toContain("Retry is available in Phase 4.");
});

it("disables Retry with the empty reason when a finished job has no failed units", async () => {
  serverJobs = [makeJob({ status: "completed", stage: "done" })];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  expect(actionButton(host, "Retry failed").disabled).toBe(true);
  expect(host.textContent).toContain("No failed units to retry.");
});

function holdRetry(): void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  retryHold = { promise, release };
}

it("retries once, swaps the label to Retrying…, then refreshes the record", async () => {
  vi.useFakeTimers();
  serverJobs = [
    makeJob({
      status: "completed",
      stage: "done",
      skipped: [{ slug: "video-a", stage: "S2", reason: "timeout" }],
    }),
  ];
  holdRetry();
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const retry = actionButton(host, "Retry failed");
  expect(retry.disabled).toBe(false);
  await render(() => {
    retry.click();
    // The second press is in the same tick: `pending` must already bite.
    retry.click();
  });

  expect(retryCalls).toBe(1);
  expect(retry.disabled).toBe(true);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(140);
  });
  expect(host.textContent).toContain("Retrying…");

  await act(async () => {
    retryHold?.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(retryCalls).toBe(1);
  expect(host.textContent).not.toContain("Retrying…");
  // The list and the detail were re-read; the reset record is the server's.
  expect(serverJobs[0]?.status).toBe("queued");
  expect(actionButton(host, "Retry failed").disabled).toBe(true);
  expect(host.textContent).toContain("Retry after the job finishes.");
});

/* ---- Task 2: the per-row Retry column ---- */

it("gives every failed row its own secondary Retry button in a Retry column", async () => {
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      skipped: [
        { slug: "video-a", stage: "S4", reason: "timeout" },
        { slug: "video-b", stage: "S2", reason: "validator" },
      ],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const headers = [...host.querySelectorAll(".job-failed-table th")].map((th) => th.textContent);
  expect(headers).toEqual(["Unit", "Stage", "Reason", "Retry"]);

  const rowButtons = [
    ...host.querySelectorAll<HTMLButtonElement>(".job-failed-table tbody button"),
  ];
  expect(rowButtons.length).toBe(2);
  expect(rowButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Retry video-a",
    "Retry video-b",
  ]);
  // Secondary by definition: the default surface, never accent and never danger.
  for (const button of rowButtons) {
    expect(button.className).toContain("ghost-pill");
    expect(button.className).not.toContain("primary");
    expect(button.className).not.toContain("danger");
    expect(button.disabled).toBe(false);
  }
});

it("disables every row Retry under the same condition as the primary action", async () => {
  serverJobs = [
    makeJob({
      status: "running",
      skipped: [{ slug: "video-a", stage: "S2", reason: "timeout" }],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const rowButton = host.querySelector<HTMLButtonElement>(".job-failed-table tbody button");
  expect(rowButton?.disabled).toBe(true);
  expect(actionButton(host, "Retry failed").disabled).toBe(true);
});

it("sends the shared whole-job retry from a row button", async () => {
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      skipped: [{ slug: "video-a", stage: "S2", reason: "timeout" }],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  await render(() =>
    host.querySelector<HTMLButtonElement>(".job-failed-table tbody button")?.click(),
  );

  expect(retryCalls).toBe(1);
});

it("shows the exact S2 copy and keeps the server detail as the title", async () => {
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      skipped: [
        {
          slug: "video-a",
          stage: "S2",
          reason: "malformed_json",
          detail: "Missing summary field.",
        },
      ],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const row = host.querySelector(".job-failed-table tbody tr");
  expect(row?.textContent).toContain("Extraction failed. Source page saved as partial.");
  // The validator's own words stay reachable without replacing the approved copy.
  expect(row?.querySelector('[title="Missing summary field."]')).toBeTruthy();
});

it("shows the plain reason for an S2 capture that wrote no partial page", async () => {
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      skipped: [{ slug: "video-a", stage: "S2", reason: "capture_invalid" }],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const row = host.querySelector(".job-failed-table tbody tr");
  expect(row?.textContent).toContain("capture_invalid");
  expect(row?.textContent).not.toContain("saved as partial");
});

it("shows the approved toast and re-enables Retry when the request is refused", async () => {
  retryStatus = 409;
  serverJobs = [
    makeJob({
      status: "failed",
      stage: "done",
      skipped: [{ slug: "video-a", stage: "S2", reason: "timeout" }],
    }),
  ];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  await render(() => actionButton(host, "Retry failed").click());

  expect(retryCalls).toBe(1);
  const toasts = getToasts();
  expect(toasts.map((t) => t.text)).toEqual([
    "Couldn't retry the failed units. Try again in a moment.",
  ]);
  expect(toasts[0]?.tone).toBe("error");
  // The control is usable again: a refusal is not a dead end.
  expect(actionButton(host, "Retry failed").disabled).toBe(false);
});

it("cancels once after the exact confirmation, and not at all when dismissed", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);

  const cancelButton = (): HTMLButtonElement => {
    const found = [...host.querySelectorAll<HTMLButtonElement>(".job-live-slot button")].find(
      (el) => el.textContent === "Cancel job",
    );
    if (found === undefined) throw new Error("no Cancel job button");
    return found;
  };

  // Dismissal path.
  await render(() => cancelButton().click());
  expect(document.body.textContent).toContain(
    "Cancel job: stop the running job. Completed units stay on disk.",
  );
  const keep = document.querySelector<HTMLButtonElement>(".confirm-dialog .ghost-pill");
  expect(keep?.textContent).toBe("Keep running");
  await render(() => keep!.click());
  expect(document.querySelector(".confirm-dialog")).toBeNull();
  expect(cancelCalls).toBe(0);

  // Confirmation path.
  await render(() => cancelButton().click());
  const confirm = document.querySelector<HTMLButtonElement>(
    ".confirm-dialog .confirm-actions button.primary",
  );
  expect(confirm?.textContent).toContain("Cancel job");
  await act(async () => {
    confirm!.click();
    // Let cancelJob and the follow-up loadJobs settle.
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(cancelCalls).toBe(1);
  expect(document.querySelector(".confirm-dialog")).toBeNull();
  expect(serverJobs[0]?.status).toBe("cancelled");
  // The completed units stay on screen: cancel is not a clear of the feed.
  expect(host.querySelector(".job-feed-scroll")).toBeTruthy();
});

/* ---- Task 3: reconnect, replay, poll resilience and inert text ---- */

it("replays without duplicating a row and keeps the same source URL", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await act(async () => {
    for (let seq = 1; seq <= 30; seq += 1) {
      source.emit("unit", { slug: `u${seq}`, stage: "S1", status: "written" }, seq);
    }
  });
  expect(useStore.getState().unitFeed.length).toBe(30);

  // A reconnect delivers the tail again from the server's replay buffer.
  await render(() => source.fail());
  expect(lastSource().url).toBe("/api/jobs/j1/events");
  await render(() => source.open());

  await act(async () => {
    for (let seq = 31; seq <= 50; seq += 1) {
      source.emit("unit", { slug: `u${seq}`, stage: "S1", status: "written" }, seq);
    }
    for (let seq = 31; seq <= 50; seq += 1) {
      source.emit("unit", { slug: `u${seq}`, stage: "S1", status: "written" }, seq);
    }
  });

  const feed = useStore.getState().unitFeed;
  expect(feed.length).toBe(50);
  expect(new Set(feed.map((row) => row.seq)).size).toBe(50);
  expect(feed.at(-1)?.slug).toBe("u50");
  expect(host.querySelectorAll(".job-feed-row").length).toBe(50);
  expect(FakeEventSource.instances.length).toBe(1);
});

it("shows the pause copy, then the resumed copy for 3 s after reopening", async () => {
  vi.useFakeTimers();
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await render(() => source.fail());
  expect(host.textContent).toContain("Live updates paused. Reconnecting…");
  expect(host.textContent).not.toContain("Live updates resumed.");

  await render(() => source.open());
  expect(useStore.getState().sseState).toBe("open");
  expect(host.textContent).toContain("Live updates resumed.");
  expect(host.textContent).not.toContain("Live updates paused. Reconnecting…");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(host.textContent).not.toContain("Live updates resumed.");
  expect(host.querySelector(".job-live")).toBeTruthy();
});

it("keeps the last list visible through a failed poll and says Checking while it runs", async () => {
  vi.useFakeTimers();
  serverJobs = [makeJob()];
  const { host } = await mountJobs();
  expect(host.querySelectorAll(".job-row").length).toBe(1);

  failList = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(host.textContent).toContain("Couldn't load jobs. Try again in a moment.");
  expect(host.querySelectorAll(".job-row").length).toBe(1);
  expect(host.textContent).toContain("https://www.youtube.com/@studio");

  await act(async () => {
    useStore.setState({ jobsLoading: true });
  });
  expect(host.textContent).toContain("Checking…");
  expect(host.querySelectorAll(".job-row").length).toBe(1);
});

it("renders markup in event text as literal text and creates no element", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  const markup = '<img src=x onerror=alert(1)>';
  await render(() =>
    source.emit("unit", { slug: markup, stage: "S1", status: "skipped", detail: markup }, 1),
  );

  const slug = host.querySelector(".job-feed-slug");
  expect(slug?.textContent).toBe(markup);
  expect(host.querySelector(".job-feed-row img")).toBeNull();
  expect(host.querySelector("[onerror]")).toBeNull();
  expect(host.querySelector(".job-feed-detail")?.textContent).toBe(`Skipped: ${markup}`);
});

it("caps the feed at the last 500 units and shows the cap line", async () => {
  serverJobs = [makeJob()];
  const { host, render } = await mountJobs();
  await selectRow(host, 0, render);
  const source = lastSource();
  await render(() => source.open());

  await act(async () => {
    for (let seq = 1; seq <= 501; seq += 1) {
      source.emit("unit", { slug: `u${seq}`, stage: "S1", status: "written" }, seq);
    }
  });

  const feed = useStore.getState().unitFeed;
  expect(feed.length).toBe(500);
  expect(feed[0]?.seq).toBe(2);
  expect(feed.at(-1)?.seq).toBe(501);
  expect(useStore.getState().feedCapped).toBe(true);
  expect(host.querySelectorAll(".job-feed-row").length).toBe(500);
  expect(host.textContent).toContain("Showing the last 500 units.");
});
