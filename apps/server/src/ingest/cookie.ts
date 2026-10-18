/**
 * The YouTube cookie file (INGEST-05, T-03-25).
 *
 * The browser never sees the body after upload: the upload route validates the
 * raw Netscape text, `writeYoutubeCookie` lands it at mode 0600 through the
 * atomic temp+rename path, and `cookieStatus` reports only existence and mtime.
 *
 * The path is owned by `config.youtubeCookiePath` (the OPS-07 boundary); this
 * module never reads another environment variable and never builds a path from
 * a request value.
 */
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { config } from "../config.js";
import { writeTextAtomic } from "../http/writeAtomic.js";

/** Body cap for the raw `text/plain` upload (CONTEXT: 1 MiB). */
export const MAX_COOKIE_BYTES = 1024 * 1024;

export type CookieInvalidReason = "empty" | "too_large" | "bad_line";

export interface CookieValidation {
  ok: boolean;
  reason?: CookieInvalidReason;
}

const BOOLEAN_FIELD = /^(TRUE|FALSE)$/i;
const INTEGER_FIELD = /^\d+$/;

/**
 * Validate one Netscape cookie file without touching disk.
 *
 * A valid body has at least one cookie line. A cookie line has exactly seven
 * tab-separated fields: domain, include-subdomains (TRUE/FALSE), path, secure
 * (TRUE/FALSE), expiry (integer seconds), name and value. Blank lines and
 * `#`-comment lines are ignored; the conventional `#HttpOnly_` prefix marks a
 * real cookie, not a comment, so it is stripped before the field check.
 */
export function validateNetscapeCookie(text: string): CookieValidation {
  if (Buffer.byteLength(text, "utf8") > MAX_COOKIE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let cookieLines = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    let cookie = line;
    if (line.startsWith("#HttpOnly_")) {
      cookie = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      // `# Netscape HTTP Cookie File` and every other comment.
      continue;
    }

    const fields = cookie.split("\t");
    if (fields.length !== 7) return { ok: false, reason: "bad_line" };

    const domain = fields[0] ?? "";
    const includeSubdomains = fields[1] ?? "";
    const path = fields[2] ?? "";
    const secure = fields[3] ?? "";
    const expires = fields[4] ?? "";
    const name = fields[5] ?? "";

    if (domain === "" || path === "" || name === "") return { ok: false, reason: "bad_line" };
    if (!BOOLEAN_FIELD.test(includeSubdomains)) return { ok: false, reason: "bad_line" };
    if (!BOOLEAN_FIELD.test(secure)) return { ok: false, reason: "bad_line" };
    if (!INTEGER_FIELD.test(expires)) return { ok: false, reason: "bad_line" };

    cookieLines += 1;
  }

  if (cookieLines === 0) {
    return { ok: false, reason: text.trim() === "" ? "empty" : "bad_line" };
  }
  return { ok: true };
}

/**
 * The path to hand yt-dlp as `--cookies`, or undefined when no cookie file
 * exists. Existence is the only check: the body is never read here.
 */
export function readYoutubeCookiePath(): string | undefined {
  return existsSync(config.youtubeCookiePath) ? config.youtubeCookiePath : undefined;
}

/**
 * Store a validated body at mode 0600. The temp file is chmodded before the
 * rename, so the target path is never world-readable, not even briefly.
 */
export async function writeYoutubeCookie(text: string): Promise<void> {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  await writeTextAtomic(config.youtubeCookiePath, body, 0o600);
}

/** Remove the cookie file. Idempotent: a missing file is not an error. */
export async function deleteYoutubeCookie(): Promise<void> {
  await rm(config.youtubeCookiePath, { force: true });
}

export interface CookieStatus {
  hasYoutubeCookie: boolean;
  youtubeCookieUpdatedAt: string | null;
}

/**
 * Redacted status: existence plus mtime, never the body. A file removed between
 * the stat and the answer is reported as absent rather than throwing.
 */
export async function cookieStatus(): Promise<CookieStatus> {
  try {
    const info = await stat(config.youtubeCookiePath);
    return {
      hasYoutubeCookie: true,
      youtubeCookieUpdatedAt: info.mtime.toISOString(),
    };
  } catch {
    return { hasYoutubeCookie: false, youtubeCookieUpdatedAt: null };
  }
}
