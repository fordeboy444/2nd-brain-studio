import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRecord, newJobId, writeJob } from "../jobs/store.js";
import {
  createDefaultStageDeps,
  runJob,
  type StageDeps,
  type UnitContext,
} from "../jobs/runner.js";
import { createTranscriptFetcher } from "../jobs/stages/fetch.js";
import type { JobSettings, VideoCandidate } from "../jobs/types.js";
import {
  classifyYtDlpError,
  fetchJson3Transcript,
  parseJson3,
  runYtDlp,
  type YtDlpRun,
} from "./ytdlp.js";
import { runPythonTranscript } from "./transcript.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const SETTINGS: JobSettings = {
  maxVideos: 1,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

const FIXED_NOW = Date.parse("2026-10-18T10:00:00.000Z");

const CANDIDATE: VideoCandidate = {
  youtubeId: "abc123",
  title: "First Talk",
  url: "https://www.youtube.com/watch?v=abc123",
  published: "2026-01-01",
  durationSec: 600,
  language: "en",
};

/** Five events: one duplicate, one empty and one multi-fragment. */
const JSON3_FIXTURE = {
  events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Hello" }] },
    { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Hello" }] },
    { tStartMs: 1999, dDurationMs: 1000, segs: [{ utf8: "world " }, { utf8: "now" }] },
    { tStartMs: 65_500, dDurationMs: 500, segs: [{ utf8: "   " }] },
    { tStartMs: 66_000, dDurationMs: 1000, segs: [{ utf8: "last" }] },
  ],
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytdlp-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
  execaMock.mockReset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fake runner that writes a json3 file into the `--output` directory. */
function writingRun(
  fixture: unknown,
  onCall?: (args: readonly string[]) => void,
): YtDlpRun {
  return async (args) => {
    onCall?.(args);
    const outputAt = args.indexOf("--output");
    const template = args[outputAt + 1];
    if (template === undefined) throw new Error("argv carries no --output");
    await writeFile(join(dirname(template), "abc123.json3"), JSON.stringify(fixture));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
  };
}

/** A fake runner that succeeds but writes no subtitle file. */
function emptyRun(): YtDlpRun {
  return async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    isCanceled: false,
  });
}

describe("runYtDlp", () => {
  it("runs an argv array with shell:false, reject:false, the 120 s timeout and the 64 MiB cap", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      isCanceled: false,
    });

    const result = await runYtDlp(["--version"]);

    expect(execaMock).toHaveBeenCalledWith(
      "yt-dlp",
      ["--version"],
      expect.objectContaining({
        shell: false,
        reject: false,
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      isCanceled: false,
    });
  });

  it("passes the caller signal as cancelSignal, because execa 10 rejects a signal option", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      isCanceled: false,
    });
    const controller = new AbortController();

    await runYtDlp(["--version"], { signal: controller.signal });

    const options = execaMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(options.cancelSignal).toBe(controller.signal);
    expect(options.signal).toBeUndefined();
  });
});

describe("runPythonTranscript", () => {
  it("passes the caller signal as cancelSignal too", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      isCanceled: false,
    });
    const controller = new AbortController();

    await runPythonTranscript(["-I", "-m", "youtube_transcript_api"], {
      timeoutMs: 60_000,
      maxBufferBytes: 1024,
      signal: controller.signal,
    });

    const options = execaMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(options.cancelSignal).toBe(controller.signal);
    expect(options.signal).toBeUndefined();
  });
});

describe("parseJson3", () => {
  it("joins fragments, floors milliseconds to whole seconds and collapses consecutive duplicates", () => {
    expect(parseJson3(JSON3_FIXTURE)).toEqual([
      { startSec: 0, text: "Hello" },
      { startSec: 1, text: "world now" },
      { startSec: 66, text: "last" },
    ]);
  });

  it("returns no segments for a document that does not match the shape", () => {
    expect(parseJson3(null)).toEqual([]);
    expect(parseJson3({})).toEqual([]);
    expect(parseJson3({ events: "not-an-array" })).toEqual([]);
    expect(
      parseJson3({ events: [{ tStartMs: "zero", segs: [{ utf8: "x" }] }] }),
    ).toEqual([]);
  });
});

