/**
 * The package boundary gate.
 *
 * `packages/okf` is a pure library: every input arrives as a string or a plain
 * object, so two runs on the same input produce the same bytes. This spec fails
 * the build if any source module acquires filesystem, network, process, clock
 * or randomness access, or if the package declares a runtime dependency.
 *
 * The scan runs per file and reports `file: construct`, so a violation names
 * what to remove rather than only failing a whole-tree regex.
 */
// @ts-expect-error -- @types/node is not linked into packages/okf (its
// devDependencies are frozen to typescript + vitest); vitest resolves this
// builtin at run time.
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as okf from "../src/index.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/** Bare module names that pull in I/O, the network, the clock or processes. */
const BANNED_MODULES = new Set([
  "fs",
  "path",
  "os",
  "child_process",
  "http",
  "https",
  "net",
  "crypto",
  "worker_threads",
]);

/** Every named import specifier in a source string. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const sideEffectRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const re of [fromRe, sideEffectRe]) {
    for (const match of source.matchAll(re)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

/** Return every purity violation in one source file. */
function scanSource(file: string, source: string): string[] {
  const violations: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith("node:")) {
      violations.push(`${file}: import specifier "${specifier}" is not allowed`);
    } else if (BANNED_MODULES.has(specifier)) {
      violations.push(`${file}: import specifier "${specifier}" is not allowed`);
    }
  }
  const checks: Array<[string, RegExp]> = [
    ["fetch() call", /\bfetch\s*\(/],
    ["process access", /\bprocess\./],
    ["require() call", /\brequire\s*\(/],
    ["Date.now", /\bDate\s*\.\s*now\b/],
    ["Math.random", /\bMath\s*\.\s*random\b/],
    ["import.meta.url", /\bimport\s*\.\s*meta\s*\.\s*url\b/],
  ];
  for (const [label, re] of checks) {
    if (re.test(source)) violations.push(`${file}: ${label} is not allowed`);
  }
  return violations;
}

/** The source modules the gate covers: direct `.ts` files, specs excluded. */
const SOURCE_FILES = readdirSync(SRC_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
  .sort();

describe("purity gate", () => {
  it("scans at least three source modules", () => {
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(3);
    expect(SOURCE_FILES).toContain("frontmatter.ts");
    expect(SOURCE_FILES).toContain("indexes.ts");
    expect(SOURCE_FILES).toContain("index.ts");
    console.log(`purity gate scanned ${SOURCE_FILES.length} source files`);
  });

  it("has no I/O, network, process, clock or randomness access", () => {
    const violations = SOURCE_FILES.flatMap((name) =>
      scanSource(name, readFileSync(`${SRC_DIR}/${name}`, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("flags a prohibited import by file and construct", () => {
    expect(
      scanSource("scratch.ts", 'import { readFileSync } from "node:fs";\n'),
    ).toEqual(['scratch.ts: import specifier "node:fs" is not allowed']);
    expect(scanSource("scratch.ts", 'import { join } from "path";\n')).toEqual([
      'scratch.ts: import specifier "path" is not allowed',
    ]);
    expect(scanSource("scratch.ts", "const x = fetch('/');\n")).toEqual([
      "scratch.ts: fetch() call is not allowed",
    ]);
  });

  it("declares no runtime dependency map", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});

describe("package surface", () => {
  it("resolves every re-exported name from the barrel", () => {
    for (const name of [
      "slugify",
      "parseFrontmatter",
      "renderFrontmatter",
      "readIndexMeta",
      "buildIndexes",
      "compareCodepoint",
    ] as const) {
      expect(typeof okf[name], name).toBe("function");
    }
    expect(typeof okf.FrontmatterError).toBe("function");
  });
});
