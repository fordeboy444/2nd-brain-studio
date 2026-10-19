/**
 * The transcript cascade (INGEST-03): tier 1 yt-dlp json3, tier 2
 * youtube-transcript-api, tier 3 Supadata.
 *
 * Rules:
 * - Tiers run strictly 1 -> 2 -> 3. The first success wins and later tiers are
 *   never constructed, so a tier-1 hit costs no Python process and no network.
 * - `probe` caches a successful result by video id; `fetch` consumes and deletes
 *   that entry first, so preflight and the first unit together fetch once.
 * - Every subprocess is an argv array with `shell:false`. Tier 2 requires an
 *   11-character video id before Python is invoked (T-03-14).
 * - Third-party JSON is validated with zod. Malformed output never reaches a
 *   capture as partially parsed text (T-03-17).
 * - The Supadata key is read from config and sent only in `x-api-key`; it never
 *   enters a URL, a body, or an error detail (T-03-15).
 * - A cancellation or timeout bounds each tier, so one dead video cannot hold a
 *   job open (T-03-18).
 */
import { execa } from "execa";
import { z } from "zod";
import { config } from "../config.js";
import type { SkipReason, TranscriptSegment, VideoCandidate } from "../jobs/types.js";
import type { UnitContext } from "../jobs/runner.js";
import {
  classifyYtDlpError,
  fetchJson3Transcript,
  runYtDlp as realRunYtDlp,
  type TierResult,
  type YtDlpRun,
} from "./ytdlp.js";

/** The cascade's public shape: probe once before fan-out, then fetch per unit. */
export interface TranscriptCascade {
  probe(candidate: VideoCandidate, ctx: UnitContext): Promise<TierResult>;
  fetch(candidate: VideoCandidate, ctx: UnitContext): Promise<TierResult>;
}

/** What one injected Python run returns. */
export interface PythonRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  isCanceled?: boolean;
}

/** Options handed to the Python runner. `shell` is always false. */
export interface PythonRunOptions {
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
}

/** An injectable subprocess runner, so tests never execute Python. */
export type PythonRun = (
  argv: readonly string[],
  opts: PythonRunOptions,
) => Promise<PythonRunResult>;

/** The default tier-2 runner: `python3 -I -m youtube_transcript_api ...`. */
export const runPythonTranscript: PythonRun = async (argv, opts) => {
  const result = await execa("python3", [...argv], {
    shell: false,
    reject: false,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferBytes,
    // execa 10 renamed the option; `signal` throws before the spawn starts.
    ...(opts.signal !== undefined ? { cancelSignal: opts.signal } : {}),
  });
  return {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.timedOut === true,
    isCanceled: (result.isCanceled as boolean | undefined) === true,
  };
};

export interface TranscriptCascadeDeps {
  /** Tier 1 subprocess runner. Defaults to the real `runYtDlp`. */
  runYtDlp?: YtDlpRun;
  /** Tier 2 subprocess runner. Defaults to `runPythonTranscript`. */
  runPython?: PythonRun;
  /** Tier 3 HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** The Supadata key. `null` or absent means tier 3 is never constructed. */
  supadataKey?: string | null;
}

/** Tier 2 accepts exactly the 11-character YouTube id alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** `youtube-transcript-api --format json` emits an array of timed lines. */
const Tier2Document = z.array(
  z.object({
    text: z.string(),
    start: z.number(),
    duration: z.number(),
  }),
);

/** Supadata emits millisecond offsets inside a `content` array. */
const Tier3Document = z.object({
  content: z.array(
    z.object({
      text: z.string(),
      offset: z.number(),
      duration: z.number(),
    }),
  ),
});

/** Join fragments, drop empties, and keep whole seconds. */
function toSegments(
  lines: readonly { text: string; startSec: number }[],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text === "") continue;
    segments.push({ startSec: line.startSec, text });
  }
  return segments;
}

function failed(reason: SkipReason, detail?: string): TierResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * A channel verdict outranks a per-video reason, which outranks nothing.
 * Other reasons tie, so the later real attempt supplies the explanation.
 */
const REASON_SPECIFICITY: Partial<Record<SkipReason, number>> = {
  blocked: 2,
  timeout: 2,
};

function mostSpecificReason(
  attempts: readonly { tier: number; result: TierResult }[],
): SkipReason {
  // The key-absent entry is synthetic: no request ran, so it cannot explain
  // the failure. Use it only when no real tier produced a reason.
  const real = attempts.filter(
    (attempt) => !(attempt.result.ok === false && attempt.result.detail === "supadata key absent"),
  );
  const pool = real.length > 0 ? real : attempts;
  let chosen: { tier: number; result: TierResult } | undefined;
  for (const attempt of pool) {
    if (attempt.result.ok) continue;
    if (chosen === undefined || chosen.result.ok) {
      chosen = attempt;
      continue;
    }
    const rank = REASON_SPECIFICITY[attempt.result.reason] ?? 1;
    const chosenRank = REASON_SPECIFICITY[chosen.result.reason] ?? 1;
    if (rank >= chosenRank) chosen = attempt;
  }
  return chosen !== undefined && chosen.result.ok === false
    ? chosen.result.reason
    : "fetch_error";
}

