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

/** A typed concept block, so the subject passes E1 in rule-edge cases. */
const TYPED_CONCEPT = "---\ntype: concept\n---\n\n";

/**
 * Two concepts that link to each other, plus the index listing both.
 *
 * The companions are the minimum that keeps E3 and W1 silent, so any finding
 * in a case below comes from the subject page alone.
 */
function conceptPair(subjectText: string): BundlePage[] {
  return [
    { path: "concepts/subject.md", text: subjectText },
    {
      path: "concepts/partner.md",
      text: `${TYPED_CONCEPT}[Subject](subject.md)\n`,
    },
    {
      path: "concepts/index.md",
      text: "# Concepts\n\n- [Subject](subject.md)\n- [Partner](partner.md)\n",
    },
  ];
}

/**
 * Each finding message in append order.
 *
 * Every reference message already begins with its rule id, so this form is
 * both the asserted text and the rule identification.
 */
function findingMessages(
  pages: BundlePage[],
  options: { paths?: readonly string[] } = {},
): string[] {
  return lintBundle(pages, "edge", options).findings.map(
    (finding) => finding.message,
  );
}

describe("E1 frontmatter type boundaries", () => {
  it("finds a page with no frontmatter", () => {
    const pages = conceptPair("# Subject\n\n[Partner](partner.md)\n");
    expect(findingMessages(pages)).toEqual([
      "E1 missing/empty `type` frontmatter: concepts/subject.md",
    ]);
  });

  it("finds frontmatter without a type key", () => {
    const pages = conceptPair(
      "---\ntitle: Subject\n---\n\n[Partner](partner.md)\n",
    );
    expect(findingMessages(pages)).toEqual([
      "E1 missing/empty `type` frontmatter: concepts/subject.md",
    ]);
  });

  it("finds an empty quoted type", () => {
    const pages = conceptPair(
      '---\ntype: ""\n---\n\n[Partner](partner.md)\n',
    );
    expect(findingMessages(pages)).toEqual([
      "E1 missing/empty `type` frontmatter: concepts/subject.md",
    ]);
  });

  it("accepts a single-quoted type", () => {
    const pages = conceptPair(
      "---\ntype: 'concept'\n---\n\n[Partner](partner.md)\n",
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("accepts frontmatter that closes with a newline and three dashes", () => {
    const pages = conceptPair(
      "---\ntype: concept\n---\n\n[Partner](partner.md)\n",
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("does not flag reserved index.md or log.md without a type", () => {
    // concepts/index.md has no frontmatter by construction; add log.md too.
    const pages = conceptPair(
      "---\ntype: concept\n---\n\n[Partner](partner.md)\n",
    );
    pages.push({ path: "log.md", text: "# Log\n" });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("finds frontmatter that never closes", () => {
    const pages = conceptPair(
      "---\ntype: concept\n\n[Partner](partner.md)\n",
    );
    expect(findingMessages(pages)).toEqual([
      "E1 missing/empty `type` frontmatter: concepts/subject.md",
    ]);
  });
});

describe("E2 link boundaries", () => {
  it("resolves a relative link", () => {
    const pages = conceptPair(`${TYPED_CONCEPT}[Partner](partner.md)\n`);
    expect(findingMessages(pages)).toEqual([]);
  });

  it("resolves a link with a fragment", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md#section)\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("resolves a link with an explicit title", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md "Partner")\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("resolves an existing directory supplied through options.paths", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Scripts](../scripts/)\n`,
    );
    expect(findingMessages(pages, { paths: ["scripts"] })).toEqual([]);
  });

  it("resolves an existing non-markdown file supplied through options.paths", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Data](../scripts/taxonomy.json)\n`,
    );
    expect(
      findingMessages(pages, { paths: ["scripts/taxonomy.json"] }),
    ).toEqual([]);
  });

  it("finds a non-markdown link when options.paths omits it", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Data](../scripts/taxonomy.json)\n`,
    );
    expect(findingMessages(pages)).toEqual([
      "E2 broken link `../scripts/taxonomy.json` in concepts/subject.md",
    ]);
  });

  it("ignores a link inside a fenced block", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\`\`\`\n[Missing](missing.md)\n\`\`\`\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("ignores a link inside inline code", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\nAn example \`[Missing](missing.md)\`.\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("ignores https, mailto and anchor targets", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n` +
        "[Web](https://example.com) [Mail](mailto:a@example.com) [Here](#part)\n",
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("finds a target that climbs above the bundle root", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Escape](../../../x.md)\n`,
    );
    expect(findingMessages(pages)).toEqual([
      "E2 broken link `../../../x.md` in concepts/subject.md",
    ]);
  });
});

describe("E3 index coverage boundaries", () => {
  it("accepts a concept listed in concepts/index.md", () => {
    const pages = conceptPair(`${TYPED_CONCEPT}[Partner](partner.md)\n`);
    expect(findingMessages(pages)).toEqual([]);
  });

  it("finds a concept absent from every index", () => {
    // The index lists only partner, so subject is uncovered; both still have
    // an inbound content link, so W1 stays silent.
    const pages: BundlePage[] = [
      {
        path: "concepts/subject.md",
        text: `${TYPED_CONCEPT}[Partner](partner.md)\n`,
      },
      {
        path: "concepts/partner.md",
        text: `${TYPED_CONCEPT}[Subject](subject.md)\n`,
      },
      {
        path: "concepts/index.md",
        text: "# Concepts\n\n- [Partner](partner.md)\n",
      },
    ];
    expect(findingMessages(pages)).toEqual([
      "E3 not listed in any index.md: concepts/subject.md",
    ]);
  });

  it("accepts an entity listed only in entities/tools/index.md", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n` +
        "[Tool X](../entities/tools/tool-x.md)\n",
    );
    pages.push(
      {
        path: "entities/tools/tool-x.md",
        text: "---\ntype: entity\n---\n",
      },
      {
        path: "entities/tools/index.md",
        text: "# Tools\n\n- [Tool X](tool-x.md)\n",
      },
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("accepts a source listed only in sources/index.md", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Source](../sources/s.md)\n`,
    );
    pages.push(
      { path: "sources/s.md", text: "---\ntype: source\n---\n" },
      {
        path: "sources/index.md",
        text: "# Sources\n\n- [S](s.md)\n",
      },
      { path: "raw/s.md", text: "---\ntype: raw-transcript\n---\n" },
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("does not count a broken link inside an index page as coverage", () => {
    const pages: BundlePage[] = [
      {
        path: "concepts/subject.md",
        text: `${TYPED_CONCEPT}[Partner](partner.md)\n`,
      },
      {
        path: "concepts/partner.md",
        text: `${TYPED_CONCEPT}[Subject](subject.md)\n`,
      },
      {
        path: "concepts/index.md",
        text:
          "# Concepts\n\n[Missing](missing.md)\n\n- [Partner](partner.md)\n",
      },
    ];
    expect(findingMessages(pages)).toEqual([
      "E2 broken link `missing.md` in concepts/index.md",
      "E3 not listed in any index.md: concepts/subject.md",
    ]);
  });
});

describe("E4 sources/raw parity boundaries", () => {
  it("finds a source with no raw page", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Alpha](../sources/alpha.md)\n`,
    );
    pages.push(
      { path: "sources/alpha.md", text: "---\ntype: source\n---\n" },
      { path: "sources/index.md", text: "# Sources\n\n- [Alpha](alpha.md)\n" },
    );
    expect(findingMessages(pages)).toEqual([
      "E4 sources/alpha.md has no matching raw/alpha.md",
    ]);
  });

  it("finds a raw page with no source page", () => {
    const pages: BundlePage[] = [
      {
        path: "raw/epsilon.md",
        text: "---\ntype: raw-transcript\n---\n",
      },
    ];
    expect(findingMessages(pages)).toEqual([
      "E4 raw/epsilon.md has no matching sources/epsilon.md (not yet ingested)",
    ]);
  });

  it("reports both directions, each sorted by stem", () => {
    const pages: BundlePage[] = [
      { path: "sources/zeta.md", text: "---\ntype: source\n---\n" },
      { path: "sources/alpha.md", text: "---\ntype: source\n---\n" },
      {
        path: "sources/index.md",
        text: "# Sources\n\n- [Zeta](zeta.md)\n- [Alpha](alpha.md)\n",
      },
      { path: "raw/beta.md", text: "---\ntype: raw-transcript\n---\n" },
      { path: "raw/yankee.md", text: "---\ntype: raw-transcript\n---\n" },
    ];
    expect(findingMessages(pages)).toEqual([
      "E4 sources/alpha.md has no matching raw/alpha.md",
      "E4 sources/zeta.md has no matching raw/zeta.md",
      "E4 raw/beta.md has no matching sources/beta.md (not yet ingested)",
      "E4 raw/yankee.md has no matching sources/yankee.md (not yet ingested)",
    ]);
  });

  it("excludes reserved index.md files from both stem sets", () => {
    const pages: BundlePage[] = [
      { path: "sources/index.md", text: "# Sources\n" },
      { path: "raw/alpha.md", text: "---\ntype: raw-transcript\n---\n" },
    ];
    expect(findingMessages(pages)).toEqual([
      "E4 raw/alpha.md has no matching sources/alpha.md (not yet ingested)",
    ]);
  });
});

describe("W1 orphan boundaries", () => {
  it("finds a concept linked only from an index page", () => {
    const pages: BundlePage[] = [
      { path: "concepts/subject.md", text: `${TYPED_CONCEPT}` },
      {
        path: "concepts/index.md",
        text: "# Concepts\n\n- [Subject](subject.md)\n",
      },
    ];
    expect(findingMessages(pages)).toEqual([
      "W1 orphan (no inbound link from a content page): concepts/subject.md",
    ]);
  });

  it("accepts a concept linked from a content page", () => {
    const pages = conceptPair(`${TYPED_CONCEPT}[Partner](partner.md)\n`);
    expect(findingMessages(pages)).toEqual([]);
  });

  it("finds an entity linked only from entities/index.md", () => {
    const pages: BundlePage[] = [
      {
        path: "entities/tools/tool-x.md",
        text: "---\ntype: entity\n---\n",
      },
      {
        path: "entities/tools/index.md",
        text: "# Tools\n\n- [Tool X](tool-x.md)\n",
      },
    ];
    expect(findingMessages(pages)).toEqual([
      "W1 orphan (no inbound link from a content page): entities/tools/tool-x.md",
    ]);
  });

  it("never reports a reserved page as an orphan", () => {
    const pages: BundlePage[] = [
      { path: "concepts/index.md", text: "# Concepts\n" },
      { path: "log.md", text: "# Log\n" },
    ];
    expect(findingMessages(pages)).toEqual([]);
  });
});

describe("determinism", () => {
  it("does not depend on the input page order", () => {
    const pages: BundlePage[] = [
      {
        path: "concepts/subject.md",
        text: "# Subject\n\n[Missing](missing.md)\n",
      },
      {
        path: "concepts/index.md",
        text: "# Concepts\n\n- [Subject](subject.md)\n",
      },
      { path: "sources/delta.md", text: "---\ntype: source\n---\n" },
      {
        path: "sources/index.md",
        text: "# Sources\n\n- [Delta](delta.md)\n",
      },
      { path: "raw/epsilon.md", text: "---\ntype: raw-transcript\n---\n" },
    ];
    const forward = formatLintReport(lintBundle(pages, "edge"));
    const reverse = formatLintReport(
      lintBundle(pages.slice().reverse(), "edge"),
    );
    expect(reverse).toBe(forward);
    expect(forward).toContain("W1 orphan");
  });
});
