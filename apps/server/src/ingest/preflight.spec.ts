import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UnitContext } from "../jobs/runner.js";
import type { VideoCandidate } from "../jobs/types.js";
import { PreflightFailedError, probeFirstCandidate } from "./preflight.js";
import {
  createTranscriptCascade,
  type PythonRun,
} from "./transcript.js";
import type { YtDlpRun } from "./ytdlp.js";

const CANDIDATE: VideoCandidate = {
  youtubeId: "abcdefghijk",
  title: "First Talk",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
};

function ctx(): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: "job-1",
    vaultDir: "/tmp/vault",
    now: () => Date.parse("2026-10-18T10:00:00.000Z"),
  };
}

const tierOneWrites: YtDlpRun = async (args) => {
  const template = args[args.indexOf("--output") + 1];
  if (template === undefined) throw new Error("argv carries no --output");
  await writeFile(
    join(dirname(template), "abcdefghijk.json3"),
    JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "probed once" }] }],
    }),
  );
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
};

const tierOneMissing: YtDlpRun = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  isCanceled: false,
});

const tierTwoFails: PythonRun = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "ERROR: no transcript",
  timedOut: false,
});

describe("probeFirstCandidate", () => {
  it("reuses the probe result for the first fetch with one adapter call", async () => {
    const run = vi.fn(tierOneWrites);
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: tierTwoFails,
      supadataKey: null,
    });

    await probeFirstCandidate([CANDIDATE], cascade, ctx());
    const fetched = await cascade.fetch(CANDIDATE, ctx());

    expect(fetched).toEqual({
      ok: true,
      tier: 1,
      segments: [{ startSec: 0, text: "probed once" }],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no candidate", async () => {
    const run = vi.fn(tierOneWrites);
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: tierTwoFails,
      supadataKey: null,
    });

    await probeFirstCandidate([], cascade, ctx());
    expect(run).not.toHaveBeenCalled();
  });

  it("throws PreflightFailedError for a channel-wide block", async () => {
    const run: YtDlpRun = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Sign in to confirm you're not a bot",
      timedOut: false,
      isCanceled: false,
    });
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: tierTwoFails,
      supadataKey: null,
    });

    const error = await probeFirstCandidate([CANDIDATE], cascade, ctx()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PreflightFailedError);
    expect((error as PreflightFailedError).reason).toBe("blocked");
    expect((error as Error).message).toBe("all transcript tiers failed: blocked");
  });

  it("does not fail the job when the first video has no captions", async () => {
    const cascade = createTranscriptCascade({
      runYtDlp: tierOneMissing,
      runPython: tierTwoFails,
      supadataKey: null,
    });

    await expect(
      probeFirstCandidate([CANDIDATE], cascade, ctx()),
    ).resolves.toBeUndefined();
  });

  it("does not fail the job when the first video is private", async () => {
    const run: YtDlpRun = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Private video. Sign in if you've been granted access",
      timedOut: false,
      isCanceled: false,
    });
    const cascade = createTranscriptCascade({
      runYtDlp: run,
      runPython: tierTwoFails,
      supadataKey: null,
    });

    await expect(
      probeFirstCandidate([CANDIDATE], cascade, ctx()),
    ).resolves.toBeUndefined();
  });
});
