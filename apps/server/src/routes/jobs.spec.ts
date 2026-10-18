import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../jobs/types.js";

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

/**
 * yt-dlp is replaced at the module boundary the preview and the create route
 * both import. `failure` makes the next enumerate call throw the SAME
 * EnumerateError class the route uses for its instanceof mapping.
 */
const enumHarness = vi.hoisted(() => {
  class EnumerateError extends Error {
    code: "enumerate_failed" | "timeout";
    detail?: string;

    constructor(code: "enumerate_failed" | "timeout", detail?: string) {
      super(detail !== undefined && detail !== "" ? detail : code);
      this.name = "EnumerateError";
      this.code = code;
      if (detail !== undefined) this.detail = detail;
    }
  }
  return {
    candidates: [] as Array<{
      youtubeId: string;
      title: string;
      url: string;
      published?: string;
      durationSec?: number;
      language?: string;
    }>,
    foundAtLeast: false,
    calls: 0,
    failure: null as null | { code: "enumerate_failed" | "timeout"; detail?: string },
    EnumerateError,
  };
});

vi.mock("../ingest/enumerate.js", () => ({
  enumerateChannel: async () => {
    enumHarness.calls += 1;
    if (enumHarness.failure !== null) {
      const failure = enumHarness.failure;
      enumHarness.failure = null;
      throw new enumHarness.EnumerateError(failure.code, failure.detail);
    }
    return {
      candidates: enumHarness.candidates.map((candidate) => ({ ...candidate })),
      foundAtLeast: enumHarness.foundAtLeast,
    };
  },
  EnumerateError: enumHarness.EnumerateError,
}));

const ORIGINAL_VAULT_ROOT = process.env.VAULT_ROOT;

let root = "";

async function reload() {
  vi.resetModules();
  const routes = await import("./jobs.js");
  const registry = await import("../vaults/registry.js");
  const store = await import("../jobs/store.js");
  const cfg = await import("../config.js");
  return {
    jobs: routes.jobs,
    sseOptions: routes.sseOptions,
    config: cfg.config,
    createVault: registry.createVault,
    vaultDirPath: registry.vaultDirPath,
    readJob: store.readJob,
    writeJob: store.writeJob,
    listJobs: store.listJobs,
    appendEvent: store.appendEvent,
    readEvents: store.readEvents,
  };
}

type Routes = Awaited<ReturnType<typeof reload>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jobs-routes-"));
  process.env.VAULT_ROOT = root;
  harness.enqueued.length = 0;
  harness.cancelled.length = 0;
  harness.queue.size = 0;
  enumHarness.candidates = [
    {
      youtubeId: "v1",
      title: "First Talk",
      url: "https://youtu.be/v1",
      published: "2026-01-15",
      durationSec: 600,
      language: "en",
    },
  ];
  enumHarness.foundAtLeast = false;
  enumHarness.calls = 0;
  enumHarness.failure = null;
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

  it("snapshots the effective settings, unchanged by a later settings PUT", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };
    const before = await routes.readJob(vaultDir, created.id);

    // The per-job input and the global defaults are both in the record.
    expect(before.settings.maxVideos).toBe(5);
    expect(before.settings.fetch.concurrency).toBe(2);
    expect(before.settings.sweep).toEqual({ enabled: false });

    const settingsRoutes = await import("./settings.js");
    const put = await settingsRoutes.settings.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm: { model: "changed-model" }, fetch: { delayMs: 7 } }),
    });
    expect(put.status).toBe(200);

    const stored = await routes.readJob(vaultDir, created.id);
    expect(stored.settings).toEqual(before.settings);
    expect(stored.settings.llm.model).not.toBe("changed-model");
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

  it("creates a web job with the requested URL and one-page settings", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    const res = await routes.jobs.request(
      "/",
      jsonInit({ vaultId, kind: "web", url: "https://example.com/post", language: "de" }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");

    const onDisk = await routes.readJob(vaultDir, body.id);
    expect(onDisk.kind).toBe("web");
    expect(onDisk.input.url).toBe("https://example.com/post");
    expect(onDisk.settings.maxVideos).toBe(1);
    expect(onDisk.settings.filters).toEqual({ language: "de" });
    expect(onDisk.settings.llm.baseUrl).toBe(routes.config.ollamaBaseUrl);
    // A web job never enumerates a channel.
    expect(enumHarness.calls).toBe(0);
    expect(harness.enqueued.map((job) => job.id)).toEqual([body.id]);
  });

  it("returns 400 invalid_body when a web body carries a filter field", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    for (const extra of [
      { maxVideos: 5 },
      { dateFrom: "2026-01-01" },
      { dateTo: "2026-02-01" },
      { minDurationSec: 60 },
    ]) {
      const res = await routes.jobs.request(
        "/",
        jsonInit({ vaultId, kind: "web", url: "https://example.com/post", ...extra }),
      );
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }

    expect(existsSync(join(vaultDir, ".okf"))).toBe(false);
    expect(harness.enqueued).toHaveLength(0);
  });

  it("returns 400 invalid_source_url for a file: or credential-bearing web URL", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);

    for (const url of ["file:///etc/passwd", "https://user:secret@example.com/post"]) {
      const res = await routes.jobs.request(
        "/",
        jsonInit({ vaultId, kind: "web", url }),
      );
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_source_url");
    }

    expect(existsSync(join(vaultDir, ".okf"))).toBe(false);
    expect(harness.enqueued).toHaveLength(0);
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

