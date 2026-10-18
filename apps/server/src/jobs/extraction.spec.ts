import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Extraction } from "../llm/json.js";
import { writeTextAtomic } from "../http/writeAtomic.js";
import {
  captureFetchedAt,
  captureKind,
  captureTitle,
  extractionPath,
  listExtractions,
  readExtraction,
  sourceFromCapture,
  titleFromSlug,
  toExtractionRecord,
  transcriptText,
  writeExtraction,
  type CaptureDocument,
} from "./extraction.js";

const FIXED_ISO = "2026-10-18T10:00:00.000Z";

function videoCapture(overrides: Partial<CaptureDocument> = {}): CaptureDocument {
  return {
    slug: "first-talk",
    frontmatter: {
      type: "raw-transcript",
      source_kind: "video",
      youtube_id: "abc123",
      url: "https://youtu.be/abc123",
      slug: "first-talk",
      published: "2026-01-01",
      duration: 1402,
      fetched_at: FIXED_ISO,
      tier: 1,
      immutable: true,
    },
    body:
      "\n## Transcript\n\n**[0:00:00]** hello there\n\n**[0:23:22]** goodbye now\n",
    raw: "",
    ...overrides,
  };
}

function webCapture(overrides: Partial<CaptureDocument> = {}): CaptureDocument {
  return {
    slug: "example-post",
    frontmatter: {
      type: "raw-capture",
      source_kind: "web",
      url: "https://example.com/post",
      site: "example.com",
      slug: "example-post",
      captured_at: FIXED_ISO,
      capture_kind: "page",
      word_count: 512,
      immutable: true,
    },
    body:
      "\n## Extracted text\n\n**[#1]** alpha paragraph\n\n**[#2]** beta paragraph\n",
    raw: "",
    ...overrides,
  };
}

const EXTRACTION: Extraction = {
  slug: "model-chosen-slug",
  title: "First Talk",
  thesis: "The talk argues one thing.",
  summary: "A summary of the talk.",
  tags: ["agents", "workflow"],
  concepts: [{ name: "Agentic Workflow", slug: "agentic-workflow", weight: 0.9 }],
  entities: [
    { name: "n8n", slug: "n8n", type: "tool", weight: 0.7 },
  ],
  quotes: [
    { text: "hello there", startSec: 0 },
    { text: "goodbye now", startSec: 1402 },
  ],
  relations: [{ to: "agentic-workflow", kind: "part_of" }],
};

