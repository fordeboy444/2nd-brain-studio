import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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
  root = await mkdtemp(join(tmpdir(), "reindex-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "reindex-web-"));
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
  const { InstanceLockManager, setLockManagerForTesting } = await import("../lock.js");
  setLockManagerForTesting(new InstanceLockManager());

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

describe("POST /api/vaults/:id/reindex", () => {
  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/reindex", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("executes buildIndexes and updates index.md", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Reindex Vault");
    const vaultDir = join(root, vaultId);

    // Add a concept file with frontmatter
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(
      join(vaultDir, "concepts", "my-topic.md"),
      `---
title: My Cool Topic
type: concept
tags: [alpha]
---
# My Cool Topic
Details about cool topic.
`,
      "utf-8",
    );

    const res = await app.request(`/api/vaults/${vaultId}/reindex`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.updated).toContain("index.md");

    // Verify concepts/index.md on disk contains reference to My Cool Topic
    const indexContent = await readFile(join(vaultDir, "concepts", "index.md"), "utf-8");
    expect(indexContent).toContain("My Cool Topic");
  });

  it("rejects reindex with 403 when instance is read-only", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Reindex Vault");

    // Turn on read-only mode via mock
    const { InstanceLockManager, setLockManagerForTesting } = await import("../lock.js");
    const mockManager = {
      getLockState: () => ({
        isReadOnly: true,
        lockHolder: { pid: 99999, host: "primary", startedAt: 1000, heartbeatAt: 2000 },
      }),
    } as unknown as InstanceLockManager;
    setLockManagerForTesting(mockManager);

    const res = await app.request(`/api/vaults/${vaultId}/reindex`, { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("read_only");
  });
});
