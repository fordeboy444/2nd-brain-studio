/**
 * The committed-golden oracle.
 *
 * Goldens are never hand-written. They are produced by the unmodified
 * reference `cole-medin-knowledge-base/scripts/build_indexes.py` with this
 * preamble, run as `python3 -I /tmp/gen.py <reference> <fixture> <copy> <out>`:
 *
 * ```python
 * import json, pathlib, runpy, sys
 * reference, fixture_src, work, golden = (pathlib.Path(a) for a in sys.argv[1:5])
 *
 * # Pin traversal order: Path.glob/rglob use filesystem order.
 * _glob, _rglob = pathlib.Path.glob, pathlib.Path.rglob
 * pathlib.Path.glob = lambda self, p, **k: iter(
 *     sorted(_glob(self, p, **k), key=lambda x: x.as_posix()))
 * pathlib.Path.rglob = lambda self, p, **k: iter(
 *     sorted(_rglob(self, p, **k), key=lambda x: x.as_posix()))
 *
 * ns = runpy.run_path(str(reference), run_name="okf_build")
 * # run_path returns a COPY of the globals; rebind the live dict the functions
 * # close over, or ROOT/TAXONOMY stay the reference bundle's own.
 * g = ns["main"].__globals__
 * g["ROOT"] = work
 * g["TAXONOMY"] = json.loads(
 *     (work / "scripts" / "taxonomy.json").read_text(encoding="utf-8"))
 * ns["main"]()
 *
 * pages = [p for p in work.rglob("*.md") if p.name != "index.md"]
 * pages.sort(key=lambda p: p.relative_to(work).as_posix())
 * meta = {p.relative_to(work).as_posix(): ns["meta"](p) for p in pages}
 * # json.dumps(obj, indent=2, sort_keys=True) + "\n", UTF-8, newline="\n"
 * ```
 *
 * The reference bundle is copied to a temporary directory whose basename is
 * exactly `bundle-mini`, so the generated paths match the fixture's. No Python
 * is needed at test run time: these tests read the committed goldens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildIndexes,
  formatLintReport,
  lintBundle,
  readIndexMeta,
} from "../src/index.js";
import type { BundlePage, Taxonomy } from "../src/index.js";
import { readBundle } from "./helpers/bundle.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/bundle-mini", import.meta.url),
);
const GOLDEN_ROOT = fileURLToPath(
  new URL("./golden/bundle-mini", import.meta.url),
);

/** Read one committed golden as bytes decoded as UTF-8. */
function readGolden(relativePath: string): string {
  return readFileSync(join(GOLDEN_ROOT, relativePath), "utf8");
}

/** Assert the encoding contract every generated artifact shares. */
function expectCleanEncoding(label: string, text: string): void {
  expect(text.includes("\r"), `${label} contains a carriage return`).toBe(
    false,
  );
  expect(text.charCodeAt(0), `${label} starts with a BOM`).not.toBe(0xfeff);
  expect(text.endsWith("\n"), `${label} must end with an LF`).toBe(true);
  expect(text.endsWith("\n\n"), `${label} must end with exactly one LF`).toBe(
    false,
  );
}

/** Report the first differing line, with both sides, then fail. */
function expectSameBytes(label: string, actual: string, golden: string): void {
  expectCleanEncoding(`${label} (actual)`, actual);
  expectCleanEncoding(`${label} (golden)`, golden);
  if (actual === golden) return;

  const actualLines = actual.split("\n");
  const goldenLines = golden.split("\n");
  const length = Math.max(actualLines.length, goldenLines.length);
  for (let line = 0; line < length; line += 1) {
    if (actualLines[line] === goldenLines[line]) continue;
    throw new Error(
      `${label}: first difference at line ${line + 1}\n` +
        `  golden: ${JSON.stringify(goldenLines[line] ?? "<missing>")}\n` +
        `  actual: ${JSON.stringify(actualLines[line] ?? "<missing>")}`,
    );
  }
  throw new Error(`${label}: bytes differ but every line matches`);
}

const bundle = readBundle(FIXTURE_ROOT);
const taxonomy = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "scripts", "taxonomy.json"), "utf8"),
) as Taxonomy;

