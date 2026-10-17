import { useMemo, type MouseEvent } from "react";
import { resolveLink } from "../lib/linkResolve.js";
import { renderMarkdown } from "../lib/markdown.js";
import { sanitizeHtml } from "../lib/editor/sanitizeHtml.js";
import { splitFrontmatter } from "../lib/frontmatter/parse.js";
import { useStore } from "../store.js";

/**
 * A document, read-only (UI-09, UI-10).
 *
 * The read half of the Read/Edit toggle. It renders the SAME buffer the editor
 * holds — not the last server content — so switching to read never shows a
 * version of the note the user did not write, and switching back loses nothing.
 *
 * Three things make this more than `dangerouslySetInnerHTML`:
 *
 * 1. THE HTML IS SANITIZED TWICE, ON PURPOSE. `renderMarkdown` sanitizes its own
 *    output so no caller can mount it unsanitized; this component sanitizes
 *    again with the tree-aware `markBroken` hook, which the renderer cannot
 *    supply because it has no access to the sidebar's state. Sanitizing is
 *    idempotent and a note is a few kilobytes, so the second pass buys a
 *    guarantee (T-01-11) for the cost of one `DOMParser` call.
 * 2. IN-VAULT LINKS NAVIGATE INSIDE THE APP. A relative `.md` target is
 *    classified by `resolveLink`, the click is intercepted, and the target opens
 *    in a tab. The browser is never asked to navigate, so the shell cannot be
 *    replaced by a file listing (or by anything else the link pointed at).
 * 3. A MISSING TARGET IS A SPAN, NOT AN ERROR. `[other](gone.md)` whose
 *    directory has been read and does not hold `gone.md` renders as the tolerated
 *    span `sanitizeHtml` builds — the link's own words, no href, an accessible
 *    note — because in a vault full of drafts and renames a dead link is normal
 *    (UI-10).
 */

export function MarkdownView() {
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) ?? null);
  const vaultId = useStore((s) => s.currentVault?.id ?? null);
  const treeState = useStore((s) => s.treeState);
  const openFile = useStore((s) => s.openFile);

  const content = tab?.buffer ?? "";
  const path = tab?.path ?? "";

  const html = useMemo(() => {
    const { body } = splitFrontmatter(content);
    // Only a target in a directory that has actually been READ can be called
    // missing; `resolveLink` answers `null` for everything else.
    const markBroken = (href: string) => {
      const target = resolveLink(href, path, treeState);
      return target.kind === "broken" && target.reason === "missing" ? target.path : null;
    };
    return sanitizeHtml(renderMarkdown(body), markBroken);
  }, [content, path, treeState]);

  if (!tab) return null;

  /**
   * One handler for every anchor the document produced.
   *
   * `external` is NOT intercepted: the sanitizer already gave those anchors
   * `target="_blank"` and the `noopener noreferrer` pair, and the browser's own
   * new-tab gesture is the behaviour the UI spec asks for. An in-document anchor
   * is left to the browser too — it is the same document, so nothing can leave
   * the shell.
   */
  function onClick(e: MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (href === null) return;
    const target = resolveLink(href, path, treeState);
    if (target.kind === "vault" && vaultId) {
      e.preventDefault();
      openFile(vaultId, target.path);
      return;
    }
    // An asset has no URL this app serves yet, and a broken target has nowhere
    // to go: both stop the browser rather than letting it navigate to a path it
    // would resolve against the app's own origin.
    if (target.kind === "asset" || target.kind === "broken") e.preventDefault();
  }

  return (
    <div
      className="editor-column"
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div
        className="md-view"
        onClick={onClick}
        // The one place this app hands a string to the DOM, and the string has
        // been through the sanitizer on the line above it.
        dangerouslySetInnerHTML={{ __html: html }}
        style={{
          flex: 1,
          minHeight: 0,
          padding: "var(--sp-5) var(--editor-pad-x) var(--sp-8)",
          color: "var(--text-primary)",
          fontSize: "var(--fs-md)",
          lineHeight: 1.65,
        }}
      />
    </div>
  );
}
