import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_ENV = { ...process.env };

async function reload() {
  vi.resetModules();
  return (await import("./vaults.js")) as typeof import("./vaults.js");
}

let root = "";

beforeEach(async () => {
  delete process.env.VAULT_ROOT;
  root = await mkdtemp(join(tmpdir(), "vroutes-"));
  process.env.VAULT_ROOT = root;
});

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/vaults", () => {
  it("returns 200 with an empty array on an empty registry", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("never returns null or 404 on an empty registry", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/");
    expect(res.status).not.toBe(404);
    expect(body_isArray(await res.json())).toBe(true);
    function body_isArray(b: unknown): boolean {
      return Array.isArray(b);
    }
  });
});

describe("POST /api/vaults", () => {
  it("creates a vault and returns 201 with the record", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Vault" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("My Vault");
    expect(body.id).toBe("my-vault");
    expect(body.path).toBe("my-vault");
  });

  it("rejects an empty name with 400", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body with 400", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 naming the collision when the slug already exists", async () => {
    const { vaults } = await reload();
    await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Café" }),
    });
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cafe" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("slug_collision");
    expect(typeof body.message).toBe("string");
    // The message names the vault, not the host path.
    expect(body.message).not.toContain(root);
  });

  it("trims a name with surrounding whitespace before creating", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Trimmed Vault  " }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Trimmed Vault");
  });

  it("a created vault appears in the list without a reload", async () => {
    const { vaults } = await reload();
    await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Listed" }),
    });
    const list = await vaults.request("/");
    const arr = await list.json();
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe("Listed");
  });

  it("two creates with distinct slugs leave two directories on the volume", async () => {
    const { vaults } = await reload();
    await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "One Vault" }),
    });
    await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Two Vault" }),
    });
    const dirs = (await readdir(root)).filter((e) => e !== "vaults.json");
    expect(dirs.sort()).toEqual(["one-vault", "two-vault"]);
  });
});