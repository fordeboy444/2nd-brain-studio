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
import { buildIndexes, readIndexMeta } from "../src/index.js";
import type { Taxonomy } from "../src/index.js";
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
    const parsed: unknown = JSON.parse(raw);
    expect(JSON.stringify(parsed, null, 2) + "\n").toBe(raw);
  });
});

describe("oracle: generated index bytes", () => {
  it("builds raw/index.md byte-identical to the Python golden", () => {
    const result = buildIndexes(bundle.pages, taxonomy);
    const generated = result.files.find(
      (file) => file.path === "raw/index.md",
    );
    expect(generated, "buildIndexes did not emit raw/index.md").toBeDefined();
    expectSameBytes(
      "raw/index.md",
      (generated as { text: string }).text,
      readGolden("raw/index.md"),
    );
  });
});
