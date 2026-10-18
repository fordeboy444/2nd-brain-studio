/**
 * The stage loop (PIPE-02, PIPE-10, PIPE-11).
 *
 * Ordering: S0 first, then S1 for a video job or S1w for a web job. `stage`
 * names the stage to run next, and it is written only after the previous
 * stage's artifact was renamed into place — a crash between the two re-runs the
 * stage instead of observing a partial file.
 *
 * Adjacency: one stage at a time, one unit at a time. The Phase 3 form of
 * PIPE-10 is a one-job FIFO; `settings.fetch.concurrency` is stored and
 * rendered but is not consumed until Phase 4.
 *
 * Zero LLM in the runner: this module dispatches `S2` to its stage module and
 * never dereferences `deps.llm` itself. The field is on the dependency set so
 * S2 can read it through the one seam.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "@2nd-brain/okf";
import { config } from "../config.js";
import { writeJsonAtomic, writeTextAtomic } from "../http/writeAtomic.js";
import type { LlmClient } from "../llm/ollama.js";
import { resolveInVault } from "../paths/jail.js";
import {
  applyFilters,
  filterInputForSettings,
  uniqueSlug,
} from "../ingest/filters.js";
import { vaultDirPath } from "../vaults/registry.js";
import {
  CaptureMismatchError,
  findCaptureByUrl,
  readCapture,
  writeCapture,
} from "./capture.js";
import { appendEvent, jobDir, readJob, requestCancel, writeJob } from "./store.js";
import { createS2Stage } from "./stages/s2.js";
import { createS3Stage } from "./stages/s3.js";
import { createS4Stage } from "./stages/s4.js";
import { createS5Stage } from "./stages/s5.js";
import {
  SkipError,
  type JobRecord,
  type SkipReason,
  type SkippedUnit,
  type StageName,
  type VideoCandidate,
  type VideoRawCapture,
} from "./types.js";

/** A resolved web capture as an adapter returns it. Identity is the requested URL. */
export interface WebFetchResult {
  site: string;
  title: string;
  paragraphs: string[];
  wordCount: number;
  warning?: "short_page";
  capturedAt?: string;
  /** Optional explicit slug; falls back to the title, then the URL. */
  slug?: string;
}

/**
 * What S0 asks the enumerator for. Enumeration is pure — it returns every
 * candidate the capped scan saw — so filters and the `maxVideos` cap are
 * applied by the runner AFTER it returns, exactly as the preview does.
 */
export interface EnumerateOptions {
  maxVideos: number;
  maxScan: number;
}

/** Built once per job and passed unchanged to both S1 and S1w. */
export interface UnitContext {
  signal: AbortSignal;
  language: string;
  cookiePath?: string;
  jobId: string;
  vaultDir: string;
  now: () => number;
}

export interface StageDeps {
  /**
   * The S1 fetch stage returns the video arm of the one `RawCapture` union,
   * already carrying the producing tier. The runner only writes it.
   */
  fetchTranscript(
    candidate: VideoCandidate,
    ctx: UnitContext,
  ): Promise<VideoRawCapture>;
  fetchWeb(input: { url: string }, ctx: UnitContext): Promise<WebFetchResult>;
  enumerate(
    url: string,
    opts: EnumerateOptions,
    signal: AbortSignal,
  ): Promise<VideoCandidate[]>;
  preflight(candidates: VideoCandidate[], ctx: UnitContext): Promise<void>;
  cookiePath(): string | undefined;
  classifyVideoError(error: unknown): SkipReason;
  classifyWebError(error: unknown): SkipReason;
  now(): number;
  vaultDirFor(vaultId: string): string;
  /** Read only by the S2 stage module; the runner never dereferences it. */
  llm: LlmClient;
  /** The vault-global content-addressed cache directory for one vault. */
  cacheDirFor(vaultId: string): string;
  /** Resolve a vault-relative page path through the jail, then write it. */
  writePage(vaultDir: string, relPath: string, text: string): Promise<void>;
  idGenerator?: () => string;
}

/**
 * The stage tail a job runs, in order. Each plan appends the stages it owns:
 * S2 here, S3 in 04-03, S4 in 04-04 and S5/S6 in 04-05.
 */
export function stagesFor(job: JobRecord): StageName[] {
  return job.kind === "youtube"
    ? ["S0", "S1", "S2", "S3", "S4", "S5"]
    : ["S0", "S1w", "S2", "S3", "S4", "S5"];
}

