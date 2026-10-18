/**
 * The job-scoped extraction artifact (PIPE-03, PIPE-06).
 *
 * S2 is the only stage allowed to open a raw capture. Everything downstream
 * reads `extractions/<slug>.json` instead, so the transcript is read exactly
 * once per run. The file therefore carries the source metadata later stages
 * need: `source.rawPath`, `source.fetchedAt` and the exact identity keys.
 *
 * Every timestamp in a record comes from the capture, never from a clock read:
 * `at` is the capture's own `fetchedAt`/`capturedAt`. Two runs over the same
 * capture therefore write byte-identical JSON, whether the reply came from the
 * network or from the cache.
 *
 * A slug names a file inside the job directory, so it is validated against the
 * same closed shape the job id uses before any `join` (T-P4-05). A file that
 * does not parse, or whose slug does not match the one asked for, is `null`
 * rather than a partial record.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CITATION_OVERLAP_THRESHOLD,
  citationScore,
  parseVideoSegments,
} from "@2nd-brain/okf";
import type { OkfFrontmatter } from "@2nd-brain/okf";
import { z } from "zod";
import {
  EDGE_KINDS,
  ENTITY_TYPES,
  type Extraction,
} from "../llm/json.js";
import { writeJsonAtomic } from "../http/writeAtomic.js";

/** A capture slug is kebab-case and can never name a directory or an escape. */
export const EXTRACTION_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A parsed raw capture plus the slug it was stored under. */
export interface CaptureDocument {
  slug: string;
  /** Null when the file exists but its frontmatter is absent or unparseable. */
  frontmatter: OkfFrontmatter | null;
  body: string;
  raw: string;
}

/**
 * The stable source block every later stage reads instead of `raw/`.
 *
 * `duration` stays whole seconds here; only the rendered page formats it.
 */
export interface ExtractionSource {
  slug: string;
  title: string;
  sourceKind: "video" | "web";
  youtubeId?: string;
  url?: string;
  published?: string;
  /** Whole seconds. */
  duration?: number;
  /** Vault-relative, always `raw/<slug>.md`. */
  rawPath: string;
  /** The capture's own timestamp; the record `at` is the same value. */
  fetchedAt: string;
  site?: string;
  wordCount?: number;
}

/** One stored quote. A web quote carries no timestamp at all. */
export interface StoredQuote {
  text: string;
  startSec?: number;
}

/**
 * The extraction file. It wraps the CONTEXT extraction fields so a later stage
 * needs no capture read, and adds `partial` only for a failed S2 unit.
 */
export type ExtractionRecord = Omit<Extraction, "quotes"> & {
  quotes: StoredQuote[];
  source: ExtractionSource;
  at: string;
  partial?: true;
};

