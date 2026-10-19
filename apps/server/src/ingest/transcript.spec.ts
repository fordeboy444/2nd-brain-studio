import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UnitContext } from "../jobs/runner.js";
import type { VideoCandidate } from "../jobs/types.js";
import { createTranscriptCascade, type PythonRun } from "./transcript.js";
import type { YtDlpRun } from "./ytdlp.js";

const CANDIDATE: VideoCandidate = {
  youtubeId: "abcdefghijk",
  title: "A Talk",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
};

const KEY = "supadata-test-key-do-not-log";

function ctx(overrides: Partial<UnitContext> = {}): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: "job-1",
    vaultDir: "/tmp/vault",
    now: () => Date.parse("2026-10-18T10:00:00.000Z"),
    ...overrides,
  };
}

const JSON3 = {
  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "tier one" }] }],
};

/** Tier 1 succeeds: write a json3 file where the --output template points. */
const tierOneWrites: YtDlpRun = async (args) => {
  const template = args[args.indexOf("--output") + 1];
  if (template === undefined) throw new Error("argv carries no --output");
  await writeFile(join(dirname(template), "abcdefghijk.json3"), JSON.stringify(JSON3));
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
};

/** Tier 1 has no captions: exit 0 but no subtitle file. */
const tierOneMissing: YtDlpRun = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  isCanceled: false,
});

function pythonReturning(stdout: string, exitCode = 0): {
  run: PythonRun;
  calls: Array<{ argv: readonly string[]; opts: Parameters<PythonRun>[1] }>;
} {
  const calls: Array<{ argv: readonly string[]; opts: Parameters<PythonRun>[1] }> = [];
  const run: PythonRun = async (argv, opts) => {
    calls.push({ argv, opts });
    return { exitCode, stdout, stderr: exitCode === 0 ? "" : "ERROR: no transcript", timedOut: false };
  };
  return { run, calls };
}

const NEVER_PYTHON: PythonRun = async () => {
  throw new Error("tier 2 must not run");
};

function fetchReturning(body: unknown): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("tier ordering", () => {
  it("stops at tier 1 and never constructs python or the HTTP client", async () => {
    const http = fetchReturning({ content: [] });
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneWrites,
      runPython: NEVER_PYTHON,
      fetch: http.fetch,
      supadataKey: KEY,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    expect(result).toEqual({
      ok: true,
      tier: 1,
      segments: [{ startSec: 0, text: "tier one" }],
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe("tier 2 (youtube-transcript-api)", () => {
  it("runs the exact argv-only command with a 60 s timeout", async () => {
    const python = pythonReturning(
      JSON.stringify([
        { text: " hello ", start: 1.9, duration: 2 },
        { text: "there", start: 2, duration: 1 },
      ]),
    );
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: python.run,
      supadataKey: null,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    expect(python.calls).toHaveLength(1);
    expect(python.calls[0]!.argv).toEqual([
      "-I",
      "-m",
      "youtube_transcript_api",
      "abcdefghijk",
      "--languages",
      "en",
      "--format",
      "json",
    ]);
    expect(python.calls[0]!.opts.timeoutMs).toBe(60_000);
    expect(python.calls[0]!.opts.maxBufferBytes).toBe(16 * 1024 * 1024);
    expect(result).toEqual({
      ok: true,
      tier: 2,
      segments: [
        { startSec: 1, text: "hello" },
        { startSec: 2, text: "there" },
      ],
    });
  });

  it("rejects a malformed array instead of partially parsing it", async () => {
    const python = pythonReturning(
      JSON.stringify([{ text: "x", start: "not-a-number", duration: 1 }]),
    );
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: python.run,
      supadataKey: null,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());
    expect(result).toEqual({
      ok: false,
      reason: "fetch_error",
      detail: expect.stringContaining("invalid tier-2 json"),
    });
  });

  it("reports the channel block instead of the synthetic key-absent error", async () => {
    const blocked: YtDlpRun = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Sign in to confirm you're not a bot",
      timedOut: false,
      isCanceled: false,
    });
    const blockedPython: PythonRun = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Sign in to confirm you're not a bot",
      timedOut: false,
    });
    const cascade = createTranscriptCascade({
      runYtDlp: blocked,
      runPython: blockedPython,
      supadataKey: null,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect((result as { detail?: string }).detail).toContain("supadata key absent");
  });

  it("refuses to invoke python for an id that is not 11 characters", async () => {
    const python = pythonReturning("[]");
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: python.run,
      supadataKey: null,
    });

    const result = await cascade.fetch(
      { ...CANDIDATE, youtubeId: "$(rm -rf /)" },
      ctx(),
    );

    expect(python.calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, reason: "fetch_error" });
  });
});

