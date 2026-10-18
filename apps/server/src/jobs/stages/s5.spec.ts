import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../../llm/ollama.js";
import { writeExtraction, type ExtractionRecord } from "../extraction.js";
import { writeTaxonomy, type TaxonomyRecord } from "../manifest.js";
import {
  renderConceptPage,
  renderEntityPage,
  renderSourcePage,
  sourcePageInput,
} from "../pages.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { createJobRecord, newJobId, readEvents, writeJob } from "../store.js";
import type { JobRecord } from "../types.js";
import {
  collectRawIndexRows,
  createS5Stage,
  LINT_REPORT_PATH,
  LOG_PATH,
} from "./s5.js";

/** A tripwire: S5 must never open `raw/`. */
const fsSpy = vi.hoisted(() => ({
  rawOpens: [] as string[],
  enforce: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const guard = (target: unknown): void => {
    const path = String(target);
    if (!fsSpy.enforce) return;
    if (path.split(/[\\/]/).includes("raw")) {
      fsSpy.rawOpens.push(path);
      throw new Error(`S5 must never open a raw path: ${path}`);
    }
  };
  return {
    ...actual,
    async readFile(target: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) {
      guard(target);
      return (actual.readFile as (...args: unknown[]) => unknown)(target, ...rest);
    },
    async readdir(target: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) {
      guard(target);
      return (actual.readdir as (...args: unknown[]) => unknown)(target, ...rest);
    },
  };
});

const JOB_CREATED = "2026-10-18T10:00:00.000Z";
const CAPTURE_AT = "2026-10-17T09:00:00.000Z";
const LINT_REPORT_FILE = "lint-report.json";

const SEVEN_INDEXES = [
  "concepts/index.md",
  "entities/index.md",
  "entities/tools/index.md",
  "entities/people/index.md",
  "entities/organizations/index.md",
  "sources/index.md",
  "raw/index.md",
] as const;

let root: string;
let job: JobRecord;
let dir: string;

function makeJob(): JobRecord {
  return createJobRecord({
    id: newJobId(new Date(2026, 9, 18), () => 0.5),
    vaultId: "vault",
    kind: "youtube",
    input: { url: "https://www.youtube.com/@channel" },
    settings: {
      maxVideos: 10,
      filters: { language: "en" },
      fetch: { concurrency: 1 },
      llm: { model: "test-model" },
    },
    createdAt: JOB_CREATED,
  });
}

function ctxFor(record: JobRecord): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: record.id,
    vaultDir: root,
    now: () => Date.parse(JOB_CREATED),
  };
}

function videoRecord(
  slug: string,
  overrides: Partial<ExtractionRecord> = {},
): ExtractionRecord {
  return {
    slug,
    title: `Talk ${slug}`,
    thesis: "The talk argues one thing.",
    summary: "A summary of the talk.",
    tags: ["agents"],
    concepts: [],
    entities: [],
    quotes: [{ text: "hello there", startSec: 65 }],
    relations: [],
    source: {
      slug,
      title: `Talk ${slug}`,
      sourceKind: "video",
      youtubeId: `id-${slug}`,
      url: `https://youtu.be/${slug}`,
      duration: 1402,
      rawPath: `raw/${slug}.md`,
      fetchedAt: CAPTURE_AT,
    },
    at: CAPTURE_AT,
    ...overrides,
  };
}

function webRecord(slug: string): ExtractionRecord {
  return {
    slug,
    title: `Page ${slug}`,
    thesis: "The page argues one thing.",
    summary: "A summary of the page.",
    tags: ["web"],
    concepts: [],
    entities: [],
    quotes: [{ text: "alpha paragraph" }],
    relations: [],
    source: {
      slug,
      title: `Page ${slug}`,
      sourceKind: "web",
      url: `https://example.com/${slug}`,
      site: "example.com",
      wordCount: 512,
      rawPath: `raw/${slug}.md`,
      fetchedAt: CAPTURE_AT,
    },
    at: CAPTURE_AT,
  };
}