let root: string;
let jobDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extraction-spec-"));
  jobDir = join(root, ".okf", "jobs", "job-1");
  await mkdir(jobDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("capture metadata", () => {
  it("reads the video and web arms from their own frontmatter", () => {
    expect(captureKind(videoCapture())).toBe("video");
    expect(captureKind(webCapture())).toBe("web");
    expect(captureKind({ ...videoCapture(), frontmatter: null })).toBeNull();
  });

  it("uses the capture timestamp, never a clock read", () => {
    expect(captureFetchedAt(videoCapture())).toBe(FIXED_ISO);
    expect(captureFetchedAt(webCapture())).toBe(FIXED_ISO);
  });

  it("derives a stable title from the slug when the capture has none", () => {
    expect(captureTitle(videoCapture())).toBe("First talk");
    expect(titleFromSlug("agentic-workflow-engineering")).toBe(
      "Agentic workflow engineering",
    );
    expect(
      captureTitle({
        ...videoCapture(),
        frontmatter: { ...videoCapture().frontmatter, title: "Stored Title" },
      }),
    ).toBe("Stored Title");
  });

  it("builds the source block with a vault-relative raw path", () => {
    const video = sourceFromCapture(videoCapture());
    expect(video).toEqual({
      slug: "first-talk",
      title: "First talk",
      sourceKind: "video",
      rawPath: "raw/first-talk.md",
      fetchedAt: FIXED_ISO,
      youtubeId: "abc123",
      url: "https://youtu.be/abc123",
      published: "2026-01-01",
      duration: 1402,
    });

    const web = sourceFromCapture(webCapture());
    expect(web).toEqual({
      slug: "example-post",
      title: "Example post",
      sourceKind: "web",
      rawPath: "raw/example-post.md",
      fetchedAt: FIXED_ISO,
      url: "https://example.com/post",
      site: "example.com",
      wordCount: 512,
    });
    expect(web.youtubeId).toBeUndefined();
  });
});

describe("transcriptText", () => {
  it("strips the video markers into [H:MM:SS] lines", () => {
    expect(transcriptText(videoCapture())).toBe(
      "[0:00:00] hello there\n[0:23:22] goodbye now",
    );
  });

  it("strips the web heading and paragraph anchors", () => {
    expect(transcriptText(webCapture())).toBe(
      "alpha paragraph\n\nbeta paragraph",
    );
  });
});

describe("extraction records", () => {
  it("wraps the model extraction with the capture source and at", () => {
    const record = toExtractionRecord(EXTRACTION, videoCapture());
    expect(record.slug).toBe("first-talk");
    expect(record.title).toBe("First Talk");
    expect(record.source.sourceKind).toBe("video");
    expect(record.source.rawPath).toBe("raw/first-talk.md");
    expect(record.source.youtubeId).toBe("abc123");
    expect(record.at).toBe(FIXED_ISO);
    expect(record.partial).toBeUndefined();
    expect(record.quotes).toEqual(EXTRACTION.quotes);
  });

  it("round-trips through the job-scoped file", async () => {
    const record = toExtractionRecord(EXTRACTION, videoCapture());
    await writeExtraction(jobDir, record);

    const text = await readFile(
      join(jobDir, "extractions", "first-talk.json"),
      "utf8",
    );
    expect(text.endsWith("\n")).toBe(true);

    const read = await readExtraction(jobDir, "first-talk");
    expect(read).toEqual(record);
  });

  it("returns null for a missing extraction", async () => {
    expect(await readExtraction(jobDir, "absent")).toBeNull();
  });

  it("tolerates a corrupt extraction instead of throwing", async () => {
    await writeTextAtomic(
      extractionPath(jobDir, "first-talk"),
      "{ this is not json",
    );
    expect(await readExtraction(jobDir, "first-talk")).toBeNull();
  });

  it("rejects a record missing a required array or source field", async () => {
    const record = toExtractionRecord(EXTRACTION, videoCapture());
    await writeExtraction(jobDir, record);
    const { tags: _tags, ...withoutTags } = record;
    await writeFile(
      extractionPath(jobDir, "first-talk"),
      JSON.stringify(withoutTags),
      "utf8",
    );
    expect(await readExtraction(jobDir, "first-talk")).toBeNull();

    const { sourceKind: _kind, ...source } = record.source;
    await writeFile(
      extractionPath(jobDir, "first-talk"),
      JSON.stringify({ ...record, source }),
      "utf8",
    );
    expect(await readExtraction(jobDir, "first-talk")).toBeNull();
  });

  it("rejects a slug that could escape the job directory", () => {
    for (const slug of ["../escape", "a/b", "Bad Slug", ".hidden", ""]) {
      expect(() => extractionPath(jobDir, slug)).toThrow();
    }
    expect(extractionPath(jobDir, "first-talk")).toBe(
      join(jobDir, "extractions", "first-talk.json"),
    );
  });

  it("lists usable records in slug order and skips a corrupt one", async () => {
    await writeExtraction(
      jobDir,
      toExtractionRecord(EXTRACTION, videoCapture({ slug: "b-talk" })),
    );
    await writeExtraction(
      jobDir,
      toExtractionRecord(EXTRACTION, videoCapture({ slug: "a-talk" })),
    );
    await writeFile(extractionPath(jobDir, "c-talk"), "{not json", "utf8");

    const records = await listExtractions(jobDir);
    expect(records.map((record) => record.slug)).toEqual(["a-talk", "b-talk"]);
  });

  it("returns an empty list when the job has no extractions directory", async () => {
    expect(await listExtractions(join(root, "nowhere"))).toEqual([]);
  });
});
