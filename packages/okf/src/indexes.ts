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
import { readIndexMeta } from "./frontmatter.js";
import type { BundlePage } from "./frontmatter.js";

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
