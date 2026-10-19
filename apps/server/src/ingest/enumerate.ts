/**
 * S0 enumeration (INGEST-02): one bounded `yt-dlp --flat-playlist --dump-json
 * --playlist-end <maxScan>` call per channel, parsed into `VideoCandidate[]`.
 *
 * Boundary rules:
 * - The caller passes the canonical `/videos` URL produced by
 *   `normalizeChannelUrl`; enumeration never receives the raw user input.
 * - yt-dlp always receives an argv ARRAY with `shell: false`. No URL or
 *   candidate field is ever concatenated into a command string (T-03-10).
 * - The scan is bounded twice: `--playlist-end` caps what yt-dlp reads, and the
 *   subprocess has a 120 s timeout plus a 64 MiB output cap (T-03-11).
 * - When the parsed line count reaches the cap the return value carries
 *   `foundAtLeast: true`, never a false total.
 *
 * This is the only place that spawns yt-dlp for S0. `previewJob` and the
 * runner's S0 both call `enumerateChannel`, so a preview cannot diverge from the
 * job it estimates.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { VideoCandidate } from "../jobs/types.js";

/** The two failure classes the route layer maps to an HTTP status. */
export type EnumerateErrorCode = "enumerate_failed" | "timeout";

/** A tagged enumeration failure. The detail never contains a command string. */
export class EnumerateError extends Error {
  readonly code: EnumerateErrorCode;
  readonly detail?: string;

  constructor(code: EnumerateErrorCode, detail?: string) {
    super(detail !== undefined && detail !== "" ? detail : code);
    this.name = "EnumerateError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** What one injected subprocess run returns. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the 120 s watchdog killed the process. */
  timedOut?: boolean;
  /** True when stdout exceeded the 64 MiB cap and the process was killed. */
  overflow?: boolean;
}

/** Options handed to the runner. `shell` is always false. */
export interface RunOptions {
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
  /** Always false: yt-dlp receives an argv array, never a command string. */
  shell: false;
}

/** An injectable subprocess runner, so tests never execute yt-dlp. */
export type YtDlpRun = (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;

export interface EnumerateDeps {
  run?: YtDlpRun;
}

export interface EnumerateOptions {
  /** Used to derive `maxScan` when no explicit bound is supplied. */
  maxVideos?: number;
  /** The explicit `--playlist-end` bound. */
  maxScan?: number;
  signal?: AbortSignal;
}

export interface EnumerateResult {
  candidates: VideoCandidate[];
  /** True iff the number of parsed lines reached the scan cap. */
  foundAtLeast: boolean;
}

/** `maxScan = min(2000, max(1, maxVideos) * 5)`; an explicit bound wins. */
export function scanCap(options: EnumerateOptions): number {
  if (options.maxScan !== undefined) return options.maxScan;
  return Math.min(2000, Math.max(1, options.maxVideos ?? 1) * 5);
}

/**
 * Spawn `yt-dlp` with an argv array and no shell. Output is accumulated as
 * chunks so the caller can cap it; stderr is kept only for the failure detail.
 */
export function defaultRun(
  argv: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  // A cancel that lands before the spawn must not start yt-dlp at all: the
  // child would otherwise run to completion or to the 120 s watchdog.
  if (opts.signal?.aborted === true) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const kill = (): void => {
      // `killed` is false until a signal is sent; the optional child covers
      // an abort that races the spawn call.
      if (child !== undefined && !child.killed) child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      kill();
    };
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      done();
    };

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    // Register before `spawn`, then re-check: an abort between the first check
    // and the spawn either fires the listener or is caught by this check.
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child = spawn("yt-dlp", [...argv], {
      shell: opts.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (opts.signal?.aborted === true) kill();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxBufferBytes) {
        overflow = true;
        kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("error", (error) => {
      finish(() => reject(new EnumerateError("enumerate_failed", error.message)));
    });
    child.on("close", (code) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr,
          exitCode: code,
          timedOut,
          overflow,
        }),
      );
    });
  });
}

