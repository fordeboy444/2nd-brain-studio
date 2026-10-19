import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `cp` is the one call a rollback test needs to fail on demand; every other
// filesystem call stays real.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = (await importActual()) as typeof import("node:fs/promises");
  return {
    ...actual,
    cp: vi.fn(async (...args: Parameters<typeof actual.cp>) => actual.cp(...args)),
  };
});

async function reload() {
  vi.resetModules();
  return (await import("./scaffold.js")) as typeof import("./scaffold.js");
}

let base = "";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vscaf-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("scaffoldVault", () => {
  it("creates the four template files and six directories", async () => {
    const { scaffoldVault, NON_EMPTY_MESSAGE } = await reload();
    const dir = join(base, "vault-a");
    await scaffoldVault(dir);
    const entries = await readdir(dir);
    expect(entries).toContain("SCHEMA.md");
    expect(entries).toContain("README.md");
    expect(entries).toContain("log.md");
    expect(entries).toContain("index.md");
    expect(entries).toContain("concepts");
    expect(entries).toContain("entities");
    expect(entries).toContain("sources");
    expect(entries).toContain("raw");
    const ents = await readdir(join(dir, "entities"));
    expect(ents.sort()).toEqual(["organizations", "people", "tools"]);
    void NON_EMPTY_MESSAGE;
  });

  it("refuses a non-empty directory with the exact copy and leaves it untouched", async () => {
    const { scaffoldVault, NON_EMPTY_MESSAGE } = await reload();
    const dir = join(base, "vault-b");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "stray.txt"), "nope");
    await expect(scaffoldVault(dir)).rejects.toThrow(NON_EMPTY_MESSAGE);
    // Untouched: still only the stray file.
    const entries = await readdir(dir);
    expect(entries).toEqual(["stray.txt"]);
  });

  it("is idempotent: a second call on a fully-scaffolded dir is a no-op", async () => {
    const { scaffoldVault } = await reload();
    const dir = join(base, "vault-c");
    await scaffoldVault(dir);
    // Second call should not throw.
    await scaffoldVault(dir);
    const entries = await readdir(dir);
    expect(entries).toContain("index.md");
  });

  it("still fails after a user file was added to a scaffolded dir", async () => {
    const { scaffoldVault, NON_EMPTY_MESSAGE } = await reload();
    const dir = join(base, "vault-d");
    await scaffoldVault(dir);
    await writeFile(join(dir, "concepts", "my-note.md"), "# hi");
    await expect(scaffoldVault(dir)).rejects.toThrow(NON_EMPTY_MESSAGE);
  });

  it("the four template files are real copies (not empty)", async () => {
    const { scaffoldVault } = await reload();
    const dir = join(base, "vault-e");
    await scaffoldVault(dir);
    const idx = await stat(join(dir, "index.md"));
    expect(idx.size).toBeGreaterThan(0);
    const schema = await stat(join(dir, "SCHEMA.md"));
    expect(schema.size).toBeGreaterThan(0);
  });

  it("removes a partial scaffold when a copy fails, so a retry is possible", async () => {
    const { scaffoldVault } = await reload();
    const fsMod = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const cpMock = vi.mocked(fsMod.cp);
    cpMock.mockClear();
    cpMock.mockImplementationOnce(async (src, dest, opts) =>
      actual.cp(src, dest, opts),
    );
    cpMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const dir = join(base, "vault-partial");
    await expect(scaffoldVault(dir)).rejects.toThrow("disk full");

    // The directory this call created is gone, not left half-scaffolded.
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("empties a pre-existing directory it was filling after a failure", async () => {
    const { scaffoldVault } = await reload();
    const fsMod = await import("node:fs/promises");
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const cpMock = vi.mocked(fsMod.cp);
    cpMock.mockClear();
    cpMock.mockImplementationOnce(async (src, dest, opts) =>
      actual.cp(src, dest, opts),
    );
    cpMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const dir = join(base, "vault-empty-before");
    await mkdir(dir, { recursive: true });
    await expect(scaffoldVault(dir)).rejects.toThrow("disk full");

    // The directory the caller owned stays; only this call's output is undone.
    expect(await readdir(dir)).toEqual([]);
  });
});