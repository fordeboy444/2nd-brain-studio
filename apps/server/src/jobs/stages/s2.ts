/**
 * S2: one raw capture becomes one validated, content-addressed extraction.
 *
 * This is the only stage allowed to open `raw/`. Everything after it reads
 * `extractions/<slug>.json`, so the transcript is read exactly once per run and
 * a later stage never needs the raw page (PIPE-03).
 *
 * The call goes through `callCached`, so an identical re-run over the same vault
 * makes zero network calls. A hit still writes the job-scoped extraction file:
 * the cache is vault-global, the extraction is per job, and S3 needs one in
 * every job directory.
 *
 * Every timestamp written (`at`, `created`, `updated`) is the capture's own
 * fetch time, never a clock read, so a hit and a miss write the same bytes.
 */
import { readdir } from "node:fs/promises";
import { callCached, createLlmCache } from "../../llm/cache.js";
import {
  ExtractionSchema,
  JsonRecoveryError,
  rawPathForAttempt,
} from "../../llm/json.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../llm/ollama.js";
import type { LlmMessage } from "../../llm/ollama.js";
import { resolveInVault } from "../../paths/jail.js";
import { readCapture } from "../capture.js";
import {
  captureFetchedAt,
  captureTitle,
  EXTRACTION_SLUG_RE,
  filterQuotes,
  readExtraction,
  sourceFromCapture,
  toExtractionRecord,
  transcriptText,
  writeExtraction,
  type CaptureDocument,
  type ExtractionRecord,
  type ExtractionSource,
} from "../extraction.js";
import { redactDetail } from "./fetch.js";
import {
  renderSourcePage,
  sourcePageInput,
  type SourcePageInput,
} from "../pages.js";
import { appendEvent, readJob } from "../store.js";
import {
  SkipError,
  type JobRecord,
  type SkipReason,
  type SkippedUnit,
} from "../types.js";
import type { StageDeps, UnitContext } from "../runner.js";

/** Bumping this invalidates every cached S2 reply without touching the model. */
export const PROMPT_VERSION_S2 = "s2-v1";

/** What the prompt builder needs; it never receives the whole capture body twice. */
export interface S2PromptRecord {
  title: string;
  kind: "video" | "web";
  transcript: string;
}

const EXTRACTION_RULES = `You extract structured knowledge from one source.

Return ONLY one JSON object, with exactly these keys and no others:
slug, title, thesis, summary, tags, concepts, entities, quotes, relations.

- "slug": a kebab-case identifier for the source.
- "title": the source's title.
- "thesis": one sentence stating the source's central claim.
- "summary": two to four sentences summarising the source.
- "tags": 3 to 8 lowercase kebab-case topic tags.
- "concepts": an array of {"name", "slug", "weight"} where weight is 0 to 1.
  A concept is an idea or technique the source explains.
- "entities": an array of {"name", "slug", "type", "weight"} where type is one
  of tool, person, organization, product, framework, concept or unknown.
- "quotes": an array of {"text", "startSec"}. Copy each quote word for word
  from the transcript; never paraphrase, and never invent one.
- "relations": an array of {"to", "kind"} where "to" is a kebab-case slug and
  "kind" is one of builds_on, part_of, contrasts_with or related_to.

Output the JSON object itself. Do not wrap it in a fence or add prose.`;

/**
 * The two messages one S2 call sends. The transcript is untrusted input, so it
 * arrives in the user message and every rule lives in the system message.
 */
export function buildS2Messages(
  record: S2PromptRecord,
  promptVersion: string,
): LlmMessage[] {
  const quoteRule =
    record.kind === "video"
      ? "Every quote must carry the startSec of the line it appears on."
      : "Every quote must use startSec: 0; this source has no timestamps.";
  return [
    {
      role: "system",
      content: `${EXTRACTION_RULES}\n${quoteRule}\nPrompt version: ${promptVersion}.`,
    },
    {
      role: "user",
      content: `Title: ${record.title}\nKind: ${record.kind}\n\nTranscript:\n${record.transcript}`,
    },
  ];
}

/** One capture, resolved once, carrying the slug it was stored under. */
async function readCaptureOnce(
  vaultDir: string,
  slug: string,
): Promise<CaptureDocument | null> {
  const capture = await readCapture(vaultDir, slug);
  if (capture === null) return null;
  return { slug, ...capture };
}

/**
 * S5 writes `raw/index.md` into the same folder. It is a generated index, not
 * a capture, so S2 must never read it as one.
 */
const GENERATED_RAW_SLUGS: ReadonlySet<string> = new Set(["index"]);

/** Every capture `.md` under `raw/`, as slugs, sorted. */
async function captureSlugs(vaultDir: string): Promise<string[]> {
  const { absPath } = await resolveInVault(vaultDir, "raw");
  let names: string[];
  try {
    names = await readdir(absPath);
  } catch {
    return [];
  }
  return names
    .sort()
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter((slug) => EXTRACTION_SLUG_RE.test(slug))
    .filter((slug) => !GENERATED_RAW_SLUGS.has(slug));
}

/** The record a failed unit still leaves behind, so the raw index keeps its row. */
function partialRecord(capture: CaptureDocument): ExtractionRecord {
  return {
    slug: capture.slug,
    title: captureTitle(capture),
    thesis: "",
    summary: "",
    tags: [],
    concepts: [],
    entities: [],
    quotes: [],
    relations: [],
    source: sourceFromCapture(capture),
    at: captureFetchedAt(capture),
    partial: true,
  };
}

