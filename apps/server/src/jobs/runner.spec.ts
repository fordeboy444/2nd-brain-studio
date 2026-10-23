import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../http/writeAtomic.js";
import { probeFirstCandidate } from "../ingest/preflight.js";
import { previewJob } from "../ingest/preview.js";
import type { TranscriptCascade } from "../ingest/transcript.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../llm/ollama.js";
import {
  CaptureMismatchError,
  findCaptureByUrl,
  readCapture,
  writeCapture,
} from "./capture.js";
import {
  createJobQueue,
  retryJobRecord,
  retryUnitsFor,
  runJob,
  slugForCandidate,
  type StageDeps,
} from "./runner.js";
import { jobDir, readEvents, readJob, requestCancel, writeJob } from "./store.js";
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

/**
 * Test seam for the S3 prompt-version bump. The real stage reads its own
 * constant, so the observable effect of a bump is a different cache key. This
 * state rewrites the key input in `callCached` for S3 calls only.
 */
const cacheState = vi.hoisted(() => ({ bumpS3: false }));

vi.mock("../llm/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/cache.js")>();
  return {
    ...actual,
    callCached(...args: Parameters<typeof actual.callCached>) {
      const [cache, client, request, schema] = args;
      if (cacheState.bumpS3 && request.stage === "S3") {
        return actual.callCached(
          cache,
          client,
          { ...request, promptVersion: `${request.promptVersion}-bumped` },
          schema,
        );
      }
      return actual.callCached(cache, client, request, schema);
    },
  };
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

