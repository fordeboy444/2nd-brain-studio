/**
 * S4: the manifest becomes the bundle's pages (OKF-07, PIPE-03).
 *
 * S4a writes every `sources/<slug>.md` page in code from the extraction file and
 * the manifest. It makes no model call, never opens `raw/`, and every timestamp
 * it writes is the extraction record's own capture time.
 *
 * S4b (added in Task 2) asks the model only for the 2-4 paragraph body of a
 * concept or entity page. Frontmatter, `sources:`, `## Sources` and every typed
 * edge are assembled here, so a model omission cannot produce an uncited page.
 */
import { compareCodepoint } from "@2nd-brain/okf";
import { readExtraction, type ExtractionRecord, type ExtractionSource } from "../extraction.js";
import {
  readManifest,
  readTaxonomy,
  type ManifestRecord,
  type ManifestSource,
  type TaxonomyRecord,
} from "../manifest.js";
import {
  pagePathFor,
  renderSourcePage,
  sourcePageInput,
  type SourcePageConcept,
  type SourcePageEntity,
  type SourcePageInput,
} from "../pages.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { appendEvent, readJob } from "../store.js";
import type { JobRecord, SkippedUnit } from "../types.js";

/** Bumping this invalidates every cached S4b reply. S4a makes no call. */
export const PROMPT_VERSION_S4 = "s4-v1";

export type S4Stage = (
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  persist: () => Promise<void>,
) => Promise<boolean>;

/** What one S4 run wrote, and whether a cancel interrupted it. */
export interface S4RunResult {
  /** Bundle-relative paths of the pages this run wrote. */
  written: Set<string>;
  cancelled: boolean;
}

/** The manifest labels that name this source, as page links. */
function conceptsFor(
  manifest: ManifestRecord,
  sourceSlug: string,
): SourcePageConcept[] {
  return manifest.concepts
    .filter((concept) => concept.sources.includes(sourceSlug))
    .map((concept) => ({ name: concept.title, slug: concept.slug }))
    .sort((left, right) => compareCodepoint(left.slug, right.slug));
}

/** The manifest entities that name this source, as page links. */
function entitiesFor(
  manifest: ManifestRecord,
  sourceSlug: string,
): SourcePageEntity[] {
  return manifest.entities
    .filter((entity) => entity.sources.includes(sourceSlug))
    .map((entity) => ({ name: entity.title, slug: entity.slug, type: entity.type }))
    .sort((left, right) => compareCodepoint(left.slug, right.slug));
}

/** The source block a manifest-only partial page renders from. */
function manifestExtractionSource(
  source: ManifestSource,
  at: string,
): ExtractionSource {
  const block: ExtractionSource = {
    slug: source.slug,
    title: source.title,
    sourceKind: source.kind,
    rawPath: `raw/${source.slug}.md`,
    fetchedAt: at,
  };
  if (source.youtube_id !== undefined) block.youtubeId = source.youtube_id;
  if (source.url !== undefined) block.url = source.url;
  if (source.duration !== undefined) block.duration = source.duration;
  return block;
}

/**
 * The page input for one manifest source.
 *
 * A complete extraction supplies the summary, thesis and quotes. A missing one
 * still yields a truthful partial page from what the manifest carries, so a
 * source link never breaks and the bundle still lints.
 */
export function manifestSourceInput(
  source: ManifestSource,
  manifest: ManifestRecord,
  record: ExtractionRecord | null,
): SourcePageInput {
  const concepts = conceptsFor(manifest, source.slug);
  const entities = entitiesFor(manifest, source.slug);

  if (record !== null) {
    return {
      ...sourcePageInput(record, record.partial === true),
      concepts,
      entities,
    };
  }

  return {
    slug: source.slug,
    title: source.title,
    kind: source.kind,
    thesis: "",
    summary: "",
    tags: source.tags,
    concepts,
    entities,
    quotes: [],
    source: manifestExtractionSource(source, manifest.at),
    created: manifest.at,
    updated: manifest.at,
    partial: true,
    rawPath: `raw/${source.slug}.md`,
  };
}

/**
 * S4a: one page per manifest source, built in code (T-P4-14, T-P4-15).
 *
 * The extraction is read exactly once per source. A missing extraction is data,
 * not an exception: the partial page is written and a skipped S4 unit records
 * that the page is not backed by an extraction.
 */
export async function renderSourcePages(
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  deps: StageDeps,
  manifest: ManifestRecord,
  _taxonomy: TaxonomyRecord | null,
  persist: () => Promise<void>,
): Promise<S4RunResult> {
  const written = new Set<string>();

  for (const source of manifest.sources) {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return { written, cancelled: true };

    const record = await readExtraction(dir, source.slug);
    if (record === null) {
      const skipped: SkippedUnit = {
        slug: source.slug,
        stage: "S4",
        reason: "capture_invalid",
        detail: "extraction missing",
      };
      job.skipped.push(skipped);
      await persist();
      await appendEvent(dir, "unit", {
        slug: source.slug,
        stage: "S4",
        status: "skipped",
        reason: skipped.reason,
        detail: skipped.detail,
      });
    }

    const relPath = pagePathFor("source", source.slug);
    await deps.writePage(
      ctx.vaultDir,
      relPath,
      renderSourcePage(manifestSourceInput(source, manifest, record)),
    );
    written.add(relPath);
    await appendEvent(dir, "unit", {
      slug: source.slug,
      stage: "S4",
      status: "written",
    });
  }

  return { written, cancelled: false };
}

/**
 * Build the S4 stage. In this task it runs S4a only; Task 2 adds the bounded
 * model path for concept and entity bodies.
 */
export function createS4Stage(deps: StageDeps): S4Stage {
  return async function runS4(
    job: JobRecord,
    ctx: UnitContext,
    dir: string,
    persist: () => Promise<void>,
  ): Promise<boolean> {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    const manifest = await readManifest(dir);
    const taxonomy = await readTaxonomy(dir);
    if (manifest === null) return false;

    const result = await renderSourcePages(
      job,
      ctx,
      dir,
      deps,
      manifest,
      taxonomy,
      persist,
    );
    return result.cancelled;
  };
}
