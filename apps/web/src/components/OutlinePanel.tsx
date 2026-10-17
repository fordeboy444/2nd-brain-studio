import { useMemo, type CSSProperties } from "react";
import { extractHeadings, type Heading } from "../lib/outline.js";
import { useStore } from "../store.js";

/**
 * The Outline tab (UI-03): the open document's headings, in order, nested by
 * depth. Clicking one asks the editor to reveal that line.
 *
 * It reads the ACTIVE TAB'S BUFFER, which is what makes it live rather than
 * stale: the outline of what is on screen, updated as the user types, not the
 * outline of what the server last acknowledged. That is the same single source
 * the editor and the Frontmatter tab read (the store's `tabs` entry), so the
 * three cannot disagree.
 *
 * An outline click does not move the caret itself. It sets `pendingRevealLine`,
 * which `MarkdownEditor` consumes once it has a view to place the caret in — a
 * request made while the document is still loading would otherwise be swallowed
 * by an effect that ran before the editor existed.
 */

/** One heading and the headings nested under it, built once from the flat list. */
interface OutlineNode {
  heading: Heading;
  children: OutlineNode[];
}

/**
 * Nest headings by depth.
 *
 * A heading belongs to the nearest preceding heading of SHALLOWER depth, whatever
 * jumps the document makes — `#` then `###` nests one level, not two, because the
 * alternative is an empty `<ul>` standing in for a level nobody wrote. Same-depth
 * headings are siblings, and a document that opens at `###` gets a root-level
 * entry rather than a lost one.
 */
function nest(headings: Heading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.heading.depth ?? 0) >= heading.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/** A nested list has no rule of its own in the pruned stylesheet, so the indent
 *  is inline and every value is a token. */
const NESTED: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "0 0 0 var(--sp-3)",
};

/** The row's own reset: a `<button>` here carries no chrome, and the class is
 *  what a reader or a test can find it by. */
const ROW: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: 0,
  padding: "var(--sp-1) var(--sp-2)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-secondary)",
  fontSize: "var(--fs-sm)",
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

export function OutlinePanel() {
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) ?? null);
  const requestReveal = useStore((s) => s.requestReveal);

  const buffer = tab?.buffer ?? "";
  const tree = useMemo(() => nest(extractHeadings(buffer)), [buffer]);

  if (tree.length === 0) {
    // The approved empty copy, and the same sentence whether there is no document
    // open or a document with no headings: the tab's subject is headings, and it
    // has none either way.
    return <p className="version-panel-empty">No headings</p>;
  }

  const render = (nodes: OutlineNode[], depth: number) => (
    <ul style={depth === 0 ? { ...NESTED, padding: "var(--sp-2)" } : NESTED}>
      {nodes.map((node) => (
        <li key={`${node.heading.line}:${node.heading.text}`}>
          <button
            type="button"
            className="outline-row"
            style={ROW}
            title={`Line ${node.heading.line}`}
            onClick={() => requestReveal(node.heading.line)}
          >
            {node.heading.text === "" ? <em>Untitled heading</em> : node.heading.text}
          </button>
          {node.children.length > 0 && render(node.children, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return render(tree, 0);
}