describe("fetchJson3Transcript", () => {
  it("captures the exact tier-1 argv and passes no --cookies element when the path is absent", async () => {
    const calls: string[][] = [];
    const result = await fetchJson3Transcript(
      CANDIDATE,
      { language: "en", signal: new AbortController().signal },
      { run: writingRun(JSON3_FIXTURE, (args) => calls.push([...args])) },
    );

    expect(result).toMatchObject({ ok: true, tier: 1 });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv.slice(0, 8)).toEqual([
      "--skip-download",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "en",
      "--sub-format",
      "json3",
      "--output",
    ]);
    expect(argv[8]).toMatch(/%\(id\)s\.%\(ext\)s$/);
    expect(argv).not.toContain("--cookies");
    expect(argv[argv.length - 1]).toBe(CANDIDATE.url);
  });

  it("passes the cookie path only as the --cookies argv element", async () => {
    const calls: string[][] = [];
    await fetchJson3Transcript(
      CANDIDATE,
      {
        language: "en",
        cookiePath: "/data/youtube-cookie.txt",
        signal: new AbortController().signal,
      },
      { run: writingRun(JSON3_FIXTURE, (args) => calls.push([...args])) },
    );

    const argv = calls[0]!;
    const cookieAt = argv.indexOf("--cookies");
    expect(cookieAt).toBeGreaterThan(-1);
    expect(argv[cookieAt + 1]).toBe("/data/youtube-cookie.txt");
    expect(argv[argv.length - 1]).toBe(CANDIDATE.url);
  });

  it("terminates options before the candidate URL", async () => {
    const calls: string[][] = [];
    await fetchJson3Transcript(
      CANDIDATE,
      { language: "en", signal: new AbortController().signal },
      { run: writingRun(JSON3_FIXTURE, (args) => calls.push([...args])) },
    );

    const argv = calls[0]!;
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe(CANDIDATE.url);
  });

  it("refuses a non-YouTube candidate URL before any spawn", async () => {
    let called = false;
    const run: YtDlpRun = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
    };

    const result = await fetchJson3Transcript(
      { ...CANDIDATE, url: "file:///etc/passwd" },
      { language: "en", signal: new AbortController().signal },
      { run },
    );

    expect(result).toEqual({
      ok: false,
      reason: "fetch_error",
      detail: "invalid candidate url",
    });
    expect(called).toBe(false);
  });

  it("returns no_captions when yt-dlp writes no subtitle file", async () => {
    const result = await fetchJson3Transcript(
      CANDIDATE,
      { language: "en", signal: new AbortController().signal },
      { run: emptyRun() },
    );
    expect(result).toEqual({ ok: false, reason: "no_captions" });
  });

  it("returns empty_transcript when the json3 document has no usable events", async () => {
    const result = await fetchJson3Transcript(
      CANDIDATE,
      { language: "en", signal: new AbortController().signal },
      { run: writingRun({ events: [] }) },
    );
    expect(result).toEqual({ ok: false, reason: "empty_transcript" });
  });
});

describe("classifyYtDlpError", () => {
  it("maps a sign-in, cookie or bot wall to blocked", () => {
    expect(
      classifyYtDlpError("ERROR: Sign in to confirm you're not a bot", 1),
    ).toBe("blocked");
    expect(classifyYtDlpError("ERROR: cookies are no longer valid", 1)).toBe("blocked");
    expect(classifyYtDlpError("ERROR: Private video", 1)).toBe("blocked");
  });

  it("maps a timeout exit or message to timeout", () => {
    expect(classifyYtDlpError("", 124)).toBe("timeout");
    expect(classifyYtDlpError("ERROR: The request timed out", 1)).toBe("timeout");
  });

  it("maps everything else to fetch_error", () => {
    expect(classifyYtDlpError("ERROR: HTTP Error 500", 1)).toBe("fetch_error");
    expect(classifyYtDlpError("", null)).toBe("fetch_error");
  });
});

describe("S1 through the real runner", () => {
  it("writes an immutable tier-1 capture whose frontmatter names the producing tier", async () => {
    const cascade = {
      fetch: (candidate: VideoCandidate, ctx: UnitContext) =>
        fetchJson3Transcript(candidate, ctx, { run: writingRun(JSON3_FIXTURE) }),
    };
    const deps: StageDeps = {
      ...createDefaultStageDeps(),
      async enumerate() {
        return [CANDIDATE];
      },
      fetchTranscript: createTranscriptFetcher(cascade),
      async preflight() {
        // The cascade reuse is proven in preflight.spec.ts; this case is S1.
      },
      cookiePath: () => undefined,
      now: () => FIXED_NOW,
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
    // S5 writes raw/index.md on every completed run; the capture is what this
    // assertion owns.
    const rawFiles = (await readdir(join(root, "raw"))).filter(
      (name) => name !== "index.md",
    );
    expect(rawFiles).toEqual(["first-talk.md"]);

    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", "first-talk.md"), "utf8"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.data.source_kind).toBe("video");
    expect(parsed!.data.type).toBe("raw-transcript");
    expect(parsed!.data.tier).toBe(1);
    expect(parsed!.data.immutable).toBe(true);
    expect(parsed!.body.trimStart().startsWith("## Transcript")).toBe(true);
  });
});
