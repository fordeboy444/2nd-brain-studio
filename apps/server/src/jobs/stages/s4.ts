/**
 * S4: the manifest becomes the bundle's pages (OKF-07, PIPE-03).
 *
 * S4a writes every `sources/<slug>.md` page in code from the extraction file and
 * the manifest. It makes no model call, never opens `raw/`, and every timestamp
 * it writes is the extraction record's own capture time.
 *
 * S4b asks the model only for the 2-4 paragraph body of a concept or entity
 * page. Frontmatter, `sources:`, `## Sources` and every typed edge are
 * assembled here, so a model omission cannot produce an uncited page.
 *
 * S4b runs first, because a source page links only to label pages that exist.
 * Every extraction is read once, through `listExtractions`, before either half.
 */
import { compareCodepoint } from "@2nd-brain/okf";
import { callCached, createLlmCache } from "../../llm/cache.js";
import { PageBodiesSchema, rawPathForAttempt } from "../../llm/json.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../llm/ollama.js";
import type { LlmMessage } from "../../llm/ollama.js";
import {
  listExtractions,
  type ExtractionRecord,
  type ExtractionSource,
} from "../extraction.js";
import {
  readManifest,
  readTaxonomy,
  type ManifestRecord,
  type ManifestSource,
  type TaxonomyRecord,
} from "../manifest.js";
import {
  pagePathFor,
  renderConceptPage,
  renderEntityPage,
  renderSourcePage,
  sourcePageInput,
  type LabelPageSource,
  type PageEdge,
  type PageEdgeKind,
  type SourcePageConcept,
  type SourcePageEntity,
  type SourcePageInput,
  type SourcePageQuote,
} from "../pages.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { appendEvent, readJob } from "../store.js";
import type { JobRecord, SkippedUnit } from "../types.js";
import { redactDetail } from "./fetch.js";

/** Bumping this invalidates every cached S4b reply. S4a makes no call. */
export const PROMPT_VERSION_S4 = "s4-v1";

/**
 * Label bodies per model call (T-P4-18). A large channel grows the call count
 * linearly instead of building one huge prompt.
 */
export const PAGES_PER_CALL = 5;

/** The body rules the model sees. Every structure key stays in code. */
const PAGE_BODY_RULES = `You write the body of knowledge pages.

Return ONLY one JSON array with one entry per request:
[{"slug": "<request slug>", "body": "<2 to 4 paragraphs>"}]

- "slug" is copied exactly from its request.
- "body" is 2 to 4 paragraphs of plain prose, separated by a blank line.
- Do not add a heading, a markdown link, frontmatter or a "## Sources" section.
- Do not invent an edge, a citation or a source.
- Use only the material in the request.

Output the JSON array itself. Do not wrap it in a fence or add prose.`;

/** One concept or entity body the model is asked to write. */
export interface PageRequest {
  slug: string;
  title: string;
  kind: "concept" | "entity";
  /** Entities only. */
  entityType?: string;
  tags: string[];
  sources: Array<{ slug: string; title: string; summary: string }>;
  /** The manifest edges, as plain text. The model never writes a link from them. */
  edges: string[];
}

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

/** The manifest labels with a written page that name this source. */
function conceptsFor(
  manifest: ManifestRecord,
  sourceSlug: string,
  written: ReadonlySet<string>,
): SourcePageConcept[] {
  return manifest.concepts
    .filter(
      (concept) =>
        concept.sources.includes(sourceSlug) &&
        written.has(pagePathFor("concept", concept.slug)),
    )
    .map((concept) => ({ name: concept.title, slug: concept.slug }))
    .sort((left, right) => compareCodepoint(left.slug, right.slug));
}

