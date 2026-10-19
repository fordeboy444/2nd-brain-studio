// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest), so `tsc` cannot resolve
// this builtin. Vitest resolves it at run time; this is test-only code.
import { readFileSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { join } from "node:path";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as okf from "./index.js";
import { buildIndexes, formatLintReport, lintBundle } from "./index.js";
import type {
  BundlePage,
  LintFinding,
  LintOptions,
  LintRule,
  LintSeverity,
  Taxonomy,
} from "./index.js";
import { readBundle } from "../tests/helpers/bundle.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../tests/fixtures/bundle-mini", import.meta.url),
);
const CLEAN_ROOT = fileURLToPath(
  new URL("../tests/fixtures/bundle-clean", import.meta.url),
);

const bundle = readBundle(FIXTURE_ROOT);
const cleanBundle = readBundle(CLEAN_ROOT);
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

/** The committed clean fixture plus the seven indexes the reference generated. */
function cleanPages(): BundlePage[] {
  const indexes = buildIndexes(cleanBundle.pages, {});
  return [
    ...cleanBundle.pages,
    ...indexes.files.map((file) => ({ path: file.path, text: file.text })),
  ];
}

/** The clean fixture with one cited quote replaced by unrelated words. */
function badQuotePages(provenance: "sources" | "videos"): BundlePage[] {
  const good = '"[0:01:00] the second segment explains the exact words we cite"';
  const bad = '"[0:01:00] zebra quantum xylophone marmalade"';
  return cleanPages().map((page) => {
    if (page.path !== "concepts/alpha.md") return page;
    let text = page.text.replace(good, bad);
    if (provenance === "videos") {
      text = text.replace("sources: [video-a, web-a]", "videos: [video-a, web-a]");
    }
    return { path: page.path, text };
  });
}

