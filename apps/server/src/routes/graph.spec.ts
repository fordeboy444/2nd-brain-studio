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
  root = await mkdtemp(join(tmpdir(), "graph-"));
  process.env.VAULT_ROOT = root;
  webDist = await mkdtemp(join(tmpdir(), "graph-web-"));
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

describe("GET /api/vaults/:id/graph", () => {
  it("returns 404 for unknown vault", async () => {
    const { app } = await reloadApp();
    const res = await app.request("/api/vaults/ghost/graph");
    expect(res.status).toBe(404);
  });

  it("extracts typed nodes and typed edges based on OKF links", async () => {
    const { app } = await reloadApp();
    const vaultId = await createVaultViaApi(app, "Graph Vault");
    const vaultDir = join(root, vaultId);

    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await mkdir(join(vaultDir, "sources"), { recursive: true });

    await writeFile(
      join(vaultDir, "concepts", "node-a.md"),
      `---
title: Concept Alpha
type: concept
---
# Concept Alpha

Here is a self reference [Concept Alpha](node-a.md) that should be ignored.
Here is a dangling ref [Missing](missing.md) that should be ignored.

## Related Concepts
- [Concept Beta](node-b.md)
`,
      "utf-8",
    );

    await writeFile(
      join(vaultDir, "concepts", "node-b.md"),
      `---
title: Concept Beta
type: concept
---
# Concept Beta
`,
      "utf-8",
    );

    await writeFile(
      join(vaultDir, "sources", "vid.md"),
      `---
title: Video Source
type: source
---
# Video Source

## Mentions
Link to [Alpha](../concepts/node-a.md)
`,
      "utf-8",
    );

    const res = await app.request(`/api/vaults/${vaultId}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.nodes).toBeDefined();
    expect(body.edges).toBeDefined();

    const nodeA = body.nodes.find((n: any) => n.id === "concepts/node-a.md");
    expect(nodeA).toEqual({
      id: "concepts/node-a.md",
      label: "Concept Alpha",
      type: "concept",
      path: "concepts/node-a.md",
    });

    const nodeB = body.nodes.find((n: any) => n.id === "concepts/node-b.md");
    expect(nodeB).toBeDefined();

    // Check edge kind derived from heading
    const edgeToBeta = body.edges.find((e: any) => e.source === "concepts/node-a.md" && e.target === "concepts/node-b.md");
    expect(edgeToBeta).toBeDefined();
    expect(edgeToBeta.kind).toBe("concept"); // Heading was "## Related Concepts" -> contains "concept"

    // Vid to Alpha edge
    const edgeVidToA = body.edges.find((e: any) => e.source === "sources/vid.md" && e.target === "concepts/node-a.md");
    expect(edgeVidToA).toBeDefined();
    expect(edgeVidToA.kind).toBe("link"); // Heading was "Mentions" -> default "link"

    // Ensure self-loops and dangling edges are omitted
    expect(body.edges.some((e: any) => e.source === e.target)).toBe(false);
    expect(body.edges.some((e: any) => e.target.includes("missing"))).toBe(false);

    expect(JSON.stringify(body)).not.toContain(root);
  });
});
