import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInVault } from "../paths/jail.js";

/**
 * Concurrency and time-of-check-to-time-of-use invariants.
 *
 * These are the three truths that the sequential specs cannot reach:
 * `vaults.spec.ts` covers create-twice and delete-twice SEQUENTIALLY, and
 * `jail.spec.ts` pins the resolve → boundary → realpath ORDER rather than a
 * swap that lands inside the window. Every assertion here fires two requests
 * with no `await` between them, so the request handlers interleave at their
 * own await points.
 *
 * Node is single-threaded, so the outcome depends on where the first `await`
 * falls inside the handler. The invariants below must hold for EVERY
 * interleaving, which is why the create and delete cases run several rounds.
 */

const ORIG_ENV = { ...process.env };
const ROUNDS = 5;

async function reload() {
  vi.resetModules();
  return (await import("./vaults.js")) as typeof import("./vaults.js");
}

let root = "";

beforeEach(async () => {
  delete process.env.VAULT_ROOT;
  root = await mkdtemp(join(tmpdir(), "vraces-"));
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

type VaultsRouter = Awaited<ReturnType<typeof reload>>["vaults"];

function createVaultRequest(router: VaultsRouter, name: string): Promise<Response> {
  return router.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

async function createVault(router: VaultsRouter, name: string): Promise<string> {
  const res = await createVaultRequest(router, name);
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

/** Top-level vault directories, excluding the registry file and temp files. */
async function vaultDirs(): Promise<string[]> {
  const entries = await readdir(root);
  return entries.filter((e) => e !== "vaults.json" && !e.startsWith(".")).sort();
}

async function registryVaults(): Promise<Array<{ id: string; path: string }>> {
  const raw = await readFile(join(root, "vaults.json"), "utf8");
  return JSON.parse(raw).vaults;
}

describe("two concurrent POST /api/vaults for the same name", () => {
  it("leaves exactly one vault directory and exactly one registry entry, every round", async () => {
    const { vaults } = await reload();

    for (let round = 0; round < ROUNDS; round++) {
      const name = `Race Vault ${round}`;
      const slug = `race-vault-${round}`;

      // No await between the two calls: both handlers are in flight together.
      const [a, b] = await Promise.all([
        createVaultRequest(vaults, name),
        createVaultRequest(vaults, name),
      ]);

      // Neither call may be a 500. The registry lock serializes the two
      // read-modify-write cycles, so the loser sees the winner's entry and
      // reports a slug collision (409).
      expect([a.status, b.status].filter((s) => s === 500)).toEqual([]);
      expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
      expect([a.status, b.status]).toContain(201);

      // Exactly one directory on the volume for this slug.
      const matchingDirs = (await vaultDirs()).filter((d) => d === slug);
      expect(matchingDirs).toEqual([slug]);

      // Exactly one registry entry for this slug, and no duplicate id/path.
      const reg = await registryVaults();
      expect(reg.filter((v) => v.path === slug)).toHaveLength(1);

      // The response the client received is the record that exists on disk.
      const winners = await Promise.all(
        [a, b].filter((r) => r.status === 201).map(async (r) => (await r.json()).id as string),
      );
      expect(new Set(winners)).toEqual(new Set([slug]));
    }

    // Every round's slug exists exactly once; no round clobbered another.
    expect(await vaultDirs()).toHaveLength(ROUNDS);
    expect(await registryVaults()).toHaveLength(ROUNDS);
  });

  it("does not lose a vault when two DIFFERENT names are created at the same time", async () => {
    // Regression guard. Before the registry lock, two concurrent creates each
    // read the registry before either wrote, so the last write won and one
    // vault survived only as an orphan directory — present on disk, absent
    // from the list, and unreachable from the UI.
    const { vaults } = await reload();

    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await Promise.all([
        createVaultRequest(vaults, `Left ${round}`),
        createVaultRequest(vaults, `Right ${round}`),
      ]);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const reg = await registryVaults();
      const ids = reg.map((v) => v.id);
      expect(ids).toContain(`left-${round}`);
      expect(ids).toContain(`right-${round}`);
    }

    // Every vault that answered 201 is listed, and every directory is listed.
    expect(await vaultDirs()).toHaveLength(ROUNDS * 2);
    expect(await registryVaults()).toHaveLength(ROUNDS * 2);
  });
});

describe("two concurrent DELETE /api/vaults/:id calls", () => {
  it("leave no directory and no registry entry, and neither returns 500, every round", async () => {
    const { vaults } = await reload();

    for (let round = 0; round < ROUNDS; round++) {
      const name = `Race Delete ${round}`;
      const vaultId = await createVault(vaults, name);
      expect(existsSync(join(root, vaultId))).toBe(true);

      const del = () =>
        vaults.request(`/${vaultId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmName: name }),
        });

      // No await between the two calls.
      const [a, b] = await Promise.all([del(), del()]);

      // Neither is a 500. One wins the removal (200); the loser is the 404 case,
      // or also a legitimate 200 when both read the entry before either spliced.
      expect([a.status, b.status].filter((s) => s === 500)).toEqual([]);
      expect([a.status, b.status].every((s) => s === 200 || s === 404)).toBe(true);
      expect([a.status, b.status]).toContain(200);

      // Nothing is left on disk and nothing is left in the registry.
      expect(existsSync(join(root, vaultId))).toBe(false);
      const reg = await registryVaults();
      expect(reg.filter((v) => v.id === vaultId)).toHaveLength(0);
    }

    expect(await vaultDirs()).toEqual([]);
    expect(await registryVaults()).toEqual([]);
  });

  it("removes both vaults when two DIFFERENT ids are deleted at the same time", async () => {
    // Regression guard for the sibling lost-update: before the lock, one
    // delete answered 500 and its entry stayed in the registry after its
    // directory was already gone — a ghost row in the vault list.
    const { vaults } = await reload();

    const idA = await createVault(vaults, "Twin A");
    const idB = await createVault(vaults, "Twin B");

    const [a, b] = await Promise.all([
      vaults.request(`/${idA}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: "Twin A" }),
      }),
      vaults.request(`/${idB}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: "Twin B" }),
      }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    expect(existsSync(join(root, idA))).toBe(false);
    expect(existsSync(join(root, idB))).toBe(false);
    expect(await registryVaults()).toEqual([]);
    expect(await vaultDirs()).toEqual([]);
  });
});

describe("the jail's check-to-use window", () => {
  it("rejects a symlink that is already in place when the request arrives", async () => {
    const vaultDir = join(root, "vault");
    await mkdir(vaultDir, { recursive: true });

    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET OUTSIDE THE VAULT");
    await symlink(outside, join(vaultDir, "note.md"));

    // The realpath re-check finds the link's real target outside the vault.
    await expect(resolveInVault(vaultDir, "note.md")).rejects.toMatchObject({
      reason: "outside",
    });
  });

  it("rejects a symlinked PARENT directory that escapes the vault", async () => {
    const vaultDir = join(root, "vault");
    await mkdir(vaultDir, { recursive: true });

    const outsideDir = join(root, "outside-dir");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "note.md"), "SECRET OUTSIDE THE VAULT");
    await symlink(outsideDir, join(vaultDir, "link"));

    await expect(resolveInVault(vaultDir, "link/note.md")).rejects.toMatchObject({
      reason: "outside",
    });
  });

  it("CANARY: a swap made AFTER the re-check decides what the read returns (accepted risk AR-02 / T-01-08)", async () => {
    // This test pins a KNOWN, ACCEPTED limitation rather than a guarantee.
    //
    // `resolveInVault` returns the lexically-resolved `absPath`, not the
    // verified realpath, so the caller writes to the intended path rather than
    // through a symlink target. That choice leaves a window: between the
    // realpath re-check and the `readFile` in the route, an actor with write
    // access INSIDE the vault directory can replace the file with a symlink
    // and the read follows it.
    //
    // The phase register records this as T-01-08, accepted as AR-02 at low
    // severity: reaching it requires write access inside the vault directory,
    // which already implies full compromise of the data the vault holds. The
    // browser cannot plant a symlink — `PUT /api/file` writes bytes through a
    // temp file and a rename.
    //
    // IF THIS TEST EVER FAILS the window has been closed; retire AR-02 and
    // update 01-SECURITY.md rather than deleting the test.
    const vaultDir = join(root, "vault");
    await mkdir(vaultDir, { recursive: true });
    const target = join(vaultDir, "note.md");
    await writeFile(target, "inside the vault");

    // The check passes: the path is verified to be inside the vault.
    const { absPath } = await resolveInVault(vaultDir, "note.md");
    expect(absPath.startsWith(vaultDir)).toBe(true);
    expect(absPath).toBe(target);

    // ---- the window: an actor with write access inside the vault acts here
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET OUTSIDE THE VAULT");
    await rm(absPath);
    await symlink(outside, absPath);
    // ---- end of window

    // The use: the route reads the path it resolved, which is now a symlink.
    const buf = await readFile(absPath);
    expect(buf.toString("utf8")).toBe("SECRET OUTSIDE THE VAULT");
  });
});
