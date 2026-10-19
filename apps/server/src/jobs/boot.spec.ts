import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChatOptions, LlmClient, LlmMessage } from "../llm/ollama.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../llm/ollama.js";
import { writeCapture } from "./capture.js";
import type { JobRecord, JobSettings } from "./types.js";

/**
 * Boot resume: every registered vault is scanned, `queued` and `running` jobs
 * are re-enqueued oldest first, and one corrupt record cannot stop the scan.
 *
 * `config.ts` captures `VAULT_ROOT` at import time, so each test sets the env,
 * resets the module registry and imports the store fresh.
 */

const SETTINGS: JobSettings = {
  maxVideos: 10,
  filters: {},
  fetch: { concurrency: 1 },
  llm: { model: "test-model" },
};

const ORIGINAL_VAULT_ROOT = process.env.VAULT_ROOT;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boot-spec-"));
  process.env.VAULT_ROOT = root;
  vi.resetModules();
});

afterEach(async () => {
  if (ORIGINAL_VAULT_ROOT === undefined) delete process.env.VAULT_ROOT;
  else process.env.VAULT_ROOT = ORIGINAL_VAULT_ROOT;
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

async function load() {
  const registry = await import("../vaults/registry.js");
  const store = await import("./store.js");
  const bootstrap = await import("./bootstrap.js");
  const runner = await import("./runner.js");
  const settings = await import("../settings/store.js");
  return { registry, store, bootstrap, runner, settings };
}

/**
 * Boot resume is about the queue, not ingestion. Inject the inert adapter set
 * so a resumed job never spawns yt-dlp; the real S0 wiring is covered by
 * ingest/enumerate.spec.ts.
 */
function inertQueue(
  bootstrap: typeof import("./bootstrap.js"),
  runner: typeof import("./runner.js"),
) {
  return bootstrap.configureJobQueue(runner.createDefaultStageDeps());
}

async function makeVault(id: string): Promise<string> {
  const dir = join(root, id);
  await mkdir(join(dir, ".okf", "jobs"), { recursive: true });
  await mkdir(join(dir, "raw"), { recursive: true });
  return dir;
}

function job(
  id: string,
  vaultId: string,
  createdAt: string,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  const at = createdAt;
  return {
    id,
    vaultId,
    kind: "youtube",
    status: "queued",
    input: { url: `https://www.youtube.com/@${vaultId}` },
    settings: SETTINGS,
    createdAt: at,
    updatedAt: at,
    progress: { done: 0, total: 0 },
    skipped: [],
    error: null,
    cancelRequested: false,
    ...overrides,
  };
}

/** A valid S2 reply with no labels, so only the S2 call runs. */
function extractionReply(): string {
  return JSON.stringify({
    slug: null,
    title: "Snapshot Talk",
    thesis: "A thesis.",
    summary: "A summary.",
    tags: [],
    concepts: [],
    entities: [],
    quotes: [],
    relations: [],
  });
}

async function writeVideoCapture(vaultDir: string, slug: string): Promise<void> {
  await writeCapture(vaultDir, {
    kind: "video",
    slug,
    url: `https://youtu.be/${slug}`,
    youtubeId: slug,
    title: "Snapshot Talk",
    published: "2026-01-01",
    durationSec: 600,
    tier: 1,
    fetchedAt: "2026-10-18T08:00:00.000Z",
    segments: [
      { startSec: 0, text: "hello" },
      { startSec: 65, text: "world" },
    ],
  });
}

describe("job snapshot settings (PIPE-07)", () => {
  it("uses the creation-time model values, not a later settings.json write", async () => {
    const { store, runner, settings } = await load();
    const dir = await makeVault("vault-a");
    await writeVideoCapture(dir, "snapshot-talk");

    const snapshot: JobSettings = {
      maxVideos: 1,
      filters: {},
      fetch: { concurrency: 1 },
      llm: {
        model: "snapshot-model",
        baseUrl: "http://snapshot:11434",
        requestTimeoutMs: 12_345,
        maxRetries: 2,
      },
    };
    const running = job(
      "j_20261018_0000dd",
      "vault-a",
      "2026-10-18T09:00:00.000Z",
      { status: "running", stage: "S2", settings: snapshot },
    );
    await store.writeJob(dir, running);

    // The live settings file changes after the job was created.
    await settings.writeSettings({
      llm: {
        model: "live-model",
        baseUrl: "http://live:9999",
        requestTimeoutMs: 1_500,
        maxRetries: 5,
      },
    });

    const seen: LlmChatOptions[] = [];
    const llm: LlmClient = {
      async chat(_messages: LlmMessage[], options: LlmChatOptions) {
        seen.push(options);
        return { text: extractionReply(), tokensIn: 1, tokensOut: 1 };
      },
    };
    const deps = { ...runner.createDefaultStageDeps(), llm };
    await runner.runJob(running, deps);

    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options.model).toBe("snapshot-model");
      expect(options.baseUrl).toBe("http://snapshot:11434");
      expect(options.timeoutMs).toBe(12_345);
      expect(options.maxRetries).toBe(2);
    }
  });

  it("falls back to the default Ollama URL when the snapshot has none", async () => {
    const { store, runner } = await load();
    const dir = await makeVault("vault-a");
    await writeVideoCapture(dir, "snapshot-talk");

    const running = job(
      "j_20261018_0000ee",
      "vault-a",
      "2026-10-18T09:00:00.000Z",
      {
        status: "running",
        stage: "S2",
        settings: {
          maxVideos: 1,
          filters: {},
          fetch: { concurrency: 1 },
          llm: { model: "snapshot-model" },
        },
      },
    );
    await store.writeJob(dir, running);

    const seen: LlmChatOptions[] = [];
    const deps = {
      ...runner.createDefaultStageDeps(),
      llm: {
        async chat(_messages: LlmMessage[], options: LlmChatOptions) {
          seen.push(options);
          return { text: extractionReply(), tokensIn: 1, tokensOut: 1 };
        },
      },
    };
    await runner.runJob(running, deps);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});

describe("resumeJobs (PIPE-11)", () => {
  it("re-enqueues queued and running jobs in createdAt order across vaults", async () => {
    const { registry, store, bootstrap, runner } = await load();
    const dirA = await makeVault("vault-a");
    const dirB = await makeVault("vault-b");
    await registry.writeRegistryAtomic({
      version: 1,
      vaults: [
        {
          id: "vault-a",
          name: "Vault A",
          path: "vault-a",
          sourceKind: "manual",
          createdAt: "2026-10-18T08:00:00.000Z",
          lastOpenedAt: "2026-10-18T08:00:00.000Z",
        },
        {
          id: "vault-b",
          name: "Vault B",
          path: "vault-b",
          sourceKind: "manual",
          createdAt: "2026-10-18T08:00:00.000Z",
          lastOpenedAt: "2026-10-18T08:00:00.000Z",
        },
      ],
    });

    const older = job("j_20261018_00000a", "vault-a", "2026-10-18T09:00:00.000Z");
    const interrupted = job(
      "j_20261018_00000b",
      "vault-b",
      "2026-10-18T10:00:00.000Z",
      { status: "running", stage: "S0" },
    );
    const finished = job("j_20261018_00000c", "vault-a", "2026-10-18T08:00:00.000Z", {
      status: "completed",
      stage: "done",
    });
    await store.writeJob(dirA, older);
    await store.writeJob(dirB, interrupted);
    await store.writeJob(dirA, finished);

    const queue = inertQueue(bootstrap, runner);
    const ids = await bootstrap.resumeJobs();

    expect(ids).toEqual([older.id, interrupted.id]);
    await queue.idle();
    expect(queue.started).toEqual([older.id, interrupted.id]);
    expect((await store.readJob(dirA, older.id)).status).toBe("completed");
    expect((await store.readJob(dirB, interrupted.id)).status).toBe("completed");
    // The completed job is never re-enqueued.
    expect(queue.started).not.toContain(finished.id);
  });

  it("skips one corrupt record and still enqueues the valid job", async () => {
    const { registry, store, bootstrap, runner } = await load();
    const dirA = await makeVault("vault-a");
    await registry.writeRegistryAtomic({
      version: 1,
      vaults: [
        {
          id: "vault-a",
          name: "Vault A",
          path: "vault-a",
          sourceKind: "manual",
          createdAt: "2026-10-18T08:00:00.000Z",
          lastOpenedAt: "2026-10-18T08:00:00.000Z",
        },
      ],
    });

    const valid = job("j_20261018_0000aa", "vault-a", "2026-10-18T09:00:00.000Z");
    await store.writeJob(dirA, valid);

    const corruptDir = join(dirA, ".okf", "jobs", "j_20261018_0000bb");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "job.json"), "{ this is not json", "utf8");

    const queue = inertQueue(bootstrap, runner);
    const ids = await bootstrap.resumeJobs();

    expect(ids).toEqual([valid.id]);
    await queue.idle();
    expect((await store.readJob(dirA, valid.id)).status).toBe("completed");
  });

  it("survives a parseable record with no settings instead of rejecting unhandled", async () => {
    const { registry, store, bootstrap, runner } = await load();
    const dirA = await makeVault("vault-a");
    await registry.writeRegistryAtomic({
      version: 1,
      vaults: [
        {
          id: "vault-a",
          name: "Vault A",
          path: "vault-a",
          sourceKind: "manual",
          createdAt: "2026-10-18T08:00:00.000Z",
          lastOpenedAt: "2026-10-18T08:00:00.000Z",
        },
      ],
    });

    // Sorts like a real record and passes the queued filter, but `makeCtx`
    // dereferences `settings.filters` and throws before runJob's own try.
    const brokenId = "j_20261018_0000cc";
    const brokenDir = join(dirA, ".okf", "jobs", brokenId);
    await mkdir(brokenDir, { recursive: true });
    await writeFile(
      join(brokenDir, "job.json"),
      JSON.stringify({
        id: brokenId,
        vaultId: "vault-a",
        kind: "youtube",
        status: "queued",
        input: { url: "https://www.youtube.com/@vault-a" },
        createdAt: "2026-10-18T09:00:00.000Z",
        updatedAt: "2026-10-18T09:00:00.000Z",
        progress: { done: 0, total: 0 },
        skipped: [],
        error: null,
        cancelRequested: false,
      }),
      "utf8",
    );

    const queue = inertQueue(bootstrap, runner);
    const ids = await bootstrap.resumeJobs();

    expect(ids).toEqual([brokenId]);
    // A rejected job must be observed: idle() resolves and the process lives.
    await expect(queue.idle()).resolves.toBeUndefined();
    // WR-13: the runner validates the record and finishes it as `job_invalid`
    // instead of leaving it `queued` forever. `readJob` rejects the record by
    // design, so the assertion reads the raw file.
    const stored = JSON.parse(
      await readFile(join(brokenDir, "job.json"), "utf8"),
    ) as { status: string; error: string | null };
    expect(stored.status).toBe("failed");
    expect(stored.error).toBe("job_invalid");
  });

  it("throws a clear error when the queue was never configured", async () => {
    const { bootstrap } = await load();
    expect(() => bootstrap.getJobQueue()).toThrow("not configured");
  });
});
