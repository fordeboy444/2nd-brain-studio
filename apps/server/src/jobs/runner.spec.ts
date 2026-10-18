import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../http/writeAtomic.js";
import { previewJob } from "../ingest/preview.js";
import {
  CaptureMismatchError,
  findCaptureByUrl,
  readCapture,
  writeCapture,
} from "./capture.js";
import {
  createJobQueue,
  runJob,
  slugForCandidate,
  type StageDeps,
} from "./runner.js";
import { readEvents, readJob, requestCancel, writeJob } from "./store.js";
import {
  createJobRecord,
  newJobId,
} from "./store.js";
import {
  SkipError,
  type JobRecord,
  type JobSettings,
  type VideoCandidate,
  type VideoRawCapture,
} from "./types.js";
import { createIngestStageDeps } from "./bootstrap.js";
import { classifyWebError, createWebFetcher } from "./stages/web.js";

/** Captured pino lines, so the redaction scan covers the log surface too. */
const { pinoLines } = vi.hoisted(() => ({ pinoLines: [] as string[] }));
vi.mock("pino", () => {
  const logger = () => ({
    info: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    warn: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    error: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    debug: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    fatal: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    trace: (...args: unknown[]) => pinoLines.push(JSON.stringify(args)),
    child() {
      return this;
    },
  });
  return { default: logger };
});

const SETTINGS: JobSettings = {
  maxVideos: 10,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

const FIXED_NOW = Date.parse("2026-10-18T10:00:00.000Z");
const FIXED_ISO = new Date(FIXED_NOW).toISOString();

let root: string;
let hexCounter = 0x100000;

function nextId(): string {
  hexCounter += 1;
  return newJobId(new Date(2026, 9, 18), () => hexCounter / 0x1000000);
}

function makeVideoJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    ...createJobRecord({
      id: nextId(),
      vaultId: "vault",
      kind: "youtube",
      input: { url: "https://www.youtube.com/@channel" },
      settings: SETTINGS,
      createdAt: "2026-10-18T10:00:00.000Z",
    }),
    ...overrides,
  };
}

function makeWebJob(url: string): JobRecord {
  return createJobRecord({
    id: nextId(),
    vaultId: "vault",
    kind: "web",
    input: { url },
    settings: SETTINGS,
    createdAt: "2026-10-18T10:00:00.000Z",
  });
}

const VIDEO_A: VideoCandidate = {
  youtubeId: "abc123",
  title: "First Talk",
  url: "https://youtu.be/abc123",
  published: "2026-01-01",
  durationSec: 600,
  language: "en",
};

function segments(): { startSec: number; text: string }[] {
  return [
    { startSec: 0, text: "hello" },
    { startSec: 65, text: "world" },
  ];
}

/** The video arm the S1 fetch stage now returns; the runner only writes it. */
function videoCapture(
  candidate: VideoCandidate,
  tier: 1 | 2 | 3 = 1,
  segs: { startSec: number; text: string }[] = segments(),
): VideoRawCapture {
  return {
    kind: "video",
    slug: slugForCandidate(candidate),
    url: candidate.url,
    youtubeId: candidate.youtubeId,
    title: candidate.title,
    published: candidate.published,
    durationSec: candidate.durationSec,
    tier,
    fetchedAt: FIXED_ISO,
    segments: segs,
  };
}

