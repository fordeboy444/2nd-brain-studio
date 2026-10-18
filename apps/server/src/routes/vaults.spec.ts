import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

async function createVault(router: Awaited<ReturnType<typeof reload>>["vaults"], name: string): Promise<string> {
  const res = await router.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

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

  it("rejects a non-Latin-only name with 400 and a name-specific message", async () => {
    const { vaults } = await reload();
    const res = await vaults.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "日本語" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_name");
    expect(body.message).toContain("Latin");
    // No directory was created for the refused name.
    expect((await readdir(root)).filter((e) => e !== "vaults.json")).toEqual([]);
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

describe("DELETE /api/vaults/:id", () => {
  it("a mismatched confirmName returns 400 and leaves the vault directory on disk", async () => {
    const { vaults } = await reload();
    const vaultId = await createVault(vaults, "Real Name");
    const vaultDir = join(root, vaultId);
    expect(existsSync(vaultDir)).toBe(true);

    const res = await vaults.request(`/${vaultId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "Wrong Name" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirm_mismatch");
    // The vault directory still exists.
    expect(existsSync(vaultDir)).toBe(true);
  });

  it("a missing confirmName returns 400 and removes nothing", async () => {
    const { vaults } = await reload();
    const vaultId = await createVault(vaults, "Keep Me");
    const vaultDir = join(root, vaultId);

    const res = await vaults.request(`/${vaultId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(existsSync(vaultDir)).toBe(true);
  });

  it("a matching confirmName returns 200 with {deleted, id} and removes the directory", async () => {
    const { vaults } = await reload();
    const vaultId = await createVault(vaults, "Delete Me");
    const vaultDir = join(root, vaultId);

    const res = await vaults.request(`/${vaultId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "Delete Me" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(vaultId);
    expect(existsSync(vaultDir)).toBe(false);
  });

  it("two sequential deletes produce 200 then 404; the registry afterwards has no entry for the id", async () => {
    const { vaults } = await reload();
    const vaultId = await createVault(vaults, "Once Only");

    const first = await vaults.request(`/${vaultId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "Once Only" }),
    });
    expect(first.status).toBe(200);

    // The second delete is the 404 case, NOT 500 — idempotent under repetition.
    const second = await vaults.request(`/${vaultId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: "Once Only" }),
    });
    expect(second.status).toBe(404);
    expect((await second.json()).error).toBe("not_found");

    // The registry file contains no entry for this id.
    const reg = JSON.parse(await readFile(join(root, "vaults.json"), "utf8"));
    expect(reg.vaults.some((v: { id: string }) => v.id === vaultId)).toBe(false);

    // The second delete did NOT recreate the directory.
    expect(existsSync(join(root, vaultId))).toBe(false);
  });
});