const TERMINAL: ReadonlySet<JobRecord["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** The controller of the job currently executing, keyed by job id. */
const activeControllers = new Map<string, AbortController>();

export function activeController(jobId: string): AbortController | undefined {
  return activeControllers.get(jobId);
}

/** The inert adapter set: no network, no LLM, zero units. */
export function createDefaultStageDeps(): StageDeps {
  return {
    async fetchTranscript() {
      throw new SkipError("fetch_error", "transcript adapter not configured");
    },
    async fetchWeb() {
      throw new SkipError("fetch_error", "web adapter not configured");
    },
    async enumerate() {
      return [];
    },
    async preflight() {
      // No adapter exists yet, so there is nothing to probe.
    },
    cookiePath: () => config.youtubeCookiePath,
    classifyVideoError: () => "fetch_error",
    classifyWebError: () => "fetch_error",
    now: () => Date.now(),
    vaultDirFor: (vaultId) => vaultDirPath(vaultId),
    // The real client is wired in 04-05; until then S2 records a typed skip
    // instead of reaching the network.
    llm: {
      async chat() {
        throw new SkipError("llm_not_configured", "LLM client not configured");
      },
    },
    cacheDirFor: (vaultId) => join(vaultDirPath(vaultId), ".okf", "cache", "llm"),
    async writePage(vaultDir, relPath, text) {
      const { absPath } = await resolveInVault(vaultDir, relPath);
      await writeTextAtomic(absPath, text);
    },
  };
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "stage_failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Slug for a candidate: the title, falling back to the stable video id. */
export function slugForCandidate(candidate: VideoCandidate): string {
  try {
    return slugify(candidate.title);
  } catch {
    return slugify(candidate.youtubeId);
  }
}

/** Slug for a web page when no title-derived slug is available. */
export function slugForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return slugify(`${parsed.hostname} ${parsed.pathname}`);
  } catch {
    return "web-capture";
  }
}

function skippedFor(
  error: unknown,
  slug: string,
  stage: "S0" | "S1" | "S1w",
  classify: (error: unknown) => SkipReason,
  youtubeId?: string,
): SkippedUnit {
  let reason: SkipReason;
  let detail: string | undefined;
  if (error instanceof CaptureMismatchError) {
    reason = "capture_invalid";
    detail = error.reason;
  } else if (error instanceof SkipError) {
    reason = error.reason;
    detail = error.detail;
  } else {
    reason = classify(error);
    detail = messageOf(error);
  }
  const skipped: SkippedUnit = { slug, stage, reason };
  if (youtubeId !== undefined) skipped.youtubeId = youtubeId;
  if (detail !== undefined) skipped.detail = detail;
  return skipped;
}

function makeCtx(
  job: JobRecord,
  vaultDir: string,
  signal: AbortSignal,
  deps: StageDeps,
): UnitContext {
  let cookiePath: string | undefined;
  try {
    cookiePath = deps.cookiePath();
  } catch {
    cookiePath = undefined;
  }
  return {
    signal,
    language: job.settings.filters.language ?? "en",
    cookiePath,
    jobId: job.id,
    vaultDir,
    now: deps.now,
  };
}

/**
 * Persist the record, first merging a cancel flag another process wrote. A
 * cancel that lands while a unit runs is therefore never erased by the unit's
 * own write, and the next between-unit read sees it.
 */
function makePersist(job: JobRecord, vaultDir: string, deps: StageDeps) {
  return async (): Promise<void> => {
    try {
      const disk = await readJob(vaultDir, job.id);
      if (disk.cancelRequested) job.cancelRequested = true;
    } catch {
      // The record may not exist yet on the very first write.
    }
    job.updatedAt = iso(deps.now);
    await writeJob(vaultDir, job);
  };
}

