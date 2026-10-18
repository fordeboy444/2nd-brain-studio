import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../http/writeAtomic.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../../llm/ollama.js";
import {
  writeExtraction,
  type ExtractionRecord,
  type ExtractionSource,
} from "../extraction.js";
import { readManifest, readTaxonomy } from "../manifest.js";
import { runJob, type StageDeps } from "../runner.js";
import { createJobRecord, jobDir, newJobId, writeJob } from "../store.js";
import type { JobRecord, JobSettings } from "../types.js";
import { createS3Stage } from "./s3.js";

/**
 * The barrier proof needs to know when `listExtractions` resolved, and the
 * no-raw-read proof needs a counter that a call would trip. Both are hoisted so
 * the module mocks can see them.
 */
const spy = vi.hoisted(() => ({
  listDone: false,
  listCalls: 0,
  captureReads: 0,
}));

vi.mock("../extraction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extraction.js")>();
  return {
    ...actual,
    async listExtractions(jobDirPath: string) {
      spy.listCalls += 1;
      const records = await actual.listExtractions(jobDirPath);
      spy.listDone = true;
      return records;
    },
  };
});

vi.mock("../capture.js", () => ({
  readCapture() {
    spy.captureReads += 1;
    throw new Error("S3 must never open a raw capture");
  },
}));

const FIXED_ISO = "2026-10-18T10:00:00.000Z";
const FIXED_NOW = Date.parse(FIXED_ISO);

