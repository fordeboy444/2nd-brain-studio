/**
 * The admin credential (T-261023-01, T-261023-08).
 *
 * Resolution order is `BRAIN_ADMIN_TOKEN` first, then the file at
 * `config.adminTokenPath`. The file is generated once on first boot so a fresh
 * deployment has a working credential without the operator inventing one.
 *
 * Nothing here ever logs or returns the token itself: the boot log names the
 * path, and verification answers a boolean. Caching is deliberately absent —
 * the file is read on every call, so an operator who rotates it (or removes
 * `BRAIN_ADMIN_TOKEN`) sees the effect on the next request, not after a
 * restart.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import pino from "pino";
import { config } from "../config.js";
import { writeTextAtomic } from "../http/writeAtomic.js";

const log = pino({ name: "auth" });

/** The visible prefix on a generated admin token, so it is recognisable. */
export const ADMIN_TOKEN_PREFIX = "brain_admin_";

/** SHA-256 of a UTF-8 string, as raw bytes (fixed 32-byte length). */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The admin token, or undefined when neither the environment nor the file
 * supplies one. The file is trimmed: a trailing newline from the writer is not
 * part of the credential.
 */
export async function resolveAdminToken(): Promise<string | undefined> {
  if (config.adminToken !== undefined) return config.adminToken;
  try {
    const raw = await readFile(config.adminTokenPath, "utf8");
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time comparison against the resolved admin token.
 *
 * Both sides are hashed first, so `timingSafeEqual` always compares two
 * 32-byte digests: a candidate of a different length cannot short-circuit, and
 * the comparison time never depends on how much of the token matched.
 */
export async function verifyAdminToken(candidate: string): Promise<boolean> {
  const expected = await resolveAdminToken();
  if (expected === undefined) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * Create the admin token file on first boot.
 *
 * Returns false without touching the disk when the environment supplies the
 * token or the file already exists — a second boot never rotates the
 * credential out from under a logged-in browser. Only the path and the fact
 * that a token was created are logged.
 */
export async function ensureAdminToken(): Promise<boolean> {
  if (config.adminToken !== undefined) return false;
  try {
    await readFile(config.adminTokenPath, "utf8");
    return false;
  } catch {
    // Absent (or unreadable) — generate. An unreadable file is replaced by a
    // known-good one rather than leaving the deployment with no admin at all.
  }

  const token = ADMIN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  await writeTextAtomic(config.adminTokenPath, `${token}\n`, 0o600);
  log.info({ path: config.adminTokenPath }, "admin_token_created");
  return true;
}

/**
 * The browser session's HMAC key, derived from the admin token.
 *
 * Deriving it (rather than storing a second secret) is the rotation contract:
 * changing the admin token invalidates every signed session cookie on the next
 * request. Returns null when no admin token resolves, so every cookie read
 * fails closed.
 */
export async function sessionKey(): Promise<Buffer | null> {
  const token = await resolveAdminToken();
  if (token === undefined) return null;
  return createHash("sha256").update(`brain-session:${token}`, "utf8").digest();
}