describe("POST /api/jobs/preview", () => {
  function previewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "youtube",
      channelUrl: "https://www.youtube.com/@demo",
      maxVideos: 5,
      ...overrides,
    };
  }

  it("returns the full breakdown for two candidates and writes nothing", async () => {
    const routes = await reload();
    const { vaultDir } = await seeded(routes);
    enumHarness.candidates = [
      {
        youtubeId: "v1",
        title: "First Talk",
        url: "https://youtu.be/v1",
        published: "2026-01-15",
        durationSec: 600,
        language: "en",
      },
      {
        youtubeId: "v2",
        title: "Second Talk",
        url: "https://youtu.be/v2",
        published: "2026-02-15",
        durationSec: 900,
        language: "en",
      },
    ];

    const res = await routes.jobs.request("/preview", jsonInit(previewBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: 2,
      selected: 2,
      skipped: [],
      estimatedCalls: 9,
      estimatedMinutes: 4,
    });
    // The literal follows the locked formula, not a rounded guess.
    expect(2 + 6 + Math.ceil(2 / 5)).toBe(9);

    // A preview is a dry run: no job directory, no raw file, no enqueue.
    expect(existsSync(join(vaultDir, ".okf", "jobs"))).toBe(false);
    expect(await readdir(join(vaultDir, "raw"))).toEqual([]);
    expect(harness.enqueued).toHaveLength(0);
  });

  it("returns a complete estimate for zero candidates with 200", async () => {
    const routes = await reload();
    await seeded(routes);
    enumHarness.candidates = [];

    const res = await routes.jobs.request("/preview", jsonInit(previewBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: 0,
      selected: 0,
      skipped: [],
      estimatedCalls: 6,
      estimatedMinutes: 0,
    });
  });

  it("returns 400 invalid_source_url for a malformed channel URL", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request(
      "/preview",
      jsonInit(previewBody({ channelUrl: "https://example.com/@x" })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_source_url");
    expect(enumHarness.calls).toBe(0);
  });

  it("maps a timeout to 504 and a non-zero exit to 502", async () => {
    const routes = await reload();
    await seeded(routes);

    enumHarness.failure = { code: "timeout" };
    const timedOut = await routes.jobs.request("/preview", jsonInit(previewBody()));
    expect(timedOut.status).toBe(504);
    expect(((await timedOut.json()) as { error: string }).error).toBe("enumerate_timeout");

    enumHarness.failure = { code: "enumerate_failed", detail: "exit 2" };
    const failed = await routes.jobs.request("/preview", jsonInit(previewBody()));
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("enumerate_failed");
  });

  it("returns the fixed one-page estimate for a web preview without a fetch", async () => {
    const routes = await reload();
    const { vaultDir } = await seeded(routes);
    const fetchSpy = vi.fn(async () => {
      throw new Error("a web preview must not fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const res = await routes.jobs.request(
        "/preview",
        jsonInit({ kind: "web", url: "https://example.com/post" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        found: 1,
        selected: 1,
        skipped: [],
        estimatedCalls: 8,
        estimatedMinutes: 4,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(enumHarness.calls).toBe(0);
      expect(existsSync(join(vaultDir, ".okf", "jobs"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a web preview with a filter field as invalid_body", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request(
      "/preview",
      jsonInit({ kind: "web", url: "https://example.com/post", maxVideos: 5 }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
  });

  it("returns 400 invalid_source_url for a non-http web preview", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request(
      "/preview",
      jsonInit({ kind: "web", url: "file:///etc/passwd" }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_source_url");
  });

  it("answers GET /preview with 405 and never treats it as a job id", async () => {
    const routes = await reload();
    await seeded(routes);

    const res = await routes.jobs.request("/preview");
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toBe("method_not_allowed");
  });

  it("refuses a zero-candidate commit and creates no job directory", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    enumHarness.candidates = [];

    const res = await routes.jobs.request("/", jsonInit(validBody(vaultId)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_selection");
    expect(existsSync(join(vaultDir, ".okf", "jobs"))).toBe(false);
    expect(harness.enqueued).toHaveLength(0);
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

describe("GET /api/jobs/:id/artifacts", () => {
  async function createdJob(routes: Routes, vaultId: string): Promise<string> {
    const res = await routes.jobs.request("/", jsonInit(validBody(vaultId)));
    return ((await res.json()) as { id: string }).id;
  }

  it("returns the enumerate artifact and 404s when it is missing", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await createdJob(routes, vaultId);

    const missing = await routes.jobs.request(`/${id}/artifacts?kind=enumerate`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("artifact_not_found");

    const dir = join(vaultDir, ".okf", "jobs", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "01-enumerate.json"),
      JSON.stringify({ count: 1, candidates: [{ youtubeId: "abc" }] }),
      "utf8",
    );

    const res = await routes.jobs.request(`/${id}/artifacts?kind=enumerate`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ count: 1, candidates: [{ youtubeId: "abc" }] });
  });

  it("returns a raw capture in markdown and rejects a traversal slug", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await createdJob(routes, vaultId);

    await writeFile(
      join(vaultDir, "raw", "alpha.md"),
      "---\ntype: raw-transcript\n---\n\n## Transcript\n\nbody\n",
      "utf8",
    );

    const ok = await routes.jobs.request(`/${id}/artifacts?kind=raw&slug=alpha`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type") ?? "").toContain("text/markdown");
    expect(await ok.text()).toContain("## Transcript");

    const traversal = await routes.jobs.request(
      `/${id}/artifacts?kind=raw&slug=../vaults.json`,
    );
    expect(traversal.status).toBe(400);
    expect(((await traversal.json()) as { error: string }).error).toBe("invalid_slug");

    const uppercase = await routes.jobs.request(`/${id}/artifacts?kind=raw&slug=Alpha`);
    expect(uppercase.status).toBe(400);

    const absent = await routes.jobs.request(`/${id}/artifacts?kind=raw&slug=beta`);
    expect(absent.status).toBe(404);
    expect(((await absent.json()) as { error: string }).error).toBe("artifact_not_found");
  });

  it("404s a slug whose resolved path escapes the vault through a symlink", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await createdJob(routes, vaultId);

    const outside = join(root, "outside.md");
    await writeFile(outside, "not part of the vault\n", "utf8");
    await symlink(outside, join(vaultDir, "raw", "escape.md"));

    const res = await routes.jobs.request(`/${id}/artifacts?kind=raw&slug=escape`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(((await res.json()) as { error: string }).error).toBe("artifact_not_found");
  });

  it("returns the stored skipped array", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await createdJob(routes, vaultId);

    const clean = await routes.jobs.request(`/${id}/artifacts?kind=skipped`);
    expect(await clean.json()).toEqual({ skipped: [] });

    const job = await routes.readJob(vaultDir, id);
    job.skipped.push({
      slug: "alpha",
      youtubeId: "abc",
      stage: "S1",
      reason: "no_captions",
    });
    await routes.writeJob(vaultDir, job);

    const stored = await routes.jobs.request(`/${id}/artifacts?kind=skipped`);
    const body = (await stored.json()) as { skipped: Array<{ slug: string }> };
    expect(body.skipped.map((unit) => unit.slug)).toEqual(["alpha"]);
  });

  it("400s an unknown kind and 404s an unknown job", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);
    const id = await createdJob(routes, vaultId);

    const badKind = await routes.jobs.request(`/${id}/artifacts?kind=all`);
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { error: string }).error).toBe("invalid_body");

    const noKind = await routes.jobs.request(`/${id}/artifacts`);
    expect(noKind.status).toBe(400);

    const unknown = await routes.jobs.request("/j_20260101_abcdef/artifacts?kind=skipped");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("job_not_found");
  });
});

describe("GET /api/jobs filters", () => {
  it("filters by vaultId", async () => {
    const routes = await reload();
    const demo = await routes.createVault({ name: "Demo" });
    await routes.createVault({ name: "Other" });

    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(demo.id)))
    ).json()) as { id: string };

    const other = (await (await routes.jobs.request("/?vaultId=other")).json()) as {
      jobs: unknown[];
    };
    expect(other.jobs).toHaveLength(0);

    const own = (await (await routes.jobs.request(`/?vaultId=${demo.id}`)).json()) as {
      jobs: Array<{ id: string }>;
    };
    expect(own.jobs.map((job) => job.id)).toEqual([created.id]);
  });

  it("filters by status and rejects an unknown status", async () => {
    const routes = await reload();
    const { vaultId } = await seeded(routes);
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    const queued = (await (await routes.jobs.request("/?status=queued")).json()) as {
      jobs: Array<{ id: string }>;
    };
    expect(queued.jobs.map((job) => job.id)).toEqual([created.id]);

    const completed = (await (await routes.jobs.request("/?status=completed")).json()) as {
      jobs: unknown[];
    };
    expect(completed.jobs).toHaveLength(0);

    const bogus = await routes.jobs.request("/?status=bogus");
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe("invalid_body");
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

describe("POST /api/jobs/:id/retry", () => {
  /** Create a job through the API, then put it in the state a run left behind. */
  async function settled(
    routes: Routes,
    vaultId: string,
    vaultDir: string,
    skipped: JobRecord["skipped"],
  ): Promise<string> {
    const created = (await (
      await routes.jobs.request("/", jsonInit(validBody(vaultId)))
    ).json()) as { id: string };

    const job = await routes.readJob(vaultDir, created.id);
    job.status = "completed";
    job.stage = "done";
    job.error = "model_error";
    job.cancelRequested = true;
    job.progress = { done: 3, total: 4 };
    job.skipped = skipped;
    await routes.writeJob(vaultDir, job);
    return created.id;
  }

  it("answers 202, resets the record and re-enqueues it exactly once", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
      { slug: "beta", stage: "S1", reason: "no_captions" },
    ]);

    const res = await routes.jobs.request(`/${id}/retry`, jsonInit({}));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id, status: "queued" });

    const stored = await routes.readJob(vaultDir, id);
    expect(stored.status).toBe("queued");
    expect(stored.stage).toBe("S2");
    expect(stored.error).toBeNull();
    expect(stored.cancelRequested).toBe(false);
    expect(stored.progress).toEqual({ done: 0, total: 0 });
    expect(stored.retry).toEqual({ units: [{ slug: "alpha", stage: "S2" }] });
    // The display-only S1 entry stays; only the retried unit is cleared.
    expect(stored.skipped).toEqual([
      { slug: "beta", stage: "S1", reason: "no_captions" },
    ]);

    expect(harness.enqueued.filter((job) => job.id === id)).toHaveLength(2);
  });

  it("answers one 202 and one 409 when two retries overlap", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
    ]);
    const before = harness.enqueued.filter((job) => job.id === id).length;

    // Both requests read the terminal record before either write lands.
    const [first, second] = await Promise.all([
      routes.jobs.request(`/${id}/retry`, jsonInit({})),
      routes.jobs.request(`/${id}/retry`, jsonInit({})),
    ]);

    expect([first.status, second.status].sort()).toEqual([202, 409]);
    const refused = first.status === 409 ? first : second;
    expect(((await refused.json()) as { error: string }).error).toBe(
      "retry_running",
    );
    expect(harness.enqueued.filter((job) => job.id === id)).toHaveLength(
      before + 1,
    );
  });

  it("starts a fresh event log so the prior done frame is not replayed", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
    ]);
    const dir = join(vaultDir, ".okf", "jobs", id);

    await routes.appendEvent(dir, "unit", {
      slug: "alpha",
      stage: "S2",
      status: "skipped",
      reason: "malformed_json",
    });
    await routes.appendEvent(dir, "done", { status: "completed" });
    expect((await routes.readEvents(dir, 0)).map((event) => event.type)).toEqual([
      "unit",
      "done",
    ]);

    const res = await routes.jobs.request(`/${id}/retry`, jsonInit({}));
    expect(res.status).toBe(202);

    // A client that reconnects at seq 0 must not see the old run's frames.
    expect(await routes.readEvents(dir, 0)).toEqual([]);
  });

  it("treats an empty body as onlyFailed and records every failed stage", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
      { slug: "delta", stage: "S3", reason: "model_error" },
      { slug: "gamma", stage: "S4", reason: "model_error" },
      { slug: "some-label", stage: "S6", reason: "model_error" },
    ]);

    const res = await routes.jobs.request(`/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(202);

    const stored = await routes.readJob(vaultDir, id);
    expect(stored.stage).toBe("S2");
    expect(stored.retry?.units).toEqual([
      { slug: "alpha", stage: "S2" },
      { slug: "delta", stage: "S3" },
      { slug: "gamma", stage: "S4" },
      { slug: "some-label", stage: "S6" },
    ]);
    expect(stored.skipped).toEqual([]);
  });

  it("snapshots the configured endpoint into a new record", async () => {
    const original = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "https://endpoint.example/v1";
    try {
      const routes = await reload();
      const { vaultId, vaultDir } = await seeded(routes);

      const created = (await (
        await routes.jobs.request("/", jsonInit(validBody(vaultId)))
      ).json()) as { id: string };

      const stored = await routes.readJob(vaultDir, created.id);
      expect(stored.settings.llm.baseUrl).toBe("https://endpoint.example/v1");
      expect(routes.config.ollamaBaseUrl).toBe("https://endpoint.example/v1");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_BASE_URL;
      } else {
        process.env.OLLAMA_BASE_URL = original;
      }
    }
  });

  it("returns 404 for an unknown job and enqueues nothing", async () => {
    const routes = await reload();
    await seeded(routes);

    const before = harness.enqueued.length;
    const res = await routes.jobs.request("/j_20260101_abcdef/retry", jsonInit({}));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("job_not_found");
    expect(harness.enqueued).toHaveLength(before);
  });

  it("refuses a running job with 409 retry_running and writes nothing", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
    ]);

    const running = await routes.readJob(vaultDir, id);
    running.status = "running";
    await routes.writeJob(vaultDir, running);
    const before = harness.enqueued.length;

    const res = await routes.jobs.request(`/${id}/retry`, jsonInit({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "retry_running",
      message: "Retry after the job finishes.",
    });

    const stored = await routes.readJob(vaultDir, id);
    expect(stored.status).toBe("running");
    expect(stored.retry).toBeUndefined();
    expect(harness.enqueued).toHaveLength(before);
  });

  it("refuses a job with no retryable failure with 409 no_failed_units", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "beta", stage: "S1", reason: "no_captions" },
    ]);
    const before = harness.enqueued.length;

    const res = await routes.jobs.request(`/${id}/retry`, jsonInit({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "no_failed_units",
      message: "No failed units to retry.",
    });

    // An S1 entry is display-only and stays exactly where it was.
    const stored = await routes.readJob(vaultDir, id);
    expect(stored.skipped).toEqual([
      { slug: "beta", stage: "S1", reason: "no_captions" },
    ]);
    expect(harness.enqueued).toHaveLength(before);
  });

  it("returns 403 origin_mismatch for a cross-origin retry", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
    ]);
    const before = harness.enqueued.length;

    const res = await routes.jobs.request(
      `/${id}/retry`,
      jsonInit({ onlyFailed: true }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_mismatch");
    expect(harness.enqueued).toHaveLength(before);
  });

  it("returns 400 for an unknown body key and changes nothing", async () => {
    const routes = await reload();
    const { vaultId, vaultDir } = await seeded(routes);
    const id = await settled(routes, vaultId, vaultDir, [
      { slug: "alpha", stage: "S2", reason: "malformed_json" },
    ]);

    const res = await routes.jobs.request(
      `/${id}/retry`,
      jsonInit({ slugs: ["alpha"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");

    const stored = await routes.readJob(vaultDir, id);
    expect(stored.status).toBe("completed");
    expect(stored.retry).toBeUndefined();
  });
});
