/**
 * The one-time transcript preflight (INGEST-03, PIPE-04).
 *
 * Before fan-out, the first candidate runs the whole cascade. A success is
 * cached by the cascade and reused by that first unit; an all-tier failure is a
 * channel-wide condition (dead cookies, blocked IP, no key), so the job fails
 * once instead of writing one skipped unit per video.
 *
 * The error carries the reason only. It never includes a response body or an
 * API key (T-03-15).
 */
import type { UnitContext } from "../jobs/runner.js";
import type { SkipReason, VideoCandidate } from "../jobs/types.js";
import type { TranscriptCascade } from "./transcript.js";
import type { TierResult } from "./ytdlp.js";

export class PreflightFailedError extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason) {
    super(`all transcript tiers failed: ${reason}`);
    this.name = "PreflightFailedError";
    this.reason = reason;
  }
}

/**
 * `blocked` covers two different conditions: a per-video one (private,
 * members-only, deleted, age-gated) and a channel-wide bot or cookie wall.
 * The detail tells them apart; `blocked` without a per-video detail is a wall.
 */
const PER_VIDEO_DETAIL =
  /private video|members[- ]only|video unavailable|deleted|removed|age[- ]restricted|confirm your age/i;

/**
 * A plain `fetch_error` is not enough evidence of a channel-wide condition:
 * it also covers per-video causes. The detail must name an auth or network
 * failure that would repeat for every video.
 */
const CHANNEL_WIDE_DETAIL =
  /cookie|authenticat|sign in|log in|login|not a bot|403|429|econn|enotfound|eai_again|certificate|network/i;

function isChannelWideFailure(
  result: TierResult,
): result is Extract<TierResult, { ok: false }> {
  if (result.ok) return false;
  if (result.reason === "timeout") return true;
  if (result.reason === "blocked") {
    return result.detail === undefined || !PER_VIDEO_DETAIL.test(result.detail);
  }
  if (result.reason !== "fetch_error") return false;
  return result.detail !== undefined && CHANNEL_WIDE_DETAIL.test(result.detail);
}

/**
 * Probe the first candidate. A zero-candidate job has nothing to probe and
 * returns without touching any adapter.
 *
 * Only a channel-wide failure throws. A per-video failure (private, deleted,
 * members-only, caption-less) is not a verdict on the channel: the S1 loop
 * retries the first unit and records it as a normal skip, so one bad video
 * cannot kill a 200-video job (CR-03).
 */
export async function probeFirstCandidate(
  candidates: readonly VideoCandidate[],
  cascade: TranscriptCascade,
  ctx: UnitContext,
): Promise<void> {
  const first = candidates[0];
  if (first === undefined) return;

  const result = await cascade.probe(first, ctx);
  if (isChannelWideFailure(result)) throw new PreflightFailedError(result.reason);
}
