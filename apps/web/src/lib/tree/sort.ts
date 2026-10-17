/**
 * The tree's ordering rule, mirroring the server's.
 *
 * `apps/server/src/vaults/fsTree.ts` already returns each level directories-first
 * with numeric name ordering, so a freshly fetched level needs no client sort.
 * This module exists for the levels the CLIENT builds: the `New file` CTA inserts
 * an entry into a level the server will not re-list until the user expands it
 * again, and an appended row would land at the bottom regardless of its name.
 *
 * The collation must be the server's, character for character
 * (`new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`), or a
 * client-inserted row sits in a different place than the same row after a reload
 * — `video-2` before `video-10` on the server, after it in the tree.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The two fields ordering depends on. `TreeEntry` satisfies it. */
export interface Sortable {
  name: string;
  isDir: boolean;
}

/** Directories before files; within a group, numeric-aware name order. */
export function compareEntries(a: Sortable, b: Sortable): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator.compare(a.name, b.name);
}

/** A sorted copy — callers keep their own array identity. */
export function sortEntries<T extends Sortable>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}

/** Add one entry to an already-sorted level, leaving the level sorted. */
export function insertEntry<T extends Sortable>(entries: readonly T[], entry: T): T[] {
  const next = [...entries, entry];
  next.sort(compareEntries);
  return next;
}
