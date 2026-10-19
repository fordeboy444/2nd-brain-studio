import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { sameOrigin } from "./origin.js";

/** A route that reports the guard's verdict for the incoming request. */
function guardApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ same: sameOrigin(c) }));
  return app;
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