describe("tier 3 (Supadata)", () => {
  it("is never constructed without a key", async () => {
    const http = fetchReturning({ content: [] });
    const python = pythonReturning("[]", 1);
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: python.run,
      fetch: http.fetch,
      supadataKey: null,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    expect(http.calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false });
  });

  it("sends the key only in x-api-key and converts millisecond offsets", async () => {
    const http = fetchReturning({
      content: [
        { text: "fallback hello", offset: 1500, duration: 2000 },
        { text: "  ", offset: 4000, duration: 1000 },
        { text: "world", offset: 5000, duration: 1000 },
      ],
    });
    const python = pythonReturning("[]", 1);
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: python.run,
      fetch: http.fetch,
      supadataKey: KEY,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(
      "https://api.supadata.ai/v1/youtube/transcript?videoId=abcdefghijk&lang=en",
    );
    expect(http.calls[0]!.init?.headers).toEqual({ "x-api-key": KEY });
    expect(http.calls[0]!.url).not.toContain(KEY);
    expect(JSON.stringify(http.calls[0]!.init?.body ?? "")).not.toContain(KEY);
    expect(result).toEqual({
      ok: true,
      tier: 3,
      segments: [
        { startSec: 1, text: "fallback hello" },
        { startSec: 5, text: "world" },
      ],
    });
  });

  it("keeps no_captions when the Supadata call returns a generic error", async () => {
    const fetch = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof globalThis.fetch;
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      // An empty array exits 0 but yields no segments: empty_transcript.
      runPython: pythonReturning("[]").run,
      fetch,
      supadataKey: KEY,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());

    // The tier-3 generic error ranks below the actionable earlier reasons.
    expect(result).toMatchObject({ ok: false, reason: "empty_transcript" });
    expect((result as { detail?: string }).detail).toContain("tier1=no_captions");
    expect((result as { detail?: string }).detail).toContain("tier3=fetch_error");
  });

  it("maps an abort to timeout", async () => {
    const timeout = new Error("The operation was aborted");
    timeout.name = "TimeoutError";
    const fetch = (async () => {
      throw timeout;
    }) as unknown as typeof globalThis.fetch;
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: pythonReturning("[]", 1).run,
      fetch,
      supadataKey: KEY,
    });

    const result = await cascade.fetch(CANDIDATE, ctx());
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("probe cache", () => {
  it("serves the first fetch from the probe without another adapter call", async () => {
    const run = vi.fn(tierOneWrites);
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: NEVER_PYTHON,
      supadataKey: null,
    });

    const probed = await cascade.probe(CANDIDATE, ctx());
    const fetched = await cascade.fetch(CANDIDATE, ctx());

    expect(probed).toEqual(fetched);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keys the probe by language, so a different language is fetched again", async () => {
    const langs: string[] = [];
    const run: YtDlpRun = async (args) => {
      const language = args[args.indexOf("--sub-langs") + 1] ?? "?";
      langs.push(language);
      const template = args[args.indexOf("--output") + 1];
      if (template === undefined) throw new Error("argv carries no --output");
      await writeFile(
        join(dirname(template), "abcdefghijk.json3"),
        JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: language }] }] }),
      );
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
    };
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: NEVER_PYTHON,
      supadataKey: null,
    });

    const english = await cascade.probe(CANDIDATE, ctx({ language: "en" }));
    const german = await cascade.fetch(CANDIDATE, ctx({ language: "de" }));

    expect(english).toMatchObject({ ok: true, segments: [{ text: "en" }] });
    expect(german).toMatchObject({ ok: true, segments: [{ text: "de" }] });
    expect(langs).toEqual(["en", "de"]);
  });

  it("does not cache a probe failure", async () => {
    const run = vi.fn(tierOneMissing);
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: pythonReturning("[]", 1).run,
      supadataKey: null,
    });

    await cascade.probe(CANDIDATE, ctx());
    await cascade.fetch(CANDIDATE, ctx());

    expect(run).toHaveBeenCalledTimes(2);
  });
});
