import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateField, type Text } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { jsonLanguage } from "@codemirror/lang-json";
import { AsyncButton } from "./AsyncButton.js";
import { Banner } from "./Banner.js";
import { editorTheme, markdownHighlight } from "../lib/editor/theme.js";
import { isDirty, useStore } from "../store.js";

/**
 * The markdown editor (UI-03): CodeMirror 6 over the open tab's buffer.
 *
 * The store owns the document, this owns the view. Every keystroke goes one way
 * — `onChange` → `setBuffer` — and the only thing that writes back into the
 * view is the store's buffer changing underneath it (`@uiw/react-codemirror`
 * replaces the document for us, annotated so it is not mistaken for typing).
 * That is what makes "reload from disk" and a resolved conflict able to replace
 * the text without a second, competing source of truth.
 *
 * The measure is the UI spec's 88ch, and it is NOT set here: the wrapper is
 * `.editor-column`, where `--editor-pad-x` is composed (`styles/tokens.css`),
 * and `lib/editor/theme.ts` puts that padding on `.cm-line`. Padding — never
 * margin — because `drawSelection()` derives every selection rectangle from the
 * first line's padding.
 *
 * The save shortcut is a WINDOW-level keydown listener rather than a CodeMirror
 * keymap. Two reasons: the shortcut has to work while the tree has focus (the
 * user just clicked a file and has not typed yet), and a plain bubbling event
 * is what an automated test can drive without reaching into CodeMirror's key
 * handling. `saveActive()` refuses a save that is already in flight, and the
 * store is written synchronously, so a burst of keydowns dispatches exactly one
 * write for the keystroke burst that provoked it.
 */

/** `---` or `...` alone on a line: the frontmatter fences. */
const FRONTMATTER_FENCE = /^(-{3,}|\.{3,})$/;

/** A fence that opens a document does not close itself. */
const FRONTMATTER_CLOSE = /^(-{3,}|\.{3,})\s*$/;

/**
 * The 1-based first and last line of the leading frontmatter block, or `null`.
 *
 * A leading `---` with no closing fence is a thematic break, not frontmatter, so
 * the search has to fail rather than guess.
 */
function frontmatterBlock(doc: Text): { first: number; last: number } | null {
  if (doc.lines < 2) return null;
  if (!FRONTMATTER_FENCE.test(doc.line(1).text.trim())) return null;
  for (let n = 2; n <= doc.lines; n++) {
    if (FRONTMATTER_CLOSE.test(doc.line(n).text)) return { first: 1, last: n };
  }
  return null;
}

/**
 * Paint the leading frontmatter block as a block, using the theme's own
 * `.cm-frontmatter` / `.cm-frontmatter-fence` classes.
 *
 * ADAPTATION, recorded in 01-04-SUMMARY.md: the markdown package has no
 * frontmatter parser, and its own theme comment says why it still needs these
 * classes — with no parser, `lezer` reads `key: value\n---` as a *Setext
 * heading*, so the syntax highlighter puts heading spans on the frontmatter
 * body. The class is what overrides that. A true nested YAML parse would need
 * a frontmatter parser this app has no approved dependency for, so the block is
 * marked here instead and the frontmatter is read as text in the mean time
 * (the Frontmatter tab presents it parsed).
 *
 * A `StateField`, not a `ViewPlugin`: a view plugin's decorations may not
 * outlive the viewport, and the block stays decorated while the reader scrolls
 * to the end of a long note.
 */
function buildFrontmatterDecorations(doc: Text): DecorationSet {
  const block = frontmatterBlock(doc);
  if (!block) return Decoration.none;
  const ranges = [];
  for (let n = block.first; n <= block.last; n++) {
    const fence = n === block.first || n === block.last;
    ranges.push(
      Decoration.line({ class: fence ? "cm-frontmatter cm-frontmatter-fence" : "cm-frontmatter" }).range(
        doc.line(n).from,
      ),
    );
  }
  return Decoration.set(ranges, true);
}

const frontmatterDecoration = StateField.define<DecorationSet>({
  create: (state) => buildFrontmatterDecorations(state.doc),
  update: (deco, tr) => (tr.docChanged ? buildFrontmatterDecorations(tr.state.doc) : deco),
  provide: (field) => EditorView.decorations.from(field),
});

/** The platform's save modifier, spelled the way the platform spells it. */
function saveShortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘S" : "Ctrl+S";
}

