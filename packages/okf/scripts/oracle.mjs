#!/usr/bin/env node
/**
 * Reference oracle: re-derive every committed golden from the unmodified
 * Python tools.
 *
 * `--check` (the default) copies the fixture twice into a temporary directory,
 * runs the reference `build_indexes.py` and `lint.py` against both copies,
 * proves the two independent runs are byte-identical, then compares copy `a`
 * against the committed goldens. `--update` writes the goldens from copy `a`
 * and is never invoked by a test.
 *
 * Security contract: Python runs with `-I` and a fixed `-c` driver. The bundle
 * root and the script path always travel as separate argv elements, never
 * interpolated into the driver source. No shell is used. This script writes
 * only under the golden directory and the temporary tree; it never writes
 * inside the reference repository.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const REFERENCE_ROOT =
  process.env.OKF_REFERENCE_ROOT?.trim() ||
  join(REPO_ROOT, "cole-medin-knowledge-base");
const FIXTURE_ROOT = join(PACKAGE_ROOT, "tests", "fixtures", "bundle-mini");
const GOLDEN_ROOT = join(PACKAGE_ROOT, "tests", "golden", "bundle-mini");
const BUNDLE_NAME = "bundle-mini";

const INDEX_PATHS = [
  "concepts/index.md",
  "entities/index.md",
  "entities/tools/index.md",
  "entities/people/index.md",
  "entities/organizations/index.md",
  "sources/index.md",
  "raw/index.md",
];

const BUILD_SCRIPT = join(REFERENCE_ROOT, "scripts", "build_indexes.py");
const LINT_SCRIPT = join(REFERENCE_ROOT, "lint.py");

/**
 * The one Python driver used for every invocation.
 *
 * `run_path` returns a copy of the module globals, so `ROOT` and (for the
 * index builder) `TAXONOMY` are rebound on the live dict the functions close
 * over. Both `glob` and `rglob` are pinned to sorted order because the
 * reference relies on filesystem traversal order.
 */
const DRIVER = [
  "import json, pathlib, runpy, sys",
  "_glob, _rglob = pathlib.Path.glob, pathlib.Path.rglob",
  "pathlib.Path.glob = lambda self, p, **k: iter(",
  "    sorted(_glob(self, p, **k), key=lambda x: x.as_posix()))",
  "pathlib.Path.rglob = lambda self, p, **k: iter(",
  "    sorted(_rglob(self, p, **k), key=lambda x: x.as_posix()))",
  'ns = runpy.run_path(sys.argv[2], run_name="okf_ref")',
  'g = ns["main"].__globals__',
  "root = pathlib.Path(sys.argv[1])",
  'g["ROOT"] = root',
  'if pathlib.Path(sys.argv[2]).name == "build_indexes.py":',
  '    g["TAXONOMY"] = json.loads(',
  '        (root / "scripts" / "taxonomy.json").read_text(encoding="utf-8"))',
  'if "--meta" in sys.argv[3:]:',
  '    pages = [p for p in root.rglob("*.md") if p.name != "index.md"]',
  "    pages.sort(key=lambda p: p.relative_to(root).as_posix())",
  "    meta = {",
  "        p.relative_to(root).as_posix(): dict(",
  '            zip(("title", "description", "duration"), ns["meta"](p)))',
  "        for p in pages",
  "    }",
  "    print(json.dumps(meta, indent=2, sort_keys=True))",
  "    raise SystemExit(0)",
  'result = ns["main"]()',
  'if pathlib.Path(sys.argv[2]).name == "lint.py":',
  "    raise SystemExit(result)",
].join("\n");

/** Print the usage line and exit 2 for an unknown argument. */
function usage() {
  console.error("usage: node scripts/oracle.mjs [--check|--update]");
  process.exit(2);
}

/** Parse the mode. `--check` is the default. */
function parseMode(args) {
  let mode = "check";
  for (const arg of args) {
    if (arg === "--check") mode = "check";
    else if (arg === "--update") mode = "update";
    else usage();
  }
  return mode;
}

/** Print the loud skip line. Update mode cannot regenerate, so it exits 2. */
function skip(what, mode) {
  console.log(`ORACLE SKIPPED: ${what} not found`);
  process.exit(mode === "update" ? 2 : 0);
}

