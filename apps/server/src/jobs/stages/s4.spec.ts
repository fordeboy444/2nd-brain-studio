import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createS4Stage, PROMPT_VERSION_S4 } from "./s4.js";

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

function makeDeps(): {
  deps: StageDeps;
  calls: () => number;
} {
  let calls = 0;
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
      async chat() {
        calls += 1;
        return { text: "[]", tokensIn: 0, tokensOut: 0 };
      },
    },
    cacheDirFor: () => join(root, ".okf", "cache", "llm"),
    async writePage(vaultDir, relPath, text) {
      const target = join(vaultDir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
  };
  return { deps, calls: () => calls };
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
): Promise<{ job: JobRecord; dir: string; deps: StageDeps; calls: () => number }> {
  const job = makeJob();
  const dir = join(root, ".okf", "jobs", job.id);
  await mkdir(dir, { recursive: true });
  await writeJob(root, job);
  await writeManifest(dir, manifest);
  await writeTaxonomy(dir, taxonomyFixture());
  for (const record of records) await writeExtraction(dir, record);
  const { deps, calls } = makeDeps();
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

    const cancelled = await createS4Stage(deps)(job, ctxFor(job), dir, async () => {});
    expect(cancelled).toBe(false);
    expect(calls()).toBe(0);

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
