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
  root = await mkdtemp(join(tmpdir(), "backlinks-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "backlinks-web-"));
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

describe("GET /api/vaults/:id/backlinks", () => {
  it("rejects missing file param with 400", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Backlinks Vault");

    const res = await app.request(`/api/vaults/${vaultId}/backlinks`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_path");
  });

  it("rejects path traversal with 400", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Backlinks Vault");

    const res = await app.request(`/api/vaults/${vaultId}/backlinks?file=${encodeURIComponent("../etc/passwd")}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_path");
  });

  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/backlinks?file=concepts/indexing.md");
    expect(res.status).toBe(404);
  });

  it("finds inbound links with heading context and resolves relative links", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Backlinks Vault");
    const vaultDir = join(root, vaultId);

    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await mkdir(join(vaultDir, "sources"), { recursive: true });

    // Target file
    await writeFile(
      join(vaultDir, "concepts", "indexing.md"),
      `# Indexing\nDetails on indexing.`,
      "utf-8",
    );

    // Source 1 linking to target via relative path
    await writeFile(
      join(vaultDir, "sources", "vid1.md"),
      `# Source Video\n\n## Mentions\nIn this video we talk about [Indexing Concept](../concepts/indexing.md).`,
      "utf-8",
    );

    // Source 2 linking to target without heading
    await writeFile(
      join(vaultDir, "notes.md"),
      `Reference: [Indexing](concepts/indexing.md) is essential.`,
      "utf-8",
    );

    const res = await app.request(`/api/vaults/${vaultId}/backlinks?file=concepts/indexing.md`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.target).toBe("concepts/indexing.md");
    expect(body.backlinks).toHaveLength(2);

    const fromVid = body.backlinks.find((b: any) => b.source === "sources/vid1.md");
    expect(fromVid).toBeDefined();
    expect(fromVid.heading).toBe("Mentions");
    expect(fromVid.text).toBe("Indexing Concept");

    const fromNotes = body.backlinks.find((b: any) => b.source === "notes.md");
    expect(fromNotes).toBeDefined();
    expect(fromNotes.text).toBe("Indexing");

    // No host path leaks
    expect(JSON.stringify(body)).not.toContain(root);
  });
});
