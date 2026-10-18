/**
 * The S1 fetch stage (PIPE-01, PIPE-05).
 *
 * The cascade decides which tier produced the text; this stage turns the
 * winning result into the video arm of the one `RawCapture` union. The runner
 * hands that arm to `writeCapture`, which owns the frontmatter key mapping —
 * this module never renders a capture.
 *
 * A total cascade failure becomes a tagged `SkipError`, so the runner records
 * the enumerated reason and keeps going. The detail is capped and stripped of
 * any `x-api-key` value: the Supadata key never reaches a capture, `job.json`,
 * the event log or a pino line (T-03-15).
 */
import type { TierResult } from "../../ingest/ytdlp.js";
import {
  SkipError,
  type VideoCandidate,
  type VideoRawCapture,
} from "../types.js";
import { slugForCandidate, type UnitContext } from "../runner.js";

/** What the fetcher needs from the cascade. */
export interface TranscriptCascade {
  fetch(candidate: VideoCandidate, ctx: UnitContext): Promise<TierResult>;
}

export type TranscriptFetcher = (
  candidate: VideoCandidate,
  ctx: UnitContext,
) => Promise<VideoRawCapture>;

/** Longest detail persisted in `skipped[]`. */
const DETAIL_LIMIT = 200;

/**
 * Remove any header-shaped key value and cap the text. A key is never expected
 * in a detail, so this is a structural backstop rather than a formatting rule.
 */
export function redactDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const redacted = detail
    .replace(/"x-api-key"\s*:\s*"[^"]*"/gi, '"x-api-key":"[redacted]"')
    .replace(/(x-api-key\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .trim();
  if (redacted === "") return undefined;
  return redacted.slice(0, DETAIL_LIMIT);
}

/**
 * Build the S1 fetcher. On success the returned arm carries the producing tier,
 * so the capture records which adapter actually produced the text.
 */
export function createTranscriptFetcher(
  cascade: TranscriptCascade,
): TranscriptFetcher {
  return async (candidate, ctx) => {
    const result = await cascade.fetch(candidate, ctx);
    if (!result.ok) {
      throw new SkipError(result.reason, redactDetail(result.detail));
    }
    return {
      kind: "video",
      slug: slugForCandidate(candidate),
      url: candidate.url,
      youtubeId: candidate.youtubeId,
      title: candidate.title,
      published: candidate.published,
      durationSec: candidate.durationSec,
      tier: result.tier,
      fetchedAt: new Date(ctx.now()).toISOString(),
      segments: result.segments,
    };
  };
}
