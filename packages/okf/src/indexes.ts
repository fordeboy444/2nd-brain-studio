/**
 * Deterministic directory index generation.
 *
 * The reference `scripts/build_indexes.py` treats its output as the
 * specification: same headers, same intros, same bullets, same trailing-strip
 * plus one newline, same code-point ordering. Do not "improve" it.
 *
 * Pure: pages arrive as plain `{ path, text }` objects and the result is plain
 * strings. No filesystem, no clock, no locale.
 *
 * Task 1 of this plan emits `raw/index.md` only; the other six indexes land in
 * task 2 on the same primitives.
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
 * comparison uses UTF-16 code units, which disagrees above the BMP, and
 * `localeCompare` is locale-dependent. This is the one comparator the package
 * uses for every deterministic sort.
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

/** The filename stem of a bundle-relative POSIX path. */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.slice(0, -3);
}

/** The reference write shape: `"\n".join(lines).rstrip() + "\n"`. */
function finish(lines: readonly string[]): string {
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/** Raw transcripts: flat, ordered by stem, duration suffix. */
function rawIndex(pages: readonly BundlePage[]): { file: IndexFile; count: number } {
  const present = new Map<string, BundlePage>();
  for (const page of pages) {
    if (!page.path.startsWith("raw/")) continue;
    const rest = page.path.slice(4);
    if (rest.includes("/") || !rest.endsWith(".md") || rest === "index.md") continue;
    present.set(stemOf(page.path), page);
  }

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

/**
 * Build the directory indexes from the pages and the taxonomy.
 *
 * Task 1 emits `raw/index.md` only.
 */
export function buildIndexes(
  pages: readonly BundlePage[],
  _taxonomy: Taxonomy,
): IndexBuildResult {
  const raw = rawIndex(pages);
  return {
    files: [raw.file],
    log: [
      "Building indexes from scripts/taxonomy.json ...",
      `  wrote raw/index.md (${raw.count} transcripts)`,
      "Done.",
    ],
  };
}
