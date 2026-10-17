import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ORIG_ENV = { ...process.env };

async function reload() {
  vi.resetModules();
  return (await import("./health.js")) as typeof import("./health.js");
}

beforeEach(() => {
  delete process.env.OLLAMA_API_KEY;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
});

describe("GET / (health router, mounted at /api/health by app)", () => {
  it("answers 200 with ok:false and status:degraded when key is absent", async () => {
    const { health } = await reload();
    const res = await health.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.service).toBe("2nd-brain-studio");
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.time).toBe("string");
  });

  it("answers ok:true and status:healthy when key is present", async () => {
    process.env.OLLAMA_API_KEY = "sk-real";
    const { health } = await reload();
    const res = await health.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
  });

  it("never includes any secret key in the payload", async () => {
    process.env.OLLAMA_API_KEY = "sk-leak";
    process.env.SUPADATA_API_KEY = "sup-leak";
    const { health } = await reload();
    const res = await health.request("/");
    const body = await res.json();
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain("sk-leak");
    expect(text).not.toContain("sup-leak");
    for (const k of Object.keys(body)) {
      expect(k.toLowerCase()).not.toContain("key");
      expect(k.toLowerCase()).not.toContain("token");
    }
    expect(body).not.toHaveProperty("ollamaApiKey");
    expect(body).not.toHaveProperty("supadataApiKey");
  });
});