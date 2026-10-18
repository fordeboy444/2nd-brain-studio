/**
 * The job-scoped manifest and taxonomy (PIPE-03, OKF-08).
 *
 * S3 reads every extraction exactly once and writes these two documents. Every
 * later stage answers its page decisions from `manifest.json`; nothing after S3
 * reopens `raw/`.
 *
 * Determinism is a contract, not a nicety: every array is sorted by codepoint
 * before it reaches disk, and both records take `at` from `job.createdAt`
 * rather than a clock read. Two runs over the same extractions therefore write
 * byte-identical files, whether the model reply came from the network or from
 * the cache.
 *
 * The schema is the strict one `llm/json.ts` already owns, so the stored
 * document and the S3 output are validated by the same definition.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodepoint } from "@2nd-brain/okf";
import type { EntityType, EdgeKind } from "../llm/json.js";
import { ManifestSchema, TaxonomySchema } from "../llm/json.js";
import { writeJsonAtomic } from "../http/writeAtomic.js";

/** A label seen by a source. `youtube_id`/`url` let S4a pass lint rule E5. */
export interface ManifestSource {
  slug: string;
  title: string;
  kind: "video" | "web";
  tags: string[];
  concepts: string[];
  entities: string[];
  youtube_id?: string;
  url?: string;
  /** Whole seconds, copied from the extraction's own source block. */
  duration?: number;
}

export interface ManifestConcept {
  slug: string;
  title: string;
  tags: string[];
  sources: string[];
  weight: number;
}

export interface ManifestEntity {
  slug: string;
  title: string;
  type: EntityType;
  tags: string[];
  sources: string[];
  weight: number;
}

/** The only edge vocabulary code renders; the model cannot add one. */
export interface ManifestEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** A label the threshold dropped. It never reaches `job.skipped`. */
export interface FilteredCandidate {
  slug: string;
  kind: "concept" | "entity";
  reason: string;
}

export interface ManifestRecord {
  concepts: ManifestConcept[];
  entities: ManifestEntity[];
  sources: ManifestSource[];
  edges: ManifestEdge[];
  filtered: FilteredCandidate[];
  at: string;
}

export interface TaxonomyTheme {
  name: string;
  slug: string;
  members: string[];
}

export interface TaxonomyRecord {
  concept_themes: TaxonomyTheme[];
  tool_themes: TaxonomyTheme[];
  source_clusters: TaxonomyTheme[];
  at: string;
}

/** Labels per canonicalisation and taxonomy call (T-P4-11). */
export const LABEL_BATCH_SIZE = 35;

/** A video this long counts as a deep dive on its own. */
export const DEEP_DIVE_MIN_DURATION_SEC = 1200;

/** A web page this long counts as a deep dive on its own. */
export const DEEP_DIVE_MIN_WORDS = 3000;

/** Unique values in codepoint order. Never leaks `Set` iteration order. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

function bySlug(a: { slug: string }, b: { slug: string }): number {
  return compareCodepoint(a.slug, b.slug);
}

function sortStrings(values: readonly string[]): string[] {
  return sortedUnique(values);
}

/** Rebuild every array in a total order without mutating the caller's record. */
export function sortManifest(record: ManifestRecord): ManifestRecord {
  return {
    concepts: [...record.concepts]
      .map((concept) => ({
        slug: concept.slug,
        title: concept.title,
        tags: sortStrings(concept.tags),
        sources: sortStrings(concept.sources),
        weight: concept.weight,
      }))
      .sort(bySlug),
    entities: [...record.entities]
      .map((entity) => ({
        slug: entity.slug,
        title: entity.title,
        type: entity.type,
        tags: sortStrings(entity.tags),
        sources: sortStrings(entity.sources),
        weight: entity.weight,
      }))
      .sort(bySlug),
    sources: [...record.sources]
      .map((source) => {
        const sorted: ManifestSource = {
          slug: source.slug,
          title: source.title,
          kind: source.kind,
          tags: sortStrings(source.tags),
          concepts: sortStrings(source.concepts),
          entities: sortStrings(source.entities),
        };
        if (source.youtube_id !== undefined) sorted.youtube_id = source.youtube_id;
        if (source.url !== undefined) sorted.url = source.url;
        if (source.duration !== undefined) sorted.duration = source.duration;
        return sorted;
      })
      .sort(bySlug),
    edges: [...record.edges].sort(
      (left, right) =>
        compareCodepoint(left.from, right.from) ||
        compareCodepoint(left.to, right.to) ||
        compareCodepoint(left.kind, right.kind),
    ),
    filtered: [...record.filtered].sort(
      (left, right) =>
        compareCodepoint(left.slug, right.slug) ||
        compareCodepoint(left.kind, right.kind) ||
        compareCodepoint(left.reason, right.reason),
    ),
    at: record.at,
  };
}

/** Rebuild the taxonomy arrays in a total order. */
export function sortTaxonomy(record: TaxonomyRecord): TaxonomyRecord {
  const themes = (values: readonly TaxonomyTheme[]): TaxonomyTheme[] =>
    values
      .map((theme) => ({
        name: theme.name,
        slug: theme.slug,
        members: sortStrings(theme.members),
      }))
      .sort(
        (left, right) =>
          compareCodepoint(left.slug, right.slug) ||
          compareCodepoint(left.name, right.name),
      );

  return {
    concept_themes: themes(record.concept_themes),
    tool_themes: themes(record.tool_themes),
    source_clusters: themes(record.source_clusters),
    at: record.at,
  };
}

export function manifestPath(jobDir: string): string {
  return join(jobDir, "manifest.json");
}

export function taxonomyPath(jobDir: string): string {
  return join(jobDir, "taxonomy.json");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read the manifest. A missing, unparseable or schema-invalid document is
 * `null`; the caller decides whether that is a resume or a failure.
 */
export async function readManifest(jobDir: string): Promise<ManifestRecord | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(jobDir), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ManifestSchema.safeParse(parsed);
  return result.success ? (result.data as ManifestRecord) : null;
}

/** Write the manifest through the atomic writer, in a total order. */
export async function writeManifest(
  jobDir: string,
  record: ManifestRecord,
): Promise<void> {
  await writeJsonAtomic(manifestPath(jobDir), sortManifest(record));
}

/** Read the taxonomy, returning `null` for a missing or corrupt document. */
export async function readTaxonomy(jobDir: string): Promise<TaxonomyRecord | null> {
  let raw: string;
  try {
    raw = await readFile(taxonomyPath(jobDir), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = TaxonomySchema.safeParse(parsed);
  return result.success ? (result.data as TaxonomyRecord) : null;
}

/** Write the taxonomy through the atomic writer, in a total order. */
export async function writeTaxonomy(
  jobDir: string,
  record: TaxonomyRecord,
): Promise<void> {
  await writeJsonAtomic(taxonomyPath(jobDir), sortTaxonomy(record));
}
