import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Vault } from "./api.js";

// We import the module under test fresh per case so stubs are isolated. The
// RED phase: api.ts does not exist yet, so this import fails and every test
// errors. GREEN lands when api.ts implements the contract below.

async function load() {
  return (await import("./api.js")) as typeof import("./api.js");
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.resetModules();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Read a header value from either a Headers object, a string[][], or a record. */
function readHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) if (k.toLowerCase() === name.toLowerCase()) return v;
    return null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return String(v);
  return null;
}

describe("listVaults", () => {
  it("issues GET /api/vaults and resolves to the parsed array", async () => {
    const data = [{ id: "a", name: "A", path: "a", sourceKind: "manual", createdAt: "x", lastOpenedAt: "x" }];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/vaults");
      expect(init?.method ?? "GET").toBe("GET");
      return jsonResponse(data);
    });
    const { listVaults } = await load();
    const out = await listVaults();
    expect(out).toEqual(data);
    expect(Array.isArray(out)).toBe(true);
  });

  it("resolves an empty array successfully (not undefined, not a rejection)", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse([]));
    const { listVaults } = await load();
    const out = await listVaults();
    expect(out).toEqual([]);
  });

  it("rejects with an error carrying the server message on a non-2xx", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "boom", message: "server says no" }, 500));
    const { listVaults } = await load();
    await expect(listVaults()).rejects.toThrow("server says no");
  });
});

describe("createVault", () => {
  it("issues POST /api/vaults with a JSON body and a JSON content-type header", async () => {
    const created: Vault = { id: "my-vault", name: "My Vault", path: "my-vault", sourceKind: "manual", createdAt: "t", lastOpenedAt: "t" };
    let capturedMethod = "";
    let capturedUrl = "";
    let capturedContentType = "";
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedContentType = readHeader(init?.headers, "content-type") ?? "";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse(created, 201);
    });
    const { createVault } = await load();
    const out = await createVault("My Vault");
    expect(out).toEqual(created);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("/api/vaults");
    expect(capturedContentType).toContain("application/json");
    expect(JSON.parse(capturedBody)).toEqual({ name: "My Vault" });
  });

  it("rejects with an error whose message is the server collision message on 409", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "slug_collision", message: "A vault named X already exists with the same slug." }, 409));
    const { createVault } = await load();
    await expect(createVault("X")).rejects.toThrow("A vault named X already exists with the same slug.");
  });

  it("trims the name before sending", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ id: "t", name: "T", path: "t", sourceKind: "manual", createdAt: "t", lastOpenedAt: "t" }, 201);
    });
    const { createVault } = await load();
    await createVault("  T  ");
    expect(JSON.parse(capturedBody)).toEqual({ name: "T" });
  });
});

describe("deleteVault", () => {
  it("issues DELETE /api/vaults/:id with the confirmation under the server's own key", async () => {
    // The key is the contract: `apps/server/src/routes/vaults.ts` reads
    // `confirmName`, and anything else is a 400 on every delete, forever.
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    let capturedContentType = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedContentType = readHeader(init?.headers, "content-type") ?? "";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ deleted: true, id: "v1" });
    });
    const { deleteVault } = await load();
    const out = await deleteVault("v1", "My Vault");

    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl).toContain("/api/vaults/v1");
    expect(capturedContentType).toContain("application/json");
    expect(JSON.parse(capturedBody)).toEqual({ confirmName: "My Vault" });
    expect(out).toEqual({ deleted: true, id: "v1" });
  });

  it("percent-encodes the id into the path", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({ deleted: true, id: "a b" });
    });
    const { deleteVault } = await load();
    await deleteVault("a b", "Name");
    expect(capturedUrl).toContain("/api/vaults/a%20b");
  });

  it("sends the typed name verbatim — it does not trim it into agreement", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ deleted: true, id: "v1" });
    });
    const { deleteVault } = await load();
    await deleteVault("v1", " My Vault ");
    // Trimming here would make the client agree with itself and the server
    // still answer 400 — the mismatch would look like a server bug.
    expect(JSON.parse(capturedBody)).toEqual({ confirmName: " My Vault " });
  });

  it("rejects a 400 with the status intact so the caller knows nothing was removed", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "confirm_mismatch", message: "`confirmName` does not match the vault name." }, 400),
    );
    const { deleteVault, ApiError } = await load();
    await expect(deleteVault("v1", "Wrong Name")).rejects.toThrow(
      "`confirmName` does not match the vault name.",
    );
    await expect(deleteVault("v1", "Wrong Name")).rejects.toBeInstanceOf(ApiError);
    await expect(deleteVault("v1", "Wrong Name")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a 404 with the status intact so a gone vault can be treated as success", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "not_found", message: "No vault with that id." }, 404));
    const { deleteVault } = await load();
    await expect(deleteVault("v1", "My Vault")).rejects.toMatchObject({ status: 404 });
  });
});