/** Run a job to a terminal status. Terminal jobs are returned unchanged. */
export async function runJob(
  job: JobRecord,
  deps: StageDeps = createDefaultStageDeps(),
): Promise<JobRecord> {
  if (TERMINAL.has(job.status)) return job;

  const vaultDir = deps.vaultDirFor(job.vaultId);
  const dir = jobDir(vaultDir, job.id);
  const persist = makePersist(job, vaultDir, deps);
  const controller = new AbortController();
  activeControllers.set(job.id, controller);
  const ctx = makeCtx(job, vaultDir, controller.signal, deps);
  const table = stagesFor(job);

  try {
    job.status = "running";

    // A cancel that arrived while the job sat in the queue wins before any work.
    if (job.cancelRequested) {
      job.status = "cancelled";
      await persist();
      await appendEvent(dir, "done", { status: "cancelled" });
      return job;
    }

    const firstStage = table[0] as StageName;
    if (job.stage === undefined) job.stage = firstStage;
    await persist();

    const current = job.stage ?? firstStage;
    let start = current === "done" ? table.length : table.indexOf(current);
    if (start < 0) start = 0;

    for (let i = start; i < table.length; i += 1) {
      const stage = table[i] as StageName;
      // The pointer names the stage being started; it advanced only after the
      // previous stage's artifact rename returned.
      job.stage = stage;
      await persist();
      await appendEvent(dir, "stage", { stage, status: "started" });

      let cancelled = false;
      try {
        if (stage === "S0") {
          await runS0(job, deps, ctx, dir);
        } else if (stage === "S1") {
          cancelled = await runS1(job, vaultDir, deps, ctx, dir, persist);
        } else if (stage === "S1w") {
          cancelled = await runS1w(job, vaultDir, deps, ctx, dir, persist);
        } else if (stage === "S3") {
          cancelled = await createS3Stage(deps)(job, ctx, dir, persist);
        } else if (stage === "S4") {
          cancelled = await createS4Stage(deps)(job, ctx, dir, persist);
        } else if (stage === "S5") {
          cancelled = await createS5Stage(deps)(job, ctx, dir, persist);
        } else {
          cancelled = await createS2Stage(deps)(job, ctx, dir, persist);
        }
      } catch (error) {
        job.status = "failed";
        job.error = errorCode(error);
        await persist();
        await appendEvent(dir, "error", {
          stage,
          code: job.error,
          message: messageOf(error),
        });
        await appendEvent(dir, "done", { status: "failed" });
        return job;
      }

      if (cancelled) {
        controller.abort();
        job.status = "cancelled";
        await persist();
        await appendEvent(dir, "done", { status: "cancelled" });
        return job;
      }

      await appendEvent(dir, "stage", { stage, status: "completed" });
    }

    job.stage = "done";
    job.status = "completed";
    await persist();
    await appendEvent(dir, "done", { status: "completed" });
    return job;
  } finally {
    activeControllers.delete(job.id);
  }
}

async function runS0(
  job: JobRecord,
  deps: StageDeps,
  ctx: UnitContext,
  dir: string,
): Promise<void> {
  const settings = job.settings;
  const maxVideos = Number.isFinite(settings.maxVideos) ? Math.max(1, settings.maxVideos) : 1;
  const candidates = await deps.enumerate(
    job.input.url,
    {
      maxVideos,
      maxScan: Math.min(2000, maxVideos * 5),
    },
    ctx.signal,
  );
  // The same filter step and `maxVideos` cap the preview ran. Without this,
  // a committed job would fetch every scanned candidate and silently ignore
  // the user's date/duration/language filters.
  const { selected } = applyFilters(
    candidates,
    filterInputForSettings({ maxVideos, filters: settings.filters }),
  );
  job.progress = { done: 0, total: selected.length };
  // A zero-unit stage still writes its artifact and advances.
  await writeJsonAtomic(join(dir, "01-enumerate.json"), {
    url: job.input.url,
    count: selected.length,
    candidates: selected,
    at: iso(deps.now),
  });
}

async function readEnumerated(dir: string): Promise<VideoCandidate[]> {
  const raw = await readFile(join(dir, "01-enumerate.json"), "utf8");
  const parsed = JSON.parse(raw) as { candidates?: unknown };
  return Array.isArray(parsed.candidates) ? (parsed.candidates as VideoCandidate[]) : [];
}

/**
 * S1: preflight, dedupe by slug, then one unit at a time. Returns true when the
 * job was cancelled. A failed unit lands in `skipped[]` and the stage goes on.
 */
async function runS1(
  job: JobRecord,
  vaultDir: string,
  deps: StageDeps,
  ctx: UnitContext,
  dir: string,
  persist: () => Promise<void>,
): Promise<boolean> {
  const candidates = await readEnumerated(dir);

  // Dedupe by video id, then allocate slugs with the same allocator the
  // preview counts with. Deduping by title-slug would silently drop every
  // same-title video ("Live", episodes, trailers) that the preview counted,
  // and the missing unit never even lands in `skipped[]`.
  const seen = new Set<string>();
  const usedSlugs = new Set<string>();
  const units: Array<[string, VideoCandidate]> = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.youtubeId)) continue;
    seen.add(candidate.youtubeId);
    units.push([uniqueSlug(candidate, usedSlugs), candidate]);
  }

  // `progress` counts this run's units. On resume the units re-run (captures
  // are idempotent), so a carried-over count would double count them; the
  // pre-reset value only tells us whether S1 has ever started.
  const resumedDone = job.progress?.done ?? 0;
  job.progress = { done: 0, total: units.length };
  await persist();

  if (units.length > 0 && resumedDone === 0) {
    try {
      await deps.preflight(
        units.map(([, candidate]) => candidate),
        ctx,
      );
    } catch (error) {
      const failure = new Error(`preflight failed: ${messageOf(error)}`);
      (failure as Error & { code?: string }).code = "preflight_failed";
      throw failure;
    }
  }

  for (const [slug, candidate] of units) {
    // Re-read from disk: the in-memory copy is not the authority on cancel.
    const latest = await readJob(vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    const existing = await readCapture(vaultDir, slug);
    if (
      existing?.frontmatter?.source_kind === "video" &&
      existing.frontmatter.youtube_id === candidate.youtubeId
    ) {
      job.progress.done += 1;
      await persist();
      await appendEvent(dir, "unit", {
        slug,
        stage: "S1",
        status: "skipped",
        detail: "capture present",
      });
      continue;
    }

    try {
      const capture = await deps.fetchTranscript(candidate, ctx);
      // The runner owns the slug key it deduped on, so the capture cannot be
      // written under a slug the loop is not tracking.
      await writeCapture(vaultDir, { ...capture, slug });
      job.progress.done += 1;
      await persist();
      await appendEvent(dir, "unit", {
        slug,
        stage: "S1",
        status: "written",
        tier: capture.tier,
      });
    } catch (error) {
      const skipped = skippedFor(
        error,
        slug,
        "S1",
        deps.classifyVideoError,
        candidate.youtubeId,
      );
      job.skipped.push(skipped);
      job.progress.done += 1;
      await persist();
      await appendEvent(dir, "unit", {
        slug,
        stage: "S1",
        status: "skipped",
        reason: skipped.reason,
        detail: skipped.detail,
      });
    }
  }

  // A cancel that landed during the final unit is still honoured.
  const final = await readJob(vaultDir, job.id);
  job.cancelRequested = final.cancelRequested;
  return job.cancelRequested;
}

