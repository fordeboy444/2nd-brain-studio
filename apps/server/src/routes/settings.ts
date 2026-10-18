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
import { z } from "zod";
import { config } from "../config.js";
import { sameOrigin } from "../http/origin.js";
import {
  MAX_COOKIE_BYTES,
  cookieStatus,
  deleteYoutubeCookie,
  validateNetscapeCookie,
  writeYoutubeCookie,
} from "../ingest/cookie.js";
import { readSettings, writeSettings } from "../settings/store.js";

const log = pino({ name: "settings" });

export const settings = new Hono();

/**
 * The one redacted response shape. It is an explicit allowlist: non-secret
 * settings plus three flags and a timestamp. No key, token or cookie body is a
 * field, so no serializer change can expose one (T-03-24).
 */
async function statusPayload(): Promise<{
  settings: Awaited<ReturnType<typeof readSettings>>;
  hasYoutubeCookie: boolean;
  youtubeCookieUpdatedAt: string | null;
  hasSupadataKey: boolean;
  llmConfigured: boolean;
}> {
  const [current, status] = await Promise.all([readSettings(), cookieStatus()]);
  return {
    settings: current,
    hasYoutubeCookie: status.hasYoutubeCookie,
    youtubeCookieUpdatedAt: status.youtubeCookieUpdatedAt,
    hasSupadataKey: config.supadataApiKey !== undefined,
    llmConfigured: config.llmConfigured,
  };
}

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
  return c.json(await statusPayload(), 200);
});

/**
 * `PUT /api/settings` — the non-secret patch.
 *
 * `writeSettings` validates with zod, strips unknown keys (including a
 * secret-shaped one) and merges over the current file. A rejected patch writes
 * nothing.
 */
settings.put("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_body", message: "Request body must be a JSON settings patch." },
      400,
    );
  }

  try {
    await writeSettings(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "invalid_body", message: "One or more settings values are out of range." },
        400,
      );
    }
    throw error;
  }

  return c.json(await statusPayload(), 200);
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

/**
 * `POST /api/settings/test-llm` — one manual, bounded Ollama probe.
 *
 * The key is read from `config` at call time and used only in the Authorization
 * header (T-03-26). It is never placed in the body, the URL or the response, and
 * the upstream body is never read back. This is a manual probe only: the job
 * pipeline never calls it, so the zero-LLM Phase 3 proof still holds.
 */
settings.post("/test-llm", async (c) => {
  const key = config.ollamaApiKey;
  if (!config.llmConfigured || key === undefined) {
    return c.json(
      { error: "llm_not_configured", message: "Set OLLAMA_API_KEY to test the connection." },
      400,
    );
  }

  const started = Date.now();
  try {
    const current = await readSettings();
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: current.llm.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: false,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // The status is fixed data; the upstream body is deliberately not read.
      return c.json({ ok: false, reason: `http_${response.status}` }, 200);
    }
    return c.json({ ok: true, latencyMs: Date.now() - started }, 200);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return c.json({ ok: false, reason }, 200);
  }
});

/** `DELETE /api/settings/youtube-cookie` — idempotent; absent is a success. */
settings.delete("/youtube-cookie", async (c) => {
  await deleteYoutubeCookie();
  return c.json({ hasYoutubeCookie: false }, 200);
});
