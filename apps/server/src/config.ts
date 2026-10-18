/**
 * The OPS-07 boundary: every environment read goes through here, and an empty
 * (or all-whitespace) string is treated as unset. A missing variable is a
 * degraded state, not a boot failure (D-08): this module neither raises nor
 * terminates the process on a missing value. Modeled on the reference reader
 * at baalda/app/apps/server/src/config.ts in shape, but trimmed to this phase.
 */

/** An env var that may be absent; empty string and all-whitespace count as unset.
 *  A present, non-empty value is returned with surrounding whitespace trimmed. */
export function optional(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** An integer env var with a fallback. Empty/absent/non-integer yields the fallback. */
export function optionalInt(name: string, fallback: number): number {
  const v = optional(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Read once at module load. Frozen so callers cannot mutate it. */
const pkgVersion = "0.1.0";

export const config = Object.freeze({
  /** HTTP port the single Node process listens on. Default 3010. */
  port: optionalInt("PORT", 3010),
  /** Root directory holding all vault directories and vaults.json. */
  vaultRoot: optional("VAULT_ROOT") ?? "/data/vaults",
  /** Ollama Cloud API key. Absent or empty ⇒ degraded health. Never serialized. */
  ollamaApiKey: optional("OLLAMA_API_KEY"),
  /** Ollama Cloud base URL. */
  ollamaBaseUrl: optional("OLLAMA_BASE_URL") ?? "https://ollama.com",
  /** Ollama model id used by Phase 4 LLM stages. */
  ollamaModel: optional("OLLAMA_MODEL") ?? "llama3.1:8b",
  /** Supadata API key (Phase 3 ingest fallback). Absent or empty ⇒ unset. */
  supadataApiKey: optional("SUPADATA_API_KEY"),
  /**
   * Netscape cookie file handed to yt-dlp as `--cookies`. This is the one owner
   * of the property: 03-04 reads it through the runner's `cookiePath()` and
   * 03-06 writes the uploaded file at this path. The default matches the
   * deployment volume (`/data`), never the repository.
   */
  youtubeCookiePath: optional("YOUTUBE_COOKIE_PATH") ?? "/data/youtube-cookie.txt",
  /** Human-readable service name for health payload. */
  serviceName: "2nd-brain-studio",
  /** Service version, surfaced in /api/health. */
  version: pkgVersion,
  /** True iff an Ollama API key is configured. Drives the health status. */
  get llmConfigured(): boolean {
    return this.ollamaApiKey !== undefined;
  },
});

export type AppConfig = typeof config;