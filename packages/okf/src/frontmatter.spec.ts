/**
 * Frontmatter parser, canonical renderer and reference metadata reader.
 *
 * The cross-reader case is the frontmatter half of the byte contract: the
 * reference tool never writes frontmatter, so the provable claim is that a
 * page's parsed data, rendered by `renderFrontmatter`, is read back by the
 * reference-faithful `readIndexMeta` exactly as the original page was.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest); vitest resolves this
// builtin at run time.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  normalizeSourceKind,
  parseFrontmatter,
  parseFrontmatterSafe,
  readIndexMeta,
  renderFrontmatter,
} from "./frontmatter.js";
import type { OkfFrontmatter } from "./frontmatter.js";
import { readBundle } from "../tests/helpers/bundle.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../tests/fixtures/bundle-mini", import.meta.url),
);

/** Assert a parse throws the typed unsupported-YAML error. */
function expectUnsupported(text: string): void {
  let caught: unknown;
  try {
    parseFrontmatter(text);
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected a FrontmatterError").toBeInstanceOf(FrontmatterError);
  expect((caught as FrontmatterError).code).toBe("unsupported_yaml");
  expect((caught as FrontmatterError).message).toBe(
    "unsupported YAML in frontmatter",
  );
}

describe("parseFrontmatter", () => {
  it("parses the supported subset and preserves the body", () => {
    const text =
      "---\n" +
      "type: concept\n" +
      'title: "Alpha Concept"\n' +
      "rank: 3\n" +
      "immutable: true\n" +
      'tags: [alpha, demo]\n' +
      "---\n" +
      "\n" +
      "Body text.\n";

    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    const { data, body } = parsed as {
      data: OkfFrontmatter;
      body: string;
    };

    expect(Object.keys(data)).toEqual([
      "type",
      "title",
      "rank",
      "immutable",
      "tags",
    ]);
    expect(data.type).toBe("concept");
    expect(data.title).toBe("Alpha Concept");
    expect(data.rank).toBe(3);
    expect(data.immutable).toBe(true);
    expect(data.tags).toEqual(["alpha", "demo"]);
    expect(body).toBe("\nBody text.\n");
    expect(Object.getPrototypeOf(data)).toBeNull();
  });

  it("returns null without an opening fence", () => {
    expect(parseFrontmatter("# Just a page\n")).toBeNull();
  });

  it("returns null when the closing fence is missing", () => {
    expect(parseFrontmatter("---\ntitle: Open\n")).toBeNull();
  });

  it("parses inline arrays of strings and numbers", () => {
    const parsed = parseFrontmatter("---\ntags: [alpha, demo]\nnums: [1, -2]\n---\n");
    expect(parsed?.data.tags).toEqual(["alpha", "demo"]);
    expect(parsed?.data.nums).toEqual([1, -2]);
  });

  it("rejects a nested map", () => {
    expectUnsupported("---\nmeta:\n  nested: true\n---\n");
  });

  it("rejects a block scalar", () => {
    expectUnsupported("---\ndescription: |\n---\n");
  });

  it("rejects an anchor", () => {
    expectUnsupported("---\ntitle: &anchor\n---\n");
  });

  it("rejects an alias", () => {
    expectUnsupported("---\ntitle: *anchor\n---\n");
  });

  it("rejects a multi-document separator", () => {
    expectUnsupported("---\ntitle: one\n...\n---\n");
  });

  it("rejects a duplicate key instead of letting the last one win", () => {
    expectUnsupported("---\ntype: concept\ntype: raw-transcript\n---\n");
  });

  it("skips full-line comments, indented or not (WR-07)", () => {
    const parsed = parseFrontmatter(
      "---\n" +
        "# generated index: do not edit\n" +
        "  # an indented comment\n" +
        "type: concept\n" +
        "---\n\nBody.\n",
    );
    expect(Object.keys(parsed!.data)).toEqual(["type"]);
    expect(parsed?.data.type).toBe("concept");
  });

  it("strips an inline comment from a bare scalar (WR-07)", () => {
    const parsed = parseFrontmatter(
      "---\ntype: source\nsource_kind: web # captured page\n---\n",
    );
    expect(parsed?.data.source_kind).toBe("web");
    expect(normalizeSourceKind(parsed!.data)).toBe("web");
  });

  it("keeps a # inside a quoted value (WR-07)", () => {
    const parsed = parseFrontmatter('---\ntitle: "C# notes"\n---\n');
    expect(parsed?.data.title).toBe("C# notes");
  });

  it("strips a trailing comment after a quoted scalar (WR-03)", () => {
    const parsed = parseFrontmatter(
      '---\ntitle: "C# notes" # trailing\n---\n',
    );
    expect(parsed?.data.title).toBe("C# notes");
  });

  it("keeps a whitespace-preceded # inside a quoted scalar (WR-03)", () => {
    const parsed = parseFrontmatter(
      '---\ntitle: "value # kept" # trailing\n---\n',
    );
    expect(parsed?.data.title).toBe("value # kept");
  });

  it("strips a trailing comment after an inline array (WR-03)", () => {
    const parsed = parseFrontmatter("---\ntags: [a, b] # trailing\n---\n");
    expect(parsed?.data.tags).toEqual(["a", "b"]);
  });

  it("treats a comment-only value as empty, not as text (WR-03)", () => {
    const parsed = parseFrontmatter("---\nsource_kind: # web\n---\n");
    expect(parsed?.data.source_kind).toBe("");
    expect(normalizeSourceKind(parsed!.data)).toBe("");
  });

  it("does not treat an apostrophe in a plain scalar as a quote (WR-03)", () => {
    const parsed = parseFrontmatter("---\ntitle: don't panic # note\n---\n");
    expect(parsed?.data.title).toBe("don't panic");
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the prototype-reaching key %s",
    (key) => {
      expectUnsupported(`---\n${key}: poisoned\n---\n`);
    },
  );
});

describe("renderFrontmatter", () => {
  it("emits the canonical block", () => {
    const data: OkfFrontmatter = {
      type: "concept",
      title: "Beta: The [Bracketed] Concept",
      rank: 2,
      immutable: true,
      tags: ["alpha", "demo"],
    };
    expect(renderFrontmatter(data)).toBe(
      "---\n" +
        "type: concept\n" +
        'title: "Beta: The [Bracketed] Concept"\n' +
        "rank: 2\n" +
        "immutable: true\n" +
        "tags: [alpha, demo]\n" +
        "---\n",
    );
  });

  it("quotes values that would otherwise change meaning", () => {
    const rendered = renderFrontmatter({
      empty: "",
      spaced: " padded ",
      numeric: "123",
      booleanish: "true",
      commentish: "value # not a comment",
      colonish: "key: value",
      dashed: "- not a list",
      array: ["true", "1", "plain"],
    });
    expect(rendered).toBe(
      "---\n" +
        'empty: ""\n' +
        'spaced: " padded "\n' +
        'numeric: "123"\n' +
        'booleanish: "true"\n' +
        'commentish: "value # not a comment"\n' +
        'colonish: "key: value"\n' +
        'dashed: "- not a list"\n' +
        'array: ["true", "1", plain]\n' +
        "---\n",
    );
  });

  it("quotes values a YAML reader would misread (WR-01)", () => {
    const values = [
      "# comment",
      "%directive",
      "`tick",
      "] bracket",
      "} brace",
      ", comma",
      "? question",
      "trailing:",
      "null",
      "~",
      "yes",
      "no",
      "on",
      "off",
      "tab\t# comment",
    ];
    for (const value of values) {
      const rendered = renderFrontmatter({ title: value });
      expect(rendered, value).toContain('title: "');
      expect(parseFrontmatter(rendered)?.data.title, value).toBe(value);
    }
  });

  it("quotes an array item containing a comma (WR-02)", () => {
    const rendered = renderFrontmatter({ tags: ["a,b", "c"] });
    expect(rendered).toBe('---\ntags: ["a,b", c]\n---\n');
    const parsed = parseFrontmatter(rendered);
    expect(parsed?.data.tags).toEqual(["a,b", "c"]);
    expect(
      renderFrontmatter((parsed as { data: OkfFrontmatter }).data),
    ).toBe(rendered);
  });

  it("quotes array items containing a flow indicator (WR-05)", () => {
    const rendered = renderFrontmatter({ tags: ["a]b", "c}d", "e[f"] });
    expect(rendered).toBe('---\ntags: ["a]b", "c}d", "e[f"]\n---\n');
    const parsed = parseFrontmatter(rendered);
    expect(parsed?.data.tags).toEqual(["a]b", "c}d", "e[f"]);
    expect(
      renderFrontmatter((parsed as { data: OkfFrontmatter }).data),
    ).toBe(rendered);
  });

  it("is a fixed point when its own output is parsed and rendered again", () => {
    const first = renderFrontmatter({
      type: "concept",
      title: 'A "quoted" \\ path',
      tags: ["alpha", "demo"],
      nested: "line\nbreak",
    });
    const parsed = parseFrontmatter(first);
    expect(parsed).not.toBeNull();
    expect(renderFrontmatter((parsed as { data: OkfFrontmatter }).data)).toBe(
      first,
    );
  });
});

describe("readIndexMeta", () => {
  it("falls back to the filename stem when title is absent", () => {
    expect(readIndexMeta("---\ntype: concept\n---\n", "gamma")).toEqual({
      title: "gamma",
      description: "",
      duration: "",
    });
  });

  it("softens brackets in the title only", () => {
    const meta = readIndexMeta(
      '---\ntitle: "Beta: The [Bracketed] Concept"\n' +
        'description: "Keeps [brackets]."\n---\n',
      "beta",
    );
    expect(meta.title).toBe("Beta: The (Bracketed) Concept");
    expect(meta.description).toBe("Keeps [brackets].");
  });

  it("reads a 1 MiB single-line title unchanged", () => {
    const big = "x".repeat(1024 * 1024);
    const meta = readIndexMeta(`---\ntitle: ${big}\n---\n`, "stem");
    expect(meta.title).toBe(big);
  }, 5000);
});

describe("parseFrontmatterSafe", () => {
  it("returns null for text with no block", () => {
    expect(parseFrontmatterSafe("# no frontmatter\n")).toBeNull();
  });

  it("returns null for an unsupported block instead of throwing", () => {
    expect(parseFrontmatterSafe("---\nmeta:\n  nested: true\n---\n")).toBeNull();
  });

  it("returns the same data as parseFrontmatter for a valid block", () => {
    const text = '---\ntype: concept\ntitle: "Alpha Concept"\n---\n\nBody.\n';
    expect(parseFrontmatterSafe(text)?.data).toEqual(
      parseFrontmatter(text)?.data,
    );
  });
});

describe("cross-reader round-trip over the fixture", () => {
  it("rendered frontmatter reads back as the original metadata", () => {
    const bundle = readBundle(FIXTURE_ROOT);
    let parsedPages = 0;

    for (const page of bundle.pages) {
      const parsed = parseFrontmatterSafe(page.text);
      if (parsed === null) continue;
      parsedPages += 1;

      const name = page.path.slice(page.path.lastIndexOf("/") + 1);
      const stem = name.slice(0, -".md".length);
      const rendered = renderFrontmatter(parsed.data) + parsed.body;

      expect(readIndexMeta(rendered, stem), page.path).toEqual(
        readIndexMeta(page.text, stem),
      );
    }

    expect(parsedPages, "fixture pages with frontmatter").toBeGreaterThan(0);
  });
});


describe("CR-01 quoted first array item and escaped single quotes", () => {
  it("round-trips a quoted first item containing a hash", () => {
    const tags = ["a # b", "c"];
    expect(parseFrontmatter(renderFrontmatter({ tags }))?.data.tags).toEqual(
      tags,
    );
  });

  it("parses a quoted first item containing a hash", () => {
    expect(parseFrontmatter('---\ntags: ["a # b", c]\n---\n')?.data.tags).toEqual(
      ["a # b", "c"],
    );
    expect(parseFrontmatter('---\ntags: ["the #1 tool"]\n---\n')?.data.tags).toEqual(
      ["the #1 tool"],
    );
  });

  it("keeps a # in a single-quoted scalar with an escaped quote", () => {
    expect(
      parseFrontmatter("---\ntitle: 'it''s a # test'\n---\n")?.data.title,
    ).toBe("it's a # test");
  });

  it("keeps a # in a single-quoted array item with an escaped quote", () => {
    expect(
      parseFrontmatter("---\ntags: ['a''b # c', 'd']\n---\n")?.data.tags,
    ).toEqual(["a'b # c", "d"]);
  });
});

describe("WR-07/WR-08 regression", () => {
  it("parses array items containing apostrophes as separate items (WR-07)", () => {
    const parsed = parseFrontmatter('---\ntype: concept\ntags: [don\'t, demo]\n---\n')!;
    expect(parsed.data.tags).toEqual(["don't", "demo"]);
  });

  it("strips trailing comments on arrays with apostrophes (WR-07)", () => {
    const parsed = parseFrontmatter('---\ntype: concept\ntags: [don\'t, demo] # note\n---\n')!;
    expect(parsed.data.tags).toEqual(["don't", "demo"]);
  });

  it("renders arrays with apostrophes quoted (WR-07)", () => {
    const rendered = renderFrontmatter({ type: "concept", tags: ["don't", "demo"] });
    expect(parseFrontmatter(rendered)!.data.tags).toEqual(["don't", "demo"]);
  });

  it("quotes YAML-typed scalars when rendering (WR-08/WR-11)", () => {
    for (const value of [
      "True",
      "FALSE",
      "1.5",
      "0x10",
      ".inf",
      "2024-01-01",
      ".5",
      "1_000",
      "0b101",
      "y",
      "n",
    ]) {
      const rendered = renderFrontmatter({ title: value });
      expect(rendered).toContain(`title: "${value}"`);
      expect(parseFrontmatter(rendered)!.data.title).toBe(value);
    }
  });
});
