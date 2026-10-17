// One answer to "may this URL attribute survive sanitisation?", shared by the
// sanitizer (`sanitizeHtml.ts`) and by the markdown renderer
// (`lib/markdown.ts`). PORTED from
// `baalda/app/apps/desktop/src/lib/editor/urlSafety.ts` (read-only reference);
// the body is the reference's, unchanged.
//
// RENAMED ON PORT (recorded in 01-04-SUMMARY.md): the reference exported
// `isDangerousUrl` and both call sites asked `if (isDangerousUrl(x))` to decide
// what to STRIP. This app asks the same question at a different seam — what may
// be kept — and 01-04-PLAN.md names the export `isSafeUrl`, so the predicate is
// the reference's inverted and the name says which way round it reads. A
// negated call at every site is how the two directions drift.

/**
 * Is a URL safe to keep as `href` / `src`?
 *
 * Browsers ignore ASCII whitespace and control characters inside a scheme, so
 * `java\tscript:` executes — those are stripped before the check, otherwise a
 * single tab defeats it. Script-y schemes and non-image `data:` (which can carry
 * `data:text/html`) are the two families that must not survive.
 */
export function isSafeUrl(raw: string): boolean {
  const v = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (v.startsWith("data:")) return v.startsWith("data:image/");
  return !v.startsWith("javascript:") && !v.startsWith("vbscript:");
}

/**
 * Does this URL leave the app for another origin (or another application)?
 *
 * `http(s)` and `mailto` are the only schemes the shell hands to the browser;
 * everything else is either a vault-relative path or a scheme this app handles
 * itself (`#fragment`). Only called on URLs `isSafeUrl` has already accepted.
 */
export function isExternalUrl(raw: string): boolean {
  const v = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return v.startsWith("http://") || v.startsWith("https://") || v.startsWith("mailto:");
}
