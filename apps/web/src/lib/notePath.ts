/**
 * A note's name, derived from its path — the ONE label rule.
 *
 * A note's title is its file name. Any index the server keeps may hold a richer
 * title (frontmatter `title:` → first H1 → stem) because wikilinks resolve by
 * basename *then* title — but the UI never shows that one. The tab strip, the
 * sidebar and the backlinks card all read the filename through here, which is
 * why they can never disagree.
 *
 * Pruned from the reference's `lib/notePath.ts`: the CRDT-bridge predicates
 * (`isEditorNote`, `isMarkdownNote`) named a sync family this app does not have,
 * and the note-extension test that is still needed lives with the tree code.
 */

/**
 * Characters no filesystem accepts in a name (plus control chars). It is a `g`
 * regex, so callers that only test must reset `lastIndex` (or build their own
 * from `.source`).
 */
// eslint-disable-next-line no-control-regex
export const UNSAFE_STEM = /[\\/:*?"<>|\x00-\x1f]/g;
/** Longest name we will write. Filesystems allow more; this is a sanity cap. */
export const MAX_STEM = 100;

/** The extensions a note-shaped file hides in the UI. */
export const NOTE_EXT = /\.(md|markdown|mdx|html?|txt|url|webloc)$/i;

/** `Notes/Untitled.md` → `Untitled`. Strips ANY extension (used for renames). */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The label the UI shows for a file at `path`. Notes and pages hide their
 * extension (the same rule the rename input uses); every other file type keeps
 * it, because the extension is how you tell two previews apart.
 */
export function noteLabel(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return displayName(base, false);
}

/**
 * `noteLabel`'s name-level twin, for callers that already hold a directory
 * entry rather than a path (the sidebar rows). One rule, two arities.
 */
export function displayName(name: string, isDir: boolean): string {
  return isDir ? name : name.replace(NOTE_EXT, "");
}

/** Turn a title into something a file can be called, or null if nothing usable
 *  survives (a title of only punctuation, say). */
export function sanitizeFileStem(title: string): string | null {
  const stem = title
    .replace(UNSAFE_STEM, "")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file from the vault (dotfiles are ignored); a
    // trailing dot is illegal on Windows.
    .replace(/^\.+|[.\s]+$/g, "")
    .slice(0, MAX_STEM)
    .trim();
  return stem.length > 0 ? stem : null;
}
