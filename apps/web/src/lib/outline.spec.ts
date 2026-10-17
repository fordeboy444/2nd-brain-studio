import { describe, expect, it } from "vitest";
import { extractHeadings } from "./outline.js";

/* outline spec — the Outline tab's data (UI-01, UI-03).

   The plan's acceptance criteria name one case here explicitly: a heading-shaped
   line inside a fenced block is not a heading. The rest pin the numbers, because
   `line` is not decoration — it is what an outline click reveals in the editor,
   and an off-by-one lands the caret on the wrong paragraph. */

describe("extractHeadings", () => {
  it("reads depth, text and one-based line", () => {
    expect(extractHeadings("# One\n\ntext\n\n## Two\n\n### Three")).toEqual([
      { depth: 1, text: "One", line: 1 },
      { depth: 2, text: "Two", line: 5 },
      { depth: 3, text: "Three", line: 7 },
    ]);
  });

  it("excludes a heading-shaped line inside a fenced block", () => {
    const headings = extractHeadings(
      ["# Real", "", "```sh", "# not a heading", "```", "", "## Also real"].join("\n"),
    );
    expect(headings.map((h) => h.text)).toEqual(["Real", "Also real"]);
    expect(headings[1]?.line).toBe(7);
  });

  it("excludes fences opened with tildes, and headings after them", () => {
    const headings = extractHeadings(["~~~", "## hidden", "~~~", "## shown"].join("\n"));
    expect(headings.map((h) => h.text)).toEqual(["shown"]);
  });

  it("is not closed by a fence of a different character", () => {
    const headings = extractHeadings(["```", "## hidden", "~~~", "## also hidden", "```", "## shown"].join("\n"));
    expect(headings.map((h) => h.text)).toEqual(["shown"]);
  });

  it("treats an unterminated fence as running to the end", () => {
    const headings = extractHeadings(["# Real", "```", "## hidden"].join("\n"));
    expect(headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("counts lines in the WHOLE document, frontmatter included", () => {
    const headings = extractHeadings(
      ["---", "title: A note", "---", "", "# Heading", "", "## Second"].join("\n"),
    );
    // The reveal target is a line in the file the editor holds, not in the body.
    expect(headings).toEqual([
      { depth: 1, text: "Heading", line: 5 },
      { depth: 2, text: "Second", line: 7 },
    ]);
  });

  it("does not mistake frontmatter for a heading", () => {
    const headings = extractHeadings(["---", "title: A note", "---", "body"].join("\n"));
    expect(headings).toEqual([]);
  });

  it("strips trailing hashes and surrounding space", () => {
    expect(extractHeadings("## Spaced ##  ")).toEqual([{ depth: 2, text: "Spaced", line: 1 }]);
  });

  it("ignores a line with too many hashes or no hashes at all", () => {
    expect(extractHeadings("####### seven\n#not a heading\nplain text")).toEqual([]);
  });

  it("handles carriage returns without shifting the count", () => {
    expect(extractHeadings("# One\r\n\r\ntext\r\n\r\n## Two")).toEqual([
      { depth: 1, text: "One", line: 1 },
      { depth: 2, text: "Two", line: 5 },
    ]);
  });

  it("returns nothing for a document with no headings", () => {
    expect(extractHeadings("just a paragraph\n\nand another")).toEqual([]);
    expect(extractHeadings("")).toEqual([]);
  });
});