export function MarkdownEditor() {
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) ?? null);
  const setBuffer = useStore((s) => s.setBuffer);
  const saveActive = useStore((s) => s.saveActive);
  const saveError = useStore((s) => s.saveError);
  const conflict = useStore((s) => s.conflict);
  const reloadFromDisk = useStore((s) => s.reloadFromDisk);
  const keepMine = useStore((s) => s.keepMine);
  // A conflict the server answered with no hash is a create conflict: the file
  // was deleted on disk while the tab held a hash for it. There is no server
  // version to reload, so the banner offers only the recreating action.
  const conflictHere =
    conflict !== null && conflict.path === tab?.path ? conflict : null;
  const isCreateConflict = conflictHere !== null && conflictHere.currentHash === null;
  const revealRequest = useStore((s) => s.pendingRevealLine);
  const consumeReveal = useStore((s) => s.consumeReveal);

  const [view, setView] = useState<EditorView | null>(null);

  // Built once: CodeMirror reconfigures the whole view whenever this array's
  // identity changes, and none of these extensions depend on app state.
  const extensions = useMemo(
    () => [
      // ```json fences get real JSON highlighting. This is also the one place
      // `@codemirror/lang-json` reaches the document: frontmatter is YAML, and
      // the markdown package has no frontmatter parser to nest one into (see
      // the note on the decoration field above).
      markdown({ codeLanguages: (info) => (info.trim() === "json" ? jsonLanguage : null) }),
      // Long prose wraps instead of scrolling sideways — a writing surface, not
      // a code surface.
      EditorView.lineWrapping,
      // The editable element inside CodeMirror is `.cm-content`, not the
      // wrapper, so the label has to go on the content attributes.
      EditorView.contentAttributes.of({ "aria-label": "Note body", role: "textbox" }),
      frontmatterDecoration,
      markdownHighlight,
      editorTheme,
    ],
    [],
  );

  // Save on the platform shortcut. `preventDefault` matters: Chrome's own
  // Ctrl+S is "save the page", and a web app that lets the page-save dialog
  // open has not taken the shortcut, it has lost it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "s" && e.key !== "S") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      void saveActive();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  // An outline click asks the editor to reveal a line. The request is consumed
  // once, and only once there is a view to put the caret in — a request that
  // arrives while the document is still loading has to survive until the view
  // exists, not be swallowed by an effect that ran too early.
  useEffect(() => {
    if (revealRequest === null || !view) return;
    const line = consumeReveal();
    if (line === null) return;
    const doc = view.state.doc;
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    view.focus();
  }, [revealRequest, view, consumeReveal]);

  if (!tab) return null;

  const dirty = isDirty(tab);
  // The hash the SERVER gave us for this content — from the read, or from the
  // last successful write. Until one of those has landed the tab has no base:
  // there is nothing to compare the buffer against and nothing safe to send, so
  // the save shortcut stays inert and says so instead of opening a 409 on the
  // user's first keystroke.
  const awaitingServerHash = tab.baseHash === null;
  const status = tab.saving
    ? { text: "Saving…", className: "save-indicator saving" }
    : dirty
      ? { text: `Unsaved changes — ${saveShortcutLabel()} to save`, className: "save-indicator" }
      : awaitingServerHash
        ? { text: "Loading…", className: "save-indicator" }
        : { text: "Saved", className: "save-indicator" };

  return (
    <div
      className="editor-column"
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: "var(--sp-2)",
          paddingTop: "var(--sp-2)",
          paddingInline: "calc(var(--editor-pad-x) + var(--sp-3))",
          flexShrink: 0,
        }}
      >
        <span className={status.className} role="status" aria-live="polite">
          {status.text}
        </span>
      </div>

      {/* The 409 question (D-07), and it is a question: the store refused the
          save, the buffer is exactly what the user typed, and nothing moves
          until one of these two buttons is pressed. Both actions are spelled
          the way the UI spec spells them, because the copy IS the contract for
          a decision this expensive to get wrong.

          `Banner` brings its own margins — the strip's insets — which is why
          there is no wrapper here: nesting it in a padded box would inset it
          twice. */}
      <Banner
        show={conflictHere !== null}
        role="alert"
        className="conflict-banner"
      >
        <span>
          {isCreateConflict
            ? "This file no longer exists on disk."
            : "This file changed on disk since you opened it."}
        </span>
        <div className="banner-actions">
          {/* Reload is offered only when the server sent a version to reload.
              On a create conflict there is none, and reloading would replace
              the user's text with an empty document and mark the tab clean. */}
          {isCreateConflict ? null : (
            <button type="button" onClick={reloadFromDisk}>
              Reload from disk
            </button>
          )}
          {/* Re-sends the buffer, rebased on the hash the conflict returned, so
              the user's text wins deliberately rather than by accident. With no
              hash to rebase on, the same action recreates the deleted file. */}
          <AsyncButton className="primary" spinnerTone="on-accent" onClick={keepMine}>
            {isCreateConflict ? "Recreate" : "Keep mine"}
          </AsyncButton>
        </div>
      </Banner>

      {/* A save that failed for some other reason. Also a report, not a rescue:
          the buffer is not rolled back anywhere in the store, so the text is
          still on screen and trying again is all that is needed. The server's
          own sentence follows the fixed one — the fixed one says the edit is
          safe, this one says what refused it. */}
      <Banner show={saveError !== null && saveError.path === tab.path} role="alert">
        <span>Save failed. Your edit is still here — try again.</span>
        {saveError && saveError.path === tab.path ? (
          <span style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-sm)" }}>
            {saveError.message}
          </span>
        ) : null}
      </Banner>

      <div style={{ flex: 1, minHeight: 0 }}>
        <CodeMirror
          value={tab.buffer}
          height="100%"
          onChange={setBuffer}
          extensions={extensions}
          // The theme draws the surface, the caret and the selection, so the
          // library's own light/dark sheets are off and so is the default
          // highlight style — two highlight styles on one document is one too
          // many, and the second one wins by source order, not by intent.
          theme="none"
          basicSetup={{
            lineNumbers: false,
            syntaxHighlighting: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            foldGutter: true,
            tabSize: 2,
          }}
          onCreateEditor={(createdView) => setView(createdView)}
          // The tree is where files are found; the editor should not steal the
          // caret from a click that is still travelling through it.
          autoFocus={false}
          // `height="100%"` sizes `.cm-editor`; the wrapper div this library
          // renders around it needs the same, and it has no class of ours.
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
