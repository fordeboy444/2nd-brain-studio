/**
 * The scoped agent-token store (T-261023-02, T-261023-03).
 *
 * The file is `config.agentTokensPath`, shaped
 * `{version: 1, tokens: [{id, name, tokenHash, vaults, createdAt}]}`. Only the
 * SHA-256 of a token is ever written: the plaintext leaves this module exactly
 * once, in `mintToken`'s return value, and never appears in a log line.
 *
 * Two properties are load-bearing here:
 *
 * 1. Lookup compares every stored hash and keeps the match in a variable, so a
 *    wrong token costs the same time as a right one regardless of its position
 *    in the list.
 * 2. A file that does not parse into the expected shape throws
 *    `token_store_invalid` and is NEVER overwritten. Rewriting it would delete
 *    every live token to fix a shape error the operator can inspect.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { writeTextAtomic } from "../http/writeAtomic.js";

/** One stored token. The hash is the only credential material on disk. */
export interface AgentTokenEntry {
  id: string;
  name: string;
  tokenHash: string;
  vaults: "*" | string[];
  createdAt: string;
}

/** What the API may return: everything except the hash. */
export type PublicTokenEntry = Omit<AgentTokenEntry, "tokenHash">;

export interface TokenStore {
  version: 1;
  tokens: AgentTokenEntry[];
}

/** The typed failure a caller maps to a fixed 500. */
export class TokenStoreInvalidError extends Error {
  readonly code = "token_store_invalid";

  constructor() {
    super("The agent token store is unreadable.");
    this.name = "TokenStoreInvalidError";
  }
}

/** SHA-256 of a token, lowercase hex. The store keeps only this. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The 32 raw bytes behind a hex hash, for a constant-time comparison. */
function hashBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function emptyStore(): TokenStore {
  return { version: 1, tokens: [] };
}

function isEntry(value: unknown): value is AgentTokenEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const vaultsOk =
    entry.vaults === "*" ||
    (Array.isArray(entry.vaults) && entry.vaults.every((id) => typeof id === "string"));
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(entry.tokenHash) &&
    typeof entry.createdAt === "string" &&
    vaultsOk
  );
}

/**
 * Read the store. A missing file is an empty store — a fresh deployment has no
 * agent tokens. Anything else that does not match the shape is invalid.
 */
async function readStore(): Promise<TokenStore> {
  let raw: string;
  try {
    raw = await readFile(config.agentTokensPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TokenStoreInvalidError();
  }

  if (typeof parsed !== "object" || parsed === null) throw new TokenStoreInvalidError();
  const store = parsed as Record<string, unknown>;
  if (store.version !== 1 || !Array.isArray(store.tokens)) {
    throw new TokenStoreInvalidError();
  }
  if (!store.tokens.every(isEntry)) throw new TokenStoreInvalidError();

  return { version: 1, tokens: store.tokens as AgentTokenEntry[] };
}

/** Serialize read-modify-write cycles on the store, as the registry does. */
let writeChain: Promise<unknown> = Promise.resolve();

function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive after a rejection so one failure cannot wedge it.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeStore(store: TokenStore): Promise<void> {
  await writeTextAtomic(config.agentTokensPath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

function publicEntry(entry: AgentTokenEntry): PublicTokenEntry {
  const { tokenHash: _tokenHash, ...rest } = entry;
  return rest;
}

/**
 * Resolve a presented token to its entry, or null.
 *
 * Every entry is compared and the match is recorded rather than returned, so
 * the number of comparisons does not depend on where (or whether) the token
 * appears. A corrupt store throws.
 */
export async function findByToken(token: string): Promise<AgentTokenEntry | null> {
  const store = await readStore();
  const candidate = hashBytes(hashToken(token));
  let matched: AgentTokenEntry | null = null;
  for (const entry of store.tokens) {
    const stored = hashBytes(entry.tokenHash);
    // Both sides are fixed 32-byte digests; the length check is a guard for a
    // hand-edited file, not a fast path.
    const equal = stored.length === candidate.length && timingSafeEqual(stored, candidate);
    if (equal) matched = entry;
  }
  return matched;
}

/** Mint a token. The plaintext is returned here and nowhere else. */
export async function mintToken(input: {
  name: string;
  vaults: "*" | string[];
}): Promise<{ entry: PublicTokenEntry; token: string }> {
  const token = `brain_agent_${randomBytes(32).toString("base64url")}`;
  const entry: AgentTokenEntry = {
    id: `tok_${randomBytes(8).toString("hex")}`,
    name: input.name,
    tokenHash: hashToken(token),
    vaults: input.vaults,
    createdAt: new Date().toISOString(),
  };

  return withTokenLock(async () => {
    const store = await readStore();
    store.tokens.push(entry);
    await writeStore(store);
    return { entry: publicEntry(entry), token };
  });
}

/** Every token, without hashes. */
export async function listTokens(): Promise<PublicTokenEntry[]> {
  const store = await readStore();
  return store.tokens.map(publicEntry);
}

/** Remove one token. True when it existed; a repeat call is false. */
export async function revokeToken(id: string): Promise<boolean> {
  return withTokenLock(async () => {
    const store = await readStore();
    const before = store.tokens.length;
    store.tokens = store.tokens.filter((entry) => entry.id !== id);
    if (store.tokens.length === before) return false;
    await writeStore(store);
    return true;
  });
}

/** True when `vaultId` is inside the entry's scope. `"*"` is everything. */
export function scopeAllows(
  entry: Pick<AgentTokenEntry, "vaults">,
  vaultId: string,
): boolean {
  if (entry.vaults === "*") return true;
  return entry.vaults.includes(vaultId);
}
