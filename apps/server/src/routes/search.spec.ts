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
  root = await mkdtemp(join(tmpdir(), "search-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "search-web-"));
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

describe("GET /api/vaults/:id/search", () => {
  it("returns empty groups for empty or missing q param", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Search Vault");

    const res1 = await app.request(`/api/vaults/${vaultId}/search`);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ groups: {} });

    const res2 = await app.request(`/api/vaults/${vaultId}/search?q=   `);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ groups: {} });
  });

  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost-vault/search?q=test");
    expect(res.status).toBe(404);
  });

  it("groups matches by frontmatter type with 1-based line numbers and trimmed snippets", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Search Vault");
    const vaultDir = join(root, vaultId);

    // Write a concept file
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(
      join(vaultDir, "concepts", "indexing.md"),
      `---
type: concept
title: Search Indexing
---
# Search Indexing

Full-text search indexing is fast and scalable.
Another line without match.
`,
      "utf-8",
    );

    // Write a source file
    await mkdir(join(vaultDir, "sources"), { recursive: true });
    await writeFile(
      join(vaultDir, "sources", "vid1.md"),
      `---
type: source
title: Video 1
---
# Video 1

Discussing search techniques in depth.
`,
      "utf-8",
    );

    // Write a file without frontmatter (defaults to type "other")
    await writeFile(
      join(vaultDir, "notes.md"),
      `# Scratchpad\nQuick search thoughts.`,
      "utf-8",
    );

    // Write file in .okf (should be ignored)
    await mkdir(join(vaultDir, ".okf"), { recursive: true });
    await writeFile(join(vaultDir, ".okf", "internal.md"), "Hidden search content", "utf-8");

    const res = await app.request(`/api/vaults/${vaultId}/search?q=search`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.groups.concept).toBeDefined();
    expect(body.groups.concept.some((h: any) => h.file === "concepts/indexing.md" && h.line === 3)).toBe(true);
    expect(body.groups.concept.some((h: any) => h.file === "concepts/indexing.md" && h.line === 7)).toBe(true);

    expect(body.groups.source).toBeDefined();
    expect(body.groups.source.some((h: any) => h.file === "sources/vid1.md" && h.line === 7)).toBe(true);

    expect(body.groups.other).toBeDefined();
    expect(body.groups.other.some((h: any) => h.file === "notes.md" && h.line === 2)).toBe(true);

    // Internal .okf ignored
    const allFiles = Object.values(body.groups).flatMap((hits: any) => hits.map((h: any) => h.file));
    expect(allFiles.some((f: any) => f.includes(".okf"))).toBe(false);

    // No absolute path leakage
    const text = JSON.stringify(body);
    expect(text).not.toContain(root);
  });
});
