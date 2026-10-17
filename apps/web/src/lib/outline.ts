import { splitFrontmatter } from "./frontmatter/parse.js";

/**
 * The document's headings, in order, with the line each one is on.
 *
 * The Outline tab's data (UI-01's `Outline`) and the thing an outline click
 * reveals: `MarkdownEditor` puts the caret on `line`, which is why every number
 * here is a ONE-BASED line in the WHOLE document — frontmatter included — and
 * not an index into the body. The split below is what makes that true rather
 * than a second, subtly different count of newlines.
 *
 * Fenced code is skipped. A `#` line inside a ``` fence is a comment in someone
 * else's language, and an outline that lists it sends the reader to a line that
 * is not a heading. ATX (`#`) only: a Setext heading — text underlined with `===`
 * — is also how `lezer` reads `key: value\n---`, so counting those would list
 * frontmatter as prose (see the note in `components/MarkdownEditor.tsx`).
 */

export interface Heading {
  /** 1 for `#`, 6 for `######`. */
  depth: number;
  /** The heading's text, markers and trailing hashes removed. */
  text: string;
  /** One-based line number in the whole document. */
  line: number;
}

/** An ATX heading: 1-6 hashes, then a space (or nothing), then the text. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;

/** A fence that opens or closes a block, with its info string ignored. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function extractHeadings(markdown: string): Heading[] {
  const { body } = splitFrontmatter(markdown);
  // The body is the document minus a prefix, so the prefix's line count is the
  // offset — the number of newlines in it. Derived, never recomputed from the
  // fences: a second fence regex would eventually disagree with the first.
  const offset = body.length === markdown.length ? 0 : countLines(markdown.slice(0, markdown.length - body.length));

  const headings: Heading[] = [];
  let fence: string | null = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker[0] ?? "`";
      } else if (marker.startsWith(fence)) {
        // Only a fence of the SAME character closes it, and only one at least as
        // long: a ``` block is not closed by ~~~, and an inner ``` inside a
        // ```` block is content.
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = ATX.exec(line);
    if (!heading) continue;
    headings.push({
      depth: (heading[1] ?? "#").length,
      text: (heading[2] ?? "").trim(),
      line: offset + i + 1,
    });
  }
  return headings;
}

/** Newlines in a prefix that ends at a line boundary. */
function countLines(prefix: string): number {
  let count = 0;
  for (const ch of prefix) if (ch === "\n") count++;
  return count;
}
