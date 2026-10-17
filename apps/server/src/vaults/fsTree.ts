/**
 * The lazy one-level tree listing (VAULT-03). `listTreeLevel` reads exactly one
 * directory level inside a vault and returns the entry shape the client tree
 * component consumes — `id` and `path` are both the vault-relative path, so no
 * absolute host path ever reaches the response (D-02 / the plan's behavior
 * requirement).
 *
 * `relDir` is resolved through `resolveInVault` (VAULT-04) before any readdir,
 * so a traversal probe or a symlink escape is rejected by the jail, not by this
 * module. Dot-prefixed entries are pruned (removes `.okf/` and editor scratch
 * files). Directories sort before files; within each group a numeric collator
 * orders `video-2` before `video-10`.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInVault } from "../paths/jail.js";

export interface TreeEntry {
  /** Vault-relative path; identical to `path` (the client uses either). */
  id: string;
  /** The entry's base name. */
  name: string;
  /** Vault-relative path, using `/` separators. */
  path: string;
  isDir: boolean;
  /** Always false here — the tree is one level; children are fetched on expand. */
  childrenLoaded: boolean;
  /** `stat.mtimeMs` for files; `undefined` for directories. */
  modified?: number;
}

// Directories-first, then by name with numeric ordering so `video-2` < `video-10`.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * List one level of `relDir` inside `vaultDir`. Returns an empty array for an
 * empty directory. Throws a `PathJailError` for a traversal/escape; the caller
 * maps that to 400. Throws ENOENT-style when `relDir` does not exist — the
 * caller maps that to 404. A `relDir` that resolves to a file (not a directory)
 * surfaces as an ENOTDIR from `readdir`, which the caller maps to 400.
 */
export async function listTreeLevel(vaultDir: string, relDir: string): Promise<TreeEntry[]> {
  const { absPath, relPath } = await resolveInVault(vaultDir, relDir);

  // One level only, with dirent types so we don't stat each entry just to know
  // whether it's a directory.
  const dirents = await readdir(absPath, { withFileTypes: true });

  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    // Prune dot entries: `.okf/`, `.DS_Store`, editor scratch files (D-02).
    if (d.name.startsWith(".")) continue;

    const rel = relPath === "." ? d.name : `${relPath}/${d.name}`;
    const isDir = d.isDirectory();
    let modified: number | undefined;
    if (!isDir) {
      const s = await stat(join(absPath, d.name));
      modified = s.mtimeMs;
    }
    entries.push({
      id: rel,
      name: d.name,
      path: rel,
      isDir,
      childrenLoaded: false,
      ...(modified === undefined ? {} : { modified }),
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  return entries;
}