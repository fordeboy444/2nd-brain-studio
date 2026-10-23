import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scope enforcement end to end, through the real `app`.
 *
 * Two vaults on a temp root, one agent token scoped to `one`, and the admin
 * token as the control. The scoped credential must see exactly one vault, get
 * 403 everywhere else, and 404 for a job in a vault it cannot read — the same
 * answer the admin gets for a job that does not exist.
 */

const ORIG_ENV = { ...process.env };

const SCOPED_TOKEN = "brain_agent_scoped";
const ADMIN_TOKEN = "admin-token";

let root = "";
let webDist = "";

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function reload() {
  vi.resetModules();
  return (await import("../http/app.js")) as typeof import("../http/app.js");
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  delete process.env.AUTH_TEST_BYPASS;
  process.env.NODE_ENV = "test";
  root = await mkdtemp(join(tmpdir(), "scope-root-"));
  webDist = await mkdtemp(join(tmpdir(), "scope-dist-"));
  await writeFile(
    join(webDist, "index.html"),
    "<!doctype html><html><body><div id=root></div></body></html>",
    "utf8",
  );

  process.env.WEB_DIST_DIR = webDist;
  process.env.VAULT_ROOT = root;
  process.env.BRAIN_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AGENT_TOKENS_PATH = join(root, "agent-tokens.json");

  await mkdir(join(root, "one"), { recursive: true });
  await mkdir(join(root, "two"), { recursive: true });
  await writeFile(join(root, "one", "Note.md"), "# One\n", "utf8");

  const stamp = "2026-01-01T00:00:00Z";
  await writeFile(
    join(root, "vaults.json"),
    JSON.stringify({
      version: 1,
      vaults: [
        { id: "one", name: "One", path: "one", sourceKind: "manual", createdAt: stamp, lastOpenedAt: stamp },
        { id: "two", name: "Two", path: "two", sourceKind: "manual", createdAt: stamp, lastOpenedAt: stamp },
      ],
    }),
    "utf8",
  );

  await writeFile(
    process.env.AGENT_TOKENS_PATH,
    JSON.stringify({
      version: 1,
      tokens: [
        {
          id: "tok_scoped",
          name: "my-channel",
          tokenHash: hash(SCOPED_TOKEN),
          vaults: ["one"],
          createdAt: stamp,
        },
      ],
    }),
    "utf8",
  );
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  await rm(webDist, { recursive: true, force: true });
});

describe("a token scoped to one vault", () => {
  it("lists only its vault", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults", { headers: bearer(SCOPED_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((v) => v.id)).toEqual(["one"]);
  });

  it("reads its own tree and is refused another vault's", async () => {
    const { app } = await reload();
    const own = await app.request("/api/vaults/one/tree", { headers: bearer(SCOPED_TOKEN) });
    expect(own.status).toBe(200);

    const other = await app.request("/api/vaults/two/tree", { headers: bearer(SCOPED_TOKEN) });
    expect(other.status).toBe(403);
    expect((await other.json()).error).toBe("forbidden");
  });

  it("reads a file in its vault and is refused one outside it", async () => {
    const { app } = await reload();
    const own = await app.request("/api/file?vault=one&path=Note.md", {
      headers: bearer(SCOPED_TOKEN),
    });
    expect(own.status).toBe(200);

    const other = await app.request("/api/file?vault=two&path=Note.md", {
      headers: bearer(SCOPED_TOKEN),
    });
    expect(other.status).toBe(403);
    // The forbidden answer is the same whether or not the vault exists: no
    // existence oracle.
    const ghost = await app.request("/api/file?vault=ghost&path=Note.md", {
      headers: bearer(SCOPED_TOKEN),
    });
    expect(ghost.status).toBe(403);
  });

  it("answers 404 for a job in another vault, like an unknown job", async () => {
    const { app } = await reload();
    const res = await app.request("/api/jobs/j_20260101_abcdef", {
      headers: bearer(SCOPED_TOKEN),
    });
    expect(res.status).toBe(404);
  });

  it("is refused vault creation, settings and an out-of-scope job filter", async () => {
    const { app } = await reload();
    const create = await app.request("/api/vaults", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(SCOPED_TOKEN) },
      body: JSON.stringify({ name: "New" }),
    });
    expect(create.status).toBe(403);

    const settings = await app.request("/api/settings", { headers: bearer(SCOPED_TOKEN) });
    expect(settings.status).toBe(403);

    const jobs = await app.request("/api/jobs?vaultId=two", { headers: bearer(SCOPED_TOKEN) });
    expect(jobs.status).toBe(403);

    const admin = await app.request("/api/admin/tokens", { headers: bearer(SCOPED_TOKEN) });
    expect(admin.status).toBe(403);
  });
});

describe("the admin token", () => {
  it("sees every vault", async () => {
    const { app } = await reload();
    const res = await app.request("/api/vaults", { headers: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((v) => v.id).sort()).toEqual(["one", "two"]);
  });

  it("mints, lists and revokes through the admin API", async () => {
    const { app } = await reload();
    const created = await app.request("/api/admin/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(ADMIN_TOKEN) },
      body: JSON.stringify({ name: "agent", vaults: "*" }),
    });
    expect(created.status).toBe(201);
    const { token, tokenId } = (await created.json()) as { token: string; tokenId: string };

    const list = await app.request("/api/admin/tokens", { headers: bearer(ADMIN_TOKEN) });
    expect(list.status).toBe(200);

    const revoked = await app.request(`/api/admin/tokens/${tokenId}`, {
      method: "DELETE",
      headers: bearer(ADMIN_TOKEN),
    });
    expect(revoked.status).toBe(200);

    // Revocation takes effect on the very next request.
    const after = await app.request("/api/vaults", { headers: bearer(token) });
    expect(after.status).toBe(401);
  });
});
