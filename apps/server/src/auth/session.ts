/**
 * The signed browser session cookie (T-261023-02).
 *
 * The value is `base64url(JSON payload) + "." + base64url(HMAC-SHA256)`. The
 * payload carries only the subject and the expiry — there is nothing in it a
 * client could usefully forge, and the signature is what decides acceptance.
 *
 * The key is derived from the admin token (`sessionKey`), so rotating that
 * token invalidates every browser session. `HttpOnly` keeps the value away from
 * page scripts; `SameSite=Lax` stops a cross-site form post from carrying it;
 * `Secure` is on in production (the Dockerfile sets `NODE_ENV=production`) and
 * off in development so `pnpm dev` over plain HTTP can log in.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "brain_session";

/** Seven days, in milliseconds. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  sub: "admin";
  exp: number;
}

function hmac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Sign a fresh admin session. The payload is base64url JSON and the signature
 * is over its encoded form, so the verifier never parses untrusted bytes before
 * the signature matches.
 */
export function signSession(key: Buffer, now = Date.now()): string {
  const payload: SessionPayload = { sub: "admin", exp: now + SESSION_TTL_MS };
  const encoded = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${base64url(hmac(key, encoded))}`;
}

/**
 * Verify a cookie value. Returns false — never throws — for a missing value, a
 * malformed shape, a tampered signature, an expired payload or a null key.
 */
export function readSession(
  value: string | undefined,
  key: Buffer | null,
  now = Date.now(),
): boolean {
  if (key === null || value === undefined || value === "") return false;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return false;

  const encoded = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  let providedBytes: Buffer;
  try {
    providedBytes = Buffer.from(provided, "base64url");
  } catch {
    return false;
  }
  const expected = hmac(key, encoded);
  // Length is checked first because `timingSafeEqual` throws on mismatched
  // lengths; both are fixed-size HMAC digests, so this is only ever a forgery.
  if (providedBytes.length !== expected.length) return false;
  if (!timingSafeEqual(providedBytes, expected)) return false;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    if (parsed.sub !== "admin") return false;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return false;
    return parsed.exp > now;
  } catch {
    return false;
  }
}

/** The cookie options shared by the write and the clear. */
function cookieOptions(): {
  path: string;
  httpOnly: boolean;
  sameSite: "Lax";
  secure: boolean;
} {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  };
}

/** Write the signed admin cookie on a successful login. */
export function writeSessionCookie(c: Context, key: Buffer): void {
  setCookie(c, SESSION_COOKIE, signSession(key), {
    ...cookieOptions(),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Expire the cookie. Idempotent: clearing an absent cookie is a no-op. */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions());
}
