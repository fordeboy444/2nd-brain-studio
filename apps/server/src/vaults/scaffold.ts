import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Scaffold a vault directory from `templates/okf-bundle` (D-01, D-03).
 *
 * - Refuses to proceed when `dir` exists and is non-empty, with the exact copy
 *   `This location isn't empty. Create a new vault in an existing or new directory?`
 *   — never merges, never overwrites.
 * - Copies the four template markdown files into the vault root.
 * - Creates `concepts/`, `entities/tools/`, `entities/people/`,
 *   `entities/organizations/`, `sources/` and `raw/` as directories (git does
 *   not track empty dirs, so they are created in code per D-01).
 * - Idempotent for a directory it created itself: a second call on a vault root
 *   that already contains exactly the scaffold output is a no-op; a second call
 *   after any user file was added still fails.
 */

export const NON_EMPTY_MESSAGE =
  "This location isn't empty. Create a new vault in an existing or new directory?";

// templates/okf-bundle lives at the repo root. Resolve relative to this module
// (apps/server/src/vaults/) so it works regardless of the process cwd.
const TEMPLATE_DIR = (): string =>
  resolve(MODULE_DIR, "../../../../templates/okf-bundle");

// Directory skeleton, expressed as relative paths from the vault root.
const SCAFFOLD_DIRS = [
  "concepts",
  "entities/tools",
  "entities/people",
  "entities/organizations",
  "sources",
  "raw",
];

const SCAFFOLD_FILES = ["SCHEMA.md", "README.md", "log.md", "index.md"];

/** True iff `dir` contains exactly the scaffold output (4 files + 6 empty dirs). */
async function looksLikeScaffold(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  const expectedFiles = new Set(SCAFFOLD_FILES);
  // Build the set of expected top-level names (files + "entities" + flat dirs).
  const expectedTop = new Set<string>(SCAFFOLD_FILES);
  for (const d of SCAFFOLD_DIRS) {
    const top = d.split("/")[0];
    if (top) expectedTop.add(top);
  }
  const seenTop = new Set<string>();
  for (const name of entries) {
    if (!expectedTop.has(name)) return false;
    const p = resolve(dir, name);
    let isDir: boolean;
    try {
      isDir = (await stat(p)).isDirectory();
    } catch {
      return false;
    }
    if (isDir) {
      // For the entities dir, validate its subdirs are exactly tools/people/organizations, each empty.
      if (name === "entities") {
        const subs = await readdir(p).catch(() => [] as string[]);
        const expectedSubs = new Set(["tools", "people", "organizations"]);
        if (subs.length !== 3) return false;
        for (const s of subs) {
          if (!expectedSubs.has(s)) return false;
          const subP = resolve(p, s);
          const subStat = await stat(subP).catch(() => null);
          if (!subStat || !subStat.isDirectory()) return false;
          const subEntries = await readdir(subP).catch(() => [] as string[]);
          if (subEntries.length > 0) return false;
        }
      } else {
        // A flat scaffold dir must be empty (no user content yet).
        const subEntries = await readdir(p).catch(() => [] as string[]);
        if (subEntries.length > 0) return false;
      }
      seenTop.add(name);
    } else {
      if (!expectedFiles.has(name)) return false;
      seenTop.add(name);
    }
  }
  return seenTop.size === expectedTop.size;
}

export async function scaffoldVault(dir: string): Promise<void> {
  let exists = false;
  try {
    await stat(dir);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    const entries = await readdir(dir);
    if (entries.length > 0) {
      // Idempotent no-op only when the dir already contains exactly the
      // scaffold output; otherwise refuse (D-03).
      if (await looksLikeScaffold(dir)) {
        return;
      }
      const err = new Error(NON_EMPTY_MESSAGE);
      (err as Error & { code?: string }).code = "non_empty";
      throw err;
    }
  }

  await mkdir(dir, { recursive: true });
  // Copy the four template markdown files into the vault root.
  const tmpl = TEMPLATE_DIR();
  for (const file of SCAFFOLD_FILES) {
    await cp(resolve(tmpl, file), resolve(dir, file)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    });
  }
  // Create the directory skeleton.
  for (const sub of SCAFFOLD_DIRS) {
    await mkdir(resolve(dir, sub), { recursive: true });
  }
}