import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin credential (T-261023-01, T-261023-08).
 *
 * Resolution order, first-boot generation and constant-time verification. The
 * file is read on every call on purpose, so a rotation is visible without a
 * restart; the test for that is "a changed file value is honoured next call".
 */

const ORIG_ENV = { ...process.env };

let root = "";
let tokenPath = "";

async function reload() {
  vi.resetModules();
  return (await import("./adminToken.js")) as typeof import("./adminToken.js");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "admin-token-"));
  tokenPath = join(root, "admin-token");
  process.env.ADMIN_TOKEN_PATH = tokenPath;
  delete process.env.BRAIN_ADMIN_TOKEN;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("resolveAdminToken", () => {
  it("prefers BRAIN_ADMIN_TOKEN over the file", async () => {
    await writeFile(tokenPath, "file-token\n", "utf8");
    process.env.BRAIN_ADMIN_TOKEN = "env-token";
    const { resolveAdminToken, ensureAdminToken } = await reload();

    expect(await resolveAdminToken()).toBe("env-token");
    // With the environment supplying the token, first-boot generation must not
    // touch the volume at all.
    expect(await ensureAdminToken()).toBe(false);
    expect(await readFile(tokenPath, "utf8")).toBe("file-token\n");
  });

  it("trims the file value and treats an empty file as unset", async () => {
    const { resolveAdminToken } = await reload();

    await writeFile(tokenPath, "  file-token  \n", "utf8");
    expect(await resolveAdminToken()).toBe("file-token");

    await writeFile(tokenPath, "   \n", "utf8");
    expect(await resolveAdminToken()).toBeUndefined();
  });

  it("returns undefined when neither source exists", async () => {
    const { resolveAdminToken } = await reload();
    expect(await resolveAdminToken()).toBeUndefined();
  });
});

describe("ensureAdminToken", () => {
  it("generates the file once at 0600 and never rotates it", async () => {
    const { ensureAdminToken, resolveAdminToken, ADMIN_TOKEN_PREFIX } = await reload();

    expect(await ensureAdminToken()).toBe(true);
    const first = await readFile(tokenPath, "utf8");
    expect(first.startsWith(ADMIN_TOKEN_PREFIX)).toBe(true);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);

    // A second boot must leave the credential alone: rotating it here would
    // sign every logged-in browser out for no reason.
    expect(await ensureAdminToken()).toBe(false);
    expect(await readFile(tokenPath, "utf8")).toBe(first);
    expect(await resolveAdminToken()).toBe(first.trim());
  });

  it("honours a rotated file on the next call (no caching)", async () => {
    const { ensureAdminToken, verifyAdminToken } = await reload();
    await ensureAdminToken();

    await writeFile(tokenPath, "rotated-token\n", "utf8");
    expect(await verifyAdminToken("rotated-token")).toBe(true);
    expect(await verifyAdminToken("stale-token")).toBe(false);
  });
});

describe("verifyAdminToken", () => {
  it("accepts the resolved token and rejects a wrong value or no token", async () => {
    const { verifyAdminToken } = await reload();
    // No credential configured: every candidate is refused.
    expect(await verifyAdminToken("anything")).toBe(false);

    process.env.BRAIN_ADMIN_TOKEN = "test-admin";
    vi.resetModules();
    const loaded = (await import("./adminToken.js")) as typeof import("./adminToken.js");
    expect(await loaded.verifyAdminToken("test-admin")).toBe(true);
    expect(await loaded.verifyAdminToken("test-admi")).toBe(false);
    expect(await loaded.verifyAdminToken("")).toBe(false);
  });
});

describe("sessionKey", () => {
  it("derives a stable key from the admin token and null when unset", async () => {
    const { sessionKey } = await reload();
    expect(await sessionKey()).toBeNull();

    process.env.BRAIN_ADMIN_TOKEN = "test-admin";
    vi.resetModules();
    const loaded = (await import("./adminToken.js")) as typeof import("./adminToken.js");
    const key = await loaded.sessionKey();
    expect(key).not.toBeNull();
    expect(key?.length).toBe(32);
    expect((await loaded.sessionKey())?.equals(key as Buffer)).toBe(true);
  });
});
