/**
 * Same-origin guard for state-changing requests (T-03-08).
 *
 * The app is same-origin in production (one container, one port), so a browser
 * cross-site POST/DELETE carrying an `Origin` for another host is a forgery
 * attempt and is refused. A request with no `Origin` header is not a browser
 * cross-site request (curl, a test, a server-side call) and is allowed: the
 * cookie-free API has no ambient credential to protect.
 *
 * `X-Forwarded-Host` is client input. When `APP_ORIGIN` is configured, only its
 * allowlist is consulted, so a forged `Origin` plus a matching forged
 * `X-Forwarded-Host` is still refused. Without `APP_ORIGIN` the guard falls
 * back to `X-Forwarded-Host` (needed by the Vite dev proxy) then `Host`.
 *
 * This function never throws — a malformed `Origin` is simply not same-origin.
 */
import type { Context } from "hono";
import { config } from "../config.js";

/** The first host in an `X-Forwarded-Host` list (proxy may append). */
function firstHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first.toLowerCase();
}

/** The normalised `APP_ORIGIN` allowlist; empty when the variable is unset. */
function configuredOrigins(): string[] {
  const raw = config.appOrigin;
  if (raw === undefined) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    try {
      const url = new URL(trimmed);
      if (url.host !== "") origins.push(url.origin.toLowerCase());
    } catch {
      // An unusable entry is ignored; the valid entries still apply.
    }
  }
  return origins;
}

/** True when the request is same-origin, or carries no `Origin` at all. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined || origin.trim() === "") return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === "") return false;

  const allowlist = configuredOrigins();
  if (allowlist.length > 0) {
    // Scheme, host and port must all match a configured origin. The forwarded
    // header is never consulted, so a client cannot nominate its own origin.
    return allowlist.includes(parsed.origin.toLowerCase());
  }

  // Behind the reverse proxy the browser-facing host is `X-Forwarded-Host`;
  // fall back to the direct `Host` header.
  const expected = firstHost(c.req.header("x-forwarded-host")) ?? firstHost(c.req.header("host"));
  if (expected === undefined) return false;

  return parsed.host.toLowerCase() === expected;
}
