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
