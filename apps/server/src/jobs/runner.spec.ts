import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@2nd-brain/okf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTextAtomic } from "../http/writeAtomic.js";
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
      paragraphs: ["alpha", "beta"],
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
  it("runs S0 -> S1 and leaves a throwing LLM stub untouched", async () => {
    const llm = {
      calls: 0,
      async call(): Promise<never> {
        this.calls += 1;
        throw new Error("never called");
      },
    };
    const deps = makeDeps({
      llm,
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

    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("completed");
    expect(onDisk.stage).toBe("done");
    expect(finished.status).toBe("completed");
    expect(llm.calls).toBe(0);
    expect(onDisk.skipped).toEqual([]);
  });

  it("fails the job with preflight_failed before any unit adapter runs", async () => {
    let fetches = 0;
    const deps = makeDeps({
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
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("preflight_failed");
    const onDisk = await readJob(root, job.id);
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error).toBe("preflight_failed");
    expect(await readdir(join(root, "raw"))).toEqual([]);
  });

  it("continues the job when one unit fails, recording the injected reason", async () => {
    const deps = makeDeps({
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
