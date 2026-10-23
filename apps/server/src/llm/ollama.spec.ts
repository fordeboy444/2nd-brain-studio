import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOllamaClient,
  DEFAULT_OLLAMA_BASE_URL,
  LlmHttpError,
  LlmProtocolError,
  redactSecret,
  type LlmChatOptions,
  type LlmMessage,
} from "./ollama.js";

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You extract JSON." },
  { role: "user", content: "Extract this transcript." },
];

const OPTIONS: LlmChatOptions = {
  model: "test-model",
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  timeoutMs: 1_000,
  maxRetries: 0,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A recording fake `fetch`. The handler decides each reply. */
function recordingFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; impl: typeof globalThis.fetch } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { calls, impl };
}

function okReply(content = "hello", usage?: { in?: number; out?: number }): Response {
  return new Response(
    JSON.stringify({
      message: { content },
      prompt_eval_count: usage?.in,
      eval_count: usage?.out,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("createOllamaClient request shape", () => {
  it("posts one system plus one user message to the per-call base URL", async () => {
    const { calls, impl } = recordingFetch(() => okReply());
    const client = createOllamaClient({ apiKey: "marker-key", fetchImpl: impl });

    await client.chat(MESSAGES, { ...OPTIONS, baseUrl: "https://ollama.com/" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ollama.com/api/chat");
    expect(headersOf(calls[0] as FetchCall).Authorization).toBe("Bearer marker-key");
    expect(headersOf(calls[0] as FetchCall)["content-type"]).toBe("application/json");

    const body = bodyOf(calls[0] as FetchCall);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ temperature: 0 });
    expect(body).not.toHaveProperty("format");
    expect(body).not.toHaveProperty("response_format");
  });

  it("takes the base URL from the call options, not the constructor", async () => {
    const { calls, impl } = recordingFetch(() => okReply());
    const client = createOllamaClient({ apiKey: "marker-key", fetchImpl: impl });

    await client.chat(MESSAGES, { ...OPTIONS, baseUrl: "https://example.test/proxy" });

    expect(calls[0]?.url).toBe("https://example.test/proxy/api/chat");
  });

  it("never lets the key reach the body or the URL", async () => {
    const secret = "marker-secret-9f3c1b";
    const { calls, impl } = recordingFetch(() => okReply());
    const client = createOllamaClient({ apiKey: secret, fetchImpl: impl });

    await client.chat(MESSAGES, OPTIONS);

    expect(calls[0]?.url).not.toContain(secret);
    expect(String(calls[0]?.init.body)).not.toContain(secret);
    expect(JSON.stringify(headersOf(calls[0] as FetchCall))).toContain(
      `Bearer ${secret}`,
    );
  });

  it("resolves a provided key on every call, so a saved key needs no restart", async () => {
    const keys = ["sk-first", "sk-second"];
    let reads = 0;
    const { calls, impl } = recordingFetch(() => okReply());
    const client = createOllamaClient({
      apiKey: async () => keys[reads++],
      fetchImpl: impl,
    });

    await client.chat(MESSAGES, OPTIONS);
    await client.chat(MESSAGES, OPTIONS);

    expect(reads).toBe(2);
    expect(headersOf(calls[0] as FetchCall).Authorization).toBe("Bearer sk-first");
    expect(headersOf(calls[1] as FetchCall).Authorization).toBe("Bearer sk-second");
  });
});

describe("createOllamaClient reply mapping", () => {
  it("maps prompt_eval_count/eval_count and reports absent counts as zero", async () => {
    const withUsage = recordingFetch(() => okReply("a", { in: 12, out: 34 }));
    const client = createOllamaClient({ apiKey: "k", fetchImpl: withUsage.impl });
    await expect(client.chat(MESSAGES, OPTIONS)).resolves.toEqual({
      text: "a",
      tokensIn: 12,
      tokensOut: 34,
    });

    const withoutUsage = recordingFetch(() => okReply("b"));
    const second = createOllamaClient({ apiKey: "k", fetchImpl: withoutUsage.impl });
    await expect(second.chat(MESSAGES, OPTIONS)).resolves.toEqual({
      text: "b",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("rejects a 2xx body with no message content", async () => {
    const { impl } = recordingFetch(() => new Response("{}", { status: 200 }));
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });

    await expect(client.chat(MESSAGES, OPTIONS)).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it("rejects a 2xx body that is not JSON", async () => {
    const { impl } = recordingFetch(() => new Response("<html>", { status: 200 }));
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });

    await expect(client.chat(MESSAGES, OPTIONS)).rejects.toBeInstanceOf(LlmProtocolError);
  });
});

describe("createOllamaClient retry policy", () => {
  it("retries a 429 with the first backoff step", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const { calls, impl } = recordingFetch(() => {
      attempt += 1;
      return attempt === 1 ? new Response("", { status: 429 }) : okReply("ok");
    });
    const client = createOllamaClient({
      apiKey: "k",
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.chat(MESSAGES, { ...OPTIONS, maxRetries: 1 })).resolves.toMatchObject({
      text: "ok",
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it("backs off exponentially across repeated 5xx replies", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const { calls, impl } = recordingFetch(() => {
      attempt += 1;
      return attempt <= 3 ? new Response("", { status: 503 }) : okReply("ok");
    });
    const client = createOllamaClient({
      apiKey: "k",
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await client.chat(MESSAGES, { ...OPTIONS, maxRetries: 3 });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([250, 500, 1_000]);
  });

  it("fails a 400 on the first attempt with no retry", async () => {
    const { calls, impl } = recordingFetch(
      () => new Response("bad marker-body", { status: 400 }),
    );
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });

    await expect(client.chat(MESSAGES, { ...OPTIONS, maxRetries: 4 })).rejects.toMatchObject({
      name: "LlmHttpError",
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it("throws LlmHttpError carrying only the status once retries are exhausted", async () => {
    const sleeps: number[] = [];
    const { calls, impl } = recordingFetch(
      () => new Response("provider-detail-marker", { status: 500 }),
    );
    const client = createOllamaClient({
      apiKey: "k",
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    let thrown: unknown;
    try {
      await client.chat(MESSAGES, { ...OPTIONS, maxRetries: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LlmHttpError);
    expect((thrown as LlmHttpError).status).toBe(500);
    expect(sleeps).toEqual([250, 500]);
    expect(calls).toHaveLength(3);
    // The upstream body is never echoed into the error.
    expect((thrown as Error).message).not.toContain("provider-detail-marker");
    expect((thrown as Error).message).toBe("Ollama returned HTTP 500.");
  });

  it("aborts on the per-call timeout and does not retry", async () => {
    const { calls, impl } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          });
        }),
    );
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });

    await expect(
      client.chat(MESSAGES, { ...OPTIONS, timeoutMs: 5, maxRetries: 3 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces a caller cancellation as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, impl } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted === true) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });

    await expect(
      client.chat(MESSAGES, { ...OPTIONS, signal: controller.signal, maxRetries: 3 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });
});

describe("createOllamaClient raw replies and redaction", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ollama-spec-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the exact reply text to rawPath before the caller parses it", async () => {
    const raw = '{"slug": "x", broken';
    const { impl } = recordingFetch(() => okReply(raw));
    const client = createOllamaClient({ apiKey: "k", fetchImpl: impl });
    const rawPath = join(root, "llm", "S2-video-1.txt");

    const reply = await client.chat(MESSAGES, { ...OPTIONS, rawPath });
    expect(reply.text).toBe(raw);

    // A deliberately failing parse after the call proves the file predates it.
    expect(() => JSON.parse(reply.text)).toThrow();
    expect(await readFile(rawPath, "utf8")).toBe(raw);
  });

  it("never leaks the key into a thrown message", async () => {
    const secret = "marker-secret-9f3c1b";
    const { impl } = recordingFetch(() => {
      throw new Error(`network exploded while sending ${secret}`);
    });
    const client = createOllamaClient({ apiKey: secret, fetchImpl: impl });

    let thrown: unknown;
    try {
      await client.chat(MESSAGES, OPTIONS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(secret);
    expect(message).toContain("[redacted]");
  });

  it("keeps the key out of the raw reply file", async () => {
    const secret = "marker-secret-9f3c1b";
    const { impl } = recordingFetch(() => okReply("plain reply"));
    const client = createOllamaClient({ apiKey: secret, fetchImpl: impl });
    const rawPath = join(root, "S2-video-1.txt");

    await client.chat(MESSAGES, { ...OPTIONS, rawPath });
    expect(await readFile(rawPath, "utf8")).not.toContain(secret);
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence and is a no-op for an empty secret", () => {
    expect(redactSecret("a SECRET b SECRET", "SECRET")).toBe("a [redacted] b [redacted]");
    expect(redactSecret("unchanged", undefined)).toBe("unchanged");
    expect(redactSecret("unchanged", "")).toBe("unchanged");
  });
});
