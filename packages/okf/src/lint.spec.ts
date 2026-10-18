// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest), so `tsc` cannot resolve
// this builtin. Vitest resolves it at run time; this is test-only code.
import { readFileSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { join } from "node:path";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndexes, formatLintReport, lintBundle } from "./index.js";
import type { BundlePage, Taxonomy } from "./index.js";
import { readBundle } from "../tests/helpers/bundle.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../tests/fixtures/bundle-mini", import.meta.url),
);

const bundle = readBundle(FIXTURE_ROOT);
const taxonomy = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "scripts", "taxonomy.json"), "utf8"),
) as Taxonomy;

/** The committed fixture plus the seven indexes the reference generated. */
function fixturePages(): BundlePage[] {
  const indexes = buildIndexes(bundle.pages, taxonomy);
  return [
    ...bundle.pages,
    ...indexes.files.map((file) => ({ path: file.path, text: file.text })),
  ];
}

describe("lintBundle: the committed fixture", () => {
  it("reports exactly the three errors, in rule order", () => {
    const result = lintBundle(fixturePages(), "bundle-mini");
    expect(result.errors.map((finding) => finding.message)).toEqual([
      "E1 missing/empty `type` frontmatter: concepts/gamma.md",
      "E2 broken link `../concepts/missing.md` in concepts/beta.md",
      "E4 sources/delta.md has no matching raw/delta.md",
    ]);
    expect(result.errors.map((finding) => finding.rule)).toEqual([
      "E1",
      "E2",
      "E4",
    ]);
    expect(result.errors.map((finding) => finding.severity)).toEqual([
      "error",
      "error",
      "error",
    ]);
  });

  it("reports exactly the three warnings, in rule order", () => {
    const result = lintBundle(fixturePages(), "bundle-mini");
    expect(result.warnings.map((finding) => finding.message)).toEqual([
      "E4 raw/epsilon.md has no matching sources/epsilon.md (not yet ingested)",
      "W1 orphan (no inbound link from a content page): concepts/gamma.md",
      "W1 orphan (no inbound link from a content page): entities/tools/tool-b.md",
    ]);
    expect(result.warnings.map((finding) => finding.rule)).toEqual([
      "E4",
      "W1",
      "W1",
    ]);
  });

  it("keeps findings in append order across both severities", () => {
    const result = lintBundle(fixturePages(), "bundle-mini");
    expect(result.findings).toHaveLength(6);
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      "E1",
      "E2",
      "E4",
      "E4",
      "W1",
      "W1",
    ]);
  });

  it("prints every warning before every error", () => {
    const report = formatLintReport(lintBundle(fixturePages(), "bundle-mini"));
    const lastWarning = report.lastIndexOf("  WARN  ");
    const firstError = report.indexOf("  ERROR ");
    expect(lastWarning).toBeGreaterThanOrEqual(0);
    expect(firstError).toBeGreaterThan(lastWarning);
  });

  it("prints the reference summary, scanned line and exit status", () => {
    const result = lintBundle(fixturePages(), "bundle-mini");
    const report = formatLintReport(result);
    expect(report.startsWith("Scanned 22 markdown files under bundle-mini/\n")).toBe(
      true,
    );
    expect(report.endsWith("\n3 error(s), 3 warning(s).\n")).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.scanned).toBe(22);
  });
});

describe("lintBundle: a clean bundle", () => {
  /** A minimal bundle where every rule is satisfied at once. */
  const cleanPages: BundlePage[] = [
    {
      path: "concepts/alpha.md",
      text: "---\ntype: concept\n---\n\nLinks to [Beta](beta.md).\n",
    },
    {
      path: "concepts/beta.md",
      text: "---\ntype: concept\n---\n\nLinks to [Alpha](alpha.md).\n",
    },
    {
      path: "concepts/index.md",
      text: "# Concepts\n\n- [Alpha](alpha.md)\n- [Beta](beta.md)\n",
    },
  ];

  it("returns no findings and exit code 0", () => {
    const result = lintBundle(cleanPages, "clean");
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.scanned).toBe(3);
  });
});
