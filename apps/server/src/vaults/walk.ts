import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface MarkdownFile {
  relPath: string;
  absPath: string;
}

/**
 * Walk all markdown files (.md) in a vault directory.
 * Ignores dot directories (such as `.okf/`, `.git/`), dot files, and `node_modules`.
 * Returns entries sorted by `relPath` with POSIX forward slashes.
 */
export async function walkMarkdownFiles(vaultDir: string): Promise<MarkdownFile[]> {
  const results: MarkdownFile[] = [];

  async function walk(currentRel: string) {
    const currentAbs = currentRel === "" ? vaultDir : join(vaultDir, currentRel);
    let dirents;
    try {
      dirents = await readdir(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      if (d.name === "node_modules") continue;

      const childRel = currentRel === "" ? d.name : `${currentRel}/${d.name}`;
      const childAbs = join(currentAbs, d.name);

      if (d.isDirectory()) {
        await walk(childRel);
      } else if (d.isFile() && d.name.endsWith(".md")) {
        results.push({ relPath: childRel, absPath: childAbs });
      }
    }
  }

  await walk("");
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}