function stringField(
  data: OkfFrontmatter | null,
  key: string,
): string | undefined {
  if (data === null) return undefined;
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberField(
  data: OkfFrontmatter | null,
  key: string,
): number | undefined {
  if (data === null) return undefined;
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The capture arm, read from the frontmatter `source_kind`. */
export function captureKind(capture: CaptureDocument): "video" | "web" | null {
  const kind = stringField(capture.frontmatter, "source_kind");
  if (kind === "video" || kind === "web") return kind;
  return null;
}

/**
 * A human-readable title for a capture.
 *
 * `writeCapture` deliberately renders no `title:` key (it is TypeScript-only on
 * the capture arm), so the frontmatter normally has none. The fallback derives
 * one from the slug instead of inventing content.
 */
export function captureTitle(capture: CaptureDocument): string {
  const stored = stringField(capture.frontmatter, "title");
  if (stored !== undefined) return stored;
  return titleFromSlug(capture.slug);
}

/** `agentic-workflow-engineering` -> `Agentic workflow engineering`. */
export function titleFromSlug(slug: string): string {
  const words = slug.split("-").filter((word) => word !== "");
  if (words.length === 0) return slug;
  const first = words[0] as string;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(
    " ",
  );
}

/**
 * The one stable timestamp for a capture: `fetched_at` for a video,
 * `captured_at` for a web page. Never a clock read.
 */
export function captureFetchedAt(capture: CaptureDocument): string {
  const kind = captureKind(capture);
  const value =
    kind === "web"
      ? stringField(capture.frontmatter, "captured_at")
      : stringField(capture.frontmatter, "fetched_at");
  if (value === undefined) {
    throw new Error("capture has no fetch timestamp");
  }
  return value;
}

/**
 * Build the source block from the capture's own frontmatter. No body text is
 * copied, and the timestamp is the capture's, not the run's.
 */
export function sourceFromCapture(capture: CaptureDocument): ExtractionSource {
  const kind = captureKind(capture);
  if (kind === null) {
    throw new Error("capture has no source_kind");
  }
  const source: ExtractionSource = {
    slug: capture.slug,
    title: captureTitle(capture),
    sourceKind: kind,
    rawPath: `raw/${capture.slug}.md`,
    fetchedAt: captureFetchedAt(capture),
  };
  const url = stringField(capture.frontmatter, "url");
  if (url !== undefined) source.url = url;

  if (kind === "video") {
    const youtubeId = stringField(capture.frontmatter, "youtube_id");
    if (youtubeId !== undefined) source.youtubeId = youtubeId;
    const published = stringField(capture.frontmatter, "published");
    if (published !== undefined) source.published = published;
    const duration = numberField(capture.frontmatter, "duration");
    if (duration !== undefined) source.duration = duration;
    return source;
  }

  const site = stringField(capture.frontmatter, "site");
  if (site !== undefined) source.site = site;
  const wordCount = numberField(capture.frontmatter, "word_count");
  if (wordCount !== undefined) source.wordCount = wordCount;
  return source;
}

/**
 * The transcript text S2 sends to the model.
 *
 * A video line becomes `[H:MM:SS] text` (the capture's `**[H:MM:SS]**` wrapper
 * is removed but the timestamp stays). A web body loses its `## Extracted
 * text` heading and every `**[#n]**` paragraph anchor.
 */
export function transcriptText(capture: CaptureDocument): string {
  if (captureKind(capture) === "web") return webTranscriptText(capture.body);
  return videoTranscriptText(capture.body);
}

function videoTranscriptText(body: string): string {
  const lines: string[] = [];
  // Split on the marker prefix: the head before the first marker is the
  // `## Transcript` heading and is not a segment.
  for (const part of body.split("**[").slice(1)) {
    const close = part.indexOf("]");
    if (close === -1) continue;
    const timestamp = part.slice(0, close);
    let text = part.slice(close + 1);
    if (text.startsWith("**")) text = text.slice(2);
    lines.push(`[${timestamp}] ${text.trim()}`);
  }
  return lines.join("\n");
}

function webTranscriptText(body: string): string {
  return body
    .replace(/^\s*## Extracted text[^\n]*\n+/, "")
    .replace(/\*\*\[#\d+\]\*\*\s*/g, "")
    .trim();
}

/**
 * Drop every quote the raw capture cannot support (OKF-06, E8).
 *
 * A model asked to copy quotes still paraphrases sometimes. The reference
 * scoring rule decides: a quote survives when at least 55% of its significant
 * words occur in its cited window (video) or anywhere in the page (web). A
 * dropped quote is never replaced, so the page cites fewer claims rather than
 * a claim the source does not make.
 */
export function filterQuotes(
  extraction: Extraction,
  rawBody: string,
  kind: "video" | "web",
): Extraction {
  const segments = kind === "video" ? parseVideoSegments(rawBody) : [];
  const quotes = extraction.quotes.filter((quote) => {
    const seconds = kind === "video" ? (quote.startSec ?? null) : null;
    return (
      citationScore(quote.text, segments, rawBody, seconds) >=
      CITATION_OVERLAP_THRESHOLD
    );
  });
  return { ...extraction, quotes };
}

/**
 * Wrap a validated extraction in the stable source block. The capture slug is
 * authoritative: a model reply cannot redirect the write to another page.
 */
export function toExtractionRecord(
  extraction: Extraction,
  capture: CaptureDocument,
  at: string = captureFetchedAt(capture),
): ExtractionRecord {
  const source = sourceFromCapture(capture);
  const title = extraction.title !== "" ? extraction.title : source.title;
  const quotes: StoredQuote[] =
    source.sourceKind === "web"
      ? extraction.quotes.map((quote) => ({ text: quote.text }))
      : extraction.quotes.map((quote) => ({
          text: quote.text,
          startSec: quote.startSec,
        }));

  return {
    slug: capture.slug,
    title,
    thesis: extraction.thesis,
    summary: extraction.summary,
    tags: extraction.tags,
    concepts: extraction.concepts,
    entities: extraction.entities,
    quotes,
    relations: extraction.relations,
    source,
    at,
  };
}

/** `<jobDir>/extractions/<slug>.json`, after the slug shape is proven. */
export function extractionPath(jobDir: string, slug: string): string {
  if (!EXTRACTION_SLUG_RE.test(slug)) {
    throw new Error("invalid extraction slug");
  }
  return join(jobDir, "extractions", `${slug}.json`);
}

const storedSlug = z.string().regex(EXTRACTION_SLUG_RE);

const StoredConceptSchema = z
  .object({
    name: z.string(),
    slug: storedSlug,
    weight: z.number(),
  })
  .strict();

const StoredEntitySchema = z
  .object({
    name: z.string(),
    slug: storedSlug,
    type: z.enum(ENTITY_TYPES),
    weight: z.number(),
  })
  .strict();

const StoredQuoteSchema = z
  .object({
    text: z.string(),
    startSec: z.number().optional(),
  })
  .strict();

const StoredRelationSchema = z
  .object({
    to: storedSlug,
    kind: z.enum(EDGE_KINDS),
  })
  .strict();

const StoredSourceSchema = z
  .object({
    slug: storedSlug,
    title: z.string(),
    sourceKind: z.enum(["video", "web"]),
    youtubeId: z.string().optional(),
    url: z.string().optional(),
    published: z.string().optional(),
    duration: z.number().optional(),
    rawPath: z.string(),
    fetchedAt: z.string(),
    site: z.string().optional(),
    wordCount: z.number().optional(),
  })
  .strict();

/**
 * The full stored shape. A record missing an array or a source field is not
 * usable: S3 spreads `tags` and iterates `concepts`/`entities` before it can
 * record a skip, so a half-record would fail the whole job unretryably
 * (WR-02).
 */
const StoredExtractionSchema = z
  .object({
    slug: storedSlug,
    title: z.string(),
    thesis: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    concepts: z.array(StoredConceptSchema),
    entities: z.array(StoredEntitySchema),
    quotes: z.array(StoredQuoteSchema),
    relations: z.array(StoredRelationSchema),
    source: StoredSourceSchema,
    at: z.string(),
    partial: z.literal(true).optional(),
  })
  .strict();

/** A stored record is usable only when its identity matches the requested one. */
function parseExtractionRecord(
  value: unknown,
  slug: string,
): ExtractionRecord | null {
  const result = StoredExtractionSchema.safeParse(value);
  if (!result.success) return null;
  if (result.data.slug !== slug) return null;
  return result.data;
}

/**
 * Read one extraction. A missing file, an unparseable file or a record whose
 * identity does not match is `null`; the caller re-extracts once.
 */
export async function readExtraction(
  jobDir: string,
  slug: string,
): Promise<ExtractionRecord | null> {
  let raw: string;
  try {
    raw = await readFile(extractionPath(jobDir, slug), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseExtractionRecord(parsed, slug);
}

/** Write one extraction through the atomic temp+rename writer. */
export async function writeExtraction(
  jobDir: string,
  record: ExtractionRecord,
): Promise<void> {
  await writeJsonAtomic(extractionPath(jobDir, record.slug), record);
}

/**
 * Every usable extraction in a job directory, sorted by slug. One corrupt file
 * is skipped so it cannot stop a later stage's scan.
 */
export async function listExtractions(
  jobDir: string,
): Promise<ExtractionRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(jobDir, "extractions"));
  } catch {
    return [];
  }

  const records: ExtractionRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const slug = name.slice(0, -".json".length);
    if (!EXTRACTION_SLUG_RE.test(slug)) continue;
    const record = await readExtraction(jobDir, slug).catch(() => null);
    if (record !== null) records.push(record);
  }
  return records;
}
