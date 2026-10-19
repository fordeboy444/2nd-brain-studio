import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "../components/Banner.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Spinner } from "../components/Spinner.js";
import { jobEventsUrl, type JobStage, type JobSummary } from "../lib/api.js";
import { useAsyncAction } from "../lib/useAsyncAction.js";
import { liveStagesFor, useStore, type UnitFeedRow } from "../store.js";

/**
 * Jobs: a polling list beside one live detail stream.
 *
 * Two facts drive every choice here. The job outlives the tab, so the screen
 * never invents progress: the list polls the server's record and the detail
 * replays `events.ndjson` from `Last-Event-ID`. And a reconnect is normal
 * traffic, so the feed is deduped by `seq` in the store before it reaches the
 * DOM — the browser's own retry is not allowed to duplicate a row.
 *
 * There is exactly one `EventSource`, owned by the effect keyed on the selected
 * job. The source is opened only once the record has loaded and the job is not
 * terminal: a finished job's stream would never emit another frame, and the
 * browser would retry it forever.
 */

/** Declared pipeline. S2-S6 are named so the gaps are visible, not implied. */
const STAGES = ["S0", "S1", "S1w", "S2", "S3", "S4", "S5", "S6"] as const;
type StepperStage = (typeof STAGES)[number];

type StageVisual = "done" | "active" | "pending" | "unused";

interface StageCell {
  stage: StepperStage;
  visual: StageVisual;
  reason: string | null;
}

