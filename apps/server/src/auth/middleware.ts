/**
 * Authentication and vault scope (T-261023-04, T-261023-05, T-261023-10).
 *
 * One middleware decides whether a request carries a credential at all; the
 * route-level checks decide what that credential may do. Keeping the two apart
 * is what lets `/api/health` stay public while every vault surface is gated.
 *
 * `authenticate` runs for every `/api/*` request but returns `next()`
 * immediately for a path no gate covers. That keeps the public surface
 * explicit: a new route is public only by NOT being in `GATED_PREFIXES`.
 */
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { sessionKey, verifyAdminToken } from "./adminToken.js";
import { SESSION_COOKIE, readSession } from "./session.js";

/**
 * An authenticated caller. The browser session and a Bearer credential both
 * resolve to a principal, but only the browser session is ever an admin today:
 * agent tokens are Bearer-only and carry a vault list.
 */
export interface Principal {
  kind: "admin" | "token";
  id?: string;
  name?: string;
  vaults: "*" | string[];
}

/** Where the principal is stored on the context. */
const PRINCIPAL_KEY = "principal";

/**
 * The test-only bypass. BOTH halves are required: an environment that merely
 * inherits `AUTH_TEST_BYPASS=1` still fails closed unless it is also a test
 * process. `vitest` sets `NODE_ENV=test`, a container does not.
 */
export function authBypassEnabled(): boolean {
  return process.env.AUTH_TEST_BYPASS === "1" && process.env.NODE_ENV === "test";
}

/**
 * The prefixes that require a credential. Matching is exact-or-slash, so
 * `/api/vaults` and `/api/vaults/x` are gated while `/api/vaultsx` is not.
 */
export const GATED_PREFIXES = [
  "/api/vaults",
  "/api/file",
  "/api/jobs",
  "/api/settings",
  "/api/admin",
] as const;

export function isGatedPath(path: string): boolean {
  return GATED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * The principal `authenticate` stored, or the bypass admin when the bypass is
 * on, or null. Reading it through one function is what keeps the bypass from
 * leaking into route code: no route ever inspects the env var.
 */
export function principalOf(c: Context): Principal | null {
  const stored = c.get(PRINCIPAL_KEY) as Principal | undefined;
  if (stored !== undefined) return stored;
  if (authBypassEnabled()) {
    return { kind: "admin", vaults: "*" };
  }
  return null;
}

/** True only for an admin principal. A scoped token is never an admin. */
export function isAdmin(c: Context): boolean {
  return principalOf(c)?.kind === "admin";
}

/**
 * The vault ids this principal may reach: `"*"` for an admin, the minted list
 * for an agent token, and an empty list when there is no principal at all.
 */
export function allowedVaultIds(c: Context): "*" | string[] {
  return principalOf(c)?.vaults ?? [];
}

/** The fixed 401. The body names no credential and no reason. */
function unauthorized(c: Context): Response {
  return c.json(
    { error: "unauthorized", message: "A token is required." },
    401,
    { "WWW-Authenticate": "Bearer" },
  );
}

/** The fixed 403 for a vault outside the principal's scope. */
export function forbiddenVault(c: Context): Response {
  return c.json(
    { error: "forbidden", message: "This token cannot access that vault." },
    403,
  );
}

/**
 * Accept a credential or refuse the request.
 *
 * Order is deliberate: Bearer first (the agent path, no ambient state), then
 * the session cookie (the browser path). A Bearer credential that fails is not
 * retried as a cookie — a caller that sent one shape gets one answer.
 */
export async function authenticate(c: Context, next: Next): Promise<void | Response> {
  if (!isGatedPath(c.req.path)) {
    await next();
    return;
  }

  if (authBypassEnabled()) {
    c.set(PRINCIPAL_KEY, { kind: "admin", vaults: "*" } satisfies Principal);
    await next();
    return;
  }

  const header = c.req.header("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const credential = header.slice(7).trim();
    if (credential !== "" && (await verifyAdminToken(credential))) {
      c.set(PRINCIPAL_KEY, { kind: "admin", vaults: "*" } satisfies Principal);
      await next();
      return;
    }
    return unauthorized(c);
  }

  const key = await sessionKey();
  if (readSession(getCookie(c, SESSION_COOKIE), key)) {
    c.set(PRINCIPAL_KEY, { kind: "admin", vaults: "*" } satisfies Principal);
    await next();
    return;
  }

  return unauthorized(c);
}

/**
 * Guard one vault id against the principal's scope.
 *
 * Returns a Response when the request must stop, or null when it may proceed.
 * This runs BEFORE any registry lookup on purpose: a vault the caller cannot
 * see must answer 403 whether or not it exists, or the status code becomes an
 * existence oracle.
 *
 * Task 1 knows only the admin principal; per-token scopes arrive with
 * `scopeAllows` in Task 2.
 */
export function guardVault(c: Context, _vaultId: string): Response | null {
  return principalOf(c) === null ? forbiddenVault(c) : null;
}

/** The `/api/vaults/:id` and `/api/vaults/:id/*` middleware. */
export async function vaultScope(c: Context, next: Next): Promise<void | Response> {
  const denied = guardVault(c, c.req.param("id") ?? "");
  if (denied !== null) return denied;
  await next();
}
