/**
 * Index generation: grouping, the `## Other` bucket, ordering, encoding and
 * idempotency. Byte-for-byte agreement with the Python reference lives in
 * `tests/oracle.spec.ts`; these cases pin the behaviors the reference implies.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest); vitest resolves this
// builtin at run time.
import { readFileSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BundlePage } from "./frontmatter.js";
import {
  ROOT_BANNER_END,
  ROOT_BANNER_START,
  RootIndexError,
  buildIndexes,
  buildRootIndex,
  compareCodepoint,
  countBundle,
  renderRootBanner,
} from "./indexes.js";
import type { IndexBuildResult, Taxonomy } from "./indexes.js";

/** Build a page with the frontmatter subset the index reader consumes. */
function page(
  path: string,
  title: string | null,
  description = "",
  duration = "",
  type = "concept",
): BundlePage {
  const lines = ["---", `type: ${type}`];
  if (title !== null) lines.push(`title: "${title}"`);
  if (description !== "") lines.push(`description: "${description}"`);
  if (duration !== "") lines.push(`duration: "${duration}"`);
  lines.push("---", "", "Body.", "");
  return { path, text: lines.join("\n") };
}

/** The generated file at `path`, failing the test when it is missing. */
function fileAt(result: IndexBuildResult, path: string): string {
  const file = result.files.find((entry) => entry.path === path);
  expect(file, `buildIndexes did not emit ${path}`).toBeDefined();
  return (file as { text: string }).text;
}

const SEVEN_PATHS = [
  "concepts/index.md",
  "entities/index.md",
  "entities/tools/index.md",
  "entities/people/index.md",
  "entities/organizations/index.md",
  "sources/index.md",
  "raw/index.md",
];

describe("grouping and the Other bucket", () => {
  const pages = [
    page("concepts/alpha.md", "Alpha Concept", "First concept."),
    page("concepts/gamma.md", "Gamma"),
  ];
  const taxonomy: Taxonomy = {
    concept_themes: [["Theme One", ["alpha"]]],
  };

  it("puts a page absent from the taxonomy under ## Other", () => {
    const text = fileAt(buildIndexes(pages, taxonomy), "concepts/index.md");
    expect(text).toContain("## Theme One\n- [Alpha Concept](alpha.md)");
    expect(text).toContain("## Other\n- [Gamma](gamma.md)");
  });

  it("keeps a listed page out of ## Other", () => {
    const text = fileAt(buildIndexes(pages, taxonomy), "concepts/index.md");
    const other = text.slice(text.indexOf("## Other"));
    expect(other).not.toContain("alpha.md");
  });

  it("lists a slug under every theme that names it", () => {
    const result = buildIndexes([page("concepts/alpha.md", "Alpha")], {
      concept_themes: [
        ["Theme One", ["alpha"]],
        ["Theme Two", ["alpha"]],
      ],
    });
    const text = fileAt(result, "concepts/index.md");
    expect(text.split("(alpha.md)").length - 1).toBe(2);
    expect(text).not.toContain("## Other");
  });

  it("uses the filename stem when a page has no title", () => {
    const result = buildIndexes([page("concepts/gamma.md", null)], {});
    expect(fileAt(result, "concepts/index.md")).toContain(
      "- [gamma](gamma.md)",
    );
  });
});