describe("lintBundle: the committed mixed-provenance fixture", () => {
  it("lints clean with 13 scanned pages and exit code 0", () => {
    const result = lintBundle(cleanPages(), "bundle-clean");
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(13);
    expect(result.exitCode).toBe(0);
  });

  it("prints the exact clean report", () => {
    const report = formatLintReport(lintBundle(cleanPages(), "bundle-clean"));
    expect(report).toBe(
      "Scanned 13 markdown files under bundle-clean/\n\n0 error(s), 0 warning(s).\n",
    );
  });

  it("turns an unrelated quote into exactly one E8 error on a sources: page", () => {
    const result = lintBundle(badQuotePages("sources"), "bundle-clean");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 quote not found near cited timestamp: concepts/alpha.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("turns the same quote into exactly one E8 warning on a legacy videos: page", () => {
    const result = lintBundle(badQuotePages("videos"), "bundle-clean");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 quote not found near cited timestamp: concepts/alpha.md",
    ]);
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("scores a verbatim segment quote at 1 and a different long window below 0.55", () => {
    const segments = [
      { seconds: 0, text: "alpha beta gamma delta epsilon" },
      { seconds: 600, text: "zebra quantum xylophone marmalade orchard" },
    ];
    const full = segments.map((segment) => segment.text).join(" ");
    expect(
      okf.citationScore("alpha beta gamma delta", segments, full, 0),
    ).toBe(1);
    expect(
      okf.citationScore("alpha beta gamma delta", segments, full, 600),
    ).toBeLessThan(0.55);
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

describe("E1 unsupported frontmatter (CR-01)", () => {
  it("reports unsupported YAML instead of silently skipping E5, E6 and E8", () => {
    // A valid `type:` line plus an indented nested key: E1's type read passes,
    // so without this rule the page would opt out of every semantic check.
    const pages = conceptWithBullet(
      "sources: [web-a]\nmetadata:\n  owner: someone\n",
      '- [Web A](../sources/web-a.md) - "[0:01:00] a timestamped phrase"',
      webSourcePages(
        "a timestamped phrase appears here; a plain phrase and a quote too.",
      ),
    );
    const result = lintBundle(pages, "edge");
    expect(result.errors.map((finding) => finding.message)).toEqual([
      "E1 unsupported YAML in frontmatter: concepts/subject.md",
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it("reports one error per unsupported page, in path order", () => {
    const pages = conceptPair(
      "---\ntype: concept\nmeta:\n  nested: true\n---\n\n[Partner](partner.md)\n",
    );
    expect(findingMessages(pages)).toEqual([
      "E1 unsupported YAML in frontmatter: concepts/subject.md",
    ]);
  });

  it("suppresses E1 for a reserved page the reference skips (WR-02)", () => {
    const pages: BundlePage[] = [
      {
        path: "index.md",
        text:
          '---\nokf_version: "0.1"\nmeta:\n  nested: true\n---\n\n# Bundle\n',
      },
    ];
    const result = lintBundle(pages, "edge");
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
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

  it("resolves a link to the bundle root (WR-05)", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n[Index](../)\n`,
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

/**
 * A source page with a matching raw page and an index listing.
 *
 * The companions keep E1, E3 and E4 silent, so every finding in an E5 case
 * comes from the subject source page.
 */
function sourceBundle(frontmatter: string): BundlePage[] {
  return [
    {
      path: "sources/subject.md",
      text: `---\ntype: source\n${frontmatter}---\n\n# Subject\n`,
    },
    { path: "sources/index.md", text: "# Sources\n\n- [Subject](subject.md)\n" },
    {
      path: "raw/subject.md",
      text: "---\ntype: raw-transcript\n---\n\n## Transcript\n\n**[0:00:00]** a transcript.\n",
    },
  ];
}

describe("E5 source_kind and youtube_id boundaries", () => {
  it("finds a web source that carries a youtube_id", () => {
    expect(
      findingMessages(sourceBundle("source_kind: web\nyoutube_id: abc123\n")),
    ).toEqual([
      "E5 source_kind web must not carry youtube_id: sources/subject.md",
    ]);
  });

  it("finds a video source without a youtube_id", () => {
    expect(findingMessages(sourceBundle("source_kind: video\n"))).toEqual([
      "E5 source_kind video requires youtube_id: sources/subject.md",
    ]);
  });

  it("finds a video source with an empty youtube_id", () => {
    expect(
      findingMessages(sourceBundle('source_kind: video\nyoutube_id: ""\n')),
    ).toEqual([
      "E5 source_kind video requires youtube_id: sources/subject.md",
    ]);
  });

  it("accepts a video source with a non-empty youtube_id", () => {
    expect(
      findingMessages(sourceBundle("source_kind: video\nyoutube_id: abc123\n")),
    ).toEqual([]);
  });

  it("accepts a web source without a youtube_id", () => {
    expect(findingMessages(sourceBundle("source_kind: web\n"))).toEqual([]);
  });

  it("accepts a page with no source_kind even when it carries a youtube_id", () => {
    expect(findingMessages(sourceBundle("youtube_id: abc123\n"))).toEqual([]);
  });

  it("reads a single-quoted source_kind as its unquoted value", () => {
    expect(
      findingMessages(
        sourceBundle("source_kind: 'web'\nyoutube_id: abc123\n"),
      ),
    ).toEqual([
      "E5 source_kind web must not carry youtube_id: sources/subject.md",
    ]);
  });

  it("normalizes source_kind case before comparing (WR-03)", () => {
    expect(
      findingMessages(sourceBundle("source_kind: Web\nyoutube_id: abc123\n")),
    ).toEqual([
      "E5 source_kind web must not carry youtube_id: sources/subject.md",
    ]);
  });
});

/** A web source, its raw capture and its index listing. */
function webSourcePages(rawBody: string): BundlePage[] {
  return [
    {
      path: "sources/web-a.md",
      text:
        "---\ntype: source\nsource_kind: web\ntitle: \"Web A\"\n" +
        'slug: web-a\nraw: "../raw/web-a.md"\n---\n\n# Web A\n',
    },
    { path: "sources/index.md", text: "# Sources\n\n- [Web A](web-a.md)\n" },
    {
      path: "raw/web-a.md",
      text:
        "---\ntype: raw-capture\n---\n\n## Extracted text\n\n" +
        `**[#1]** ${rawBody}\n`,
    },
  ];
}

/** A video source, its transcript and its index listing. */
function videoSourcePages(transcriptBody: string): BundlePage[] {
  return [
    {
      path: "sources/video-a.md",
      text:
        "---\ntype: source\nsource_kind: video\nyoutube_id: videoA00001\n" +
        'title: "Video A"\nslug: video-a\nraw: "../raw/video-a.md"\n---\n\n# Video A\n',
    },
    {
      path: "sources/index.md",
      text: "# Sources\n\n- [Video A](video-a.md)\n",
    },
    {
      path: "raw/video-a.md",
      text:
        "---\ntype: raw-transcript\n---\n\n## Transcript\n\n" +
        `**[0:00:00]** ${transcriptBody}\n`,
    },
  ];
}

/** A concept with a `## Sources` bullet plus the companions its gate needs. */
function conceptWithBullet(
  frontmatter: string,
  bullet: string,
  companions: BundlePage[],
): BundlePage[] {
  const pages = conceptPair(
    `---\ntype: concept\n${frontmatter}---\n\n[Partner](partner.md)\n\n` +
      `## Sources\n\n${bullet}\n`,
  );
  pages.push(...companions.map((page) => ({ ...page })));
  return pages;
}

describe("E6 web citation boundaries", () => {
  const rawBody =
    "a timestamped phrase appears here; a plain phrase and a quote too.";

  it("warns when a web citation on a sources: page carries a timestamp", () => {
    const pages = conceptWithBullet(
      "sources: [web-a]\n",
      '- [Web A](../sources/web-a.md) - "[0:01:00] a timestamped phrase"',
      webSourcePages(rawBody),
    );
    expect(findingMessages(pages)).toEqual([
      "E6 web citation carries a video timestamp: concepts/subject.md",
    ]);
  });

  it("warns identically when the same page uses a legacy videos: key", () => {
    const pages = conceptWithBullet(
      "videos: [web-a]\n",
      '- [Web A](../sources/web-a.md) - "[0:01:00] a timestamped phrase"',
      webSourcePages(rawBody),
    );
    expect(findingMessages(pages)).toEqual([
      "E6 web citation carries a video timestamp: concepts/subject.md",
    ]);
  });

  it("is silent when the page declares neither provenance key", () => {
    const pages = conceptWithBullet(
      "",
      '- [Web A](../sources/web-a.md) - "[0:01:00] a timestamped phrase"',
      webSourcePages(rawBody),
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("is silent for a web citation without a timestamp", () => {
    const pages = conceptWithBullet(
      "sources: [web-a]\n",
      '- [Web A](../sources/web-a.md) - "a plain phrase"',
      webSourcePages(rawBody),
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("is silent for a video citation with a timestamp", () => {
    const pages = conceptWithBullet(
      "sources: [video-a]\n",
      '- [Video A](../sources/video-a.md) - "[0:00:00] a timestamped phrase"',
      videoSourcePages("a timestamped phrase appears here."),
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("is silent when the timestamp is in the middle of the quote", () => {
    const pages = conceptWithBullet(
      "sources: [web-a]\n",
      '- [Web A](../sources/web-a.md) - "the quote [0:01:00] here"',
      webSourcePages(rawBody),
    );
    expect(findingMessages(pages)).toEqual([]);
  });
});

describe("source section grammar (WR-01)", () => {
  const outOfWindow = '- [Video A](../sources/video-a.md) - "[0:10:00] alpha beta gamma delta"';

  it("still emits E8 when the heading has trailing whitespace", () => {
    const pages = e8Set({ bullet: outOfWindow, rawText: E8_TWO_SEGMENTS });
    const subject = pages.find((page) => page.path === "concepts/subject.md");
    expect(subject).toBeDefined();
    subject!.text = subject!.text.replace("## Sources\n", "## Sources \n");
    expect(findingMessages(pages)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
  });

  it("still emits E8 for an indented star-marker bullet", () => {
    const pages = e8Set({
      bullet: `  * ${outOfWindow}`,
      rawText: E8_TWO_SEGMENTS,
    });
    expect(findingMessages(pages)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
  });

  it("still emits E8 when the heading is indented up to three spaces (WR-01)", () => {
    const pages = e8Set({ bullet: outOfWindow, rawText: E8_TWO_SEGMENTS });
    const subject = pages.find((page) => page.path === "concepts/subject.md");
    expect(subject).toBeDefined();
    subject!.text = subject!.text.replace("## Sources\n", " ## Sources\n");
    expect(findingMessages(pages)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
  });

  it("still emits E8 when the heading has a closing hash sequence (WR-01)", () => {
    const pages = e8Set({ bullet: outOfWindow, rawText: E8_TWO_SEGMENTS });
    const subject = pages.find((page) => page.path === "concepts/subject.md");
    expect(subject).toBeDefined();
    subject!.text = subject!.text.replace("## Sources\n", "## Sources ##\n");
    expect(findingMessages(pages)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
  });
});

describe("thematic breaks in the Sources section (WR-02)", () => {
  it.each(["* * *", "- - -"])(
    "does not treat %s as a citation bullet",
    (breakLine) => {
      const pages = e8Set({
        bullet:
          '- [Video A](../sources/video-a.md) - "[0:00:00] alpha beta gamma delta"',
      });
      const subject = pages.find((page) => page.path === "concepts/subject.md");
      expect(subject).toBeDefined();
      // No `## ` heading follows, so the break is still inside the section.
      subject!.text += `\n${breakLine}\n`;
      expect(findingMessages(pages)).toEqual([]);
    },
  );
});

describe("E7 wikilink boundaries", () => {
  it("finds one wikilink and embeds the matched text", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\nSee [[Alpha Concept]] for details.\n`,
    );
    expect(findingMessages(pages)).toEqual([
      "E7 wikilink `[[Alpha Concept]]` in concepts/subject.md",
    ]);
  });

  it("finds two wikilinks in document order", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\n` +
        "See [[Alpha Concept]] and [[Beta Concept]].\n",
    );
    expect(findingMessages(pages)).toEqual([
      "E7 wikilink `[[Alpha Concept]]` in concepts/subject.md",
      "E7 wikilink `[[Beta Concept]]` in concepts/subject.md",
    ]);
  });

  it("ignores a wikilink inside a fenced block", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\n\`\`\`\n[[Hidden]]\n\`\`\`\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("ignores a wikilink inside an inline-code span", () => {
    const pages = conceptPair(
      `${TYPED_CONCEPT}[Partner](partner.md)\n\nAn example \`[[Hidden]]\`.\n`,
    );
    expect(findingMessages(pages)).toEqual([]);
  });

  it("ignores a wikilink on a reserved index page", () => {
    const pages = conceptPair(`${TYPED_CONCEPT}[Partner](partner.md)\n`);
    pages[2] = {
      path: "concepts/index.md",
      text:
        "# Concepts\n\n- [Subject](subject.md)\n- [Partner](partner.md)\n\n" +
        "See [[Ignored]].\n",
    };
    expect(findingMessages(pages)).toEqual([]);
  });

  it.each(["[[]]", "[[][]]", "[[[]a]]", "[[]a]]"])(
    "does not report the non-wikilink %s as E7 (WR-10)",
    (text) => {
      const pages = conceptPair(
        `${TYPED_CONCEPT}[Partner](partner.md)\n\nShortcut ${text} here.\n`,
      );
      const result = lintBundle(pages, "edge");
      expect(result.findings).toEqual([]);
      expect(result.exitCode).toBe(0);
    },
  );
});

describe("warning order across added rules", () => {
  it("lists E4, then E6, then E8, then W1", () => {
    const pages = conceptWithBullet(
      "videos: [web-a]\n",
      '- [Web A](../sources/web-a.md) - "[0:01:00] unrelated zebra quantum words"',
      webSourcePages("a captured page about attention mechanisms."),
    );
    pages.push({
      path: "concepts/orphan.md",
      text: "---\ntype: concept\n---\n\n",
    });
    pages.push({
      path: "raw/epsilon.md",
      text: "---\ntype: raw-transcript\n---\n",
    });
    const index = pages.find((page) => page.path === "concepts/index.md");
    if (index !== undefined) {
      index.text =
        "# Concepts\n\n- [Subject](subject.md)\n- [Partner](partner.md)\n" +
        "- [Orphan](orphan.md)\n";
    }

    const messages = findingMessages(pages);
    expect(messages).toEqual([
      "E4 raw/epsilon.md has no matching sources/epsilon.md (not yet ingested)",
      "E6 web citation carries a video timestamp: concepts/subject.md",
      "E8 quote not found in cited page: concepts/subject.md",
      "W1 orphan (no inbound link from a content page): concepts/orphan.md",
    ]);
  });
});

/** Long enough that a wrongly excluded boundary segment cannot fall back. */
const E8_LONG_QUOTE_TEXT =
  "alpha beta gamma delta epsilon zeta theta iota kappa lambda";

/** Video source frontmatter pointing at the helper's raw page. */
function videoSourceFrontmatter(slug: string): string {
  return (
    "source_kind: video\nyoutube_id: videoA00001\n" +
    `title: "Source"\nslug: ${slug}\nraw: "../raw/${slug}.md"\n`
  );
}

/** A web source frontmatter pointing at the helper's raw page. */
function webSourceFrontmatter(slug: string): string {
  return (
    "source_kind: web\n" +
    `title: "Source"\nslug: ${slug}\nraw: "../raw/${slug}.md"\n`
  );
}

interface E8SetOptions {
  /** Defaults to the strict `sources:` key. */
  provenance?: string;
  bullet: string;
  sourceSlug?: string;
  sourceFrontmatter?: string;
  rawText?: string;
  includeSource?: boolean;
  includeRaw?: boolean;
}

/**
 * A citing concept plus the source, raw and index companions its gate needs.
 *
 * The subject is a concept with an inbound partner link, so E1, E3 and W1 stay
 * silent; the source page has a matching raw page, so E4 stays silent too.
 */
function e8Set(options: E8SetOptions): BundlePage[] {
  const slug = options.sourceSlug ?? "video-a";
  const provenance = options.provenance ?? "sources: [video-a]\n";
  const pages = conceptPair(
    `---\ntype: concept\n${provenance}---\n\n[Partner](partner.md)\n\n` +
      `## Sources\n\n${options.bullet}\n`,
  );
  if (options.includeSource !== false) {
    pages.push({
      path: `sources/${slug}.md`,
      text:
        `---\ntype: source\n` +
        `${options.sourceFrontmatter ?? videoSourceFrontmatter(slug)}` +
        "---\n\n# Source\n",
    });
    pages.push({
      path: "sources/index.md",
      text: `# Sources\n\n- [Source](${slug}.md)\n`,
    });
  }
  if (options.includeRaw !== false) {
    pages.push({
      path: `raw/${slug}.md`,
      text:
        "---\ntype: raw-transcript\n---\n\n## Transcript\n\n" +
        `**[0:00:00]** ${options.rawText ?? E8_LONG_QUOTE_TEXT}\n`,
    });
  }
  return pages;
}

/** The two-segment transcript that makes an out-of-window quote provable. */
const E8_TWO_SEGMENTS =
  `**[0:00:00]** ${E8_LONG_QUOTE_TEXT}\n\n` +
  "**[0:10:00]** zebra quantum xylophone marmalade orchard";

describe("E8 citation integrity on a strict sources: page", () => {
  it("accepts a video quote inside the cited window", () => {
    const pages = e8Set({
      bullet: '- [Video A](../sources/video-a.md) - "[0:00:00] alpha beta gamma delta"',
    });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("reports a video quote outside the cited window as an error", () => {
    const pages = e8Set({
      bullet: '- [Video A](../sources/video-a.md) - "[0:10:00] alpha beta gamma delta"',
      rawText: E8_TWO_SEGMENTS,
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("reports a video citation without a timestamp", () => {
    const pages = e8Set({
      bullet: '- [Video A](../sources/video-a.md) - "alpha beta gamma delta"',
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 video citation missing timestamp: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("reports a bullet with no quoted text", () => {
    const pages = e8Set({
      bullet: "- [Video A](../sources/video-a.md)",
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 citation has no quoted text: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("reports a bullet with no relative source link", () => {
    const pages = e8Set({ bullet: "- a bullet without any link" });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 citation has no source link: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("reports a cited source that does not exist", () => {
    const pages = e8Set({
      bullet: '- [Gone](../sources/gone.md) - "[0:00:00] alpha beta gamma delta"',
      includeSource: false,
      includeRaw: false,
    });
    const messages = findingMessages(pages, { paths: ["sources/gone.md"] });
    expect(messages).toEqual(["E8 cited source is missing: sources/gone.md"]);
    expect(
      lintBundle(pages, "edge", { paths: ["sources/gone.md"] }).findings[0]
        ?.severity,
    ).toBe("error");
  });

  it("reports a cited source whose raw page does not exist", () => {
    const pages = e8Set({
      bullet: '- [Video A](../sources/video-a.md) - "[0:00:00] alpha beta gamma delta"',
      sourceFrontmatter:
        "source_kind: video\nyoutube_id: videoA00001\n" +
        'title: "Source"\nslug: video-a\nraw: "../raw/gone.md"\n',
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 cited source has no raw page: sources/video-a.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("accepts a web quote present anywhere in the raw page", () => {
    const pages = e8Set({
      provenance: "sources: [web-a]\n",
      sourceSlug: "web-a",
      sourceFrontmatter: webSourceFrontmatter("web-a"),
      bullet:
        '- [Web A](../sources/web-a.md) - "a sentence about attention mechanisms"',
      rawText: "a sentence about attention mechanisms and more context",
    });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("reports a web quote absent from the raw page", () => {
    const pages = e8Set({
      provenance: "sources: [web-a]\n",
      sourceSlug: "web-a",
      sourceFrontmatter: webSourceFrontmatter("web-a"),
      bullet:
        '- [Web A](../sources/web-a.md) - "zebra quantum xylophone marmalade"',
      rawText: "a sentence about attention mechanisms and more context",
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 quote not found in cited page: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("finds a bad quote on a CRLF page (WR-04)", () => {
    const pages = e8Set({
      bullet:
        '- [Video A](../sources/video-a.md) - "[0:10:00] alpha beta gamma delta"',
      rawText: E8_TWO_SEGMENTS,
    }).map((page) =>
      page.path === "concepts/subject.md"
        ? { path: page.path, text: page.text.replace(/\n/g, "\r\n") }
        : page,
    );
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 quote not found near cited timestamp: concepts/subject.md",
    ]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("treats a mixed-case source_kind as web (WR-03)", () => {
    const pages = e8Set({
      provenance: "sources: [web-a]\n",
      sourceSlug: "web-a",
      sourceFrontmatter: webSourceFrontmatter("web-a").replace(
        "source_kind: web",
        "source_kind: Web",
      ),
      bullet:
        '- [Web A](../sources/web-a.md) - "a sentence about attention mechanisms"',
      rawText: "a sentence about attention mechanisms and more context",
    });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("treats a source with no source_kind as a video source", () => {
    const pages = e8Set({
      bullet: '- [Source](../sources/video-a.md) - "alpha beta gamma delta"',
      sourceFrontmatter:
        'title: "Source"\nslug: video-a\nraw: "../raw/video-a.md"\n',
    });
    expect(findingMessages(pages)).toEqual([
      "E8 video citation missing timestamp: concepts/subject.md",
    ]);
  });

  it("reports a 1 MiB quote with no closing double quote (T-02-05)", () => {
    const pages = e8Set({
      bullet: `- [Video A](../sources/video-a.md) - "${"x".repeat(1024 * 1024)}`,
    });
    expect(findingMessages(pages)).toEqual([
      "E8 citation has no quoted text: concepts/subject.md",
    ]);
  });
});

describe("E8 citation integrity on a legacy videos: page", () => {
  it("reports a below-threshold quote as one warning and keeps exit 0", () => {
    const pages = e8Set({
      provenance: "videos: [video-a]\n",
      bullet: '- [Video A](../sources/video-a.md) - "[0:10:00] alpha beta gamma delta"',
      rawText: E8_TWO_SEGMENTS,
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toBe(
      "E8 quote not found near cited timestamp: concepts/subject.md",
    );
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("skips a link-only bullet", () => {
    const pages = e8Set({
      provenance: "videos: [video-a]\n",
      bullet: "- [Video A](../sources/video-a.md)",
    });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("skips a quoted citation without a timestamp", () => {
    const pages = e8Set({
      provenance: "videos: [video-a]\n",
      bullet: '- [Video A](../sources/video-a.md) - "alpha beta gamma delta"',
    });
    expect(findingMessages(pages)).toEqual([]);
  });

  it("reports a missing cited source as one warning", () => {
    const pages = e8Set({
      provenance: "videos: [video-a]\n",
      bullet: '- [Gone](../sources/gone.md) - "[0:00:00] alpha beta gamma delta"',
      includeSource: false,
      includeRaw: false,
    });
    const result = lintBundle(pages, "edge", { paths: ["sources/gone.md"] });
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 cited source is missing: sources/gone.md",
    ]);
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing raw page as one warning", () => {
    const pages = e8Set({
      provenance: "videos: [video-a]\n",
      bullet: '- [Video A](../sources/video-a.md) - "[0:00:00] alpha beta gamma delta"',
      sourceFrontmatter:
        "source_kind: video\nyoutube_id: videoA00001\n" +
        'title: "Source"\nslug: video-a\nraw: "../raw/gone.md"\n',
    });
    const result = lintBundle(pages, "edge");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "E8 cited source has no raw page: sources/video-a.md",
    ]);
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });
});

describe("E8 rule order", () => {
  it("places E8 errors after E7 errors and before W1 warnings", () => {
    const pages = e8Set({
      bullet: '- [Video A](../sources/video-a.md) - "[0:10:00] alpha beta gamma delta"',
      rawText: E8_TWO_SEGMENTS,
    }).map((page) => {
      if (page.path === "concepts/subject.md") {
        return {
          path: page.path,
          text: page.text.replace(
            "[Partner](partner.md)",
            "[Partner](partner.md)\n\nSee [[Other]].",
          ),
        };
      }
      if (page.path === "concepts/index.md") {
        return {
          path: page.path,
          text: `${page.text}- [Orphan](orphan.md)\n`,
        };
      }
      return page;
    });
    pages.push({
      path: "concepts/orphan.md",
      text: "---\ntype: concept\n---\n\n",
    });
    expect(findingMessages(pages)).toEqual([
      "E7 wikilink `[[Other]]` in concepts/subject.md",
      "E8 quote not found near cited timestamp: concepts/subject.md",
      "W1 orphan (no inbound link from a content page): concepts/orphan.md",
    ]);
  });

  it("places E8 warnings after E6 warnings and before W1 warnings", () => {
    const pages = e8Set({
      provenance: "videos: [web-a]\n",
      sourceSlug: "web-a",
      sourceFrontmatter: webSourceFrontmatter("web-a"),
      bullet:
        '- [Web A](../sources/web-a.md) - "[0:01:00] zebra quantum xylophone marmalade"',
      rawText: "a captured page about attention mechanisms",
    }).map((page) =>
      page.path === "concepts/index.md"
        ? { path: page.path, text: `${page.text}- [Orphan](orphan.md)\n` }
        : page,
    );
    pages.push({
      path: "concepts/orphan.md",
      text: "---\ntype: concept\n---\n\n",
    });
    expect(findingMessages(pages)).toEqual([
      "E6 web citation carries a video timestamp: concepts/subject.md",
      "E8 quote not found in cited page: concepts/subject.md",
      "W1 orphan (no inbound link from a content page): concepts/orphan.md",
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

describe("private state directory prune", () => {
  it("omits a nested .okf page from the count, findings and report", () => {
    const pages: BundlePage[] = [
      { path: ".okf/jobs/job-1.md", text: "# Job One\n" },
      { path: "concepts/valid.md", text: TYPED_CONCEPT },
    ];
    const result = lintBundle(pages, "edge");
    expect(result.scanned).toBe(1);
    expect(
      result.findings.every((finding) => !finding.message.includes(".okf")),
    ).toBe(true);
    expect(formatLintReport(result)).not.toContain(".okf");
  });

  it("omits .okf/notes.md and keeps a near-miss directory", () => {
    const pages: BundlePage[] = [
      { path: ".okf/notes.md", text: "# Private Notes\n" },
      {
        path: "docs/okf-notes/x.md",
        text: "---\ntype: concept\n---\n",
      },
    ];
    const result = lintBundle(pages, "edge");
    expect(result.scanned).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("counts a directory whose name merely contains okf", () => {
    const pages: BundlePage[] = [
      {
        path: "docs/okf-notes/x.md",
        text: "---\ntype: concept\n---\n",
      },
    ];
    expect(lintBundle(pages, "edge").scanned).toBe(1);
  });

  it("omits .git pages", () => {
    const pages: BundlePage[] = [
      { path: ".git/hooks/note.md", text: "# Git Note\n" },
      { path: "concepts/valid.md", text: TYPED_CONCEPT },
    ];
    expect(lintBundle(pages, "edge").scanned).toBe(1);
  });

  it("omits a page with a nested .git segment (WR-03)", () => {
    const pages: BundlePage[] = [
      { path: "notes/.git/config.md", text: "# Nested Checkout\n" },
      { path: "vendor/repo/.git/x.md", text: "# Worktree\n" },
      { path: "notes/valid.md", text: "---\ntype: note\n---\n" },
    ];
    const result = lintBundle(pages, "edge");
    expect(result.scanned).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

describe("quiet mode", () => {
  /** One mixed set with both severities, so the quiet shape is visible. */
  const mixedPages: BundlePage[] = [
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

  it("omits the scanned line but keeps findings, blank line and summary", () => {
    const result = lintBundle(mixedPages, "edge");
    const quiet = formatLintReport(result, { quiet: true });
    expect(quiet.includes("Scanned ")).toBe(false);
    expect(quiet).toContain("  WARN  ");
    expect(quiet).toContain("  ERROR ");
    expect(quiet).toContain("\n\n");
    expect(quiet.endsWith(`\n${result.errors.length} error(s), ${result.warnings.length} warning(s).\n`)).toBe(
      true,
    );
  });

  it("prints exactly the reference shape with zero findings", () => {
    const result = lintBundle([], "empty");
    expect(result.scanned).toBe(0);
    expect(formatLintReport(result, { quiet: true })).toBe(
      "\n0 error(s), 0 warning(s).\n",
    );
  });
});

describe("exit semantics", () => {
  it("returns 0 when the only finding is a W1 warning", () => {
    const pages: BundlePage[] = [
      { path: "concepts/subject.md", text: TYPED_CONCEPT },
      {
        path: "concepts/index.md",
        text: "# Concepts\n\n- [Subject](subject.md)\n",
      },
    ];
    const result = lintBundle(pages, "edge");
    expect(result.warnings.length).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 when an E1 error is present", () => {
    const pages = conceptPair("# Subject\n\n[Partner](partner.md)\n");
    const result = lintBundle(pages, "edge");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  it("returns 1 when both severities are present", () => {
    const result = lintBundle(
      [
        {
          path: "concepts/subject.md",
          text: "# Subject\n\n[Missing](missing.md)\n",
        },
        {
          path: "concepts/index.md",
          text: "# Concepts\n\n- [Subject](subject.md)\n",
        },
        { path: "raw/epsilon.md", text: "---\ntype: raw-transcript\n---\n" },
      ],
      "edge",
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);

    // Formatting is a read-only view: it never changes the exit status.
    formatLintReport(result, { quiet: true });
    expect(result.exitCode).toBe(1);
  });
});

/** Read the template contract the LLM follows. */
function schemaText(): string {
  return readFileSync(
    fileURLToPath(
      new URL("../../../templates/okf-bundle/SCHEMA.md", import.meta.url),
    ),
    "utf8",
  );
}

/** The YAML block that follows `marker`, including its `---` fences. */
function schemaExample(marker: string): string {
  const schema = schemaText();
  const at = schema.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const open = schema.indexOf("```yaml\n", at);
  expect(open, marker).toBeGreaterThanOrEqual(0);
  const start = open + "```yaml\n".length;
  const close = schema.indexOf("```", start);
  expect(close, marker).toBeGreaterThan(start);
  return schema.slice(start, close);
}

/** A bundle whose source page is the documented example. */
function documentedPages(
  slug: string,
  sourceBlock: string,
  quote: string,
  rawBody: string,
): BundlePage[] {
  const pages = conceptPair(
    `---\ntype: concept\nsources: [${slug}]\n---\n\n[Partner](partner.md)\n\n` +
      `## Sources\n\n- [Source](../sources/${slug}.md) - ${quote}\n`,
  );
  pages.push({
    path: `sources/${slug}.md`,
    text: `${sourceBlock}\n# Source\n`,
  });
  pages.push({
    path: "sources/index.md",
    text: `# Sources\n\n- [Source](${slug}.md)\n`,
  });
  pages.push({
    path: `raw/${slug}.md`,
    text: `---\ntype: raw-transcript\n---\n\n## Transcript\n\n${rawBody}\n`,
  });
  return pages;
}

describe("documented SCHEMA examples (WR-07)", () => {
  it("lints a video bundle built from the documented Source example", () => {
    const block = schemaExample("**Source** (");
    expect(block).toContain("source_kind: video");
    expect(block).toContain("youtube_id:");
    expect(block).toContain("duration:");
    const pages = documentedPages(
      "why-ai-coding-abandoned-rag",
      block,
      '"[0:01:00] alpha beta gamma delta"',
      "**[0:01:00]** alpha beta gamma delta epsilon zeta theta iota",
    );
    expect(lintBundle(pages, "doc").findings).toEqual([]);
  });

  it("lints a web bundle built from the documented Web source example", () => {
    const block = schemaExample("**Web source** (");
    expect(block).toContain("source_kind: web");
    expect(block).not.toContain("youtube_id:");
    const pages = documentedPages(
      "attention-explained",
      block,
      '"a sentence about attention mechanisms"',
      "**[#1]** a sentence about attention mechanisms and more context",
    );
    expect(lintBundle(pages, "doc").findings).toEqual([]);
  });

  it("documents the raw page types the reference writes", () => {
    const schema = schemaText();
    expect(schema).toContain("`type: raw-transcript`");
    expect(schema).toContain("`type: raw-capture`");
    expect(schema).not.toContain("`type: raw-source`");
  });
});

describe("package surface", () => {
  it("exports the seven link and lint functions by name", () => {
    for (const name of [
      "stripCode",
      "extractLinks",
      "linkTarget",
      "isExternalTarget",
      "resolveBundlePath",
      "lintBundle",
      "formatLintReport",
    ] as const) {
      expect(typeof okf[name], name).toBe("function");
    }
  });

  it("exports the time and citation surface by name", () => {
    for (const name of [
      "parseTimestamp",
      "formatTimestamp",
      "normalizeCitationText",
      "parseVideoSegments",
      "citationScore",
    ] as const) {
      expect(typeof okf[name], name).toBe("function");
    }
    expect(okf.CITATION_WINDOW_BEFORE_SECONDS).toBe(45);
    expect(okf.CITATION_WINDOW_AFTER_SECONDS).toBe(120);
    expect(okf.CITATION_OVERLAP_THRESHOLD).toBe(0.55);
    const segment: okf.CitationSegment = { seconds: 60, text: "example" };
    expect(segment.seconds).toBe(60);
  });

  it("exports the lint types by name", () => {
    const finding: LintFinding = {
      rule: "E4",
      severity: "warning",
      message: "example",
    };
    const options: LintOptions = { quiet: true };
    const rule: LintRule = "W1";
    const severity: LintSeverity = "warning";
    expect(finding.rule).toBe("E4");
    expect(options.quiet).toBe(true);
    expect(rule).toBe("W1");
    expect(severity).toBe("warning");
  });
});


describe("WR-04/WR-05/WR-06 regression", () => {
  const pagesFor = (sourceText: string) => [
    { path: "concepts/x.md", text: sourceText },
    { path: "sources/src.md", text: "---\ntype: source\nsource_kind: video\nraw: raw/src.md\nyoutube_id: abc\n---\n" },
    { path: "raw/src.md", text: "[0:00:00] hi there" },
  ];

  it("WR-04 ends the Sources section on an indented h2", () => {
    const src = "---\ntype: concept\nsources:\n---\n## Sources\n- [S](../sources/src.md) - \"[0:00:00] hi\"\n  ## Related\n- unrelated note here\n";
    const result = lintBundle(pagesFor(src), "b");
    const msgs = result.errors.map((f) => f.message);
    expect(msgs).not.toContain("E8 citation has no source link: concepts/x.md");
  });

  it("WR-05 ignores fenced code inside Sources", () => {
    const src = "---\ntype: concept\nsources:\n---\n## Sources\n```md\n- [Example](../sources/example.md) - \"text\"\n```\n- [S](../sources/src.md) - \"[0:00:00] hi\"\n";
    const result = lintBundle(pagesFor(src), "b");
    const msgs = result.errors.map((f) => f.message);
    expect(msgs).not.toContain("E8 cited source is missing: sources/example.md");
  });

  it("WR-06 treats plus bullets as citations", () => {
    const src = "---\ntype: concept\nsources:\n---\n## Sources\n+ no link here at all\n";
    const result = lintBundle(pagesFor(src), "b");
    const msgs = result.errors.map((f) => f.message);
    expect(msgs).toContain("E8 citation has no source link: concepts/x.md");
  });

  it("WR-06 ignores nested notes under citations", () => {
    const src = "---\ntype: concept\nsources:\n---\n## Sources\n- [S](../sources/src.md) - \"[0:00:00] hi\"\n  - see also the appendix\n";
    const result = lintBundle(pagesFor(src), "b");
    const msgs = result.errors.map((f) => f.message);
    expect(msgs).not.toContain("E8 citation has no source link: concepts/x.md");
  });
});
