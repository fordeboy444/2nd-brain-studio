/**
 * Same-origin guard for state-changing requests (T-03-08).
 *
 * The app is same-origin in production (one container, one port), so a browser
 * cross-site POST/DELETE carrying an `Origin` for another host is a forgery
 * attempt and is refused. A request with no `Origin` header is not a browser
 * cross-site request (curl, a test, a server-side call) and is allowed: the
 * cookie-free API has no ambient credential to protect.
 *
 * This function never throws — a malformed `Origin` is simply not same-origin.
 */
import type { Context } from "hono";

/** The first host in an `X-Forwarded-Host` list (proxy may append). */
function firstHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first.toLowerCase();
}

/** True when the request is same-origin, or carries no `Origin` at all. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined || origin.trim() === "") return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;

  // Behind the reverse proxy the browser-facing host is `X-Forwarded-Host`;
  // fall back to the direct `Host` header.
  const expected = firstHost(c.req.header("x-forwarded-host")) ?? firstHost(c.req.header("host"));
  if (expected === undefined) return false;

  return originHost === expected;
}
