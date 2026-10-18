/**
 * The vault-global content-addressed LLM cache (PIPE-06; T-P4-02).
 *
 * Every paid unit is keyed by the model, the stage's prompt version and a
 * canonical hash of the messages. Two jobs over the same inputs on one vault
 * therefore share every result, and an identical re-run makes zero calls.
 *
 * A cache file is a hash — user text can change which file is read but can
 * never name it. The stored `output` is the validated object, never raw text,
 * and the atomic temp+rename writer means a reader never sees a partial entry.
 * `get` returns `null` for a missing, corrupt or mismatched entry instead of
 * throwing, so a damaged cache costs one re-fetch and nothing else.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../http/writeAtomic.js";
import { callJson } from "./json.js";
import type { LlmClient, LlmMessage } from "./ollama.js";

/** A cache file name is always this shape; anything else cannot be a path. */
const KEY_RE = /^[0-9a-f]{64}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonical(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * JSON with recursively sorted object keys and LF newlines, so two equal
 * message arrays serialise to the same bytes regardless of key order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value), null, 2);
}

/** `sha256(stableStringify(messages))`, lowercase hex. */
export function hashMessages(messages: readonly LlmMessage[]): string {
  return createHash("sha256").update(stableStringify(messages)).digest("hex");
}

/**
 * `sha256(model + PROMPT_VERSION + sha256(canonicalMessages))`. A model change
 * or a stage prompt edit changes the key and invalidates only that unit.
 */
export function cacheKey(input: {
  model: string;
  promptVersion: string;
  messages: readonly LlmMessage[];
}): string {
  const material = `${input.model}\n${input.promptVersion}\n${hashMessages(
    input.messages,
  )}`;
  return createHash("sha256").update(material).digest("hex");
}

/** One stored unit. `output` is the validated object, never raw text. */
export interface CacheEntry<T> {
  key: string;
  model: string;
  promptVersion: string;
  stage: string;
  inputHash: string;
  output: T;
  tokensIn: number;
  tokensOut: number;
  at: string;
}

/** The cache seam every stage takes instead of touching a path. */
export interface LlmCache {
  pathFor(key: string): string;
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  put<T>(entry: CacheEntry<T>): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrap one cache directory. The directory is created lazily by the atomic
 * writer, so a vault that never makes an LLM call never grows the folder.
 */
export function createLlmCache(cacheDir: string): LlmCache {
  const pathFor = (key: string): string => {
    if (!KEY_RE.test(key)) {
      throw new Error("invalid cache key");
    }
    return join(cacheDir, `${key}.json`);
  };

  return {
    pathFor,

    async get<T>(key: string): Promise<CacheEntry<T> | null> {
      let raw: string;
      try {
        raw = await readFile(pathFor(key), "utf8");
      } catch {
        // ENOENT is a miss, not an error.
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A corrupt entry is ignored; the caller re-fetches exactly once.
        return null;
      }

      if (!isObject(parsed) || parsed.key !== key) return null;
      return parsed as unknown as CacheEntry<T>;
    },

    async put<T>(entry: CacheEntry<T>): Promise<void> {
      await writeJsonAtomic(pathFor(entry.key), entry);
    },
  };
}

export interface CachedRequest {
  model: string;
  baseUrl: string;
  promptVersion: string;
  stage: string;
  messages: readonly LlmMessage[];
  timeoutMs: number;
  maxRetries: number;
  /** A stable timestamp from the stage; never `Date.now()`. */
  at: string;
  rawPathForAttempt?: (attempt: number) => string | undefined;
}

export interface CachedResult<T> {
  output: T;
  tokensIn: number;
  tokensOut: number;
  at: string;
  hit: boolean;
}

/**
 * The one entry point every stage uses. A hit returns the stored validated
 * output and the entry's stable `at` with no client call and no write; a miss
 * runs the repair ladder once and stores the validated result. A failed call
 * writes nothing.
 */
export async function callCached<T>(
  cache: LlmCache,
  client: LlmClient,
  request: CachedRequest,
  schema: z.ZodType<T>,
): Promise<CachedResult<T>> {
  const key = cacheKey({
    model: request.model,
    promptVersion: request.promptVersion,
    messages: request.messages,
  });

  const cached = await cache.get<T>(key);
  if (cached !== null) {
    return {
      output: cached.output,
      tokensIn: cached.tokensIn,
      tokensOut: cached.tokensOut,
      at: cached.at,
      hit: true,
    };
  }

  // `callJson` returns the validated value; wrap the client to observe the
  // usage counters of the attempt that actually succeeded.
  let tokensIn = 0;
  let tokensOut = 0;
  const recording: LlmClient = {
    async chat(messages, options) {
      const reply = await client.chat(messages, options);
      tokensIn = reply.tokensIn;
      tokensOut = reply.tokensOut;
      return reply;
    },
  };

  const output = await callJson(recording, request.messages, schema, {
    model: request.model,
    baseUrl: request.baseUrl,
    timeoutMs: request.timeoutMs,
    maxRetries: request.maxRetries,
    rawPathForAttempt: request.rawPathForAttempt,
  });

  await cache.put({
    key,
    model: request.model,
    promptVersion: request.promptVersion,
    stage: request.stage,
    inputHash: hashMessages(request.messages),
    output,
    tokensIn,
    tokensOut,
    at: request.at,
  });

  return { output, tokensIn, tokensOut, at: request.at, hit: false };
}
