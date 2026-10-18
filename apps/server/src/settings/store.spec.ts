import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * `config` is frozen at module load, so each case sets VAULT_ROOT to a fresh
 * temporary directory and reloads the module graph before reading settings.
 */

const ORIGINAL_VAULT_ROOT = process.env.VAULT_ROOT;

let root = "";

async function reload(): Promise<
  typeof import("./store.js") & { model: string }
> {
  vi.resetModules();
  const store = await import("./store.js");
  const { config } = await import("../config.js");
  return { ...store, model: config.ollamaModel };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-store-"));
  process.env.VAULT_ROOT = root;
});

afterEach(async () => {
  if (ORIGINAL_VAULT_ROOT === undefined) delete process.env.VAULT_ROOT;
  else process.env.VAULT_ROOT = ORIGINAL_VAULT_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe("defaultSettings", () => {
  it("describes the full non-secret surface", async () => {
    const { defaultSettings, model } = await reload();

    expect(defaultSettings()).toEqual({
      llm: { model, concurrency: 1, requestTimeoutMs: 120_000, maxRetries: 3 },
      fetch: { delayMs: 1_000, concurrency: 2, language: "en" },
      sweep: { enabled: true },
      ui: { theme: "system" },
    });
  });

  it("puts settings.json at the vault root", async () => {
    const { settingsPath } = await reload();
    expect(settingsPath()).toBe(join(root, "settings.json"));
  });
});

describe("readSettings", () => {
  it("returns the defaults when the file is missing", async () => {
    const { defaultSettings, readSettings } = await reload();
    expect(await readSettings()).toEqual(defaultSettings());
  });

  it("returns the defaults when the file is corrupt JSON", async () => {
    const { defaultSettings, readSettings, settingsPath } = await reload();
    await writeFile(settingsPath(), "not json {", "utf8");
    expect(await readSettings()).toEqual(defaultSettings());
  });

  it("returns the defaults when a stored value violates the schema", async () => {
    const { defaultSettings, readSettings, settingsPath } = await reload();
    await writeFile(settingsPath(), JSON.stringify({ llm: { concurrency: 99 } }), "utf8");
    expect(await readSettings()).toEqual(defaultSettings());
  });

  it("deep-merges a partial file over the defaults", async () => {
    const { defaultSettings, readSettings, settingsPath } = await reload();
    await writeFile(
      settingsPath(),
      JSON.stringify({ ui: { theme: "dark" }, fetch: { delayMs: 25 } }),
      "utf8",
    );

    const settings = await readSettings();
    expect(settings.ui.theme).toBe("dark");
    expect(settings.fetch.delayMs).toBe(25);
    expect(settings.fetch.concurrency).toBe(defaultSettings().fetch.concurrency);
    expect(settings.llm).toEqual(defaultSettings().llm);
  });
});

describe("writeSettings", () => {
  it("merges a valid patch over the current settings and writes it atomically", async () => {
    const { readSettings, settingsPath, writeSettings } = await reload();

    const next = await writeSettings({ ui: { theme: "light" } });
    expect(next.ui.theme).toBe("light");
    expect(await readSettings()).toEqual(next);

    const stored = JSON.parse(await readFile(settingsPath(), "utf8")) as {
      ui: { theme: string };
    };
    expect(stored.ui.theme).toBe("light");
  });

  it("strips unknown keys at both levels, including a secret-shaped field", async () => {
    const { settingsPath, writeSettings } = await reload();

    await writeSettings({
      llm: { model: "some-model", apiKey: "SECRET-VALUE" },
      bogus: true,
    });

    const stored = await readFile(settingsPath(), "utf8");
    expect(stored).not.toMatch(/"(key|apiKey|token|password)"/);
    expect(stored).not.toContain("SECRET-VALUE");

    const parsed = JSON.parse(stored) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["fetch", "llm", "sweep", "ui"]);
    expect(parsed.llm).not.toHaveProperty("apiKey");
    expect(parsed).not.toHaveProperty("bogus");
  });

  it("rejects an out-of-range value without writing", async () => {
    const { settingsPath, writeSettings } = await reload();

    await expect(writeSettings({ llm: { concurrency: 5 } })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    await expect(readFile(settingsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bad theme and an over-long model", async () => {
    const { writeSettings } = await reload();

    await expect(writeSettings({ ui: { theme: "neon" } })).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      writeSettings({ llm: { model: "m".repeat(129) } }),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
