/**
 * Tier 1 of the transcript cascade (PIPE-01): `yt-dlp` downloads the auto or
 * uploaded `json3` captions into a throwaway directory and this module turns
 * the events into whole-second segments.
 *
 * Boundary rules:
 * - `yt-dlp` always receives an argv ARRAY with `shell: false`; no candidate
 *   field or cookie path is ever concatenated into a command string (T-03-14).
 * - The cookie path is passed only as the `--cookies` argv element. Nothing in
 *   this module reads the cookie file (T-03-16).
 * - The downloaded subtitle file is untrusted third-party output: it is parsed
 *   through zod and a malformed document never reaches a capture (T-03-17).
 * - The temporary directory is removed in `finally`, so a failed tier leaves no
 *   caption artifact outside the vault.
 */
import { execa } from "execa";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SkipReason, TranscriptSegment, VideoCandidate } from "../jobs/types.js";

/** What one subprocess run returns. A failure is a value, never a throw. */
export interface YtDlpResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the `timeout` option killed the process. */
  timedOut: boolean;
  /** True when the AbortSignal cancelled the process. */
  isCanceled: boolean;
}

export interface YtDlpRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** An injectable runner, so every spec can avoid a real `yt-dlp` call. */
export type YtDlpRun = (
  args: readonly string[],
  opts?: YtDlpRunOptions,
) => Promise<YtDlpResult>;

/**
 * Run `yt-dlp` with an argv array and no shell. `shell: false` is the security
 * boundary, not a default: a URL or path is data, never command text.
 * `reject: false` turns a non-zero exit into a result the classifier can name.
 */
export async function runYtDlp(
  args: readonly string[],
  opts: YtDlpRunOptions = {},
): Promise<YtDlpResult> {
  try {
    const result = await execa("yt-dlp", [...args], {
      shell: false,
      reject: false,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut === true,
      isCanceled: result.isCanceled === true,
    };
  } catch (error) {
    const canceled = (error as { isCanceled?: boolean } | null)?.isCanceled === true;
    return {
      exitCode: null,
      stdout: "",
      stderr: canceled ? "" : error instanceof Error ? error.message : String(error),
      timedOut: false,
      isCanceled: canceled,
    };
  }
}

/** One json3 event. Unknown keys are stripped; every used field is optional. */
const Json3Event = z.object({
  tStartMs: z.number().optional(),
  dDurationMs: z.number().optional(),
  segs: z
    .array(
      z.object({
        utf8: z.string().optional(),
      }),
    )
    .optional(),
});

const Json3Document = z.object({
  events: z.array(Json3Event).optional(),
});

/**
 * `json3` events -> transcript segments.
 *
 * Each event's `segs[].utf8` fragments are joined, trimmed, and dropped when
 * empty. `tStartMs` is milliseconds and is floored to whole seconds. Two
 * consecutive events with the same text are one segment: automatic captions
 * repeat the previous line while the next one is still being produced.
 * A document that does not match the shape yields `[]`, never partial text.
 */
export function parseJson3(raw: unknown): TranscriptSegment[] {
  const parsed = Json3Document.safeParse(raw);
  if (!parsed.success) return [];

  const segments: TranscriptSegment[] = [];
  for (const event of parsed.data.events ?? []) {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? "")
      .join("")
      .trim();
    if (text === "") continue;

    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.text === text) continue;

    segments.push({
      startSec: Math.floor((event.tStartMs ?? 0) / 1000),
      text,
    });
  }
  return segments;
}

/** The tier result: the producer is recorded only on success. */
export type TierResult =
  | { ok: true; tier: 1 | 2 | 3; segments: TranscriptSegment[] }
  | { ok: false; reason: SkipReason; detail?: string };

/** What `fetchJson3Transcript` needs. Both fields are injectable for tests. */
export interface FetchJson3Deps {
  run?: YtDlpRun;
  /** Parent for `mkdtemp`; the OS temp directory by default. */
  tmpRoot?: string;
}

/** Context the tier needs. A cookie path is passed only when the file exists. */
export interface TierContext {
  language: string;
  cookiePath?: string;
  signal: AbortSignal;
}

/** Bound on stderr copied into a skip detail. Never the cookie body. */
function stderrDetail(stderr: string): string | undefined {
  const text = stderr.trim();
  if (text === "") return undefined;
  return text.slice(-500);
}

/** Sign-in, cookie and bot walls all mean "the platform refused this client". */
const BLOCKED_PATTERN =
  /sign in|log in|login|cookies|not a bot|confirm your age|private video|members[- ]only|age[- ]restricted|video unavailable|requested content/i;

/** A timeout may be reported by the watchdog or by yt-dlp's own message. */
const TIMEOUT_PATTERN = /timed? ?out|timeout/i;

/**
 * Map a failed tier-1 run to the enumerated skip taxonomy.
 *
 * `blocked` is a sign-in/cookie/bot wall, `timeout` is the 120 s watchdog (or
 * yt-dlp's own timeout message), and every other non-zero exit is
 * `fetch_error`.
 */
export function classifyYtDlpError(
  stderr: string,
  exitCode: number | null,
): SkipReason {
  if (exitCode === 124) return "timeout";
  if (BLOCKED_PATTERN.test(stderr)) return "blocked";
  if (TIMEOUT_PATTERN.test(stderr)) return "timeout";
  return "fetch_error";
}

/**
 * Tier 1: download `json3` captions into a temporary directory, parse them,
 * and remove the directory in `finally`.
 *
 * No `*.json3` file means the video has no captions (`no_captions`). A file
 * that parses to zero segments is `empty_transcript`. A non-zero exit is
 * classified from stderr. Every failure is a value, so the cascade can try the
 * next tier.
 */
export async function fetchJson3Transcript(
  candidate: VideoCandidate,
  ctx: TierContext,
  deps: FetchJson3Deps = {},
): Promise<TierResult> {
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "2nd-brain-tier1-"));
  try {
    const argv = [
      "--skip-download",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      ctx.language,
      "--sub-format",
      "json3",
      "--output",
      join(dir, "%(id)s.%(ext)s"),
      ...(ctx.cookiePath !== undefined ? ["--cookies", ctx.cookiePath] : []),
      candidate.url,
    ];

    const run = deps.run ?? runYtDlp;
    const result = await run(argv, {
      signal: ctx.signal,
      timeoutMs: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.isCanceled) {
      return { ok: false, reason: "fetch_error", detail: "cancelled" };
    }
    if (result.timedOut) {
      return {
        ok: false,
        reason: "timeout",
        detail: "yt-dlp timed out after 120 seconds",
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: classifyYtDlpError(result.stderr, result.exitCode),
        detail: stderrDetail(result.stderr),
      };
    }

    const names = await readdir(dir);
    const subtitle = names.find((name) => name.endsWith(".json3"));
    if (subtitle === undefined) return { ok: false, reason: "no_captions" };

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, subtitle), "utf8"));
    } catch {
      return { ok: false, reason: "empty_transcript", detail: "invalid json3" };
    }

    const segments = parseJson3(raw);
    if (segments.length === 0) return { ok: false, reason: "empty_transcript" };
    return { ok: true, tier: 1, segments };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
