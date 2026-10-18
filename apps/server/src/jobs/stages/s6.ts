/**
 * S6: the opt-in sweep (UI-11).
 *
 * S6 runs only when the job snapshot says `settings.sweep.enabled === true`.
 * It re-fills label pages that S4 left as a code fallback, or whose overview
 * has fewer than two paragraphs, and records one notability score per page in
 * the job-scoped `notability.json`.
 *
 * S6 never reads a raw capture and never deletes a page. Bodies flow through
 * the same `renderLabelPage` code path as S4, so frontmatter, citations and
 * typed edges stay code-owned.
 */
import { readFile } from "node:fs/promises";
import { compareCodepoint, parseFrontmatter, slugify } from "@2nd-brain/okf";
import { z } from "zod";
import { callCached, createLlmCache } from "../../llm/cache.js";
import {
  JsonRecoveryError,
  pageBodyIssue,
  rawPathForAttempt,
} from "../../llm/json.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../llm/ollama.js";
import type { LlmMessage } from "../../llm/ollama.js";
import { resolveInVault } from "../../paths/jail.js";
import { listExtractions } from "../extraction.js";
import { readManifest, readTaxonomy, type ManifestRecord } from "../manifest.js";
import {
  readNotability,
  writeNotability,
  type NotabilityRecord,
} from "../notability.js";
import { pagePathFor } from "../pages.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { appendEvent, readJob } from "../store.js";
import type { JobRecord, SkipReason, SkippedUnit } from "../types.js";
import { redactDetail } from "./fetch.js";
import {
  buildPageRequests,
  renderLabelPage,
  type PageRequest,
} from "./s4.js";
import { collectBundlePages, LOG_PATH } from "./s5.js";

/** Bumping this invalidates every cached S6 reply. */
export const PROMPT_VERSION_S6 = "s6-v1";

/** The job-relative notability path template. */
export const NOTABILITY_PATH = ".okf/jobs/<id>/notability.json";

/** Sweep targets per model call. */
export const SWEEP_PER_CALL = 5;

/** The final log line S6 owns. */
const SWEEP_LOG_LINE = "sweep: true";

/** The rules the model sees for one sweep call. */
const SWEEP_RULES = `You fill short knowledge pages and score how notable each one is.

Return ONLY one JSON object:
{"pages": [{"slug": "<request slug>", "body": "<2 to 4 paragraphs>", "notable": <0 to 1>}]}

- "slug" is copied exactly from its request.
- "body" is 2 to 4 paragraphs of plain prose, separated by a blank line.
- Do not add a heading, a markdown link, frontmatter or a "## Sources" section.
- "notable" is a number from 0 to 1.

Output the JSON object itself. Do not wrap it in a fence or add prose.`;

/** A slug that could not be normalised is treated as an unknown entry. */
function normaliseSlug(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return slugify(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * The sweep reply contract: one entry per request with a 2-4 paragraph body
 * and a 0..1 score. A bad entry rejects the reply, which then records a
 * retryable `malformed_json` skip and leaves the pages untouched.
 */
export const SweepSchema = z
  .object({
    pages: z.array(
      z.object({
        slug: z.unknown(),
        body: z.string(),
        notable: z.number(),
      }),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.pages.forEach((page, index) => {
      const issue = pageBodyIssue(page.body);
      if (issue !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["pages", index, "body"],
          message: issue,
        });
      }
    });
  })
  .transform((value) => ({
    pages: value.pages.map((page) => ({
      slug: normaliseSlug(page.slug),
      body: page.body.trim(),
      notable: Math.min(1, Math.max(0, page.notable)),
    })),
  }));

/** One manifest label S6 may rewrite. */
export interface SweepTarget {
  slug: string;
  kind: "concept" | "entity";
  entityType?: string;
  title: string;
}

/** Non-empty paragraphs in a page's `## Overview` section. */
function overviewParagraphCount(text: string): number {
  const parsed = parseFrontmatter(text);
  if (parsed === null) return 0;
  const match = /(?:^|\n)## Overview\n+([\s\S]*?)(?=\n## |\s*$)/.exec(
    parsed.body,
  );
  if (match === null) return 0;
  return (match[1] as string)
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== "").length;
}

/**
 * The manifest labels S6 should re-fill: a label with an S4 skip entry (the
 * code fallback) or a written page whose overview has fewer than two
 * paragraphs. Sorted by slug.
 */