describe("bullets and metadata", () => {
  it("softens brackets in the title", () => {
    const result = buildIndexes(
      [page("concepts/beta.md", "Beta: The [Bracketed] Concept")],
      {},
    );
    expect(fileAt(result, "concepts/index.md")).toContain(
      "- [Beta: The (Bracketed) Concept](beta.md)",
    );
  });

  it("adds the duration suffix only to raw bullets", () => {
    const result = buildIndexes(
      [
        page("concepts/alpha.md", "Alpha", "", "0:10:00"),
        page("raw/alpha.md", "Alpha Video", "", "0:10:00", "raw-transcript"),
      ],
      {},
    );
    expect(fileAt(result, "concepts/index.md")).not.toContain("0:10:00");
    expect(fileAt(result, "raw/index.md")).toContain(
      "- [Alpha Video](alpha.md) - 0:10:00",
    );
  });

  it("ends a description-free bullet at the closing parenthesis", () => {
    const result = buildIndexes([page("concepts/gamma.md", "Gamma")], {});
    expect(fileAt(result, "concepts/index.md")).toContain(
      "- [Gamma](gamma.md)\n",
    );
    expect(fileAt(result, "concepts/index.md")).not.toContain(
      "- [Gamma](gamma.md) -",
    );
  });

  it("keeps non-ASCII titles unchanged", () => {
    const result = buildIndexes([page("concepts/cafe.md", "Café Notes")], {});
    expect(fileAt(result, "concepts/index.md")).toContain(
      "- [Café Notes](cafe.md)",
    );
  });

  it("never leaks a CR from a CRLF-authored page", () => {
    const crlf: BundlePage = {
      path: "concepts/crlf.md",
      text:
        "---\r\n" +
        "type: concept\r\n" +
        'title: "CRLF Page"\r\n' +
        'description: "Windows authored."\r\n' +
        "---\r\n" +
        "\r\n" +
        "Body.\r\n",
    };
    const result = buildIndexes([crlf], {});
    const text = fileAt(result, "concepts/index.md");
    expect(text).not.toContain("\r");
    expect(text).toContain("- [CRLF Page](crlf.md) - Windows authored.");
  });
});

describe("empty bundle", () => {
  it("emits all seven indexes with headings and zero counts", () => {
    const result = buildIndexes([], {});
    expect(result.files.map((file) => file.path)).toEqual(SEVEN_PATHS);
    expect(result.log).toEqual([
      "Building indexes from scripts/taxonomy.json ...",
      "  wrote concepts/index.md (0 pages)",
      "  wrote entities/index.md",
      "  wrote entities/tools/index.md (0 pages)",
      "  wrote entities/people/index.md (0 pages)",
      "  wrote entities/organizations/index.md (0 pages)",
      "  wrote sources/index.md (0 pages)",
      "  wrote raw/index.md (0 transcripts)",
      "Done.",
    ]);

    for (const file of result.files) {
      // The entities root carries three fixed group links, not page bullets.
      if (file.path === "entities/index.md") continue;
      expect(file.text, file.path).not.toContain("- [");
    }
    expect(fileAt(result, "entities/index.md")).toContain(
      "- [Tools & products](tools/index.md)",
    );
  });
});

describe("idempotency and ordering", () => {
  it("ignores generated index pages fed back through buildIndexes", () => {
    const people = [
      page("entities/people/person-a.md", "Person A", "A person."),
      page("entities/people/person-b.md", "Person B"),
    ];
    const first = buildIndexes(people, {});
    const second = buildIndexes([...people, ...first.files], {});
    expect(fileAt(second, "entities/people/index.md")).toBe(
      fileAt(first, "entities/people/index.md"),
    );
  });

  it("orders by code point, not UTF-16 units or locale", () => {
    // U+FF5E (fullwidth tilde) sorts before U+1F600 (emoji) by code point but
    // after it by UTF-16 code unit, because the emoji is a surrogate pair.
    expect(compareCodepoint("～", "\u{1F600}")).toBeLessThan(0);
    expect(compareCodepoint("a", "a")).toBe(0);
    expect(compareCodepoint("b", "a")).toBeGreaterThan(0);
  });
});

/** A source page with an optional `source_kind`. */
function sourcePage(path: string, kind: string | null): BundlePage {
  const lines = ["---", "type: source"];
  if (kind !== null) lines.push(`source_kind: ${kind}`);
  lines.push("---", "", "Body.", "");
  return { path, text: lines.join("\n") };
}

