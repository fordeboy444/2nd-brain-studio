import { mkdir, mkdtemp, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathJailError, decodePathParam, resolveInVault } from "./jail.js";

/**
 * The adversarial traversal suite for the path jail (VAULT-04). Every rejection
 * case asserts both the throw and the `reason` value. No thrown error message
 * may contain the temp-root string.
 */

let root = "";
let vaultDir = "";
let outsideDir = "";
let inVaultSymlink = "";
let escapingSymlink = "";
let siblingSymlink = "";
let inVaultFile = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jail-"));
  vaultDir = join(root, "myvault");
  // A sibling whose name extends the vault directory name (prefix-sibling).
  // A buggy bare-prefix boundary check would treat this as inside the vault.
  const sibling = join(root, "myvault-evil");
  // A directory outside the root entirely.
  outsideDir = await mkdtemp(join(tmpdir(), "jail-outside-"));

  await mkdir(vaultDir, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(join(vaultDir, "concepts"), { recursive: true });

  // A real file inside the vault.
  inVaultFile = join(vaultDir, "concepts", "real.md");
  await writeFile(inVaultFile, "real\n", "utf8");

  // A symlink inside the vault pointing at an in-vault file (positive case).
  inVaultSymlink = join(vaultDir, "concepts", "link.md");
  await symlink(inVaultFile, inVaultSymlink);

  // A symlink inside the vault pointing OUTSIDE the vault (escape case) — to
  // an unrelated outside file. The target must exist so `realpath` resolves the
  // link and the re-check can catch the escape.
  const outsideTarget = join(outsideDir, "secret.md");
  await writeFile(outsideTarget, "outside secret\n", "utf8");
  escapingSymlink = join(vaultDir, "concepts", "escape.md");
  await symlink(outsideTarget, escapingSymlink);

  // A symlink inside the vault pointing at the prefix-sibling directory — the
  // realistic prefix-sibling attack. Its realpath is `<root>/myvault-evil`,
  // which shares the vault dir's name prefix; only a separator-boundary check
  // (not a bare string prefix) rejects it.
  siblingSymlink = join(vaultDir, "concepts", "sibling-link.md");
  await symlink(sibling, siblingSymlink);

  // Assert the fixtures exist before the escaping case runs — skip loudly
  // rather than silently passing if symlink creation failed. Use lstat so a
  // broken link still reports as present (we care that the link itself exists).
  expect(await lstat(escapingSymlink).then((s) => s.isSymbolicLink()).catch(() => false)).toBe(true);
  expect(await lstat(inVaultSymlink).then((s) => s.isSymbolicLink()).catch(() => false)).toBe(true);
  expect(await lstat(siblingSymlink).then((s) => s.isSymbolicLink()).catch(() => false)).toBe(true);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

function expectReason(fn: () => unknown, reason: string) {
  try {
    const r = fn();
    // resolveInVault is async; support a thenable.
    if (r && typeof (r as Promise<unknown>).then === "function") {
      throw new Error("expected async throw but got a promise — use expectRejects");
    }
    throw new Error(`expected PathJailError(${reason}) but call resolved`);
  } catch (err) {
    if (err instanceof PathJailError) {
      expect(err.reason).toBe(reason);
      // No message contains the temp root.
      expect(err.message).not.toContain(root);
      expect(err.message).not.toContain(tmpdir());
      return;
    }
    throw err;
  }
}

async function expectRejects(promise: Promise<unknown>, reason: string) {
  try {
    await promise;
    throw new Error(`expected PathJailError(${reason}) but call resolved`);
  } catch (err) {
    if (!(err instanceof PathJailError)) throw err;
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain(root);
    expect(err.message).not.toContain(tmpdir());
  }
}

describe("resolveInVault rejections (reason asserted)", () => {
  it("rejects absent, empty and whitespace-only input with reason `empty`", async () => {
    // absent (undefined)
    await expectRejects(resolveInVault(vaultDir, undefined as unknown as string), "empty");
    // empty string
    await expectRejects(resolveInVault(vaultDir, ""), "empty");
    // whitespace only
    await expectRejects(resolveInVault(vaultDir, "   "), "empty");
  });

  it("rejects a null character with reason `null-byte`", async () => {
    await expectRejects(resolveInVault(vaultDir, "concepts/rea\0l.md"), "null-byte");
  });

  it("rejects a literal parent segment with reason `parent-segment`", async () => {
    await expectRejects(resolveInVault(vaultDir, "../escape.md"), "parent-segment");
    await expectRejects(resolveInVault(vaultDir, "concepts/../../etc/passwd"), "parent-segment");
  });

  it("rejects an input beginning with a path separator with reason `absolute`", async () => {
    await expectRejects(resolveInVault(vaultDir, "/etc/passwd"), "absolute");
    await expectRejects(resolveInVault(vaultDir, "\\windows\\system32"), "absolute");
  });

  it("rejects Windows drive and UNC prefixes with reason `absolute`", async () => {
    await expectRejects(resolveInVault(vaultDir, "C:\\secret"), "absolute");
    await expectRejects(resolveInVault(vaultDir, "\\\\server\\share"), "absolute");
  });

  it("rejects the prefix-sibling directory (via symlink) with reason `outside`", async () => {
    // The symlink "concepts/sibling-link.md" is lexically inside the vault; its
    // real target is `<root>/myvault-evil`, a sibling whose name extends the
    // vault dir name. A bare-prefix boundary check would pass (the sibling name
    // starts with the vault dir name); only a separator-boundary check rejects.
    await expectRejects(resolveInVault(vaultDir, "concepts/sibling-link.md"), "outside");
  });

  it("rejects traversal through the escaping symlink with reason `outside`", async () => {
    // The symlink name is lexically clean (inside the vault); its real target
    // is outside. Only the realpath re-check catches this.
    await expectRejects(resolveInVault(vaultDir, "concepts/escape.md"), "outside");
  });

  it("no thrown PathJailError message contains the temp root (sampled)", async () => {
    // Re-run a spread of rejections and assert the message is free of the
    // temp-root string and the OS tmpdir.
    for (const [input, reason] of [
      ["", "empty"],
      ["\0", "null-byte"],
      ["../x", "parent-segment"],
      ["/x", "absolute"],
      ["concepts/sibling-link.md", "outside"],
      ["concepts/escape.md", "outside"],
    ] as const) {
      try {
        await resolveInVault(vaultDir, input);
        throw new Error("expected throw");
      } catch (err) {
        if (!(err instanceof PathJailError)) throw err;
        expect(err.reason).toBe(reason);
        expect(err.message).not.toContain(root);
      }
    }
  });
});

describe("resolveInVault positive cases", () => {
  it("resolves a plain nested file inside the vault with a matching relPath", async () => {
    const { absPath, relPath } = await resolveInVault(vaultDir, "concepts/real.md");
    expect(absPath).toBe(join(vaultDir, "concepts", "real.md"));
    expect(relPath).toBe("concepts/real.md");
  });

  it("resolves a path naming the vault root itself", async () => {
    const { absPath } = await resolveInVault(vaultDir, ".");
    expect(absPath).toBe(await import("node:fs/promises").then((m) => m.realpath(vaultDir)));
  });

  it("resolves a path traversing an in-vault symlink (target inside vault)", async () => {
    const { absPath, relPath } = await resolveInVault(vaultDir, "concepts/link.md");
    expect(relPath).toBe("concepts/link.md");
    // absPath is the lexical candidate (inside vault); realpath of it is the
    // in-vault target, which the boundary test accepts.
    expect(absPath).toBe(join(vaultDir, "concepts", "link.md"));
  });
});

describe("resolveInVault ordering guarantee", () => {
  it("rejects a lexically-clean path whose real target is outside (realpath re-check after boundary)", async () => {
    // "concepts/escape.md" is lexically inside the vault; its realpath is
    // outside. If the realpath re-check were skipped, this would resolve.
    // If it ran BEFORE the boundary check, the lexical check would never gate
    // a non-symlink case. The only way this rejects is: boundary check passes,
    // THEN realpath re-check fails.
    await expectRejects(resolveInVault(vaultDir, "concepts/escape.md"), "outside");
  });
});

describe("decodePathParam", () => {
  it("decodes a percent-encoded path once", () => {
    expect(decodePathParam("concepts%2Freal.md")).toBe("concepts/real.md");
  });

  it("rejects an undecodable percent sequence with reason `undecodable`", () => {
    expectReason(() => decodePathParam("%zz"), "undecodable");
    expectReason(() => decodePathParam("concepts/%E0%A4"), "undecodable");
  });

  it("decodes a percent-encoded parent segment into its literal form (caught by jail)", async () => {
    // %2e%2e -> ".." — decodePathParam yields the literal, which resolveInVault
    // then rejects as parent-segment. Both layers must agree.
    expect(decodePathParam("%2e%2e/escape.md")).toBe("../escape.md");
    // And the jail catches the decoded form:
    await expectRejects(resolveInVault(vaultDir, decodePathParam("%2e%2e/escape.md")), "parent-segment");
  });
});