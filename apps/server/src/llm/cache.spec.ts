import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cacheKey,
  callCached,
  createLlmCache,
  hashMessages,
  stableStringify,
} from "./cache.js";
import { JsonRecoveryError } from "./json.js";
import type { LlmChatOptions, LlmClient, LlmMessage } from "./ollama.js";

const SCHEMA = z.object({ slug: z.string() }).strict();

const MESSAGES: readonly LlmMessage[] = [
  { role: "system", content: "Extract JSON." },
  { role: "user", content: "The transcript." },
];

const REQUEST = {
  model: "test-model",
  baseUrl: "https://ollama.com",
  promptVersion: "s2-v1",
  stage: "S2",
  messages: MESSAGES,
  timeoutMs: 1_000,
  maxRetries: 0,
  at: "2026-01-01T00:00:00.000Z",
};

interface FakeCall {
  messages: readonly LlmMessage[];
  options: LlmChatOptions;
}

function fakeClient(replies: readonly string[]): {
  client: LlmClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const client: LlmClient = {
    async chat(messages, options) {
      calls.push({ messages, options });
      const text = replies[Math.min(index, replies.length - 1)] ?? "";
      index += 1;
      return { text, tokensIn: 11, tokensOut: 22 };
    },
  };
  return { client, calls };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "llm-cache-spec-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stableStringify and cacheKey", () => {
  it("is independent of object-key insertion order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify([{ role: "user", content: "x" }])).toBe(
      stableStringify([{ content: "x", role: "user" }]),
    );
  });

  it("hashes reordered messages identically", () => {
    const ordered: LlmMessage[] = [{ role: "user", content: "x" }];
    const reordered: LlmMessage[] = [{ content: "x", role: "user" }];
    expect(hashMessages(ordered)).toBe(hashMessages(reordered));
  });

  it("produces a 64-character lowercase hex key", () => {
    const key = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across independent constructions", () => {
    const first = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });
    const second = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: [
        { content: "Extract JSON.", role: "system" },
        { content: "The transcript.", role: "user" },
      ],
    });
    expect(second).toBe(first);
  });

  it("changes when the model, the prompt version or the messages change", () => {
    const base = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });

    expect(
      cacheKey({ model: "other-model", promptVersion: "s2-v1", messages: MESSAGES }),
    ).not.toBe(base);
    expect(
      cacheKey({ model: "test-model", promptVersion: "s2-v2", messages: MESSAGES }),
    ).not.toBe(base);
    expect(
      cacheKey({
        model: "test-model",
        promptVersion: "s2-v1",
        messages: [{ role: "user", content: "different" }],
      }),
    ).not.toBe(base);
  });
});

describe("createLlmCache", () => {
  it("places an entry at <dir>/<64 hex>.json", () => {
    const cache = createLlmCache(root);
    const key = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });

    expect(cache.pathFor(key)).toBe(join(root, `${key}.json`));
  });

  it("refuses a path key that is not a 64-character hex hash", () => {
    const cache = createLlmCache(root);
    expect(() => cache.pathFor("../../etc/passwd")).toThrow();
    expect(() => cache.pathFor("not-a-hash")).toThrow();
  });

  it("round-trips an entry and returns null for a missing key", async () => {
    const cache = createLlmCache(root);
    const key = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });
    const entry = {
      key,
      model: "test-model",
      promptVersion: "s2-v1",
      stage: "S2",
      inputHash: hashMessages(MESSAGES),
      output: { slug: "a" },
      tokensIn: 1,
      tokensOut: 2,
      at: "2026-01-01T00:00:00.000Z",
    };

    expect(await cache.get(key)).toBeNull();
    await cache.put(entry);
    expect(await cache.get(key)).toEqual(entry);
  });

  it("returns null for a corrupt file and for a key mismatch", async () => {
    const cache = createLlmCache(root);
    const key = cacheKey({
      model: "test-model",
      promptVersion: "s2-v1",
      messages: MESSAGES,
    });

    await writeFile(cache.pathFor(key), "not json {", "utf8");
    expect(await cache.get(key)).toBeNull();

    const other = cacheKey({ model: "x", promptVersion: "y", messages: MESSAGES });
    await writeFile(
      cache.pathFor(key),
      JSON.stringify({ key: other, output: { slug: "wrong" } }),
      "utf8",
    );
    expect(await cache.get(key)).toBeNull();
  });
});