/** Read a fixture or template file from the repository. */
function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

describe("bundle counts", () => {
  it("counts the clean fixture as one video and one web page", () => {
    const root = "../tests/fixtures/bundle-clean/";
    const pages: BundlePage[] = [
      { path: "sources/video-a.md", text: read(`${root}sources/video-a.md`) },
      { path: "sources/web-a.md", text: read(`${root}sources/web-a.md`) },
    ];
    expect(countBundle(pages)).toEqual({ videos: 1, webPages: 1 });
  });

  it("counts a legacy page with no source_kind as a video", () => {
    expect(countBundle([sourcePage("sources/legacy.md", null)])).toEqual({
      videos: 1,
      webPages: 0,
    });
  });

  it("normalizes source_kind case and surrounding space", () => {
    expect(countBundle([sourcePage("sources/upper.md", " WEB ")])).toEqual({
      videos: 0,
      webPages: 1,
    });
  });

  it("ignores reserved, nested, non-source and frontmatter-free pages", () => {
    const pages: BundlePage[] = [
      sourcePage("sources/index.md", "video"),
      sourcePage("sources/log.md", "web"),
      sourcePage("sources/nested/deep.md", "video"),
      sourcePage("docs/elsewhere.md", "video"),
      { path: "sources/note.md", text: "---\ntype: concept\n---\n" },
      { path: "sources/nothing.md", text: "No frontmatter.\n" },
    ];
    expect(countBundle(pages)).toEqual({ videos: 0, webPages: 0 });
  });

  it("skips an unsupported nested map without throwing", () => {
    const nested: BundlePage = {
      path: "sources/unparseable.md",
      text: "---\ntype: source\nmeta:\n  nested: true\n---\n",
    };
    expect(() => countBundle([nested])).not.toThrow();
    expect(countBundle([nested])).toEqual({ videos: 0, webPages: 0 });
  });
});

describe("coverage banner", () => {
  it("renders zero counts with the plural form", () => {
    expect(renderRootBanner({ videos: 0, webPages: 0 })).toBe(
      [
        ROOT_BANNER_START,
        "**Coverage:** 0 videos, 0 web pages",
        ROOT_BANNER_END,
      ].join("\n"),
    );
  });

  it("renders the singular form for exactly one", () => {
    const banner = renderRootBanner({ videos: 1, webPages: 1 });
    expect(banner).toContain("**Coverage:** 1 video, 1 web page");
    expect(banner).not.toContain("1 videos");
    expect(banner).not.toContain("1 web pages");
  });

  it("renders large counts as plain digits with no separators", () => {
    expect(renderRootBanner({ videos: 1234, webPages: 5678 })).toContain(
      "**Coverage:** 1234 videos, 5678 web pages",
    );
  });
});

