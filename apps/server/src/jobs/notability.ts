/**
 * The job-scoped notability triage artifact (S6, owned by 04-05).
 *
 * Notability is deliberately not a field on `manifest.json`: the manifest is
 * the page-shape contract S4 reads, and adding a score there would change a
 * strict document every later stage depends on. This file is written and read
 * only by the sweep, so S6 can be switched off without touching the manifest.
 *
 * A missing or corrupt file reads as `null` — an absent triage is a normal
 * starting point, not an error.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodepoint } from "@2nd-brain/okf";
import { z } from "zod";
import { writeJsonAtomic } from "../http/writeAtomic.js";

/** A score belongs to one manifest concept or entity slug. */
const notabilitySlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const NotabilityScoreSchema = z
  .object({
    slug: notabilitySlug,
    score: z.number().min(0).max(1),
  })
  .strict();

/** The stored triage document. Strict: an unknown key is a corrupt file. */
export const NotabilitySchema = z
  .object({
    scores: z.array(NotabilityScoreSchema),
    at: z.string(),
  })
  .strict();

export type NotabilityRecord = z.infer<typeof NotabilitySchema>;

export function notabilityPath(jobDir: string): string {
  return join(jobDir, "notability.json");
}

/** Read the triage. Missing, unparseable or schema-invalid is `null`. */
export async function readNotability(
  jobDir: string,
): Promise<NotabilityRecord | null> {
  let raw: string;
  try {
    raw = await readFile(notabilityPath(jobDir), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = NotabilitySchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Write the triage through the fsync-then-rename helper, with scores in a
 * total order so two runs over the same input write identical bytes.
 */
export async function writeNotability(
  jobDir: string,
  record: NotabilityRecord,
): Promise<void> {
  const sorted: NotabilityRecord = {
    scores: [...record.scores]
      .map((score) => ({ slug: score.slug, score: score.score }))
      .sort((left, right) => compareCodepoint(left.slug, right.slug)),
    at: record.at,
  };
  await writeJsonAtomic(notabilityPath(jobDir), sorted);
}
