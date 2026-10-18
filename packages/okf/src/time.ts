/**
 * Citation time parsing and the reference citation-overlap score.
 *
 * The reference `tools/validation/citation_integrity.py` defines the algorithm
 * this module reproduces: a quote is a claim about a window from 45 seconds
 * before to 120 seconds after its cited timestamp, and it passes when at least
 * 55% of its significant words occur somewhere in that window's text.
 *
 * Pure: every input is a string or a plain array, and every output is a number,
 * a string or a plain object. No filesystem, network or process access.
 */

/** Seconds of transcript before the cited timestamp that the window covers. */
export const CITATION_WINDOW_BEFORE_SECONDS = 45;

/** Seconds of transcript after the cited timestamp that the window covers. */
export const CITATION_WINDOW_AFTER_SECONDS = 120;

/** Minimum share of significant quote words that must occur in the haystack. */
export const CITATION_OVERLAP_THRESHOLD = 0.55;

/** A window fallback happens when the joined window text is this short. */
const MIN_WINDOW_TEXT_LENGTH = 40;

/** Significant quote words are at least this long. */
const MIN_QUOTE_WORD_LENGTH = 4;

/** One timestamped transcript segment and its normalized text. */
export interface CitationSegment {
  /** The segment marker in seconds. */
  seconds: number;
  /** The segment body after normalization. */
  text: string;
}

/**
 * Parse `H:MM:SS`, `MM:SS` or `SS` into seconds.
 *
 * Mirrors the reference `to_sec`: every part is a base-10 integer, the list is
 * left-padded to three parts, and only the last three parts count.
 */
export function parseTimestamp(timestamp: string): number {
  const parts = timestamp.split(":").map((part) => Number.parseInt(part, 10));
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts.slice(-3) as [number, number, number];
  return hours * 3600 + minutes * 60 + seconds;
}

/** Pad a non-negative integer to two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Format seconds as `H:MM:SS`.
 *
 * The hour is never zero-padded; minutes and seconds always are. This is the
 * inverse of `parseTimestamp` for non-negative values.
 */
export function formatTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Lowercase, replace every character outside `[a-z0-9 ]` with a space, collapse
 * whitespace runs and trim. This is the reference `norm`.
 */
export function normalizeCitationText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The reference transcript-marker pattern.
 *
 * A marker is `**[H:MM:SS]**`; its body is everything up to the next marker at
 * the start of a line or the end of the text. The body is non-greedy, so the
 * scan never runs past the marker that bounds it.
 */
const SEGMENT_RE = /\*\*\[(\d+:\d+:\d+)\]\*\*\s*([\s\S]*?)(?=\n\*\*\[|$)/g;

/**
 * Split a raw transcript into timestamped segments.
 *
 * Returns the segments in document order with normalized bodies. Text before
 * the first marker is not a segment, matching the reference.
 */
export function parseVideoSegments(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  const pattern = new RegExp(SEGMENT_RE.source, "g");
  let match = pattern.exec(text);
  while (match !== null) {
    segments.push({
      seconds: parseTimestamp(match[1] as string),
      text: normalizeCitationText(match[2] as string),
    });
    match = pattern.exec(text);
  }
  return segments;
}

/**
 * Score a quote against its cited transcript.
 *
 * Words shorter than four characters do not count, and a quote with none is
 * trivial and passes. A timestamp selects the inclusive window
 * `[seconds - 45, seconds + 120]`; a joined window of 40 characters or fewer
 * falls back to the whole transcript. A `null` timestamp always uses the whole
 * transcript, which is the reference's web path.
 */
export function citationScore(
  quote: string,
  segments: readonly CitationSegment[],
  fullText: string,
  seconds: number | null,
): number {
  const quoteWords = normalizeCitationText(quote)
    .split(" ")
    .filter((word) => word.length >= MIN_QUOTE_WORD_LENGTH);
  if (quoteWords.length === 0) return 1;

  const full = normalizeCitationText(fullText);
  let haystack = full;
  if (seconds !== null) {
    const windowText = segments
      .filter(
        (segment) =>
          seconds - CITATION_WINDOW_BEFORE_SECONDS <= segment.seconds &&
          segment.seconds <= seconds + CITATION_WINDOW_AFTER_SECONDS,
      )
      .map((segment) => segment.text)
      .join(" ");
    if (windowText.length > MIN_WINDOW_TEXT_LENGTH) haystack = windowText;
  }

  const hits = quoteWords.filter((word) => haystack.includes(word)).length;
  return hits / quoteWords.length;
}
