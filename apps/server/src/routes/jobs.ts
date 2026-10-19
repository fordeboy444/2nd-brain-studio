/**
 * The job routes (API-03, API-04, API-05).
 *
 * The route module follows the vault route idiom: a `Hono` instance, zod body
 * validation inside try/catch, and `{error, message}` on every non-2xx path.
 *
 * Ordering that matters: the record is written to disk BEFORE it is enqueued.
 * A crash between the two leaves a `queued` job on disk, which boot resume picks
 * up; the reverse order could lose a job the API already answered 202 for.
 *
 * The route never builds a filesystem path from a request value. A job id is
 * validated by `isJobId` and the vault directory comes from the registry.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import pino from "pino";
import { z } from "zod";
import { config } from "../config.js";
import { sameOrigin } from "../http/origin.js";
import { EnumerateError } from "../ingest/enumerate.js";
import {
  previewJob,
  type PreviewInput,
  type PreviewResult,
} from "../ingest/preview.js";
import { parseWebUrl, SsrfError } from "../ingest/ssrf.js";
import { InvalidSourceUrlError, normalizeChannelUrl } from "../ingest/urls.js";
import { getJobQueue } from "../jobs/bootstrap.js";
import { parseLastEventId, streamJobEvents } from "../jobs/events.js";
import {
  createJobRecord,
  isJobId,
  JobRecordSchema,
  jobDir,
  listJobs,
  newJobId,
  readJob,
  requestCancel,
  resetJobEvents,
  writeJob,
} from "../jobs/store.js";
import { retryJobRecord } from "../jobs/runner.js";
import type { JobRecord, JobSettings, JobStatus } from "../jobs/types.js";
import { PathJailError, resolveInVault } from "../paths/jail.js";
import { readSettings } from "../settings/store.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";

export const jobs = new Hono();

const log = pino({ name: "jobs-route" });

/**
 * Enqueue without awaiting: the response means "accepted", not "finished".
 * The runner records its own failure on the job, but a rejection before that
 * point must not be silent.
 */
function enqueueJob(record: JobRecord): void {
  void getJobQueue()
    .enqueue(record)
    .catch((error: unknown) => {
      log.error({ jobId: record.id, err: error }, "enqueue_failed");
    });
}

/**
 * Stream intervals. Production never writes this object; a spec sets short
 * intervals so keepalive and tail behaviour are observable in a few
 * milliseconds instead of 15 seconds.
 */