/**
 * S1w: find an existing capture by the requested URL before any fetch, then
 * scrape once. A bad page becomes a skipped unit; it never fails the job.
 */
async function runS1w(
  job: JobRecord,
  vaultDir: string,
  deps: StageDeps,
  ctx: UnitContext,
  dir: string,
  persist: () => Promise<void>,
): Promise<boolean> {
  const latest = await readJob(vaultDir, job.id);
  job.cancelRequested = latest.cancelRequested;
  if (job.cancelRequested) return true;

  job.progress = { done: 0, total: 1 };
  await persist();

  const existing = await findCaptureByUrl(vaultDir, job.input.url);
  if (existing !== null) {
    job.progress.done = 1;
    await persist();
    await appendEvent(dir, "unit", {
      slug: existing.slug,
      stage: "S1w",
      status: "skipped",
      detail: "capture present",
    });
    return false;
  }

  const fallbackSlug = slugForUrl(job.input.url);
  try {
    const result = await deps.fetchWeb({ url: job.input.url }, ctx);
    let slug = fallbackSlug;
    if (result.slug !== undefined) {
      slug = result.slug;
    } else if (result.title !== "") {
      try {
        slug = slugify(result.title);
      } catch {
        slug = fallbackSlug;
      }
    }
    await writeCapture(vaultDir, {
      kind: "web",
      slug,
      url: job.input.url,
      site: result.site,
      title: result.title,
      capturedAt: result.capturedAt ?? iso(deps.now),
      wordCount: result.wordCount,
      warning: result.warning,
      paragraphs: result.paragraphs,
    });
    job.progress.done = 1;
    await persist();
    await appendEvent(dir, "unit", { slug, stage: "S1w", status: "written" });
  } catch (error) {
    const skipped = skippedFor(error, fallbackSlug, "S1w", deps.classifyWebError);
    job.skipped.push(skipped);
    job.progress.done = 1;
    await persist();
    await appendEvent(dir, "unit", {
      slug: skipped.slug,
      stage: "S1w",
      status: "skipped",
      reason: skipped.reason,
      detail: skipped.detail,
    });
  }

  const final = await readJob(vaultDir, job.id);
  job.cancelRequested = final.cancelRequested;
  return job.cancelRequested;
}

export interface JobQueue {
  /** Queue a job behind the active one. Resolves when this job is terminal. */
  enqueue(job: JobRecord): Promise<JobRecord>;
  /** Set the cancel flag and abort the active subprocess, if this job owns it. */
  cancel(vaultDir: string, id: string): Promise<void>;
  /** Resolves when the chain drains. */
  idle(): Promise<void>;
  readonly size: number;
  /** Ids in the order they started, for tests and boot logging. */
  readonly started: string[];
}

/** A FIFO of exactly one running job (PIPE-10, Phase 3 form). */
export function createJobQueue(deps: StageDeps = createDefaultStageDeps()): JobQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const started: string[] = [];

  return {
    enqueue(job: JobRecord): Promise<JobRecord> {
      pending += 1;
      const run = chain.then(async () => {
        started.push(job.id);
        try {
          return await runJob(job, deps);
        } finally {
          pending -= 1;
        }
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    async cancel(vaultDir: string, id: string): Promise<void> {
      activeController(id)?.abort();
      await requestCancel(vaultDir, id);
    },

    idle(): Promise<void> {
      return chain.then(() => undefined);
    },

    get size(): number {
      return pending;
    },

    get started(): string[] {
      return [...started];
    },
  };
}
