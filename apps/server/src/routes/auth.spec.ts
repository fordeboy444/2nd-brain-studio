import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session routes, driven directly through their router.
 *
 * The subject is the cookie contract: a correct admin token sets exactly one
 * `brain_session` that is HttpOnly, a wrong one sets nothing, and `/session`
 * reports the truth of the cookie it is handed. The admin token never leaves
 * the server in any response body.
 */

const ORIG_ENV = { ...process.env };

async function reload() {
  vi.resetModules();
  return (await import("./auth.js")) as typeof import("./auth.js");
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** The `name=value` half of a Set-Cookie header, for replaying as a request. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

beforeEach(() => {
  process.env.BRAIN_ADMIN_TOKEN = "test-admin";
  delete process.env.AUTH_TEST_BYPASS;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("POST /api/login", () => {
  it("accepts the admin token and sets an HttpOnly brain_session cookie", async () => {
    const { auth } = await reload();
    const res = await auth.request("/login", jsonRequest({ token: "test-admin" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, isAdmin: true });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("brain_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    // The credential is never echoed back.
    expect(text).not.toContain("test-admin");
  });

  it("refuses a wrong token with 401 and no Set-Cookie", async () => {
    const { auth } = await reload();
    const res = await auth.request("/login", jsonRequest({ token: "wrong" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(JSON.stringify(body)).not.toContain("wrong");
  });

  it("rejects a malformed body with 400", async () => {
    const { auth } = await reload();
    const res = await auth.request("/login", jsonRequest({ token: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("answers 503, not 401, when the deployment has no admin token", async () => {
    process.env.BRAIN_ADMIN_TOKEN = "   ";
    process.env.ADMIN_TOKEN_PATH = "/nonexistent/dir/admin-token";
    const { auth } = await reload();
    const res = await auth.request("/login", jsonRequest({ token: "anything" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("admin_token_missing");
  });

  it("refuses a cross-origin login with 403", async () => {
    const { auth } = await reload();
    const res = await auth.request("/login", {
      ...jsonRequest({ token: "test-admin" }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("origin_mismatch");
  });
});

describe("GET /api/session", () => {
  it("answers 200 with authenticated:false and no cookie", async () => {
    const { auth } = await reload();
    const res = await auth.request("/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, isAdmin: false });
  });

  it("reports authenticated:true for a cookie minted by login", async () => {
    const { auth } = await reload();
    const login = await auth.request("/login", jsonRequest({ token: "test-admin" }));
    const cookie = cookiePair(login.headers.get("set-cookie") ?? "");
    expect(cookie).toContain("brain_session=");

    const res = await auth.request("/session", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, isAdmin: true });
  });

  it("rejects a forged cookie", async () => {
    const { auth } = await reload();
    const res = await auth.request("/session", {
      headers: { cookie: "brain_session=eyJzdWIiOiJhZG1pbiJ9.forged" },
    });
    expect(await res.json()).toEqual({ authenticated: false, isAdmin: false });
  });
});

describe("POST /api/logout", () => {
  it("expires the cookie", async () => {
    const { auth } = await reload();
    const res = await auth.request("/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("brain_session=");
    // hono/cookie expires by writing an empty value with Max-Age=0 (or a past
    // Expires); either spelling clears the browser's copy.
    expect(setCookie.includes("Max-Age=0") || setCookie.includes("Expires=Thu, 01 Jan 1970")).toBe(true);
  });
});
