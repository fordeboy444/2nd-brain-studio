/**
 * The JSON reliability module (PIPE-08, PIPE-09; T-P4-04).
 *
 * Ollama Cloud has no JSON-schema mode, so a malformed reply is a certainty at
 * 294 calls. This module is the deterministic response: a repair ladder and a
 * set of normalising zod validators that never trust the model's shape.
 *
 * Two rules keep the parser safe: neither `extractJson` nor `repairJson` ever
 * evaluates input, and every accepted object passes a named schema before a
 * stage can write it. An unrecoverable reply throws a typed error with the
 * validator messages attached; it never yields a partial object.
 */
import { join } from "node:path";
import { slugify } from "@2nd-brain/okf";
import { z } from "zod";
import type { LlmClient, LlmMessage } from "./ollama.js";

/** The entity subtypes a page may carry; anything else becomes `unknown`. */
export const ENTITY_TYPES = [
  "tool",
  "person",
  "organization",
  "product",
  "framework",
  "concept",
  "unknown",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** The only typed edges code will render. The model cannot invent one. */
export const EDGE_KINDS = [
  "builds_on",
  "part_of",
  "contrasts_with",
  "related_to",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/** At most three model calls: the raw call, then two repair calls. */
const MAX_ATTEMPTS = 3;

/** How much of the previous bad reply attempt 3 echoes back. */
const ECHO_LIMIT = 4_000;

/** A quote longer than this is truncated before it can reach a page. */
const MAX_QUOTE_CHARS = 240;

/** The single namer for a raw-reply path; no stage joins its own. */
export function rawPathForAttempt(
  jobDir: string,
  stage: string,
  unit: string,
  attempt: number,
): string {
  return join(jobDir, "llm", `${stage}-${unit}-${attempt}.txt`);
}

/**
 * Remove one leading markdown fence. A reply that begins with ```json is the
 * common shape; the closing fence is dropped with the trailing prose.
 */
function stripFence(input: string): string {
  let text = input.trim();
  if (!text.startsWith("```")) return text;
  const newline = text.indexOf("\n");
  if (newline === -1) return text;
  text = text.slice(newline + 1);
  const closing = text.lastIndexOf("```");
  if (closing !== -1) text = text.slice(0, closing);
  return text.trim();
}

/** The first `{` or `[`, whichever appears first; -1 when neither does. */
function firstBracket(text: string): number {
  const object = text.indexOf("{");
  const array = text.indexOf("[");
  if (object === -1) return array;
  if (array === -1) return object;
  return Math.min(object, array);
}

/**
 * Scan from `start` to the matching close, honouring strings and escapes. An
 * unbalanced tail is returned whole so `repairJson` can close it.
 */
function balancedSlice(text: string, start: number): string {
  const open = text[start];
  if (open === undefined) return "";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

/**
 * Strip a fence, then return the first balanced object or array. Everything
 * after the matching close (trailing prose, a second object) is dropped.
 */
export function extractJson(text: string): string {
  const unfenced = stripFence(text);
  const start = firstBracket(unfenced);
  if (start === -1) return unfenced;
  return balancedSlice(unfenced, start);
}

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char);

/**
 * A deterministic string repair. No evaluation, no dependency:
 * - drops a leading apology (everything before the first bracket)
 * - normalises curly quotes and en/em dashes
 * - converts single-quoted strings, escaping inner double quotes
 * - escapes raw newlines, carriage returns and tabs inside a string
 * - strips `//` and block comments outside strings
 * - drops a trailing comma before a close
 * - replaces `NaN`/`Infinity` literals with `null`
 * - closes every unbalanced brace and bracket
 */
export function repairJson(input: string): string {
  // Strip a fence, then any leading apology before the first bracket.
  let text = stripFence(input);
  const start = firstBracket(text);
  if (start !== -1) text = text.slice(start);

  text = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-");

  let out = "";
  const stack: string[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    // Comments are only meaningful outside a string.
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    // A string, in either quote style. The output is always double-quoted.
    if (char === '"' || char === "'") {
      const quote = char;
      out += '"';
      index += 1;
      let closed = false;
      while (index < text.length) {
        const inner = text[index] as string;
        if (inner === "\\") {
          const next = text[index + 1];
          if (quote === "'") {
            if (next === "'") {
              out += "'";
              index += 2;
              continue;
            }
            if (next === '"') {
              out += '\\"';
              index += 2;
              continue;
            }
          }
          out += inner;
          if (next !== undefined) {
            out += next;
            index += 2;
          } else {
            index += 1;
          }
          continue;
        }
        if (inner === quote) {
          out += '"';
          index += 1;
          closed = true;
          break;
        }
        if (inner === '"' && quote === "'") {
          out += '\\"';
          index += 1;
          continue;
        }
        if (inner === "\n") {
          out += "\\n";
          index += 1;
          continue;
        }
        if (inner === "\r") {
          out += "\\r";
          index += 1;
          continue;
        }
        if (inner === "\t") {
          out += "\\t";
          index += 1;
          continue;
        }
        out += inner;
        index += 1;
      }
      // A reply truncated mid-string: close it so the brackets can close too.
      if (!closed) out += '"';
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      out += char;
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.at(-1) === char) stack.pop();
      out += char;
      index += 1;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] as string)) {
        lookahead += 1;
      }
      const next = text[lookahead];
      // A comma immediately before a close is invalid JSON; drop it.
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }

    if (
      text.startsWith("NaN", index) &&
      !isWordChar(text[index - 1]) &&
      !isWordChar(text[index + 3])
    ) {
      out += "null";
      index += 3;
      continue;
    }
    if (
      text.startsWith("Infinity", index) &&
      !isWordChar(text[index - 1]) &&
      !isWordChar(text[index + 8])
    ) {
      out += "null";
      index += 8;
      continue;
    }

    out += char;
    index += 1;
  }

  // Close every unbalanced bracket, dropping a dangling comma or a bare key.
  while (stack.length > 0) {
    out = out.replace(/[\s,]+$/, "");
    if (out.endsWith(":")) out += "null";
    out += stack.pop() as string;
  }

  return out;
}