const RawLine = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  url: z.string().optional(),
  webpage_url: z.string().optional(),
  duration: z.union([z.number(), z.string()]).optional(),
  upload_date: z.string().optional(),
  channel: z.string().optional(),
  language: z.string().optional(),
});

/** `YYYYMMDD` (yt-dlp's flat-playlist form) -> `YYYY-MM-DD`. */
function normalizeUploadDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return undefined;
}

/**
 * Integer seconds from either a number or `H:MM:SS` / `MM:SS`.
 * Anything else is absent metadata, not a partially parsed value.
 */
export function parseDuration(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const parts = text.split(":");
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : NaN));
  if (numbers.some((n) => !Number.isFinite(n))) return undefined;
  const seconds = numbers[numbers.length - 1] as number;
  const minutes = numbers[numbers.length - 2] as number;
  const hours = numbers.length === 3 ? (numbers[0] as number) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse one `--dump-json` line. A blank line, invalid JSON, or an object
 * without an `id` is `null` (skipped by the caller). Absent metadata stays
 * undefined so a filter can decide whether that matters.
 */
export function parseYtDlpLine(line: string): VideoCandidate | null {
  if (line.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = RawLine.safeParse(raw);
  if (!parsed.success) return null;

  const entry = parsed.data;
  const youtubeId = entry.id;
  const candidate: VideoCandidate = {
    youtubeId,
    title: entry.title !== undefined && entry.title.trim() !== "" ? entry.title : youtubeId,
    url:
      entry.webpage_url !== undefined && entry.webpage_url !== ""
        ? entry.webpage_url
        : entry.url !== undefined && entry.url !== ""
          ? entry.url
          : `https://www.youtube.com/watch?v=${youtubeId}`,
  };

  const published = normalizeUploadDate(entry.upload_date);
  if (published !== undefined) candidate.published = published;
  const durationSec = parseDuration(entry.duration);
  if (durationSec !== undefined) candidate.durationSec = durationSec;
  if (entry.channel !== undefined && entry.channel !== "") candidate.channel = entry.channel;
  if (entry.language !== undefined && entry.language !== "") candidate.language = entry.language;

  return candidate;
}

/**
 * Enumerate one channel's `/videos` tab. Empty stdout is a successful empty
 * list, not an error. Duplicate ids collapse to their first occurrence, which
 * preserves the newest-first source order.
 */
export async function enumerateChannel(
  normalizedUrl: string,
  options: EnumerateOptions = {},
  deps: EnumerateDeps = {},
): Promise<EnumerateResult> {
  const maxScan = scanCap(options);
  // The argv is fixed except for the numeric bound and the already-normalized
  // URL. It is passed as an array with shell:false; nothing is quoted or joined.
  const argv = [
    "--flat-playlist",
    "--dump-json",
    "--playlist-end",
    String(maxScan),
    normalizedUrl,
  ];

  const run = deps.run ?? defaultRun;
  const result = await run(argv, {
    shell: false,
    timeoutMs: 120_000,
    maxBufferBytes: 64 * 1024 * 1024,
    signal: options.signal,
  });

  if (result.timedOut === true) {
    throw new EnumerateError("timeout", "yt-dlp timed out after 120 seconds.");
  }
  if (result.overflow === true) {
    throw new EnumerateError("enumerate_failed", "yt-dlp output exceeded 64 MiB.");
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.slice(-500).trim();
    throw new EnumerateError(
      "enumerate_failed",
      detail === ""
        ? `yt-dlp exited with code ${String(result.exitCode)}`
        : detail,
    );
  }

  const byId = new Map<string, VideoCandidate>();
  let parsedLineCount = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    const candidate = parseYtDlpLine(line);
    if (candidate === null) continue;
    parsedLineCount += 1;
    if (!byId.has(candidate.youtubeId)) byId.set(candidate.youtubeId, candidate);
  }

  return {
    candidates: [...byId.values()],
    // The cap is reached as soon as the parsed line count hits it. The exact
    // total is unknowable from a capped scan, so the caller must not invent one.
    foundAtLeast: parsedLineCount >= maxScan,
  };
}
