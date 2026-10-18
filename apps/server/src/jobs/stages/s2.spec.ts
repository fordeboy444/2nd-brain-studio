import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../http/writeAtomic.js";
import type { LlmClient, LlmChatOptions } from "../../llm/ollama.js";
import { writeCapture } from "../capture.js";
import { readExtraction } from "../extraction.js";
import { createJobRecord, jobDir, newJobId, writeJob } from "../store.js";
import type { JobRecord, JobSettings } from "../types.js";
import type { UnitContext } from "../runner.js";
import { createS2Stage } from "./s2.js";

/**
 * The read-once proof needs a count of `readCapture` calls, not a guess from
 * the filesystem. The mock forwards everything else (notably `writeCapture`).
 */
const captureReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture.js")>();
  return {
    ...actual,
    async readCapture(vaultDir: string, slug: string) {
      captureReads.count += 1;
      return actual.readCapture(vaultDir, slug);
    },
  };
});

const FIXED_ISO = "2026-10-18T10:00:00.000Z";
const FIXED_NOW = Date.parse(FIXED_ISO);

const SETTINGS: JobSettings = {
  maxVideos: 5,
  filters: { language: "en" },
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

/** A reply the normalising extraction schema accepts. */
const VALID_REPLY = JSON.stringify({
  slug: "model-chosen-slug",
  title: "Model Title",
  thesis: "A thesis.",
  summary: "A summary.",
  tags: ["agents"],
  concepts: [],
  entities: [],
  quotes: [],
  relations: [],
});

interface FakeLlm {
  calls: number;
  client: LlmClient;
}

/**
 * A fake client that honours the one contract the real client owns: when the
 * caller asks for a raw-reply path, the exact reply text is on disk before
 * `chat` returns. S2 is wrong if it never asks for a path or asks for the wrong
 * one, so the fake has to write it rather than ignore the option.
 */
function fakeLlm(reply: string | (() => string)): FakeLlm {
  const state: FakeLlm = {
    calls: 0,
    client: {
      async chat(_messages, options: LlmChatOptions) {
        state.calls += 1;
        const text = typeof reply === "function" ? reply() : reply;
        if (options.rawPath !== undefined) {
          await writeTextAtomic(options.rawPath, text);
        }
        return { text, tokensIn: 1, tokensOut: 1 };
      },
    },
  };
  return state;
}

function makeJob(random: number): JobRecord {
  return createJobRecord({
    id: newJobId(new Date(2026, 9, 18), () => random),
    vaultId: "vault",
    kind: "youtube",
    input: { url: "https://www.youtube.com/@x/videos" },
    settings: SETTINGS,
    createdAt: FIXED_ISO,
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "s2-spec-"));
  await mkdir(join(root, "raw"), { recursive: true });
  captureReads.count = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeDeps(llm: LlmClient): Parameters<typeof createS2Stage>[0] {
  return {
    async fetchTranscript() {
      throw new Error("not used by S2");
    },
    async fetchWeb() {
      throw new Error("not used by S2");
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

function ctxFor(job: JobRecord): UnitContext {
  return {
    signal: new AbortController().signal,
    language: "en",
    jobId: job.id,
    vaultDir: root,
    now: () => FIXED_NOW,
  };
}

async function runS2(job: JobRecord, llm: LlmClient): Promise<boolean> {
  await writeJob(root, job);
  const dir = jobDir(root, job.id);
  const persist = async (): Promise<void> => {
    await writeJob(root, job);
  };
  return createS2Stage(makeDeps(llm))(job, ctxFor(job), dir, persist);
}

async function writeVideo(slug: string, title: string): Promise<void> {
  await writeCapture(root, {
    kind: "video",
    slug,
    url: `https://youtu.be/${slug}`,
    youtubeId: slug,
    title,
    tier: 1,
    fetchedAt: FIXED_ISO,
    segments: [
      { startSec: 0, text: "hello there" },
      { startSec: 1402, text: "goodbye now" },
    ],
  });
}

async function writeWeb(slug: string, title: string): Promise<void> {
  await writeCapture(root, {
    kind: "web",
    slug,
    url: `https://example.com/${slug}`,
    site: "example.com",
    title,
    capturedAt: FIXED_ISO,
    wordCount: 4,
    paragraphs: ["alpha paragraph", "beta paragraph"],
  });
}

/** A schema-valid reply carrying the given quotes. */
function replyWith(quotes: Array<{ text: string; startSec?: number }>): string {
  return JSON.stringify({
    slug: "model-chosen-slug",
    title: "Model Title",
    thesis: "A thesis.",
    summary: "A summary.",
    tags: ["agents"],
    concepts: [],
    entities: [],
    quotes,
    relations: [],
  });
}

describe("S2 stage", () => {
  it("calls the model once per capture and writes one extraction and one page each", async () => {
    await writeVideo("first-talk", "First Talk");
    await writeVideo("second-talk", "Second Talk");

    const llm = fakeLlm(VALID_REPLY);
    const job = makeJob(0.5);
    await runS2(job, llm.client);

    expect(llm.calls).toBe(2);

    const dir = jobDir(root, job.id);
    expect(await readdir(join(dir, "extractions"))).toEqual([
      "first-talk.json",
      "second-talk.json",
    ]);
    expect(await readdir(join(root, "sources"))).toEqual([
      "first-talk.md",
      "second-talk.md",
    ]);

    const first = await readExtraction(dir, "first-talk");
    expect(first?.slug).toBe("first-talk");
    expect(first?.source.rawPath).toBe("raw/first-talk.md");
    expect(first?.at).toBe(FIXED_ISO);
    expect(first?.partial).toBeUndefined();
  });

  it("makes zero calls on a second job over the same vault and writes identical bytes", async () => {
    await writeVideo("first-talk", "First Talk");

    const firstJob = makeJob(0.5);
    const firstLlm = fakeLlm(VALID_REPLY);
    await runS2(firstJob, firstLlm.client);
    expect(firstLlm.calls).toBe(1);

    const secondJob = makeJob(0.75);
    const secondLlm = fakeLlm(VALID_REPLY);
    await runS2(secondJob, secondLlm.client);
    expect(secondLlm.calls).toBe(0);

    const firstBytes = await readFile(
      join(jobDir(root, firstJob.id), "extractions", "first-talk.json"),
      "utf8",
    );
    const secondBytes = await readFile(
      join(jobDir(root, secondJob.id), "extractions", "first-talk.json"),
      "utf8",
    );
    expect(secondBytes).toBe(firstBytes);

    // A cache hit still renders the page.
    expect(await readdir(join(root, "sources"))).toEqual(["first-talk.md"]);
  });

  it("leaves every raw reply on disk when the parse cannot be recovered", async () => {
    await writeVideo("first-talk", "First Talk");

    const badReply = "not json at all — this is the exact model reply";
    const llm = fakeLlm(badReply);
    const job = makeJob(0.5);
    await runS2(job, llm.client);

    // The ladder is three attempts: the raw call and two repairs.
    expect(llm.calls).toBe(3);
    const dir = jobDir(root, job.id);
    for (const attempt of [1, 2, 3]) {
      expect(
        await readFile(join(dir, "llm", `S2-first-talk-${attempt}.txt`), "utf8"),
      ).toBe(badReply);
    }

    // The unit still leaves a partial record the raw index can build from.
    const record = await readExtraction(dir, "first-talk");
    expect(record?.partial).toBe(true);
    expect(record?.source.rawPath).toBe("raw/first-talk.md");
  });
});

describe("S2 extraction contract", () => {
  it("reads each raw capture exactly once, even at 300 segments", async () => {
    const segments = Array.from({ length: 300 }, (_, index) => ({
      startSec: index * 5,
      text: `segment number ${index}`,
    }));
    await writeCapture(root, {
      kind: "video",
      slug: "long-talk",
      url: "https://youtu.be/long-talk",
      youtubeId: "long-talk",
      title: "Long Talk",
      tier: 1,
      fetchedAt: FIXED_ISO,
      segments,
    });

    const job = makeJob(0.5);
    await runS2(job, fakeLlm(VALID_REPLY).client);

    expect(captureReads.count).toBe(1);
  });

  it("keeps a verbatim quote and drops a paraphrased one", async () => {
    await writeVideo("first-talk", "First Talk");

    const job = makeJob(0.5);
    await runS2(
      job,
      fakeLlm(
        replyWith([
          { text: "hello there", startSec: 0 },
          { text: "completely different topic", startSec: 0 },
        ]),
      ).client,
    );

    const record = await readExtraction(jobDir(root, job.id), "first-talk");
    expect(record?.quotes).toEqual([{ text: "hello there", startSec: 0 }]);
  });

  it("stores no timestamp on a web quote and no youtube_id in its source", async () => {
    await writeWeb("example-post", "Example Post");

    const job = makeJob(0.5);
    await runS2(
      job,
      fakeLlm(
        replyWith([
          { text: "alpha paragraph", startSec: 0 },
          { text: "totally invented content", startSec: 0 },
        ]),
      ).client,
    );

    const dir = jobDir(root, job.id);
    const record = await readExtraction(dir, "example-post");
    expect(record?.quotes).toEqual([{ text: "alpha paragraph" }]);
    expect(record?.quotes[0]).not.toHaveProperty("startSec");
    expect(record?.source.sourceKind).toBe("web");
    expect(record?.source).not.toHaveProperty("youtubeId");

    const page = await readFile(join(root, "sources", "example-post.md"), "utf8");
    expect(page).not.toContain("youtube_id");
  });

  it("keys the file on the capture slug when the model answers with another", async () => {
    await writeVideo("first-talk", "First Talk");

    const job = makeJob(0.5);
    await runS2(job, fakeLlm(VALID_REPLY).client);

    const dir = jobDir(root, job.id);
    expect(await readdir(join(dir, "extractions"))).toEqual(["first-talk.json"]);
    expect((await readExtraction(dir, "first-talk"))?.slug).toBe("first-talk");
  });

  it("stores no transcript body and no producing tier in the extraction file", async () => {
    await writeVideo("first-talk", "First Talk");

    const job = makeJob(0.5);
    await runS2(job, fakeLlm(VALID_REPLY).client);

    const raw = await readFile(
      join(jobDir(root, job.id), "extractions", "first-talk.json"),
      "utf8",
    );
    expect(raw).not.toContain("goodbye now");
    expect(raw).not.toMatch(/"transcript"\s*:/);
    expect(raw).not.toMatch(/"body"\s*:/);
    expect(raw).not.toMatch(/"tier"\s*:/);
  });
});