export const sseOptions: { pollMs: number; keepaliveMs: number } = {
  pollMs: 250,
  keepaliveMs: 15_000,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The YouTube create arm. Every string is bounded and `maxVideos` is capped at
 * 2000, so one request cannot ask for an unbounded scan (T-03-05).
 */
const YoutubeCreateBody = z.object({
  vaultId: z.string().min(1).max(128),
  kind: z.literal("youtube"),
  channelUrl: z.string().min(1).max(2048),
  maxVideos: z.number().int().min(1).max(2000),
  dateFrom: z.string().regex(DATE_RE).optional(),
  dateTo: z.string().regex(DATE_RE).optional(),
  minDurationSec: z.number().int().min(0).max(86400).optional(),
  language: z.string().min(2).max(16).optional(),
});

/**
 * The web create arm. `.strict()` is the point: a web job has one page, so a
 * `maxVideos` or a date filter is a client error rather than a value that is
 * silently dropped.
 */
const WebCreateBody = z
  .object({
    vaultId: z.string().min(1).max(128),
    kind: z.literal("web"),
    url: z.string().min(1).max(2048),
    language: z.string().min(2).max(16).optional(),
  })
  .strict();

const CreateJobBody = z.discriminatedUnion("kind", [YoutubeCreateBody, WebCreateBody]);

/**
 * POST /:id/retry body. Strict, so an unknown key is a 400 rather than a value
 * that silently changes what the route does. An empty body means `onlyFailed`.
 * `onlyFailed: false` is refused: PIPE-12 has one retry mode, and accepting the
 * value while retrying failed units only would do the opposite of the request.
 */
const RetryBody = z.object({ onlyFailed: z.literal(true).optional() }).strict();

/**
 * POST /api/jobs/preview body: the create body without `vaultId`, because a
 * preview writes nothing and therefore needs no vault.
 */
const YoutubePreviewBody = z.object({
  kind: z.literal("youtube"),
  channelUrl: z.string().min(1).max(2048),
  maxVideos: z.number().int().min(1).max(2000),
  dateFrom: z.string().regex(DATE_RE).optional(),
  dateTo: z.string().regex(DATE_RE).optional(),
  minDurationSec: z.number().int().min(0).max(86400).optional(),
  language: z.string().min(2).max(16).optional(),
});

const WebPreviewBody = z
  .object({
    kind: z.literal("web"),
    url: z.string().min(1).max(2048),
    language: z.string().min(2).max(16).optional(),
  })
  .strict();

const PreviewBody = z.discriminatedUnion("kind", [YoutubePreviewBody, WebPreviewBody]);

/**
 * A web job's dry run is one page. The number is fixed rather than enumerated:
 * a preview must make no network call, so there is nothing to discover.
 */
const WEB_PREVIEW: PreviewResult = {
  found: 1,
  selected: 1,
  skipped: [],
  estimatedCalls: 8,
  estimatedMinutes: 4,
};

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

/** The three stage artifacts a job exposes. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set(["enumerate", "raw", "skipped"]);

/**
 * A raw capture slug. Deliberately strict: no separator, no parent segment, no
 * uppercase, so the value can only ever name one file directly under `raw/`
 * (T-03-09). The jail re-checks the resolved path anyway.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Every status a job can hold; an unknown query value is a 400, not a filter. */
const STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A non-GET request whose `Origin` names another host is refused before the
 * body is read, so a forged cross-site create/cancel never reaches the store.
 */
jobs.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    return c.json(
      { error: "origin_mismatch", message: "Cross-origin requests are not accepted." },
      403,
    );
  }
  await next();
});

interface FoundJob {
  job: JobRecord;
  vaultDir: string;
}

/**
 * Find one job across every registered vault. Job ids carry no vault id, so the
 * scan is the lookup. An unreadable record is treated as absent.
 */
async function findJob(id: string): Promise<FoundJob | null> {
  if (!isJobId(id)) return null;
  const registry = await readRegistry();
  for (const vault of registry.vaults) {
    const vaultDir = vaultDirPath(vault.id);
    try {
      return { job: await readJob(vaultDir, id), vaultDir };
    } catch {
      // Not in this vault (or a corrupt record): keep scanning.
    }
  }
  return null;
}

/** The YouTube preview form mapped onto `previewJob`'s input shape. */
function toPreviewInput(parsed: z.infer<typeof YoutubePreviewBody>): PreviewInput {
  return {
    channelUrl: parsed.channelUrl,
    maxVideos: parsed.maxVideos,
    ...(parsed.dateFrom !== undefined ? { dateFrom: parsed.dateFrom } : {}),
    ...(parsed.dateTo !== undefined ? { dateTo: parsed.dateTo } : {}),
    ...(parsed.minDurationSec !== undefined
      ? { minDurationSec: parsed.minDurationSec }
      : {}),
    ...(parsed.language !== undefined ? { language: parsed.language } : {}),
  };
}

/** Map an enumeration failure onto the route contract. */
function previewFailure(
  error: unknown,
): { status: 400 | 502 | 504; error: string; message: string } | null {
  if (error instanceof InvalidSourceUrlError) {
    return { status: 400, error: "invalid_source_url", message: error.message };
  }
  if (error instanceof EnumerateError) {
    if (error.code === "timeout") {
      return {
        status: 504,
        error: "enumerate_timeout",
        message: "Channel enumeration timed out.",
      };
    }
    return {
      status: 502,
      error: "enumerate_failed",
      message: "Channel enumeration failed.",
    };
  }
  return null;
}

/**
 * GET /preview is not part of the contract. Answering it explicitly (rather
 * than letting the literal fall through to `GET /:id`) keeps `/preview` from
 * ever being treated as a job id.
 */
jobs.get("/preview", (c) => {
  c.header("Allow", "POST");
  return c.json(
    { error: "method_not_allowed", message: "Use POST /api/jobs/preview." },
    405,
  );
});

