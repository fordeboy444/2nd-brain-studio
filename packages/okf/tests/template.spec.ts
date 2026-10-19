import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBundle } from "../src/lint.js";

/**
 * The scaffold template must lint clean as a whole tree. E1 skips only
 * `index.md` and `log.md`, so every other root markdown file needs
 * frontmatter — a fresh vault must not fail its own first lint.
 */

const TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/okf-bundle",
);

// The scaffold's empty directories are real link targets even though no pages
// live in them yet.
const SCAFFOLD_DIRS = [
  "concepts",
  "entities",
  "entities/tools",
  "entities/people",
  "entities/organizations",
  "sources",
  "raw",
];

describe("okf-bundle template", () => {
  it("lints every root markdown file with zero errors", async () => {
    const names = (await readdir(TEMPLATE_DIR)).filter((name) => name.endsWith(".md"));
    const pages = await Promise.all(
      names.map(async (name) => ({
        path: name,
        text: await readFile(resolve(TEMPLATE_DIR, name), "utf8"),
      })),
    );

    const result = lintBundle(pages, "okf-bundle-template", {
      paths: SCAFFOLD_DIRS,
    });

    expect(result.errors).toEqual([]);
  });
});
