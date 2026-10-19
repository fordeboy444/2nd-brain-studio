/**
 * The vault-scoped job store (T-03-01).
 *
 * Layout: `<vault>/.okf/jobs/<jobId>/{job.json,events.ndjson,01-enumerate.json}`.
 * A job id is generated server-side and validated before any path is built, so
 * a request-supplied id can never reach `path.join`. Vault roots come from the
 * registry, never from a request; raw paths go through the jail.
 *
 * `events.ndjson` is append-only and is the replay source. `seq` starts at 1 and
 * increases by one; the event is on disk before any subscriber sees it.
 */
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../http/writeAtomic.js";
import type {
  JobEvent,
  JobEventType,
  JobInput,
  JobKind,
  JobRecord,
  JobSettings,
} from "./types.js";

const JOB_ID_RE = /^j_\d{8}_[0-9a-f]{6}$/;

/** True iff `value` is a server-generated job id, checked before any fs call. */
export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_RE.test(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `j_<YYYYMMDD>_<6 lowercase hex>` from a local date and a random source.
 * Both arguments are injectable so tests and the resume fixture are stable.
 */
export function newJobId(
  now: Date | number = new Date(),
  random: () => number = Math.random,
): string {
  const date = typeof now === "number" ? new Date(now) : now;
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const raw = Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  const hex = raw.slice(-6).replace(/[^0-9a-f]/g, "0");
  return `j_${ymd}_${hex}`;
}

/** The absolute directory for a job. An invalid id throws before the path exists. */
export function jobDir(vaultDir: string, id: string): string {
  if (!isJobId(id)) {
    throw new Error("invalid job id");
  }
  return join(vaultDir, ".okf", "jobs", id);
}

function jobFile(vaultDir: string, id: string): string {
  return join(jobDir(vaultDir, id), "job.json");
}

export interface CreateJobRecordInput {
  id: string;
  vaultId: string;
  kind: JobKind;
  input: JobInput;
  settings: JobSettings;
  createdAt?: string;
}

/** Build a fresh `queued` record. Writing it is `writeJob`'s job. */
export function createJobRecord(input: CreateJobRecordInput): JobRecord {
  if (!isJobId(input.id)) {
    throw new Error("invalid job id");
  }
  const at = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id,
    vaultId: input.vaultId,
    kind: input.kind,
    status: "queued",
    input: input.input,
    settings: input.settings,
    createdAt: at,
    updatedAt: at,
    progress: { done: 0, total: 0 },
    skipped: [],
    error: null,
    cancelRequested: false,
  };
}

const STAGE_NAMES = [
  "S0",
  "S1",
  "S1w",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "done",
] as const;

const UNIT_STAGE_NAMES = ["S0", "S1", "S1w", "S2", "S3", "S4", "S5", "S6"] as const;

const SKIP_REASONS = [
  "no_captions",
  "blocked",
  "timeout",
  "fetch_error",
  "empty_transcript",
  "capture_invalid",
  "malformed_json",
  "model_timeout",
  "model_error",
  "llm_not_configured",
] as const;

/**
 * The record a reader may use. Unknown keys are preserved, so a record written
 * by a newer build survives a read-modify-write by an older one.
 *
 * `readJob` validates against this schema. The list scan reads loosely and the
 * runner turns an invalid record into a terminal `job_invalid` failure, so a
 * parseable but malformed record can neither reach the UI nor stay queued.
 */
