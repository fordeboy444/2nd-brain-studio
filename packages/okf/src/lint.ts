/**
 * The deterministic OKF lint engine and report formatter.
 *
 * Rules E1-E4 and W1 reproduce the reference `lint.py` exactly: same message
 * text, same severity, same order, same summary and same exit status. E5-E8 are
 * this project's additions, and their order is E1, E2, E3, E4, E5, E6, E7, E8,
 * W1. The report is a byte contract downstream phases gate generated pages on,
 * so the report never suppresses, deduplicates or reorders a finding to fit a
 * golden.
 *
 * Pure: pages arrive as plain `{ path, text }` objects. No filesystem, network
 * or process access.
 */
import type { BundlePage, OkfFrontmatter } from "./frontmatter.js";
import {
  FrontmatterError,
  normalizeSourceKind,
  parseFrontmatter,
} from "./frontmatter.js";
import { compareCodepoint } from "./indexes.js";
import {
  extractLinks,
  isExternalTarget,
  linkTarget,
  resolveBundlePath,
  stripCode,
} from "./links.js";
import {
  CITATION_OVERLAP_THRESHOLD,
  citationScore,
  parseTimestamp,
  parseVideoSegments,
} from "./time.js";

/** Every rule the engine reports. */
export type LintRule =
  | "E1"
  | "E2"
  | "E3"
  | "E4"
  | "E5"
  | "E6"
  | "E7"
  | "E8"
  | "W1";

/** Severity, matching the reference's two report tiers. */
export type LintSeverity = "error" | "warning";

/** One lint finding, in the form the report prints. */
export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  message: string;
}

/** Inputs the walk and link resolver accept. */
export interface LintOptions {
  /** Extra bundle-relative paths (directories and non-markdown files) that a link may resolve to. */
  paths?: readonly string[];
  /** Accepted for callers that pass the same options object to the formatter. */
  quiet?: boolean;
}

/** The structured lint result and the reference exit status. */
export interface LintResult {
  /** The bundle name printed on the scanned line. */
  bundleName: string;
  /** Kept pages, including reserved `index.md` and `log.md` files. */
  scanned: number;
  errors: LintFinding[];
  warnings: LintFinding[];
  /** Every finding in append order. */
  findings: LintFinding[];
  exitCode: number;
}

/** The basename of a bundle-relative POSIX path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The filename stem of a bundle-relative POSIX path. */
function stemOf(path: string): string {
  const name = nameOf(path);
  return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}

/** `index.md` and `log.md` are reserved at every depth. */
function isReserved(path: string): boolean {
  const name = nameOf(path);
  return name === "index.md" || name === "log.md";
}

/** True when the first path segment names a private state directory. */
function isPrivateState(path: string): boolean {
  const slash = path.indexOf("/");
  const first = slash === -1 ? path : path.slice(0, slash);
  return first === ".git" || first === ".okf";
}

/** True for a top-level page of `directory`, with no nested path. */
function isTopLevelPage(path: string, directory: string): boolean {
  const prefix = `${directory}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest !== "" && !rest.includes("/") && rest.endsWith(".md");
}

/** True for any page below `directory`, at any depth. */
function isRecursivePage(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`) && path.endsWith(".md");
}

/**
 * The reference frontmatter slice and `type:` read.
 *
 * A page that does not start with three dashes, or whose block never closes,
 * has no type. Quote removal mirrors `str.strip('"')` then `str.strip("'")`.
 */
function referenceType(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const frontmatter = text.slice(3, end);
  const match = /^type:\s*(.+?)\s*$/m.exec(frontmatter);
  if (match === null) return null;
  return (match[1] as string)
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
}

/** A page's parsed frontmatter, or `null` when it has none this parser accepts. */
type ParsedPage = { data: OkfFrontmatter; body: string } | null;

/**
 * Read one scalar field, normalized the way the reference reads a value:
 * trim, then strip double quotes, then strip single quotes.
 */
function scalarField(data: OkfFrontmatter, key: string): string | null {
  const value = data[key];
  if (value === undefined || Array.isArray(value)) return null;
  return String(value)
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
}

/** True when the page declares the provenance key, even with an empty array. */
function declares(data: OkfFrontmatter, key: string): boolean {
  return data[key] !== undefined;
}

/** True when the page declares either provenance key. */
function hasProvenance(data: OkfFrontmatter): boolean {
  return declares(data, "sources") || declares(data, "videos");
}

/**
 * The bullet lines of the `## Sources` section, in document order.
 *
 * The section starts at a line that is exactly `## Sources` and ends before the
 * next `## ` heading or at the end of the page. Only column-zero `- ` lines are
 * bullets.
 */
