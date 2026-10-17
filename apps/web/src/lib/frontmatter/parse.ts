import type { Frontmatter } from "./types.js";

/**
 * Split a document into its leading frontmatter block and its body.
 *
 * A DELIMITER, not a parser: this finds the block and hands back its text and
 * everything after it. It validates no keys and parses no YAML — that is the OKF
 * library's job in Phase 2 (01-04-PLAN.md), and two YAML readers in one app is
 * one too many.
 *
 * The same rules the editor's own frontmatter decoration uses
 * (`components/MarkdownEditor.tsx`), because two different answers to "where
 * does the frontmatter end" is a bug with two homes:
 *
 * - The opening fence must be the document's FIRST line. A `---` further down is
 *   a thematic break, and treating it as an opener would swallow the note.
 * - The closing fence may be `---` or `...`.
 * - An unterminated opening fence is a thematic break too, not frontmatter. The
 *   search has to fail rather than guess where the block ends.
 */

/** A fence that could open the block: three or more `-`, or three or more `.`. */
const OPEN_FENCE = /^(?:-{3,}|\.{3,})$/;

/** A fence that closes it, with the editor's tolerance for trailing blanks. */
const CLOSE_FENCE = /^(?:-{3,}|\.{3,})[ \t]*$/;

function noBlock(body: string): { frontmatter: Frontmatter; body: string } {
  return { frontmatter: { raw: "", present: false }, body };
}

export function splitFrontmatter(markdown: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const lines = markdown.split("\n");
  // `\r` is stripped per line rather than throughout: a stray `\r` inside the
  // YAML is the author's, and normalising the body would silently edit a file
  // this app is only supposed to read.
  const strip = (line: string) => line.replace(/\r$/, "");

  // The opener is tested with surrounding blank space trimmed, the closer with
  // its trailing blanks tolerated — exactly the pair of tests the editor's
  // decoration makes, so the painted block and the split block agree.
  if (lines.length < 2 || !OPEN_FENCE.test(strip(lines[0] ?? "").trim())) {
    return noBlock(markdown);
  }
  for (let i = 1; i < lines.length; i++) {
    if (!CLOSE_FENCE.test(strip(lines[i] ?? ""))) continue;
    return {
      frontmatter: { raw: lines.slice(1, i).join("\n"), present: true },
      body: lines.slice(i + 1).join("\n"),
    };
  }
  return noBlock(markdown);
}
