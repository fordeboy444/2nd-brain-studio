/**
 * Boot resume (PIPE-11).
 *
 * The process holds one queue. On boot it scans every registered vault's
 * `.okf/jobs/<jobId>/job.json`, re-enqueues `queued` and `running` jobs in
 * `createdAt` order, and ignores completed/failed/cancelled jobs. One corrupt
 * record is logged and skipped so it can never stop the scan — or the server.
 */
import { existsSync } from "node:fs";
import pino from "pino";
import { config } from "../config.js";
import { enumerateChannel } from "../ingest/enumerate.js";
import { probeFirstCandidate } from "../ingest/preflight.js";
import type { LookupFn } from "../ingest/ssrf.js";
import {
  createTranscriptCascade,
  type PythonRun,
} from "../ingest/transcript.js";
import { classifyYtDlpError, type YtDlpRun } from "../ingest/ytdlp.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import {
  createDefaultStageDeps,
  createJobQueue,
  type JobQueue,
  type StageDeps,
} from "./runner.js";
import { createTranscriptFetcher } from "./stages/fetch.js";
import { classifyWebError, createWebFetcher } from "./stages/web.js";
import { listJobs } from "./store.js";
import type { JobRecord, SkipReason } from "./types.js";

const log = pino({ name: "jobs" });

let queue: JobQueue | null = null;

/** Test seams: the factory never reaches a real subprocess or network in a spec. */
export interface IngestDeps {
  runYtDlp?: YtDlpRun;
  runPython?: PythonRun;
  fetch?: typeof globalThis.fetch;
  /** DNS seam for the S1w guard, so a spec never resolves a real host. */
  lookup?: LookupFn;
  /** `null` disables tier 3 even when the environment carries a key. */
  supadataKey?: string | null;
}

/** Map an untagged adapter error through the subprocess classifier. */
function classifyVideoFailure(error: unknown): SkipReason {
  const record = error as { stderr?: unknown; exitCode?: unknown } | null;
  const stderr =
    typeof record?.stderr === "string"
      ? record.stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const exitCode = typeof record?.exitCode === "number" ? record.exitCode : null;
  return classifyYtDlpError(stderr, exitCode);
}

/**
 * The Phase 3 dependency set: the real S0 enumerator and the three-tier S1
 * transcript cascade. The runner reads flat fields, so the wiring is one flat
 * function per dependency.
 *
 * `signal` is passed inside the options object `enumerateChannel`
 * destructures; passing it as a third argument would drop S0 cancellation.
 *
 * The cascade's probe cache is what makes the first video cost one fetch:
 * `preflight` probes and caches, the first unit's `fetch` consumes that entry.
 */
export function createIngestStageDeps(overrides: IngestDeps = {}): StageDeps {
  const base = createDefaultStageDeps();
  const cascade = createTranscriptCascade({
    runYtDlp: overrides.runYtDlp,
    runPython: overrides.runPython,
    fetch: overrides.fetch,
    supadataKey:
      "supadataKey" in overrides ? overrides.supadataKey : config.supadataApiKey,
  });

  return {
    ...base,
    fetchTranscript: createTranscriptFetcher(cascade),
    fetchWeb: createWebFetcher({
      fetch: overrides.fetch,
      lookup: overrides.lookup,
    }),
    async preflight(candidates, ctx) {
      await probeFirstCandidate(candidates, cascade, ctx);
    },
    async enumerate(url, opts, signal) {
      const { candidates } = await enumerateChannel(url, { ...opts, signal });
      return candidates;
    },
    classifyVideoError: classifyVideoFailure,
    classifyWebError,
    cookiePath() {
      const path = config.youtubeCookiePath;
      return existsSync(path) ? path : undefined;
    },
    now: () => Date.now(),
  };
}

/** Install the process-wide queue. `index.ts` calls this before `serve`. */
export function configureJobQueue(deps: StageDeps = createIngestStageDeps()): JobQueue {
  queue = createJobQueue(deps);
  return queue;
}

export function getJobQueue(): JobQueue {
  if (queue === null) {
    throw new Error("job queue is not configured; call configureJobQueue first");
  }
  return queue;
}

/**
 * Re-enqueue every interrupted job, oldest first. Returns the enqueued ids in
 * order so boot can log and a test can assert the order. The enqueue itself is
 * fire-and-forget: the queue runs the job, boot does not wait for it.
 */
export async function resumeJobs(): Promise<string[]> {
  const active = getJobQueue();
  const registry = await readRegistry();
  const found: JobRecord[] = [];

  for (const vault of registry.vaults) {
    const vaultDir = vaultDirPath(vault.id);
    let jobs: JobRecord[];
    try {
      jobs = await listJobs(vaultDir, (id, error) => {
        log.warn(
          { vaultId: vault.id, jobId: id, reason: error instanceof Error ? error.message : String(error) },
          "job_record_unreadable",
        );
      });
    } catch (error) {
      log.warn(
        { vaultId: vault.id, reason: error instanceof Error ? error.message : String(error) },
        "job_scan_failed",
      );
      continue;
    }
    for (const job of jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      found.push(job);
    }
  }

  found.sort((a, b) => {
    const t = a.createdAt.localeCompare(b.createdAt);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  const ids: string[] = [];
  for (const job of found) {
    log.info({ jobId: job.id, status: job.status }, "job_resumed");
    active.enqueue(job);
    ids.push(job.id);
  }
  return ids;
}