/**
 * The dry run: enumerate, filter and estimate, with zero writes. Registering
 * the literal route before `/:id` is what keeps the path unambiguous.
 */
jobs.post("/preview", async (c) => {
  let parsed: z.infer<typeof PreviewBody>;
  try {
    const body = await c.req.json();
    parsed = PreviewBody.parse(body);
  } catch {
    return c.json(
      {
        error: "invalid_body",
        message:
          "Request body must be JSON with kind:\"youtube\" (channelUrl, maxVideos 1..2000) or kind:\"web\" (url). A web preview takes no maxVideos or date filters.",
      },
      400,
    );
  }

  if (parsed.kind === "web") {
    try {
      // Syntax only: a preview must not resolve DNS or fetch the page.
      parseWebUrl(parsed.url);
    } catch (error) {
      if (error instanceof SsrfError) {
        return c.json({ error: "invalid_source_url", message: error.message }, 400);
      }
      throw error;
    }
    return c.json(WEB_PREVIEW, 200);
  }

  try {
    const preview = await previewJob(toPreviewInput(parsed));
    return c.json(preview, 200);
  } catch (error) {
    const failure = previewFailure(error);
    if (failure !== null) {
      return c.json({ error: failure.error, message: failure.message }, failure.status);
    }
    throw error;
  }
});

jobs.post("/", async (c) => {
  let parsed: z.infer<typeof CreateJobBody>;
  try {
    const body = await c.req.json();
    parsed = CreateJobBody.parse(body);
  } catch {
    return c.json(
      {
        error: "invalid_body",
        message:
          "Request body must be JSON with kind:\"youtube\" (vaultId, channelUrl, maxVideos 1..2000) or kind:\"web\" (vaultId, url). A web job takes no maxVideos or date filters.",
      },
      400,
    );
  }

  // The vault must already exist; the Settings form creates one first.
  const registry = await readRegistry();
  const vault = registry.vaults.find((entry) => entry.id === parsed.vaultId);
  if (!vault) {
    return c.json({ error: "vault_not_found", message: "Unknown vault." }, 404);
  }

  // A web job has one page, so there is nothing to enumerate or filter. The
  // URL is checked for syntax here; the address check runs in S1w, where a DNS
  // failure is a unit skip rather than a route error.
  if (parsed.kind === "web") {
    let webUrl: string;
    try {
      webUrl = parseWebUrl(parsed.url).toString();
    } catch (error) {
      if (error instanceof SsrfError) {
        return c.json({ error: "invalid_source_url", message: error.message }, 400);
      }
      throw error;
    }

    const globalSettings = await readSettings();
    const filters: JobSettings["filters"] = {};
    if (parsed.language !== undefined) filters.language = parsed.language;

    const vaultDir = vaultDirPath(vault.id);
    const record = createJobRecord({
      id: newJobId(),
      vaultId: vault.id,
      kind: "web",
      input: { url: webUrl },
      settings: {
        ...globalSettings,
        maxVideos: 1,
        filters,
        // The endpoint is part of the snapshot, so this job stays reproducible
        // after a later environment change.
        llm: { ...globalSettings.llm, baseUrl: config.ollamaBaseUrl },
      },
    });

    await writeJob(vaultDir, record);
    enqueueJob(record);

    return c.json({ id: record.id, status: "queued" }, 202);
  }

  let channelUrl: string;
  try {
    channelUrl = normalizeChannelUrl(parsed.channelUrl);
  } catch (error) {
    if (error instanceof InvalidSourceUrlError) {
      return c.json({ error: "invalid_source_url", message: error.message }, 400);
    }
    throw error;
  }

  // Enumeration at commit time. The server runs the same preview path instead
  // of trusting a client-supplied selected count, so an empty selection is
  // refused before any job record exists. This duplicates one S0 call per
  // commit; a spoofable count is the alternative, and that is not acceptable.
  let preview: PreviewResult;
  try {
    preview = await previewJob(toPreviewInput(parsed));
  } catch (error) {
    const failure = previewFailure(error);
    if (failure !== null) {
      return c.json({ error: failure.error, message: failure.message }, failure.status);
    }
    throw error;
  }
  if (preview.selected === 0) {
    return c.json(
      {
        error: "empty_selection",
        message: "No videos matched the filters; nothing was queued.",
      },
      400,
    );
  }

  const filters: JobSettings["filters"] = {};
  if (parsed.dateFrom !== undefined) filters.publishedAfter = parsed.dateFrom;
  if (parsed.dateTo !== undefined) filters.publishedBefore = parsed.dateTo;
  if (parsed.minDurationSec !== undefined) filters.minDurationSec = parsed.minDurationSec;
  if (parsed.language !== undefined) filters.language = parsed.language;

  // CONTEXT snapshot: the effective global settings are copied into the record
  // before it is written, so a later PUT /api/settings cannot change this job.
  const globalSettings = await readSettings();
  const settings: JobSettings = {
    ...globalSettings,
    maxVideos: parsed.maxVideos,
    filters,
    llm: { ...globalSettings.llm, baseUrl: config.ollamaBaseUrl },
  };

  const vaultDir = vaultDirPath(vault.id);
  const record = createJobRecord({
    id: newJobId(),
    vaultId: vault.id,
    kind: parsed.kind,
    // The canonical channel URL, so S0 receives the shape it enumerates.
    input: { url: channelUrl },
    settings,
  });

  // Persist first: a queued job that exists on disk survives a crash, and boot
  // resume re-enqueues it.
  await writeJob(vaultDir, record);
  enqueueJob(record);

  return c.json({ id: record.id, status: "queued" }, 202);
});

