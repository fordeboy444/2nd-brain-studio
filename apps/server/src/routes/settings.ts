/**
 * The settings surface (INGEST-05, INGEST-06).
 *
 * Upload is a raw `text/plain` body, never multipart: the browser sends the
 * Netscape file as-is and the server validates, caps and stores it. The read
 * path is redacted by construction — it returns only presence and mtime, so a
 * cookie body can never travel back to the browser (T-03-24).
 *
 * Every non-GET request passes the same-origin guard (T-03-27), so a third-party
 * page cannot upload a cookie or change settings.
 */
import { Hono } from "hono";
import pino from "pino";
import { sameOrigin } from "../http/origin.js";
import {
  MAX_COOKIE_BYTES,
  cookieStatus,
  deleteYoutubeCookie,
  validateNetscapeCookie,
  writeYoutubeCookie,
} from "../ingest/cookie.js";

const log = pino({ name: "settings" });

export const settings = new Hono();

settings.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    return c.json(
      { error: "origin_mismatch", message: "Cross-origin requests are not accepted." },
      403,
    );
  }
  await next();
});

/**
 * The redacted status object. The cookie body is not a field and is never read:
 * `cookieStatus` calls `stat` only.
 */
settings.get("/", async (c) => {
  const status = await cookieStatus();
  return c.json(status, 200);
});

/**
 * `POST /api/settings/youtube-cookie` — raw Netscape text.
 *
 * The declared `content-length` is checked before the body is buffered; the
 * actual byte length is re-checked after, because a chunked request has no
 * declared length. A rejected body writes nothing.
 */
settings.post("/youtube-cookie", async (c) => {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/plain")) {
    return c.json(
      {
        error: "unsupported_media_type",
        message: "Upload the Netscape cookie file as a raw text/plain body.",
      },
      415,
    );
  }

  const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_COOKIE_BYTES) {
    log.info({ route: "settings.youtube-cookie", bytes: declared, ok: false }, "youtube_cookie_rejected");
    return c.json(
      { error: "cookie_too_large", message: "The cookie body must be at most 1 MiB." },
      413,
    );
  }

  const text = await c.req.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_COOKIE_BYTES) {
    log.info({ route: "settings.youtube-cookie", bytes, ok: false }, "youtube_cookie_rejected");
    return c.json(
      { error: "cookie_too_large", message: "The cookie body must be at most 1 MiB." },
      413,
    );
  }

  const verdict = validateNetscapeCookie(text);
  if (!verdict.ok) {
    // The reason names the shape of the failure, never the body.
    log.info({ route: "settings.youtube-cookie", bytes, ok: false }, "youtube_cookie_rejected");
    return c.json(
      {
        error: "invalid_cookie",
        message: `The body is not a valid Netscape cookie file (${verdict.reason ?? "bad_line"}).`,
      },
      400,
    );
  }

  await writeYoutubeCookie(text);
  const status = await cookieStatus();
  log.info({ route: "settings.youtube-cookie", bytes, ok: true }, "youtube_cookie_uploaded");
  return c.json(
    {
      hasYoutubeCookie: true,
      youtubeCookieUpdatedAt: status.youtubeCookieUpdatedAt,
    },
    200,
  );
});

/** `DELETE /api/settings/youtube-cookie` — idempotent; absent is a success. */
settings.delete("/youtube-cookie", async (c) => {
  await deleteYoutubeCookie();
  return c.json({ hasYoutubeCookie: false }, 200);
});
