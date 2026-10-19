import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sameOrigin } from "./origin.js";

/** A route that reports the guard's verdict for the incoming request. */
function appWith(guard: (c: Context) => boolean): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ same: guard(c) }));
  return app;
}

function guardApp(): Hono {
  return appWith(sameOrigin);
}

/** Import `sameOrigin` again with `APP_ORIGIN` set, as a fresh boot would. */
async function reloadWithAppOrigin(value: string): Promise<Hono> {
  process.env.APP_ORIGIN = value;
  vi.resetModules();
  const fresh = (await import("./origin.js")) as typeof import("./origin.js");
  return appWith(fresh.sameOrigin);
}

describe("sameOrigin", () => {
  it("accepts a request with no Origin header", async () => {
    const res = await guardApp().request("/");
    expect(await res.json()).toEqual({ same: true });
  });

  it("accepts an Origin that matches X-Forwarded-Host", async () => {
    const res = await guardApp().request("/", {
      headers: {
        Origin: "http://localhost:5173",
        "X-Forwarded-Host": "localhost:5173",
      },
    });
    expect(await res.json()).toEqual({ same: true });
  });

  it("uses the first host in a forwarded list (the browser-facing one)", async () => {
    // Vite's proxy with `xfwd` appends the forwarded host; a later proxy hop
    // may append its own. The leftmost entry is what the browser used.
    const res = await guardApp().request("/", {
      headers: {
        Origin: "http://localhost:5173",
        "X-Forwarded-Host": "localhost:5173, internal:3010",
      },
    });
    expect(await res.json()).toEqual({ same: true });
  });

  it("rejects a cross-origin request", async () => {
    const res = await guardApp().request("/", {
      headers: {
        Origin: "http://evil.example",
        "X-Forwarded-Host": "localhost:5173",
      },
    });
    expect(await res.json()).toEqual({ same: false });
  });
});

describe("sameOrigin with APP_ORIGIN (WR-12)", () => {
  afterEach(() => {
    delete process.env.APP_ORIGIN;
    vi.resetModules();
  });

  it("rejects an Origin that echoes the forged X-Forwarded-Host", async () => {
    const app = await reloadWithAppOrigin("https://brain.example");
    const res = await app.request("/", {
      headers: {
        Origin: "https://evil.example",
        // The old guard trusted this header; the allowlist ignores it.
        "X-Forwarded-Host": "evil.example",
      },
    });
    expect(await res.json()).toEqual({ same: false });
  });

  it("accepts an origin on the allowlist", async () => {
    const app = await reloadWithAppOrigin("https://brain.example, http://localhost:5173");
    const res = await app.request("/", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(await res.json()).toEqual({ same: true });
  });

  it("rejects a different scheme or port on the same host", async () => {
    const app = await reloadWithAppOrigin("https://brain.example");
    const wrongScheme = await app.request("/", {
      headers: { Origin: "http://brain.example" },
    });
    const wrongPort = await app.request("/", {
      headers: { Origin: "https://brain.example:8443" },
    });
    expect(await wrongScheme.json()).toEqual({ same: false });
    expect(await wrongPort.json()).toEqual({ same: false });
  });

  it("still accepts a request with no Origin", async () => {
    const app = await reloadWithAppOrigin("https://brain.example");
    const res = await app.request("/");
    expect(await res.json()).toEqual({ same: true });
  });
});
