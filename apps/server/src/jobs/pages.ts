/**
 * The source-page renderer (OKF-07, S4a).
 *
 * S2 builds one `sources/<slug>.md` per capture. The page is assembled in code
 * and never by the model: the frontmatter key order, the description source and
 * the citation bullet grammar are byte contracts the lint engine and the
 * reference bundle depend on.
 *
 * `renderSourcePage` is pure and returns text; the S2 stage hands that text to
 * `deps.writePage`, which resolves it through the vault jail. The partial path
 * uses the same renderer with `partial: true`, so there is exactly one template.
 */
import { formatTimestamp, renderFrontmatter } from "@2nd-brain/okf";
import type { OkfFrontmatter } from "@2nd-brain/okf";
import type {
  ExtractionSource,
  ExtractionRecord,
  StoredQuote,
} from "./extraction.js";

/** How a rendered page knows whether a quote carries a timestamp. */
export interface SourcePageQuote {
  text: string;
  /** Whole seconds. Absent for a web quote, which never carries a timestamp. */
  startSec?: number;
}

/** One concept as the page link needs it. */
export interface SourcePageConcept {
  name: string;
  slug: string;
}

/** One entity as the page link needs it; `type` selects the subdirectory. */
export interface SourcePageEntity {
  name: string;
  slug: string;
  type: string;
}

/** Everything one source page renders from. */
export interface SourcePageInput {
  slug: string;
  title: string;
  kind: "video" | "web";
  thesis: string;
  summary: string;
  tags: string[];
  concepts: SourcePageConcept[];
  entities: SourcePageEntity[];
  quotes: SourcePageQuote[];
  source: ExtractionSource;
  /** Both are the capture `fetchedAt`; never a wall-clock read. */
  created: string;
  updated: string;
  partial?: boolean;
  /** The page file's own directory, used only to keep `raw` vault-relative. */
  rawPath?: string;
}

/**
 * The exact frontmatter key order for a source page.
 *
 * `description` is the extraction thesis on a complete page and the capture
 * title on a partial one: a page without a thesis must not claim one. `duration`
 * is formatted only here, so the extraction JSON keeps whole seconds.
 */
export function sourceFrontmatter(input: SourcePageInput): OkfFrontmatter {
  const data: OkfFrontmatter = {
    type: "source",
    source_kind: input.kind,
  };
  if (input.kind === "video") {
    data.youtube_id = input.source.youtubeId ?? "";
  } else {
    data.url = input.source.url ?? "";
  }
  data.slug = input.slug;
  data.title = input.title;
  data.description = input.partial === true ? input.title : input.thesis;

  if (input.kind === "video" && input.source.published !== undefined) {
    data.published = input.source.published;
  }
  if (input.kind === "video" && isRenderableDuration(input.source.duration)) {
    data.duration = formatTimestamp(input.source.duration as number);
  }

  data.raw = `../${input.rawPath ?? input.source.rawPath}`;
  data.tags = input.tags;
  data.created = input.created;
  data.updated = input.updated;
  if (input.partial === true) data.partial = true;
  return data;
}

