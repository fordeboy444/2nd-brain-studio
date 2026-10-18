import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRecord, newJobId, writeJob } from "../jobs/store.js";
import { runJob, type StageDeps } from "../jobs/runner.js";
import { readJob } from "../jobs/store.js";
import type { JobSettings, VideoCandidate } from "../jobs/types.js";
import {
  EnumerateError,
  enumerateChannel,
  parseDuration,
  parseYtDlpLine,
  type RunOptions,
  type RunResult,
} from "./enumerate.js";

const SETTINGS: JobSettings = {
  maxVideos: 5,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

function line(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    title: `Video ${id}`,
    url: `https://youtu.be/${id}`,
    upload_date: "20260101",
    duration: 600,
    ...extra,
  });
}

function fixtureRunner(stdout: string, overrides: Partial<RunResult> = {}) {
  const calls: Array<{ argv: string[]; opts: RunOptions }> = [];
  const run = async (argv: readonly string[], opts: RunOptions): Promise<RunResult> => {
    calls.push({ argv: [...argv], opts });
    return { stdout, stderr: "", exitCode: 0, ...overrides };
  };
  return { run, calls };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "enumerate-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("enumerateChannel (INGEST-02)", () => {
  it("passes one bounded argv array for maxVideos 20 and no shell", async () => {
    const { run, calls } = fixtureRunner("");
    await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      { maxVideos: 20 },
      { run },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      "--flat-playlist",
      "--dump-json",
      "--playlist-end",
      "100",
      "https://www.youtube.com/@x/videos",
    ]);
    expect(calls[0]?.opts.shell).toBe(false);
    expect(calls[0]?.opts.timeoutMs).toBe(120_000);
    expect(calls[0]?.opts.maxBufferBytes).toBe(64 * 1024 * 1024);
  });

  it("parses 7 valid lines from 2 malformed and 1 duplicate, keeping first-seen order", async () => {
    const ids = ["a1", "b2", "c3", "d4", "e5", "f6", "g7"];
    const stdout = [
      ...ids.map((id) => line(id)),
      "not json at all",
      JSON.stringify({ title: "missing id" }),
      line("a1", { title: "Duplicate" }),
      "",
    ].join("\n");
    const { run } = fixtureRunner(stdout);

    const result = await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      { maxVideos: 20 },
      { run },
    );

    expect(result.candidates.map((candidate) => candidate.youtubeId)).toEqual(ids);
    expect(result.candidates[0]?.title).toBe("Video a1");
    expect(result.foundAtLeast).toBe(false);
  });

  it("reports foundAtLeast at the cap and not below it", async () => {
    const hundred = fixtureRunner(
      Array.from({ length: 100 }, (_, i) => line(`v${String(i).padStart(3, "0")}`)).join("\n"),
    );
    const capped = await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      { maxVideos: 20 },
      { run: hundred.run },
    );
    expect(hundred.calls[0]?.argv[3]).toBe("100");
    expect(capped.candidates).toHaveLength(100);
    expect(capped.foundAtLeast).toBe(true);

    const three = fixtureRunner([line("a"), line("b"), line("c")].join("\n"));
    const short = await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      { maxVideos: 20 },
      { run: three.run },
    );
    expect(short.candidates).toHaveLength(3);
    expect(short.foundAtLeast).toBe(false);
  });

  it("treats empty stdout as a successful empty list", async () => {
    const { run } = fixtureRunner("");
    const result = await enumerateChannel("https://www.youtube.com/@x/videos", {}, { run });
    expect(result).toEqual({ candidates: [], foundAtLeast: false });
  });

  it("maps a non-zero exit to enumerate_failed with the stderr tail", async () => {
    const { run } = fixtureRunner("", {
      exitCode: 2,
      stderr: `ERROR: ${"x".repeat(700)}network denied`,
    });
    const error = await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      {},
      { run },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnumerateError);
    expect((error as EnumerateError).code).toBe("enumerate_failed");
    expect((error as EnumerateError).detail).toHaveLength(500);
    expect((error as EnumerateError).detail?.endsWith("network denied")).toBe(true);
  });

  it("maps a watchdog kill to timeout", async () => {
    const { run } = fixtureRunner("", { exitCode: null, timedOut: true });
    const error = await enumerateChannel(
      "https://www.youtube.com/@x/videos",
      {},
      { run },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnumerateError);
    expect((error as EnumerateError).code).toBe("timeout");
  });
});

