/**
 * The test layer's only filesystem reader.
 *
 * The library itself never touches disk: pages arrive as `{ path, text }`
 * objects. This helper turns a committed fixture tree into exactly that shape,
 * so every spec can treat the fixture as the oracle's input contract.
 *
 * `paths` includes every file and directory below `root` (POSIX relative, no
 * trailing slash) and never includes `root` itself.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest), so `tsc` cannot resolve
// this builtin. Vitest resolves it at run time; this is test-only code.
import { readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { join, relative, sep } from "node:path";
import type { BundlePage } from "../../src/frontmatter.js";

/** Convert a platform path to the POSIX form used by bundle paths. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Walk one directory, appending pages and every entry path. */
function walk(
  root: string,
  dir: string,
  pages: BundlePage[],
  paths: string[],
): void {
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    const absolute = join(dir, name);
    const relativePath = toPosix(relative(root, absolute));
    paths.push(relativePath);
    if (statSync(absolute).isDirectory()) {
      walk(root, absolute, pages, paths);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    pages.push({ path: relativePath, text: readFileSync(absolute, "utf8") });
  }
}

/**
 * Read a fixture bundle.
 *
 * @param root Absolute (or cwd-relative) path to the bundle directory.
 */
export function readBundle(root: string): {
  pages: BundlePage[];
  paths: string[];
} {
  const pages: BundlePage[] = [];
  const paths: string[] = [];
  walk(root, root, pages, paths);
  return { pages, paths };
}
