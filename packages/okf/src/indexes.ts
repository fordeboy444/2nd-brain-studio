/**
 * Deterministic directory index generation.
 *
 * The reference `scripts/build_indexes.py` treats its output as the
 * specification: same headers, same intros, same bullets, same trailing-strip
 * plus one newline, same code-point ordering. Do not "improve" it.
 *
 * Pure: pages arrive as plain `{ path, text }` objects and the result is plain
 * strings. No filesystem, no clock, no locale.
 */
import { parseFrontmatterSafe, readIndexMeta } from "./frontmatter.js";
import type { BundlePage, OkfFrontmatter } from "./frontmatter.js";

/** A theme name and the slugs it groups. */
export type ThemeGroup = [string, string[]];

/** The taxonomy shape read from `scripts/taxonomy.json`. */
export interface Taxonomy {
  concept_themes?: ThemeGroup[];
  tool_themes?: ThemeGroup[];
  source_clusters?: ThemeGroup[];
}

/** One generated index file. */
export interface IndexFile {
  /** Bundle-relative POSIX path, for example `raw/index.md`. */
  path: string;
  text: string;
}

/** The generated files and the log lines the reference prints while building. */
export interface IndexBuildResult {
  files: IndexFile[];
  log: string[];
}

/**
 * Compare two strings by Unicode code point.
 *
 * Python's `sorted()` compares code points; JavaScript's default string
 * comparison uses UTF-16 code units, which disagrees above the BMP, and the
 * locale-sensitive collator depends on the host. This is the one comparator
 * the package uses for every deterministic sort.
 */
export function compareCodepoint(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done && r.done) return 0;
    if (l.done) return -1;
    if (r.done) return 1;
    const lc = (l.value as string).codePointAt(0) as number;
    const rc = (r.value as string).codePointAt(0) as number;
    if (lc !== rc) return lc < rc ? -1 : 1;
  }
}

/** The filename of a bundle-relative POSIX path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The filename stem of a bundle-relative POSIX path. */
function stemOf(path: string): string {
  return nameOf(path).slice(0, -".md".length);
}

