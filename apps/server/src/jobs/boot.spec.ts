import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return { registry, store, bootstrap, runner };
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

  it("throws a clear error when the queue was never configured", async () => {
    const { bootstrap } = await load();
    expect(() => bootstrap.getJobQueue()).toThrow("not configured");
  });
});