/** A client that answers every S2 call with one valid extraction object. */
function workingLlm(): { calls: number; client: { chat: () => Promise<{ text: string; tokensIn: number; tokensOut: number }> } } {
  const state = {
    calls: 0,
    client: {
      async chat() {
        state.calls += 1;
        return {
          text: JSON.stringify({
            slug: "model-chosen-slug",
            title: "Model Title",
            thesis: "A thesis.",
            summary: "A summary.",
            tags: [],
            concepts: [],
            entities: [],
            quotes: [],
            relations: [],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    },
  };
  return state;
}

function makeDeps(overrides: Partial<StageDeps> = {}): StageDeps {
  return {
    async fetchTranscript() {
      throw new SkipError("fetch_error", "no adapter");
    },
    async fetchWeb() {
      throw new SkipError("fetch_error", "no adapter");
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
    llm: {
      async chat() {
        throw new SkipError("llm_not_configured", "no llm in this spec");
      },
    },
    cacheDirFor: () => join(root, ".okf", "cache", "llm"),
    async writePage(vaultDir, relPath, text) {
      const target = join(vaultDir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runner-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("capture rendering (CONTEXT key mapping)", () => {
  it("writes the exact video frontmatter keys and no title key", async () => {
    const result = await writeCapture(root, {
      kind: "video",
      slug: "first-talk",
      url: VIDEO_A.url,
      youtubeId: VIDEO_A.youtubeId,
      title: VIDEO_A.title,
      published: VIDEO_A.published,
      durationSec: VIDEO_A.durationSec,
      tier: 2,
      fetchedAt: FIXED_ISO,
      segments: segments(),
    });
    expect(result).toEqual({ status: "written" });

    const text = await readFile(join(root, "raw", "first-talk.md"), "utf8");
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.data)).toEqual([
      "type",
      "source_kind",
      "youtube_id",
      "url",
      "slug",
      "published",
      "duration",
      "fetched_at",
      "tier",
      "immutable",
    ]);
    expect(parsed!.data.type).toBe("raw-transcript");
    expect(parsed!.data.source_kind).toBe("video");
    expect(parsed!.data.duration).toBe(600);
    expect(parsed!.data.immutable).toBe(true);
    expect(parsed!.data.title).toBeUndefined();
    // The reference page has one blank line after the closing `---`; the parser
    // drops the newline that closes that line and keeps the blank line.
    expect(parsed!.body).toBe(
      "\n## Transcript\n\n**[0:00:00]** hello\n\n**[0:01:05]** world\n",
    );
  });

  it("omits published and duration when absent", async () => {
    await writeCapture(root, {
      kind: "video",
      slug: "bare",
      url: "https://youtu.be/bare",
      youtubeId: "bare",
      title: "Bare",
      tier: 1,
      fetchedAt: FIXED_ISO,
      segments: [{ startSec: 0, text: "one" }],
    });
    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", "bare.md"), "utf8"),
    );
    expect(Object.keys(parsed!.data)).toEqual([
      "type",
      "source_kind",
      "youtube_id",
      "url",
      "slug",
      "fetched_at",
      "tier",
      "immutable",
    ]);
  });

  it("writes the exact web frontmatter keys", async () => {
    await writeCapture(root, {
      kind: "web",
      slug: "example-post",
      url: "https://example.com/post",
      site: "example.com",
      title: "Example Post",
      capturedAt: FIXED_ISO,
      wordCount: 512,
      // `numberParagraphs` assigns the anchors before the arm reaches the
      // writer; the writer joins these blocks unchanged.
      paragraphs: ["**[#1]** alpha", "**[#2]** beta"],
    });
    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", "example-post.md"), "utf8"),
    );
    expect(Object.keys(parsed!.data)).toEqual([
      "type",
      "source_kind",
      "url",
      "site",
      "slug",
      "captured_at",
      "capture_kind",
      "word_count",
      "immutable",
    ]);
    expect(parsed!.data.type).toBe("raw-capture");
    expect(parsed!.data.capture_kind).toBe("page");
    expect(parsed!.data.immutable).toBe(true);
    expect(parsed!.data.title).toBeUndefined();
    expect(parsed!.body).toBe(
      "\n## Extracted text\n\n**[#1]** alpha\n\n**[#2]** beta\n",
    );
  });

  it("skips an identity-matched capture and never rewrites it", async () => {
    const capture = {
      kind: "video" as const,
      slug: "first-talk",
      url: VIDEO_A.url,
      youtubeId: VIDEO_A.youtubeId,
      title: VIDEO_A.title,
      tier: 1 as const,
      fetchedAt: FIXED_ISO,
      segments: segments(),
    };
    await writeCapture(root, capture);
    const before = await readFile(join(root, "raw", "first-talk.md"), "utf8");

    const second = await writeCapture(root, {
      ...capture,
      tier: 3,
      segments: [{ startSec: 0, text: "different" }],
    });
    expect(second).toEqual({ status: "skipped" });
    expect(await readFile(join(root, "raw", "first-talk.md"), "utf8")).toBe(before);
  });

  it("throws CaptureMismatchError on a differing youtube_id and keeps the bytes", async () => {
    await writeCapture(root, {
      kind: "video",
      slug: "first-talk",
      url: "https://youtu.be/other",
      youtubeId: "other",
      title: "First Talk",
      tier: 1,
      fetchedAt: FIXED_ISO,
      segments: segments(),
    });
    const before = await readFile(join(root, "raw", "first-talk.md"), "utf8");

    await expect(
      writeCapture(root, {
        kind: "video",
        slug: "first-talk",
        url: VIDEO_A.url,
        youtubeId: VIDEO_A.youtubeId,
        title: VIDEO_A.title,
        tier: 1,
        fetchedAt: FIXED_ISO,
        segments: segments(),
      }),
    ).rejects.toBeInstanceOf(CaptureMismatchError);
    expect(await readFile(join(root, "raw", "first-talk.md"), "utf8")).toBe(before);
  });

  it("treats unparseable or empty frontmatter as capture_invalid", async () => {
    await writeTextAtomic(join(root, "raw", "broken.md"), "no frontmatter here\n");
    const read = await readCapture(root, "broken");
    expect(read?.frontmatter).toBeNull();

    await expect(
      writeCapture(root, {
        kind: "video",
        slug: "broken",
        url: "https://youtu.be/broken",
        youtubeId: "broken",
        title: "Broken",
        tier: 1,
        fetchedAt: FIXED_ISO,
        segments: segments(),
      }),
    ).rejects.toMatchObject({ reason: "capture_invalid" });
  });

  it("finds a web capture by its requested URL without network access", async () => {
    await writeCapture(root, {
      kind: "web",
      slug: "example-post",
      url: "https://example.com/post",
      site: "example.com",
      title: "Example Post",
      capturedAt: FIXED_ISO,
      wordCount: 300,
      paragraphs: ["alpha"],
    });
    const found = await findCaptureByUrl(root, "https://example.com/post");
    expect(found?.slug).toBe("example-post");
    expect(await findCaptureByUrl(root, "https://example.com/other")).toBeNull();
  });
});

describe("runJob (PIPE-02, PIPE-10)", () => {
  it("runs S0 -> S1 -> S2 and calls the injected LLM once per capture", async () => {
    const llm = workingLlm();
    const deps = makeDeps({
      llm: llm.client,
      async enumerate() {
        return [VIDEO_A];
      },
      async fetchTranscript() {
        return videoCapture(VIDEO_A);
      },
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    const finished = await runJob(job, deps);

    const enumerated = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "01-enumerate.json"), "utf8"),
    );
    expect(enumerated.count).toBe(1);
    expect(await readdir(join(root, "raw"))).toEqual(["first-talk.md"]);
    expect(llm.calls).toBe(1);

    const extraction = JSON.parse(
      await readFile(
        join(root, ".okf", "jobs", job.id, "extractions", "first-talk.json"),
        "utf8",
      ),
    );
    expect(extraction.slug).toBe("first-talk");
    expect(await readdir(join(root, "sources"))).toEqual(["first-talk.md"]);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.stage).toBe("done");
    expect(finished.status).toBe("completed");
    expect(onDisk.skipped).toEqual([]);
  });

  it("fails the job with preflight_failed before any unit adapter runs", async () => {
    let fetches = 0;
    const llm = workingLlm();
    const deps = makeDeps({
      llm: llm.client,
      async enumerate() {
        return [VIDEO_A];
      },
      async preflight() {
        throw new Error("all transcript tiers failed: blocked");
      },
      async fetchTranscript() {
        fetches += 1;
        return videoCapture(VIDEO_A);
      },
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    const finished = await runJob(job, deps);

    expect(fetches).toBe(0);
    // S2 is never reached: the failure happens before any unit runs.
    expect(llm.calls).toBe(0);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("preflight_failed");
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error).toBe("preflight_failed");
    expect(await readdir(join(root, "raw"))).toEqual([]);
  });

  it("continues the job when one unit fails, recording the injected reason", async () => {
    const deps = makeDeps({
      llm: workingLlm().client,
      async enumerate() {
        return [VIDEO_A, { ...VIDEO_A, youtubeId: "def456", title: "Second Talk" }];
      },
      async fetchTranscript(candidate) {
        if (candidate.youtubeId === "abc123") return videoCapture(candidate);
        throw new Error("blocked by the host");
      },
      classifyVideoError: () => "blocked",
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    await runJob(job, deps);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.skipped).toHaveLength(1);
    expect(onDisk.skipped[0]).toMatchObject({
      slug: "second-talk",
      youtubeId: "def456",
      stage: "S1",
      reason: "blocked",
    });
    expect(await readdir(join(root, "raw"))).toEqual(["first-talk.md"]);
  });

  it("applies the persisted filters in S0 before any unit runs", async () => {
    const fetched: string[] = [];
    const candidate = (
      youtubeId: string,
      title: string,
      published: string,
      durationSec: number,
      language: string,
    ): VideoCandidate => ({
      youtubeId,
      title,
      url: `https://youtu.be/${youtubeId}`,
      published,
      durationSec,
      language,
    });
    const deps = makeDeps({
      async enumerate() {
        return [
          candidate("keep-a", "Keep A", "2026-02-01", 900, "en"),
          candidate("too-old", "Too Old", "2025-01-01", 900, "en"),
          candidate("too-short", "Too Short", "2026-02-02", 30, "en"),
          candidate("wrong-lang", "Wrong Language", "2026-02-03", 900, "de"),
          candidate("keep-b", "Keep B", "2026-02-04", 900, "en"),
        ];
      },
      async fetchTranscript(candidate) {
        fetched.push(candidate.youtubeId);
        return videoCapture(candidate);
      },
    });

    const job = makeVideoJob({
      settings: {
        ...SETTINGS,
        maxVideos: 10,
        filters: {
          publishedAfter: "2026-01-01",
          publishedBefore: "2026-12-31",
          minDurationSec: 60,
          language: "en",
        },
      },
    });
    await writeJob(root, job);
    await runJob(job, deps);

    expect(fetched).toEqual(["keep-a", "keep-b"]);
    const enumerated = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "01-enumerate.json"), "utf8"),
    );
    expect(enumerated.count).toBe(2);
    expect(enumerated.candidates).toHaveLength(2);
    expect((await readJob(root, job.id)).progress.total).toBe(2);
  });

  it("caps S0 at maxVideos after enumeration", async () => {
    const fetched: string[] = [];
    const deps = makeDeps({
      async enumerate(_url, opts) {
        // The scan bound is still maxVideos * 5; the cap applies afterwards.
        expect(opts.maxScan).toBe(15);
        return Array.from({ length: 8 }, (_, index) => ({
          youtubeId: `cap-${String(index)}`,
          title: `Cap ${String(index)}`,
          url: `https://youtu.be/cap-${String(index)}`,
          published: "2026-01-01",
          durationSec: 600,
          language: "en",
        }));
      },
      async fetchTranscript(candidate) {
        fetched.push(candidate.youtubeId);
        return videoCapture(candidate);
      },
    });

    const job = makeVideoJob({
      settings: { ...SETTINGS, maxVideos: 3, filters: {} },
    });
    await writeJob(root, job);
    await runJob(job, deps);

    expect(fetched).toEqual(["cap-0", "cap-1", "cap-2"]);
    const enumerated = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "01-enumerate.json"), "utf8"),
    );
    expect(enumerated.count).toBe(3);
    expect(enumerated.candidates).toHaveLength(3);
    expect((await readJob(root, job.id)).progress.total).toBe(3);
  });

  it("keeps two same-title videos as distinct units the preview counted", async () => {
    const candidates: VideoCandidate[] = [
      { ...VIDEO_A, youtubeId: "abc123", title: "Live", url: "https://youtu.be/abc123" },
      { ...VIDEO_A, youtubeId: "def456", title: "Live", url: "https://youtu.be/def456" },
    ];
    const fetched: string[] = [];
    const deps = makeDeps({
      llm: workingLlm().client,
      async enumerate() {
        return candidates;
      },
      async fetchTranscript(candidate) {
        fetched.push(candidate.youtubeId);
        return videoCapture(candidate);
      },
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    await runJob(job, deps);

    expect(fetched).toEqual(["abc123", "def456"]);
    expect((await readdir(join(root, "raw"))).sort()).toEqual([
      "live-def456.md",
      "live.md",
    ]);
    const onDisk = await readJob(root, job.id);
    expect(onDisk.progress.total).toBe(2);
    expect(onDisk.skipped).toEqual([]);

    // The preview counts both units, so the estimate and the committed work
    // agree on the same allocator.
    const preview = await previewJob(
      { channelUrl: "https://www.youtube.com/@channel", maxVideos: 10 },
      {
        async enumerate() {
          return { candidates, foundAtLeast: false };
        },
      },
    );
    expect(onDisk.progress.total).toBe(preview.selected);
  });

  it("advances a zero-unit stage and completes", async () => {
    const deps = makeDeps({
      async enumerate() {
        return [];
      },
    });
    const job = makeVideoJob();
    await writeJob(root, job);
    await runJob(job, deps);

    const enumerated = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "01-enumerate.json"), "utf8"),
    );
    expect(enumerated.count).toBe(0);
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.stage).toBe("done");
  });

  it("makes zero network calls for a repeat web URL", async () => {
    const url = "https://example.com/post";
    await writeCapture(root, {
      kind: "web",
      slug: "example-post",
      url,
      site: "example.com",
      title: "Example Post",
      capturedAt: FIXED_ISO,
      wordCount: 300,
      paragraphs: ["alpha"],
    });

    let fetches = 0;
    const deps = makeDeps({
      async fetchWeb() {
        fetches += 1;
        return {
          site: "example.com",
          title: "Example Post",
          paragraphs: ["fresh"],
          wordCount: 1,
        };
      },
    });
    const job = makeWebJob(url);
    await writeJob(root, job);
    await runJob(job, deps);

    expect(fetches).toBe(0);
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(await readdir(join(root, "raw"))).toEqual(["example-post.md"]);
    const events = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const skip = events.find(
      (event) => event.type === "unit" && event.data.status === "skipped",
    );
    expect(skip?.data.detail).toBe("capture present");
  });

  it("completes a web job with a fake fetchWeb and one raw file", async () => {
    const url = "https://example.com/fresh";
    const deps = makeDeps({
      async fetchWeb() {
        return {
          site: "example.com",
          title: "Fresh Page",
          paragraphs: ["**[#1]** alpha"],
          wordCount: 2,
        };
      },
    });
    const job = makeWebJob(url);
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    expect(finished.stage).toBe("done");
    expect(await readdir(join(root, "raw"))).toEqual(["fresh-page.md"]);
    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", "fresh-page.md"), "utf8"),
    );
    expect(parsed!.data.url).toBe(url);
    expect(parsed!.data.source_kind).toBe("web");
    expect(parsed!.data.captured_at).toBe(FIXED_ISO);
  });

  it("records a thrown fetchWeb as one S1w skip and never fails the job", async () => {
    const deps = makeDeps({
      async fetchWeb() {
        throw new Error("socket hang up");
      },
      classifyWebError: () => "fetch_error",
    });
    const job = makeWebJob("https://example.com/broken");
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    expect(finished.stage).toBe("done");
    expect(finished.skipped).toHaveLength(1);
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "fetch_error" });
    expect(await readdir(join(root, "raw"))).toEqual([]);
  });

  it("keeps a tagged web SkipError and never calls the web classifier", async () => {
    let classified = 0;
    const deps = makeDeps({
      async fetchWeb() {
        throw new SkipError("blocked", "sign in wall");
      },
      classifyWebError: () => {
        classified += 1;
        return "fetch_error";
      },
    });
    const job = makeWebJob("https://example.com/locked");
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "blocked" });
    expect(classified).toBe(0);
    expect(await readdir(join(root, "raw"))).toEqual([]);
  });

  it("runs the real createWebFetcher through runJob with a fake fetch and lookup", async () => {
    const url = "https://example.com/real";
    const words = Array.from({ length: 220 }, (_, index) => `token${index}`).join(" ");
    const html = `<!doctype html><html><head><title>Real Adapter</title></head><body>
      <article><h1>Real Adapter</h1><p>${words}</p><p>Second block.</p></article>
    </body></html>`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const deps = makeDeps({
      fetchWeb: createWebFetcher({
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    });
    const job = makeWebJob(url);
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    const files = await readdir(join(root, "raw"));
    expect(files).toHaveLength(1);
    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", files[0] as string), "utf8"),
    );
    expect(parsed!.data.url).toBe(url);
    expect(parsed!.data.site).toBe("example.com");
    expect(parsed!.body).toContain("**[#1]** ");
  });

  it("skips an unreadable page as empty_transcript through the real classifier", async () => {
    const deps = makeDeps({
      fetchWeb: createWebFetcher({
        fetch: (async () =>
          new Response("<html><body></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })) as unknown as typeof globalThis.fetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
      classifyWebError,
    });
    const job = makeWebJob("https://example.com/empty");
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    expect(finished.skipped).toHaveLength(1);
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "empty_transcript" });
    expect(await readdir(join(root, "raw"))).toEqual([]);
  });

  it("skips a matching video capture on a second run with zero adapter calls", async () => {
    let calls = 0;
    const deps = makeDeps({
      async enumerate() {
        return [VIDEO_A];
      },
      async fetchTranscript() {
        calls += 1;
        return videoCapture(VIDEO_A);
      },
    });

    const first = makeVideoJob();
    await writeJob(root, first);
    await runJob(first, deps);
    expect(calls).toBe(1);

    const second = makeVideoJob();
    await writeJob(root, second);
    await runJob(second, deps);
    expect(calls).toBe(1);
    expect((await readJob(root, second.id)).status).toBe("completed");
  });

  it("keeps a tagged reason and never calls the web classifier for a video unit", async () => {
    let webCalls = 0;
    const deps = makeDeps({
      llm: workingLlm().client,
      async enumerate() {
        return [
          VIDEO_A,
          { ...VIDEO_A, youtubeId: "def456", title: "Second Talk" },
          { ...VIDEO_A, youtubeId: "ghi789", title: "Third Talk" },
        ];
      },
      async fetchTranscript(candidate) {
        if (candidate.youtubeId === "abc123") {
          throw new SkipError("blocked", "sign in wall");
        }
        if (candidate.youtubeId === "def456") throw new Error("socket hang up");
        return videoCapture(candidate);
      },
      classifyVideoError: () => "timeout",
      classifyWebError: () => {
        webCalls += 1;
        return "capture_invalid";
      },
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    await runJob(job, deps);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.skipped.map((skipped) => skipped.reason)).toEqual([
      "blocked",
      "timeout",
    ]);
    expect(onDisk.skipped[0]?.detail).toBe("sign in wall");
    expect(webCalls).toBe(0);
    expect(await readdir(join(root, "raw"))).toEqual(["third-talk.md"]);
  });

  it("never writes the Supadata key to job state, events, raw captures or pino lines", async () => {
    const KEY = "supadata-test-key-do-not-log";
    const first: VideoCandidate = {
      youtubeId: "aaa111bbb22",
      title: "First Talk",
      url: "https://youtu.be/aaa111bbb22",
      language: "en",
    };
    const second: VideoCandidate = {
      youtubeId: "ccc333ddd44",
      title: "Second Talk",
      url: "https://youtu.be/ccc333ddd44",
      language: "en",
    };

    const runYtDlp = async (args: readonly string[]) => {
      if (args[args.length - 1] === first.url) {
        const template = args[args.indexOf("--output") + 1];
        if (template !== undefined) {
          await writeFile(
            join(dirname(template), `${first.youtubeId}.json3`),
            JSON.stringify({
              events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello" }] }],
            }),
          );
        }
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, isCanceled: false };
    };
    const runPython = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: no transcript",
      timedOut: false,
      isCanceled: false,
    });
    const fetch = async () => {
      // A hostile upstream echoing the credential back must not reach disk.
      throw new Error(`upstream rejected x-api-key=${KEY}`);
    };

    const deps: StageDeps = {
      ...createIngestStageDeps({
        runYtDlp,
        runPython,
        fetch: fetch as unknown as typeof globalThis.fetch,
        supadataKey: KEY,
      }),
      llm: workingLlm().client,
      cacheDirFor: () => join(root, ".okf", "cache", "llm"),
      async enumerate() {
        return [first, second];
      },
      vaultDirFor: () => root,
      now: () => FIXED_NOW,
      cookiePath: () => undefined,
    };

    const job = makeVideoJob();
    await writeJob(root, job);
    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    expect(finished.skipped).toHaveLength(1);
    expect(finished.skipped[0]).toMatchObject({
      youtubeId: second.youtubeId,
      reason: "fetch_error",
    });
    expect(finished.skipped[0]?.detail).not.toContain(KEY);
    expect(finished.skipped[0]?.detail).toContain("[redacted]");

    const artifacts = new Map<string, string>();
    const jobDir = join(root, ".okf", "jobs", job.id);
    artifacts.set("job.json", await readFile(join(jobDir, "job.json"), "utf8"));
    artifacts.set("events.ndjson", await readFile(join(jobDir, "events.ndjson"), "utf8"));
    const rawFiles = await readdir(join(root, "raw"));
    for (const name of rawFiles) {
      artifacts.set(`raw/${name}`, await readFile(join(root, "raw", name), "utf8"));
    }
    artifacts.set("pino", pinoLines.join("\n"));

    for (const [name, text] of artifacts) {
      expect(text, name).not.toContain(KEY);
    }
    expect(rawFiles).toEqual(["first-talk.md"]);
  });
});

