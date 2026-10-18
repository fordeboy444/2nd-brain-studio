import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@2nd-brain/okf";
import type { ExtractionSource } from "./extraction.js";
import {
  renderSourcePage,
  renderSourcesSection,
  sourceFrontmatter,
  sourcesBullet,
  type SourcePageInput,
} from "./pages.js";

const FIXED_ISO = "2026-10-18T10:00:00.000Z";

const VIDEO_SOURCE: ExtractionSource = {
  slug: "first-talk",
  title: "First Talk",
  sourceKind: "video",
  youtubeId: "abc123",
  url: "https://youtu.be/abc123",
  published: "2026-01-01",
  duration: 1402,
  rawPath: "raw/first-talk.md",
  fetchedAt: FIXED_ISO,
};

const WEB_SOURCE: ExtractionSource = {
  slug: "example-post",
  title: "Example Post",
  sourceKind: "web",
  url: "https://example.com/post",
  site: "example.com",
  wordCount: 512,
  rawPath: "raw/example-post.md",
  fetchedAt: FIXED_ISO,
};

function videoInput(overrides: Partial<SourcePageInput> = {}): SourcePageInput {
  return {
    slug: "first-talk",
    title: "First Talk",
    kind: "video",
    thesis: "The talk argues one thing.",
    summary: "A summary of the talk.",
    tags: ["agents", "workflow"],
    concepts: [{ name: "Agentic Workflow", slug: "agentic-workflow" }],
    entities: [{ name: "n8n", slug: "n8n", type: "tool" }],
    quotes: [{ text: "hello there", startSec: 0 }],
    source: VIDEO_SOURCE,
    created: FIXED_ISO,
    updated: FIXED_ISO,
    ...overrides,
  };
}

function webInput(overrides: Partial<SourcePageInput> = {}): SourcePageInput {
  return {
    slug: "example-post",
    title: "Example Post",
    kind: "web",
    thesis: "The page argues one thing.",
    summary: "A summary of the page.",
    tags: ["web"],
    concepts: [{ name: "Readability", slug: "readability" }],
    entities: [{ name: "jsdom", slug: "jsdom", type: "tool" }],
    quotes: [{ text: "alpha paragraph" }],
    source: WEB_SOURCE,
    created: FIXED_ISO,
    updated: FIXED_ISO,
    ...overrides,
  };
}

