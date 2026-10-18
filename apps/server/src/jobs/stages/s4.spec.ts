import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTextAtomic } from "../../http/writeAtomic.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../../llm/ollama.js";
import { writeExtraction, type ExtractionRecord } from "../extraction.js";
import {
  writeManifest,
  writeTaxonomy,
  type ManifestRecord,
  type TaxonomyRecord,
} from "../manifest.js";
import type { StageDeps, UnitContext } from "../runner.js";
import { createJobRecord, newJobId, readEvents, writeJob } from "../store.js";
import type { JobRecord } from "../types.js";
import {
  buildPageMessages,
  buildPageRequests,
  createS4Stage,
  PAGES_PER_CALL,
  PROMPT_VERSION_S4,
  renderSourcePages,
} from "./s4.js";

const JOB_CREATED = "2026-10-18T10:00:00.000Z";
const CAPTURE_AT = "2026-10-17T09:00:00.000Z";

let root: string;

function makeJob(): JobRecord {
  return createJobRecord({
    id: newJobId(new Date(2026, 9, 18), () => 0.25),
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

function ctxFor(job: JobRecord): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: job.id,
    vaultDir: root,
    now: () => Date.parse(JOB_CREATED),
  };
}

interface CapturedCall {
  messages: LlmMessage[];
  requests: Array<{ slug: string }>;
  rawPath?: string;
}

function makeDeps(options: {
  reply?: (call: CapturedCall) => string;
} = {}): { deps: StageDeps; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
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
    llm: {
      async chat(messages: LlmMessage[], chatOptions: LlmChatOptions) {
        const payload = messages[1]?.content ?? "";
        const requests = payload
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { slug: string });
        const call: CapturedCall = {
          messages,
          requests,
          ...(chatOptions.rawPath !== undefined
            ? { rawPath: chatOptions.rawPath }
            : {}),
        };
        calls.push(call);
        const text = options.reply?.(call) ?? "[]";
        if (chatOptions.rawPath !== undefined) {
          await writeTextAtomic(chatOptions.rawPath, text);
        }
        return { text, tokensIn: 1, tokensOut: 1 };
      },
    },
    cacheDirFor: () => join(root, ".okf", "cache", "llm"),
    async writePage(vaultDir, relPath, text) {
      const target = join(vaultDir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
  };
  return { deps, calls };
}

function videoRecord(overrides: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    slug: "first-talk",
    title: "First Talk",
    thesis: "The talk argues one thing.",
    summary: "A summary of the talk.",
    tags: ["agents", "workflow"],
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
      published: "2026-01-01",
      duration: 1402,
      rawPath: "raw/first-talk.md",
      fetchedAt: CAPTURE_AT,
    },
    at: CAPTURE_AT,
    ...overrides,
  };
}

function webRecord(overrides: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    slug: "example-post",
    title: "Example Post",
    thesis: "The page argues one thing.",
    summary: "A summary of the page.",
    tags: ["web"],
    concepts: [],
    entities: [],
    quotes: [{ text: "alpha paragraph" }],
    relations: [],
    source: {
      slug: "example-post",
      title: "Example Post",
      sourceKind: "web",
      url: "https://example.com/post",
      site: "example.com",
      wordCount: 512,
      rawPath: "raw/example-post.md",
      fetchedAt: CAPTURE_AT,
    },
    at: CAPTURE_AT,
    ...overrides,
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
        tags: ["agents", "workflow"],
        concepts: ["agentic-workflow"],
        entities: ["n8n"],
        youtube_id: "abc123",
        duration: 1402,
      },
      {
        slug: "example-post",
        title: "Example Post",
        kind: "web",
        tags: ["web"],
        concepts: [],
        entities: [],
        url: "https://example.com/post",
      },
    ],
    edges: [],
    filtered: [
      { slug: "passing-mention", kind: "concept", reason: "single_source" },
    ],
    at: JOB_CREATED,
  };
}

function taxonomyFixture(): TaxonomyRecord {
  return {
    concept_themes: [],
    tool_themes: [],
    source_clusters: [],
    at: JOB_CREATED,
  };
}

