import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, slugify } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCapture } from "../jobs/capture.js";
import type { UnitContext } from "../jobs/runner.js";
import { createWebFetcher } from "../jobs/stages/web.js";
import {
  countWords,
  extractReadable,
  numberParagraphs,
  WebContentError,
  webSlug,
} from "./web.js";
import type { LookupFn } from "./ssrf.js";

const FIXED_NOW = Date.UTC(2026, 9, 18, 10, 0, 0);
const FIXED_ISO = new Date(FIXED_NOW).toISOString();
const REQUESTED_URL = "https://requested.example/start";
const FINAL_URL = "https://final.example/page";

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

function ctxIn(vaultDir = ""): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: "job_test",
    vaultDir,
    now: () => FIXED_NOW,
  };
}

function articleHtml(words: number, title = "A Readable Page"): string {
  const filler = Array.from({ length: words }, (_, index) => `word${index}`).join(" ");
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article><h1>${title}</h1><p>${filler}</p><p>Second paragraph with a few more words.</p></article>
    <footer>copyright notice</footer>
  </body></html>`;
}

function asFetch(
  fn: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

function proseAnchors(paragraphs: readonly string[]): number[] {
  const anchors: number[] = [];
  for (const block of paragraphs) {
    if (block.startsWith("#")) continue;
    const match = /^\*\*\[#(\d+)\]\*\* /.exec(block);
    if (match?.[1] !== undefined) anchors.push(Number(match[1]));
  }
  return anchors;
}

describe("numberParagraphs", () => {
  it("numbers prose blocks in order and leaves headings unnumbered", () => {
    const paragraphs = numberParagraphs(
      "## Heading\n\nFirst para.\n\n### Sub heading\n\nSecond para.\n\nThird para.",
    );

    expect(paragraphs).toEqual([
      "## Heading",
      "**[#1]** First para.",
      "### Sub heading",
      "**[#2]** Second para.",
      "**[#3]** Third para.",
    ]);
  });

  it("drops empty blocks and never emits a gap in the sequence", () => {
    expect(numberParagraphs("\n\n  \n\nalpha\n\n\n\nbeta\n\n")).toEqual([
      "**[#1]** alpha",
      "**[#2]** beta",
    ]);
  });
});

describe("countWords", () => {
  it("ignores anchor markers and markdown punctuation", () => {
    expect(countWords("**[#1]** one **two** three")).toBe(3);
    expect(countWords("## Heading\n\ntext")).toBe(2);
    expect(countWords("")).toBe(0);
  });
});

describe("extractReadable", () => {
  it("returns the title, anchored prose and a word count", () => {
    const page = extractReadable(articleHtml(250, "A Long Page"), FINAL_URL);

    expect(page.title).toBe("A Long Page");
    expect(page.wordCount).toBeGreaterThanOrEqual(200);
    expect(page.warning).toBeUndefined();

    const anchors = proseAnchors(page.paragraphs);
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchors).toEqual(anchors.map((_, index) => index + 1));
    const firstProse = page.paragraphs.find((block) => block.startsWith("**[#"));
    expect(firstProse).toMatch(/^\*\*\[#1\]\*\* /);
  });

  it("flags a page shorter than 200 words without failing it", () => {
    const page = extractReadable(articleHtml(60), FINAL_URL);

    expect(page.wordCount).toBeLessThan(200);
    expect(page.warning).toBe("short_page");
  });

  it.each([
    ["an empty document", "<html><body></body></html>"],
    ["a document with almost no text", "<html><body><p>hi</p></body></html>"],
  ])("rejects %s as empty_transcript", (_label, html) => {
    expect(() => extractReadable(html, FINAL_URL)).toThrow(WebContentError);
    try {
      extractReadable(html, FINAL_URL);
    } catch (error) {
      expect(error).toMatchObject({ reason: "empty_transcript" });
    }
  });
});

describe("webSlug", () => {
  it("is the title slug plus six hash characters of the requested URL", () => {
    const expected = `${slugify("A Readable Page")}-${createHash("sha256")
      .update(REQUESTED_URL)
      .digest("hex")
      .slice(0, 6)}`;

    expect(webSlug("A Readable Page", REQUESTED_URL)).toBe(expected);
  });

  it("separates two pages that share a title", () => {
    expect(webSlug("Same Title", "https://a.example/1")).not.toBe(
      webSlug("Same Title", "https://a.example/2"),
    );
  });

  it("falls back to the site when the title is empty", () => {
    expect(webSlug("", REQUESTED_URL, "final.example")).toContain("final-example-");
  });
});

describe("createWebFetcher (S1w)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "web-spec-"));
    await mkdir(join(root, "raw"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function redirectingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(
      asFetch(async (input) => {
        if (String(input) === REQUESTED_URL) {
          return new Response(null, { status: 302, headers: { location: FINAL_URL } });
        }
        return new Response(articleHtml(250, "Final Page"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );
  }

  it("writes one immutable capture keyed by the requested URL, not the redirect target", async () => {
    const fetchImpl = redirectingFetch();
    const fetcher = createWebFetcher({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      lookup: publicLookup,
    });

    const capture = await fetcher({ url: REQUESTED_URL }, ctxIn(root));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(capture.site).toBe("final.example");
    expect(capture.title).toBe("Final Page");
    expect(capture.capturedAt).toBe(FIXED_ISO);
    expect(capture.warning).toBeUndefined();
    expect(capture.slug).toBe(
      `${slugify("Final Page")}-${createHash("sha256")
        .update(REQUESTED_URL)
        .digest("hex")
        .slice(0, 6)}`,
    );

    const written = await writeCapture(root, {
      kind: "web",
      slug: capture.slug as string,
      url: REQUESTED_URL,
      site: capture.site,
      title: capture.title,
      capturedAt: capture.capturedAt as string,
      wordCount: capture.wordCount,
      paragraphs: capture.paragraphs,
    });
    expect(written.status).toBe("written");

    const text = await readFile(join(root, "raw", `${capture.slug}.md`), "utf8");
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.data).toMatchObject({
      type: "raw-capture",
      source_kind: "web",
      url: REQUESTED_URL,
      site: "final.example",
      capture_kind: "page",
      immutable: true,
      word_count: capture.wordCount,
    });
    expect(parsed!.data.slug).toBe(capture.slug);
    expect(parsed!.body).toContain("## Extracted text");
    expect(parsed!.body).toContain("**[#1]** ");
    // Exactly one anchor per prose block — the writer must not re-number.
    expect(parsed!.body.match(/\*\*\[#1\]\*\*/g)).toHaveLength(1);

    const second = await writeCapture(root, {
      kind: "web",
      slug: capture.slug as string,
      url: REQUESTED_URL,
      site: capture.site,
      title: capture.title,
      capturedAt: capture.capturedAt as string,
      wordCount: capture.wordCount,
      paragraphs: capture.paragraphs,
    });
    expect(second.status).toBe("skipped");
    expect(await readFile(join(root, "raw", `${capture.slug}.md`), "utf8")).toBe(text);
  });

  it("produces the same slug on a resumed run", async () => {
    const fetcher = createWebFetcher({
      fetch: redirectingFetch() as unknown as typeof globalThis.fetch,
      lookup: publicLookup,
    });

    const first = await fetcher({ url: REQUESTED_URL }, ctxIn(root));
    const second = await fetcher({ url: REQUESTED_URL }, ctxIn(root));

    expect(second.slug).toBe(first.slug);
  });

  it("returns a short-page warning without hiding the capture", async () => {
    const fetcher = createWebFetcher({
      fetch: asFetch(async () =>
        new Response(articleHtml(60, "Tiny Page"), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
      lookup: publicLookup,
    });

    const capture = await fetcher({ url: REQUESTED_URL }, ctxIn(root));

    expect(capture.warning).toBe("short_page");
    expect(capture.paragraphs.length).toBeGreaterThan(0);
  });
});
