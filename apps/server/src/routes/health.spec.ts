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

  it("reports readOnly:false by default and readOnly:true when secondary instance", async () => {
    const { health } = await reload();
    const res = await health.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readOnly).toBe(false);

    // Simulate secondary instance
    const { InstanceLockManager, setLockManagerForTesting } = await import("../lock.js");
    const mockManager = {
      getLockState: () => ({
        isReadOnly: true,
        lockHolder: { pid: 12345, host: "primary", startedAt: 1000, heartbeatAt: 2000 },
      }),
    } as unknown as InstanceLockManager;
    setLockManagerForTesting(mockManager);

    const resLocked = await health.request("/");
    const bodyLocked = await resLocked.json();
    expect(bodyLocked.readOnly).toBe(true);

    // Reset default
    setLockManagerForTesting(new InstanceLockManager());
  });

  it("blocks mutating API requests with 403 when readOnly is true", async () => {
    const { InstanceLockManager, setLockManagerForTesting } = await import("../lock.js");
    const mockManager = {
      getLockState: () => ({
        isReadOnly: true,
        lockHolder: { pid: 12345, host: "primary", startedAt: 1000, heartbeatAt: 2000 },
      }),
    } as unknown as InstanceLockManager;
    setLockManagerForTesting(mockManager);

    const { app } = await import("../http/app.js");

    // POST /api/vaults should be blocked
    const postRes = await app.request("/api/vaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blocked Vault" }),
    });
    expect(postRes.status).toBe(403);
    const postBody = await postRes.json();
    expect(postBody.error).toBe("read_only");

    // GET /api/health should still succeed with 200
    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);

    // Reset default
    setLockManagerForTesting(new InstanceLockManager());
  });
});