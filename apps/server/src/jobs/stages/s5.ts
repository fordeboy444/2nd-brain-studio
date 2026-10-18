/**
 * S5: the page set becomes the seven indexes, `log.md` and a lint report
 * (PIPE-07, UI-11 support).
 *
 * S5 makes no model call. It reads the written pages under `concepts/`,
 * `entities/` and `sources/` through the vault jail, synthesizes one raw page
 * per extraction record, builds the reference indexes, writes `log.md`, and
 * lints the whole bundle in memory.
 *
 * The raw index is a view of `extractions/*.json`, not of `raw/`: no stage
 * after S2 opens a raw capture. The synthetic raw body carries the stored
 * quotes, so E8 resolves the same way it would against the real file.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildIndexes,
  compareCodepoint,
  formatTimestamp,
  lintBundle,
  renderFrontmatter,
} from "@2nd-brain/okf";
import type {
  BundlePage,
  LintResult,
  OkfFrontmatter,
  Taxonomy,
  ThemeGroup,
} from "@2nd-brain/okf";
import { writeJsonAtomic } from "../../http/writeAtomic.js";
import { resolveInVault } from "../../paths/jail.js";
import { listExtractions, type ExtractionRecord } from "../extraction.js";
import { readTaxonomy, type TaxonomyRecord } from "../manifest.js";
import { appendEvent, readJob } from "../store.js";
import type { StageDeps, UnitContext } from "../runner.js";
import type { JobRecord } from "../types.js";

/** The bundle-relative path of the generated log. */
export const LOG_PATH = "log.md";

/** The job-relative lint report path template. */
export const LINT_REPORT_PATH = ".okf/jobs/<id>/lint-report.json";

/** The lint report file name inside one job directory. */
const LINT_REPORT_FILE = "lint-report.json";

/** The bundle roots S5 reads. `raw/` is deliberately absent. */
const PAGE_ROOTS = ["concepts", "entities", "sources"] as const;

/** Directories that never contribute a page. */
const PRIVATE_DIRS = new Set([".okf", ".git"]);

/** One raw page synthesized from an extraction record, never from `raw/`. */
function rawPageFor(record: ExtractionRecord): BundlePage {
  const source = record.source;
  const isVideo = source.sourceKind === "video";

  const data: OkfFrontmatter = { type: isVideo ? "raw-transcript" : "raw-capture" };
  data.source_kind = source.sourceKind;
  if (isVideo && source.youtubeId !== undefined) data.youtube_id = source.youtubeId;
  if (!isVideo && source.url !== undefined) data.url = source.url;
  data.slug = record.slug;
  data.title = source.title;
  if (
    isVideo &&
    source.duration !== undefined &&
    Number.isInteger(source.duration) &&
    source.duration >= 0
  ) {
    data.duration = formatTimestamp(source.duration);
  }

  const quotes = [...record.quotes].sort(
    (left, right) => (left.startSec ?? 0) - (right.startSec ?? 0),
  );
  let body: string;
  if (isVideo) {
    const lines = quotes.map((quote) =>
      quote.startSec === undefined
        ? `- ${quote.text}`
        : `**[${formatTimestamp(quote.startSec)}]** ${quote.text}`,
    );
    body = lines.length === 0 ? "" : `## Transcript\n\n${lines.join("\n\n")}\n`;
  } else {
    const lines = quotes.map((quote) => quote.text);
    body =
      lines.length === 0 ? "" : `## Extracted text\n\n${lines.join("\n\n")}\n`;
  }

  const text = `${renderFrontmatter(data)}\n${body}`;
  return { path: `raw/${record.slug}.md`, text };
}

/**
 * One synthetic raw page per extraction record (PIPE-07).
 *
 * A partial record still yields a row. The row count equals the extraction
 * count because `listExtractions` is the only input.
 */
export async function collectRawIndexRows(jobDir: string): Promise<BundlePage[]> {
  const records = await listExtractions(jobDir);
  return records
    .map(rawPageFor)
    .sort((left, right) => compareCodepoint(left.path, right.path));
}

