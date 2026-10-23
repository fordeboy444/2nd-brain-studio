import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent-token store (T-261023-02, T-261023-03).
 *
 * The subject is what is on disk: a minted token's plaintext appears in the
 * return value and NOWHERE else, the file is 0600, a lookup is constant-shape,
 * and a corrupt file is reported rather than overwritten.
 */

const ORIG_ENV = { ...process.env };

let root = "";
let storePath = "";

async function reload() {
  vi.resetModules();
  return (await import("./tokens.js")) as typeof import("./tokens.js");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-tokens-"));
  storePath = join(root, "agent-tokens.json");
  process.env.AGENT_TOKENS_PATH = storePath;
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

describe("mintToken", () => {
  it("returns a brain_agent_ token and stores only its SHA-256", async () => {
    const { mintToken, hashToken } = await reload();
    const { token, entry } = await mintToken({ name: "agent-a", vaults: ["my-channel"] });

    expect(token.startsWith("brain_agent_")).toBe(true);
    expect(entry).not.toHaveProperty("tokenHash");

    const raw = await readFile(storePath, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    expect(raw).toContain('"name": "agent-a"');
  });

  it("writes the store at mode 0600", async () => {
    const { mintToken } = await reload();
    await mintToken({ name: "agent-a", vaults: "*" });
    const mode = (await stat(storePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("findByToken", () => {
  it("resolves the minted token and rejects anything else", async () => {
    const { mintToken, findByToken } = await reload();
    const { token, entry } = await mintToken({ name: "agent-a", vaults: ["my-channel"] });

    const found = await findByToken(token);
    expect(found?.id).toBe(entry.id);
    expect(found?.vaults).toEqual(["my-channel"]);

    expect(await findByToken("brain_agent_not-real")).toBeNull();
    expect(await findByToken("")).toBeNull();
  });

  it("treats a missing store as empty rather than an error", async () => {
    const { findByToken, listTokens } = await reload();
    expect(await findByToken("brain_agent_x")).toBeNull();
    expect(await listTokens()).toEqual([]);
  });
});

describe("revokeToken", () => {
  it("makes the token invalid on the next lookup", async () => {
    const { mintToken, findByToken, revokeToken } = await reload();
    const { token, entry } = await mintToken({ name: "agent-a", vaults: "*" });

    expect(await revokeToken(entry.id)).toBe(true);
    expect(await findByToken(token)).toBeNull();
    // A repeated revoke is a no-op, not an error.
    expect(await revokeToken(entry.id)).toBe(false);
  });
});

describe("scopeAllows", () => {
  it("accepts every vault for '*' and only the listed ids otherwise", async () => {
    const { scopeAllows } = await reload();
    expect(scopeAllows({ vaults: "*" }, "anything")).toBe(true);
    expect(scopeAllows({ vaults: ["my-channel"] }, "my-channel")).toBe(true);
    expect(scopeAllows({ vaults: ["my-channel"] }, "other-channel")).toBe(false);
    expect(scopeAllows({ vaults: [] }, "my-channel")).toBe(false);
  });
});

describe("corrupt store", () => {
  it("throws without overwriting the file", async () => {
    const bad = "{ this is not json";
    await writeFile(storePath, bad, "utf8");
    const { listTokens, TokenStoreInvalidError } = await reload();

    await expect(listTokens()).rejects.toBeInstanceOf(TokenStoreInvalidError);
    expect(await readFile(storePath, "utf8")).toBe(bad);
  });

  it("rejects a well-formed JSON file with the wrong shape", async () => {
    const bad = JSON.stringify({ version: 2, tokens: [] });
    await writeFile(storePath, bad, "utf8");
    const { listTokens, TokenStoreInvalidError } = await reload();

    await expect(listTokens()).rejects.toBeInstanceOf(TokenStoreInvalidError);
    expect(await readFile(storePath, "utf8")).toBe(bad);
  });
});