describe("oracle: reference metadata", () => {
  it("reproduces meta.json for every fixture page", () => {
    const raw = readGolden("meta.json");
    expectCleanEncoding("meta.json", raw);
    const expected = JSON.parse(raw) as Record<
      string,
      { title: string; description: string; duration: string }
    >;

    const actual: Record<string, unknown> = {};
    for (const page of bundle.pages) {
      const name = page.path.slice(page.path.lastIndexOf("/") + 1);
      const stem = name.slice(0, -".md".length);
      actual[page.path] = readIndexMeta(page.text, stem);
    }

    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const path of Object.keys(expected)) {
      expect(actual[path], path).toEqual(expected[path]);
    }
  });

  it("keeps meta.json in the pinned Python serialization", () => {
    const raw = readGolden("meta.json");
    const parsed = JSON.parse(raw) as Record<
      string,
      { title: string; description: string; duration: string }
    >;
    expect(JSON.stringify(parsed, null, 2) + "\n").toBe(raw);

    // `JSON.parse` preserves the golden's own order, so the round-trip above
    // cannot detect a regeneration without `sort_keys=True`. Pin the order
    // the Python serializer must produce: sorted paths, and the alphabetical
    // inner keys (`description`, `duration`, `title`).
    const paths = Object.keys(parsed);
    expect(paths).toEqual([...paths].sort());
    for (const path of paths) {
      expect(Object.keys(parsed[path]), path).toEqual([
        "description",
        "duration",
        "title",
      ]);
    }
  });
});

/** The reference `main()` order. Explicit, so an added golden cannot slip in. */
const INDEX_PATHS = [
  "concepts/index.md",
  "entities/index.md",
  "entities/tools/index.md",
  "entities/people/index.md",
  "entities/organizations/index.md",
  "sources/index.md",
  "raw/index.md",
] as const;

describe("oracle: generated index bytes", () => {
  it("emits exactly the seven index paths, in reference order", () => {
    const result = buildIndexes(bundle.pages, taxonomy);
    expect(result.files.map((file) => file.path)).toEqual([...INDEX_PATHS]);
  });

  it("builds every index byte-identical to its Python golden", () => {
    const result = buildIndexes(bundle.pages, taxonomy);
    for (const path of INDEX_PATHS) {
      const generated = result.files.find((file) => file.path === path);
      expect(generated, `buildIndexes did not emit ${path}`).toBeDefined();
      expectSameBytes(
        path,
        (generated as { text: string }).text,
        readGolden(path),
      );
    }
  });

  it("reproduces the reference log line by line", () => {
    expect(buildIndexes(bundle.pages, taxonomy).log).toEqual([
      "Building indexes from scripts/taxonomy.json ...",
      "  wrote concepts/index.md (3 pages)",
      "  wrote entities/index.md",
      "  wrote entities/tools/index.md (2 pages)",
      "  wrote entities/people/index.md (1 pages)",
      "  wrote entities/organizations/index.md (1 pages)",
      "  wrote sources/index.md (4 pages)",
      "  wrote raw/index.md (4 transcripts)",
      "Done.",
    ]);
  });
});

/**
 * The lint goldens use the same `runpy.run_path` preamble as the index
 * goldens: copy the fixture to a temporary directory whose basename is
 * `bundle-mini`, run the unmodified `build_indexes.py` with `ROOT` and
 * `TAXONOMY` rebound on `main.__globals__`, then run the unmodified
 * `lint.py` with `ROOT` rebound. The quiet golden is produced by appending
 * `--quiet` to the driver's `sys.argv` before `main()`.
 */
describe("oracle: lint report bytes", () => {
  /** The committed fixture plus the seven indexes the reference generated. */
  function generatedPages(): BundlePage[] {
    const indexes = buildIndexes(bundle.pages, taxonomy);
    return [
      ...bundle.pages,
      ...indexes.files.map((file) => ({ path: file.path, text: file.text })),
    ];
  }

  it("prints stdout byte-identical to the Python lint report", () => {
    const result = lintBundle(generatedPages(), "bundle-mini");
    expectSameBytes(
      "lint.stdout.txt",
      formatLintReport(result),
      readGolden("lint.stdout.txt"),
    );
  });

  it("prints the quiet report byte-identical, with no scanned line", () => {
    const result = lintBundle(generatedPages(), "bundle-mini");
    expectSameBytes(
      "lint.quiet.stdout.txt",
      formatLintReport(result, { quiet: true }),
      readGolden("lint.quiet.stdout.txt"),
    );

    const normal = readGolden("lint.stdout.txt");
    const quiet = readGolden("lint.quiet.stdout.txt");
    expect(normal.includes("Scanned ")).toBe(true);
    expect(quiet.includes("Scanned ")).toBe(false);
  });

  it("returns the reference exit status", () => {
    const result = lintBundle(generatedPages(), "bundle-mini");
    expect(String(result.exitCode)).toBe(
      readGolden("lint.exit.txt").trim(),
    );
  });

  it("exercises both severities, so an empty report cannot pass", () => {
    const result = lintBundle(generatedPages(), "bundle-mini");
    expect(result.errors).toHaveLength(3);
    expect(result.warnings).toHaveLength(3);
    expect(result.scanned).toBe(22);
  });
});
