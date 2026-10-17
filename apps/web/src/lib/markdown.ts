// Markdown → HTML that can be put in the DOM (T-01-11, T-01-12, UI-09).
//
// Two guarantees, and neither is marked's to give:
//
// 1. NOTHING EXECUTES. The renderer's output is untrusted — it is a note, which
//    arrived from a downloaded file, a scraped page, or an LLM — so the string
//    this module returns has been through `sanitizeHtml` before a caller can
//    reach for `dangerouslySetInnerHTML`. Rendering and sanitizing are one
//    function because two functions is a caller who uses one of them.
// 2. A REFUSED URL IS STILL READABLE. marked's own `link` renderer calls
//    `cleanUrl` and, when it refuses a href, returns just the escaped link TEXT
//    — so `[click](javascript:…)` silently loses its brackets and stops looking
//    like a link at all. This app's contract (01-04-PLAN.md) is a tolerated span
//    carrying the original text: visible, inert, and still obviously a link the
//    author wrote. That needs a renderer override, so we have one.
//
// The body is what gets rendered. Frontmatter is the Frontmatter tab's business
// (`components/FrontmatterPanel.tsx`), and a `---` block that reached marked
// would come out as a heading and two paragraphs of YAML.
import { Marked, Renderer, type Tokens } from "marked";
import { isSafeUrl } from "./editor/urlSafety.js";
import { sanitizeHtml } from "./editor/sanitizeHtml.js";
import { splitFrontmatter } from "./frontmatter/parse.js";

export interface RenderOptions {
  /**
   * The second-pass hook: given an href, return the vault path when that link is
   * DEFINITIVELY missing (its directory has been read and does not hold it), or
   * null otherwise. `MarkdownView` supplies the tree-aware answer; omitted, no
   * link is called missing on this pass.
   */
  markBroken?: (href: string) => string | null;
}

/** `class` for an anchor that was refused a href — see the span below. */
const BLOCKED_CLASS = "md-link-blocked";

/** The HTML escape marked uses internally, for the one path marked cannot cover. */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * One instance for the process, built once.
 *
 * `gfm` for tables and strikethrough (the reference bundle uses both), `async:
 * false` so `parse` returns a string rather than a promise — every caller here
 * renders synchronously, and an accidental `Promise<string>` reaching
 * `dangerouslySetInnerHTML` renders the literal text `[object Promise]`.
 */
const md = new Marked({ gfm: true, async: false });

const renderer = new Renderer();

/**
 * marked's own anchor renderer, reached through the instance it was written for.
 *
 * Bound rather than copied: the original reads `this.parser` to render the
 * anchor's inline tokens, and the parser sets that field on THIS renderer when
 * the parse begins.
 */
const baseLink = renderer.link.bind(renderer);

renderer.link = (token: Tokens.Link): string => {
  if (isSafeUrl(token.href)) return baseLink(token);
  // An autolink (`<javascript:…>`) has no child tokens — its text IS the URL —
  // so there is nothing to parse inline and the literal must be escaped here.
  const label = token.autolink
    ? token.text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
    : renderer.parser.parseInline(token.tokens);
  return `<span class="${BLOCKED_CLASS}" role="note" aria-label="${escapeAttribute(
    token.text,
  )} — this link was refused">${label}</span>`;
};

md.setOptions({ renderer });

/**
 * Render a markdown document (or just its body) to sanitized HTML.
 *
 * Takes a whole document: the frontmatter is split off first, so a caller that
 * has already split it is not punished for passing the body instead.
 */
export function renderMarkdown(markdown: string, options?: RenderOptions): string {
  const { body } = splitFrontmatter(markdown);
  const html = md.parse(body, { async: false });
  return sanitizeHtml(html, options?.markBroken);
}

/** An escape for a value going into an attribute, in either quote style. */
function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}
