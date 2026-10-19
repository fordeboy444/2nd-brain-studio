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
  root = await mkdtemp(join(tmpdir(), "frontmatter-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "frontmatter-web-"));
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

describe("GET /api/vaults/:id/frontmatter", () => {
  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/frontmatter");
    expect(res.status).toBe(404);
  });

  it("indexes frontmatter across all markdown files in vault", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "FM Vault");
    const vaultDir = join(root, vaultId);

    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(
      join(vaultDir, "concepts", "topic.md"),
      `---
title: Topic A
type: concept
tags: [alpha, beta]
---
# Topic A Content`,
      "utf-8",
    );

    await writeFile(
      join(vaultDir, "plain.md"),
      `# No frontmatter here`,
      "utf-8",
    );

    await mkdir(join(vaultDir, ".okf"), { recursive: true });
    await writeFile(join(vaultDir, ".okf", "config.md"), "---\nsecret: 123\n---", "utf-8");

    const res = await app.request(`/api/vaults/${vaultId}/frontmatter`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.files).toBeDefined();
    expect(body.files["concepts/topic.md"]).toEqual({
      title: "Topic A",
      type: "concept",
      tags: ["alpha", "beta"],
    });
    expect(body.files["plain.md"]).toEqual({});
    expect(body.files[".okf/config.md"]).toBeUndefined();

    expect(JSON.stringify(body)).not.toContain(root);
  });
});
