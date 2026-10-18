/**
 * The one Ollama call layer (PIPE-06, PIPE-08; T-P4-01, T-P4-03).
 *
 * The provider has no JSON-schema mode, so this module deliberately sends the
 * plain chat shape and nothing more: one system message, one user message,
 * `temperature: 0`, `stream: false`, and no `format` field.
 *
 * Every seam is injected (`fetchImpl`, `sleep`) so a spec never reaches the
 * network and never waits on a backoff. `baseUrl` is a per-call option, not a
 * constructor argument, because the locked decision takes it from the job's
 * settings snapshot rather than process configuration.
 *
 * The API key lives in exactly one place: the `Authorization` header. It is
 * never put in the body, the URL, or an error message. `redactSecret` is the
 * belt-and-braces pass over every message this module constructs (T-P4-01).
 */
import { writeTextAtomic } from "../http/writeAtomic.js";

/** The production endpoint; a job may override it from its settings snapshot. */
export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com";

/** The two roles this pipeline ever sends. */
export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

/** Everything needed for one bounded chat call. */
export interface LlmChatOptions {
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** A job cancellation signal; combined with the per-call deadline. */
  signal?: AbortSignal;
  /** When set, the exact reply text is written here before the call returns. */
  rawPath?: string;
}

/** The provider usage report, with absent counts reported as `0`. */
export interface LlmReply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** The injectable seam every stage depends on instead of `fetch` directly. */
export interface LlmClient {
  chat(messages: readonly LlmMessage[], options: LlmChatOptions): Promise<LlmReply>;
}

/** A non-2xx reply that outlived the retry policy. Carries only the status. */
export class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Ollama returned HTTP ${status}.`);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

/** A 2xx reply whose body does not match the agreed envelope. */
export class LlmProtocolError extends Error {
  constructor(message = "Ollama returned an unexpected response body.") {
    super(message);
    this.name = "LlmProtocolError";
  }
}

/**
 * Replace every occurrence of `secret` with `[redacted]`. An absent or empty
 * secret is a no-op, so a keyless server never mangles an unrelated message.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") return text;
  return text.split(secret).join("[redacted]");
}

export interface OllamaClientDeps {
  apiKey: string;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Defaults to a real timer; injected so a backoff spec does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isAbortName(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * An abort is reported under its own name, never as a network failure. A
 * caller cancellation wins over the deadline, because both can be true at once.
 */
function abortError(outer: AbortSignal | undefined, timeoutMs: number): Error {
  const cancelled = outer?.aborted === true;
  const error = new Error(
    cancelled
      ? "The LLM call was cancelled."
      : `The LLM call timed out after ${timeoutMs} ms.`,
  );
  error.name = cancelled ? "AbortError" : "TimeoutError";
  return error;
}

/** A provider usage field is a finite non-negative integer or it is `0`. */
function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * Build the client once per process. Every value that can differ between jobs
 * arrives per call, so one client serves every vault and every job.
 */
export function createOllamaClient(deps: OllamaClientDeps): LlmClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const apiKey = deps.apiKey;

  return {
    async chat(messages, options) {
      const url = `${options.baseUrl.replace(/\/+$/, "")}/api/chat`;
      const body = JSON.stringify({
        model: options.model,
        messages,
        stream: false,
        options: { temperature: 0 },
      });

      for (let attempt = 0; ; attempt += 1) {
        const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
        if (options.signal !== undefined) signals.push(options.signal);
        const signal = AbortSignal.any(signals);

        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body,
            signal,
          });
        } catch (error) {
          if (signal.aborted || isAbortName(error)) {
            // A timeout or cancellation is not a retryable network failure.
            throw abortError(options.signal, options.timeoutMs);
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(redactSecret(`Ollama request failed: ${message}`, apiKey));
        }

        if (response.ok) {
          let envelope: unknown;
          try {
            envelope = await response.json();
          } catch {
            throw new LlmProtocolError("Ollama returned a body that is not JSON.");
          }

          const candidate = envelope as {
            message?: { content?: unknown };
            prompt_eval_count?: unknown;
            eval_count?: unknown;
          } | null;
          const text = candidate?.message?.content;
          if (typeof text !== "string") {
            throw new LlmProtocolError("Ollama returned no message content.");
          }

          // The raw reply is on disk before the caller parses it, so a
          // malformed reply can always be reproduced from the job directory.
          if (options.rawPath !== undefined) {
            await writeTextAtomic(options.rawPath, text);
          }

          return {
            text,
            tokensIn: usageCount(candidate?.prompt_eval_count),
            tokensOut: usageCount(candidate?.eval_count),
          };
        }

        // 429 and 5xx are retryable; any other status fails on the first reply.
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < options.maxRetries
        ) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new LlmHttpError(response.status);
      }
    },
  };
}
