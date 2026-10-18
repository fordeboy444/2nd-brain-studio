/**
 * The non-secret settings file (OPS-07, T-03-28).
 *
 * `settings.json` lives at the vault root and holds only values the browser may
 * read back. There is deliberately no key/token/password field: secrets stay in
 * the environment (`config.ts`) and never enter this file (prohibition in
 * 03-06-PLAN.md).
 *
 * Writes go through `writeJsonAtomic` (temp file, fsync, rename), so a crash
 * leaves either the previous complete file or the new complete one. A missing
 * or corrupt file is not an error — it resolves to the defaults.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { writeJsonAtomic } from "../http/writeAtomic.js";

/** The complete, non-secret settings surface persisted at the vault root. */
export const SettingsSchema = z.object({
  llm: z.object({
    model: z.string().min(1).max(128),
    concurrency: z.number().int().min(1).max(4),
    requestTimeoutMs: z.number().int().min(1000).max(600_000),
    maxRetries: z.number().int().min(0).max(5),
  }),
  fetch: z.object({
    delayMs: z.number().int().min(0).max(60_000),
    /**
     * Stored and rendered in Phase 3, but no Phase 3 code consumes it. Phase 4
     * adds the concurrent LLM pool that will read this value.
     */
    concurrency: z.number().int().min(1).max(4),
    language: z.string().min(2).max(16),
  }),
  sweep: z.object({
    enabled: z.boolean(),
  }),
  ui: z.object({
    theme: z.enum(["system", "light", "dark"]),
  }),
});

export type AppSettings = z.infer<typeof SettingsSchema>;

/**
 * A PUT body. Every field is optional at both levels; unknown keys are stripped
 * before the merge, so a request can never add a field — let alone a secret.
 */
export const SettingsPatchSchema = z.object({
  llm: SettingsSchema.shape.llm.partial().optional(),
  fetch: SettingsSchema.shape.fetch.partial().optional(),
  sweep: SettingsSchema.shape.sweep.partial().optional(),
  ui: SettingsSchema.shape.ui.partial().optional(),
});

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** The single global settings file (per-vault overrides are deferred). */
export function settingsPath(): string {
  return join(config.vaultRoot, "settings.json");
}

/**
 * The defaults every missing field resolves to. `llm.model` follows the
 * environment so the Test connection probe and the Phase 4 pipeline agree.
 */
export function defaultSettings(): AppSettings {
  return {
    llm: {
      model: config.ollamaModel,
      concurrency: 1,
      requestTimeoutMs: 120_000,
      maxRetries: 3,
    },
    fetch: {
      delayMs: 1_000,
      // Inert in Phase 3; the Phase 4 LLM pool is the first consumer.
      concurrency: 2,
      language: "en",
    },
    sweep: { enabled: true },
    ui: { theme: "system" },
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge only the keys `base` already knows. This is the unknown-key strip for
 * both a read file and a PUT patch: a value cannot introduce a new property.
 */
function mergeKnown(base: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    const baseValue = base[key];
    const patchValue = patch[key];
    merged[key] =
      isObject(baseValue) && isObject(patchValue)
        ? mergeKnown(baseValue, patchValue)
        : patchValue;
  }
  return merged;
}

/**
 * Read the merged settings. A missing file, unreadable file, invalid JSON or a
 * value that violates the schema returns the defaults rather than throwing.
 */
export async function readSettings(): Promise<AppSettings> {
  const defaults = defaultSettings();
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return defaults;
  }
  if (!isObject(stored)) return defaults;

  const merged = mergeKnown(
    defaults as unknown as JsonObject,
    stored,
  );
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

/**
 * Validate a patch, strip unknown keys, deep-merge over the current settings and
 * write atomically. Throws `ZodError` for an out-of-range value; the route maps
 * that to 400 `invalid_body`.
 */
export async function writeSettings(patch: unknown): Promise<AppSettings> {
  const parsed = SettingsPatchSchema.parse(patch);
  const current = await readSettings();
  const merged = mergeKnown(
    current as unknown as JsonObject,
    parsed as unknown as JsonObject,
  );
  const next = SettingsSchema.parse(merged);
  await writeJsonAtomic(settingsPath(), next);
  return next;
}
