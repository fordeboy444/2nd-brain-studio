import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTreeLevel } from "./fsTree.js";

let root = "";
let vaultDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fstree-"));
  vaultDir = join(root, "myvault");
  await mkdir(vaultDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listTreeLevel", () => {
  it("returns only the two non-dot directories for a fixture with concepts/, sources/ and .okf/", async () => {
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await mkdir(join(vaultDir, "sources"), { recursive: true });
    await mkdir(join(vaultDir, ".okf"), { recursive: true });
    // A dot file too, to confirm file-level pruning.
    await writeFile(join(vaultDir, ".DS_Store"), "x");

    const entries = await listTreeLevel(vaultDir, ".");
    const names = entries.map((e) => e.name);
    expect(names).toEqual(["concepts", "sources"]);
    expect(names).not.toContain(".okf");
    expect(names).not.toContain(".DS_Store");
  });

  it("a directory entry has childrenLoaded === false and no `children` key", async () => {
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    // Put a nested file inside so we can prove it is NOT listed (one level only).
    await writeFile(join(vaultDir, "concepts", "nested.md"), "x");

    const entries = await listTreeLevel(vaultDir, ".");
    const dir = entries.find((e) => e.name === "concepts");
    expect(dir).toBeDefined();
    expect(dir!.isDir).toBe(true);
    expect(dir!.childrenLoaded).toBe(false);
    expect("children" in dir!).toBe(false);
    // The nested file must not appear at this level.
    expect(entries.some((e) => e.name === "nested.md")).toBe(false);
  });

  it("sorts ten numbered files so video-2 comes before video-10 (numeric ordering)", async () => {
    for (let i = 1; i <= 10; i++) {
      await writeFile(join(vaultDir, `video-${i}.md`), `${i}`);
    }
    const entries = await listTreeLevel(vaultDir, ".");
    const names = entries.map((e) => e.name);
    // video-2 before video-10; a lexical sort would put video-10 before video-2.
    const two = names.indexOf("video-2.md");
    const ten = names.indexOf("video-10.md");
    expect(ten).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(-1);
    expect(two).toBeLessThan(ten);
    // And the full order is the numeric one.
    expect(names).toEqual([
      "video-1.md",
      "video-2.md",
      "video-3.md",
      "video-4.md",
      "video-5.md",
      "video-6.md",
      "video-7.md",
      "video-8.md",
      "video-9.md",
      "video-10.md",
    ]);
  });

  it("sorts directories before files", async () => {
    await mkdir(join(vaultDir, "zdir"), { recursive: true });
    await writeFile(join(vaultDir, "afile.md"), "x");
    const entries = await listTreeLevel(vaultDir, ".");
    expect(entries.map((e) => e.name)).toEqual(["zdir", "afile.md"]);
  });

  it("sets `modified` from stat.mtimeMs for files and leaves it undefined for directories", async () => {
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, "note.md"), "hello");
    const entries = await listTreeLevel(vaultDir, ".");
    const file = entries.find((e) => e.name === "note.md");
    const dir = entries.find((e) => e.name === "concepts");
    expect(typeof file!.modified).toBe("number");
    expect("modified" in dir!).toBe(false);
  });

  it("id and path are both the vault-relative path (no absolute host path)", async () => {
    await mkdir(join(vaultDir, "concepts"), { recursive: true });
    await writeFile(join(vaultDir, "concepts", "note.md"), "x");
    const root = await listTreeLevel(vaultDir, ".");
    const nested = await listTreeLevel(vaultDir, "concepts");
    expect(root.find((e) => e.name === "concepts")!.id).toBe("concepts");
    expect(nested.find((e) => e.name === "note.md")!.path).toBe("concepts/note.md");
    // No entry carries the host path.
    for (const e of [...root, ...nested]) {
      expect(e.id).not.toContain(vaultDir);
      expect(e.path).not.toContain(vaultDir);
    }
  });

  it("returns an empty array for an empty directory, not a throw", async () => {
    await mkdir(join(vaultDir, "empty"), { recursive: true });
    const entries = await listTreeLevel(vaultDir, "empty");
    expect(entries).toEqual([]);
  });

  it("rejects a traversal probe through the jail (parent-segment)", async () => {
    const { PathJailError } = await import("../paths/jail.js");
    await expect(listTreeLevel(vaultDir, "../escape")).rejects.toBeInstanceOf(PathJailError);
  });
});