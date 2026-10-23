/**
 * The job path resolves the Ollama key at call time
 * (settings-no-ollama-key-input).
 *
 * Before the fix the bootstrap froze the key from `OLLAMA_API_KEY` at boot:
 * a key saved in Settings could never reach a running job. These specs pin the
 * two behaviours the fix depends on - a key pasted on disk is used by the next
 * chat call with no reload, and an absent key is still the typed
 * `llm_not_configured` skip rather than a `model_error`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChatOptions, LlmMessage } from "../llm/ollama.js";

const MESSAGES: LlmMessage[] = [{ role: "user", content: "Extract JSON." }];

const OPTIONS: LlmChatOptions = {
  model: "test-model",
  baseUrl: "https://ollama.example",
  timeoutMs: 1_000,
  maxRetries: 0,
};

const ORIGINAL_KEY = process.env.OLLAMA_API_KEY;
const ORIGINAL_KEY_PATH = process.env.OLLAMA_KEY_PATH;

let root = "";
let keyPath = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bootstrap-key-"));
  keyPath = join(root, "ollama-api-key");
  delete process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_KEY_PATH = keyPath;
  vi.resetModules();
});

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_KEY_PATH === undefined) delete process.env.OLLAMA_KEY_PATH;
  else process.env.OLLAMA_KEY_PATH = ORIGINAL_KEY_PATH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Build the real deps after the env is set, as the server does at boot. */
async function freshDeps() {
  const { createIngestStageDeps } = await import("./bootstrap.js");
  return createIngestStageDeps({ supadataKey: null });
}

function okReply(): Response {
  return new Response(
    JSON.stringify({ message: { content: "hello" }, prompt_eval_count: 1, eval_count: 1 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createIngestStageDeps Ollama key resolution", () => {
  it("skips with llm_not_configured when neither env nor file carries a key", async () => {
    const deps = await freshDeps();

    await expect(deps.llm?.chat(MESSAGES, OPTIONS)).rejects.toMatchObject({
      name: "SkipError",
      reason: "llm_not_configured",
    });
  });

  it("uses a key saved to disk after boot, with no restart", async () => {
    // The client captures `globalThis.fetch` when it is constructed, so the
    // stub has to exist before the deps are built.
    const fetchMock = vi.fn(async () => okReply());
    vi.stubGlobal("fetch", fetchMock);
    const deps = await freshDeps();

    // Boot had no key: the first call is the typed skip.
    await expect(deps.llm?.chat(MESSAGES, OPTIONS)).rejects.toMatchObject({
      reason: "llm_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The Settings route lands the key; the same deps instance now uses it.
    await writeFile(keyPath, "sk-pasted-in-settings\n", { mode: 0o600 });

    const reply = await deps.llm?.chat(MESSAGES, OPTIONS);
    expect(reply?.text).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-pasted-in-settings",
    );
  });

  it("keeps OLLAMA_API_KEY authoritative over a key on disk", async () => {
    process.env.OLLAMA_API_KEY = "sk-from-env";
    const fetchMock = vi.fn(async () => okReply());
    vi.stubGlobal("fetch", fetchMock);
    const deps = await freshDeps();
    await writeFile(keyPath, "sk-from-settings\n", { mode: 0o600 });

    await deps.llm?.chat(MESSAGES, OPTIONS);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-from-env");
  });
});