/** One line per attempted tier, so a final failure names what was tried. */
function summary(attempts: readonly { tier: number; result: TierResult }[]): string {
  const parts = attempts.map(({ tier, result }) => {
    if (result.ok) return `tier${tier}=ok`;
    return result.detail === undefined
      ? `tier${tier}=${result.reason}`
      : `tier${tier}=${result.reason} (${result.detail})`;
  });
  return parts.join("; ");
}

/** Tier 2: youtube-transcript-api, argv-only, 60 s, id checked first. */
async function fetchTierTwo(
  candidate: VideoCandidate,
  ctx: UnitContext,
  run: PythonRun,
): Promise<TierResult> {
  if (!VIDEO_ID.test(candidate.youtubeId)) {
    return failed("fetch_error", "invalid video id");
  }
  const argv = [
    "-I",
    "-m",
    "youtube_transcript_api",
    candidate.youtubeId,
    "--languages",
    ctx.language,
    "--format",
    "json",
  ];

  let result: PythonRunResult;
  try {
    result = await run(argv, {
      timeoutMs: 60_000,
      maxBufferBytes: 16 * 1024 * 1024,
      signal: ctx.signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) return failed("fetch_error", "cancelled");
    return failed("fetch_error", error instanceof Error ? error.message : String(error));
  }

  if (result.isCanceled === true) return failed("fetch_error", "cancelled");
  if (result.timedOut === true) return failed("timeout");
  if (result.exitCode !== 0) {
    return failed(
      classifyYtDlpError(result.stderr, result.exitCode),
      result.stderr.slice(-500),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return failed("fetch_error", "invalid tier-2 json");
  }
  const document = Tier2Document.safeParse(parsed);
  if (!document.success) return failed("fetch_error", "invalid tier-2 json");

  const segments = toSegments(
    document.data.map((line) => ({
      startSec: Math.floor(line.start),
      text: line.text,
    })),
  );
  if (segments.length === 0) return failed("empty_transcript");
  return { ok: true, tier: 2, segments };
}

/** Tier 3: Supadata. Never constructed without a key; the key stays in a header. */
async function fetchTierThree(
  candidate: VideoCandidate,
  ctx: UnitContext,
  deps: { fetch: typeof globalThis.fetch; supadataKey: string },
): Promise<TierResult> {
  const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(
    candidate.youtubeId,
  )}&lang=${encodeURIComponent(ctx.language)}`;

  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: { "x-api-key": deps.supadataKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return failed("timeout");
    }
    return failed("fetch_error", error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) return failed("fetch_error", `supadata http ${response.status}`);

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return failed("fetch_error", "invalid tier-3 json");
  }
  const document = Tier3Document.safeParse(parsed);
  if (!document.success) return failed("fetch_error", "invalid tier-3 json");

  const segments = toSegments(
    document.data.content.map((line) => ({
      startSec: Math.floor(line.offset / 1000),
      text: line.text,
    })),
  );
  if (segments.length === 0) return failed("empty_transcript");
  return { ok: true, tier: 3, segments };
}

/**
 * Build the cascade once per process/job. The returned `probe` must be called
 * by preflight before fan-out; `fetch` then reuses that one result.
 */
export function createTranscriptCascade(
  deps: TranscriptCascadeDeps = {},
): TranscriptCascade {
  const runYtDlp: YtDlpRun = deps.runYtDlp ?? realRunYtDlp;
  const runPython = deps.runPython ?? runPythonTranscript;
  const http = deps.fetch ?? globalThis.fetch;
  const supadataKey =
    deps.supadataKey === null ? undefined : (deps.supadataKey ?? config.supadataApiKey);
  const probed = new Map<string, TierResult>();

  async function runTiers(
    candidate: VideoCandidate,
    ctx: UnitContext,
  ): Promise<TierResult> {
    const attempts: { tier: number; result: TierResult }[] = [];

    const tier1 = await fetchJson3Transcript(candidate, ctx, { run: runYtDlp });
    attempts.push({ tier: 1, result: tier1 });
    if (tier1.ok) return tier1;

    const tier2 = await fetchTierTwo(candidate, ctx, runPython);
    attempts.push({ tier: 2, result: tier2 });
    if (tier2.ok) return tier2;

    if (supadataKey !== undefined && supadataKey !== "") {
      const tier3 = await fetchTierThree(candidate, ctx, {
        fetch: http,
        supadataKey,
      });
      attempts.push({ tier: 3, result: tier3 });
      if (tier3.ok) return tier3;
    } else {
      attempts.push({ tier: 3, result: failed("fetch_error", "supadata key absent") });
    }

    // Report the most specific real failure. Taking the last attempt let the
    // synthetic "supadata key absent" entry mask a `blocked` tier 1 as
    // `fetch_error` (CR-03), which also hides a channel-wide block from the
    // preflight decision.
    const reason = mostSpecificReason(attempts);
    return failed(reason, summary(attempts));
  }

  return {
    async probe(candidate, ctx) {
      const result = await runTiers(candidate, ctx);
      if (result.ok) probed.set(candidate.youtubeId, result);
      return result;
    },

    async fetch(candidate, ctx) {
      const cached = probed.get(candidate.youtubeId);
      if (cached !== undefined) {
        probed.delete(candidate.youtubeId);
        return cached;
      }
      return runTiers(candidate, ctx);
    },
  };
}