/** The raw capture files, without the index S5 writes into the same folder. */
async function rawCaptures(): Promise<string[]> {
  const names = await readdir(join(root, "raw"));
  return names.filter((name) => name !== "index.md");
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
    expect(await rawCaptures()).toEqual(["first-talk.md"]);
    expect(llm.calls).toBe(1);

    const extraction = JSON.parse(
      await readFile(
        join(root, ".okf", "jobs", job.id, "extractions", "first-talk.json"),
        "utf8",
      ),
    );
    expect(extraction.slug).toBe("first-talk");
    expect(
      (await readdir(join(root, "sources"))).filter(
        (name) => name !== "index.md",
      ),
    ).toEqual(["first-talk.md"]);

    // S5 runs after S4, makes no model call, and always leaves a report.
    const jobDir = join(root, ".okf", "jobs", job.id);
    for (const path of [
      "concepts/index.md",
      "entities/index.md",
      "entities/tools/index.md",
      "entities/people/index.md",
      "entities/organizations/index.md",
      "sources/index.md",
      "raw/index.md",
    ]) {
      await expect(readFile(join(root, path), "utf8")).resolves.toContain("#");
    }
    await expect(readFile(join(root, "log.md"), "utf8")).resolves.toContain(
      "Done.",
    );
    const report = JSON.parse(
      await readFile(join(jobDir, "lint-report.json"), "utf8"),
    ) as { exitCode: number };
    expect(report.exitCode).toBe(0);
    const events = await readEvents(jobDir, 0);
    expect(
      events.some(
        (event) =>
          event.type === "stage" &&
          event.data.stage === "S5" &&
          event.data.status === "lint",
      ),
    ).toBe(true);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.stage).toBe("done");
    expect(finished.status).toBe("completed");
    expect(onDisk.skipped).toEqual([]);
  });

  it("completes the job when S2 cannot recover a reply, with the partial page on disk", async () => {
    const deps = makeDeps({
      llm: {
        async chat() {
          return { text: "not json at all", tokensIn: 0, tokensOut: 0 };
        },
      },
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

    expect(finished.status).toBe("completed");
    expect(finished.stage).toBe("done");

    const page = await readFile(join(root, "sources", "first-talk.md"), "utf8");
    expect(page).toContain("partial: true");

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.skipped).toHaveLength(1);
    expect(onDisk.skipped[0]).toMatchObject({
      slug: "first-talk",
      stage: "S2",
      reason: "malformed_json",
    });
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
    expect(await rawCaptures()).toEqual([]);
  });

  it("completes when the first candidate has no captions", async () => {
    // Real preflight: a per-video failure must not be a channel verdict.
    const cascade: TranscriptCascade = {
      async probe() {
        return { ok: false, reason: "no_captions" };
      },
      async fetch() {
        return { ok: false, reason: "no_captions" };
      },
    };
    const second: VideoCandidate = {
      ...VIDEO_A,
      youtubeId: "def456",
      title: "Second Talk",
      url: "https://www.youtube.com/watch?v=def456",
    };
    const deps = makeDeps({
      llm: workingLlm().client,
      async enumerate() {
        return [VIDEO_A, second];
      },
      async preflight(candidates, ctx) {
        await probeFirstCandidate(candidates, cascade, ctx);
      },
      async fetchTranscript(candidate) {
        if (candidate.youtubeId === VIDEO_A.youtubeId) {
          throw new SkipError("no_captions", "no subtitle file");
        }
        return videoCapture(second);
      },
    });

    const job = makeVideoJob();
    await writeJob(root, job);
    const finished = await runJob(job, deps);

    expect(finished.status).toBe("completed");
    const onDisk = await readJob(root, job.id);
    expect(onDisk.skipped).toHaveLength(1);
    expect(onDisk.skipped[0]).toMatchObject({
      slug: "first-talk",
      stage: "S1",
      reason: "no_captions",
    });
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
    expect(await rawCaptures()).toEqual(["first-talk.md"]);
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
    expect((await rawCaptures()).sort()).toEqual([
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

  it("advances a zero-unit stage and fails with no_sources", async () => {
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
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error).toBe("no_sources");
    expect(onDisk.stage).toBe("S1");
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
    expect(await rawCaptures()).toEqual(["example-post.md"]);
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
    expect(await rawCaptures()).toEqual(["fresh-page.md"]);
    const parsed = parseFrontmatter(
      await readFile(join(root, "raw", "fresh-page.md"), "utf8"),
    );
    expect(parsed!.data.url).toBe(url);
    expect(parsed!.data.source_kind).toBe("web");
    expect(parsed!.data.captured_at).toBe(FIXED_ISO);
  });

  it("records a thrown fetchWeb as one S1w skip and fails the job with no_sources", async () => {
    const deps = makeDeps({
      async fetchWeb() {
        throw new Error("socket hang up");
      },
      classifyWebError: () => "fetch_error",
    });
    const job = makeWebJob("https://example.com/broken");
    await writeJob(root, job);

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("no_sources");
    expect(finished.stage).toBe("S1w");
    expect(finished.skipped).toHaveLength(1);
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "fetch_error" });
    expect(await rawCaptures()).toEqual([]);
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

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("no_sources");
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "blocked" });
    expect(classified).toBe(0);
    expect(await rawCaptures()).toEqual([]);
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
    const files = await rawCaptures();
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

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("no_sources");
    expect(finished.skipped).toHaveLength(1);
    expect(finished.skipped[0]).toMatchObject({ stage: "S1w", reason: "empty_transcript" });
    expect(await rawCaptures()).toEqual([]);
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
    expect(await rawCaptures()).toEqual(["third-talk.md"]);
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
    const rawFiles = await rawCaptures();
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

/** The four units the PIPE-07 proof runs in every job. */
const PIPELINE_CANDIDATES: VideoCandidate[] = [
  {
    youtubeId: "vid1",
    title: "Agent Talk",
    url: "https://youtu.be/vid1",
    published: "2026-01-01",
    durationSec: 600,
    language: "en",
  },
  {
    youtubeId: "vid2",
    title: "Workflow Basics",
    url: "https://youtu.be/vid2",
    published: "2026-01-02",
    durationSec: 620,
    language: "en",
  },
  {
    youtubeId: "vid3",
    title: "Tool Roundup",
    url: "https://youtu.be/vid3",
    published: "2026-01-03",
    durationSec: 640,
    language: "en",
  },
  {
    youtubeId: "vid4",
    title: "Source Notes",
    url: "https://youtu.be/vid4",
    published: "2026-01-04",
    durationSec: 660,
    language: "en",
  },
];

const PIPELINE_BODY =
  "First paragraph about the label.\n\nSecond paragraph about the label.";

interface PipelineCall {
  stage: "S2" | "S3" | "S4" | "S6" | "unknown";
  system: string;
  user: string;
  model: string;
  baseUrl: string | undefined;
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
}

function stageOf(system: string): PipelineCall["stage"] {
  if (system.includes("Prompt version: s2-v1.")) return "S2";
  if (system.includes("Prompt version: s3-v2.")) return "S3";
  if (system.includes("Prompt version: s4-v2.")) return "S4";
  if (system.includes("Prompt version: s6-v2.")) return "S6";
  return "unknown";
}

interface RequestLine {
  kind: "concept" | "entity";
  slug: string;
  name?: string;
}

function requestLines(content: string): RequestLine[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RequestLine);
}

/**
 * A stage-aware fake. It answers each prompt with the shape that prompt asks
 * for and records the cache-facing options, so a run can prove which stage
 * called and which model/timeout values it used.
 */
function pipelineLlm(
  options: {
    quotes?: boolean;
    extraConcept?: boolean;
    omitS4?: string;
  } = {},
): {
  calls: PipelineCall[];
  client: LlmClient;
} {
  const calls: PipelineCall[] = [];
  const client: LlmClient = {
    async chat(messages: LlmMessage[], chatOptions: LlmChatOptions) {
      const system = messages[0]?.content ?? "";
      const stage = stageOf(system);
      const user = messages[1]?.content ?? "";
      calls.push({
        stage,
        system,
        user,
        model: chatOptions.model,
        baseUrl: chatOptions.baseUrl,
        timeoutMs: chatOptions.timeoutMs,
        maxRetries: chatOptions.maxRetries,
      });

      if (stage === "S2") {
        const title = /^Title: (.*)$/m.exec(user)?.[1] ?? "Untitled";
        return {
          text: JSON.stringify({
            slug: null,
            title,
            thesis: `Thesis of ${title}.`,
            summary: `Summary of ${title}.`,
            tags: [],
            concepts: [
              { name: "Agentic Workflow", slug: "agentic-workflow", weight: 1 },
              ...(options.extraConcept === true
                ? [{ name: "Beta Topic", slug: "beta", weight: 0.5 }]
                : []),
            ],
            entities: [{ name: "n8n", slug: "n8n", type: "tool", weight: 1 }],
            quotes:
              options.quotes === true
                ? [{ text: "hello", startSec: 0 }]
                : [],
            relations: [],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }

      if (stage === "S3") {
        const requests = requestLines(user);
        if (system.includes("canonicalise")) {
          return {
            text: JSON.stringify({
              labels: requests.map((request) => ({
                kind: request.kind,
                from: request.slug,
                to: request.slug,
                title: request.name ?? request.slug,
                tags: [],
                aliases: [],
              })),
            }),
            tokensIn: 1,
            tokensOut: 1,
          };
        }
        return {
          text: JSON.stringify({
            concept_themes: [],
            tool_themes: [],
            source_clusters: [],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }

      if (stage === "S4") {
        return {
          text: JSON.stringify(
            requestLines(user)
              .filter((request) => request.slug !== options.omitS4)
              .map((request) => ({
                kind: request.kind,
                slug: request.slug,
                body: PIPELINE_BODY,
              })),
          ),
          tokensIn: 1,
          tokensOut: 1,
        };
      }

      if (stage === "S6") {
        return {
          text: JSON.stringify({
            pages: requestLines(user).map((request) => ({
              kind: request.kind,
              slug: request.slug,
              body: PIPELINE_BODY,
              notable: 0.4,
            })),
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }

      throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
    },
  };
  return { calls, client };
}

/** Every page in the vault, keyed by its path relative to the vault root. */
async function vaultPages(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(relPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(root, relPath), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".okf" || entry.name === ".git") continue;
      const next = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
      } else {
        files[next] = await readFile(join(root, next), "utf8");
      }
    }
  }
  await walk("");
  return files;
}

/** The job-scoped artifacts the determinism proof compares. */
async function jobArtifacts(job: JobRecord): Promise<Record<string, string>> {
  const dir = join(root, ".okf", "jobs", job.id);
  const files: Record<string, string> = {};
  const extractions = (
    await readdir(join(dir, "extractions"))
  ).sort();
  for (const name of extractions) {
    files[`extractions/${name}`] = await readFile(
      join(dir, "extractions", name),
      "utf8",
    );
  }
  for (const name of ["manifest.json", "taxonomy.json", "lint-report.json"]) {
    files[name] = await readFile(join(dir, name), "utf8");
  }
  // The log lives at the vault root; S5 rewrites it on every run.
  files["log.md"] = await readFile(join(root, "log.md"), "utf8");
  return files;
}

function expectSameBytes(
  left: Record<string, string>,
  right: Record<string, string>,
): void {
  expect(Object.keys(right).sort()).toEqual(Object.keys(left).sort());
  for (const key of Object.keys(left)) {
    expect(right[key], key).toBe(left[key]);
  }
}

/** One end-to-end job over the four fixed candidates. */
async function runPipeline(
  job: JobRecord,
  client: LlmClient,
  counters: { fetchTranscript: number; fetchWeb: number },
  candidates: VideoCandidate[] = PIPELINE_CANDIDATES,
): Promise<void> {
  await writeJob(root, job);
  const deps = makeDeps({
    llm: client,
    async enumerate() {
      return candidates;
    },
    async fetchTranscript(candidate) {
      counters.fetchTranscript += 1;
      return videoCapture(candidate);
    },
    async fetchWeb() {
      counters.fetchWeb += 1;
      throw new SkipError("fetch_error", "web is not used here");
    },
  });
  await runJob(job, deps);
}

describe("PIPE-07: a repeat run makes no paid call", () => {
  beforeEach(() => {
    cacheState.bumpS3 = false;
  });

  it("reuses the cache, recreates a deleted page byte for byte, and changes nothing", async () => {
    const first = pipelineLlm();
    const firstCounters = { fetchTranscript: 0, fetchWeb: 0 };
    const jobA = makeVideoJob();
    await runPipeline(jobA, first.client, firstCounters);

    expect(firstCounters.fetchTranscript).toBe(4);
    expect(first.calls.map((call) => call.stage).sort()).toEqual([
      "S2",
      "S2",
      "S2",
      "S2",
      "S3",
      "S3",
      "S4",
    ]);
    const pagesA = await vaultPages();
    const artifactsA = await jobArtifacts(jobA);

    // A page missing from the vault is rebuilt from code and cache, not lost.
    await rm(join(root, "concepts", "agentic-workflow.md"));
    await rm(join(root, "sources", "agent-talk.md"));

    const second = pipelineLlm();
    const secondCounters = { fetchTranscript: 0, fetchWeb: 0 };
    const jobB = makeVideoJob();
    await runPipeline(jobB, second.client, secondCounters);

    expect(second.calls).toEqual([]);
    expect(secondCounters).toEqual({ fetchTranscript: 0, fetchWeb: 0 });
    expectSameBytes(pagesA, await vaultPages());
    expectSameBytes(artifactsA, await jobArtifacts(jobB));
  });

  it("changes only the model name, which invalidates every stage cache", async () => {
    const first = pipelineLlm();
    const jobA = makeVideoJob();
    await runPipeline(jobA, first.client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });
    const pagesA = await vaultPages();

    const changed = pipelineLlm();
    const counters = { fetchTranscript: 0, fetchWeb: 0 };
    const jobC = makeVideoJob({
      settings: {
        ...SETTINGS,
        llm: { model: "other-model" },
      },
    });
    await runPipeline(jobC, changed.client, counters);

    // A new model is a new cache key at S2, S3 and S4. No capture is re-read.
    expect(
      changed.calls.every(
        (call) =>
          call.stage === "S2" || call.stage === "S3" || call.stage === "S4",
      ),
    ).toBe(true);
    expect(changed.calls.filter((call) => call.stage === "S2")).toHaveLength(4);
    expect(counters.fetchTranscript).toBe(0);
    expect(counters.fetchWeb).toBe(0);

    // Source-derived pages do not carry the model name.
    const pagesC = await vaultPages();
    expect(pagesC["raw/index.md"]).toBe(pagesA["raw/index.md"]);
    expect(pagesC["entities/index.md"]).toBe(pagesA["entities/index.md"]);
  });

  it("makes new S3 calls when the S3 prompt version changes, and no S2 call", async () => {
    const first = pipelineLlm();
    const jobA = makeVideoJob();
    await runPipeline(jobA, first.client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    // The seam above changes only the S3 cache key, the same observable effect
    // as bumping PROMPT_VERSION_S3 in the stage.
    cacheState.bumpS3 = true;
    const bumped = pipelineLlm();
    const jobD = makeVideoJob();
    await runPipeline(jobD, bumped.client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    expect(bumped.calls.filter((call) => call.stage === "S2")).toHaveLength(0);
    expect(
      bumped.calls.filter((call) => call.stage === "S3").length,
    ).toBeGreaterThan(0);
  });

  it("writes the same bytes when the wall clock moves two days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-18T10:00:00.000Z"));
      const first = pipelineLlm();
      const jobA = makeVideoJob();
      await runPipeline(jobA, first.client, {
        fetchTranscript: 0,
        fetchWeb: 0,
      });
      const pagesA = await vaultPages();
      const artifactsA = await jobArtifacts(jobA);

      vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));
      const second = pipelineLlm();
      const jobB = makeVideoJob();
      await runPipeline(jobB, second.client, {
        fetchTranscript: 0,
        fetchWeb: 0,
      });

      expectSameBytes(pagesA, await vaultPages());
      expectSameBytes(artifactsA, await jobArtifacts(jobB));
    } finally {
      vi.useRealTimers();
    }
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

describe("setup failure", () => {
  it("returns a failed record when vaultDirFor throws before the stage try", async () => {
    const job = makeVideoJob();
    await writeJob(root, job);
    const deps = makeDeps({
      vaultDirFor() {
        throw new Error("vault is not registered");
      },
    });

    const finished = await runJob(job, deps);

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("stage_failed");
  });

  it("persists failed and a done event when a malformed record throws in makeCtx", async () => {
    const job = makeVideoJob();
    // A parseable but malformed record: `filters` is absent, so `makeCtx`
    // cannot read the language. Setup must fail closed, not reject silently.
    // Assign a new object; the shared SETTINGS fixture must stay intact.
    job.settings = {
      ...job.settings,
      filters: undefined as unknown as JobSettings["filters"],
    };
    await writeJob(root, job);

    const finished = await runJob(job, makeDeps());

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("job_invalid");
    // `readJob` validates by design; read the raw file to see the terminal record.
    const onDisk = JSON.parse(
      await readFile(join(jobDir(root, job.id), "job.json"), "utf8"),
    ) as JobRecord;
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error).toBe("job_invalid");
    const events = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    expect(events.find((event) => event.type === "error")?.data.code).toBe("job_invalid");
    expect(events.find((event) => event.type === "done")?.data.status).toBe("failed");
  });
});

describe("cancel", () => {
  it("records a cancel that lands during S0 as cancelled, not failed", async () => {
    const job = makeVideoJob();
    await writeJob(root, job);
    const deps = makeDeps({
      async enumerate() {
        await requestCancel(root, job.id);
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    await runJob(job, deps);

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("cancelled");
    expect(onDisk.error).toBeNull();
    const events = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "done")?.data.status).toBe("cancelled");
  });

  it("honours a cancel flag written while the job sat in the queue, before S0", async () => {
    const job = makeVideoJob();
    // The user cancelled after `writeJob` but before the queue started it:
    // only the on-disk flag knows, and there is no active controller to abort.
    await writeJob(root, { ...job, cancelRequested: true });
    const enumerate = vi.fn(async () => {
      throw new Error("S0 must not run");
    });
    const deps = makeDeps({ enumerate });

    const finished = await runJob(job, deps);

    expect(enumerate).not.toHaveBeenCalled();
    expect(finished.status).toBe("cancelled");
    expect((await readJob(root, job.id)).status).toBe("cancelled");
  });

  it("does not record a failure when the queue aborts the active job", async () => {
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const job = makeVideoJob();
    await writeJob(root, job);
    const deps = makeDeps({
      async enumerate(_url, _options, signal) {
        signalEntered();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const queue = createJobQueue(deps);
    const run = queue.enqueue(job);
    await entered;
    await queue.cancel(root, job.id);
    await run;

    expect((await readJob(root, job.id)).status).toBe("cancelled");
  });

  it("records no skip when an abort lands inside a unit fetch", async () => {
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const job = makeVideoJob();
    await writeJob(root, job);
    const deps = makeDeps({
      async enumerate() {
        return [VIDEO_A];
      },
      async fetchTranscript(_candidate, ctx) {
        signalEntered();
        await new Promise<never>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (ctx.signal.aborted) {
            fail();
            return;
          }
          ctx.signal.addEventListener("abort", fail, { once: true });
        });
      },
    });

    const queue = createJobQueue(deps);
    const run = queue.enqueue(job);
    await entered;
    await queue.cancel(root, job.id);
    await run;

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("cancelled");
    // The abort is not a unit failure: no bogus skip and no progress advance.
    expect(onDisk.skipped).toEqual([]);
    expect(onDisk.progress.done).toBe(0);
  });

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
    expect(await rawCaptures()).toEqual(["first-talk.md"]);
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("cancelled");
    expect(onDisk.stage).toBe("S1");
    const events = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const done = events.find((event) => event.type === "done");
    expect(done?.data.status).toBe("cancelled");
  });
});

describe("retry scope (PIPE-12)", () => {
  it("collects only S2, S3, S4 and S6 entries, deduped and sorted", () => {
    const job = makeVideoJob({
      skipped: [
        { slug: "alpha", stage: "S2", reason: "malformed_json" },
        { slug: "alpha", stage: "S2", reason: "model_error" },
        { slug: "delta", stage: "S3", reason: "model_error" },
        { slug: "gamma", stage: "S4", reason: "model_error" },
        { slug: "some-label", stage: "S6", reason: "model_error" },
        { slug: "beta", stage: "S1", reason: "no_captions" },
      ],
    });

    expect(retryUnitsFor(job, "S2")).toEqual([
      { slug: "alpha", stage: "S2" },
    ]);
    expect(retryUnitsFor(job, "S3")).toEqual([
      { slug: "delta", stage: "S3" },
    ]);
    expect(retryUnitsFor(job, "S4")).toEqual([
      { slug: "gamma", stage: "S4" },
    ]);
    expect(retryUnitsFor(job, "S6")).toEqual([
      { slug: "some-label", stage: "S6" },
    ]);
    // S5 is code-only: a failure there fails the job, so it is not retryable.
    expect(retryUnitsFor(job, "S5")).toEqual([]);
  });

  it("treats an S1-only failure as nothing to retry and keeps the entry", () => {
    const job = makeVideoJob({
      status: "completed",
      stage: "done",
      skipped: [{ slug: "beta", stage: "S1", reason: "no_captions" }],
    });

    expect(retryJobRecord(job)).toEqual({ error: "no_failed" });
    expect(job.skipped).toEqual([
      { slug: "beta", stage: "S1", reason: "no_captions" },
    ]);
    expect(job.retry).toBeUndefined();
    expect(job.status).toBe("completed");
  });

  it("reuses retry units a failed run consumed before it threw", () => {
    const job = makeVideoJob({
      status: "failed",
      stage: "S4",
      skipped: [],
      retry: { units: [{ slug: "gamma", stage: "S4" }] },
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S4" });
    expect(job.status).toBe("queued");
    expect(job.retry?.units).toEqual([{ slug: "gamma", stage: "S4" }]);
    expect(job.skipped).toEqual([]);
  });

  it("resets an S3 failure to the S3 barrier", () => {
    const job = makeVideoJob({
      status: "completed",
      stage: "done",
      skipped: [{ slug: "delta", stage: "S3", reason: "model_error" }],
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S3" });
    expect(job.stage).toBe("S3");
    expect(job.status).toBe("queued");
    expect(job.retry?.units).toEqual([{ slug: "delta", stage: "S3" }]);
    expect(job.skipped).toEqual([]);
  });

  it("records an S6 unit", () => {
    const job = makeVideoJob({
      status: "completed",
      stage: "done",
      skipped: [{ slug: "some-label", stage: "S6", reason: "model_error" }],
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S6" });
    expect(job.retry?.units).toEqual([{ slug: "some-label", stage: "S6" }]);
  });

  it("refuses a queued or running job", () => {
    for (const status of ["queued", "running"] as const) {
      const job = makeVideoJob({
        status,
        skipped: [{ slug: "alpha", stage: "S2", reason: "model_error" }],
      });
      expect(retryJobRecord(job)).toEqual({ error: "running" });
      expect(job.retry).toBeUndefined();
    }
  });

  it("starts at the earliest failed stage and keeps both removed entries out", () => {
    const job = makeVideoJob({
      status: "failed",
      stage: "done",
      error: "stage_failed",
      cancelRequested: true,
      progress: { done: 4, total: 4 },
      skipped: [
        { slug: "alpha", stage: "S2", reason: "malformed_json" },
        { slug: "gamma", stage: "S4", reason: "model_error" },
      ],
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S2" });
    expect(job.retry?.units).toEqual([
      { slug: "alpha", stage: "S2" },
      { slug: "gamma", stage: "S4" },
    ]);
    expect(job.skipped).toEqual([]);
    expect(job.error).toBeNull();
    expect(job.cancelRequested).toBe(false);
    expect(job.progress).toEqual({ done: 0, total: 0 });
  });

  /** A pipeline client that rejects every S2 call for one source title. */
  function failingS2Client(
    failTitle: string,
    options: { quotes?: boolean; omitS4?: string } = {},
  ): {
    calls: PipelineCall[];
    client: LlmClient;
  } {
    const inner = pipelineLlm(options);
    const client: LlmClient = {
      async chat(messages, options) {
        const system = messages[0]?.content ?? "";
        if (stageOf(system) === "S2") {
          const user = messages[1]?.content ?? "";
          const title = /^Title: (.*)$/m.exec(user)?.[1];
          if (title === failTitle) throw new Error("model unavailable");
        }
        return inner.client.chat(messages, options);
      },
    };
    return { calls: inner.calls, client };
  }

  it("retries only the failed S2 unit, and the cache makes the retry free", async () => {
    const counters = { fetchTranscript: 0, fetchWeb: 0 };
    const job = makeVideoJob();
    await runPipeline(job, failingS2Client("Agent talk").client, counters);
    expect(job.skipped.map(({ slug, stage }) => ({ slug, stage }))).toEqual([
      { slug: "agent-talk", stage: "S2" },
    ]);

    // A second job over the same vault seeds the cache for that unit.
    await runPipeline(makeVideoJob(), pipelineLlm().client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S2" });
    expect(job.retry?.units).toEqual([{ slug: "agent-talk", stage: "S2" }]);
    expect(job.skipped).toEqual([]);
    await writeJob(root, job);

    const before = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const lastSeq = before.at(-1)?.seq ?? 0;
    const retry = pipelineLlm();
    await runJob(job, makeDeps({ llm: retry.client }));

    // The retried unit is a cache hit: no S2 call, and the partial page is gone.
    expect(retry.calls.filter((call) => call.stage === "S2")).toEqual([]);
    expect(job.skipped).toEqual([]);
    expect(job.retry).toBeUndefined();

    // A good S2 unit makes no call and no event, so only the failed slug runs.
    const s2Events = (await readEvents(join(root, ".okf", "jobs", job.id), lastSeq))
      .filter(
        (event) =>
          event.type === "unit" &&
          (event.data as { stage?: string }).stage === "S2",
      );
    expect(
      s2Events.map((event) => [
        (event.data as { slug?: string }).slug,
        (event.data as { status?: string }).status,
      ]),
    ).toEqual([["agent-talk", "written"]]);
    const extraction = JSON.parse(
      await readFile(
        join(root, ".okf", "jobs", job.id, "extractions", "agent-talk.json"),
        "utf8",
      ),
    ) as { partial?: boolean; summary: string };
    expect(extraction.partial).toBeUndefined();
    expect(extraction.summary).toBe("Summary of Agent talk.");
  });

  it("returns the unit to skipped[] when the retry fails again", async () => {
    const settings: JobSettings = {
      ...SETTINGS,
      llm: { ...SETTINGS.llm, model: "failing-model" },
    };
    const job = makeVideoJob({ settings });
    await runPipeline(job, failingS2Client("Agent talk").client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    expect(retryJobRecord(job)).toEqual({ stage: "S2" });
    await writeJob(root, job);
    await runJob(job, makeDeps({ llm: failingS2Client("Agent talk").client }));

    expect(job.skipped.map(({ slug, stage }) => ({ slug, stage }))).toEqual([
      { slug: "agent-talk", stage: "S2" },
    ]);
    // A finished retry never keeps its scope: the next run is not narrowed.
    expect(job.retry).toBeUndefined();
  });

  /** A label page with a one-paragraph overview, so S6 selects it. */
  function shortPage(): string {
    return [
      "---",
      "type: concept",
      "title: Short",
      "slug: short",
      "sources: []",
      "tags: []",
      "created: 2026-10-18T10:00:00.000Z",
      "updated: 2026-10-18T10:00:00.000Z",
      "---",
      "# Short",
      "",
      "## Overview",
      "",
      "One paragraph only.",
      "",
    ].join("\n");
  }

  it("retries an S2 failure and an S4 failure in one pass from S2", async () => {
    const job = makeVideoJob();
    await runPipeline(
      job,
      failingS2Client("Agent talk", { omitS4: "n8n" }).client,
      { fetchTranscript: 0, fetchWeb: 0 },
    );
    expect(job.skipped.map(({ slug, stage }) => ({ slug, stage }))).toEqual([
      { slug: "agent-talk", stage: "S2" },
      { slug: "n8n", stage: "S4" },
    ]);

    expect(retryJobRecord(job)).toEqual({ stage: "S2" });
    expect(job.retry?.units).toEqual([
      { slug: "agent-talk", stage: "S2" },
      { slug: "n8n", stage: "S4" },
    ]);
    expect(job.skipped).toEqual([]);
    await writeJob(root, job);

    const retry = pipelineLlm();
    await runJob(job, makeDeps({ llm: retry.client }));

    // Both failed units completed in the same pass, and neither skip survives.
    expect(job.skipped).toEqual([]);
    expect(job.retry).toBeUndefined();
    expect(job.status).toBe("completed");
    expect(
      Object.keys(await vaultPages()).filter(
        (path) => path.startsWith("sources/") && path !== "sources/index.md",
      ),
    ).toHaveLength(4);
  });

  it("rewrites only the recorded S4 label when no earlier stage re-runs", async () => {
    const job = makeVideoJob();
    await runPipeline(job, pipelineLlm().client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    // The first run is complete; inject the failure an earlier run recorded.
    job.skipped.push({ slug: "agentic-workflow", stage: "S4", reason: "model_error" });
    // A deleted page proves the good unit was not re-rendered.
    await rm(join(root, "entities", "tools", "n8n.md"));
    expect(retryJobRecord(job)).toEqual({ stage: "S4" });
    await writeJob(root, job);

    const before = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const lastSeq = before.at(-1)?.seq ?? 0;
    const retry = pipelineLlm();
    await runJob(job, makeDeps({ llm: retry.client }));

    // One S4 call, one request, one written unit: only the failed label.
    expect(retry.calls.map((call) => call.stage)).toEqual(["S4"]);
    expect(requestLines(retry.calls[0]!.user).map((request) => request.slug)).toEqual([
      "agentic-workflow",
    ]);
    const s4Events = (await readEvents(join(root, ".okf", "jobs", job.id), lastSeq))
      .filter(
        (event) =>
          event.type === "unit" &&
          (event.data as { stage?: string }).stage === "S4",
      );
    expect(
      s4Events.map((event) => [
        (event.data as { slug?: string }).slug,
        (event.data as { status?: string }).status,
      ]),
    ).toEqual([["agentic-workflow", "written"]]);
    await expect(
      readFile(join(root, "entities", "tools", "n8n.md"), "utf8"),
    ).rejects.toThrow();
    expect(job.retry).toBeUndefined();
  });

  it("sweeps only the recorded S6 label", async () => {
    const settings: JobSettings = {
      ...SETTINGS,
      sweep: { enabled: true },
    };
    const job = makeVideoJob({ settings });
    await runPipeline(job, pipelineLlm().client, {
      fetchTranscript: 0,
      fetchWeb: 0,
    });

    // Two pages are short enough for S6, but only one failure was recorded.
    const short = shortPage();
    await writeFile(join(root, "concepts", "agentic-workflow.md"), short);
    await writeFile(join(root, "entities", "tools", "n8n.md"), short);
    job.skipped.push({ slug: "agentic-workflow", stage: "S6", reason: "model_error" });
    expect(retryJobRecord(job)).toEqual({ stage: "S6" });
    await writeJob(root, job);

    const before = await readEvents(join(root, ".okf", "jobs", job.id), 0);
    const lastSeq = before.at(-1)?.seq ?? 0;
    const retry = pipelineLlm();
    await runJob(job, makeDeps({ llm: retry.client }));

    expect(retry.calls.map((call) => call.stage)).toEqual(["S6"]);
    expect(requestLines(retry.calls[0]!.user).map((request) => request.slug)).toEqual([
      "agentic-workflow",
    ]);
    const s6Events = (await readEvents(join(root, ".okf", "jobs", job.id), lastSeq))
      .filter(
        (event) =>
          event.type === "unit" &&
          (event.data as { stage?: string }).stage === "S6",
      );
    expect(
      s6Events.map((event) => [
        (event.data as { slug?: string }).slug,
        (event.data as { status?: string }).status,
      ]),
    ).toEqual([["agentic-workflow", "written"]]);
    // The label outside the retry scope keeps its short page untouched.
    expect(await readFile(join(root, "entities", "tools", "n8n.md"), "utf8")).toBe(
      short,
    );
    expect(job.retry).toBeUndefined();
  });

  it("writes a label the retried extraction adds and links it from the new source", async () => {
    const job = makeVideoJob();
    // A deep-dive source keeps a label that only one extraction names.
    const candidates = PIPELINE_CANDIDATES.map((candidate) =>
      candidate.youtubeId === "vid1"
        ? { ...candidate, durationSec: 1800 }
        : candidate,
    );
    await runPipeline(
      job,
      failingS2Client("Agent talk", { quotes: true }).client,
      { fetchTranscript: 0, fetchWeb: 0 },
      candidates,
    );
    const pagesA = await vaultPages();
    expect(pagesA["concepts/beta.md"]).toBeUndefined();

    expect(retryJobRecord(job)).toEqual({ stage: "S2" });
    await writeJob(root, job);

    // The retried extraction adds concept beta, which the first manifest never had.
    const retry = pipelineLlm({ quotes: true, extraConcept: true });
    await runJob(job, makeDeps({ llm: retry.client }));

    const beta = parseFrontmatter(
      await readFile(join(root, "concepts", "beta.md"), "utf8"),
    );
    expect(beta).not.toBeNull();
    expect(beta!.data.type).toBe("concept");
    expect(beta!.data.slug).toBe("beta");
    expect(beta!.data.sources).toEqual(["agent-talk"]);
    expect(beta!.body).toContain("## Sources");
    expect(beta!.body).toContain("../sources/agent-talk.md");

    const alpha = parseFrontmatter(
      await readFile(join(root, "concepts", "agentic-workflow.md"), "utf8"),
    );
    expect(alpha).not.toBeNull();
    expect(alpha!.body).toContain("../sources/agent-talk.md");

    const manifest = JSON.parse(
      await readFile(join(root, ".okf", "jobs", job.id, "manifest.json"), "utf8"),
    ) as { concepts: Array<{ slug: string }> };
    expect(manifest.concepts.map((concept) => concept.slug).sort()).toEqual([
      "agentic-workflow",
      "beta",
    ]);
    expect(job.skipped).toEqual([]);
    expect(job.retry).toBeUndefined();
  });
});