/** Extract, repair, then validate. Throws a SyntaxError or a ZodError. */
export function parseWith<T>(text: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(repairJson(extractJson(text))));
}

/** An unrecoverable reply. Carries every attempt's validator message. */
export class JsonRecoveryError extends Error {
  readonly attempts: number;
  readonly errors: string[];

  constructor(attempts: number, errors: string[]) {
    super(
      `The model reply was not valid JSON after ${attempts} attempts: ${errors.join(
        "; ",
      )}`,
    );
    this.name = "JsonRecoveryError";
    this.attempts = attempts;
    this.errors = errors;
  }
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      })
      .join(", ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface CallJsonOptions {
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Attempt number -> the raw-reply path for that attempt. */
  rawPathForAttempt?: (attempt: number) => string | undefined;
}

/**
 * The 3-attempt ladder: the raw call, a repair message carrying the validator
 * errors, then the same instruction with the previous bad output echoed back
 * (truncated). Every reply is on disk before it is parsed.
 */
export async function callJson<T>(
  client: LlmClient,
  messages: readonly LlmMessage[],
  schema: z.ZodType<T>,
  options: CallJsonOptions,
): Promise<T> {
  const errors: string[] = [];
  let previous = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const current: LlmMessage[] = [...messages];
    if (attempt > 1) {
      const instruction = `Your previous output was not valid: ${errors.join(
        "; ",
      )}. Return ONLY the corrected JSON.`;
      current.push({
        role: "user",
        content:
          attempt === 2
            ? instruction
            : `${instruction}\nPrevious output:\n${previous.slice(0, ECHO_LIMIT)}`,
      });
    }

    const reply = await client.chat(current, {
      model: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      rawPath: options.rawPathForAttempt?.(attempt),
    });
    previous = reply.text;

    try {
      return parseWith(reply.text, schema);
    } catch (error) {
      errors.push(describeError(error));
    }
  }

  throw new JsonRecoveryError(MAX_ATTEMPTS, errors);
}

// ---------------------------------------------------------------------------
// Normalising helpers
// ---------------------------------------------------------------------------

function slugOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    return slugify(trimmed);
  } catch {
    return null;
  }
}

/** A slug field: slugify it, fall back to the name, then to `unknown`. */
function slugOr(value: unknown, fallback: unknown): string {
  return slugOrNull(value) ?? slugOrNull(fallback) ?? "unknown";
}

function normalizeWeight(value: unknown): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

function normalizeEntityType(value: unknown): EntityType {
  const raw =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  return (ENTITY_TYPES as readonly string[]).includes(raw)
    ? (raw as EntityType)
    : "unknown";
}

function normalizeEdgeKind(value: unknown): EdgeKind | null {
  const raw =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  return (EDGE_KINDS as readonly string[]).includes(raw)
    ? (raw as EdgeKind)
    : null;
}

