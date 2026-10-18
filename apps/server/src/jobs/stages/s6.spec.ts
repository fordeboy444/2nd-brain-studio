import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../http/writeAtomic.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../../llm/ollama.js";
import { writeExtraction, type ExtractionRecord } from "../extraction.js";
import {
  readManifest,
  writeManifest,
  writeTaxonomy,
  type ManifestRecord,
} from "../manifest.js";
import {
  NotabilitySchema,
  notabilityPath,
} from "../notability.js";
import {
  renderConceptPage,
  renderEntityPage,
} from "../pages.js";
import { stagesFor, type StageDeps, type UnitContext } from "../runner.js";
import { createJobRecord, newJobId, readEvents, writeJob } from "../store.js";
import type { JobRecord } from "../types.js";
import {
  collectSweepTargets,
  createS6Stage,
  NOTABILITY_PATH,
  PROMPT_VERSION_S6,
  SweepSchema,
} from "./s6.js";

/** A tripwire: S6 must never open a raw capture. */
const spy = vi.hoisted(() => ({ captureReads: 0 }));

vi.mock("../capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture.js")>();
  return {
    ...actual,
    readCapture() {
      spy.captureReads += 1;
      throw new Error("S6 must never open a raw capture");
    },
  };
});

const JOB_CREATED = "2026-10-18T10:00:00.000Z";
const CAPTURE_AT = "2026-10-17T09:00:00.000Z";

let root: string;
let job: JobRecord;
let dir: string;

