/**
 * The job spine's data model.
 *
 * `RawCapture` is deliberately ONE discriminated union: a producer supplies an
 * arm and `writeCapture` renders the exact CONTEXT frontmatter mapping for that
 * arm. No later stage repeats a key mapping.
 */

export type JobKind = "youtube" | "web";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** `done` is terminal; every other value names the stage to run next. */
export type StageName = "S0" | "S1" | "S1w" | "done";

export type JobEventType = "job" | "stage" | "unit" | "error" | "done";

/** A video the S0 enumeration selected. `title` feeds the capture slug. */
export interface VideoCandidate {
  youtubeId: string;
  title: string;
  url: string;
  published?: string;
  durationSec?: number;
  channel?: string;
  language?: string;
}

/** The reason a unit was not captured. `capture_invalid` is the immutability guard. */
export type SkipReason =
  | "no_captions"
  | "blocked"
  | "timeout"
  | "fetch_error"
  | "empty_transcript"
  | "capture_invalid";

export interface SkippedUnit {
  slug: string;
  youtubeId?: string;
  stage: "S0" | "S1" | "S1w";
  reason: SkipReason;
  detail?: string;
}

/**
 * What the ingest form resolves to, snapshotted into `job.json` at creation.
 *
 * The global non-secret settings (`settings/store.ts`) are spread into this
 * record, so a later `PUT /api/settings` cannot change a queued or running job.
 * The runner reads only `filters` and `maxVideos`; the remaining fields are
 * carried verbatim for Phase 4.
 */
export interface JobSettings {
  maxVideos: number;
  filters: {
    publishedAfter?: string;
    publishedBefore?: string;
    minDurationSec?: number;
    language?: string;
  };
  /** Stored and rendered in Phase 3; consumed in Phase 4. Not an active limit yet. */
  fetch: { concurrency: number; delayMs?: number; language?: string };
  llm: {
    model: string;
    concurrency?: number;
    requestTimeoutMs?: number;
    maxRetries?: number;
  };
  sweep?: { enabled: boolean };
  ui?: { theme: "system" | "light" | "dark" };
}

export interface JobInput {
  /** The requested channel or page URL, exactly as the user submitted it. */
  url: string;
}

export interface JobProgress {
  done: number;
  total: number;
}

export interface JobRecord {
  id: string;
  vaultId: string;
  kind: JobKind;
  status: JobStatus;
  /** Absent before the first run; otherwise the stage to run next. */
  stage?: StageName;
  input: JobInput;
  settings: JobSettings;
  createdAt: string;
  updatedAt: string;
  progress: JobProgress;
  skipped: SkippedUnit[];
  error: string | null;
  cancelRequested: boolean;
}

/** One `events.ndjson` line. `seq` starts at 1 and increases by one. */
export interface JobEvent {
  seq: number;
  type: JobEventType;
  data: Record<string, unknown>;
  at: string;
}

/** One timestamped caption segment, in whole seconds. */
export interface TranscriptSegment {
  startSec: number;
  text: string;
}

export interface VideoRawCapture {
  kind: "video";
  slug: string;
  url: string;
  youtubeId: string;
  /** TypeScript-only: builds the slug, never rendered as a frontmatter key. */
  title: string;
  published?: string;
  durationSec?: number;
  tier: 1 | 2 | 3;
  fetchedAt: string;
  segments: TranscriptSegment[];
}

export interface WebRawCapture {
  kind: "web";
  slug: string;
  /** The requested URL, so a repeat job finds the capture before any fetch. */
  url: string;
  site: string;
  /** TypeScript-only: builds the slug, never rendered as a frontmatter key. */
  title: string;
  capturedAt: string;
  wordCount: number;
  warning?: "short_page";
  paragraphs: string[];
}

export type RawCapture = VideoRawCapture | WebRawCapture;

/**
 * A tagged adapter failure. Adapters throw this to name the skip reason; the
 * runner prefers it over the injected classifier.
 */
export class SkipError extends Error {
  readonly reason: SkipReason;
  readonly detail?: string;

  constructor(reason: SkipReason, detail?: string) {
    super("unit skipped");
    this.name = "SkipError";
    this.reason = reason;
    this.detail = detail;
  }
}
