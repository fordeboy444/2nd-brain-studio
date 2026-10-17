import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Vault } from "./api.js";

// We import the module under test fresh per case so stubs are isolated. The
// RED phase: api.ts does not exist yet, so this import fails and every test
// errors — that is the expected RED state. GREEN lands when api.ts implements
// the contract below.

async function load() {
  return (await import("./api.js")) as typeof import("./api.js");
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Default stub: a 200 JSON response. Individual tests override.
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

describe("listVaults", () => {
  it("issues GET /api/vaults and resolves to the parsed array", async () => {
    const data = [{ id: "a", name: "A", path: "a", sourceKind: "manual", createdAt: "x", lastOpenedAt: "x" }];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = new Request(input);
      expect(req.method).toBe("GET");
      expect(String(req.url)).toContain("/api/vaults");
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
      const req = new Request(input, init);
      capturedMethod = req.method;
      capturedUrl = String(req.url);
      capturedContentType = req.headers.get("content-type") ?? "";
      capturedBody = await req.text();
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
      const req = new Request(input, init);
      capturedBody = await req.text();
      return jsonResponse({ id: "t", name: "T", path: "t", sourceKind: "manual", createdAt: "t", lastOpenedAt: "t" }, 201);
    });
    const { createVault } = await load();
    await createVault("  T  ");
    expect(JSON.parse(capturedBody)).toEqual({ name: "T" });
  });
});

describe("request helper (no real network)", () => {
  it("never performs a real network call (fetch is stubbed)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse([]);
    });
    const { listVaults } = await load();
    await listVaults();
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toMatch(/^https?:\/\//);
  });
});