function sourceBullets(text: string): string[] {
  const bullets: string[] = [];
  let inSources = false;
  for (const rawLine of text.split("\n")) {
    // A CRLF page leaves a trailing carriage return on every line.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "## Sources") {
      inSources = true;
      continue;
    }
    if (!inSources) continue;
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) bullets.push(line);
  }
  return bullets;
}

/** The reference citation link: `](../sources/<slug>.md)`. */
const SOURCE_LINK_RE = /\]\((?:\.\.\/)+sources\/([a-z0-9][a-z0-9-]+)\.md\)/;

/** A `## Sources` bullet's link, separator and opening quote. */
const QUOTE_OPEN_RE = /^\s*-\s*"/;

/** A video citation quote: a bracketed timestamp, then the quote body. */
const VIDEO_QUOTE_RE = /^\[(\d+:\d+:\d+)\]\s*([\s\S]*)$/;

/** A wikilink, which OKF forbids in prose. */
const WIKILINK_RE = /\[\[[^\]]+\]\]/g;

/**
 * The bundle path set a link may resolve to.
 *
 * It contains every kept page, every ancestor directory of a kept page, and
 * any extra path the caller supplies.
 */
function bundlePathSet(
  pages: readonly BundlePage[],
  extra: readonly string[] | undefined,
): Set<string> {
  const paths = new Set<string>();
  for (const page of pages) {
    paths.add(page.path);
    let directory = page.path;
    let slash = directory.lastIndexOf("/");
    while (slash !== -1) {
      directory = directory.slice(0, slash);
      paths.add(directory);
      slash = directory.lastIndexOf("/");
    }
  }
  for (const path of extra ?? []) {
    const trimmed = path.replace(/\/+$/, "");
    if (trimmed !== "") paths.add(trimmed);
  }
  return paths;
}

/**
 * Lint a page set and return structured findings.
 *
 * The caller supplies the page list. Pages under `.okf/` and `.git/` are
 * pruned here before sorting, so they are not scanned, not counted and cannot
 * produce a finding. `buildIndexes` needs no change: it receives this filtered
 * set, never the raw walk.
 */