describe("listTree", () => {
  it("issues GET /api/vaults/:id/tree with the root as the default dir", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({ dir: ".", entries: [] });
    });
    const { listTree } = await load();
    const out = await listTree("v1");
    expect(out).toEqual({ dir: ".", entries: [] });
    expect(capturedUrl).toContain("/api/vaults/v1/tree");
    // The server's spelling of the root is ".", and a request with no dir at all
    // would be a second, undocumented form of the same question.
    expect(capturedUrl).toContain("dir=");
    expect(decodeURIComponent(capturedUrl)).toContain("dir=.");
  });

  it("sends a nested directory and encodes it", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({ dir: "Notes/Deep", entries: [] });
    });
    const { listTree } = await load();
    await listTree("v1", "Notes/Deep");
    expect(capturedUrl).toContain("dir=Notes%2FDeep");
  });

  it("resolves the entries the server returned, unchanged", async () => {
    const entries = [
      { id: "Notes", name: "Notes", path: "Notes", isDir: true, childrenLoaded: false },
      { id: "Alpha.md", name: "Alpha.md", path: "Alpha.md", isDir: false, childrenLoaded: false, modified: 1234 },
    ];
    globalThis.fetch = vi.fn(async () => jsonResponse({ dir: ".", entries }));
    const { listTree } = await load();
    const out = await listTree("v1");
    expect(out.entries).toEqual(entries);
  });
});

describe("readFile", () => {
  it("issues GET /api/file with vault and path, and resolves the base hash", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({ path: "Alpha.md", content: "# Alpha", baseHash: "hash-1" });
    });
    const { readFile } = await load();
    const out = await readFile("v1", "Alpha.md");
    expect(out).toEqual({ path: "Alpha.md", content: "# Alpha", baseHash: "hash-1" });
    expect(capturedUrl).toContain("/api/file");
    expect(capturedUrl).toContain("vault=v1");
    expect(capturedUrl).toContain("path=Alpha.md");
  });

  it("rejects with the server message when the file is not there", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "not_found", message: "No such file." }, 404));
    const { readFile } = await load();
    await expect(readFile("v1", "Gone.md")).rejects.toThrow("No such file.");
  });
});

describe("writeFile", () => {
  it("PUTs the content with the supplied base hash and resolves the returned hash", async () => {
    let capturedMethod = "";
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ path: "Alpha.md", baseHash: "hash-2" });
    });
    const { writeFile } = await load();
    const out = await writeFile("v1", "Alpha.md", "# Alpha edited", "hash-1");
    expect(out).toEqual({ path: "Alpha.md", baseHash: "hash-2" });
    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain("/api/file");
    expect(JSON.parse(capturedBody)).toEqual({
      vault: "v1",
      path: "Alpha.md",
      content: "# Alpha edited",
      baseHash: "hash-1",
    });
  });

  it("sends baseHash null for a create — the only form the server reads as 'this is new'", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ path: "New.md", baseHash: "hash-new" });
    });
    const { writeFile } = await load();
    await writeFile("v1", "New.md", "hello", null);
    expect(JSON.parse(capturedBody)).toEqual({ vault: "v1", path: "New.md", content: "hello", baseHash: null });
  });

  it("turns a 409 into a ConflictError carrying both fields, distinguishable from a generic failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: "conflict",
          message: "This file changed on disk since you opened it.",
          currentContent: "someone else's text",
          currentHash: "hash-disk",
        },
        409,
      ),
    );
    const { writeFile, ConflictError, ApiError } = await load();
    const thrown = await writeFile("v1", "Alpha.md", "mine", "hash-stale").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ConflictError);
    // Both fields the caller needs to offer a choice, not just a status number.
    expect((thrown as InstanceType<typeof ConflictError>).currentContent).toBe("someone else's text");
    expect((thrown as InstanceType<typeof ConflictError>).currentHash).toBe("hash-disk");
    expect((thrown as Error).message).toBe("This file changed on disk since you opened it.");
    // A generic ApiError is NOT a conflict: the caller branches on the type, so
    // the two must not be interchangeable.
    expect(thrown).toBeInstanceOf(ApiError);
    expect(new ApiError(500, "other")).not.toBeInstanceOf(ConflictError);
  });

  it("does not turn a 500 into a ConflictError", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "io", message: "Disk is full." }, 500));
    const { writeFile, ConflictError } = await load();
    const thrown = await writeFile("v1", "Alpha.md", "mine", "hash-1").catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(ConflictError);
    expect((thrown as Error).message).toBe("Disk is full.");
  });
});