export async function collectSweepTargets(
  job: JobRecord,
  manifest: ManifestRecord,
  vaultDir: string,
): Promise<SweepTarget[]> {
  const skippedAtS4 = new Set(
    job.skipped
      .filter((entry) => entry.stage === "S4")
      .map((entry) => entry.slug),
  );

  const labels: SweepTarget[] = [
    ...manifest.concepts.map((concept) => ({
      slug: concept.slug,
      kind: "concept" as const,
      title: concept.title,
    })),
    ...manifest.entities.map((entity) => ({
      slug: entity.slug,
      kind: "entity" as const,
      entityType: entity.type,
      title: entity.title,
    })),
  ];

  const targets: SweepTarget[] = [];
  for (const label of labels) {
    let pageText: string | null = null;
    try {
      const relPath = pagePathFor(label.kind, label.slug, label.entityType);
      const { absPath } = await resolveInVault(vaultDir, relPath);
      pageText = await readFile(absPath, "utf8");
    } catch {
      pageText = null;
    }
    if (
      skippedAtS4.has(label.slug) ||
      pageText === null ||
      overviewParagraphCount(pageText) < 2
    ) {
      targets.push(label);
    }
  }
  return targets.sort((left, right) => compareCodepoint(left.slug, right.slug));
}

/**
 * The label slugs a retry narrows S6 to, or `null` for a full sweep. A retry
 * that re-runs any earlier stage (S2/S3/S4) rebuilds the manifest or the
 * pages, so the whole target set is evaluated, exactly like S4's barrier.
 */
export function s6Scope(job: JobRecord): ReadonlySet<string> | null {
  if (job.retry === undefined) return null;
  const barrier = job.retry.units.some(
    (unit) => unit.stage === "S2" || unit.stage === "S3" || unit.stage === "S4",
  );
  if (barrier) return null;
  return new Set(
    job.retry.units
      .filter((unit) => unit.stage === "S6")
      .map((unit) => unit.slug),
  );
}

/**
 * Rewrite `log.md` with one final `sweep: true` line. A second S6 run over the
 * same log does not add the line twice.
 */
export async function writeSweepLog(
  deps: StageDeps,
  vaultDir: string,
): Promise<void> {
  let text = "";
  try {
    const { absPath } = await resolveInVault(vaultDir, LOG_PATH);
    text = await readFile(absPath, "utf8");
  } catch {
    text = "";
  }
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.split("\n").at(-1) === SWEEP_LOG_LINE) return;
  const base = trimmed === "" ? "" : `${trimmed}\n`;
  await deps.writePage(vaultDir, LOG_PATH, `${base}${SWEEP_LOG_LINE}\n`);
}

/** The system rules and one user line per sweep target. */
function sweepMessages(requests: readonly PageRequest[]): LlmMessage[] {
  return [
    {
      role: "system",
      content: `${SWEEP_RULES}\nPrompt version: ${PROMPT_VERSION_S6}.`,
    },
    {
      role: "user",
      content: requests.map((request) => JSON.stringify(request)).join("\n"),
    },
  ];
}

/** Split an array into fixed-size batches. */
function batchSlices<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** The skip reason for one failed batch. */
function failureReason(error: unknown): SkipReason {
  return error instanceof JsonRecoveryError ? "malformed_json" : "model_error";
}

/** Record one retryable S6 skip and its event. */
async function recordSkip(
  job: JobRecord,
  dir: string,
  slug: string,
  reason: SkipReason,
  detail: string | undefined,
  persist: () => Promise<void>,
): Promise<void> {
  const skipped: SkippedUnit = { slug, stage: "S6", reason };
  if (detail !== undefined) skipped.detail = detail;
  job.skipped.push(skipped);
  await persist();
  await appendEvent(dir, "unit", {
    slug,
    stage: "S6",
    status: "skipped",
    reason: skipped.reason,
    detail: skipped.detail,
  });
}

/**
 * Build the S6 stage. The stage-list gate lives in `stagesFor`, so a job with
 * sweep off never reaches this function.
 */