describe("sourceFrontmatter", () => {
  it("emits the CONTEXT key order for a video", () => {
    const data = sourceFrontmatter(videoInput());
    expect(Object.keys(data)).toEqual([
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
    expect(data.type).toBe("source");
    expect(data.source_kind).toBe("video");
    expect(data.description).toBe("The talk argues one thing.");
    expect(data.raw).toBe("../raw/first-talk.md");
    expect(data.created).toBe(FIXED_ISO);
    expect(data.updated).toBe(FIXED_ISO);
  });

  it("renders 1402 seconds as exactly 0:23:22", () => {
    expect(sourceFrontmatter(videoInput()).duration).toBe("0:23:22");
  });

  it("omits duration when it is missing or not a whole non-negative count", () => {
    for (const duration of [undefined, -1, 1402.5, Number.NaN, Infinity]) {
      const data = sourceFrontmatter(
        videoInput({ source: { ...VIDEO_SOURCE, duration } }),
      );
      expect("duration" in data, String(duration)).toBe(false);
    }
  });

  it("omits published when the capture has none", () => {
    const data = sourceFrontmatter(
      videoInput({ source: { ...VIDEO_SOURCE, published: undefined } }),
    );
    expect("published" in data).toBe(false);
    expect(Object.keys(data)).not.toContain("published");
  });

  it("carries url and no youtube_id for a web source", () => {
    const data = sourceFrontmatter(webInput());
    expect(Object.keys(data)).toEqual([
      "type",
      "source_kind",
      "url",
      "slug",
      "title",
      "description",
      "raw",
      "tags",
      "created",
      "updated",
    ]);
    expect(data.source_kind).toBe("web");
    expect(data.url).toBe("https://example.com/post");
    expect("youtube_id" in data).toBe(false);
  });

  it("marks a partial page last and uses the capture title as description", () => {
    const data = sourceFrontmatter(
      videoInput({ thesis: "", summary: "", partial: true }),
    );
    expect(data.partial).toBe(true);
    expect(data.description).toBe("First Talk");
    expect(Object.keys(data).at(-1)).toBe("partial");
  });
});

describe("sourcesBullet", () => {
  it("renders the video grammar with a formatted timestamp", () => {
    expect(
      sourcesBullet("First Talk", "first-talk", {
        text: "hello there",
        startSec: 65,
      }),
    ).toBe('- [First Talk](../sources/first-talk.md) - "[0:01:05] hello there"');
  });

  it("renders the web grammar with no timestamp", () => {
    expect(
      sourcesBullet("Example Post", "example-post", { text: "alpha paragraph" }),
    ).toBe('- [Example Post](../sources/example-post.md) - "alpha paragraph"');
  });

  it("returns no section for an empty bullet list", () => {
    expect(renderSourcesSection([])).toBe("");
    expect(renderSourcesSection(["- one"])).toBe("## Sources\n\n- one\n");
  });
});

describe("renderSourcePage", () => {
  it("renders frontmatter, summary and the fixed sections in order", () => {
    const text = renderSourcePage(videoInput());
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.data.type).toBe("source");
    expect(parsed!.data.duration).toBe("0:23:22");

    const body = parsed!.body;
    expect(body.startsWith("\n# First Talk\n")).toBe(true);
    const summaryAt = body.indexOf("A summary of the talk.");
    const conceptsAt = body.indexOf("## Concepts covered");
    const entitiesAt = body.indexOf("## Entities");
    const momentsAt = body.indexOf("## Key moments");
    expect(summaryAt).toBeGreaterThan(-1);
    expect(conceptsAt).toBeGreaterThan(summaryAt);
    expect(entitiesAt).toBeGreaterThan(conceptsAt);
    expect(momentsAt).toBeGreaterThan(entitiesAt);
    expect(body).toContain("- [Agentic Workflow](../concepts/agentic-workflow.md)");
    expect(body).toContain("- [n8n](../entities/tool/n8n.md)");
    expect(body).toContain("- **[0:00:00]** hello there");
    // A source page has no `## Sources` section.
    expect(body).not.toContain("## Sources");
  });

  it("renders no key moments for a web page and no timestamp on its quote", () => {
    const text = renderSourcePage(webInput());
    expect(text).not.toContain("## Key moments");
    expect(text).not.toContain("[0:00:00]");
    expect(text).not.toContain("## Sources");
    expect(text).toContain("A summary of the page.");
    expect(text).toContain("## Concepts covered");
    expect(text).toContain("## Entities");
  });

  it("writes a partial page without a claimed thesis, summary or quote", () => {
    const text = renderSourcePage(
      videoInput({
        thesis: "",
        summary: "",
        concepts: [],
        entities: [],
        quotes: [],
        partial: true,
      }),
    );
    const parsed = parseFrontmatter(text);
    expect(parsed!.data.partial).toBe(true);
    expect(parsed!.data.description).toBe("First Talk");
    expect(parsed!.body).not.toContain("## Concepts covered");
    expect(parsed!.body).not.toContain("## Entities");
    expect(parsed!.body).not.toContain("## Key moments");
    expect(parsed!.body).not.toContain("The talk argues one thing.");
    expect(parsed!.body).not.toContain("A summary of the talk.");
  });

  it("treats a whitespace-only summary as absent", () => {
    expect(renderSourcePage(videoInput({ summary: "   " }))).toBe(
      renderSourcePage(videoInput({ summary: "" })),
    );
    expect(renderSourcePage(videoInput({ summary: "   " }))).not.toContain("   \n");
  });
});