describe("one-job FIFO", () => {
  it("starts the second job only after the first is terminal", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const deps = makeDeps({
      async enumerate() {
        return [VIDEO_A];
      },
      async fetchTranscript() {
        entered();
        await gate;
        return videoCapture(VIDEO_A);
      },
    });

    const queue = createJobQueue(deps);
    const first = makeVideoJob();
    const second = makeVideoJob({
      createdAt: "2026-10-18T10:01:00.000Z",
      input: { url: "https://www.youtube.com/@other" },
    });
    await writeJob(root, first);
    await writeJob(root, second);

    const firstRun = queue.enqueue(first);
    await enteredP;
    const secondRun = queue.enqueue(second);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue.started).toEqual([first.id]);
    expect((await readJob(root, second.id)).status).toBe("queued");

    release();
    await Promise.all([firstRun, secondRun]);

    expect(queue.started).toEqual([first.id, second.id]);
    expect((await readJob(root, first.id)).status).toBe("completed");
    expect((await readJob(root, second.id)).status).toBe("completed");
    expect(queue.size).toBe(0);
  });
});

describe("cancel", () => {
  it("stops between units, keeps the first capture and never calls the second adapter", async () => {
    let secondCalled = false;
    let job: JobRecord = makeVideoJob();
    const deps = makeDeps({
      async enumerate() {
        return [VIDEO_A, { ...VIDEO_A, youtubeId: "def456", title: "Second Talk" }];
      },
      async fetchTranscript(candidate) {
        if (candidate.youtubeId === "def456") {
          secondCalled = true;
          return videoCapture(candidate);
        }
        // The flag lands while unit 1 runs; the runner must read it from disk
        // before unit 2 rather than trusting its in-memory copy.
        await requestCancel(root, job.id);
        return videoCapture(candidate);
      },
    });

    job = makeVideoJob();
    await writeJob(root, job);
    await runJob(job, deps);

    expect(secondCalled).toBe(false);
    expect(await readdir(join(root, "raw"))).toEqual(["first-talk.md"]);
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("cancelled");
    expect(onDisk.stage).toBe("S1");
    const events = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const done = events.find((event) => event.type === "done");
    expect(done?.data.status).toBe("cancelled");
  });
});