function pageInput(record: ExtractionRecord): SourcePageInput {
  return sourcePageInput(record);
}

/** The reason a failed S2 unit records; nothing else ever reaches `skipped[]`. */
function reasonFor(error: unknown): SkipReason {
  if (error instanceof JsonRecoveryError) return "malformed_json";
  if (error instanceof SkipError) {
    return error.reason === "llm_not_configured"
      ? "llm_not_configured"
      : "model_error";
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      code === "ETIMEDOUT"
    ) {
      return "model_timeout";
    }
  }
  return "model_error";
}

/** The bounded detail persisted with the skip. */
function detailFor(error: unknown): string | undefined {
  if (error instanceof SkipError) return error.detail ?? error.reason;
  if (error instanceof Error) return error.message;
  return String(error);
}

export type S2Stage = (
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  persist: () => Promise<void>,
) => Promise<boolean>;

/**
 * Build the S2 stage. The LLM client, the cache root and the page writer all
 * arrive through `StageDeps`; this module never reaches a path or the network
 * itself.
 */
export function createS2Stage(deps: StageDeps): S2Stage {
  return async function runS2(
    job: JobRecord,
    ctx: UnitContext,
    dir: string,
    persist: () => Promise<void>,
  ): Promise<boolean> {
    const vaultDir = ctx.vaultDir;
    const slugs = await captureSlugs(vaultDir);
    const cache = createLlmCache(deps.cacheDirFor(job.vaultId));
    // A retry narrows the loop to its recorded S2 units. A good unit makes no
    // call and emits no event, so the earlier run's output stays untouched.
    const retrySlugs =
      job.retry === undefined
        ? null
        : new Set(
            job.retry.units
              .filter((unit) => unit.stage === "S2")
              .map((unit) => unit.slug),
          );

    for (const slug of slugs) {
      const latest = await readJob(vaultDir, job.id);
      job.cancelRequested = latest.cancelRequested;
      if (job.cancelRequested) return true;
      if (retrySlugs !== null && !retrySlugs.has(slug)) continue;

      const capture = await readCaptureOnce(vaultDir, slug);
      if (capture === null) continue;

      let source: ExtractionSource;
      try {
        source = sourceFromCapture(capture);
        captureFetchedAt(capture);
      } catch {
        // A capture whose metadata cannot be read has no source block to write.
        const skipped: SkippedUnit = {
          slug,
          stage: "S2",
          reason: "capture_invalid",
        };
        job.skipped.push(skipped);
        await persist();
        await appendEvent(dir, "unit", {
          slug,
          stage: "S2",
          status: "skipped",
          reason: skipped.reason,
        });
        continue;
      }

      // A complete record is authoritative: only a missing or partial one is
      // worth another paid call. A partial record is retried exactly once.
      const existing = await readExtraction(dir, slug);
      if (existing !== null && existing.partial !== true) {
        await appendEvent(dir, "unit", {
          slug,
          stage: "S2",
          status: "skipped",
          detail: "extraction present",
        });
        continue;
      }

      try {
        const messages = buildS2Messages(
          {
            title: source.title,
            kind: source.sourceKind,
            transcript: transcriptText(capture),
          },
          PROMPT_VERSION_S2,
        );

        const result = await callCached(
          cache,
          deps.llm,
          {
            model: job.settings.llm.model,
            baseUrl: job.settings.llm.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
            timeoutMs: job.settings.llm.requestTimeoutMs ?? 180_000,
            maxRetries: job.settings.llm.maxRetries ?? 4,
            stage: "S2",
            promptVersion: PROMPT_VERSION_S2,
            messages,
            at: captureFetchedAt(capture),
            rawPathForAttempt: (attempt) =>
              rawPathForAttempt(dir, "S2", slug, attempt),
          },
          ExtractionSchema,
        );

        // Every stored quote has to be a real citation of the raw capture.
        const verified = filterQuotes(
          result.output,
          capture.body,
          source.sourceKind,
        );
        const record = toExtractionRecord(verified, capture, result.at);
        await writeExtraction(dir, record);
        await deps.writePage(
          vaultDir,
          `sources/${slug}.md`,
          renderSourcePage(pageInput(record)),
        );

        await persist();
        await appendEvent(dir, "unit", {
          slug,
          stage: "S2",
          status: "written",
          ...(result.hit ? { detail: "cache hit" } : {}),
        });
      } catch (error) {
        // One bad unit never fails the job: it leaves a partial page, a
        // partial extraction (so the raw index keeps one row per capture) and
        // a typed skip, then the loop moves on.
        const reason = reasonFor(error);
        const detail = redactDetail(detailFor(error));
        const record = partialRecord(capture);

        try {
          await writeExtraction(dir, record);
        } catch {
          // A failed write must not stop the remaining captures.
        }
        try {
          await deps.writePage(
            vaultDir,
            `sources/${slug}.md`,
            renderSourcePage(pageInput(record)),
          );
        } catch {
          // Same: the skip below is still recorded.
        }

        const skipped: SkippedUnit = { slug, stage: "S2", reason };
        if (source.sourceKind === "video" && source.youtubeId !== undefined) {
          skipped.youtubeId = source.youtubeId;
        }
        if (detail !== undefined) skipped.detail = detail;
        job.skipped.push(skipped);

        await persist();
        await appendEvent(dir, "unit", {
          slug,
          stage: "S2",
          status: "skipped",
          reason,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
    }

    const final = await readJob(vaultDir, job.id);
    job.cancelRequested = final.cancelRequested;
    return job.cancelRequested;
  };
}