/** True when `python3` answers on PATH. */
function pythonAvailable() {
  try {
    execFileSync("python3", ["-I", "--version"], {
      stdio: "ignore",
      encoding: null,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the driver and return stdout as a Buffer plus the exit status.
 *
 * A non-zero status is expected for the fixture lint run, so it is captured
 * rather than thrown.
 */
function runPython(root, script, extra = []) {
  const args = ["-I", "-c", DRIVER, root, script, ...extra];
  try {
    const stdout = execFileSync("python3", args, {
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, status: 0 };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      typeof error.status === "number" &&
      Buffer.isBuffer(error.stdout)
    ) {
      return { stdout: error.stdout, status: error.status };
    }
    throw error;
  }
}

/** Run the full pipeline against one `bundle-mini` copy. */
function runPipeline(copyRoot) {
  const indexes = new Map();
  const build = runPython(copyRoot, BUILD_SCRIPT);
  if (build.status !== 0) {
    throw new Error(
      `build_indexes.py exited ${build.status}: ${build.stdout.toString("utf8")}`,
    );
  }
  for (const relative of INDEX_PATHS) {
    indexes.set(relative, readFileSync(join(copyRoot, relative)));
  }
  const meta = runPython(copyRoot, BUILD_SCRIPT, ["--meta"]).stdout;
  const normal = runPython(copyRoot, LINT_SCRIPT);
  const quiet = runPython(copyRoot, LINT_SCRIPT, ["--quiet"]);
  return {
    indexes,
    meta,
    normal: normal.stdout,
    quiet: quiet.stdout,
    status: normal.status,
    quietStatus: quiet.status,
  };
}

/** Report the first differing line, then return false. */
function compareBytes(label, actual, expected) {
  if (Buffer.compare(actual, expected) === 0) return true;
  const actualLines = actual.toString("utf8").split("\n");
  const expectedLines = expected.toString("utf8").split("\n");
  const length = Math.max(actualLines.length, expectedLines.length);
  for (let line = 0; line < length; line += 1) {
    if (actualLines[line] === expectedLines[line]) continue;
    console.error(`ORACLE MISMATCH: ${label}`);
    console.error(`  first difference at line ${line + 1}`);
    console.error(`  expected: ${JSON.stringify(expectedLines[line] ?? "<missing>")}`);
    console.error(`  actual:   ${JSON.stringify(actualLines[line] ?? "<missing>")}`);
    return false;
  }
  console.error(`ORACLE MISMATCH: ${label} (bytes differ, every line matches)`);
  return false;
}

/** Prove two independent runs produced identical artifacts. */
function compareRuns(a, b) {
  let ok = true;
  for (const relative of INDEX_PATHS) {
    ok =
      compareBytes(
        `${relative} (run a vs run b)`,
        a.indexes.get(relative),
        b.indexes.get(relative),
      ) && ok;
  }
  ok = compareBytes("meta.json (run a vs run b)", a.meta, b.meta) && ok;
  ok = compareBytes("lint.stdout.txt (run a vs run b)", a.normal, b.normal) && ok;
  ok = compareBytes("lint.quiet.stdout.txt (run a vs run b)", a.quiet, b.quiet) && ok;
  if (a.status !== b.status) {
    console.error(`ORACLE MISMATCH: lint exit status ${a.status} vs ${b.status}`);
    ok = false;
  }
  return ok;
}

/** Compare copy `a` against the committed goldens. */
function compareGoldens(run) {
  let ok = true;
  for (const relative of INDEX_PATHS) {
    ok =
      compareBytes(
        relative,
        run.indexes.get(relative),
        readFileSync(join(GOLDEN_ROOT, relative)),
      ) && ok;
  }
  ok =
    compareBytes(
      "meta.json",
      run.meta,
      readFileSync(join(GOLDEN_ROOT, "meta.json")),
    ) && ok;
  ok =
    compareBytes(
      "lint.stdout.txt",
      run.normal,
      readFileSync(join(GOLDEN_ROOT, "lint.stdout.txt")),
    ) && ok;
  ok =
    compareBytes(
      "lint.quiet.stdout.txt",
      run.quiet,
      readFileSync(join(GOLDEN_ROOT, "lint.quiet.stdout.txt")),
    ) && ok;
  ok =
    compareBytes(
      "lint.exit.txt",
      Buffer.from(`${run.status}\n`),
      readFileSync(join(GOLDEN_ROOT, "lint.exit.txt")),
    ) && ok;
  return ok;
}

/** Write copy `a`'s artifacts into the golden directory. */
function writeGoldens(run) {
  mkdirSync(GOLDEN_ROOT, { recursive: true });
  for (const relative of INDEX_PATHS) {
    writeFileSync(join(GOLDEN_ROOT, relative), run.indexes.get(relative));
  }
  writeFileSync(join(GOLDEN_ROOT, "meta.json"), run.meta);
  writeFileSync(join(GOLDEN_ROOT, "lint.stdout.txt"), run.normal);
  writeFileSync(join(GOLDEN_ROOT, "lint.quiet.stdout.txt"), run.quiet);
  writeFileSync(join(GOLDEN_ROOT, "lint.exit.txt"), `${run.status}\n`);
}

function main() {
  const mode = parseMode(process.argv.slice(2));

  if (!existsSync(REFERENCE_ROOT)) skip("reference repository", mode);
  if (!existsSync(BUILD_SCRIPT)) skip("build_indexes.py", mode);
  if (!existsSync(LINT_SCRIPT)) skip("lint.py", mode);
  if (!pythonAvailable()) skip("python3", mode);

  const temporary = mkdtempSync(join(tmpdir(), "okf-oracle-"));
  try {
    const copyA = join(temporary, "a", BUNDLE_NAME);
    const copyB = join(temporary, "b", BUNDLE_NAME);
    mkdirSync(dirname(copyA), { recursive: true });
    mkdirSync(dirname(copyB), { recursive: true });
    cpSync(FIXTURE_ROOT, copyA, { recursive: true });
    cpSync(FIXTURE_ROOT, copyB, { recursive: true });

    const runA = runPipeline(copyA);
    const runB = runPipeline(copyB);

    if (!runA.normal.toString("utf8").includes("Scanned ")) {
      console.error("ORACLE MISMATCH: normal lint stdout has no Scanned line");
      process.exit(1);
    }
    if (runA.quiet.toString("utf8").includes("Scanned ")) {
      console.error("ORACLE MISMATCH: quiet lint stdout has a Scanned line");
      process.exit(1);
    }
    if (runA.quietStatus !== runA.status) {
      console.error(
        `ORACLE MISMATCH: quiet exit ${runA.quietStatus} vs normal ${runA.status}`,
      );
      process.exit(1);
    }
    if (!compareRuns(runA, runB)) process.exit(1);

    if (mode === "update") {
      writeGoldens(runA);
      console.log("ORACLE UPDATED: goldens written from the reference");
      process.exit(0);
    }

    if (!compareGoldens(runA)) process.exit(1);
    console.log("ORACLE OK: indexes, meta and lint match the reference");
    process.exit(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main();
