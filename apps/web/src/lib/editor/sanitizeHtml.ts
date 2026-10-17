// The app's one HTML sanitizer: it turns an untrusted HTML fragment into markup
// that renders but cannot run. PORTED from
// `baalda/app/apps/desktop/src/lib/editor/sanitizeHtml.ts` (read-only reference).
//
// A note is untrusted input — it arrives from a downloaded file, from a web page
// this app scraped, or from an LLM — and this is the only place the read view
// hands a string to `dangerouslySetInnerHTML`. Everything rendered from markdown
// passes through here, including the string `lib/markdown.ts` just built.
//
// ADAPTED ON PORT (recorded in 01-04-SUMMARY.md), three changes:
//
// 1. STRING IN, STRING OUT. The reference wrote into a target element
//    (`renderEmbeddedHtml(target, html, resolveAsset)`) because CodeMirror's
//    `innerHTML` lived in a widget. A React view needs the string for
//    `dangerouslySetInnerHTML`, so `sanitizeHtml(html)` is the primary export.
//    The reference's signature is kept beside it as `renderEmbeddedHtml` — one
//    implementation, two spellings — so the ported shape is still there for a
//    caller that holds a real element.
// 2. ANCHORS KEEP A SAFE HREF. The reference moved an external `href` to
//    `data-href` and let the editor's own click handler open it externally. This
//    app's read view wants the opposite: an ordinary anchor for an http(s)
//    target so the browser opens it in a new tab, and `MarkdownView` intercepts
//    the vault-relative ones itself. So the href stays and the external
//    attributes are added instead.
// 3. AN UNKEEPABLE HREF BECOMES A SPAN. The reference stripped the attribute
//    (leaving an inert `<a>`); a stripped anchor still LOOKS broken. 01-04's
//    contract is a tolerated span carrying the original text, so the element is
//    replaced rather than hollowed out.
import { isExternalUrl, isSafeUrl } from "./urlSafety.js";

/** Turns an image `src` into a URL this app can load. */
export type ResolveAsset = (src: string) => string;

/** Tags that could execute code or leak styles — dropped entirely. */
export const BLOCKED_HTML_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "META",
  "BASE",
]);

/** Every URL-bearing attribute: what a click or a fetch could reach. */
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href"]);

/** A resolved-but-missing link, marked so it reads as tolerated, not as an error. */
const BROKEN_CLASS = "md-link-broken";

/**
 * Sanitize an HTML fragment. Returns markup safe to inject.
 *
 * A *render, never a run*: `<script>`/`<style>`/frames are dropped, every `on*`
 * handler and `style` attribute is stripped, and a URL attribute that fails the
 * safety check is removed — or, on an anchor, the whole element becomes a span
 * so the link's text survives without a target. `DOMParser` splits head/body
 * even for a full-document paste, so `<!DOCTYPE html>…<body>…` returns just its
 * body content.
 *
 * `markBroken` is the optional second pass the read view supplies: given the
 * anchor's `href` it answers a vault-relative path when that link is
 * DEFINITIVELY missing (its directory has been read and does not hold it). Only
 * then is the anchor swapped for the same tolerated span, because a link into a
 * directory nobody has opened yet may well be fine.
 */
export function sanitizeHtml(
  html: string,
  markBroken?: (href: string) => string | null,
): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("*").forEach((el) => {
    // Uppercase so a foreign-content (SVG/MathML) <script> — whose tagName is
    // lowercase — is caught by the same blocklist as an HTML one.
    if (BLOCKED_HTML_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        // Inline event handlers.
        el.removeAttribute(attr.name);
      } else if (name === "style") {
        // Inline styles enable full-screen fixed overlays / UI spoofing.
        el.removeAttribute(attr.name);
      } else if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A") rewriteAnchor(el, markBroken);
  });
  return parsed.body.innerHTML;
}

/**
 * An anchor that came through the safety check, or a span in its place.
 *
 * Two anchors end up as a span: one whose href is unsafe (dropped by the loop
 * above, so it has no href at all — an `<a>` with no target is still something a
 * reader clicks, and a click that does nothing is worse than a link that says it
 * has nowhere to go) and one whose in-vault target is known to be missing.
 */
function rewriteAnchor(el: Element, markBroken?: (href: string) => string | null): void {
  const href = el.getAttribute("href");
  const missing = href !== null && markBroken ? markBroken(href) : null;
  if (href === null || missing !== null) {
    const span = el.ownerDocument.createElement("span");
    span.className = BROKEN_CLASS;
    const path = missing ?? href ?? "";
    span.setAttribute("title", `Not in this vault: ${path}`);
    // The accessible indication: an `aria-label` on a bare span is ignored by
    // assistive tech (its role has no name from author), so the span carries a
    // note role — which does — and the label repeats the visible words.
    span.setAttribute("role", "note");
    span.setAttribute("aria-label", `${el.textContent ?? ""} — not in this vault: ${path}`);
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
    return;
  }
  // A URL that leaves the app opens in its own tab, with the rel pair that stops
  // the new document reaching back through `window.opener`.
  if (isExternalUrl(href)) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
}

/**
 * The reference's own signature: sanitize into `target` as real DOM.
 *
 * Kept because it is the shape the ported module had, and because "sanitize a
 * string" and "put it somewhere safe" are one decision, not two.
 */
export function renderEmbeddedHtml(
  target: HTMLElement,
  html: string,
  resolveAsset: ResolveAsset,
): void {
  const parsed = new DOMParser().parseFromString(sanitizeHtml(html), "text/html");
  // Point <img> at a loadable URL so vault-local images display. Done after
  // sanitizing, so the resolver's answer is never what the safety check judged.
  parsed.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", resolveAsset(src));
  });
  target.innerHTML = parsed.body.innerHTML;
}
