import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIG_ENV = { ...process.env };

async function loadConfig() {
  vi.resetModules();
  return (await import("./config.js")) as typeof import("./config.js");
}

beforeEach(() => {
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.SUPADATA_API_KEY;
  delete process.env.VAULT_ROOT;
  delete process.env.PORT;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
});

describe("optional / config (OPS-07)", () => {
  it("treats an empty OLLAMA_API_KEY as unset (llmConfigured false)", async () => {
    process.env.OLLAMA_API_KEY = "";
    const { config, optional } = await loadConfig();
    expect(optional("OLLAMA_API_KEY")).toBeUndefined();
    expect(config.ollamaApiKey).toBeUndefined();
    expect(config.llmConfigured).toBe(false);
  });

  it("treats an all-whitespace value as unset", async () => {
    process.env.OLLAMA_API_KEY = "   ";
    const { config, optional } = await loadConfig();
    expect(optional("OLLAMA_API_KEY")).toBeUndefined();
    expect(config.ollamaApiKey).toBeUndefined();
    expect(config.llmConfigured).toBe(false);
  });

  it("trims leading and trailing whitespace from a present value", async () => {
    process.env.OLLAMA_API_KEY = "  sk-test  ";
    const { config } = await loadConfig();
    expect(config.ollamaApiKey).toBe("sk-test");
    expect(config.llmConfigured).toBe(true);
  });

  it("reports healthy when the key is present", async () => {
    process.env.OLLAMA_API_KEY = "sk-real";
    const { config } = await loadConfig();
    expect(config.llmConfigured).toBe(true);
  });

  it("falls back to /data/vaults when VAULT_ROOT is unset", async () => {
    const { config } = await loadConfig();
    expect(config.vaultRoot).toBe("/data/vaults");
  });

  it("honours VAULT_ROOT when set", async () => {
    process.env.VAULT_ROOT = "/tmp/some-vaults";
    const { config } = await loadConfig();
    expect(config.vaultRoot).toBe("/tmp/some-vaults");
  });

  it("defaults PORT to 3010 and parses an override", async () => {
    const { config: c1 } = await loadConfig();
    expect(c1.port).toBe(3010);
    process.env.PORT = "4010";
    const { config: c2 } = await loadConfig();
    expect(c2.port).toBe(4010);
  });

  it("config is frozen", async () => {
    const { config } = await loadConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });
});