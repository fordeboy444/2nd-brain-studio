/**
 * S3: the label-space barrier (PIPE-03, OKF-08; T-P4-10, T-P4-11, T-P4-12).
 *
 * One read of every extraction happens before the first model call. From there
 * the stage decides in code which labels deserve a page, canonicalises only the
 * survivors in batches of at most 35, derives every typed edge from the
 * extractions, and writes `manifest.json` plus `taxonomy.json`.
 *
 * The model can rename a label, never create or keep one. A reply that arrives
 * malformed costs one batch: the failed unit is recorded as a retryable
 * `skipped[]` entry and the stage continues with the batches that survived.
 *
 * This module never opens `raw/`. Its only input is `extractions/<slug>.json`.
 */
import { compareCodepoint } from "@2nd-brain/okf";
import { callCached, createLlmCache } from "../../llm/cache.js";
import type { LlmCache } from "../../llm/cache.js";
import type { EntityType } from "../../llm/json.js";
import {
  CanonicalizeSchema,
  EDGE_KINDS,
  JsonRecoveryError,
  TaxonomyResponseSchema,
  rawPathForAttempt,
} from "../../llm/json.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../llm/ollama.js";
import type { LlmClient, LlmMessage } from "../../llm/ollama.js";
import { listExtractions } from "../extraction.js";
import type { ExtractionRecord, ExtractionSource } from "../extraction.js";
import {
  LABEL_BATCH_SIZE,
  sortedUnique,
  writeManifest,
  writeTaxonomy,
  type FilteredCandidate,
  type ManifestConcept,
  type ManifestEdge,
  type ManifestEntity,
  type ManifestRecord,
  type ManifestSource,
  type TaxonomyRecord,
  type TaxonomyTheme,
} from "../manifest.js";
import { appendEvent, readJob } from "../store.js";
import type { JobRecord, SkipReason, SkippedUnit } from "../types.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { redactDetail } from "./fetch.js";

/** Bumping this invalidates every cached S3 reply, canonicalise and taxonomy. */
export const PROMPT_VERSION_S3 = "s3-v1";

/** One label occurrence, or the merged candidate for one exact slug. */
export interface LabelCandidate {
  slug: string;
  kind: "concept" | "entity";
  title: string;
  tags: string[];
  sources: string[];
  weight: number;
  /** Entities only. A concept leaves it undefined. */
  type?: EntityType;
}

/** `kind:origin-slug` -> the canonical slug the label resolved to. */
export type LabelMapping = Map<string, string>;

/** Everything one S3 call needs; the stage builds it once. */
export interface S3CallContext {
  job: JobRecord;
  llm: LlmClient;
  cache: LlmCache;
  dir: string;
}

/** A batch the model could not answer; the stage turns it into a skip. */
export interface BatchFailure {
  unit: string;
  reason: SkipReason;
  detail?: string;
}

export interface CanonicalizeResult {
  labels: LabelCandidate[];
  mapping: LabelMapping;
  failures: BatchFailure[];
}

export interface TaxonomyResult {
  concept_themes: TaxonomyTheme[];
  tool_themes: TaxonomyTheme[];
  source_clusters: TaxonomyTheme[];
  failures: BatchFailure[];
}

export type S3Stage = (
  job: JobRecord,
  ctx: UnitContext,
  dir: string,
  persist: () => Promise<void>,
) => Promise<boolean>;

const CANONICALIZE_RULES = `You canonicalise knowledge labels collected from many sources.

Return ONLY one JSON object with exactly one key: "labels".
Its value is an array with one entry per input label:
{"from": "<input slug>", "to": "<canonical slug>", "title": "<title>", "tags": ["<tag>"], "aliases": ["<alias>"]}

- "from" is an input slug, copied exactly.
- "to" is a kebab-case slug for the one canonical label.
- Inputs that name the same idea share the same "to".
- "title" is a short human-readable name.
- "tags" are lowercase kebab-case topic tags.
- "aliases" are alternative names for the same label.

Output the JSON object itself. Do not wrap it in a fence or add prose.`;

const TAXONOMY_RULES = `You group knowledge labels into themes.

Return ONLY one JSON object with exactly these keys and no others:
concept_themes, tool_themes, source_clusters.
Each value is an array of {"name", "slug", "members"}.
- "members" are slugs copied from the input labels.
- A theme with no members is omitted.
- Never invent a slug that is not in the input.

Output the JSON object itself. Do not wrap it in a fence or add prose.`;

