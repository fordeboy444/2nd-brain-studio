/**
 * The browser session routes (T-261023-09).
 *
 * `POST /api/login` accepts the admin token only. Agent tokens are Bearer-only
 * by design: the single browser session is the admin's, and a cookie minted
 * from an agent token would be an ambient credential with a scope the browser
 * never asked for. `GET /api/session` always answers 200 so the SPA can boot
 * without a credential and render the login screen from a value, not an error.
 */
import { Hono } from "hono";
import { z } from "zod";
import { resolveAdminToken, sessionKey, verifyAdminToken } from "../auth/adminToken.js";
import { clearSessionCookie, readSession, SESSION_COOKIE, writeSessionCookie } from "../auth/session.js";
import { sameOrigin } from "../http/origin.js";
import { getCookie } from "hono/cookie";

export const auth = new Hono();

const LoginBody = z.object({
  token: z.string().min(1).max(512),
});

/** Login and logout both change ambient state, so both carry the CSRF guard. */
auth.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    return c.json(
      { error: "origin_mismatch", message: "Cross-origin requests are not accepted." },
      403,
    );
  }
  await next();
});

auth.post("/login", async (c) => {
  let parsed: z.infer<typeof LoginBody>;
  try {
    const body = await c.req.json();
    parsed = LoginBody.parse(body);
  } catch {
    return c.json(
      { error: "invalid_body", message: "Request body must be JSON with a `token` string." },
      400,
    );
  }

  // A deployment with no admin token is a configuration state, not a bad
  // credential: say so, or the operator debugs the token they typed.
  if ((await resolveAdminToken()) === undefined) {
    return c.json(
      {
        error: "admin_token_missing",
        message:
          "No admin token is configured. Set BRAIN_ADMIN_TOKEN, or restart so /data/admin-token is generated.",
      },
      503,
    );
  }

  if (!(await verifyAdminToken(parsed.token))) {
    // No cookie on a refusal. The message never repeats the credential.
    return c.json({ error: "unauthorized", message: "That token was not accepted." }, 401);
  }

  const key = await sessionKey();
  if (key === null) {
    // Unreachable while the check above passed, but fail closed if a rotation
    // removed the token between the two reads.
    return c.json(
      { error: "admin_token_missing", message: "No admin token is configured." },
      503,
    );
  }
  writeSessionCookie(c, key);
  return c.json({ ok: true, isAdmin: true }, 200);
});

auth.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true }, 200);
});

/**
 * The boot probe. A 200 in every state: `authenticated:false` is the ordinary
 * first visit, and an SPA that had to treat 401 as "logged out" would need a
 * special case in exactly the place this route exists to remove one.
 */
auth.get("/session", async (c) => {
  const key = await sessionKey();
  const authenticated = readSession(getCookie(c, SESSION_COOKIE), key);
  return c.json({ authenticated, isAdmin: authenticated }, 200);
});