function partialRecord(slug: string): ExtractionRecord {
  return videoRecord(slug, {
    thesis: "",
    summary: "",
    tags: [],
    quotes: [],
    partial: true,
  });
}

function taxonomyFixture(): TaxonomyRecord {
  return {
    concept_themes: [
      { name: "Workflow", slug: "workflow", members: ["agentic-workflow"] },
    ],
    tool_themes: [],
    source_clusters: [],
    at: JOB_CREATED,
  };
}

interface CapturedCall {
  messages: LlmMessage[];
}

function makeDeps(): { deps: StageDeps; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const llm: LlmClient = {
    async chat(messages: LlmMessage[], _options: LlmChatOptions) {
      calls.push({ messages });
      throw new Error("S5 must make no model call");
    },
  };
  const deps: StageDeps = {
    async fetchTranscript() {
      throw new Error("not used in this spec");
    },
    async fetchWeb() {
      throw new Error("not used in this spec");
    },
    async enumerate() {
      return [];
    },
    async preflight() {
      // no-op
    },
    cookiePath: () => undefined,
    classifyVideoError: () => "fetch_error",
    classifyWebError: () => "fetch_error",
    now: () => Date.parse(JOB_CREATED),
    vaultDirFor: () => root,
    llm,
    cacheDirFor: () => join(root, ".okf", "cache", "llm"),
    async writePage(vaultDir, relPath, text) {
      const target = join(vaultDir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
  };
  return { deps, calls };
}

/** Write one vault page exactly as S4 would. */
async function put(relPath: string, text: string): Promise<void> {
  const target = join(root, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function writeFixtures(): Promise<{
  deps: StageDeps;
  calls: CapturedCall[];
  records: ExtractionRecord[];
}> {
  job = makeJob();
  dir = join(root, ".okf", "jobs", job.id);
  await mkdir(dir, { recursive: true });
  await writeJob(root, job);
  await writeTaxonomy(dir, taxonomyFixture());

  const first = videoRecord("first-talk", {
    concepts: [{ name: "Agentic Workflow", slug: "agentic-workflow", weight: 1 }],
    entities: [{ name: "n8n", slug: "n8n", type: "tool", weight: 1 }],
  });
  const records = [
    first,
    videoRecord("second-talk"),
    webRecord("example-post"),
    partialRecord("failed-talk"),
  ];
  for (const record of records) await writeExtraction(dir, record);

  // The S4a page set, rendered through the real renderers.
  for (const record of records) {
    if (record.slug === "failed-talk") continue;
    await put(`sources/${record.slug}.md`, renderSourcePage(sourcePageInput(record)));
  }
  await put(
    "sources/failed-talk.md",
    renderSourcePage(sourcePageInput(partialRecord("failed-talk"))),
  );

  await put(
    "concepts/agentic-workflow.md",
    renderConceptPage({
      slug: "agentic-workflow",
      title: "Agentic Workflow",
      tags: ["agents"],
      sources: [
        {
          slug: "first-talk",
          title: "Talk first-talk",
          quotes: first.quotes,
        },
      ],
      body: "A workflow body.\n\nA second paragraph.",
      edges: [],
      created: JOB_CREATED,
      updated: JOB_CREATED,
    }),
  );
  await put(
    "entities/tools/n8n.md",
    renderEntityPage({
      slug: "n8n",
      title: "n8n",
      entityType: "tool",
      tags: ["agents"],
      sources: [
        {
          slug: "first-talk",
          title: "Talk first-talk",
          quotes: first.quotes,
        },
      ],
      body: "An entity body.\n\nA second paragraph.",
      edges: [],
      created: JOB_CREATED,
      updated: JOB_CREATED,
    }),
  );

  const { deps, calls } = makeDeps();
  return { deps, calls, records };
}

async function runS5(deps: StageDeps): Promise<boolean> {
  return createS5Stage(deps)(job, ctxFor(job), dir, async () => {});
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s5-spec-"));
  fsSpy.rawOpens = [];
  fsSpy.enforce = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S5 indexes, log and lint report", () => {
  it("writes the seven indexes, log.md and a report with no model call", async () => {
    const { deps, calls } = await writeFixtures();

    fsSpy.enforce = true;
    const cancelled = await runS5(deps);
    fsSpy.enforce = false;

    expect(cancelled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(fsSpy.rawOpens).toEqual([]);

    for (const path of SEVEN_INDEXES) {
      await expect(readFile(join(root, path), "utf8")).resolves.toContain("# ");
    }

    const log = await readFile(join(root, LOG_PATH), "utf8");
    expect(log).toContain("Building indexes from scripts/taxonomy.json ...");
    expect(log.endsWith("Done.\n")).toBe(true);

    const raw = await readFile(join(root, "raw", "index.md"), "utf8");
    const rows = raw.split("\n").filter((line) => line.startsWith("- ["));
    expect(rows).toHaveLength(4);
    expect(raw).toContain("- [Talk first-talk](first-talk.md) - 0:23:22");
    expect(raw).toContain("- [Page example-post](example-post.md)");
    expect(raw).toContain("- [Talk failed-talk](failed-talk.md)");

    const report = JSON.parse(
      await readFile(join(dir, LINT_REPORT_FILE), "utf8"),
    ) as { errors: unknown[]; warnings: unknown[]; exitCode: number };
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(LINT_REPORT_PATH).toBe(".okf/jobs/<id>/lint-report.json");

    const events = await readEvents(dir, 0);
    const lint = events.filter(
      (event) => event.type === "stage" && event.data.status === "lint",
    );
    expect(lint).toHaveLength(1);
    expect(lint[0]!.data).toEqual({
      stage: "S5",
      status: "lint",
      errors: 0,
      warnings: 0,
    });
  });

  it("writes byte-identical bytes on two runs", async () => {
    const { deps } = await writeFixtures();

    await runS5(deps);
    const paths = [...SEVEN_INDEXES, LOG_PATH].map((path) => join(root, path));
    const firstBytes = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    const firstReport = await readFile(join(dir, LINT_REPORT_FILE), "utf8");

    await runS5(deps);
    const secondBytes = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    const secondReport = await readFile(join(dir, LINT_REPORT_FILE), "utf8");

    expect(secondBytes).toEqual(firstBytes);
    expect(secondReport).toBe(firstReport);
  });

  it("reports a lint error, names the finding and does not throw", async () => {
    const { deps } = await writeFixtures();
    await put(
      "concepts/broken.md",
      [
        "---",
        "type: concept",
        "title: Broken",
        "slug: broken",
        "tags: []",
        "created: 2026-10-18T10:00:00.000Z",
        "updated: 2026-10-18T10:00:00.000Z",
        "---",
        "",
        "# Broken",
        "",
        "## Overview",
        "",
        "A body with a [broken link](../concepts/missing.md).",
        "",
      ].join("\n"),
    );

    const cancelled = await runS5(deps);
    expect(cancelled).toBe(false);

    const report = JSON.parse(
      await readFile(join(dir, LINT_REPORT_FILE), "utf8"),
    ) as {
      errors: Array<{ rule: string; message: string }>;
      exitCode: number;
    };
    expect(report.exitCode).not.toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(
      report.errors.some(
        (finding) =>
          finding.rule === "E2" &&
          finding.message.includes("concepts/missing.md"),
      ),
    ).toBe(true);

    const events = await readEvents(dir, 0);
    const lint = events.find(
      (event) => event.type === "stage" && event.data.status === "lint",
    );
    expect(lint?.data.errors).toBe(report.errors.length);
  });
});

describe("collectRawIndexRows", () => {
  it("makes one row per extraction record, including a partial one", async () => {
    await writeFixtures();

    const rows = await collectRawIndexRows(dir);

    expect(rows.map((row) => row.path)).toEqual([
      "raw/example-post.md",
      "raw/failed-talk.md",
      "raw/first-talk.md",
      "raw/second-talk.md",
    ]);
    expect(new Set(rows.map((row) => row.path)).size).toBe(4);
  });
});
