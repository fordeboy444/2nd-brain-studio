import { useMemo } from "react";
import { splitFrontmatter } from "../lib/frontmatter/parse.js";
import { useStore } from "../store.js";

/**
 * The Frontmatter tab (UI-03): the open document's leading block, verbatim.
 *
 * Verbatim is the whole contract this phase. The block is the file's own YAML,
 * shown as text — not parsed into rows, not reformatted, not reserialised. Two
 * reasons, both recorded in the plan: the OKF library validates this frontmatter
 * in Phase 2, and a second YAML reader living in the web client would be the one
 * that disagrees with it. Showing the bytes is the one rendering that cannot
 * disagree with anything.
 *
 * It reads the active tab's buffer, like the Outline and the editor, so what it
 * shows is what the user is looking at rather than what was last saved.
 */
export function FrontmatterPanel() {
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) ?? null);

  const buffer = tab?.buffer ?? "";
  const { frontmatter } = useMemo(() => splitFrontmatter(buffer), [buffer]);

  if (!frontmatter.present) {
    // The approved empty copy. Also the answer for a block that opens but never
    // closes: an unterminated fence is a thematic break, not frontmatter.
    return <p className="version-panel-empty">No frontmatter</p>;
  }

  return (
    <div style={{ padding: "var(--sp-3) var(--sp-4)" }}>
      <pre
        className="frontmatter-block"
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          lineHeight: 1.6,
          color: "var(--text-secondary)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {frontmatter.raw}
      </pre>
    </div>
  );
}
