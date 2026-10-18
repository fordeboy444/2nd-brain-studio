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
  root = await mkdtemp(join(tmpdir(), "tree-"));
  process.env.VAULT_ROOT = root;
  // A directory this spec owns: a shared apps/web/dist fixture would be
  // deleted by parallel specs mid-test.
  webDist = await mkdtemp(join(tmpdir(), "tree-web-"));
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

describe("GET /api/vaults/:id/tree", () => {
  it("returns one ordered level with .okf/ and dot entries pruned", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Tree Vault");
    const vaultDir = join(root, vaultId);
    // createVault scaffolds concepts/, entities/, raw/, sources/ + 4 md files.
    // Add a .okf dir and a dot file to prove pruning, and a nested file to
    // prove one-level listing.
    await mkdir(join(vaultDir, ".okf"), { recursive: true });
    await writeFile(join(vaultDir, ".scratch"), "x");
    await writeFile(join(vaultDir, "concepts", "nested.md"), "x");

    const res = await app.request(`/api/vaults/${vaultId}/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dir).toBe(".");
    const names = body.entries.map((e: { name: string }) => e.name);
    // Dot entries pruned.
    expect(names).not.toContain(".okf");
    expect(names).not.toContain(".scratch");
    // The nested file is NOT listed at this level (one level only).
    expect(names).not.toContain("nested.md");
    // Directories come before files; scaffold dirs are present.
    expect(names).toContain("concepts");
    expect(names).toContain("sources");
    const firstFileIdx = names.findIndex((n: string) => n.endsWith(".md"));
    const lastDirIdx = names.map((n: string, i: number) => ({ n, i }))
      .filter((x) => !x.n.endsWith(".md"))
      .map((x) => x.i)
      .pop();
    expect(lastDirIdx).toBeGreaterThan(-1);
    expect(firstFileIdx).toBeGreaterThan(lastDirIdx!);
  });

  it("drills into a subdirectory with dir= and returns vault-relative paths", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Tree Vault");
    const vaultDir = join(root, vaultId);
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, "concepts", "a.md"), "x");
    await writeFile(join(vaultDir, "concepts", "b.md"), "x");

    const res = await app.request(`/api/vaults/${vaultId}/tree?dir=concepts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dir).toBe("concepts");
    const paths = body.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(["concepts/a.md", "concepts/b.md"]);
  });

  it("an unknown vault id returns 404", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/tree");
    expect(res.status).toBe(404);
  });

  it("a traversal probe returns 400 with the fixed message and no absolute path", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Tree Vault");
    const res = await app.request(`/api/vaults/${vaultId}/tree?dir=${encodeURIComponent("../escape")}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe("Invalid path.");
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("a dir naming a file returns 400", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Tree Vault");
    await writeFile(join(root, vaultId, "afile.md"), "x");
    const res = await app.request(`/api/vaults/${vaultId}/tree?dir=afile.md`);
    expect(res.status).toBe(400);
  });

  it("no response body contains an absolute host path", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Tree Vault");
    await mkdir(join(root, vaultId, "concepts"), { recursive: true });
    await writeFile(join(root, vaultId, "concepts", "note.md"), "x");
    const res = await app.request(`/api/vaults/${vaultId}/tree`);
    const text = await res.text();
    expect(text).not.toContain(root);
    expect(text).not.toContain(join(root, vaultId));
  });
});