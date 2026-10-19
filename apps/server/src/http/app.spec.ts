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

  it("contains no CORS middleware (grep-verifiable here by behaviour)", async () => {
    const src = readFileSync(APP_SRC, "utf8");
    expect(src.toLowerCase()).not.toContain("cors");
  });
});