function bySlugKind(left: LabelCandidate, right: LabelCandidate): number {
  return compareCodepoint(left.slug, right.slug) || compareCodepoint(left.kind, right.kind);
}

/** The label identity key. Concept and entity never collapse into each other. */
function keyOf(kind: LabelCandidate["kind"], slug: string): string {
  return `${kind}:${slug}`;
}

/**
 * Merge exact-slug duplicates in code before any model call (OKF-08).
 *
 * Exact slug only: fuzzy merging is the model's job, and a silent code merge
 * could collapse two genuinely different tools. Source slugs union, tags union,
 * the weight takes the maximum, and the first non-empty title in slug order
 * wins. A merged-away duplicate is never recorded in `filtered`.
 */
export function mergeDuplicates(
  labels: readonly LabelCandidate[],
): LabelCandidate[] {
  const merged = new Map<string, LabelCandidate>();
  const ordered = [...labels].sort(bySlugKind);

  for (const label of ordered) {
    const key = keyOf(label.kind, label.slug);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        slug: label.slug,
        kind: label.kind,
        title: label.title,
        tags: sortedUnique(label.tags),
        sources: sortedUnique(label.sources),
        weight: label.weight,
        ...(label.type !== undefined ? { type: label.type } : {}),
      });
      continue;
    }

    existing.sources = sortedUnique([...existing.sources, ...label.sources]);
    existing.tags = sortedUnique([...existing.tags, ...label.tags]);
    existing.weight = Math.max(existing.weight, label.weight);
    if (existing.title === "" && label.title !== "") existing.title = label.title;
    if (
      existing.kind === "entity" &&
      (existing.type === undefined || existing.type === "unknown") &&
      label.type !== undefined &&
      label.type !== "unknown"
    ) {
      existing.type = label.type;
    }
  }

  return [...merged.values()].sort(bySlugKind);
}

/**
 * Every concept and entity named by an extraction, keyed by exact slug and
 * already merged. The source tags of a label are the tags of the extractions
 * that named it; the deep-dive decision later reads the same source blocks.
 */
export function collectLabels(
  records: readonly ExtractionRecord[],
): LabelCandidate[] {
  const occurrences: LabelCandidate[] = [];

  for (const record of records) {
    const tags = [...record.tags];
    for (const concept of record.concepts) {
      occurrences.push({
        slug: concept.slug,
        kind: "concept",
        title: concept.name !== "" ? concept.name : concept.slug,
        tags,
        sources: [record.slug],
        weight: concept.weight,
      });
    }
    for (const entity of record.entities) {
      occurrences.push({
        slug: entity.slug,
        kind: "entity",
        title: entity.name !== "" ? entity.name : entity.slug,
        tags,
        sources: [record.slug],
        weight: entity.weight,
        type: entity.type,
      });
    }
  }

  return mergeDuplicates(occurrences);
}

/** `ceil(n / LABEL_BATCH_SIZE)`, the one place a batch cap is calculated. */
function batchSlices<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += LABEL_BATCH_SIZE) {
    batches.push(items.slice(index, index + LABEL_BATCH_SIZE));
  }
  return batches;
}

/** The label payload both S3 prompts send: names, slugs, counts and tags only. */
function labelPayload(labels: readonly LabelCandidate[]): string {
  return labels
    .map((label) =>
      JSON.stringify({
        kind: label.kind,
        slug: label.slug,
        name: label.title,
        sourceCount: label.sources.length,
        tags: label.tags,
      }),
    )
    .join("\n");
}

function stageMessages(
  rules: string,
  labels: readonly LabelCandidate[],
  promptVersion: string,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `${rules}\nPrompt version: ${promptVersion}.`,
    },
    { role: "user", content: labelPayload(labels) },
  ];
}