describe("root index rebuild", () => {
  it("is idempotent on the committed template", () => {
    const template = read("../../../templates/okf-bundle/index.md");
    expect(template).toContain("<!-- GENERATED:BANNER -->");
    expect(template).toContain("**Coverage:** 0 videos, 0 web pages");
    expect(buildRootIndex(template, [])).toBe(template);
  });

  it("replaces the region and preserves the prose bytes around it", () => {
    const text = [
      "---",
      'okf_version: "0.1"',
      "---",
      "",
      "# Knowledge Bundle",
      "",
      "Intro paragraph.",
      "",
      ROOT_BANNER_START,
      "**Coverage:** 9 videos, 9 web pages",
      ROOT_BANNER_END,
      "",
      "Tail paragraph.",
      "",
    ].join("\n");
    const rebuilt = buildRootIndex(text, [sourcePage("sources/a.md", "video")]);
    expect(rebuilt).toBe(
      text.replace(
        "**Coverage:** 9 videos, 9 web pages",
        "**Coverage:** 1 video, 0 web pages",
      ),
    );
  });

  it("inserts the banner after the first H1 when the markers are absent", () => {
    const text = '---\nokf_version: "0.1"\n---\n\n# Title\n\nBody.\n';
    expect(buildRootIndex(text, [])).toBe(
      '---\nokf_version: "0.1"\n---\n\n# Title\n\n' +
        `${ROOT_BANNER_START}\n` +
        "**Coverage:** 0 videos, 0 web pages\n" +
        `${ROOT_BANNER_END}\n\n` +
        "Body.\n",
    );
  });

  it("inserts the banner with CRLF on a CRLF root index (WR-08)", () => {
    const text =
      '---\r\nokf_version: "0.1"\r\n---\r\n\r\n# Title\r\n\r\nBody.\r\n';
    const rebuilt = buildRootIndex(text, []);
    expect(rebuilt).toBe(
      '---\r\nokf_version: "0.1"\r\n---\r\n\r\n# Title\r\n\r\n' +
        `${ROOT_BANNER_START}\r\n` +
        "**Coverage:** 0 videos, 0 web pages\r\n" +
        `${ROOT_BANNER_END}\r\n\r\n` +
        "Body.\r\n",
    );
    // No lone LF survives: every inserted line ending matches the file.
    expect(rebuilt.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("throws a typed error on a single marker", () => {
    const text = "# Title\n\n<!-- GENERATED:BANNER -->\n**Coverage:** 1 video\n";
    let caught: unknown;
    try {
      buildRootIndex(text, []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RootIndexError);
    expect((caught as RootIndexError).code).toBe("unbalanced_markers");
    expect((caught as Error).message).toBe(
      "root index has an unbalanced banner marker pair",
    );
  });

  it("gains okf_version as the first frontmatter line when absent", () => {
    const text = '---\ntitle: "Bundle"\n---\n\n# Bundle\n';
    expect(buildRootIndex(text, [])).toContain(
      '---\nokf_version: "0.1"\ntitle: "Bundle"\n---',
    );
  });

  it("leaves an existing okf_version value unchanged", () => {
    const text = '---\nokf_version: "0.2"\n---\n\n# Bundle\n';
    const rebuilt = buildRootIndex(text, []);
    expect(rebuilt).toContain('okf_version: "0.2"');
    expect(rebuilt).not.toContain('okf_version: "0.1"');
  });

  it("preserves CRLF outside the banner region", () => {
    const text =
      '---\r\nokf_version: "0.1"\r\n---\r\n\r\n# Title\r\n\r\n' +
      `${ROOT_BANNER_START}\r\n` +
      "**Coverage:** 0 videos\r\n" +
      `${ROOT_BANNER_END}\r\n\r\nTail.\r\n`;
    const rebuilt = buildRootIndex(text, [
      sourcePage("sources/a.md", "video"),
      sourcePage("sources/b.md", "video"),
    ]);
    expect(rebuilt.slice(0, rebuilt.indexOf("<!"))).toBe(
      '---\r\nokf_version: "0.1"\r\n---\r\n\r\n# Title\r\n\r\n',
    );
    expect(rebuilt).toContain("**Coverage:** 2 videos, 0 web pages");
    const closing = rebuilt.lastIndexOf(ROOT_BANNER_END) + ROOT_BANNER_END.length;
    expect(rebuilt.slice(closing)).toBe("\r\n\r\nTail.\r\n");
  });

  it("inserts okf_version with CRLF in a CRLF frontmatter block", () => {
    const text = '---\r\ntitle: "Bundle"\r\n---\r\n\r\n# Bundle\r\n';
    expect(buildRootIndex(text, [])).toContain(
      '---\r\nokf_version: "0.1"\r\ntitle: "Bundle"\r\n---',
    );
  });
});

describe("determinism source assertion", () => {
  it("contains no locale, clock or Intl reference", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./indexes.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("localeCompare");
    expect(source).not.toContain("toLocaleString");
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/\bIntl\b/);
  });
});