describe("callCached", () => {
  it("misses once, stores the validated object and reports a miss", async () => {
    const cache = createLlmCache(root);
    const { client, calls } = fakeClient(['{"slug":"a"}']);

    const first = await callCached(cache, client, REQUEST, SCHEMA);

    expect(first).toEqual({
      output: { slug: "a" },
      tokensIn: 11,
      tokensOut: 22,
      at: REQUEST.at,
      hit: false,
    });
    expect(calls).toHaveLength(1);

    const key = cacheKey({
      model: REQUEST.model,
      promptVersion: REQUEST.promptVersion,
      messages: REQUEST.messages,
    });
    const stored = JSON.parse(await readFile(cache.pathFor(key), "utf8")) as {
      output: unknown;
      key: string;
    };
    expect(stored.key).toBe(key);
    expect(stored.output).toEqual({ slug: "a" });
  });

  it("hits without a client call or a file write and keeps the stored `at`", async () => {
    const cache = createLlmCache(root);
    const first = fakeClient(['{"slug":"a"}']);
    await callCached(cache, first.client, REQUEST, SCHEMA);

    const key = cacheKey({
      model: REQUEST.model,
      promptVersion: REQUEST.promptVersion,
      messages: REQUEST.messages,
    });
    const before = await stat(cache.pathFor(key));

    const second = fakeClient(['{"slug":"different"}']);
    const hit = await callCached(
      cache,
      second.client,
      { ...REQUEST, at: "2027-09-09T00:00:00.000Z" },
      SCHEMA,
    );

    expect(hit).toEqual({
      output: { slug: "a" },
      tokensIn: 11,
      tokensOut: 22,
      at: REQUEST.at,
      hit: true,
    });
    expect(second.calls).toHaveLength(0);
    expect((await stat(cache.pathFor(key))).mtimeMs).toBe(before.mtimeMs);
  });

  it("ignores a corrupt entry and re-fetches exactly once", async () => {
    const cache = createLlmCache(root);
    const key = cacheKey({
      model: REQUEST.model,
      promptVersion: REQUEST.promptVersion,
      messages: REQUEST.messages,
    });
    await writeFile(cache.pathFor(key), "{ corrupt", "utf8");

    const { client, calls } = fakeClient(['{"slug":"a"}']);
    const result = await callCached(cache, client, REQUEST, SCHEMA);

    expect(result.hit).toBe(false);
    expect(calls).toHaveLength(1);
    const repaired = JSON.parse(await readFile(cache.pathFor(key), "utf8")) as {
      output: unknown;
    };
    expect(repaired.output).toEqual({ slug: "a" });
  });

  it("treats a schema-invalid stored output as a miss and re-fetches once", async () => {
    const cache = createLlmCache(root);
    const key = cacheKey({
      model: REQUEST.model,
      promptVersion: REQUEST.promptVersion,
      messages: REQUEST.messages,
    });
    await writeFile(
      cache.pathFor(key),
      JSON.stringify({
        key,
        model: REQUEST.model,
        promptVersion: REQUEST.promptVersion,
        stage: REQUEST.stage,
        inputHash: hashMessages(REQUEST.messages),
        output: { slug: 42 },
        tokensIn: 5,
        tokensOut: 6,
        at: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const { client, calls } = fakeClient(['{"slug":"a"}']);
    const result = await callCached(cache, client, REQUEST, SCHEMA);

    expect(result.hit).toBe(false);
    expect(result.output).toEqual({ slug: "a" });
    expect(calls).toHaveLength(1);
    const repaired = JSON.parse(await readFile(cache.pathFor(key), "utf8")) as {
      output: unknown;
    };
    expect(repaired.output).toEqual({ slug: "a" });
  });

  it("writes no entry when the reply is unrecoverable", async () => {
    const cache = createLlmCache(root);
    const { client } = fakeClient(["not json at all"]);

    await expect(callCached(cache, client, REQUEST, SCHEMA)).rejects.toBeInstanceOf(
      JsonRecoveryError,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("misses across a different model, prompt version and messages", async () => {
    const cache = createLlmCache(root);
    const { client, calls } = fakeClient(['{"slug":"a"}']);

    await callCached(cache, client, REQUEST, SCHEMA);
    await callCached(cache, client, { ...REQUEST, model: "other" }, SCHEMA);
    await callCached(cache, client, { ...REQUEST, promptVersion: "s2-v2" }, SCHEMA);
    await callCached(
      cache,
      client,
      { ...REQUEST, messages: [{ role: "user", content: "other" }] },
      SCHEMA,
    );

    expect(calls).toHaveLength(4);
  });

  it("passes the caller's raw-path namer through to the client", async () => {
    const cache = createLlmCache(root);
    const { client, calls } = fakeClient(['{"slug":"a"}']);

    await callCached(
      cache,
      client,
      { ...REQUEST, rawPathForAttempt: (attempt) => `/job/llm/S2-unit-${attempt}.txt` },
      SCHEMA,
    );

    expect(calls[0]?.options.rawPath).toBe("/job/llm/S2-unit-1.txt");
  });
});