function makeJob(sweepEnabled: boolean): JobRecord {
  return createJobRecord({
    id: newJobId(new Date(2026, 9, 18), () => 0.75),
    vaultId: "vault",
    kind: "youtube",
    input: { url: "https://www.youtube.com/@channel" },
    settings: {
      maxVideos: 10,
      filters: { language: "en" },
      fetch: { concurrency: 1 },
      llm: { model: "test-model", maxRetries: 1 },
      sweep: { enabled: sweepEnabled },
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

function record(): ExtractionRecord {
  return {
    slug: "first-talk",
    title: "First Talk",
    thesis: "The talk argues one thing.",
    summary: "A summary of the talk.",
    tags: ["agents"],
    concepts: [{ name: "Agentic Workflow", slug: "agentic-workflow", weight: 1 }],
    entities: [{ name: "n8n", slug: "n8n", type: "tool", weight: 1 }],
    quotes: [{ text: "hello there", startSec: 65 }],
    relations: [],
    source: {
      slug: "first-talk",
      title: "First Talk",
      sourceKind: "video",
      youtubeId: "abc123",
      url: "https://youtu.be/abc123",
      duration: 1402,
      rawPath: "raw/first-talk.md",
      fetchedAt: CAPTURE_AT,
    },
    at: CAPTURE_AT,
  };
}

function manifestFixture(): ManifestRecord {
  return {
    concepts: [
      {
        slug: "agentic-workflow",
        title: "Agentic Workflow",
        tags: ["agents"],
        sources: ["first-talk"],
        weight: 1,
      },
    ],
    entities: [
      {
        slug: "n8n",
        title: "n8n",
        type: "tool",
        tags: ["agents"],
        sources: ["first-talk"],
        weight: 1,
      },
    ],
    sources: [
      {
        slug: "first-talk",
        title: "First Talk",
        kind: "video",
        tags: ["agents"],
        concepts: ["agentic-workflow"],
        entities: ["n8n"],
        youtube_id: "abc123",
        duration: 1402,
      },
    ],
    edges: [],
    filtered: [],
    at: JOB_CREATED,
  };
}

interface CapturedCall {
  messages: LlmMessage[];
  rawPath: string | undefined;
  /** `LlmChatOptions` carries no stage; the system message names the prompt. */
  system: string;
}

function makeDeps(reply: (call: CapturedCall) => string): {
  deps: StageDeps;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const llm: LlmClient = {
    async chat(messages: LlmMessage[], options: LlmChatOptions) {
      const call: CapturedCall = {
        messages,
        rawPath: options.rawPath,
        system: messages[0]?.content ?? "",
      };
      calls.push(call);
      const text = reply(call);
      if (options.rawPath !== undefined) {
        await writeTextAtomic(options.rawPath, text);
      }
      return { text, tokensIn: 1, tokensOut: 1 };
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

async function put(relPath: string, text: string): Promise<void> {
  const target = join(root, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}

/**
 * Write the job, manifest and taxonomy. The concept page carries a one
 * paragraph fallback body; the entity page carries a full two paragraph body.
 */
async function writeFixtures(sweepEnabled: boolean): Promise<void> {
  job = makeJob(sweepEnabled);
  dir = join(root, ".okf", "jobs", job.id);
  await mkdir(dir, { recursive: true });
  await writeJob(root, job);
  await writeManifest(dir, manifestFixture());
  await writeTaxonomy(dir, {
    concept_themes: [],
    tool_themes: [],
    source_clusters: [],
    at: JOB_CREATED,
  });
  await writeExtraction(dir, record());

  const sources = [
    { slug: "first-talk", title: "First Talk", quotes: record().quotes },
  ];
  await put(
    "concepts/agentic-workflow.md",
    renderConceptPage({
      slug: "agentic-workflow",
      title: "Agentic Workflow",
      tags: ["agents"],
      sources,
      body: "A short fallback body.",
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
      sources,
      body: "An entity paragraph.\n\nA second entity paragraph.",
      edges: [],
      created: JOB_CREATED,
      updated: JOB_CREATED,
    }),
  );
}

async function runS6(deps: StageDeps): Promise<boolean> {
  return createS6Stage(deps)(job, ctxFor(job), dir, async () => {});
}

function sweepReply(
  slug: string,
  notable = 0.8,
  kind: "concept" | "entity" = "concept",
): string {
  return JSON.stringify({
    pages: [
      {
        kind,
        slug,
        body: "The rebuilt body paragraph.\n\nThe second rebuilt paragraph.",
        notable,
      },
    ],
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s6-spec-"));
  spy.captureReads = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S6 sweep gate", () => {
  it("stays out of the stage list when the job snapshot has sweep off", async () => {
    await writeFixtures(false);

    expect(stagesFor(job)).not.toContain("S6");
    expect(NOTABILITY_PATH).toBe(".okf/jobs/<id>/notability.json");
  });

  it("enters the stage list only when the job snapshot enables it", async () => {
    await writeFixtures(true);

    expect(stagesFor(job)).toContain("S6");
  });
});

describe("S6 sweep", () => {
  it("re-fills a fallback page through the S4 renderer and writes notability", async () => {
    await writeFixtures(true);
    const { deps, calls } = makeDeps(() => sweepReply("agentic-workflow"));

    const cancelled = await runS6(deps);

    expect(cancelled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(`Prompt version: ${PROMPT_VERSION_S6}.`);
    expect(spy.captureReads).toBe(0);

    const page = await readFile(
      join(root, "concepts", "agentic-workflow.md"),
      "utf8",
    );
    expect(page).toContain("The rebuilt body paragraph.");
    expect(page).toContain("## Sources");
    expect(page).toContain("sources: [first-talk]");

    // The full-page entity stays untouched.
    const entity = await readFile(join(root, "entities", "tools", "n8n.md"), "utf8");
    expect(entity).toContain("An entity paragraph.");

    const notability = NotabilitySchema.parse(
      JSON.parse(await readFile(notabilityPath(dir), "utf8")),
    );
    expect(notability).toEqual({
      scores: [{ slug: "agentic-workflow", score: 0.8 }],
      at: JOB_CREATED,
    });

    // Notability never enters the strict manifest schema.
    await expect(readManifest(dir)).resolves.not.toBeNull();

    const log = await readFile(join(root, "log.md"), "utf8");
    expect(log.endsWith("sweep: true\n")).toBe(true);

    const events = await readEvents(dir, 0);
    expect(
      events.some(
        (event) =>
          event.type === "unit" &&
          event.data.stage === "S6" &&
          event.data.status === "written",
      ),
    ).toBe(true);
  });

  it("keeps the stored triage and sweeps every target on an earlier-stage retry", async () => {
    await writeFixtures(true);
    await writeFile(
      notabilityPath(dir),
      JSON.stringify({
        scores: [{ slug: "n8n", score: 0.4 }],
        at: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    // An S2 retry rebuilds the manifest and pages, so S6 must not narrow.
    job.retry = { units: [{ slug: "first-talk", stage: "S2" }] };
    job.skipped = [];
    const { deps, calls } = makeDeps(() => sweepReply("agentic-workflow"));

    const cancelled = await runS6(deps);

    expect(cancelled).toBe(false);
    expect(calls).toHaveLength(1);
    const notability = NotabilitySchema.parse(
      JSON.parse(await readFile(notabilityPath(dir), "utf8")),
    );
    expect(notability.scores).toEqual([
      { slug: "agentic-workflow", score: 0.8 },
      { slug: "n8n", score: 0.4 },
    ]);
    expect(notability.at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("leaves the triage untouched when a narrowed retry has no targets", async () => {
    await writeFixtures(true);
    const stored = JSON.stringify({
      scores: [{ slug: "agentic-workflow", score: 0.7 }],
      at: JOB_CREATED,
    });
    await writeFile(notabilityPath(dir), stored, "utf8");
    // The only target is outside the S6 scope; the sweep evaluates nothing.
    job.retry = { units: [{ slug: "n8n", stage: "S6" }] };
    job.skipped = [];
    const { deps, calls } = makeDeps(() => sweepReply("agentic-workflow"));

    const cancelled = await runS6(deps);

    expect(cancelled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(notabilityPath(dir), "utf8")).toBe(stored);
  });

  it("keeps the raw reply, the page and a retryable skip on a rejected reply", async () => {
    await writeFixtures(true);
    const before = await readFile(
      join(root, "concepts", "agentic-workflow.md"),
      "utf8",
    );
    const { deps } = makeDeps(() => "not json at all");

    const cancelled = await runS6(deps);
    expect(cancelled).toBe(false);

    const raw = await readFile(
      join(dir, "llm", "S6-sweep-0-1.txt"),
      "utf8",
    );
    expect(raw).toBe("not json at all");

    const after = await readFile(
      join(root, "concepts", "agentic-workflow.md"),
      "utf8",
    );
    expect(after).toBe(before);

    expect(job.skipped).toContainEqual(
      expect.objectContaining({
        slug: "agentic-workflow",
        stage: "S6",
        reason: "malformed_json",
      }),
    );

    const notability = NotabilitySchema.parse(
      JSON.parse(await readFile(notabilityPath(dir), "utf8")),
    );
    expect(notability.scores).toEqual([]);
  });
});

describe("collectSweepTargets", () => {
  it("selects only the short page, sorted by slug", async () => {
    await writeFixtures(true);

    const targets = await collectSweepTargets(job, manifestFixture(), root);

    expect(targets.map((target) => target.slug)).toEqual(["agentic-workflow"]);
  });

  it("selects a label recorded as an S4 skip even when its page is long", async () => {
    await writeFixtures(true);
    job.skipped.push({ slug: "n8n", stage: "S4", reason: "model_error" });

    const targets = await collectSweepTargets(job, manifestFixture(), root);

    expect(targets.map((target) => target.slug)).toEqual([
      "agentic-workflow",
      "n8n",
    ]);
  });
});

describe("SweepSchema", () => {
  it("accepts a bounded body and clamps the score", () => {
    const parsed = SweepSchema.parse({
      pages: [
        {
          kind: "concept",
          slug: "Agentic Workflow",
          body: "First paragraph.\n\nSecond paragraph.",
          notable: 3,
        },
      ],
    });
    expect(parsed.pages[0]).toEqual({
      kind: "concept",
      slug: "agentic-workflow",
      body: "First paragraph.\n\nSecond paragraph.",
      notable: 1,
    });
  });

  it("rejects a heading or a link in a body", () => {
    expect(() =>
      SweepSchema.parse({
        pages: [
          {
            kind: "concept",
            slug: "x",
            body: "## Heading\n\nA second paragraph.",
            notable: 0.5,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SweepSchema.parse({
        pages: [
          {
            kind: "concept",
            slug: "x",
            body: "A [link](../sources/x.md).\n\nA second paragraph.",
            notable: 0.5,
          },
        ],
      }),
    ).toThrow();
  });
});
