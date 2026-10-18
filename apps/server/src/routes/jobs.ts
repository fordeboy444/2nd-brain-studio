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
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { sameOrigin } from "../http/origin.js";
import { InvalidSourceUrlError, normalizeChannelUrl } from "../ingest/urls.js";
import { getJobQueue } from "../jobs/bootstrap.js";
import {
  createJobRecord,
  isJobId,
  listJobs,
  newJobId,
  readJob,
  requestCancel,
  writeJob,
} from "../jobs/store.js";
import type { JobRecord, JobSettings, JobStatus } from "../jobs/types.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";

export const jobs = new Hono();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/jobs body. Every string is bounded and `maxVideos` is capped at
 * 2000, so one request cannot ask for an unbounded scan (T-03-05).
 */
const CreateJobBody = z.object({
  vaultId: z.string().min(1).max(128),
  kind: z.literal("youtube"),
  channelUrl: z.string().min(1).max(2048),
  maxVideos: z.number().int().min(1).max(2000),
  dateFrom: z.string().regex(DATE_RE).optional(),
  dateTo: z.string().regex(DATE_RE).optional(),
  minDurationSec: z.number().int().min(0).max(86400).optional(),
  language: z.string().min(2).max(16).optional(),
});

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

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
          "Request body must be JSON with vaultId, kind:\"youtube\", channelUrl and maxVideos (1..2000).",
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

  let channelUrl: string;
  try {
    channelUrl = normalizeChannelUrl(parsed.channelUrl);
  } catch (error) {
    if (error instanceof InvalidSourceUrlError) {
      return c.json({ error: "invalid_source_url", message: error.message }, 400);
    }
    throw error;
  }

  const filters: JobSettings["filters"] = {};
  if (parsed.dateFrom !== undefined) filters.publishedAfter = parsed.dateFrom;
  if (parsed.dateTo !== undefined) filters.publishedBefore = parsed.dateTo;
  if (parsed.minDurationSec !== undefined) filters.minDurationSec = parsed.minDurationSec;
  if (parsed.language !== undefined) filters.language = parsed.language;

  const settings: JobSettings = {
    maxVideos: parsed.maxVideos,
    filters,
    // Stored and rendered in Phase 3; the one-job FIFO is the active limit.
    fetch: { concurrency: 1 },
    llm: { model: config.ollamaModel },
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
  // Not awaited: the response means "accepted", not "finished". A rejection is
  // already recorded on the job by the runner.
  void getJobQueue()
    .enqueue(record)
    .catch(() => undefined);

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
    all.push(...(await listJobs(vaultDirPath(vault.id))));
  }

  const filtered = status === undefined ? all : all.filter((job) => job.status === status);
  // Newest first, id descending as the tiebreak, across every vault.
  filtered.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });

  return c.json({ jobs: filtered });
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
