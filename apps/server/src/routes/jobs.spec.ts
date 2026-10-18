import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The queue is mocked so a route test can assert the record the API persisted
 * without letting the real runner advance it out of `queued` mid-test. The
 * runner itself is covered by jobs/runner.spec.ts and jobs/boot.spec.ts.
 */
const harness = vi.hoisted(() => {
  interface FakeJob {
    id: string;
    status: string;
  }
  const enqueued: FakeJob[] = [];
  const cancelled: Array<{ vaultDir: string; id: string }> = [];
  const queue = {
    enqueue(job: FakeJob): Promise<FakeJob> {
      enqueued.push(job);
      return Promise.resolve(job);
    },
    cancel(vaultDir: string, id: string): Promise<void> {
      cancelled.push({ vaultDir, id });
      return Promise.resolve();
    },
    idle(): Promise<void> {
      return Promise.resolve();
    },
    size: 0,
    started: [] as string[],
  };
  return { enqueued, cancelled, queue };
});

vi.mock("../jobs/bootstrap.js", () => ({ getJobQueue: () => harness.queue }));

const ORIGINAL_VAULT_ROOT = process.env.VAULT_ROOT;

let root = "";

async function reload() {
  vi.resetModules();
  const routes = await import("./jobs.js");
  const registry = await import("../vaults/registry.js");
  const store = await import("../jobs/store.js");
  return {
    jobs: routes.jobs,
    sseOptions: routes.sseOptions,
    createVault: registry.createVault,
    vaultDirPath: registry.vaultDirPath,
    readJob: store.readJob,
    listJobs: store.listJobs,
    appendEvent: store.appendEvent,
  };
}

type Routes = Awaited<ReturnType<typeof reload>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jobs-routes-"));
  process.env.VAULT_ROOT = root;
  harness.enqueued.length = 0;
  harness.cancelled.length = 0;
  harness.queue.size = 0;
});

afterEach(async () => {
  if (ORIGINAL_VAULT_ROOT === undefined) {
    delete process.env.VAULT_ROOT;
  } else {
    process.env.VAULT_ROOT = ORIGINAL_VAULT_ROOT;
  }
  await rm(root, { recursive: true, force: true });
});

function validBody(vaultId: string): Record<string, unknown> {
  return {
    vaultId,
    kind: "youtube",
    channelUrl: "https://www.youtube.com/@demo",
    maxVideos: 5,
  };
}

function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function seeded(routes: Routes): Promise<{ vaultId: string; vaultDir: string }> {
  const vault = await routes.createVault({ name: "Demo" });
  return { vaultId: vault.id, vaultDir: routes.vaultDirPath(vault.id) };
}

describe("POST /api/jobs", () => {
  it("persists a queued job and returns 202 before enqueueing it", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    const res = await routes.jobs.request("/", jsonInit(validBody(vaultId)));
    expect(res.status).toBe(202);

    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    expect(body.id).toMatch(/^j_\d{8}_[0-9a-f]{6}$/);

    const onDisk = JSON.parse(
      await readFile(join(vaultDir, ".okf", "jobs", body.id, "job.json"), "utf8"),
    ) as { id: string; status: string; input: { url: string } };
    expect(onDisk.id).toBe(body.id);
    expect(onDisk.status).toBe("queued");
    // The canonical /videos URL is what S0 enumerates.
    expect(onDisk.input.url).toBe("https://www.youtube.com/@demo/videos");

    expect(harness.enqueued.map((job) => job.id)).toEqual([body.id]);
  });

  it("returns 404 for an unknown vault and writes no job", async () => {
    const routes = await reload();
    const { vaultDir } = await seeded(routes);

    const res = await routes.jobs.request("/", jsonInit(validBody("no-such-vault")));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("vault_not_found");
    expect(existsSync(join(vaultDir, ".okf"))).toBe(false);
    expect(harness.enqueued).toHaveLength(0);
  });

  it("returns 400 for maxVideos: 0 and writes no job", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    const res = await routes.jobs.request(
      "/",
      jsonInit({ ...validBody(vaultId), maxVideos: 0 }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    expect(existsSync(join(vaultDir, ".okf"))).toBe(false);
  });

  it("returns 400 invalid_source_url for a non-channel URL and writes no job", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    const res = await routes.jobs.request(
      "/",
      jsonInit({ ...validBody(vaultId), channelUrl: "https://example.com/@x" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_source_url");
    expect(existsSync(join(vaultDir, ".okf"))).toBe(false);
  });

  it("returns 403 origin_mismatch for a cross-origin POST and creates nothing", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);

    const res = await routes.jobs.request(
      "/",
      jsonInit(validBody(vaultId), { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_mismatch");
    expect(harness.enqueued).toHaveLength(0);
  });

  it("allows a request with no Origin header", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);

    const res = await routes.jobs.request("/", jsonInit(validBody(vaultId)));
    expect(res.status).toBe(202);
  });
});

describe("GET /api/jobs", () => {
  it("lists the created job and reads it back by id", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    const list = await routes.jobs.request("/");
    expect(list.status).toBe(200);
    const { jobs: listed } = (await list.json()) as { jobs: Array<{ id: string }> };
    expect(listed.map((job) => job.id)).toEqual([created.id]);

    const one = await routes.jobs.request(`/${created.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { id: string }).id).toBe(created.id);
  });

  it("returns 404 for an unknown or malformed id without touching disk", async () => {
    const routes = await reload();
    await seeded(routes);

    for (const id of ["j_20260101_zzzzzz", "not-an-id", "../vaults.json"]) {
      const res = await routes.jobs.request(`/${id}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("job_not_found");
    }
  });
});

describe("GET /api/jobs/:id/events", () => {
  it("returns 404 JSON for an unknown job and never opens a stream", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request("/j_20260101_abcdef/events");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(((await res.json()) as { error: string }).error).toBe("job_not_found");
  });

  it("streams a persisted job's event log with the required SSE headers", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    await routes.appendEvent(join(vaultDir, ".okf", "jobs", created.id), "stage", {
      stage: "S0",
      status: "started",
    });

    // Keep the stream quiet for the life of the assertion.
    routes.sseOptions.pollMs = 1000;
    routes.sseOptions.keepaliveMs = 60_000;

    const res = await routes.jobs.request(`/${created.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no stream body");
    const chunk = await reader.read();
    await reader.cancel().catch(() => undefined);
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("id: 1");
    expect(text).toContain("event: stage");
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("returns 202 and is idempotent on repeat without creating a second job", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    const first = await routes.jobs.request(`/${created.id}`, { method: "DELETE" });
    expect(first.status).toBe(202);
    expect(((await first.json()) as { id: string }).id).toBe(created.id);

    const second = await routes.jobs.request(`/${created.id}`, { method: "DELETE" });
    expect(second.status).toBe(202);

    const { jobs: listed } = (await (await routes.jobs.request("/")).json()) as {
      jobs: unknown[];
    };
    expect(listed).toHaveLength(1);
    expect(harness.cancelled.map((call) => call.id)).toEqual([created.id]);
  });

  it("returns 404 for an unknown job", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request("/j_20260101_abcdef", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 403 origin_mismatch for a cross-origin DELETE", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    const res = await routes.jobs.request(`/${created.id}`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(harness.cancelled).toHaveLength(0);
  });
});
