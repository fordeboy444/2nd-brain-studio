import { useMemo, useState } from "react";

/**
 * The OKF `index.md` catalog reader (UI-08).
 *
 * The root `index.md` and every sub-index (`concepts/index.md`,
 * `entities/index.md`, ...) share one shape: a YAML frontmatter block, a `# H1`
 * title, and a sequence of `## Section` headings each followed by a list of
 * `- [Title](relative/path.md) - description` bullets. Rendering that markdown
 * through `MarkdownView` works, but it gives the user a wall of text where the
 * links are no easier to scan than in the editor. This component turns the same
 * bytes into a navigable catalog: sections become headed cards, bullets become
 * clickable rows, and a filter input narrows the cards by title or description.
 *
 * Three things make this more than a markdown dump:
 *
 * 1. PATHS ARE RESOLVED, NOT PASSED THROUGH. The raw href in
 *    `concepts/index.md` is `alpha.md`, which is correct only relative to that
 *    file's directory. Clicking the card calls `onSelectFile` with
 *    `concepts/alpha.md` — the vault-relative path the rest of the app speaks —
 *    so the sub-indexes work as well as the root.
 * 2. A DIRECTORY LINK IS A LINK TO ITS `index.md`. The root catalog writes
 *    `[Concepts](./concepts/)`, with the trailing slash the OKF convention for
 *    "this is a sub-index". The catalog normalizes that to
 *    `concepts/index.md`, so the click opens the file the directory's listing
 *    lives in.
 * 3. SECTIONS WITH NO VISIBLE ITEMS ARE HIDDEN UNDER FILTER. A search that
 *    empties a section does not leave its header on screen — the card goes
 *    away, so the user is not asked to scroll past headings whose contents the
 *    filter already removed.
 */

/** One clickable card parsed from a `- [Title](href) - description` bullet. */
interface CatalogItem {
  title: string;
  /** The raw href from the markdown, before path resolution. */
  href: string;
  /** The text after the `- ` separator; `""` when the bullet has none. */
  description: string;
}

/** One `## Heading` group with its parsed items. */
interface CatalogSection {
  name: string;
  items: CatalogItem[];
}

/** A `- [Title](href)` bullet, with an optional separator and description.
 *  The title is captured up to `]`, the href up to `)`. The description is
 *  whatever follows an optional separator: `-` (hyphen, the OKF library's
 *  `bullet()` output), `—` (em-dash, the root template's convention), or `–`
 *  (en-dash). `[-+*]` covers every Markdown list marker so the parser is not
 *  surprised by a `+` bullet. A bullet with no description (just the link) is
 *  accepted: the description captures as `""`. */
const LINK_BULLET = /^[-+*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[-—–]\s+(.*))?$/;

/** A `## Heading` line, allowing trailing whitespace but no leading spaces. */
const SECTION_HEADING = /^##\s+(.+?)\s*$/;

/** Strip a leading YAML frontmatter block (`---\n...\n---\n`). The closing
 *  fence is matched on its own line so a `---` inside the body (a thematic
 *  break) is not mistaken for the end of the frontmatter. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  const eol = content.startsWith("---\r\n") ? "\r\n" : "\n";
  const fence = `${eol}---${eol}`;
  const end = content.indexOf(fence, 4);
  if (end < 0) return content;
  return content.slice(end + fence.length);
}

/** Parse an index.md body into named sections of link items. Sections with no
 *  link items are still returned (the renderer decides what to do with them),
 *  so an index that is all prose and no links is detectable as the empty state. */
