/**
 * Boot resume (PIPE-11).
 *
 * The process holds one queue. On boot it scans every registered vault's
 * `.okf/jobs/<jobId>/job.json`, re-enqueues `queued` and `running` jobs in
 * `createdAt` order, and ignores completed/failed/cancelled jobs. One corrupt
 * record is logged and skipped so it can never stop the scan — or the server.
 */
import pino from "pino";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import {
  createDefaultStageDeps,
  createJobQueue,
  type JobQueue,
  type StageDeps,
} from "./runner.js";
import { listJobs } from "./store.js";
import type { JobRecord } from "./types.js";

const log = pino({ name: "jobs" });

let queue: JobQueue | null = null;

/** Install the process-wide queue. `index.ts` calls this before `serve`. */
export function configureJobQueue(deps: StageDeps = createDefaultStageDeps()): JobQueue {
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