async function writeFixtures(
  manifest: ManifestRecord,
  records: ExtractionRecord[],
  options: { reply?: (call: CapturedCall) => string } = {},
): Promise<{
  job: JobRecord;
  dir: string;
  deps: StageDeps;
  calls: CapturedCall[];
}> {
  const job = makeJob();
  const dir = join(root, ".okf", "jobs", job.id);
  await mkdir(dir, { recursive: true });
  await writeJob(root, job);
  await writeManifest(dir, manifest);
  await writeTaxonomy(dir, taxonomyFixture());
  for (const record of records) await writeExtraction(dir, record);
  const { deps, calls } = makeDeps(options);
  return { job, dir, deps, calls };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s4-spec-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("S4a source pages", () => {
  it("writes every manifest source page in code and makes zero model calls", async () => {
    const { job, dir, deps, calls } = await writeFixtures(manifestFixture(), [
      videoRecord(),
      webRecord(),
    ]);

    const result = await renderSourcePages(
      job,
      ctxFor(job),
      dir,
      deps,
      manifestFixture(),
      taxonomyFixture(),
      async () => {},
    );
    expect(result.cancelled).toBe(false);
    expect(calls).toHaveLength(0);

    const video = parseFrontmatter(
      await readFile(join(root, "sources", "first-talk.md"), "utf8"),
    );
    expect(video).not.toBeNull();
    expect(Object.keys(video!.data)).toEqual([
      "type",
      "source_kind",
      "youtube_id",
      "slug",
      "title",
      "description",
      "published",
      "duration",
      "raw",
      "tags",
      "created",
      "updated",
    ]);
    expect(video!.data.description).toBe("The talk argues one thing.");
    expect(video!.data.raw).toBe("../raw/first-talk.md");
    expect(video!.data.created).toBe(CAPTURE_AT);
    expect(video!.data.updated).toBe(CAPTURE_AT);
    expect(video!.body).toContain("## Summary");
    expect(video!.body).toContain(
      "- [Agentic Workflow](../concepts/agentic-workflow.md)",
    );
    expect(video!.body).toContain("- [n8n](../entities/tool/n8n.md)");
    expect(video!.body).toContain("- **[0:01:05]** hello there");
    expect(video!.body).not.toContain("## Sources");

    const web = parseFrontmatter(
      await readFile(join(root, "sources", "example-post.md"), "utf8"),
    );
    expect(web).not.toBeNull();
    expect(web!.data.source_kind).toBe("web");
    expect(web!.data.url).toBe("https://example.com/post");
    expect(web!.body).not.toContain("## Key moments");
    expect(web!.body).not.toContain("[0:01:05]");

    // A filtered label earns no page.
    await expect(
      readFile(join(root, "concepts", "passing-mention.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const events = await readEvents(dir, 0);
    const written = events.filter(
      (event) => event.type === "unit" && event.data.stage === "S4",
    );
    expect(written.map((event) => event.data.slug).sort()).toEqual([
      "example-post",
      "first-talk",
    ]);
    expect(written.every((event) => event.data.status === "written")).toBe(true);
  });

  it("keeps partial: true on the page after S4a rewrites it", async () => {
    const partial = videoRecord({
      thesis: "",
      summary: "",
      tags: [],
      concepts: [],
      entities: [],
      quotes: [],
      partial: true,
    });
    const { job, dir, deps } = await writeFixtures(manifestFixture(), [
      partial,
      webRecord(),
    ]);

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});
    const page = parseFrontmatter(
      await readFile(join(root, "sources", "first-talk.md"), "utf8"),
    );
    expect(page!.data.partial).toBe(true);
    expect(page!.data.description).toBe("First Talk");
    expect(page!.body).not.toContain("A summary of the talk.");
  });

  it("writes a partial page for a missing extraction and records a skip", async () => {
    const manifest = manifestFixture();
    manifest.sources.push({
      slug: "lost-episode",
      title: "Lost Episode",
      kind: "video",
      tags: ["agents"],
      concepts: [],
      entities: [],
      youtube_id: "lost123",
      duration: 600,
    });
    const { job, dir, deps } = await writeFixtures(manifest, [
      videoRecord(),
      webRecord(),
    ]);

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    const page = parseFrontmatter(
      await readFile(join(root, "sources", "lost-episode.md"), "utf8"),
    );
    expect(page!.data.partial).toBe(true);
    expect(page!.data.description).toBe("Lost Episode");
    expect(page!.data.created).toBe(JOB_CREATED);
    expect(page!.data.updated).toBe(JOB_CREATED);

    expect(job.skipped).toContainEqual({
      slug: "lost-episode",
      stage: "S4",
      reason: "capture_invalid",
      detail: "extraction missing",
    });
  });

  it("exposes the S4 prompt version", () => {
    expect(PROMPT_VERSION_S4).toBe("s4-v1");
  });
});

const GOOD_BODY =
  "The label names a way of working with agents.\n\nIt appears in the first talk.";

function pagePayload(bodies: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(bodies).map(([slug, body]) => ({ slug, body })),
  );
}

function elevenLabelManifest(): ManifestRecord {
  const concepts = Array.from({ length: 11 }, (_, index) => ({
    slug: `label-${index}`,
    title: `Label ${index}`,
    tags: ["agents"],
    sources: ["first-talk"],
    weight: 1,
  }));
  const manifest = manifestFixture();
  manifest.concepts = concepts;
  manifest.entities = [];
  return manifest;
}

describe("S4b label pages", () => {
  it("makes three calls for eleven labels and never more than five requests a call", async () => {
    const { job, dir, deps, calls } = await writeFixtures(elevenLabelManifest(), [
      videoRecord(),
    ]);

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.requests.length <= PAGES_PER_CALL)).toBe(
      true,
    );
    expect(
      calls.reduce((count, call) => count + call.requests.length, 0),
    ).toBe(11);
    const requests = buildPageRequests(
      elevenLabelManifest(),
      [videoRecord()],
      taxonomyFixture(),
    );
    expect(requests).toHaveLength(11);
    expect(() =>
      buildPageMessages([
        ...requests,
        ...requests.slice(0, 1),
        ...requests.slice(0, 1),
        ...requests.slice(0, 1),
        ...requests.slice(0, 1),
        ...requests.slice(0, 1),
      ]),
    ).toThrow();
  });

  it("rejects a body with a heading, writes the code fallback and keeps the raw reply", async () => {
    const { job, dir, deps } = await writeFixtures(
      manifestFixture(),
      [videoRecord(), webRecord()],
      {
        reply: () =>
          pagePayload({
            "agentic-workflow": "## Heading\n\nBody text.",
          }),
      },
    );

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    const page = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(page).not.toBeNull();
    expect(page!.body).not.toContain("## Heading");
    expect(page!.body).toContain("## Overview");
    expect(page!.body).toContain("A summary of the talk.");
    expect(job.skipped).toContainEqual(
      expect.objectContaining({
        slug: "agentic-workflow",
        stage: "S4",
        reason: "model_error",
      }),
    );

    const raw = await readFile(
      join(dir, "llm", "S4-pages-0-1.txt"),
      "utf8",
    );
    expect(raw).toContain("## Heading");
  });

  it("rejects a body with a markdown link", async () => {
    const { job, dir, deps } = await writeFixtures(
      manifestFixture(),
      [videoRecord(), webRecord()],
      {
        reply: () =>
          pagePayload({
            "agentic-workflow":
              "One paragraph with [a link](https://example.com).\n\nSecond paragraph.",
          }),
      },
    );

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});
    const page = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(page!.body).not.toContain("](https://example.com)");
  });

  it("keeps frontmatter and `## Sources` when the model body is one bare paragraph", async () => {
    const { job, dir, deps } = await writeFixtures(
      manifestFixture(),
      [videoRecord(), webRecord()],
      {
        reply: () =>
          pagePayload({ "agentic-workflow": "Only one paragraph." }),
      },
    );

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    const page = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(Object.keys(page!.data)).toEqual([
      "type",
      "title",
      "slug",
      "sources",
      "tags",
      "created",
      "updated",
    ]);
    expect(page!.data.type).toBe("concept");
    expect(page!.data.sources).toEqual(["first-talk"]);
    expect(page!.body).not.toContain("Only one paragraph.");
    expect(page!.body).toContain("## Overview");
    expect(page!.body).toContain("## Sources");
    expect(page!.body).toContain(
      '- [First Talk](../sources/first-talk.md) - "[0:01:05] hello there"',
    );
  });

  it("takes only a requested slug once and ignores an unknown slug", async () => {
    const { job, dir, deps } = await writeFixtures(
      manifestFixture(),
      [videoRecord(), webRecord()],
      {
        reply: () =>
          JSON.stringify([
            { slug: "agentic-workflow", body: GOOD_BODY },
            { slug: "agentic-workflow", body: "Second.\n\nDuplicate body." },
            { slug: "evil-page", body: GOOD_BODY },
          ]),
      },
    );

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    const page = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(page!.body).toContain("The label names a way of working with agents.");
    expect(page!.body).not.toContain("Duplicate body.");
    await expect(
      readFile(join(root, "concepts", "evil-page.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, "entities", "tool", "evil-page.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stamps both timestamps from the job and renders the reference citation", async () => {
    const { job, dir, deps } = await writeFixtures(
      manifestFixture(),
      [videoRecord(), webRecord()],
      {
        reply: () =>
          pagePayload({
            "agentic-workflow": GOOD_BODY,
            n8n: "n8n is a workflow tool.\n\nIt connects services.",
          }),
      },
    );

    await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});

    const concept = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(concept!.data.created).toBe(JOB_CREATED);
    expect(concept!.data.updated).toBe(JOB_CREATED);
    expect(concept!.body).toContain(
      '## Sources\n\n- [First Talk](../sources/first-talk.md) - "[0:01:05] hello there"\n',
    );

    const entity = parseFrontmatter(
      await readFile(join(root, "entities", "tool", "n8n.md"), "utf8"),
    );
    expect(Object.keys(entity!.data)).toEqual([
      "type",
      "entity_type",
      "title",
      "slug",
      "sources",
      "tags",
      "created",
      "updated",
    ]);
    expect(entity!.data.type).toBe("entity");
    expect(entity!.data.entity_type).toBe("tool");
    expect(entity!.body).toContain("It connects services.");
  });
});
