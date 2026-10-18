/**
 * The fixed filter order and the pure call/time estimator (INGEST-02,
 * INGEST-03).
 *
 * Filters run in this exact order over the enumeration's preserved
 * newest-first source order:
 *
 *   1. date range      — inclusive at both ends, `YYYY-MM-DD` string compare
 *   2. minimum duration — inclusive, integer seconds
 *   3. language        — case-insensitive exact match
 *   4. maxVideos       — truncate the survivors, never recorded as a skip
 *
 * Missing metadata is honest: a candidate with no `published`/`durationSec`/
 * `language` is `unknown_metadata` ONLY when the matching filter is set, and is
 * kept when that filter is not set.
 *
 * The estimator is an integer function of the post-filter `selected` count, so
 * the preview number cannot be inflated by the raw `found` total.
 */
import { slugify } from "@2nd-brain/okf";
import type { VideoCandidate } from "../jobs/types.js";

/** Why a candidate did not survive the filters. */
export type FilterReason =
  | "unknown_metadata"
  | "outside_date_range"
  | "below_min_duration"
  | "wrong_language";

export interface FilterInput {
  maxVideos: number;
  dateFrom?: string;
  dateTo?: string;
  minDurationSec?: number;
  language?: string;
}

/** One filtered-out candidate, with a stable slug for the preview/UI. */
export interface FilteredUnit {
  youtubeId: string;
  slug: string;
  reason: FilterReason;
}

export interface FilterResult {
  selected: VideoCandidate[];
  skipped: FilteredUnit[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-video seconds for S0 + S1, from idea.md's wall-clock table: 200 videos of
 * S0 + S1 take about 7 minutes at concurrency 1, i.e. roughly 2 s per video; we
 * use 3 s to leave headroom for the transcript cascade.
 */
const SECONDS_PER_VIDEO = 3;

/**
 * Seconds per LLM call at concurrency 1, from idea.md's 2 h 15 min total for
 * about 294 calls: 294 * 26 s = 2 h 7 min, plus 200 * 3 s of S0 + S1 lands at
 * about 2 h 17 min.
 */
const SECONDS_PER_LLM_CALL = 26;

/** A title-derived slug, falling back to the stable video id. */
function baseSlug(candidate: VideoCandidate): string {
  try {
    const slug = slugify(candidate.title);
    if (slug !== "") return slug;
  } catch {
    // Fall through to the id, which is always slug-safe.
  }
  try {
    const slug = slugify(candidate.youtubeId);
    return slug === "" ? "video" : slug;
  } catch {
    return "video";
  }
}

/** Return a slug not already used in this run, appending `-<id>` on collision. */
function uniqueSlug(candidate: VideoCandidate, used: Set<string>): string {
  const base = baseSlug(candidate);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const withId = `${base}-${candidate.youtubeId}`;
  if (!used.has(withId)) {
    used.add(withId);
    return withId;
  }
  let n = 2;
  while (used.has(`${withId}-${n}`)) n += 1;
  const unique = `${withId}-${n}`;
  used.add(unique);
  return unique;
}

/**
 * The first failing filter in the fixed order, or `null` when the candidate
 * survives. One candidate reports one reason: the earliest filter that
 * rejected it.
 */
function rejectionReason(
  candidate: VideoCandidate,
  input: FilterInput,
): FilterReason | null {
  // (1) date range, inclusive on both ends.
  if (input.dateFrom !== undefined || input.dateTo !== undefined) {
    if (candidate.published === undefined || !DATE_RE.test(candidate.published)) {
      return "unknown_metadata";
    }
    if (input.dateFrom !== undefined && candidate.published < input.dateFrom) {
      return "outside_date_range";
    }
    if (input.dateTo !== undefined && candidate.published > input.dateTo) {
      return "outside_date_range";
    }
  }

  // (2) minimum duration, inclusive, integer arithmetic only.
  if (input.minDurationSec !== undefined) {
    if (candidate.durationSec === undefined) return "unknown_metadata";
    if (candidate.durationSec < input.minDurationSec) return "below_min_duration";
  }

  // (3) language, case-insensitive exact match.
  if (input.language !== undefined) {
    if (candidate.language === undefined) return "unknown_metadata";
    if (candidate.language.toLowerCase() !== input.language.toLowerCase()) {
      return "wrong_language";
    }
  }

  return null;
}

/**
 * Apply the fixed filter order and truncate the survivors. Source order is
 * preserved; truncation is not a skip.
 */
export function applyFilters(
  candidates: readonly VideoCandidate[],
  input: FilterInput,
): FilterResult {
  const selected: VideoCandidate[] = [];
  const skipped: FilteredUnit[] = [];
  const usedSlugs = new Set<string>();

  for (const candidate of candidates) {
    const reason = rejectionReason(candidate, input);
    if (reason !== null) {
      skipped.push({
        youtubeId: candidate.youtubeId,
        slug: uniqueSlug(candidate, usedSlugs),
        reason,
      });
      continue;
    }
    selected.push(candidate);
  }

  const limit = Number.isFinite(input.maxVideos) ? Math.max(0, Math.trunc(input.maxVideos)) : 0;
  return { selected: selected.slice(0, limit), skipped };
}

/**
 * The locked cost model: one extraction call per selected video, six
 * canonicalization calls, and one prose call per five pages.
 */
export function estimateCalls(selected: number): number {
  return selected + 6 + Math.ceil(selected / 5);
}

/**
 * Wall-clock estimate at concurrency 1. Zero selected means zero minutes; a
 * zero-video run still pays the six fixed calls, so the call estimate is 6.
 */
export function estimateMinutes(selected: number): number {
  if (selected === 0) return 0;
  return Math.ceil(
    (selected * SECONDS_PER_VIDEO + estimateCalls(selected) * SECONDS_PER_LLM_CALL) / 60,
  );
}
