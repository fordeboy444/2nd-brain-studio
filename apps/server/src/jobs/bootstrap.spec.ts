import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIngestStageDeps } from "./bootstrap.js";
import { runJob, type StageDeps } from "./runner.js";
import { createJobRecord, newJobId, readJob, writeJob } from "./store.js";
import type { JobSettings, VideoCandidate } from "./types.js";

const SETTINGS: JobSettings = {
  maxVideos: 1,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

const CANDIDATE: VideoCandidate = {
  youtubeId: "abcdefghijk",
  title: "First Talk",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  published: "2026-01-01",
  durationSec: 600,
  language: "en",
};

const FIELDS = [
  "enumerate",
  "preflight",
  "fetchTranscript",
  "fetchWeb",
  "classifyVideoError",
  "classifyWebError",
  "cookiePath",
  "now",
] as const;

const runWritesJson3 = vi.fn(async (args: readonly string[]) => {
  const template = args[args.indexOf("--output") + 1];
  if (template === undefined) throw new Error("argv carries no --output");
  await writeFile(
    join(dirname(template), "abcdefghijk.json3"),
    JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "from tier one" }] }],
    }),
  );
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
});

const http = vi.fn(async () => {
  throw new Error("tier 3 must not be constructed without a key");
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bootstrap-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
  runWritesJson3.mockClear();
  http.mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createIngestStageDeps", () => {
  it("exposes the eight flat fields as functions and no nested youtube object", () => {
    const deps = createIngestStageDeps({
      runYtDlp: runWritesJson3,
      fetch: http as unknown as typeof globalThis.fetch,
      supadataKey: null,
    });

    for (const field of FIELDS) {
      expect(typeof deps[field], field).toBe("function");
    }
    expect("youtube" in deps).toBe(false);
  });

  it("returns a zero-unit S0 for a web URL without enumerating a channel", async () => {
    const deps = createIngestStageDeps({ supadataKey: null });

    const candidates = await deps.enumerate("https://example.com/post", {
      maxVideos: 1,
      maxScan: 5,
    });

    expect(candidates).toEqual([]);
  });

  it("completes one S0 + S1 job with one raw file and one preflight fetch", async () => {
    const factory = createIngestStageDeps({
      runYtDlp: runWritesJson3,
      fetch: http as unknown as typeof globalThis.fetch,
      supadataKey: null,
    });
    // S0's real enumerator is not injectable here; this spec owns the
    // factory-to-runner boundary, not enumeration (03-03 covers that).
    const deps: StageDeps = {
      ...factory,
      llm: {
        async chat() {
          return {
            text: JSON.stringify({
              slug: "first-talk",
              title: "First Talk",
              thesis: "A thesis.",
              summary: "A summary.",
              tags: [],
              concepts: [],
              entities: [],
              quotes: [],
              relations: [],
            }),
            tokensIn: 1,
            tokensOut: 1,
          };
        },
      },
      cacheDirFor: () => join(root, ".okf", "cache", "llm"),
      async enumerate() {
        return [CANDIDATE];
      },
      vaultDirFor: () => root,
    };

    const job = createJobRecord({
      id: newJobId(new Date(2026, 9, 18), () => 0.5),
      vaultId: "vault",
      kind: "youtube",
      input: { url: "https://www.youtube.com/@channel" },
      settings: SETTINGS,
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    const rawFiles = (await readdir(join(root, "raw"))).filter(
      (name) => name !== "index.md",
    );
    expect(rawFiles).toEqual(["first-talk.md"]);
    expect(runWritesJson3).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.skipped).toEqual([]);
  });
});
