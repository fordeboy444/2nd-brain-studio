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
import { buildIndexes, compareCodepoint } from "./indexes.js";
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