describe("parseYtDlpLine", () => {
  it("maps upload_date, duration strings and webpage_url", () => {
    const candidate = parseYtDlpLine(
      JSON.stringify({
        id: "abc",
        title: "A talk",
        webpage_url: "https://www.youtube.com/watch?v=abc",
        url: "https://youtu.be/abc",
        upload_date: "20260817",
        duration: "1:02:03",
      }),
    );
    expect(candidate).toMatchObject({
      youtubeId: "abc",
      title: "A talk",
      url: "https://www.youtube.com/watch?v=abc",
      published: "2026-08-17",
      durationSec: 3723,
    });
  });

  it("parses MM:SS and integer durations, and leaves absent metadata undefined", () => {
    expect(parseDuration("2:03")).toBe(123);
    expect(parseDuration("600")).toBe(600);
    expect(parseDuration(600.9)).toBe(600);
    expect(parseDuration("bad")).toBeUndefined();

    const candidate = parseYtDlpLine(
      JSON.stringify({ id: "bare", title: "Bare", url: "https://youtu.be/bare" }),
    );
    expect(candidate).toEqual({
      youtubeId: "bare",
      title: "Bare",
      url: "https://youtu.be/bare",
    });
    expect(candidate?.published).toBeUndefined();
    expect(candidate?.durationSec).toBeUndefined();
  });

  it("returns null for blank, malformed and id-less lines", () => {
    expect(parseYtDlpLine("")).toBeNull();
    expect(parseYtDlpLine("   ")).toBeNull();
    expect(parseYtDlpLine("{oops")).toBeNull();
    expect(parseYtDlpLine(JSON.stringify({ title: "no id" }))).toBeNull();
  });
});

describe("S0 through the real runner", () => {
  it("writes 01-enumerate.json and completes the job", async () => {
    const stdout = [
      line("vid1", { title: "First Talk" }),
      line("vid2", { title: "Second Talk", duration: "2:03" }),
    ].join("\n");
    const { run } = fixtureRunner(stdout);

    const candidates: VideoCandidate[] = [];
    const deps: StageDeps = {
      async enumerate(url, opts, signal) {
        const result = await enumerateChannel(url, { ...opts, signal }, { run });
        candidates.push(...result.candidates);
        return result.candidates;
      },
      async fetchTranscript() {
        return { tier: 1 as const, segments: [{ startSec: 0, text: "hello" }] };
      },
      async fetchWeb() {
        throw new Error("not a web job");
      },
      async preflight() {
        // no-op
      },
      cookiePath: () => undefined,
      classifyVideoError: () => "fetch_error",
      classifyWebError: () => "fetch_error",
      now: () => Date.parse("2026-10-18T10:00:00.000Z"),
      vaultDirFor: () => root,
    };

    const job = createJobRecord({
      id: newJobId(new Date(2026, 9, 18), () => 0.5),
      vaultId: "vault",
      kind: "youtube",
      input: { url: "https://www.youtube.com/@x/videos" },
      settings: SETTINGS,
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    await writeJob(root, job);
    await runJob(job, deps);

    const artifact = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "01-enumerate.json"), "utf8"),
    ) as { candidates: VideoCandidate[]; count: number };
    expect(artifact.count).toBe(2);
    expect(artifact.candidates.map((candidate) => candidate.youtubeId)).toEqual([
      "vid1",
      "vid2",
    ]);
    expect(artifact.candidates[1]?.durationSec).toBe(123);
    expect(candidates).toHaveLength(2);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.stage).toBe("done");
  });
});