function parseIndex(content: string): CatalogSection[] {
  const body = stripFrontmatter(content);
  const lines = body.split(/\r?\n/);
  const sections: CatalogSection[] = [];
  let current: CatalogSection | null = null;
  for (const line of lines) {
    const h = SECTION_HEADING.exec(line);
    if (h) {
      current = { name: h[1]!, items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const m = LINK_BULLET.exec(line.trim());
    if (m) {
      current.items.push({
        title: m[1]!,
        href: m[2]!,
        description: (m[3] ?? "").trim(),
      });
    }
  }
  return sections;
}

/**
 * Resolve an index link's href against the index file's own path, returning a
 * vault-relative path the rest of the app can open.
 *
 * `./concepts/` against `index.md` → `concepts/index.md`.
 * `alpha.md` against `concepts/index.md` → `concepts/alpha.md`.
 * `../sources/x.md` against `concepts/index.md` → `sources/x.md`.
 *
 * The trailing slash is the OKF convention for a sub-index directory; appending
 * `index.md` makes the click open the file the directory's listing lives in.
 * Leading `./` is stripped before joining, and `..` segments are collapsed so
 * a cross-directory link in a sub-index resolves to the right vault-relative
 * path rather than a literal `..`.
 */
export function resolveIndexPath(basePath: string, href: string): string {
  let h = href.replace(/^\.\//, "");
  if (h.endsWith("/")) h = `${h}index.md`;
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash) : "";
  const joined = dir === "" ? h : `${dir}/${h}`;
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export interface IndexCatalogProps {
  /** The raw bytes of the `index.md` file, frontmatter included. */
  content: string;
  /** The vault-relative path of the index file itself, used to resolve relative
   *  hrefs. `index.md` for the root, `concepts/index.md` for a sub-index. */
  basePath: string;
  /** Click handler. Receives the resolved vault-relative path. */
  onSelectFile: (path: string) => void;
}

export function IndexCatalog({ content, basePath, onSelectFile }: IndexCatalogProps) {
  const [query, setQuery] = useState("");

  const sections = useMemo(() => parseIndex(content), [content]);
  const allItems = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections],
  );

  const q = query.trim().toLowerCase();
  const matches = (item: CatalogItem) =>
    q === "" ||
    item.title.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q);

  // Empty state: no link items anywhere in the index. A user who opens an
  // index that is all prose should not be shown an empty grid with a filter
  // input — the catalog has nothing to offer them.
  if (allItems.length === 0) {
    return (
      <div className="index-catalog index-catalog--empty" style={emptyStyle}>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontWeight: 600 }}>
          No entries
        </p>
        <p style={{ margin: "var(--sp-2) 0 0", color: "var(--text-tertiary)", fontSize: "var(--fs-sm)" }}>
          This index has no catalog links yet.
        </p>
      </div>
    );
  }

  return (
    <div
      className="index-catalog"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        padding: "var(--sp-5) var(--editor-pad-x) var(--sp-8)",
      }}
    >
      <div className="index-catalog__toolbar" style={{ marginBottom: "var(--sp-4)" }}>
        <input
          type="text"
          aria-label="Filter catalog"
          placeholder="Filter catalog"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            padding: "var(--sp-2) var(--sp-3)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            fontSize: "var(--fs-md)",
          }}
        />
      </div>
      <div
        className="index-catalog__grid"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}
      >
        {sections.map((section) => {
          const visible = section.items.filter(matches);
          if (visible.length === 0) return null;
          return (
            <section
              key={section.name}
              data-section={section.name}
              className="index-catalog__section"
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-surface)",
                overflow: "hidden",
              }}
            >
              <header
                className="index-catalog__section-header"
                style={{
                  padding: "var(--sp-2) var(--sp-4)",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                  fontSize: "var(--fs-sm)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {section.name}
                <span
                  style={{
                    marginLeft: "var(--sp-2)",
                    color: "var(--text-tertiary)",
                    fontWeight: 400,
                  }}
                >
                  {visible.length}
                </span>
              </header>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: "1px",
                  background: "var(--border)",
                }}
              >
                {visible.map((item) => {
                  return (
                    <li key={`${item.title}|${item.href}`}>
                      <button
                        type="button"
                        data-catalog-item
                        data-title={item.title}
                        onClick={() => onSelectFile(resolveIndexPath(basePath, item.href))}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: "var(--sp-1)",
                          width: "100%",
                          padding: "var(--sp-3) var(--sp-4)",
                          border: 0,
                          background: "var(--bg-surface)",
                          color: "var(--text-primary)",
                          textAlign: "left",
                          cursor: "pointer",
                          fontWeight: 600,
                          fontSize: "var(--fs-md)",
                        }}
                      >
                        <span style={{ color: "var(--accent)" }}>{item.title}</span>
                        {item.description ? (
                          <span
                            style={{
                              color: "var(--text-tertiary)",
                              fontWeight: 400,
                              fontSize: "var(--fs-sm)",
                              lineHeight: 1.4,
                            }}
                          >
                            {item.description}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {q !== "" && sections.every((s) => s.items.every((i) => !matches(i))) ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-sm)", margin: "var(--sp-4) 0 0" }}>
            No entries match "{query}".
          </p>
        ) : null}
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--sp-8)",
  textAlign: "center",
};