import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobRecord, newJobId, readJob, writeJob } from "./store.js";
import type { JobSettings } from "./types.js";

/**
 * A SIGKILL mid-S1, then a fresh process: the job must complete with exactly
 * one capture per unit and zero LLM calls. The child is a real `node --import
 * tsx` process running the real `runJob`; nothing about the resume path is
 * test-only.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(MODULE_DIR, "../..");
const CHILD_PATH = join(MODULE_DIR, "fixtures", "resume-child.ts");

const SETTINGS: JobSettings = {
  maxVideos: 10,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

interface Child {
  process: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function runChild(vault: string, jobId: string, mode: "hang" | "resume"): Child {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD_PATH], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      RESUME_VAULT: vault,
      RESUME_JOB: jobId,
      RESUME_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  return { process: child, stdout: () => out, stderr: () => err, exited };
}

function waitFor(child: Child, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (child.stdout().includes(text)) {
        clearInterval(timer);
        resolveWait();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `timed out waiting for ${text}; stdout=${JSON.stringify(child.stdout())} stderr=${JSON.stringify(child.stderr())}`,
          ),
        );
      }
    }, 20);
  });
}

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "resume-spec-"));
  await mkdir(join(vault, "raw"), { recursive: true });
  await mkdir(join(vault, ".okf", "jobs"), { recursive: true });
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe("stage-granular resume (PIPE-11)", () => {
  it("resumes after SIGKILL", { timeout: 30_000 }, async () => {
    const id = newJobId(new Date(2026, 9, 18), () => 0.654321);
    const job = createJobRecord({
      id,
      vaultId: "fixture",
      kind: "youtube",
      input: { url: "https://www.youtube.com/@fixture" },
      settings: SETTINGS,
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    await writeJob(vault, job);

    const first = runChild(vault, id, "hang");
    await waitFor(first, "CAPTURE_WRITTEN", 20_000);

    // The line comes from candidate 2's adapter, so candidate 1's capture
    // rename has already completed.
    first.process.kill("SIGKILL");
    const firstExit = await first.exited;
    expect(firstExit.signal).toBe("SIGKILL");

    const killed = await readJob(vault, id);
    expect(killed.status).toBe("running");
    expect(killed.stage).toBe("S1");
    expect(await readdir(join(vault, "raw"))).toEqual(["first-candidate.md"]);

    const second = runChild(vault, id, "resume");
    const secondExit = await second.exited;
    expect(secondExit.code).toBe(0);

    const finished = await readJob(vault, id);
    expect(finished.status).toBe("completed");
    expect(finished.stage).toBe("done");
    expect(finished.skipped).toEqual([]);

    const raw = (await readdir(join(vault, "raw")))
      .filter((name) => name !== "index.md")
      .sort();
    expect(raw).toEqual(["first-candidate.md", "second-candidate.md"]);

    // S2 runs after S1 and makes one call per captured slug; no cache exists
    // because the killed run never reached S2.
    expect(second.stdout()).toContain("llm_calls=2");
    // Candidate 1's adapter is not called again: the matching capture skipped it.
    expect(second.stdout()).not.toContain("CAPTURE_WRITTEN");
    expect(second.stdout()).toContain("JOB_COMPLETE");

    // No temp artifact survives in the job directory. S3 adds its two
    // documents, and makes no call because these extractions carry no labels.
    const jobFiles = await readdir(join(vault, ".okf", "jobs", id));
    expect(jobFiles.sort()).toEqual([
      "01-enumerate.json",
      "events.ndjson",
      "extractions",
      "job.json",
      "lint-report.json",
      "manifest.json",
      "taxonomy.json",
    ]);
    expect(jobFiles.some((name) => name.includes(".tmp-"))).toBe(false);
  });
});