function reasonForError(error: unknown): SkipReason {
  if (error instanceof JsonRecoveryError) return "malformed_json";
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

function detailFor(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The job-snapshot options every paid S3 call uses. */
function callOptions(job: JobRecord) {
  return {
    model: job.settings.llm.model,
    baseUrl: job.settings.llm.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    timeoutMs: job.settings.llm.requestTimeoutMs ?? 180_000,
    maxRetries: job.settings.llm.maxRetries ?? 4,
    stage: "S3",
    promptVersion: PROMPT_VERSION_S3,
    at: job.createdAt,
  };
}

function failureFrom(unit: string, error: unknown): BatchFailure {
  const detail = redactDetail(detailFor(error));
  return {
    unit,
    reason: reasonForError(error),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Canonicalise the surviving labels, at most 35 per call, in slug order.
 *
 * A malformed batch keeps its own labels under their original slugs and titles
 * (identity), so every source still resolves to a manifest label. It never
 * rethrows: the failure is recorded and the next batch runs.
 */
export async function canonicalizeLabels(
  labels: readonly LabelCandidate[],
  context: S3CallContext,
): Promise<CanonicalizeResult> {
  const ordered = [...labels].sort(bySlugKind);
  const batches = batchSlices(ordered);
  const options = callOptions(context.job);
  const failures: BatchFailure[] = [];
  const specs = new Map<
    string,
    { to: string; title: string; tags: string[] }
  >();

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] as LabelCandidate[];
    const messages = stageMessages(CANONICALIZE_RULES, batch, PROMPT_VERSION_S3);
    try {
      const result = await callCached(
        context.cache,
        context.llm,
        {
          ...options,
          messages,
          rawPathForAttempt: (attempt) =>
            rawPathForAttempt(context.dir, "S3", `labels-${index}`, attempt),
        },
        CanonicalizeSchema,
      );

      // The model may answer in any order; applying mappings by `from` sort
      // keeps the resulting manifest independent of that order.
      for (const label of [...result.output.labels].sort((left, right) =>
        compareCodepoint(left.from, right.from),
      )) {
        if (specs.has(label.from)) continue;
        specs.set(label.from, {
          to: label.to,
          title: label.title,
          tags: label.tags,
        });
      }
    } catch (error) {
      failures.push(failureFrom(`labels-${index}`, error));
    }
  }

  const merged = new Map<string, LabelCandidate>();
  const mapping: LabelMapping = new Map();

  for (const origin of ordered) {
    const spec = specs.get(origin.slug);
    const to = spec?.to ?? origin.slug;
    mapping.set(keyOf(origin.kind, origin.slug), to);

    const key = keyOf(origin.kind, to);
    const tags =
      spec !== undefined ? sortedUnique([...origin.tags, ...spec.tags]) : origin.tags;
    const title = spec !== undefined && spec.title !== "" ? spec.title : origin.title;
    const existing = merged.get(key);

    if (existing === undefined) {
      merged.set(key, {
        slug: to,
        kind: origin.kind,
        title,
        tags: sortedUnique(tags),
        sources: sortedUnique(origin.sources),
        weight: origin.weight,
        ...(origin.type !== undefined ? { type: origin.type } : {}),
      });
      continue;
    }

    existing.sources = sortedUnique([...existing.sources, ...origin.sources]);
    existing.tags = sortedUnique([...existing.tags, ...tags]);
    existing.weight = Math.max(existing.weight, origin.weight);
    if (existing.title === "" && title !== "") existing.title = title;
    if (
      existing.kind === "entity" &&
      (existing.type === undefined || existing.type === "unknown") &&
      origin.type !== undefined &&
      origin.type !== "unknown"
    ) {
      existing.type = origin.type;
    }
  }

  return {
    labels: [...merged.values()].sort(bySlugKind),
    mapping,
    failures,
  };
}

function conceptOf(label: LabelCandidate): ManifestConcept {
  return {
    slug: label.slug,
    title: label.title,
    tags: sortedUnique(label.tags),
    sources: sortedUnique(label.sources),
    weight: label.weight,
  };
}

function entityOf(label: LabelCandidate): ManifestEntity {
  return {
    slug: label.slug,
    title: label.title,
    type: label.type ?? "unknown",
    tags: sortedUnique(label.tags),
    sources: sortedUnique(label.sources),
    weight: label.weight,
  };
}

/**
 * The source entry for one extraction. Its label lists are resolved through the
 * canonical mapping, so a source page names only labels that have a page.
 *
 * `youtube_id`/`url` and `duration` are copied from the extraction's own source
 * block: an S4a fallback page passes lint rule E5 without opening `raw/`.
 */
export function manifestSourceFor(
  record: ExtractionRecord,
  mapping: LabelMapping,
): ManifestSource | null {
  const source: ExtractionSource = record.source;
  const concepts = sortedUnique(
    record.concepts.flatMap((concept) => {
      const to = mapping.get(keyOf("concept", concept.slug));
      return to === undefined ? [] : [to];
    }),
  );
  const entities = sortedUnique(
    record.entities.flatMap((entity) => {
      const to = mapping.get(keyOf("entity", entity.slug));
      return to === undefined ? [] : [to];
    }),
  );

  const entry: ManifestSource = {
    slug: source.slug,
    title: source.title,
    kind: source.sourceKind,
    tags: sortedUnique(record.tags),
    concepts,
    entities,
  };

  if (source.sourceKind === "video") {
    if (source.youtubeId === undefined) return null;
    entry.youtube_id = source.youtubeId;
    if (source.duration !== undefined) {
      entry.duration = Math.max(0, Math.trunc(source.duration));
    }
    return entry;
  }

  if (source.url === undefined) return null;
  entry.url = source.url;
  return entry;
}

/**
 * Derive every typed edge from the extraction relations and filter it against
 * the manifest (T-P4-10). The model has no field that can add an edge, and an
 * unresolved target or an unknown kind is dropped.
 */
export function deriveEdges(
  records: readonly ExtractionRecord[],
  concepts: readonly ManifestConcept[],
  entities: readonly ManifestEntity[],
  mapping: LabelMapping = new Map(),
): ManifestEdge[] {
  const conceptSlugs = new Set(concepts.map((concept) => concept.slug));
  const entitySlugs = new Set(entities.map((entity) => entity.slug));
  const seen = new Set<string>();
  const edges: ManifestEdge[] = [];

  const resolveTarget = (target: string): string | undefined => {
    const mapped =
      mapping.get(keyOf("concept", target)) ?? mapping.get(keyOf("entity", target));
    if (mapped !== undefined) {
      return conceptSlugs.has(mapped) || entitySlugs.has(mapped) ? mapped : undefined;
    }
    return conceptSlugs.has(target) || entitySlugs.has(target) ? target : undefined;
  };

  for (const record of records) {
    const froms = sortedUnique([
      ...record.concepts.flatMap((concept) => {
        const to = mapping.get(keyOf("concept", concept.slug));
        return to !== undefined && conceptSlugs.has(to) ? [to] : [];
      }),
      ...record.entities.flatMap((entity) => {
        const to = mapping.get(keyOf("entity", entity.slug));
        return to !== undefined && entitySlugs.has(to) ? [to] : [];
      }),
    ]);

    for (const relation of record.relations) {
      const allowed = (EDGE_KINDS as readonly string[]).includes(relation.kind);
      if (!allowed) continue;
      const target = resolveTarget(relation.to);
      if (target === undefined) continue;

      for (const from of froms) {
        if (from === target) continue;
        const id = `${from}\u0000${target}\u0000${relation.kind}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ from, to: target, kind: relation.kind });
      }
    }
  }

  return edges.sort(
    (left, right) =>
      compareCodepoint(left.from, right.from) ||
      compareCodepoint(left.to, right.to) ||
      compareCodepoint(left.kind, right.kind),
  );
}

function mergeThemes(
  target: Map<string, TaxonomyTheme>,
  themes: readonly TaxonomyTheme[],
): void {
  for (const theme of themes) {
    const existing = target.get(theme.slug);
    if (existing === undefined) {
      target.set(theme.slug, {
        name: theme.name,
        slug: theme.slug,
        members: sortedUnique(theme.members),
      });
      continue;
    }
    existing.members = sortedUnique([...existing.members, ...theme.members]);
  }
}

function normalizeThemes(
  themes: Map<string, TaxonomyTheme>,
  allowed: ReadonlySet<string>,
): TaxonomyTheme[] {
  const output: TaxonomyTheme[] = [];
  for (const theme of themes.values()) {
    const members = sortedUnique(theme.members.filter((member) => allowed.has(member)));
    if (members.length === 0) continue;
    output.push({ name: theme.name, slug: theme.slug, members });
  }
  return output.sort(
    (left, right) =>
      compareCodepoint(left.slug, right.slug) || compareCodepoint(left.name, right.name),
  );
}

/**
 * Group the canonical labels into themes, 35 labels per call. Members are
 * filtered to slugs the manifest actually contains, an empty theme is dropped,
 * and a failed batch contributes no themes instead of aborting the stage.
 */
export async function buildTaxonomy(
  labels: readonly LabelCandidate[],
  manifest: Pick<ManifestRecord, "concepts" | "entities" | "sources">,
  context: S3CallContext,
): Promise<TaxonomyResult> {
  const ordered = [...labels].sort(bySlugKind);
  const batches = batchSlices(ordered);
  const options = callOptions(context.job);
  const failures: BatchFailure[] = [];

  const conceptThemes = new Map<string, TaxonomyTheme>();
  const toolThemes = new Map<string, TaxonomyTheme>();
  const sourceClusters = new Map<string, TaxonomyTheme>();

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] as LabelCandidate[];
    const messages = stageMessages(TAXONOMY_RULES, batch, PROMPT_VERSION_S3);
    try {
      const result = await callCached(
        context.cache,
        context.llm,
        {
          ...options,
          messages,
          rawPathForAttempt: (attempt) =>
            rawPathForAttempt(context.dir, "S3", `taxonomy-${index}`, attempt),
        },
        TaxonomyResponseSchema,
      );
      mergeThemes(conceptThemes, result.output.concept_themes);
      mergeThemes(toolThemes, result.output.tool_themes);
      mergeThemes(sourceClusters, result.output.source_clusters);
    } catch (error) {
      failures.push(failureFrom(`taxonomy-${index}`, error));
    }
  }

  const labelSlugs = new Set([
    ...manifest.concepts.map((concept) => concept.slug),
    ...manifest.entities.map((entity) => entity.slug),
  ]);
  const sourceSlugs = new Set(manifest.sources.map((source) => source.slug));

  return {
    concept_themes: normalizeThemes(conceptThemes, labelSlugs),
    tool_themes: normalizeThemes(toolThemes, labelSlugs),
    source_clusters: normalizeThemes(sourceClusters, sourceSlugs),
    failures,
  };
}

/** Persist one failed batch as a retryable stage-S3 unit, then carry on. */
async function recordFailures(
  failures: readonly BatchFailure[],
  job: JobRecord,
  dir: string,
  persist: () => Promise<void>,
): Promise<void> {
  for (const failure of failures) {
    const skipped: SkippedUnit = {
      slug: failure.unit,
      stage: "S3",
      reason: failure.reason,
    };
    if (failure.detail !== undefined) skipped.detail = failure.detail;
    job.skipped.push(skipped);
    await persist();
    await appendEvent(dir, "unit", {
      slug: failure.unit,
      stage: "S3",
      status: "skipped",
      reason: failure.reason,
      ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
    });
  }
}

/**
 * Build the S3 stage. It is a barrier: every extraction is read before the
 * first model call, and it never opens `raw/`.
 */
export function createS3Stage(deps: StageDeps): S3Stage {
  return async function runS3(
    job: JobRecord,
    ctx: UnitContext,
    dir: string,
    persist: () => Promise<void>,
  ): Promise<boolean> {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    // The barrier: `listExtractions` resolves only after every file was read.
    const records = await listExtractions(dir);
    const candidates = collectLabels(records);
    const filtered: FilteredCandidate[] = [];

    const cache = createLlmCache(deps.cacheDirFor(job.vaultId));
    const context: S3CallContext = {
      job,
      llm: deps.llm,
      cache,
      dir,
    };

    const canonical = await canonicalizeLabels(candidates, context);
    await recordFailures(canonical.failures, job, dir, persist);

    const concepts = canonical.labels
      .filter((label) => label.kind === "concept")
      .map(conceptOf);
    const entities = canonical.labels
      .filter((label) => label.kind === "entity")
      .map(entityOf);
    const sources = records.flatMap((record) => {
      const entry = manifestSourceFor(record, canonical.mapping);
      return entry === null ? [] : [entry];
    });
    const edges = deriveEdges(records, concepts, entities, canonical.mapping);

    const manifest: ManifestRecord = {
      concepts,
      entities,
      sources,
      edges,
      filtered,
      at: job.createdAt,
    };
    await writeManifest(dir, manifest);

    const taxonomy = await buildTaxonomy(canonical.labels, manifest, context);
    await recordFailures(taxonomy.failures, job, dir, persist);

    const record: TaxonomyRecord = {
      concept_themes: taxonomy.concept_themes,
      tool_themes: taxonomy.tool_themes,
      source_clusters: taxonomy.source_clusters,
      at: job.createdAt,
    };
    await writeTaxonomy(dir, record);

    return false;
  };
}