/** `formatTimestamp` needs a whole count of seconds, not a float. */
function isRenderableDuration(value: number | undefined): boolean {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/**
 * One `## Sources` bullet in the reference grammar.
 *
 * The quote itself decides the arm: a stored quote carries `startSec` for a
 * video and never for a web page, so the two grammars cannot drift from the
 * extraction record.
 */
export function sourcesBullet(
  title: string,
  slug: string,
  quote: SourcePageQuote,
): string {
  const link = `- [${title}](../sources/${slug}.md) - `;
  if (quote.startSec === undefined) return `${link}"${quote.text}"`;
  return `${link}"[${formatTimestamp(quote.startSec)}] ${quote.text}"`;
}

/**
 * A `## Sources` section, or the empty string when there is nothing to cite.
 * Concept and entity pages use it too; a page with no bullets has no heading.
 */
export function renderSourcesSection(bullets: readonly string[]): string {
  if (bullets.length === 0) return "";
  return `## Sources\n\n${bullets.join("\n")}\n`;
}

/** A page slug and an entity subtype name a path, so both are closed shapes. */
const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The three page kinds a bundle contains below its root. */
export type PageKind = "source" | "concept" | "entity";

/**
 * The one namer for a bundle page path (T-P4-15).
 *
 * Every writer and every link renderer calls this function, so a link and its
 * target cannot disagree. A slug or an entity subtype that could name a
 * directory or an escape is rejected before any path is built.
 */
export function pagePathFor(
  kind: PageKind,
  slug: string,
  entityType?: string,
): string {
  if (!PAGE_SLUG_RE.test(slug)) throw new Error("invalid page slug");
  if (kind === "source") return `sources/${slug}.md`;
  if (kind === "concept") return `concepts/${slug}.md`;
  if (kind === "entity") {
    if (entityType === undefined || !PAGE_SLUG_RE.test(entityType)) {
      throw new Error("invalid entity type");
    }
    return `entities/${entityType}/${slug}.md`;
  }
  throw new Error(`unknown page kind: ${String(kind)}`);
}

/** One `- [label](path)` bullet. */
function linkLine(label: string, path: string): string {
  return `- [${label}](${path})`;
}

/** `concepts/<slug>.md` as a link from inside `sources/`. */
function conceptLink(concept: SourcePageConcept): string {
  return linkLine(concept.name, `../${pagePathFor("concept", concept.slug)}`);
}

/** `entities/<type>/<slug>.md` as a link from inside `sources/`. */
function entityLink(entity: SourcePageEntity): string {
  return linkLine(
    entity.name,
    `../${pagePathFor("entity", entity.slug, entity.type)}`,
  );
}

/** One key moment: `- **[H:MM:SS]** text`. Video only. */
function keyMoment(quote: SourcePageQuote): string | null {
  if (quote.startSec === undefined) return null;
  return `- **[${formatTimestamp(quote.startSec)}]** ${quote.text}`;
}

function section(heading: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `${heading}\n\n${lines.join("\n")}\n`;
}

/**
 * Render the whole page: frontmatter, H1, summary and the three fixed sections.
 * An empty section is omitted rather than rendered as a bare heading, and a
 * partial page carries no summary, concept, entity or quote it does not have.
 */
export function renderSourcePage(input: SourcePageInput): string {
  const parts: string[] = [
    renderFrontmatter(sourceFrontmatter(input)),
    `# ${input.title}\n`,
  ];

  if (input.partial === true) {
    parts.push(
      "_This page was written from the capture metadata because the extraction did not complete._\n",
    );
  } else {
    const summary = input.summary.trim();
    if (summary !== "") parts.push(section("## Summary", [summary]));
  }

  const concepts = input.concepts.map(conceptLink);
  const entities = input.entities.map(entityLink);
  const moments =
    input.kind === "video"
      ? input.quotes.flatMap((quote) => {
          const rendered = keyMoment(quote);
          return rendered === null ? [] : [rendered];
        })
      : [];

  const conceptsSection = section("## Concepts covered", concepts);
  if (conceptsSection !== "") parts.push(conceptsSection);
  const entitiesSection = section("## Entities", entities);
  if (entitiesSection !== "") parts.push(entitiesSection);
  const momentsSection = section("## Key moments", moments);
  if (momentsSection !== "") parts.push(momentsSection);

  return parts.join("\n");
}

/** The page input an extraction record renders from. */
export function sourcePageInput(
  record: ExtractionRecord,
  partial = record.partial === true,
): SourcePageInput {
  return {
    slug: record.slug,
    title: record.title,
    kind: record.source.sourceKind,
    thesis: partial ? "" : record.thesis,
    summary: partial ? "" : record.summary,
    tags: partial ? [] : record.tags,
    concepts: partial ? [] : record.concepts,
    entities: partial ? [] : record.entities,
    quotes: partial ? [] : (record.quotes as StoredQuote[]),
    source: record.source,
    created: record.at,
    updated: record.at,
    partial,
    rawPath: record.source.rawPath,
  };
}