/** Tags are lowercase slugs and unique, in first-seen order. */
function normalizeTags(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const slug = slugOrNull(value);
    if (slug !== null) seen.add(slug);
  }
  return [...seen];
}

/** Free-text string arrays (aliases): trimmed, non-empty and unique. */
function normalizeStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/** A number, `H:MM:SS` or `MM:SS`; `null` when it does not parse. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (!/^\d+(:\d{1,2}){1,2}$/.test(trimmed)) return null;

  const parts = trimmed.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length === 2) {
    const [minutes, seconds] = parts as [number, number];
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts as [number, number, number];
    return hours * 3_600 + minutes * 60 + seconds;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Named validators
// ---------------------------------------------------------------------------

const ConceptSchema = z.object({
  name: z.string(),
  slug: z.unknown(),
  weight: z.unknown(),
});

const EntitySchema = z.object({
  name: z.string(),
  slug: z.unknown(),
  type: z.unknown(),
  weight: z.unknown(),
});

const QuoteSchema = z.object({
  text: z.string(),
  startSec: z.unknown(),
});

const RelationSchema = z.object({
  to: z.unknown(),
  kind: z.unknown(),
});

/**
 * Collapse whitespace in model text. One line cannot open a new markdown
 * block inside `## Sources` or `## Key moments` (WR-09).
 */
export function singleLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One-line title text that is safe inside `# ${title}` and `[${title}](...)`:
 * no leading heading marker and no bracket that would end a link label.
 */
export function markdownSafeTitle(value: string): string {
  return singleLineText(
    singleLineText(value).replace(/^#+\s*/, "").replace(/[[\]]/g, ""),
  );
}

/**
 * The S2 extraction contract. Every field is normalised before a stage sees
 * it: slugs are kebab-case, types are in the enum, weights are clamped, quote
 * text is one line and capped, and an unparseable timestamp drops only that
 * quote.
 */
export const ExtractionSchema = z
  .object({
    slug: z.unknown(),
    title: z.string(),
    thesis: z.string(),
    summary: z.string(),
    tags: z.array(z.unknown()),
    concepts: z.array(ConceptSchema),
    entities: z.array(EntitySchema),
    quotes: z.array(QuoteSchema),
    relations: z.array(RelationSchema),
  })
  .strict()
  .transform((value) => ({
    slug: slugOr(value.slug, value.title),
    title: markdownSafeTitle(value.title),
    thesis: value.thesis.trim(),
    summary: value.summary.trim(),
    tags: normalizeTags(value.tags),
    concepts: value.concepts.map((concept) => ({
      name: markdownSafeTitle(concept.name),
      slug: slugOr(concept.slug, concept.name),
      weight: normalizeWeight(concept.weight),
    })),
    entities: value.entities.map((entity) => ({
      name: markdownSafeTitle(entity.name),
      slug: slugOr(entity.slug, entity.name),
      type: normalizeEntityType(entity.type),
      weight: normalizeWeight(entity.weight),
    })),
    quotes: value.quotes.flatMap((quote) => {
      const startSec = parseTimestamp(quote.startSec);
      if (startSec === null) return [];
      return [
        {
          text: singleLineText(quote.text).slice(0, MAX_QUOTE_CHARS),
          startSec,
        },
      ];
    }),
    relations: value.relations.flatMap((relation) => {
      const kind = normalizeEdgeKind(relation.kind);
      const to = slugOrNull(relation.to);
      if (kind === null || to === null) return [];
      return [{ to, kind }];
    }),
  }));

export type Extraction = z.infer<typeof ExtractionSchema>;

/** Paragraph split used by both the body validator and the stages. */
function paragraphsOf(body: string): string[] {
  return body
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/**
 * The S4b page-body contract: an array of `{slug, body}`, each body 2-4 prose
 * paragraphs with no heading and no link. Frontmatter and `## Sources` belong
 * to code, never to the model.
 */
/**
 * The shared page-body rules. Returns the first violated rule, or null.
 *
 * S4b and S6 both validate model prose with this one predicate, so the two
 * stages cannot drift apart.
 */
export function pageBodyIssue(raw: string): string | null {
  const body = raw.trim();
  const count = paragraphsOf(body).length;
  if (count < 2 || count > 4) return "a page body must be 2 to 4 paragraphs";
  if (/^#{1,6}\s/m.test(body)) {
    return "a page body must not contain a markdown heading";
  }
  if (body.includes("](") || body.includes("[[")) {
    return "a page body must not contain a markdown link";
  }
  return null;
}

export const PageBodiesSchema = z
  .array(
    z.object({
      kind: z.enum(["concept", "entity"]),
      slug: z.unknown(),
      body: z.string(),
    }),
  )
  .superRefine((items, ctx) => {
    items.forEach((item, index) => {
      const issue = pageBodyIssue(item.body);
      if (issue !== null) {
        ctx.addIssue({ code: "custom", path: [index, "body"], message: issue });
      }
    });
  })
  .transform((items) =>
    items.map((item) => ({
      kind: item.kind,
      slug: slugOr(item.slug, undefined),
      body: item.body.trim(),
    })),
  );

export type PageBody = z.infer<typeof PageBodiesSchema>[number];

/** A stored-manifest slug is already kebab-case; a bad one is a corrupt file. */
const storedSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const clampedWeight = z.number().min(0).max(1);

const ManifestSourceSchema = z
  .object({
    slug: storedSlug,
    title: z.string(),
    kind: z.enum(["video", "web"]),
    tags: z.array(z.string()),
    concepts: z.array(z.string()),
    entities: z.array(z.string()),
    youtube_id: z.string().optional(),
    url: z.string().optional(),
    duration: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A fallback source page needs these to pass lint rule E5 without raw/.
    if (value.kind === "video" && value.youtube_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["youtube_id"],
        message: "a video source record needs youtube_id",
      });
    }
    if (value.kind === "web" && value.url === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "a web source record needs url",
      });
    }
  });