jobs.get("/", async (c) => {
  const status = c.req.query("status");
  if (status !== undefined && !STATUSES.has(status)) {
    return c.json({ error: "invalid_body", message: `Unknown job status "${status}".` }, 400);
  }
  const vaultId = c.req.query("vaultId");

  const registry = await readRegistry();
  const vaults =
    vaultId === undefined ? registry.vaults : registry.vaults.filter((v) => v.id === vaultId);

  const all: JobRecord[] = [];
  for (const vault of vaults) {
    const records = await listJobs(
      vaultDirPath(vault.id),
      (id, error) => {
        log.warn(
          {
            vaultId: vault.id,
            jobId: id,
            reason: error instanceof Error ? error.message : String(error),
          },
          "job_record_unreadable",
        );
      },
    );
    for (const record of records) {
      // The scan reads loosely so boot can report a malformed record; the API
      // never serves one, because the UI dereferences `progress` and `skipped`.
      const valid = JobRecordSchema.safeParse(record);
      if (!valid.success) {
        log.warn(
          {
            vaultId: vault.id,
            jobId: (record as { id?: unknown }).id,
            reason: "job.json is not a valid job record",
          },
          "job_record_invalid",
        );
        continue;
      }
      all.push(valid.data as JobRecord);
    }
  }

  const filtered = status === undefined ? all : all.filter((job) => job.status === status);
  // Newest first, id descending as the tiebreak, across every vault.
  filtered.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });

  return c.json({ jobs: filtered });
});

/**
 * Replay then tail one job's event log. An unknown job is a plain JSON 404
 * before any stream opens, so the client never sees a 200 with no frames.
 */
jobs.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  const found = await findJob(id);
  if (found === null) {
    return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
  }
  const lastSeq = parseLastEventId(c.req.header("last-event-id"));
  return streamJobEvents(c, jobDir(found.vaultDir, id), lastSeq, sseOptions);
});

/**
 * One stage artifact: the enumerate JSON, one raw markdown capture, or the
 * `skipped[]` array. The raw path is the only request-driven filesystem read,
 * and it goes through the jail after the strict slug check.
 */