describe("settings calls", () => {
  it("reads the redacted settings from GET /api/settings", async () => {
    const payload = {
      settings: {
        llm: { model: "m", concurrency: 1, requestTimeoutMs: 1000, maxRetries: 3 },
        fetch: { delayMs: 1000, concurrency: 2, language: "en" },
        sweep: { enabled: true },
        ui: { theme: "system" },
      },
      hasYoutubeCookie: false,
      youtubeCookieUpdatedAt: null,
      hasSupadataKey: false,
      llmConfigured: true,
    };
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse(payload);
    });
    const { getSettings } = await load();
    await expect(getSettings()).resolves.toEqual(payload);
    expect(capturedUrl).toBe("/api/settings");
  });

  it("PUTs a partial settings patch as JSON", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ settings: {}, hasYoutubeCookie: false });
    });
    const { putSettings } = await load();
    await putSettings({ fetch: { delayMs: 500 } });
    expect(capturedMethod).toBe("PUT");
    expect(JSON.parse(capturedBody)).toEqual({ fetch: { delayMs: 500 } });
  });

  it("uploads the cookie as a raw text/plain body, never as JSON", async () => {
    const raw = "www.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tSECRET-VALUE\n";
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedContentType = "";
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedContentType = readHeader(init?.headers, "content-type") ?? "";
      capturedBody = init?.body;
      return jsonResponse({ hasYoutubeCookie: true, youtubeCookieUpdatedAt: "2026-10-18T12:00:00Z" });
    });
    const { uploadYoutubeCookie } = await load();
    const out = await uploadYoutubeCookie(raw);

    expect(capturedUrl).toBe("/api/settings/youtube-cookie");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toContain("text/plain");
    // The body is the file itself, not a JSON envelope around it: the route
    // validates the raw Netscape text and would 415 anything else.
    expect(capturedBody).toBe(raw);
    expect(out.hasYoutubeCookie).toBe(true);
  });

  it("deletes the cookie with DELETE and reads the test-llm answer as a 200", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({ ok: true, latencyMs: 42 });
    });
    const { deleteYoutubeCookie, testLlm } = await load();
    await deleteYoutubeCookie();
    await expect(testLlm()).resolves.toEqual({ ok: true, latencyMs: 42 });
    expect(calls).toEqual([
      { url: "/api/settings/youtube-cookie", method: "DELETE" },
      { url: "/api/settings/test-llm", method: "POST" },
    ]);
  });
});

describe("ingest calls", () => {
  it("posts the YouTube preview body and resolves the server's numbers", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({
        found: 12,
        selected: 9,
        skipped: [],
        estimatedCalls: 9,
        estimatedMinutes: 4,
      });
    });
    const { previewJob } = await load();
    const out = await previewJob({
      kind: "youtube",
      channelUrl: "https://www.youtube.com/@studio",
      maxVideos: 10,
      language: "en",
    });
    expect(JSON.parse(capturedBody)).toEqual({
      kind: "youtube",
      channelUrl: "https://www.youtube.com/@studio",
      maxVideos: 10,
      language: "en",
    });
    // No browser-side estimate: the numbers are the response's own.
    expect(out.estimatedCalls).toBe(9);
    expect(out.estimatedMinutes).toBe(4);
  });

  it("never attaches a video-only field to a strict web body", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ found: 1, selected: 1, skipped: [], estimatedCalls: 8, estimatedMinutes: 4 });
    });
    const { previewJob } = await load();
    await previewJob({
      kind: "web",
      url: "https://example.com/page",
      // The route's web arm is `.strict()`; these must not be sent even if a
      // caller hands them over.
      maxVideos: 5,
      dateFrom: "2026-01-01",
      minDurationSec: 60,
    });
    expect(JSON.parse(capturedBody)).toEqual({ kind: "web", url: "https://example.com/page" });
  });

  it("starts a job through POST /api/jobs and resolves id and status", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return jsonResponse({ id: "j_20261018_abcdef", status: "queued" }, 202);
    });
    const { startJob } = await load();
    const out = await startJob({
      vaultId: "v1",
      kind: "youtube",
      channelUrl: "https://www.youtube.com/@studio",
      maxVideos: 10,
    });
    expect(JSON.parse(capturedBody)).toEqual({
      vaultId: "v1",
      kind: "youtube",
      channelUrl: "https://www.youtube.com/@studio",
      maxVideos: 10,
    });
    expect(out).toEqual({ id: "j_20261018_abcdef", status: "queued" });
  });
});

describe("request helper (no real network)", () => {
  it("never performs a real network call (fetch is stubbed, URL is same-origin relative)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse([]);
    });
    const { listVaults } = await load();
    await listVaults();
    expect(calls.length).toBe(1);
    // The URL is a same-origin relative path, not an absolute http(s) URL.
    expect(calls[0]).not.toMatch(/^https?:\/\//);
    expect(calls[0]).toContain("/api/vaults");
  });
});