export function createS6Stage(deps: StageDeps) {
  return async function runS6(
    job: JobRecord,
    ctx: UnitContext,
    dir: string,
    persist: () => Promise<void>,
  ): Promise<boolean> {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    const manifest = await readManifest(dir);
    if (manifest === null) {
      await writeSweepLog(deps, ctx.vaultDir);
      return false;
    }

    const allTargets = await collectSweepTargets(job, manifest, ctx.vaultDir);
    // A retry narrows the sweep to its recorded S6 units, unless it also
    // re-runs an earlier stage, which rebuilds the target set. A target
    // outside the scope makes no call and no event, so its page stays
    // untouched.
    const scope = s6Scope(job);
    const targets =
      scope === null
        ? allTargets
        : allTargets.filter((target) => scope.has(target.slug));
    await writeSweepLog(deps, ctx.vaultDir);
    if (targets.length === 0) {
      // Nothing was evaluated, so the stored triage stays as it was (CR-02).
      return false;
    }

    const taxonomy = await readTaxonomy(dir);
    const records = await listExtractions(dir);
    const requests = new Map(
      buildPageRequests(manifest, records, taxonomy).map(
        (request) => [request.slug, request] as const,
      ),
    );

    // Every written page can satisfy an edge, and every target gets a page, so
    // the visible set matches what S4b resolved against.
    const basePages = await collectBundlePages(ctx.vaultDir);
    const visible = new Set(basePages.map((page) => page.path));
    for (const target of targets) {
      visible.add(pagePathFor(target.kind, target.slug, target.entityType));
    }

    const cache = createLlmCache(deps.cacheDirFor(job.vaultId));
    const options = {
      model: job.settings.llm.model,
      baseUrl: job.settings.llm.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      timeoutMs: job.settings.llm.requestTimeoutMs ?? 180_000,
      maxRetries: job.settings.llm.maxRetries ?? 4,
      stage: "S6" as const,
      promptVersion: PROMPT_VERSION_S6,
      at: job.createdAt,
    };

    const accepted = new Map<string, { body: string; notable: number }>();
    const failures = new Map<
      string,
      { reason: SkipReason; detail: string | undefined }
    >();

    const batches = batchSlices(targets, SWEEP_PER_CALL);
    for (let index = 0; index < batches.length; index += 1) {
      const current = await readJob(ctx.vaultDir, job.id);
      job.cancelRequested = current.cancelRequested;
      if (job.cancelRequested) return true;

      const batch = batches[index] as SweepTarget[];
      const batchRequests = batch.flatMap((target) => {
        const request = requests.get(target.slug);
        return request === undefined ? [] : [request];
      });
      try {
        const result = await callCached(
          cache,
          deps.llm,
          {
            ...options,
            messages: sweepMessages(batchRequests),
            rawPathForAttempt: (attempt) =>
              rawPathForAttempt(dir, "S6", `sweep-${index}`, attempt),
          },
          SweepSchema,
        );
        for (const entry of result.output.pages) {
          if (entry.slug === undefined) continue;
          if (!requests.has(entry.slug)) continue;
          if (accepted.has(entry.slug)) continue;
          accepted.set(entry.slug, {
            body: entry.body,
            notable: entry.notable,
          });
        }
      } catch (error) {
        const reason = failureReason(error);
        const detail =
          redactDetail(error instanceof Error ? error.message : String(error)) ??
          reason;
        for (const target of batch) failures.set(target.slug, { reason, detail });
      }
    }

    const scores: NotabilityRecord["scores"] = [];
    for (const target of targets) {
      const entry = accepted.get(target.slug);
      const request = requests.get(target.slug);
      if (entry === undefined || request === undefined) {
        const failure = failures.get(target.slug);
        await recordSkip(
          job,
          dir,
          target.slug,
          failure?.reason ?? "malformed_json",
          failure?.detail ?? "missing body",
          persist,
        );
        continue;
      }

      const { relPath, text } = renderLabelPage(
        request,
        entry.body,
        manifest,
        records,
        visible,
        job.createdAt,
      );
      await deps.writePage(ctx.vaultDir, relPath, text);
      scores.push({ slug: target.slug, score: entry.notable });
      await appendEvent(dir, "unit", {
        slug: target.slug,
        stage: "S6",
        status: "written",
      });
    }

    // A retry merges into the stored triage, so scores for targets it did not
    // evaluate survive. A full run replaces the record (CR-02).
    if (job.retry === undefined) {
      await writeNotability(dir, { scores, at: job.createdAt });
    } else {
      const previous = await readNotability(dir);
      const merged = new Map(
        (previous?.scores ?? []).map((score) => [score.slug, score.score] as const),
      );
      for (const score of scores) merged.set(score.slug, score.score);
      await writeNotability(dir, {
        scores: [...merged].map(([slug, score]) => ({ slug, score })),
        at: previous?.at ?? job.createdAt,
      });
    }
    return false;
  };
}
