import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(HERE, "app.ts");

// A directory this spec owns. A cwd-relative `apps/web/dist` would make the
// suite delete a real build it did not create, and would race the other specs
// that used the same path.
let WEB_DIST = "";
let INDEX_HTML = "";

beforeEach(() => {
  // Create a minimal built SPA so the app mounts the static + SPA fallback.
  WEB_DIST = mkdtempSync(join(tmpdir(), "web-dist-app-"));
  INDEX_HTML = join(WEB_DIST, "index.html");
  process.env.WEB_DIST_DIR = WEB_DIST;
  writeFileSync(
    INDEX_HTML,
    "<!doctype html><html><body><div id=root></div></body></html>",
  );
});

afterEach(() => {
  rmSync(WEB_DIST, { recursive: true, force: true });
  delete process.env.WEB_DIST_DIR;
});

async function reload() {
  vi.resetModules();
  return (await import("./app.js")) as typeof import("./app.js");
}

describe("http app", () => {
  it("GET /api/health answers 200 with a json body and an ok boolean", async () => {
    const { app } = await reload();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ok).toBe("boolean");
    expect(body.status === "healthy" || body.status === "degraded").toBe(true);
  });

  it("GET / returns text/html when the web build exists", async () => {
    const { app } = await reload();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<div id=root>");
  });

  it("an unknown /api/* path returns JSON 404, not the SPA HTML", async () => {
    const { app } = await reload();
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("a missing /assets/* file returns 404, not the SPA HTML", async () => {
    const { app } = await reload();
    const res = await app.request("/assets/missing.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect((await res.json()).error).toBe("not_found");
  });

  it("a missing favicon returns 404, not the SPA HTML", async () => {
    const { app } = await reload();
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(404);
  });

  it("rejects an oversized declared content-length with 413 before parsing (WR-11)", async () => {
    const { app } = await reload();
    const res = await app.request("/api/nope", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
      body: "{}",
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
  });

  it("rejects an oversized chunked body while reading it (WR-11)", async () => {
    const { app } = await reload();
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 17 * 64 KiB is just over the 1 MiB cap and has no content-length.
        for (let i = 0; i < 17; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await app.request("/api/nope", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("contains no CORS middleware (grep-verifiable here by behaviour)", async () => {
    const src = readFileSync(APP_SRC, "utf8");
    expect(src.toLowerCase()).not.toContain("cors");
  });
});
describe("auth gate", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    // An admin token in the environment is the whole credential set Task 1
    // installs: no `/data` file is read when the env var is present.
    process.env.BRAIN_ADMIN_TOKEN = "test-admin";
    delete process.env.AUTH_TEST_BYPASS;
    // An empty vault root keeps the authenticated request off `/data`.
    process.env.VAULT_ROOT = WEB_DIST;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIG_ENV)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(ORIG_ENV)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it("rejects a gated read with 401 and a Bearer challenge when no credential is sent", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("accepts the admin token as a Bearer credential on a gated read", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults", {
      headers: { authorization: "Bearer test-admin" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("rejects a wrong Bearer token without falling back to a cookie", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults", {
      headers: {
        authorization: "Bearer nope",
        cookie: "brain_session=forged.signature",
      },
    });
    expect(res.status).toBe(401);
  });

  it("leaves health public and keeps unknown /api paths at 404", async () => {
    const { app } = await reload();
    expect((await app.request("/api/health")).status).toBe(200);
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("still answers 413 for an oversized body before authentication runs", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
      body: "{}",
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });
});