const SETTINGS: JobSettings = {
  maxVideos: 50,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

interface BatchLabel {
  kind: "concept" | "entity";
  slug: string;
  name: string;
  sourceCount: number;
  tags: string[];
}

interface CapturedCall {
  messages: LlmMessage[];
  canonical: boolean;
  labels: BatchLabel[];
  rawPath?: string;
  sawExtractions: boolean;
}

interface FakeLlm {
  calls: CapturedCall[];
  client: LlmClient;
  canonicalCalls: number;
  taxonomyCalls: number;
}

function defaultCanonical(labels: BatchLabel[]): string {
  return JSON.stringify({
    labels: labels.map((label) => ({
      from: label.slug,
      to: label.slug,
      title: label.name,
      tags: label.tags,
      aliases: [],
    })),
  });
}

const EMPTY_TAXONOMY = JSON.stringify({
  concept_themes: [],
  tool_themes: [],
  source_clusters: [],
});

/**
 * A fake client that honours the raw-reply contract: the exact reply text is on
 * disk before `chat` returns. It routes by the system prompt, because S3 sends
 * two different paid requests.
 */
function fakeLlm(options: {
  canonicalText?: (call: CapturedCall) => string;
  taxonomyText?: (call: CapturedCall) => string;
} = {}): FakeLlm {
  const state: FakeLlm = {
    calls: [],
    canonicalCalls: 0,
    taxonomyCalls: 0,
    client: undefined as unknown as LlmClient,
  };

  state.client = {
    async chat(messages: LlmMessage[], chatOptions: LlmChatOptions) {
      const system = messages[0]?.content ?? "";
      const canonical = system.includes("canonicalise");
      const payload = messages[1]?.content ?? "";
      const labels = payload
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as BatchLabel);
      const call: CapturedCall = {
        messages,
        canonical,
        labels,
        sawExtractions: spy.listDone,
        ...(chatOptions.rawPath !== undefined ? { rawPath: chatOptions.rawPath } : {}),
      };
      state.calls.push(call);
      if (canonical) state.canonicalCalls += 1;
      else state.taxonomyCalls += 1;

      let text: string;
      if (canonical) {
        text = options.canonicalText?.(call) ?? defaultCanonical(labels);
      } else {
        text = options.taxonomyText?.(call) ?? EMPTY_TAXONOMY;
      }
      if (chatOptions.rawPath !== undefined) {
        await writeTextAtomic(chatOptions.rawPath, text);
      }
      return { text, tokensIn: 1, tokensOut: 1 };
    },
  };

  return state;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s3-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
  spy.listDone = false;
  spy.listCalls = 0;
  spy.captureReads = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function source(
  slug: string,
  overrides: Partial<ExtractionSource> = {},
): ExtractionSource {
  return {
    slug,
    title: `Title ${slug}`,
    sourceKind: "video",
    youtubeId: `yt-${slug}`,
    duration: 600,
    rawPath: `raw/${slug}.md`,
    fetchedAt: FIXED_ISO,
    ...overrides,
  };
}

interface RecordOptions {
  source?: Partial<ExtractionSource>;
  tags?: string[];
  concepts?: Array<{ name: string; slug: string; weight: number }>;
  entities?: Array<{
    name: string;
    slug: string;
    type: "tool" | "person" | "organization" | "product" | "framework" | "concept" | "unknown";
    weight: number;
  }>;
  relations?: Array<{ to: string; kind: "builds_on" | "part_of" | "contrasts_with" | "related_to" }>;
}

function record(slug: string, options: RecordOptions = {}): ExtractionRecord {
  return {
    slug,
    title: `Title ${slug}`,
    thesis: "",
    summary: "",
    tags: options.tags ?? [],
    concepts: options.concepts ?? [],
    entities: options.entities ?? [],
    quotes: [],
    relations: options.relations ?? [],
    source: source(slug, options.source),
    at: FIXED_ISO,
  };
}

function makeJob(createdAt = FIXED_ISO, random = 0.5): JobRecord {
  return createJobRecord({
    id: newJobId(new Date(2026, 9, 18), () => random),
    vaultId: "vault",
    kind: "youtube",
    input: { url: "https://www.youtube.com/@x/videos" },
    settings: SETTINGS,
    createdAt,
  });
}

function makeDeps(llm: LlmClient): StageDeps {
  return {
    async fetchTranscript() {
      throw new Error("not used by S3");
    },
    async fetchWeb() {
      throw new Error("not used by S3");
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
    now: () => FIXED_NOW,
    vaultDirFor: () => root,
    llm,
    cacheDirFor: (vaultId) => join(root, ".okf", "cache", "llm", vaultId),
    async writePage(vaultDir, relPath, text) {
      await writeTextAtomic(join(vaultDir, relPath), text);
    },
  };
}

async function seed(job: JobRecord, records: readonly ExtractionRecord[]): Promise<string> {
  const dir = jobDir(root, job.id);
  for (const item of records) {
    await writeExtraction(dir, item);
  }
  return dir;
}

async function runS3(job: JobRecord, llm: LlmClient): Promise<boolean> {
  await writeJob(root, job);
  const dir = jobDir(root, job.id);
  const persist = async (): Promise<void> => {
    await writeJob(root, job);
  };
  return createS3Stage(makeDeps(llm))(job, { ...ctxFor(job) }, dir, persist);
}

function ctxFor(job: JobRecord) {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: job.id,
    vaultDir: root,
    now: () => FIXED_NOW,
  };
}

describe("S3 barrier", () => {
  it("reads every extraction before the first model call", async () => {
    const job = makeJob();
    await seed(job, [
      record("first-talk", {
        concepts: [{ name: "Alpha", slug: "alpha", weight: 0.5 }],
      }),
      record("second-talk", {
        concepts: [{ name: "Beta", slug: "beta", weight: 0.5 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    expect(spy.listCalls).toBe(1);
    expect(spy.listDone).toBe(true);
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(llm.calls.every((call) => call.sawExtractions)).toBe(true);
    expect(spy.captureReads).toBe(0);
  });

  it("writes both documents even when there are no extractions", async () => {
    const job = makeJob();
    const llm = fakeLlm();
    await runS3(job, llm.client);

    const dir = jobDir(root, job.id);
    expect(await readManifest(dir)).toEqual({
      concepts: [],
      entities: [],
      sources: [],
      edges: [],
      filtered: [],
      at: FIXED_ISO,
    });
    expect(await readTaxonomy(dir)).toEqual({
      concept_themes: [],
      tool_themes: [],
      source_clusters: [],
      at: FIXED_ISO,
    });
    expect(llm.calls).toEqual([]);
  });
});

describe("S3 manifest", () => {
  it("merges exact-slug duplicates with unioned sources, tags and max weight", async () => {
    const job = makeJob();
    await seed(job, [
      record("first-talk", {
        tags: ["agents", "workflow"],
        concepts: [{ name: "The PIV Loop", slug: "the-piv-loop", weight: 0.4 }],
      }),
      record("second-talk", {
        tags: ["agents", "teams"],
        concepts: [{ name: "PIV loop", slug: "the-piv-loop", weight: 0.9 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const dir = jobDir(root, job.id);
    const manifest = await readManifest(dir);
    expect(manifest?.concepts).toEqual([
      {
        slug: "the-piv-loop",
        title: "The PIV Loop",
        tags: ["agents", "teams", "workflow"],
        sources: ["first-talk", "second-talk"],
        weight: 0.9,
      },
    ]);

    // One batch row, not one per occurrence.
    const sent = llm.calls.filter((call) => call.canonical);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.labels).toHaveLength(1);
    expect(sent[0]?.labels[0]?.sourceCount).toBe(2);
  });

  it("keeps every surviving source with its identity keys and duration", async () => {
    const job = makeJob();
    await seed(job, [
      record("video-talk", {
        concepts: [{ name: "Alpha", slug: "alpha", weight: 0.5 }],
      }),
      record("example-post", {
        source: {
          sourceKind: "web",
          youtubeId: undefined,
          url: "https://example.com/post",
          duration: undefined,
          wordCount: 400,
        },
        concepts: [{ name: "Alpha", slug: "alpha", weight: 0.5 }],
      }),
    ]);

    await runS3(job, fakeLlm().client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.sources).toEqual([
      {
        slug: "example-post",
        title: "Title example-post",
        kind: "web",
        tags: [],
        concepts: ["alpha"],
        entities: [],
        url: "https://example.com/post",
      },
      {
        slug: "video-talk",
        title: "Title video-talk",
        kind: "video",
        tags: [],
        concepts: ["alpha"],
        entities: [],
        youtube_id: "yt-video-talk",
        duration: 600,
      },
    ]);
  });

  it("derives edges only from extraction relations that resolve to a manifest slug", async () => {
    const job = makeJob();
    await seed(job, [
      record("first-talk", {
        concepts: [
          { name: "Alpha", slug: "alpha", weight: 0.5 },
          { name: "Beta", slug: "beta", weight: 0.5 },
        ],
        relations: [
          { to: "beta", kind: "builds_on" },
          { to: "ghost", kind: "related_to" },
        ],
      }),
      record("second-talk", {
        concepts: [
          { name: "Alpha", slug: "alpha", weight: 0.5 },
          { name: "Beta", slug: "beta", weight: 0.5 },
        ],
        relations: [{ to: "alpha", kind: "contrasts_with" }],
      }),
    ]);

    await runS3(job, fakeLlm().client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.edges).toEqual([
      { from: "alpha", to: "beta", kind: "builds_on" },
      { from: "beta", to: "alpha", kind: "contrasts_with" },
    ]);
  });
});

describe("S3 candidate filter", () => {
  it("keeps a label named by two ordinary videos", async () => {
    const job = makeJob();
    await seed(job, [
      record("first-talk", {
        source: { duration: 600 },
        concepts: [{ name: "Alpha", slug: "alpha", weight: 0.5 }],
      }),
      record("second-talk", {
        source: { duration: 600 },
        concepts: [{ name: "Alpha", slug: "alpha", weight: 0.7 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.concepts.map((concept) => concept.slug)).toEqual(["alpha"]);
    expect(manifest?.concepts[0]?.sources).toEqual([
      "first-talk",
      "second-talk",
    ]);
    expect(manifest?.filtered).toEqual([]);
    expect(job.skipped).toEqual([]);

    const canonical = llm.calls.filter((call) => call.canonical);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.labels.map((label) => label.slug)).toEqual(["alpha"]);
  });

  it("filters a tool named once in a 300-second video", async () => {
    const job = makeJob();
    await seed(job, [
      record("first-talk", {
        source: { duration: 300 },
        entities: [
          { name: "One Off Tool", slug: "one-off-tool", type: "tool", weight: 0.5 },
        ],
      }),
      // A source with no surviving label still belongs in the manifest.
      record("empty-talk", { source: { duration: 600 } }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.entities).toEqual([]);
    expect(manifest?.filtered).toEqual([
      { slug: "one-off-tool", kind: "entity", reason: "single_source" },
    ]);
    expect(manifest?.sources.map((source) => source.slug)).toEqual([
      "empty-talk",
      "first-talk",
    ]);
    // A dropped label never reaches the model.
    expect(llm.calls).toEqual([]);
    expect(job.skipped).toEqual([]);
  });

  it("keeps a concept named once in a 1500-second video", async () => {
    const job = makeJob();
    await seed(job, [
      record("deep-talk", {
        source: { duration: 1500 },
        concepts: [{ name: "Deep Idea", slug: "deep-idea", weight: 0.5 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.concepts.map((concept) => concept.slug)).toEqual([
      "deep-idea",
    ]);
    expect(manifest?.filtered).toEqual([]);
    expect(job.skipped).toEqual([]);
  });

  it("filters a label named by one video and one ordinary web page", async () => {
    const job = makeJob();
    await seed(job, [
      record("short-talk", {
        source: { duration: 600 },
        concepts: [{ name: "Mixed Label", slug: "mixed-label", weight: 0.5 }],
      }),
      record("ordinary-post", {
        source: {
          sourceKind: "web",
          youtubeId: undefined,
          url: "https://example.com/ordinary",
          duration: undefined,
          wordCount: 400,
        },
        concepts: [{ name: "Mixed Label", slug: "mixed-label", weight: 0.5 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.concepts).toEqual([]);
    expect(manifest?.filtered).toEqual([
      { slug: "mixed-label", kind: "concept", reason: "single_source" },
    ]);
    // The web page never counts toward the two-video branch.
    expect(llm.calls).toEqual([]);
    expect(job.skipped).toEqual([]);
  });

  it("filters two ordinary web pages and keeps a deep-dive page", async () => {
    const job = makeJob();
    const web = (slug: string, wordCount: number): ExtractionSource => ({
      ...source(slug),
      sourceKind: "web",
      youtubeId: undefined,
      url: `https://example.com/${slug}`,
      duration: undefined,
      wordCount,
    });
    await seed(job, [
      record("post-one", {
        source: { ...web("post-one", 400) },
        concepts: [{ name: "Web Only", slug: "web-only", weight: 0.5 }],
      }),
      record("post-two", {
        source: { ...web("post-two", 400) },
        concepts: [{ name: "Web Only", slug: "web-only", weight: 0.5 }],
      }),
      record("deep-post", {
        source: { ...web("deep-post", 3200) },
        concepts: [{ name: "Deep Page", slug: "deep-page", weight: 0.5 }],
      }),
    ]);

    const llm = fakeLlm();
    await runS3(job, llm.client);

    const manifest = await readManifest(jobDir(root, job.id));
    expect(manifest?.concepts.map((concept) => concept.slug)).toEqual([
      "deep-page",
    ]);
    expect(manifest?.filtered).toEqual([
      { slug: "web-only", kind: "concept", reason: "single_source" },
    ]);
    // Only the deep-dive label is paid for.
    const canonical = llm.calls.filter((call) => call.canonical);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.labels.map((label) => label.slug)).toEqual([
      "deep-page",
    ]);
    expect(job.skipped).toEqual([]);
  });
});

describe("S3 determinism", () => {
  it("writes byte-identical files on a second run and makes no call", async () => {
    const records = [
      record("first-talk", {
        tags: ["agents"],
        concepts: [
          { name: "Alpha", slug: "alpha", weight: 0.5 },
          { name: "Beta", slug: "beta", weight: 0.5 },
        ],
        relations: [{ to: "beta", kind: "part_of" }],
      }),
      record("second-talk", {
        tags: ["agents", "teams"],
        concepts: [{ name: "Beta", slug: "beta", weight: 0.7 }],
      }),
    ];

    const firstJob = makeJob();
    await seed(firstJob, records);
    const firstLlm = fakeLlm();
    await runS3(firstJob, firstLlm.client);
    expect(firstLlm.calls.length).toBeGreaterThan(0);

    const secondJob = makeJob();
    await seed(secondJob, records);
    const secondLlm = fakeLlm();
    await runS3(secondJob, secondLlm.client);

    expect(secondLlm.calls).toEqual([]);

    const firstDir = jobDir(root, firstJob.id);
    const secondDir = jobDir(root, secondJob.id);
    for (const name of ["manifest.json", "taxonomy.json"]) {
      expect(await readFile(join(secondDir, name), "utf8")).toBe(
        await readFile(join(firstDir, name), "utf8"),
      );
    }
  });
});

describe("S3 failure containment", () => {
  it("records one retryable skip for a failed batch and completes the job", async () => {
    const concepts = Array.from({ length: 36 }, (_, index) => ({
      name: `Concept ${index}`,
      slug: `concept-${String(index).padStart(2, "0")}`,
      weight: 0.5,
    }));

    const job: JobRecord = { ...makeJob(), stage: "S3" };
    await seed(job, [record("first-talk", { concepts })]);

    const llm = fakeLlm({
      canonicalText(call) {
        // Only batch 0 fails; batch 1 answers normally.
        return call.rawPath?.includes("labels-0") === true
          ? "this is not json at all"
          : defaultCanonical(call.labels);
      },
    });

    await writeJob(root, job);
    const finished = await runJob(job, makeDeps(llm.client));

    expect(finished.status).toBe("completed");
    expect(finished.stage).toBe("done");

    const dir = jobDir(root, job.id);
    // Three ladder attempts for batch 0, then batch 1, then two taxonomy calls.
    expect(llm.canonicalCalls).toBe(4);
    expect(llm.taxonomyCalls).toBe(2);

    expect(
      await readFile(join(dir, "llm", "S3-labels-0-1.txt"), "utf8"),
    ).toBe("this is not json at all");

    const skipped = finished.skipped.filter((unit) => unit.stage === "S3");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      slug: "labels-0",
      stage: "S3",
      reason: "malformed_json",
    });
    expect(skipped[0]?.detail?.length).toBeLessThanOrEqual(200);

    const manifest = await readManifest(dir);
    // The failed batch keeps its labels under their original slugs.
    expect(manifest?.concepts).toHaveLength(36);
    expect(manifest?.concepts.map((concept) => concept.slug)).toContain(
      "concept-00",
    );

    const taxonomy = await readTaxonomy(dir);
    expect(taxonomy).not.toBeNull();

    // Only the successful calls wrote cache entries: batch 1 plus two taxonomy.
    const cacheDir = join(root, ".okf", "cache", "llm", "vault");
    expect((await readdir(cacheDir)).length).toBe(3);
  });
});