export const JobRecordSchema = z
  .object({
    id: z.string().regex(JOB_ID_RE),
    vaultId: z.string().min(1),
    kind: z.enum(["youtube", "web"]),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    stage: z.enum(STAGE_NAMES).optional(),
    input: z.object({ url: z.string().min(1) }).passthrough(),
    settings: z
      .object({
        maxVideos: z.number().int().min(1),
        filters: z
          .object({
            publishedAfter: z.string().optional(),
            publishedBefore: z.string().optional(),
            minDurationSec: z.number().optional(),
            language: z.string().optional(),
          })
          .passthrough(),
        fetch: z
          .object({
            concurrency: z.number(),
            delayMs: z.number().optional(),
            language: z.string().optional(),
          })
          .passthrough(),
        llm: z
          .object({
            model: z.string(),
            baseUrl: z.string().optional(),
            concurrency: z.number().optional(),
            requestTimeoutMs: z.number().optional(),
            maxRetries: z.number().optional(),
          })
          .passthrough(),
        sweep: z.object({ enabled: z.boolean() }).passthrough().optional(),
        ui: z.object({ theme: z.enum(["system", "light", "dark"]) }).passthrough().optional(),
      })
      .passthrough(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    progress: z.object({ done: z.number(), total: z.number() }).passthrough(),
    skipped: z.array(
      z
        .object({
          slug: z.string(),
          youtubeId: z.string().optional(),
          stage: z.enum(UNIT_STAGE_NAMES),
          reason: z.enum(SKIP_REASONS),
          detail: z.string().optional(),
        })
        .passthrough(),
    ),
    retry: z
      .object({
        units: z.array(
          z
            .object({
              slug: z.string(),
              stage: z.enum(UNIT_STAGE_NAMES),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
    error: z.string().nullable(),
    cancelRequested: z.boolean(),
  })
  .passthrough();

/** Read one job. Throws for a missing, unparseable or malformed record. */
export async function readJob(vaultDir: string, id: string): Promise<JobRecord> {
  const raw = await readFile(jobFile(vaultDir, id), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("job.json is not valid JSON");
  }
  const result = JobRecordSchema.safeParse(parsed);
  if (!result.success) throw new Error("job.json is not a valid job record");
  return result.data as JobRecord;
}

/**
 * Read a record for the boot/listing scan. Only JSON parseability is checked,
 * so one structurally malformed record is still reported to `onError` callers
 * and can be turned into `job_invalid` by the runner. The list route applies
 * `JobRecordSchema` itself, so it never serves an invalid record.
 */
async function readJobLoosely(vaultDir: string, id: string): Promise<JobRecord> {
  const raw = await readFile(jobFile(vaultDir, id), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("job.json is not an object");
  }
  return parsed as JobRecord;
}

/** Persist a job atomically. Creates its directory when absent. */
export async function writeJob(vaultDir: string, job: JobRecord): Promise<void> {
  await mkdir(jobDir(vaultDir, job.id), { recursive: true });
  await writeJsonAtomic(jobFile(vaultDir, job.id), job);
}

/**
 * Read every job record under one vault, newest last.
 *
 * A missing jobs directory is an empty list. One unreadable or unparseable
 * `job.json` is skipped so a single corrupt record cannot stop the scan.
 */
export async function listJobs(
  vaultDir: string,
  onError?: (id: string, error: unknown) => void,
): Promise<JobRecord[]> {
  const base = join(vaultDir, ".okf", "jobs");
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs: JobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isJobId(entry.name)) continue;
    try {
      jobs.push(await readJobLoosely(vaultDir, entry.name));
    } catch (error) {
      // Corrupt or half-written record: skip it, keep scanning.
      onError?.(entry.name, error);
    }
  }
  jobs.sort((a, b) => {
    const t = a.createdAt.localeCompare(b.createdAt);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
  return jobs;
}

/**
 * One append per directory at a time, and the last seq cached after the first
 * read so the common case is a single `appendFile`.
 */
const chains = new Map<string, Promise<unknown>>();
const lastSeq = new Map<string, number>();
const listeners = new Map<string, Set<(event: JobEvent) => void>>();

function serialize<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(dir) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(
    dir,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readLastSeq(dir: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(dir, "events.ndjson"), "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<JobEvent>;
      if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
        return parsed.seq;
      }
    } catch {
      // An unfinished trailing line: keep walking back to the last complete one.
    }
  }
  return 0;
}

/**
 * The fsync seam. A spec replaces `syncFile` to prove the sync completes
 * before any subscriber runs; production always calls `FileHandle.sync`.
 */
export const storeIo = {
  async syncFile(handle: { sync: () => Promise<void> }): Promise<void> {
    await handle.sync();
  },
};

/**
 * Append `{seq, type, data, at}` as one line, fsync it, then notify
 * subscribers. The data is durable before any listener runs, so a crash never
 * leaves a subscriber — or the SSE stream — believing an event is on disk when
 * it is only in the page cache.
 */
export function appendEvent(
  dir: string,
  type: JobEventType,
  data: Record<string, unknown>,
): Promise<JobEvent> {
  return serialize(dir, async () => {
    await mkdir(dir, { recursive: true });
    let seq = lastSeq.get(dir);
    if (seq === undefined) {
      seq = await readLastSeq(dir);
    }
    seq += 1;
    const event: JobEvent = {
      seq,
      type,
      data,
      at: new Date().toISOString(),
    };
    const handle = await open(join(dir, "events.ndjson"), "a");
    try {
      await handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
      await storeIo.syncFile(handle);
    } finally {
      await handle.close();
    }
    lastSeq.set(dir, seq);
    for (const listener of listeners.get(dir) ?? []) {
      try {
        listener(event);
      } catch {
        // A subscriber must never break the durable append path.
      }
    }
    return event;
  });
}

/**
 * Truncate a job's event log for a retry, but keep its high-water `seq`.
 *
 * A client that reconnects with `lastSeq = 0` replays nothing from the prior
 * run (CR-01), while a client whose stream was disconnected across the retry
 * still holds the old run's last `Last-Event-ID`. Event ids must stay
 * monotonic: the first event of the retry is `oldHigh + 1`, so that client
 * receives it and the client-side `seq <= lastSeq` guard never drops the
 * retry's `done` frame.
 */
export function resetJobEvents(dir: string): Promise<void> {
  return serialize(dir, async () => {
    await mkdir(dir, { recursive: true });
    let high = lastSeq.get(dir);
    if (high === undefined) {
      high = await readLastSeq(dir);
    }
    await writeFile(join(dir, "events.ndjson"), "", "utf8");
    lastSeq.set(dir, high);
  });
}

/**
 * Read events with `seq > afterSeq`, ascending. Only an unfinished trailing
 * line (a torn append) is ignored; a malformed line in the middle is corrupt
 * data and raises rather than silently dropping history.
 */
export async function readEvents(dir: string, afterSeq = 0): Promise<JobEvent[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "events.ndjson"), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const hasFragment = text.length > 0 && !text.endsWith("\n");
  const events: JobEvent[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const isTrailingFragment = hasFragment && i === lines.length - 1;
    let parsed: JobEvent;
    try {
      parsed = JSON.parse(line) as JobEvent;
    } catch {
      if (isTrailingFragment) break;
      throw new Error("events.ndjson contains a corrupt line");
    }
    if (isTrailingFragment) break;
    if (typeof parsed.seq !== "number") {
      throw new Error("events.ndjson contains a corrupt line");
    }
    if (parsed.seq > afterSeq) events.push(parsed);
  }
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

/** Subscribe to events for one job directory. Returns an unsubscribe function. */
export function onEventAppended(
  dir: string,
  listener: (event: JobEvent) => void,
): () => void {
  let set = listeners.get(dir);
  if (!set) {
    set = new Set();
    listeners.set(dir, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/**
 * Run `fn` under the per-job directory lock. Every read-modify-write of
 * `job.json` goes through here: a cancel and a runner persist can then never
 * interleave (read A, read B, write B, write A) and silently drop a flag.
 * The same chain serializes event appends for the directory.
 */
export function withJobLock<T>(
  vaultDir: string,
  id: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return serialize(jobDir(vaultDir, id), () => Promise.resolve(fn()));
}

/** Set the cancel flag atomically. The runner reads it between units. */
export async function requestCancel(vaultDir: string, id: string): Promise<JobRecord> {
  return withJobLock(vaultDir, id, async () => {
    const job = await readJob(vaultDir, id);
    job.cancelRequested = true;
    job.updatedAt = new Date().toISOString();
    await writeJob(vaultDir, job);
    return job;
  });
}
