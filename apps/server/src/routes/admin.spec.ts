import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin API: minting returns the plaintext exactly once, the list never
 * carries it, revocation is immediate, and a scoped principal is refused before
 * any handler runs.
 */

const ORIG_ENV = { ...process.env };

let dir = "";
let storePath = "";

async function reload() {
  vi.resetModules();
  return (await import("./admin.js")) as typeof import("./admin.js");
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(async () => {
  delete process.env.AUTH_TEST_BYPASS;
  dir = await mkdtemp(join(tmpdir(), "admin-route-"));
  storePath = join(dir, "agent-tokens.json");
  process.env.AGENT_TOKENS_PATH = storePath;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("POST /tokens", () => {
  it("mints a token and returns the plaintext once", async () => {
    // The router sits behind `authenticate` in the real app; here the bypass
    // supplies the admin principal it would have stored.
    process.env.AUTH_TEST_BYPASS = "1";
    process.env.NODE_ENV = "test";
    const { admin } = await reload();

    const res = await admin.request("/tokens", post({ name: "my-channel", vaults: ["v1"] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token.startsWith("brain_agent_")).toBe(true);
    expect(body.entry.vaults).toEqual(["v1"]);
    expect(body.entry.tokenHash).toBeUndefined();

    const raw = await readFile(storePath, "utf8");
    expect(raw).not.toContain(body.token);
  });

  it("rejects an empty name or an empty vault list", async () => {
    process.env.AUTH_TEST_BYPASS = "1";
    process.env.NODE_ENV = "test";
    const { admin } = await reload();
    expect((await admin.request("/tokens", post({ name: "", vaults: "*" }))).status).toBe(400);
    expect((await admin.request("/tokens", post({ name: "a", vaults: [] }))).status).toBe(400);
  });
});

describe("GET /tokens", () => {
  it("lists names and scopes but never a hash or token", async () => {
    process.env.AUTH_TEST_BYPASS = "1";
    process.env.NODE_ENV = "test";
    const { admin } = await reload();
    const minted = await admin.request("/tokens", post({ name: "my-channel", vaults: "*" }));
    const { token } = await minted.json();

    const res = await admin.request("/tokens");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("tokenHash");
    const body = JSON.parse(text) as { tokens: Array<{ name: string; vaults: string }> };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.name).toBe("my-channel");
    expect(body.tokens[0]?.vaults).toBe("*");
  });
});

describe("DELETE /tokens/:id", () => {
  it("revokes one token and 404s a repeat", async () => {
    process.env.AUTH_TEST_BYPASS = "1";
    process.env.NODE_ENV = "test";
    const { admin } = await reload();
    const minted = await admin.request("/tokens", post({ name: "a", vaults: "*" }));
    const { tokenId } = await minted.json();

    const res = await admin.request(`/tokens/${tokenId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: tokenId });

    const again = await admin.request(`/tokens/${tokenId}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });
});

describe("the admin gate", () => {
  it("refuses a scoped token principal with 403 before any handler", async () => {
    const { admin } = await reload();
    // Mount the router under a middleware that stores exactly what
    // `authenticate` stores for an agent token.
    const shell = new Hono();
    shell.use("*", async (c, next) => {
      c.set("principal", { kind: "token", id: "tok_1", name: "agent", vaults: ["v1"] });
      await next();
    });
    shell.route("/", admin);

    const res = await shell.request("/tokens");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");

    const create = await shell.request("/tokens", post({ name: "x", vaults: "*" }));
    expect(create.status).toBe(403);
  });

  it("refuses an unauthenticated caller (no bypass, no principal)", async () => {
    const { admin } = await reload();
    const res = await admin.request("/tokens");
    expect(res.status).toBe(403);
  });
});