const ManifestConceptSchema = z
  .object({
    slug: storedSlug,
    title: z.string(),
    tags: z.array(z.string()),
    sources: z.array(z.string()),
    weight: clampedWeight,
  })
  .strict();

const ManifestEntitySchema = z
  .object({
    slug: storedSlug,
    title: z.string(),
    type: z.enum(ENTITY_TYPES),
    tags: z.array(z.string()),
    sources: z.array(z.string()),
    weight: clampedWeight,
  })
  .strict();

const ManifestEdgeSchema = z
  .object({
    from: storedSlug,
    to: storedSlug,
    kind: z.enum(EDGE_KINDS),
  })
  .strict();

const FilteredCandidateSchema = z
  .object({
    slug: storedSlug,
    kind: z.enum(["concept", "entity"]),
    reason: z.string(),
  })
  .strict();

/** The S3 stored manifest document, exactly as `jobs/manifest.ts` writes it. */
export const ManifestSchema = z
  .object({
    concepts: z.array(ManifestConceptSchema),
    entities: z.array(ManifestEntitySchema),
    sources: z.array(ManifestSourceSchema),
    edges: z.array(ManifestEdgeSchema),
    filtered: z.array(FilteredCandidateSchema),
    at: z.string(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

const TaxonomyThemeSchema = z
  .object({
    name: z.string(),
    slug: storedSlug,
    members: z.array(storedSlug),
  })
  .strict();

const TAXONOMY_GROUPS = {
  concept_themes: z.array(TaxonomyThemeSchema),
  tool_themes: z.array(TaxonomyThemeSchema),
  source_clusters: z.array(TaxonomyThemeSchema),
};

/** The S3 taxonomy reply, before the stored `at` field exists. */
export const TaxonomyResponseSchema = z.object(TAXONOMY_GROUPS).strict();

/** The S3 stored taxonomy document. */
export const TaxonomySchema = z
  .object({ ...TAXONOMY_GROUPS, at: z.string() })
  .strict();

export type Taxonomy = z.infer<typeof TaxonomySchema>;

const CanonicalLabelSchema = z
  .object({
    kind: z.enum(["concept", "entity"]),
    from: z.unknown(),
    to: z.unknown(),
    title: z.string().trim().min(1),
    tags: z.array(z.unknown()),
    aliases: z.array(z.unknown()),
  })
  .transform((value) => ({
    kind: value.kind,
    from: slugOr(value.from, undefined),
    to: slugOr(value.to, undefined),
    title: markdownSafeTitle(value.title),
    tags: normalizeTags(value.tags),
    aliases: normalizeStrings(value.aliases),
  }));

/**
 * The S3 canonicalisation envelope. It validates the reply before any label
 * mapping is applied, so no paid reply is parsed without a named validator.
 */
export const CanonicalizeSchema = z
  .object({
    labels: z.array(CanonicalLabelSchema),
  })
  .strict();

export type CanonicalLabel = z.infer<typeof CanonicalizeSchema>["labels"][number];
