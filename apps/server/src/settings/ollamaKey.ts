/**
 * The Ollama API key file (settings-no-ollama-key-input).
 *
 * The key lives on disk exactly the way the YouTube cookie does: a single file
 * at `config.ollamaKeyPath`, written at mode 0600 through the atomic
 * temp+rename path, and reported back to the browser only as presence + mtime.
 * The browser never receives the key body: the upload route validates the raw
 * `text/plain` body, `writeOllamaKey` lands it, and `ollamaKeyStatus` reports
 * only existence and mtime.
 *
 * Resolution order is `config.ollamaApiKey` (the `OLLAMA_API_KEY` environment
 * variable, read once at boot) FIRST, then the file. A deploy that pins a key
 * in the environment therefore wins over a key pasted in Settings, so a
 * Coolify env var stays authoritative when set; when unset, the in-app key is
 * used. Because every consumer calls `resolveOllamaKey` at call time (not at
 * boot), saving a key in Settings takes effect without a restart.
 */
import { rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { writeTextAtomic } from "../http/writeAtomic.js";

/** Body cap for the raw `text/plain` upload. A bearer token is far under this. */
export const MAX_OLLAMA_KEY_BYTES = 4096;

export type OllamaKeyInvalidReason = "empty" | "too_large" | "bad_shape";

export interface OllamaKeyValidation {
  ok: boolean;
  reason?: OllamaKeyInvalidReason;
}

/**
 * Validate one Ollama API key without touching disk.
 *
 * A valid key is a single non-empty line: after trimming, it is non-empty,
 * under the byte cap, and carries no tab, CR or LF (a multi-line value would
 * break an `Authorization: Bearer <key>` header and is refused here rather than
 * at the network).
 */
export function validateOllamaKey(text: string): OllamaKeyValidation {
  if (Buffer.byteLength(text, "utf8") > MAX_OLLAMA_KEY_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (/[\t\r\n]/.test(trimmed)) return { ok: false, reason: "bad_shape" };
  return { ok: true };
}

/**
 * Store a validated key at mode 0600. The temp file is chmodded before the
 * rename, so the target path is never world-readable, not even briefly.
 */
export async function writeOllamaKey(text: string): Promise<void> {
  const body = text.trim();
  await writeTextAtomic(config.ollamaKeyPath, `${body}\n`, 0o600);
}

/** Remove the key file. Idempotent: a missing file is not an error. */
export async function deleteOllamaKey(): Promise<void> {
  await rm(config.ollamaKeyPath, { force: true });
}

/**
 * Read the stored key, or undefined when absent/empty. The env var
 * (`config.ollamaApiKey`) is authoritative and takes precedence in
 * `resolveOllamaKey`; this reader is the file fallback.
 */
export async function readOllamaKey(): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(config.ollamaKeyPath, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The key a live call should use, resolved at call time. The environment wins
 * over the file so a deploy-pinned key stays authoritative; when the env var is
 * unset, the in-app pasted key is used. Returns undefined when neither exists.
 */
export async function resolveOllamaKey(): Promise<string | undefined> {
  return config.ollamaApiKey ?? (await readOllamaKey());
}

export interface OllamaKeyStatus {
  hasOllamaKey: boolean;
  ollamaKeyUpdatedAt: string | null;
}

/**
 * Redacted status for the browser: presence plus mtime, never the body. A file
 * removed between the stat and the answer is reported as absent rather than
 * throwing.
 */
export async function ollamaKeyStatus(): Promise<OllamaKeyStatus> {
  try {
    const info = await stat(config.ollamaKeyPath);
    return {
      hasOllamaKey: true,
      ollamaKeyUpdatedAt: info.mtime.toISOString(),
    };
  } catch {
    return { hasOllamaKey: false, ollamaKeyUpdatedAt: null };
  }
}