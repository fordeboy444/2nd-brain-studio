/**
 * The display title of a tree row.
 *
 * One rule, and it is `lib/notePath.ts`'s: a note hides its extension in the UI
 * (`Notes/Alpha.md` → `Alpha`), a directory keeps its name verbatim, and any
 * other file type keeps its extension because that is how two previews are told
 * apart. The tab strip and the sidebar read the same rule through the same
 * module, so a row and its tab can never disagree about what a file is called.
 *
 * Nothing here is a frontmatter `title:` and nothing here consults an index:
 * those resolve wikilinks, they do not label rows.
 */
import { displayName, noteLabel } from "../notePath.js";

/** The label for a vault-relative path: `Notes/Alpha.md` → `Alpha`. */
export function displayTitle(path: string): string {
  return noteLabel(path);
}

/**
 * The same rule from a directory listing entry, which already carries the base
 * name and the directory flag — no path slicing needed, and a directory named
 * `notes.md` still reads as a directory.
 */
export function entryTitle(entry: { name: string; isDir: boolean }): string {
  return displayName(entry.name, entry.isDir);
}
