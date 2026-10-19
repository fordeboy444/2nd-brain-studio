/**
 * The recursive source-module walker shared by the purity and determinism
 * gates.
 *
 * `src` may gain nested modules, and every one of them must be covered by the
 * gates that keep this package pure and byte-identical across hosts. Spec
 * files are excluded: they are test code, not part of the shipped surface.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest); vitest resolves this
// builtin at run time. This is test-only code.
import { readdirSync } from "node:fs";

/** Collect source modules below `dir` as POSIX-relative paths, recursively. */
export function collectSourceFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(`${dir}/${entry.name}`, relative));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      files.push(relative);
    }
  }
  return files.sort();
}
