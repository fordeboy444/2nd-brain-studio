import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_ENV = { ...process.env };
let root = "";
let webDist = "";

async function reloadApp() {
  vi.resetModules();
  return (await import("../http/app.js")) as typeof import("../http/app.js");
}

beforeEach(async () => {
  delete process.env.VAULT_ROOT;
  root = await mkdtemp(join(tmpdir(), "lint-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "lint-web-"));
  process.env.WEB_DIST_DIR = webDist;
  await writeFile(
    join(webDist, "index.html"),
    "<!doctype html><html><body><div id=root></div></body></html>",
  );
});

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(webDist, { recursive: true, force: true });
});

async function createVaultViaApi(app: Awaited<ReturnType<typeof reloadApp>>["app"], name: string): Promise<string> {
  const res = await app.request("/api/vaults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe("GET & POST /api/vaults/:id/lint", () => {
  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/lint");
    expect(res.status).toBe(404);
  });

  it("lints a clean vault successfully via GET and POST", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Lint Vault");

    // Default scaffold has index.md and clean files
    const resGet = await app.request(`/api/vaults/${vaultId}/lint`);
    expect(resGet.status).toBe(200);
    const bodyGet = await resGet.json();
    console.log("LINT ERRORS:", JSON.stringify(bodyGet.errors, null, 2));
    expect(bodyGet.ok).toBe(true);
    expect(bodyGet.errors).toEqual([]);
    expect(bodyGet.scanned).toBeGreaterThan(0);

    const resPost = await app.request(`/api/vaults/${vaultId}/lint`, { method: "POST" });
    expect(resPost.status).toBe(200);
    const bodyPost = await resPost.json();
    expect(bodyPost.ok).toBe(true);
    expect(bodyPost.errors).toEqual([]);
  });

  it("reports broken links as lint errors", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Lint Vault");
    const vaultDir = join(root, vaultId);

    // Create a file with a broken link to nonexistent page
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(
      join(vaultDir, "concepts", "broken.md"),
      `---
title: Broken
type: concept
---
# Broken

Here is a [Broken Link](nonexistent.md).
`,
      "utf-8",
    );

    const res = await app.request(`/api/vaults/${vaultId}/lint`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.some((e: any) => e.message?.includes("broken link") || e.message?.includes("concepts/broken.md"))).toBe(true);
  });
});
