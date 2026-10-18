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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// @ts-expect-error -- see the note above.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as okf from "../src/index.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/** Bare module names that pull in I/O, the network, the clock or processes. */
const BANNED_MODULES = new Set([
  "fs",
  "fs/promises",
  "path",
  "os",
  "child_process",
  "http",
  "https",
  "net",
  "crypto",
  "worker_threads",
  "perf_hooks",
  "timers",
  "vm",
  "module",
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
    ["dynamic import() call", /\bimport\s*\(/],
    ["Date.now", /\bDate\s*\.\s*now\b/],
    ["new Date", /\bnew\s+Date\b/],
    ["Math.random", /\bMath\s*\.\s*random\b/],
    ["performance access", /\bperformance\s*\./],
    [
      "globalThis.crypto/process/fetch access",
      /\bglobalThis\s*\.\s*(?:crypto|process|fetch)\b/,
    ],
    ["setTimeout call", /\bsetTimeout\s*\(/],
    ["setInterval call", /\bsetInterval\s*\(/],
    ["import.meta.url", /\bimport\s*\.\s*meta\s*\.\s*url\b/],
  ];
  for (const [label, re] of checks) {
    if (re.test(source)) violations.push(`${file}: ${label} is not allowed`);
  }
  return violations;
}

/**
 * Collect source modules below `dir` as POSIX-relative paths, recursively.
 *
 * The tsconfig includes every `.ts` file under `src`, so a nested module is
 * part of the package and must not escape the gate.
 */
function collectSourceFiles(dir: string, prefix = ""): string[] {
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

/** The source modules the gate covers: every `.ts` file, specs excluded. */
const SOURCE_FILES = collectSourceFiles(SRC_DIR);

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

  it("flags every synthetic bypass (WR-06)", () => {
    const cases: Array<[string, string]> = [
      [
        'import { readFileSync } from "fs/promises";\n',
        'import specifier "fs/promises" is not allowed',
      ],
      [
        'const fs = await import("node:fs");\n',
        "dynamic import() call is not allowed",
      ],
      ["const now = new Date();\n", "new Date is not allowed"],
      ["const t = performance.now();\n", "performance access is not allowed"],
      [
        "globalThis.crypto.getRandomValues(bytes);\n",
        "globalThis.crypto/process/fetch access is not allowed",
      ],
      ["setTimeout(run, 1);\n", "setTimeout call is not allowed"],
      ["setInterval(run, 1);\n", "setInterval call is not allowed"],
      [
        'import { Worker } from "worker_threads";\n',
        'import specifier "worker_threads" is not allowed',
      ],
    ];
    for (const [source, expected] of cases) {
      expect(scanSource("scratch.ts", source), source).toContain(
        `scratch.ts: ${expected}`,
      );
    }
  });

  it("walks src recursively and skips spec files (WR-06)", () => {
    const root =
      fileURLToPath(new URL("../", import.meta.url)) + "purity-probe-";
    const directory = mkdtempSync(root);
    try {
      mkdirSync(`${directory}/sub`);
      writeFileSync(`${directory}/top.ts`, "export const top = 1;\n");
      writeFileSync(
        `${directory}/top.spec.ts`,
        'import { x } from "node:fs";\n',
      );
      writeFileSync(
        `${directory}/sub/nested.ts`,
        'import { readFileSync } from "node:fs";\n',
      );

      const files = collectSourceFiles(directory);
      expect(files).toEqual(["sub/nested.ts", "top.ts"]);
      expect(
        files.flatMap((name) =>
          scanSource(name, readFileSync(`${directory}/${name}`, "utf8")),
        ),
      ).toEqual(['sub/nested.ts: import specifier "node:fs" is not allowed']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
