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

export class PreflightFailedError extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason) {
    super(`all transcript tiers failed: ${reason}`);
    this.name = "PreflightFailedError";
    this.reason = reason;
  }
}

/**
 * Probe the first candidate. A zero-candidate job has nothing to probe and
 * returns without touching any adapter.
 */
export async function probeFirstCandidate(
  candidates: readonly VideoCandidate[],
  cascade: TranscriptCascade,
  ctx: UnitContext,
): Promise<void> {
  const first = candidates[0];
  if (first === undefined) return;

  const result = await cascade.probe(first, ctx);
  if (!result.ok) throw new PreflightFailedError(result.reason);
}
