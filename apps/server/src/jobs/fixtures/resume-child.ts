/**
 * A real child process for the SIGKILL resume proof (PIPE-11).
 *
 * The process reads the job from disk, runs the real `runJob` with a fake video
 * adapter, and behaves differently by `RESUME_MODE`:
 *
 * - `hang`: candidate 2's adapter prints `CAPTURE_WRITTEN` and then never
 *   resolves, so the spec can kill the process after candidate 1's capture has
 *   been renamed into place.
 * - `resume`: candidate 2's adapter returns normally; candidate 1's matching
 *   capture must be skipped without calling the adapter.
 *
 * Only candidate 2's adapter ever prints, and only in `hang` mode.
 *
 * The LLM stub throws if called and reports its invocation count with a
 * synchronous write on exit, so `SIGKILL` (which skips `exit`) never reports a
 * misleading zero for the child that was killed.
 */
import { writeSync } from "node:fs";
import { runJob, slugForCandidate, type StageDeps } from "../runner.js";
import { readJob } from "../store.js";
import type { VideoCandidate } from "../types.js";

const vault = process.env.RESUME_VAULT;
const jobId = process.env.RESUME_JOB;
const mode = process.env.RESUME_MODE ?? "resume";

if (vault === undefined || jobId === undefined) {
  process.stderr.write("RESUME_VAULT and RESUME_JOB are required\n");
  process.exit(2);
}

const candidates: VideoCandidate[] = [
  {
    youtubeId: "vid_first_01",
    title: "First Candidate",
    url: "https://youtu.be/vid_first_01",
  },
  {
    youtubeId: "vid_second_2",
    title: "Second Candidate",
    url: "https://youtu.be/vid_second_2",
  },
];

let llmCalls = 0;
const llm = {
  async call(): Promise<never> {
    llmCalls += 1;
    throw new Error("never called");
  },
};

process.on("exit", () => {
  // Synchronous write: a piped stdout write queued from `exit` can be lost.
  writeSync(1, `llm_calls=${llmCalls}\n`);
});

const deps: StageDeps = {
  async enumerate() {
    return candidates;
  },
  async fetchTranscript(candidate) {
    const segments = [
      { startSec: 0, text: `${candidate.youtubeId} says hello` },
      { startSec: 30, text: "and goodbye" },
    ];
    if (candidate.youtubeId === "vid_second_2" && mode === "hang") {
      // Candidate 1's capture rename already returned before this adapter ran.
      writeSync(1, "CAPTURE_WRITTEN\n");
      // The timer keeps the event loop alive: a pending promise alone does not,
      // and the child would exit on its own before the spec could SIGKILL it.
      setInterval(() => undefined, 1000);
      await new Promise<never>(() => {
        // Deliberately never resolves; the spec sends SIGKILL.
      });
    }
    return {
      kind: "video",
      slug: slugForCandidate(candidate),
      url: candidate.url,
      youtubeId: candidate.youtubeId,
      title: candidate.title,
      tier: 1 as const,
      fetchedAt: new Date().toISOString(),
      segments,
    };
  },
  async fetchWeb() {
    throw new Error("web adapter is not used by the resume fixture");
  },
  async preflight() {
    // No network in the fixture.
  },
  cookiePath: () => undefined,
  classifyVideoError: () => "fetch_error",
  classifyWebError: () => "fetch_error",
  now: () => Date.now(),
  vaultDirFor: () => vault,
  llm,
};

const job = await readJob(vault, jobId);
await runJob(job, deps);
writeSync(1, "JOB_COMPLETE\n");