/** The reference write shape: `"\n".join(lines).rstrip() + "\n"`. */
function finish(lines: readonly string[]): string {
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * The top-level `*.md` pages of one directory, keyed by stem.
 *
 * Mirrors `directory.glob("*.md")`: nested pages and `index.md` never
 * participate.
 */
function directoryPages(
  pages: readonly BundlePage[],
  directory: string,
): Map<string, BundlePage> {
  const prefix = `${directory}/`;
  const present = new Map<string, BundlePage>();
  for (const page of pages) {
    if (!page.path.startsWith(prefix)) continue;
    const name = page.path.slice(prefix.length);
    if (name.includes("/") || !name.endsWith(".md") || name === "index.md") {
      continue;
    }
    present.set(stemOf(page.path), page);
  }
  return present;
}

/** The reference bullet: `- [title](rel)` plus ` - description` when present. */
function bullet(relative: string, title: string, description: string): string {
  return `- [${title}](${relative})` + (description ? ` - ${description}` : "");
}

/** Theme-grouped index, with every unlisted page under `## Other`. */
function groupedIndex(
  pages: readonly BundlePage[],
  directory: string,
  themes: readonly ThemeGroup[],
  header: string,
  intro: string,
): { file: IndexFile; count: number } {
  const present = directoryPages(pages, directory);
  const listed = new Set<string>();
  const lines = [`# ${header}`, "", intro, ""];

  for (const [name, slugs] of themes) {
    const rows: string[] = [];
    for (const slug of slugs) {
      const page = present.get(slug);
      if (page === undefined) continue;
      const meta = readIndexMeta(page.text, slug);
      rows.push(bullet(`${slug}.md`, meta.title, meta.description));
      // A slug named by two themes is emitted under both, as the reference does.
      listed.add(slug);
    }
    if (rows.length > 0) {
      lines.push(`## ${name}`);
      lines.push(...rows, "");
    }
  }

  const leftover = [...present.keys()]
    .filter((slug) => !listed.has(slug))
    .sort(compareCodepoint);
  if (leftover.length > 0) {
    lines.push("## Other");
    for (const slug of leftover) {
      const page = present.get(slug) as BundlePage;
      const meta = readIndexMeta(page.text, slug);
      lines.push(bullet(`${slug}.md`, meta.title, meta.description));
    }
    lines.push("");
  }

  return {
    file: { path: `${directory}/index.md`, text: finish(lines) },
    count: present.size,
  };
}

/**
 * Flat index, ordered by filename.
 *
 * Python sorts `Path` objects, whose order within one directory is the
 * filename including `.md` — not the bare stem, so `a-b.md` sorts before
 * `a.md`.
 */
function flatIndex(
  pages: readonly BundlePage[],
  directory: string,
  header: string,
  intro: string,
): { file: IndexFile; count: number } {
  const present = directoryPages(pages, directory);
  const names = [...present.keys()]
    .map((stem) => `${stem}.md`)
    .sort(compareCodepoint);
  const lines = [`# ${header}`, "", intro, ""];
  for (const name of names) {
    const stem = name.slice(0, -".md".length);
    const page = present.get(stem) as BundlePage;
    const meta = readIndexMeta(page.text, stem);
    lines.push(bullet(name, meta.title, meta.description));
  }
  return {
    file: { path: `${directory}/index.md`, text: finish(lines) },
    count: names.length,
  };
}

/** Raw transcripts: flat, ordered by stem, duration suffix. */
function rawIndex(pages: readonly BundlePage[]): { file: IndexFile; count: number } {
  const present = directoryPages(pages, "raw");
  const names = [...present.keys()].sort(compareCodepoint);
  const lines = [
    "# Raw Transcripts",
    "",
    "Immutable, timestamped transcripts (the source of truth); never hand-edit. " +
      "Synthesized summaries live in [sources/](../sources/index.md).",
    "",
  ];
  for (const name of names) {
    const page = present.get(name) as BundlePage;
    const meta = readIndexMeta(page.text, name);
    lines.push(
      `- [${meta.title}](${name}.md)` + (meta.duration ? ` - ${meta.duration}` : ""),
    );
  }
  return { file: { path: "raw/index.md", text: finish(lines) }, count: names.length };
}

/** The fixed entities root index. */
const ENTITIES_ROOT = [
  "# Entities",
  "",
  "Nameable things that exist across the videos, split by kind.",
  "",
  "## Groups",
  "",
  "- [Tools & products](tools/index.md) - coding agents, SDKs, RAG/data tools, integrations.",
  "- [People](people/index.md) - creators and voices referenced in the videos.",
  "- [Organizations](organizations/index.md) - the companies and research labs behind the tools.",
  "",
].join("\n");

/**
 * Build the seven directory indexes from the pages and the taxonomy.
 *
 * Files and log lines follow the reference `main()` order exactly. The caller
 * supplies an already-pruned page list: pages under `.okf/` and `.git/` never
 * reach this function, so index building never needs its own filter.
 */
export function buildIndexes(
  pages: readonly BundlePage[],
  taxonomy: Taxonomy,
): IndexBuildResult {
  const concepts = groupedIndex(
    pages,
    "concepts",
    taxonomy.concept_themes ?? [],
    "Concepts",
    "Ideas, techniques, patterns, and mental models mined from the videos. " +
      "Grouped by theme.",
  );
  const entities: IndexFile = {
    path: "entities/index.md",
    text: ENTITIES_ROOT,
  };
  const tools = groupedIndex(
    pages,
    "entities/tools",
    taxonomy.tool_themes ?? [],
    "Tools & Products",
    "Tools, products, and frameworks referenced across the videos.",
  );
  const people = flatIndex(
    pages,
    "entities/people",
    "People",
    "Creators and voices referenced in the videos.",
  );
  const organizations = flatIndex(
    pages,
    "entities/organizations",
    "Organizations",
    "The companies and research labs behind the tools and ideas.",
  );
  const sources = groupedIndex(
    pages,
    "sources",
    taxonomy.source_clusters ?? [],
    "Sources",
    "One synthesized summary per video, with provenance to the immutable " +
      "[raw transcript](../raw/index.md). Grouped by theme.",
  );
  const raw = rawIndex(pages);

  return {
    files: [
      concepts.file,
      entities,
      tools.file,
      people.file,
      organizations.file,
      sources.file,
      raw.file,
    ],
    log: [
      "Building indexes from scripts/taxonomy.json ...",
      `  wrote concepts/index.md (${concepts.count} pages)`,
      "  wrote entities/index.md",
      `  wrote entities/tools/index.md (${tools.count} pages)`,
      `  wrote entities/people/index.md (${people.count} pages)`,
      `  wrote entities/organizations/index.md (${organizations.count} pages)`,
      `  wrote sources/index.md (${sources.count} pages)`,
      `  wrote raw/index.md (${raw.count} transcripts)`,
      "Done.",
    ],
  };
}

/**
 * The reference banner marker.
 *
 * The reference uses one marker string for both ends of the generated region,
 * so a search for the closing marker must start after the opening one.
 */
export const ROOT_BANNER_START = "<!-- GENERATED:BANNER -->";

/** The marker that closes the generated region (the same literal). */
export const ROOT_BANNER_END = "<!-- GENERATED:BANNER -->";

/** The countable source pages of a bundle, split by source kind. */
export interface BundleCounts {
  /** Legacy and explicit video sources. */
  videos: number;
  /** Sources whose normalized `source_kind` is `web`. */
  webPages: number;
}

/** Raised when the root index does not carry a balanced marker pair. */
export class RootIndexError extends Error {
  readonly code: "unbalanced_markers" = "unbalanced_markers";

  constructor() {
    super("root index has an unbalanced banner marker pair");
    this.name = "RootIndexError";
  }
}

/** Read one scalar frontmatter field with the library's quote stripping. */
function frontmatterScalar(
  data: OkfFrontmatter,
  key: string,
): string | null {
  const value = data[key];
  if (value === undefined || Array.isArray(value)) return null;
  return String(value)
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
}

/**
 * Count the `sources/<stem>.md` pages of a bundle by source kind.
 *
 * Only a top-level page whose frontmatter parses and whose `type` is `source`
 * is countable; a reserved `index.md` or `log.md` never is. A page with
 * unsupported YAML is silently skipped rather than thrown on. A page with no
 * `source_kind` is a legacy video source, so an imported reference bundle
 * counts correctly.
 */
export function countBundle(pages: readonly BundlePage[]): BundleCounts {
  const counts: BundleCounts = { videos: 0, webPages: 0 };
  const prefix = "sources/";
  for (const page of pages) {
    if (!page.path.startsWith(prefix)) continue;
    const name = page.path.slice(prefix.length);
    if (name.includes("/") || !name.endsWith(".md")) continue;
    if (name === "index.md" || name === "log.md") continue;
    const parsed = parseFrontmatterSafe(page.text);
    if (parsed === null) continue;
    if (frontmatterScalar(parsed.data, "type") !== "source") continue;
    const kind = frontmatterScalar(parsed.data, "source_kind");
    if (kind !== null && kind.toLowerCase() === "web") {
      counts.webPages += 1;
    } else {
      counts.videos += 1;
    }
  }
  return counts;
}

/**
 * Render the generated coverage banner.
 *
 * Plain decimal digits, no separators, and the singular form for exactly one.
 */
export function renderRootBanner(counts: BundleCounts): string {
  const videoWord = counts.videos === 1 ? "video" : "videos";
  const webWord = counts.webPages === 1 ? "web page" : "web pages";
  return [
    ROOT_BANNER_START,
    `**Coverage:** ${counts.videos} ${videoWord}, ${counts.webPages} ${webWord}`,
    ROOT_BANNER_END,
  ].join("\n");
}

/** Insert `okf_version: "0.1"` when the frontmatter does not declare one. */
function ensureOkfVersion(text: string): string {
  if (!text.startsWith("---")) {
    return `---\nokf_version: "0.1"\n---\n\n${text}`;
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const frontmatter = text.slice(3, end);
  if (/^okf_version\s*:/m.test(frontmatter)) return text;
  const crlf = text.startsWith("---\r\n");
  const insertAt = crlf ? 5 : 4;
  return (
    text.slice(0, insertAt) +
    'okf_version: "0.1"' +
    (crlf ? "\r\n" : "\n") +
    text.slice(insertAt)
  );
}

/** Insert the banner after the first H1, with one blank line on each side. */
function insertBannerAfterHeading(text: string, banner: string): string {
  const heading = /^# .*$/m.exec(text);
  if (heading === null) {
    const separator = text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${banner}\n`;
  }
  let insertAt = heading.index + heading[0].length;
  if (text.startsWith("\r\n", insertAt)) insertAt += 2;
  else if (text.startsWith("\n", insertAt)) insertAt += 1;
  const rest = text.slice(insertAt);
  const trailing =
    rest.startsWith("\n") || rest.startsWith("\r\n") ? "" : "\n";
  return `${text.slice(0, insertAt)}\n${banner}\n${trailing}${rest}`;
}

/**
 * Rebuild a root `index.md`: normalize `okf_version` and splice the banner.
 *
 * Every other byte is returned unchanged, including line endings and the
 * final-newline state. The banner region is the only part replaced.
 */
export function buildRootIndex(
  text: string,
  pages: readonly BundlePage[],
): string {
  const normalized = ensureOkfVersion(text);
  const banner = renderRootBanner(countBundle(pages));
  const start = normalized.indexOf(ROOT_BANNER_START);
  if (start >= 0) {
    const end = normalized.indexOf(
      ROOT_BANNER_END,
      start + ROOT_BANNER_START.length,
    );
    if (end < 0) throw new RootIndexError();
    return (
      normalized.slice(0, start) +
      banner +
      normalized.slice(end + ROOT_BANNER_END.length)
    );
  }
  if (normalized.includes(ROOT_BANNER_END)) throw new RootIndexError();
  return insertBannerAfterHeading(normalized, banner);
}
