/**
 * The full imported reference bundle, linted read-only.
 *
 * This is the phase's proof against real data, not the small fixture: the
 * unmodified `cole-medin-knowledge-base/` bundle must scan more than 500
 * pages, report zero errors, exit 0, and produce exactly the five measured E8
 * warnings on legacy `videos:` pages. The `videos`/`sources` key counts show
 * E8 actually ran with the legacy severity split rather than being skipped.
 *
 * The case never writes under the reference root. A missing checkout skips
 * loudly so a machine without the reference repository still runs the suite.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest); vitest resolves this
// builtin at run time.
import { existsSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { join } from "node:path";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintBundle } from "../src/index.js";
import { readBundle } from "./helpers/bundle.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REFERENCE_ROOT =
  process.env.OKF_REFERENCE_ROOT?.trim() ||
  join(REPO_ROOT, "cole-medin-knowledge-base");

/** The five measured below-threshold quotes, and no others. */
const FIVE_WARNING_PAGES = [
  "concepts/mcp.md",
  "concepts/no-code-agents.md",
  "concepts/prd-first-development.md",
  "entities/organizations/dynamous.md",
  "entities/tools/qdrant.md",
];

/** The frontmatter slice, or an empty string when the page has none. */
function frontmatter(text: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  return end === -1 ? "" : text.slice(3, end);
}

/** The citing page named by an E8 message. */
function citingPage(message: string): string {
  return message.slice(message.lastIndexOf(": ") + 2);
}

describe("reference bundle", () => {
  it(
    "lints with zero errors and only the five measured legacy E8 warnings",
    () => {
      if (!existsSync(REFERENCE_ROOT)) {
        console.log(`REFERENCE BUNDLE SKIPPED: ${REFERENCE_ROOT} not found`);
        return;
      }

      const { pages, paths } = readBundle(REFERENCE_ROOT, {
        excludeTopLevel: [".git", ".claude", "CLAUDE.md"],
      });
      const result = lintBundle(pages, "cole-medin-knowledge-base", { paths });

      expect(result.scanned).toBe(pages.length);
      expect(result.scanned).toBeGreaterThan(500);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(5);
      expect(result.exitCode).toBe(0);

      for (const warning of result.warnings) {
        expect(warning.rule).toBe("E8");
        expect(warning.severity).toBe("warning");
      }
      expect(result.warnings.map((warning) => citingPage(warning.message)).sort())
        .toEqual([...FIVE_WARNING_PAGES].sort());

      const withVideos = pages.filter((page) =>
        /^videos\s*:/m.test(frontmatter(page.text)),
      ).length;
      const withSources = pages.filter((page) =>
        /^sources\s*:/m.test(frontmatter(page.text)),
      ).length;
      expect(withVideos).toBeGreaterThanOrEqual(400);
      expect(withSources).toBe(0);
    },
    120_000,
  );
});