export function lintBundle(
  pages: readonly BundlePage[],
  bundleName: string,
  options: LintOptions = {},
): LintResult {
  const kept = pages
    .filter((page) => !isPrivateState(page.path))
    .slice()
    .sort((left, right) => compareCodepoint(left.path, right.path));
  const paths = bundlePathSet(kept, options.paths);

  const errors: LintFinding[] = [];
  const warnings: LintFinding[] = [];
  const findings: LintFinding[] = [];

  const record = (
    rule: LintRule,
    severity: LintSeverity,
    message: string,
  ): void => {
    const finding: LintFinding = { rule, severity, message };
    if (severity === "error") errors.push(finding);
    else warnings.push(finding);
    findings.push(finding);
  };
  const error = (rule: LintRule, message: string): void => {
    record(rule, "error", message);
  };
  const warning = (rule: LintRule, message: string): void => {
    record(rule, "warning", message);
  };

  // Every page is parsed exactly once; E5-E8 share the result. A page with no
  // frontmatter yields `null` and produces no finding from those rules; E1
  // reports the missing type. A block outside the supported subset is a hard
  // E1 error: without it, one unsupported page would silently opt out of E5,
  // E6 and E8 while E1 still saw a valid `type:` line.
  const byPath = new Map<string, BundlePage>();
  const parsed = new Map<string, ParsedPage>();
  for (const page of kept) {
    byPath.set(page.path, page);
    try {
      parsed.set(page.path, parseFrontmatter(page.text));
    } catch (cause) {
      if (!(cause instanceof FrontmatterError)) throw cause;
      parsed.set(page.path, null);
      error("E1", `E1 unsupported YAML in frontmatter: ${page.path}`);
    }
  }

  // E1 — every non-reserved page carries a non-empty `type:`.
  for (const page of kept) {
    if (isReserved(page.path)) continue;
    const type = referenceType(page.text);
    if (type === null || type === "") {
      error("E1", `E1 missing/empty \`type\` frontmatter: ${page.path}`);
    }
  }

  // E2 — every local link resolves inside the bundle; collect inbound links.
  const inbound = new Map<string, Set<string>>();
  for (const page of kept) {
    const text = stripCode(page.text);
    for (const raw of extractLinks(text)) {
      const link = raw.trim().split(/\s+/)[0] ?? "";
      if (isExternalTarget(link)) continue;
      const target = linkTarget(link);
      if (target === "") continue;
      const resolved = resolveBundlePath(page.path, target);
      if (resolved === null || !paths.has(resolved)) {
        error("E2", `E2 broken link \`${link}\` in ${page.path}`);
        continue;
      }
      if (resolved.endsWith(".md")) {
        const sources = inbound.get(resolved) ?? new Set<string>();
        sources.add(page.path);
        inbound.set(resolved, sources);
      }
    }
  }

  // E3 — every concept, entity and source page is listed in some index.md.
  const indexTargets = new Set<string>();
  for (const page of kept) {
    if (nameOf(page.path) !== "index.md") continue;
    for (const raw of extractLinks(page.text)) {
      const target = linkTarget(raw);
      if (target === "") continue;
      const resolved = resolveBundlePath(page.path, target);
      if (resolved !== null) indexTargets.add(resolved);
    }
  }

  const coverageGroups: BundlePage[][] = [
    kept.filter((page) => isTopLevelPage(page.path, "concepts")),
    kept.filter((page) => isRecursivePage(page.path, "entities")),
    kept.filter((page) => isTopLevelPage(page.path, "sources")),
  ];
  for (const group of coverageGroups) {
    for (const page of group) {
      if (isReserved(page.path)) continue;
      if (!indexTargets.has(page.path)) {
        error("E3", `E3 not listed in any index.md: ${page.path}`);
      }
    }
  }

  // E4 — sources/<slug>.md and raw/<slug>.md parity, both directions.
  const sourceStems = new Set(
    kept
      .filter(
        (page) => isTopLevelPage(page.path, "sources") && !isReserved(page.path),
      )
      .map((page) => stemOf(page.path)),
  );
  const rawStems = new Set(
    kept
      .filter(
        (page) => isTopLevelPage(page.path, "raw") && !isReserved(page.path),
      )
      .map((page) => stemOf(page.path)),
  );
  const missingRaw = [...sourceStems]
    .filter((stem) => !rawStems.has(stem))
    .sort(compareCodepoint);
  for (const stem of missingRaw) {
    error("E4", `E4 sources/${stem}.md has no matching raw/${stem}.md`);
  }
  const missingSource = [...rawStems]
    .filter((stem) => !sourceStems.has(stem))
    .sort(compareCodepoint);
  for (const stem of missingSource) {
    warning(
      "E4",
      `E4 raw/${stem}.md has no matching sources/${stem}.md (not yet ingested)`,
    );
  }

  // E5 — a source page's `source_kind` and `youtube_id` must agree.
  for (const page of kept) {
    const frontmatter = parsed.get(page.path);
    if (frontmatter === null || frontmatter === undefined) continue;
    const kind = normalizeSourceKind(frontmatter.data);
    if (kind === "web") {
      if (declares(frontmatter.data, "youtube_id")) {
        error(
          "E5",
          `E5 source_kind web must not carry youtube_id: ${page.path}`,
        );
      }
      continue;
    }
    if (kind === "video") {
      const youtubeId = scalarField(frontmatter.data, "youtube_id");
      if (youtubeId === null || youtubeId === "") {
        error("E5", `E5 source_kind video requires youtube_id: ${page.path}`);
      }
    }
  }

  // E6 — a web source citation must not carry a video timestamp. The gate is
  // exactly E8's, so a legacy `videos:` page is still checked.
  for (const page of kept) {
    const frontmatter = parsed.get(page.path);
    if (frontmatter === null || frontmatter === undefined) continue;
    if (!hasProvenance(frontmatter.data)) continue;
    for (const bullet of sourceBullets(page.text)) {
      const link = SOURCE_LINK_RE.exec(bullet);
      if (link === null) continue;
      const slug = link[1] as string;
      const citedPath = `sources/${slug}.md`;
      const cited = parsed.get(citedPath);
      if (cited === null || cited === undefined) continue;
      if (normalizeSourceKind(cited.data) !== "web") continue;
      const rest = bullet.slice(link.index + link[0].length);
      if (/^\s*-\s*"\[(\d+:\d+:\d+)\]/.test(rest)) {
        warning(
          "E6",
          `E6 web citation carries a video timestamp: ${page.path}`,
        );
      }
    }
  }

  // E7 — OKF prose never uses wikilinks.
  for (const page of kept) {
    if (isReserved(page.path)) continue;
    const prose = stripCode(page.text);
    WIKILINK_RE.lastIndex = 0;
    let match = WIKILINK_RE.exec(prose);
    while (match !== null) {
      error("E7", `E7 wikilink \`${match[0]}\` in ${page.path}`);
      match = WIKILINK_RE.exec(prose);
    }
  }

  // E8 — citation integrity. The rule runs on every page that declares either
  // provenance key: errors on a modern `sources:` page, warnings on a legacy
  // `videos:` page, which keeps the imported reference bundle at exit 0.
  for (const page of kept) {
    const frontmatter = parsed.get(page.path);
    if (frontmatter === null || frontmatter === undefined) continue;
    if (!hasProvenance(frontmatter.data)) continue;
    const strict = declares(frontmatter.data, "sources");
    const emit = (message: string): void => {
      record("E8", strict ? "error" : "warning", message);
    };

    for (const bullet of sourceBullets(page.text)) {
      const link = SOURCE_LINK_RE.exec(bullet);
      if (link === null) {
        if (strict) emit(`E8 citation has no source link: ${page.path}`);
        continue;
      }
      const slug = link[1] as string;

      const tail = bullet.slice(link.index + link[0].length);
      const open = QUOTE_OPEN_RE.exec(tail);
      let quote: string | null = null;
      if (open !== null) {
        const start = open[0].length;
        const close = tail.indexOf('"', start);
        if (close !== -1) quote = tail.slice(start, close);
      }
      if (quote === null || quote === "") {
        if (strict) emit(`E8 citation has no quoted text: ${page.path}`);
        continue;
      }

      const citedPath = `sources/${slug}.md`;
      const citedPage = byPath.get(citedPath);
      if (citedPage === undefined) {
        emit(`E8 cited source is missing: ${citedPath}`);
        continue;
      }
      const citedFrontmatter = parsed.get(citedPath) ?? null;
      const rawValue =
        citedFrontmatter === null
          ? null
          : scalarField(citedFrontmatter.data, "raw");
      const rawPath =
        rawValue === null || rawValue === ""
          ? `raw/${slug}.md`
          : resolveBundlePath(citedPath, rawValue);
      const rawPage = rawPath === null ? undefined : byPath.get(rawPath);
      if (rawPage === undefined) {
        emit(`E8 cited source has no raw page: ${citedPath}`);
        continue;
      }

      const sourceKind =
        citedFrontmatter === null
          ? null
          : normalizeSourceKind(citedFrontmatter.data);
      if (sourceKind === "web") {
        const score = citationScore(quote, [], rawPage.text, null);
        if (score < CITATION_OVERLAP_THRESHOLD) {
          emit(`E8 quote not found in cited page: ${page.path}`);
        }
        continue;
      }

      const videoQuote = VIDEO_QUOTE_RE.exec(quote);
      if (videoQuote === null) {
        if (strict) emit(`E8 video citation missing timestamp: ${page.path}`);
        continue;
      }
      const seconds = parseTimestamp(videoQuote[1] as string);
      const score = citationScore(
        videoQuote[2] as string,
        parseVideoSegments(rawPage.text),
        rawPage.text,
        seconds,
      );
      if (score < CITATION_OVERLAP_THRESHOLD) {
        emit(`E8 quote not found near cited timestamp: ${page.path}`);
      }
    }
  }

  // W1 — a concept or entity with no inbound link from a non-index page.
  for (const page of kept) {
    if (!isTopLevelPage(page.path, "concepts") && !isRecursivePage(page.path, "entities")) {
      continue;
    }
    if (isReserved(page.path)) continue;
    const citing = inbound.get(page.path);
    const contentCiting =
      citing === undefined
        ? []
        : [...citing].filter((source) => nameOf(source) !== "index.md");
    if (contentCiting.length === 0) {
      warning(
        "W1",
        `W1 orphan (no inbound link from a content page): ${page.path}`,
      );
    }
  }

  return {
    bundleName,
    scanned: kept.length,
    errors,
    warnings,
    findings,
    exitCode: errors.length > 0 ? 1 : 0,
  };
}

/**
 * Format a lint result as the reference `lint.py` stdout.
 *
 * Warnings print before errors. The scanned line is omitted in quiet mode, and
 * with no findings a quiet report begins with the reference's blank line.
 */
export function formatLintReport(
  result: LintResult,
  options: { quiet?: boolean } = {},
): string {
  const lines: string[] = [];
  if (options.quiet !== true) {
    lines.push(
      `Scanned ${result.scanned} markdown files under ${result.bundleName}/`,
    );
  }
  for (const finding of result.warnings) {
    lines.push(`  WARN  ${finding.message}`);
  }
  for (const finding of result.errors) {
    lines.push(`  ERROR ${finding.message}`);
  }
  lines.push("");
  lines.push(
    `${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
  );
  return `${lines.join("\n")}\n`;
}