const TERMINAL: ReadonlySet<JobSummary["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The stages a retry can re-run. S0, S1 and S1w entries are display-only, so
 * they never make a row in the failed-unit table (CR-03).
 */
const RETRYABLE: ReadonlySet<string> = new Set(["S2", "S3", "S4", "S6"]);

function isTerminal(status: JobSummary["status"]): boolean {
  return TERMINAL.has(status);
}

/**
 * The stepper is the job's own live stage table, not a projection of the
 * events that happened to arrive: every stage the job will run is visible from
 * the first frame. A stage that does not apply to this source (S1w for a
 * channel, S1 for a page) says so, and S6 says it is switched off rather than
 * looking like work to come.
 */
function stageCells(
  kind: JobSummary["kind"],
  stagesDone: JobStage[],
  activeStage: JobStage | null,
  sweepEnabled: boolean,
): StageCell[] {
  const live = new Set<JobStage>(liveStagesFor(kind, sweepEnabled));
  const unused: StepperStage = kind === "youtube" ? "S1w" : "S1";
  return STAGES.map((stage) => {
    if (!live.has(stage as JobStage)) {
      if (stage === unused) {
        return { stage, visual: "unused", reason: "Not used for this source" };
      }
      // The only other stage a job can skip is S6, and its switch is the reason.
      return { stage, visual: "unused", reason: "Deep quality sweep is off." };
    }
    if (stagesDone.includes(stage as JobStage)) {
      return { stage, visual: "done", reason: null };
    }
    if (activeStage === stage) {
      return { stage, visual: "active", reason: null };
    }
    return { stage, visual: "pending", reason: null };
  });
}

const STATUS_LABEL: Record<JobSummary["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A timestamp that cannot shift with the machine's locale or clock. */
function formatCreated(iso: string): string {
  const at = iso.indexOf("T");
  return at > 0 ? `${iso.slice(0, at)} ${iso.slice(at + 1, at + 6)}` : iso;
}

/** One SSE frame, or null when the payload is not the JSON object we expect. */
function parseFrame(event: Event): { seq: number; data: Record<string, unknown> } | null {
  const message = event as MessageEvent<string>;
  if (typeof message.data !== "string" || message.data === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const seq = Number(message.lastEventId);
  return { seq: Number.isFinite(seq) ? seq : Number.NaN, data: parsed as Record<string, unknown> };
}

export function Jobs() {
  const closeOverlay = useStore((s) => s.closeOverlay);

  const jobs = useStore((s) => s.jobs);
  const jobsLoading = useStore((s) => s.jobsLoading);
  const jobsError = useStore((s) => s.jobsError);
  const loadJobs = useStore((s) => s.loadJobs);
  const selectedJobId = useStore((s) => s.selectedJobId);
  const selectedJob = useStore((s) => s.selectedJob);
  const selectJob = useStore((s) => s.selectJob);
  const stagesDone = useStore((s) => s.stagesDone);
  const activeStage = useStore((s) => s.activeStage);
  const unitFeed = useStore((s) => s.unitFeed);
  const feedCapped = useStore((s) => s.feedCapped);
  const sseState = useStore((s) => s.sseState);
  const applyJobEvent = useStore((s) => s.applyJobEvent);
  const cancelSelectedJob = useStore((s) => s.cancelSelectedJob);
  const retrySelectedJob = useStore((s) => s.retrySelectedJob);

  // `pending` guards the very first press; `showPending` waits 140 ms before
  // the label changes, so a fast retry does not flash a spinner.
  const retry = useAsyncAction(retrySelectedJob);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [resumed, setResumed] = useState(false);
  const resumeTimer = useRef<number | null>(null);

  // The list is the fallback truth: if the stream is blocked by a proxy, this
  // still advances. The interval is owned by this screen, so closing it stops
  // the polling.
  useEffect(() => {
    void loadJobs();
    const timer = setInterval(() => {
      void loadJobs();
    }, 2000);
    return () => clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOverlay]);

  // Two derived booleans, not the record object: `applyJobEvent` replaces the
  // record on every frame, and an object dependency would close and reopen the
  // stream once per event. `hasSelection` and `terminal` change only when the
  // connection should change.
  const hasSelection = selectedJob !== null && selectedJob.id === selectedJobId;
  const terminal = selectedJob !== null && isTerminal(selectedJob.status);

  useEffect(() => {
    if (selectedJobId === null || !hasSelection) return;
    // A finished job's stream is a dead end: the record already holds the last
    // stage and every skip. Opening a source here would only make the browser
    // retry it.
    if (terminal) {
      useStore.setState({ sseState: "idle" });
      return;
    }

    const source = new EventSource(jobEventsUrl(selectedJobId));
    const frames: Array<[string, (event: Event) => void]> = [];

    for (const type of ["job", "stage", "unit", "error"] as const) {
      const handler = (event: Event) => {
        const frame = parseFrame(event);
        if (frame !== null) applyJobEvent(frame.seq, type, frame.data);
      };
      source.addEventListener(type, handler);
      frames.push([type, handler]);
    }

    // `done` is terminal for the connection as well as the job. Closing here is
    // what stops `EventSource` from reconnecting to a stream with no more
    // frames; the store's own state is set by `applyJobEvent`.
    const onDone = (event: Event) => {
      const frame = parseFrame(event);
      if (frame !== null) applyJobEvent(frame.seq, "done", frame.data);
      source.close();
      useStore.setState({ sseState: "idle" });
    };
    source.addEventListener("done", onDone);

    source.onopen = () => {
      const wasReconnecting = useStore.getState().sseState === "reconnecting";
      useStore.setState({ sseState: "open" });
      if (wasReconnecting) {
        setResumed(true);
        if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => {
          setResumed(false);
          resumeTimer.current = null;
        }, 3000);
      }
    };
    // A transport failure is not a job failure: the record's stage stays on
    // screen and the pause copy says the stream, not the job, is interrupted.
    source.onerror = () => {
      useStore.setState({ sseState: "reconnecting" });
    };

    return () => {
      for (const [type, handler] of frames) source.removeEventListener(type, handler);
      source.removeEventListener("done", onDone);
      source.close();
      if (resumeTimer.current !== null) {
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = null;
      }
      setResumed(false);
    };
  }, [selectedJobId, hasSelection, terminal, applyJobEvent]);

  // The sweep flag is the job's own: it was fixed when the job was created, so
  // the stepper shows S6 only for a job that will run it.
  const sweepEnabled = selectedJob?.settings?.sweep?.enabled === true;
  const cells =
    selectedJob !== null
      ? stageCells(selectedJob.kind, stagesDone, activeStage, sweepEnabled)
      : [];
  const liveStages =
    selectedJob !== null ? liveStagesFor(selectedJob.kind, sweepEnabled) : [];
  const doneCount = liveStages.filter((stage) => stagesDone.includes(stage)).length;

  const failedRows = useMemo(() => {
    const rows = new Map<
      string,
      { slug: string; stage: string; reason: string; detail?: string }
    >();
    if (selectedJob !== null) {
      for (const skip of selectedJob.skipped) {
        if (!RETRYABLE.has(skip.stage)) continue;
        rows.set(`${skip.slug}\u0000${skip.reason}`, {
          slug: skip.slug,
          stage: skip.stage,
          reason: skip.reason,
          ...(skip.detail === undefined ? {} : { detail: skip.detail }),
        });
      }
    }
    for (const row of unitFeed) {
      if (row.status !== "skipped") continue;
      // An informational skip ("capture present") carries no reason and is not
      // a failure.
      if (row.reason === undefined) continue;
      if (!RETRYABLE.has(row.stage)) continue;
      const reason = row.reason;
      rows.set(`${row.slug}\u0000${reason}`, {
        slug: row.slug,
        stage: row.stage,
        reason,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
      });
    }
    return [...rows.values()];
  }, [selectedJob, unitFeed]);

  const preflightFailed =
    selectedJob !== null &&
    selectedJob.status === "failed" &&
    selectedJob.error === "preflight_failed";

  // The server refuses a retry on a running job and on a job with no failed
  // units. The screen names both conditions before the press, in that order.
  const retryBlockedReason =
    selectedJob === null
      ? "No failed units to retry."
      : !isTerminal(selectedJob.status)
        ? "Retry after the job finishes."
        : failedRows.length === 0
          ? "No failed units to retry."
          : null;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
    >
      <div className="modal jobs-modal" role="dialog" aria-modal="true" aria-label="Jobs">
        <div className="modal-header">
          <span>Jobs</span>
          <button
            className="icon-btn"
            autoFocus
            onClick={closeOverlay}
            aria-label="Close jobs"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <Banner show={jobsError !== null} role="alert">
          Couldn't load jobs. Try again in a moment.
        </Banner>

        <div className="jobs-screen">
          <section className="job-list-pane" aria-label="Job list">
            <div className="jobs-list-heading">
              <span className="subhead">Recent jobs</span>
              {jobsLoading && <span className="muted">Checking…</span>}
            </div>

            {jobs.length === 0 && !jobsLoading ? (
              <div className="job-empty">
                <p className="job-empty-title">No jobs yet</p>
                <p className="muted">Start an ingest from Settings to see progress here.</p>
              </div>
            ) : (
              <ul className="job-list">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      className="job-row"
                      aria-current={job.id === selectedJobId ? "true" : undefined}
                      onClick={() => void selectJob(job.id)}
                    >
                      <span className="job-row-status" data-status={job.status}>
                        {STATUS_LABEL[job.status]}
                      </span>
                      <span className="job-row-kind">
                        {job.kind === "youtube" ? "YouTube" : "Web"}
                      </span>
                      <span className="job-row-url" title={job.input.url}>
                        {job.input.url}
                      </span>
                      <span className="job-row-meta">
                        {formatCreated(job.createdAt)} · {job.progress.done}/{job.progress.total}{" "}
                        units
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="job-detail" aria-label="Job detail">
            {selectedJob === null ? (
              <p className="muted">Select a job to watch it run.</p>
            ) : (
              <>
                <div className="job-detail-head">
                  <div className="job-detail-identity">
                    <span className="subhead">
                      {selectedJob.kind === "youtube" ? "YouTube channel" : "Web page"}
                    </span>
                    <p className="job-detail-status">
                      {STATUS_LABEL[selectedJob.status]}
                      {selectedJob.cancelRequested ? " · cancelling" : ""}
                    </p>
                  </div>
                  <div className="job-live-slot">
                    {sseState === "open" && (
                      <span className="job-live" data-live="true">
                        <span className="job-live-dot" aria-hidden="true" />
                        Live
                      </span>
                    )}
                    {sseState === "reconnecting" && (
                      <span className="job-live-paused" role="status">
                        Live updates paused. Reconnecting…
                      </span>
                    )}
                    {resumed && sseState === "open" && (
                      <span className="job-live-resumed" role="status">
                        Live updates resumed.
                      </span>
                    )}
                    <button
                      type="button"
                      className="ghost-pill"
                      disabled={isTerminal(selectedJob.status)}
                      onClick={() => setConfirmCancel(true)}
                    >
                      Cancel job
                    </button>
                  </div>
                </div>

                <StageStepper
                  cells={cells}
                  doneCount={doneCount}
                  total={liveStages.length}
                  kind={selectedJob.kind}
                />

                {preflightFailed ? (
                  <p className="job-preflight" role="alert">
                    Transcript check failed. Retry with a fresh YouTube cookie.
                  </p>
                ) : (
                  <>
                    <UnitFeed rows={unitFeed} feedCapped={feedCapped} sourceUrl={selectedJob.input.url} />
                    <FailedUnitTable
                      rows={failedRows}
                      retryBlockedReason={retryBlockedReason}
                      retryPending={retry.pending}
                      onRetry={() => void retry.run()}
                    />
                  </>
                )}

                <div className="job-actions">
                  <div className="job-action">
                    <button
                      type="button"
                      className="ghost-pill"
                      // `pending` disables on the first press, not 140 ms later.
                      disabled={retryBlockedReason !== null || retry.pending}
                      aria-busy={retry.pending || undefined}
                      onClick={() => void retry.run()}
                    >
                      {retry.showPending ? (
                        <>
                          <Spinner size="xs" /> Retrying…
                        </>
                      ) : (
                        "Retry failed"
                      )}
                    </button>
                    {retryBlockedReason !== null && (
                      <span className="muted">{retryBlockedReason}</span>
                    )}
                  </div>
                  <div className="job-action">
                    <button type="button" className="ghost-pill" disabled>
                      Lint bundle
                    </button>
                    <span className="muted">Lint is available in Phase 5.</span>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        {confirmCancel && (
          <ConfirmDialog
            title="Cancel job?"
            confirmLabel="Cancel job"
            cancelLabel="Keep running"
            onConfirm={async () => {
              await cancelSelectedJob();
              setConfirmCancel(false);
            }}
            onCancel={() => setConfirmCancel(false)}
          >
            Cancel job: stop the running job. Completed units stay on disk.
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}

function StageStepper({
  cells,
  doneCount,
  total,
  kind,
}: {
  cells: StageCell[];
  doneCount: number;
  total: number;
  kind: JobSummary["kind"];
}) {
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  return (
    <section className="job-stepper-wrap" aria-label="Pipeline stages">
      <ol className="job-stepper">
        {cells.map((cell) => (
          <li
            key={cell.stage}
            className="job-stage"
            data-state={cell.visual}
            data-source={kind === "youtube" ? "youtube" : "web"}
          >
            <span className="job-stage-name">{cell.stage}</span>
            <span className="job-stage-state">{cell.visual}</span>
            {cell.reason !== null && <span className="job-stage-reason">{cell.reason}</span>}
          </li>
        ))}
      </ol>
      <div
        className="job-progress"
        role="progressbar"
        aria-label="Live stages complete"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={doneCount}
      >
        <div
          className="job-progress-fill"
          data-emphasis="strongest"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function UnitFeed({
  rows,
  feedCapped,
  sourceUrl,
}: {
  rows: UnitFeedRow[];
  feedCapped: boolean;
  sourceUrl: string;
}) {
  return (
    <section className="job-unit-feed" aria-label="Live unit feed">
      <div className="job-feed-head">
        <span className="subhead">Units</span>
        <span className="job-feed-source" title={sourceUrl}>
          {sourceUrl}
        </span>
        {feedCapped && <span className="muted">Showing the last 500 units.</span>}
      </div>
      <div className="job-feed-scroll">
        {rows.map((row) => (
          <div className="job-feed-row" key={row.seq}>
            <span className="job-feed-slug">{row.slug}</span>
            <span className="job-feed-stage">{row.stage}</span>
            <span className="job-feed-status" data-status={row.status}>
              {row.status}
            </span>
            {row.status === "skipped" ? (
              <span className="job-feed-detail">
                {`Skipped: ${row.detail ?? row.reason ?? "no reason"}`}
              </span>
            ) : row.detail !== undefined ? (
              <span className="job-feed-detail">{row.detail}</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The approved copy for a unit that failed extraction and left a partial page. */
const S2_FAILURE_COPY = "Extraction failed. Source page saved as partial.";

/**
 * The S2 reasons whose path writes a partial source page. `capture_invalid`
 * stops before that write, so it shows its plain reason instead (WR-10).
 */
const S2_PARTIAL_REASONS: ReadonlySet<string> = new Set([
  "malformed_json",
  "model_error",
  "model_timeout",
  "llm_not_configured",
]);

function reasonCopy(row: { stage: string; reason: string }): string {
  if (row.stage !== "S2") return row.reason;
  return S2_PARTIAL_REASONS.has(row.reason) ? S2_FAILURE_COPY : row.reason;
}

function FailedUnitTable({
  rows,
  retryBlockedReason,
  retryPending,
  onRetry,
}: {
  rows: Array<{ slug: string; stage: string; reason: string; detail?: string }>;
  retryBlockedReason: string | null;
  retryPending: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="job-failed" aria-label="Failed units">
      <span className="subhead">Failed units</span>
      {rows.length === 0 ? (
        <div className="job-empty">
          <p className="job-empty-title">No failed units</p>
          <p className="muted">Every selected unit completed.</p>
        </div>
      ) : (
        <table className="job-failed-table">
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Stage</th>
              <th scope="col">Reason</th>
              <th scope="col">Retry all</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.slug}\u0000${row.reason}`}>
                <td className="job-failed-slug">{row.slug}</td>
                <td>{row.stage}</td>
                {/* The detail stays reachable as the title; the visible copy is
                    the approved sentence whenever the run wrote a partial page. */}
                <td title={row.detail}>{reasonCopy(row)}</td>
                <td>
                  <button
                    type="button"
                    // Secondary by definition: the default surface, never accent
                    // and never danger. It shares the primary action's guards.
                    className="ghost-pill"
                    aria-label="Retry all failed units"
                    disabled={retryBlockedReason !== null || retryPending}
                    onClick={onRetry}
                  >
                    Retry all failed units
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