jobs.get("/:id/artifacts", async (c) => {
  const id = c.req.param("id");
  const found = await findJob(id);
  if (found === null) {
    return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
  }

  const kind = c.req.query("kind");
  if (kind === undefined || !ARTIFACT_KINDS.has(kind)) {
    return c.json(
      { error: "invalid_body", message: "`kind` must be enumerate, raw or skipped." },
      400,
    );
  }

  if (kind === "skipped") {
    return c.json({ skipped: found.job.skipped });
  }

  if (kind === "enumerate") {
    try {
      const text = await readFile(join(jobDir(found.vaultDir, id), "01-enumerate.json"), "utf8");
      return c.body(text, 200, { "content-type": "application/json" });
    } catch {
      return c.json(
        { error: "artifact_not_found", message: "The enumerate artifact does not exist." },
        404,
      );
    }
  }

  const slug = c.req.query("slug");
  if (slug === undefined || !SLUG_RE.test(slug)) {
    return c.json(
      { error: "invalid_slug", message: "`slug` must match ^[a-z0-9][a-z0-9-]*$." },
      400,
    );
  }

  try {
    const { absPath } = await resolveInVault(found.vaultDir, `raw/${slug}.md`);
    const text = await readFile(absPath, "utf8");
    return c.body(text, 200, { "content-type": "text/markdown; charset=utf-8" });
  } catch (error) {
    if (
      error instanceof PathJailError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return c.json(
        { error: "artifact_not_found", message: "The raw capture does not exist." },
        404,
      );
    }
    throw error;
  }
});

/**
 * Job ids with a retry in flight. The route reads, checks and writes in three
 * steps; two overlapping POSTs for one id would both pass the terminal check
 * and enqueue twice (WR-04). This set closes the check-to-write window. The
 * stored `queued` record rejects every later retry after the write.
 */
const retriesInFlight = new Set<string>();

/**
 * Retry the failed units of a terminal job (PIPE-12). The reset record comes
 * from the stored `skipped[]`, never from the request; the body only chooses
 * the retry mode, and PIPE-12 has one: failed units only. A running or queued
 * job is refused before any write, so one job never gets a second runner.
 */
jobs.post("/:id/retry", async (c) => {
  const id = c.req.param("id");

  try {
    const text = await c.req.text();
    // An empty body is the ordinary case: retry every failed unit.
    RetryBody.parse(text.trim() === "" ? {} : (JSON.parse(text) as unknown));
  } catch {
    return c.json(
      {
        error: "invalid_body",
        message: "Request body must be JSON: {} or {\"onlyFailed\": true}.",
      },
      400,
    );
  }

  if (retriesInFlight.has(id)) {
    return c.json(
      { error: "retry_running", message: "Retry after the job finishes." },
      409,
    );
  }
  retriesInFlight.add(id);
  try {
    const found = await findJob(id);
    if (found === null) {
      return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
    }

    const plan = retryJobRecord(found.job);
    if ("error" in plan) {
      if (plan.error === "running") {
        return c.json(
          { error: "retry_running", message: "Retry after the job finishes." },
          409,
        );
      }
      return c.json(
        { error: "no_failed_units", message: "No failed units to retry." },
        409,
      );
    }

    // Start a fresh event log before writing the `queued` record: if the reset
    // throws, the on-disk record is still terminal and can be retried, instead
    // of a `queued` record with no runner and a stale event log.
    await resetJobEvents(jobDir(found.vaultDir, id));
    // Persist next, exactly like create: boot resume can recover the reset job.
    await writeJob(found.vaultDir, found.job);
    enqueueJob(found.job);

    return c.json({ id, status: "queued" }, 202);
  } finally {
    retriesInFlight.delete(id);
  }
});

jobs.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isJobId(id)) {
    return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
  }
  const found = await findJob(id);
  if (found === null) {
    return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
  }
  return c.json(found.job);
});

/**
 * Cancel. A repeated DELETE is 202 with the current status and creates nothing.
 * A terminal job is returned unchanged: cancelling a finished job is a no-op,
 * not a record rewrite.
 */
jobs.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const found = await findJob(id);
  if (found === null) {
    return c.json({ error: "job_not_found", message: "Unknown job." }, 404);
  }

  if (!TERMINAL.has(found.job.status) && !found.job.cancelRequested) {
    // Persist the flag first so the runner sees it even if its own write races;
    // `queue.cancel` also aborts the active adapter through the AbortSignal.
    await requestCancel(found.vaultDir, id);
    await getJobQueue().cancel(found.vaultDir, id);
  }

  let status = found.job.status;
  try {
    status = (await readJob(found.vaultDir, id)).status;
  } catch {
    // Keep the status from the scan when the record cannot be re-read.
  }
  return c.json({ id, status }, 202);
});
