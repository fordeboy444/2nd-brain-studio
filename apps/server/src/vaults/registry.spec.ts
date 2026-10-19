import { mkdtemp, readFile, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_ENV = { ...process.env };

async function reload() {
  vi.resetModules();
  return (await import("./registry.js")) as typeof import("./registry.js");
}

let root = "";

beforeEach(async () => {
  delete process.env.VAULT_ROOT;
  root = await mkdtemp(join(tmpdir(), "vreg-"));
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

describe("registry", () => {
  it("readRegistry returns the empty envelope when the file is absent", async () => {
    const { readRegistry } = await reload();
    const reg = await readRegistry();
    expect(reg.version).toBe(1);
    expect(reg.vaults).toEqual([]);
  });

  it("a schema-mismatched registry fails loudly instead of becoming empty", async () => {
    const { createVault, readRegistry } = await reload();
    // A valid registry with one entry, then a future-version envelope.
    await createVault({ name: "Real Vault" });
    const valid = await readRegistry();
    expect(valid.vaults).toHaveLength(1);

    const invalid = JSON.stringify({ version: 2, vaults: valid.vaults });
    await writeFile(join(root, "vaults.json"), invalid, "utf8");

    // Returning an empty envelope here would make the next write erase every
    // entry. The read must refuse instead.
    await expect(readRegistry()).rejects.toMatchObject({
      code: "registry_invalid",
    });
    // The file is untouched: no recovery write happened.
    expect(JSON.parse(await readFile(join(root, "vaults.json"), "utf8"))).toEqual({
      version: 2,
      vaults: valid.vaults,
    });
  });

  it("malformed JSON fails with registry_invalid and leaves the bytes alone", async () => {
    const { readRegistry } = await reload();
    const raw = '{"version":1,"vaults":[';
    await writeFile(join(root, "vaults.json"), raw, "utf8");

    // A SyntaxError carries no code; without its own catch the outer rethrow
    // would bypass the routes' typed `registry_invalid` answer.
    await expect(readRegistry()).rejects.toMatchObject({
      code: "registry_invalid",
    });
    expect(await readFile(join(root, "vaults.json"), "utf8")).toBe(raw);
  });

  it("writeRegistryAtomic writes and leaves no tmp file behind", async () => {
    const { writeRegistryAtomic, readRegistry } = await reload();
    await writeRegistryAtomic({ version: 1, vaults: [] });
    const reg = await readRegistry();
    expect(reg.vaults).toEqual([]);
    const entries = await readdir(root);
    expect(entries).toEqual(["vaults.json"]);
    expect(entries.find((e) => e.includes(".tmp"))).toBeUndefined();
  });

  it("listVaults returns [] (never null) with 200-shape on empty", async () => {
    const { listVaults } = await reload();
    const list = await listVaults();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([]);
  });

  it("createVault produces a scaffolded dir and one registry entry; id===path===slugify(name)", async () => {
    const { createVault, listVaults, vaultDirPath } = await reload();
    const v = await createVault({ name: "My First Vault" });
    expect(v.id).toBe("my-first-vault");
    expect(v.path).toBe("my-first-vault");
    expect(v.name).toBe("My First Vault");
    const dir = vaultDirPath(v.id);
    const st = await stat(dir);
    expect(st.isDirectory()).toBe(true);
    const list = await listVaults();
    expect(list).toHaveLength(1);
  });

  it("creating the same name twice fails the second time and leaves one dir + one entry", async () => {
    const { createVault, listVaults, vaultDirPath } = await reload();
    await createVault({ name: "Café Notes" });
    await expect(createVault({ name: "Café Notes" })).rejects.toThrow();
    const list = await listVaults();
    expect(list).toHaveLength(1);
    // Exactly one directory on the volume.
    const dirs = (await readdir(root)).filter((e) => e !== "vaults.json");
    expect(dirs).toEqual(["cafe-notes"]);
    void vaultDirPath;
  });

  it("two names that slugify the same cannot both exist; two distinct slugs produce two entries", async () => {
    const { createVault, listVaults } = await reload();
    await createVault({ name: "Café" });
    await expect(createVault({ name: "cafe" })).rejects.toThrow();
    await createVault({ name: "Other Vault" });
    const list = await listVaults();
    expect(list).toHaveLength(2);
  });

  it("orders vaults by lastOpenedAt desc, ties broken by name asc", async () => {
    const { createVault, touchVault, listVaults, readRegistry, writeRegistryAtomic } = await reload();
    const a = await createVault({ name: "Alpha" });
    const b = await createVault({ name: "Beta" });
    const c = await createVault({ name: "Gamma" });
    // Make Beta the most recently opened, then Alpha, then Gamma.
    await touchVault(b.id);
    await touchVault(a.id);
    // Gamma stays oldest.
    const list = await listVaults();
    expect(list.map((v) => v.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    // Force a tie: set Alpha and Beta lastOpenedAt equal, names asc => Alpha before Beta.
    const reg = await readRegistry();
    const alpha = reg.vaults.find((v) => v.id === a.id)!;
    const beta = reg.vaults.find((v) => v.id === b.id)!;
    const tied = "2026-10-17T00:00:00.000Z";
    alpha.lastOpenedAt = tied;
    beta.lastOpenedAt = tied;
    const gamma = reg.vaults.find((v) => v.id === c.id)!;
    gamma.lastOpenedAt = "2026-10-18T00:00:00.000Z"; // Gamma newest
    await writeRegistryAtomic(reg);
    const ordered = await listVaults();
    expect(ordered.map((v) => v.name)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("vaults.json is written atomically (survives a re-read after write)", async () => {
    const { createVault, readRegistry } = await reload();
    await createVault({ name: "Persist Test" });
    const reg = await readRegistry();
    expect(reg.vaults).toHaveLength(1);
    // Raw file on disk is valid JSON.
    const raw = await readFile(join(root, "vaults.json"), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("a non-Latin-only name fails with a name-specific code, not an empty slug", async () => {
    const { createVault, listVaults } = await reload();
    let caught: unknown = null;
    try {
      await createVault({ name: "日本語" });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe("invalid_name");
    expect((caught as Error).message).toContain("Latin");
    // Nothing was scaffolded or registered.
    expect(await listVaults()).toEqual([]);
  });

  it("errors name the vault, never the host path", async () => {
    const { createVault } = await reload();
    await createVault({ name: "Dup Name" });
    let errMsg = "";
    try {
      await createVault({ name: "Dup Name" });
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg).toContain("Dup Name");
    // The host absolute path must not appear in the error.
    expect(errMsg).not.toContain(root);
  });
});