/** Walk one bundle directory recursively, skip reserved names, read `.md`. */
async function walkPages(
  vaultDir: string,
  relDir: string,
  pages: BundlePage[],
): Promise<void> {
  let absolute: string;
  try {
    ({ absPath: absolute } = await resolveInVault(vaultDir, relDir));
  } catch {
    return;
  }

  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  entries.sort((left, right) => compareCodepoint(left.name, right.name));
  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (PRIVATE_DIRS.has(entry.name)) continue;
      await walkPages(vaultDir, relPath, pages);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === "index.md" || entry.name === "log.md") continue;
    const { absPath } = await resolveInVault(vaultDir, relPath);
    pages.push({ path: relPath, text: await readFile(absPath, "utf8") });
  }
}

/**
 * Every written page under `concepts/`, `entities/` and `sources/`, sorted by
 * path. This function never builds a `raw/` path, so it cannot open one.
 */
export async function collectBundlePages(vaultDir: string): Promise<BundlePage[]> {
  const pages: BundlePage[] = [];
  for (const root of PAGE_ROOTS) await walkPages(vaultDir, root, pages);
  return pages.sort((left, right) => compareCodepoint(left.path, right.path));
}

/** One taxonomy group in the library's tuple form. */
function themeGroups(
  themes: TaxonomyRecord["concept_themes"] | undefined,
): ThemeGroup[] {
  return (themes ?? []).map((theme) => [theme.name, [...theme.members]]);
}

/** Convert the stored taxonomy record into the library's plain shape. */
export function toOkfTaxonomy(record: TaxonomyRecord | null): Taxonomy {
  if (record === null) return {};
  return {
    concept_themes: themeGroups(record.concept_themes),
    tool_themes: themeGroups(record.tool_themes),
    source_clusters: themeGroups(record.source_clusters),
  };
}

/** Write every generated index through the jail. */
export async function writeIndexes(
  deps: StageDeps,
  vaultDir: string,
  files: readonly BundlePage[],
): Promise<void> {
  for (const file of files) {
    await deps.writePage(vaultDir, file.path, file.text);
  }
}

/** Write the generated `log.md`. */
export async function writeLog(
  deps: StageDeps,
  vaultDir: string,
  text: string,
): Promise<void> {
  await deps.writePage(vaultDir, LOG_PATH, text);
}

/**
 * Write the structured lint result into the job directory. The result carries
 * no timestamp, so two runs with the same input write the same bytes.
 */
export async function writeLintReport(
  jobDir: string,
  result: LintResult,
): Promise<void> {
  await writeJsonAtomic(join(jobDir, LINT_REPORT_FILE), {
    bundleName: result.bundleName,
    scanned: result.scanned,
    errors: result.errors,
    warnings: result.warnings,
    findings: result.findings,
    exitCode: result.exitCode,
  });
}

/**
 * Build the S5 stage.
 *
 * A lint error is data: the report records it, one stage event carries the
 * counts, and the job continues to completion.
 */
export function createS5Stage(deps: StageDeps) {
  return async function runS5(
    job: JobRecord,
    ctx: UnitContext,
    dir: string,
    _persist: () => Promise<void>,
  ): Promise<boolean> {
    const latest = await readJob(ctx.vaultDir, job.id);
    job.cancelRequested = latest.cancelRequested;
    if (job.cancelRequested) return true;

    const taxonomy = await readTaxonomy(dir);
    const basePages = await collectBundlePages(ctx.vaultDir);
    const rawPages = await collectRawIndexRows(dir);
    const result = buildIndexes(
      [...basePages, ...rawPages],
      toOkfTaxonomy(taxonomy),
    );

    await writeIndexes(deps, ctx.vaultDir, result.files);
    const logText = `${result.log.join("\n")}\n`;
    await writeLog(deps, ctx.vaultDir, logText);

    const lint = lintBundle(
      [
        ...basePages,
        ...rawPages,
        ...result.files,
        { path: LOG_PATH, text: logText },
      ],
      job.vaultId,
    );
    await writeLintReport(dir, lint);

    await appendEvent(dir, "stage", {
      stage: "S5",
      status: "lint",
      errors: lint.errors.length,
      warnings: lint.warnings.length,
    });
    return false;
  };
}
