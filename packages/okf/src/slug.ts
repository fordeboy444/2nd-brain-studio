/**
 * The single shared slug implementation (D-05). Vault create and ingest must
 * share one slug function or the same video can land on two different
 * filenames. Lives in `packages/okf` even though the rest of the package is a
 * Phase 2 deliverable, because Phase 1 vault create already depends on it.
 *
 * Pure: no filesystem access, no imports, no randomness.
 */

/**
 * Reduce a name to a stable `[a-z0-9-]` slug.
 *
 * - lowercases
 * - applies Unicode NFKD normalisation and strips combining marks so accented
 *   characters fold to ASCII (Café → cafe)
 * - replaces every run of characters outside `[a-z0-9]` with a single hyphen
 * - collapses repeated hyphens
 * - trims leading and trailing hyphens
 * - truncates to 64 characters, re-trimming the trailing hyphen afterwards
 *
 * Throws `Error("slug produced an empty result")` when the input reduces to
 * nothing (e.g. a name made only of punctuation).
 */
export function slugify(name: string): string {
  const normalized = name.normalize("NFKD").toLowerCase();
  // Drop combining marks so accented chars fold to their ASCII base.
  const stripped = normalized.replace(/\p{Diacritic}/gu, "");
  // Replace every run of chars outside [a-z0-9] with a single hyphen.
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-");
  // Collapse any doubled hyphens (the replace above already yields single
  // runs, but guard against an edge case where an empty run slipped in).
  const collapsed = hyphenated.replace(/-{2,}/g, "-");
  // Trim leading/trailing hyphens.
  let trimmed = collapsed.replace(/^-+/, "").replace(/-+$/, "");
  if (trimmed === "") {
    throw new Error("slug produced an empty result");
  }
  if (trimmed.length > 64) {
    trimmed = trimmed.slice(0, 64).replace(/-+$/, "");
  }
  if (trimmed === "") {
    throw new Error("slug produced an empty result");
  }
  return trimmed;
}