/** The manifest entities with a written page that name this source. */
function entitiesFor(
  manifest: ManifestRecord,
  sourceSlug: string,
  written: ReadonlySet<string>,
): SourcePageEntity[] {
  return manifest.entities
    .filter(
      (entity) =>
        entity.sources.includes(sourceSlug) &&
        written.has(pagePathFor("entity", entity.slug, entity.type)),
    )
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
  written: ReadonlySet<string>,
): SourcePageInput {
  const concepts = conceptsFor(manifest, source.slug, written);
  const entities = entitiesFor(manifest, source.slug, written);

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
 * A source page links only to label pages already in `written`, so no source
 * page can carry a broken link. A missing extraction is data, not an
 * exception: the partial page is written and a skipped S4 unit records that
 * the page is not backed by an extraction.
 */
export async function renderSourcePages(
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  deps: StageDeps,
  manifest: ManifestRecord,
  _taxonomy: TaxonomyRecord | null,
  records: ReadonlyMap<string, ExtractionRecord>,
  written: Set<string>,
  persist: () => Promise<void>,
): Promise<S4RunResult> {
  for (const source of manifest.sources) {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return { written, cancelled: true };

    const record = records.get(source.slug) ?? null;
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
      renderSourcePage(manifestSourceInput(source, manifest, record, written)),
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
 * One request per manifest concept and entity, sorted by slug.
 *
 * A request carries derived text only: source titles, extraction summaries,
 * tags and plain-text edges. It never carries a transcript, a full page or a
 * quote longer than the extraction cap.
 */
export function buildPageRequests(
  manifest: ManifestRecord,
  extractions: readonly ExtractionRecord[],
  _taxonomy: TaxonomyRecord | null,
): PageRequest[] {
  const summaries = new Map(
    extractions.map((record) => [record.source.slug, record.summary.trim()] as const),
  );
  const sourceBySlug = new Map(
    manifest.sources.map((source) => [source.slug, source] as const),
  );
  const titles = new Map<string, string>();
  for (const concept of manifest.concepts) titles.set(concept.slug, concept.title);
  for (const entity of manifest.entities) titles.set(entity.slug, entity.title);
  for (const source of manifest.sources) titles.set(source.slug, source.title);

  const sourceBlocks = (slugs: readonly string[]): PageRequest["sources"] =>
    sortedUnique(slugs).flatMap((slug) => {
      const source = sourceBySlug.get(slug);
      if (source === undefined) return [];
      return [
        {
          slug,
          title: source.title,
          summary: summaries.get(slug) ?? "",
        },
      ];
    });

  const edgesOf = (slug: string): string[] =>
    manifest.edges
      .filter((edge) => edge.from === slug)
      .map((edge) => `${edge.kind}: ${titles.get(edge.to) ?? edge.to}`)
      .sort(compareCodepoint);

  const requests: PageRequest[] = [];
  for (const concept of manifest.concepts) {
    requests.push({
      slug: concept.slug,
      title: concept.title,
      kind: "concept",
      tags: sortedUnique(concept.tags),
      sources: sourceBlocks(concept.sources),
      edges: edgesOf(concept.slug),
    });
  }
  for (const entity of manifest.entities) {
    requests.push({
      slug: entity.slug,
      title: entity.title,
      kind: "entity",
      entityType: entity.type,
      tags: sortedUnique(entity.tags),
      sources: sourceBlocks(entity.sources),
      edges: edgesOf(entity.slug),
    });
  }
  return requests.sort((left, right) => compareCodepoint(left.slug, right.slug));
}

/** One copy of each value, sorted by codepoint. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

/**
 * The system message (body rules) and one user line per request. A call over
 * the cap is a programming error, never a bigger prompt.
 */
export function buildPageMessages(
  requests: readonly PageRequest[],
): LlmMessage[] {
  if (requests.length === 0) {
    throw new Error("a page call needs at least one request");
  }
  if (requests.length > PAGES_PER_CALL) {
    throw new Error(`a page call holds at most ${PAGES_PER_CALL} requests`);
  }
  return [
    {
      role: "system",
      content: `${PAGE_BODY_RULES}\nPrompt version: ${PROMPT_VERSION_S4}.`,
    },
    {
      role: "user",
      content: requests.map((request) => JSON.stringify(request)).join("\n"),
    },
  ];
}

/** The call options every S4b batch uses, taken from the job snapshot. */
function pageCallOptions(job: JobRecord) {
  return {
    model: job.settings.llm.model,
    baseUrl: job.settings.llm.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    timeoutMs: job.settings.llm.requestTimeoutMs ?? 180_000,
    maxRetries: job.settings.llm.maxRetries ?? 4,
    stage: "S4",
    promptVersion: PROMPT_VERSION_S4,
    at: job.createdAt,
  };
}

/** The code fallback body: the source summaries, or one truthful sentence. */
function fallbackBody(request: PageRequest): string {
  const summaries: string[] = [];
  for (const source of request.sources) {
    const summary = source.summary.trim();
    if (summary !== "" && !summaries.includes(summary)) summaries.push(summary);
  }
  if (summaries.length === 0) {
    return `No extraction summary was available for ${request.title}.`;
  }
  return summaries.join("\n\n");
}

/** The quotes one source extraction stored, for the `## Sources` bullet. */
function quotesFor(
  records: readonly ExtractionRecord[],
  slug: string,
): SourcePageQuote[] {
  const record = records.find((candidate) => candidate.source.slug === slug);
  return record === undefined ? [] : (record.quotes as SourcePageQuote[]);
}

/** The typed edges that name this label and resolve to a written page. */
function pageEdges(
  manifest: ManifestRecord,
  slug: string,
  written: ReadonlySet<string>,
): PageEdge[] {
  const concepts = new Map(
    manifest.concepts.map((concept) => [concept.slug, concept] as const),
  );
  const entities = new Map(
    manifest.entities.map((entity) => [entity.slug, entity] as const),
  );
  const edges: PageEdge[] = [];
  for (const edge of manifest.edges) {
    if (edge.from !== slug || edge.to === slug) continue;
    const concept = concepts.get(edge.to);
    if (
      concept !== undefined &&
      written.has(pagePathFor("concept", concept.slug))
    ) {
      edges.push({
        kind: edge.kind as PageEdgeKind,
        target: { kind: "concept", slug: concept.slug, title: concept.title },
      });
      continue;
    }
    const entity = entities.get(edge.to);
    if (
      entity !== undefined &&
      written.has(pagePathFor("entity", entity.slug, entity.type))
    ) {
      edges.push({
        kind: edge.kind as PageEdgeKind,
        target: {
          kind: "entity",
          slug: entity.slug,
          title: entity.title,
          entityType: entity.type,
        },
      });
    }
  }
  return edges;
}

/** Split an array into fixed-size batches. */
function batchSlices<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * S4b: ask for bounded page bodies, then wrap each one in code (T-P4-14,
 * T-P4-16, T-P4-17, T-P4-18).
 *
 * Only a `{slug, body}` entry for a requested slug is accepted. A rejected or
 * missing body becomes the code fallback plus a retryable `model_error` skip,
 * so no page ships without its code-owned citations and edges.
 */
export async function renderLabelPages(
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  deps: StageDeps,
  manifest: ManifestRecord,
  taxonomy: TaxonomyRecord | null,
  records: readonly ExtractionRecord[],
  written: Set<string>,
  persist: () => Promise<void>,
): Promise<boolean> {
  const requests = buildPageRequests(manifest, records, taxonomy);
  if (requests.length === 0) return false;

  const cache = createLlmCache(deps.cacheDirFor(job.vaultId));
  const options = pageCallOptions(job);
  const requested = new Set(requests.map((request) => request.slug));
  const bodies = new Map<string, string>();
  const failures = new Map<string, string>();

  // Every request gets a page, so an edge to a requested label resolves even
  // before that page is written. A filtered label has no request and no page.
  const labelPaths = new Set(
    requests.map((request) =>
      pagePathFor(request.kind, request.slug, request.entityType),
    ),
  );
  const visible = new Set([...written, ...labelPaths]);

  const batches = batchSlices(requests, PAGES_PER_CALL);
  for (let index = 0; index < batches.length; index += 1) {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    const batch = batches[index] as PageRequest[];
    try {
      const result = await callCached(
        cache,
        deps.llm,
        {
          ...options,
          messages: buildPageMessages(batch),
          rawPathForAttempt: (attempt) =>
            rawPathForAttempt(dir, "S4", `pages-${index}`, attempt),
        },
        PageBodiesSchema,
      );
      for (const entry of result.output) {
        // T-P4-16: an unknown slug is ignored, and the first entry wins.
        if (!requested.has(entry.slug)) continue;
        if (bodies.has(entry.slug)) continue;
        bodies.set(entry.slug, entry.body);
      }
    } catch (error) {
      const detail =
        redactDetail(error instanceof Error ? error.message : String(error)) ??
        "model_error";
      for (const request of batch) failures.set(request.slug, detail);
    }
  }

  for (const request of requests) {
    const body = bodies.get(request.slug);
    const hasBody = body !== undefined;
    if (!hasBody) {
      const skipped: SkippedUnit = {
        slug: request.slug,
        stage: "S4",
        reason: "model_error",
        detail: failures.get(request.slug) ?? "missing body",
      };
      job.skipped.push(skipped);
      await persist();
      await appendEvent(dir, "unit", {
        slug: request.slug,
        stage: "S4",
        status: "skipped",
        reason: skipped.reason,
        detail: skipped.detail,
      });
    }

    const sources: LabelPageSource[] = request.sources.map((source) => ({
      slug: source.slug,
      title: source.title,
      quotes: quotesFor(records, source.slug),
    }));
    const input = {
      slug: request.slug,
      title: request.title,
      tags: request.tags,
      sources,
      body: body ?? fallbackBody(request),
      edges: pageEdges(manifest, request.slug, visible),
      created: job.createdAt,
      updated: job.createdAt,
    };
    const relPath =
      request.kind === "concept"
        ? pagePathFor("concept", request.slug)
        : pagePathFor("entity", request.slug, request.entityType);
    const text =
      request.kind === "concept"
        ? renderConceptPage(input)
        : renderEntityPage({
            ...input,
            entityType: request.entityType ?? "",
          });
    await deps.writePage(ctx.vaultDir, relPath, text);
    written.add(relPath);
    await appendEvent(dir, "unit", {
      slug: request.slug,
      stage: "S4",
      status: "written",
    });
  }

  return false;
}

/**
 * Build the S4 stage. It runs S4a, then the bounded S4b model path.
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

    // One read of every extraction serves both S4a and S4b.
    const records = await listExtractions(dir);
    const bySlug = new Map(
      records.map((record) => [record.source.slug, record] as const),
    );
    const written = new Set<string>();

    // S4b first: a source page links only to label pages that exist.
    const labelsCancelled = await renderLabelPages(
      job,
      ctx,
      dir,
      deps,
      manifest,
      taxonomy,
      records,
      written,
      persist,
    );
    if (labelsCancelled) return true;

    const sourceResult = await renderSourcePages(
      job,
      ctx,
      dir,
      deps,
      manifest,
      taxonomy,
      bySlug,
      written,
      persist,
    );
    return sourceResult.cancelled;
  };
}
