/**
 * OKF frontmatter: the shared page model, a hand-written parser for the
 * restricted YAML subset this bundle uses, the reference-faithful metadata
 * reader, and a canonical renderer.
 *
 * Pure: no filesystem, no network, no process, no clock, no randomness. Every
 * input arrives as a string or a plain object, so two runs on the same input
 * produce the same result.
 *
 * The parser is deliberately closed. Anchors, aliases, block scalars, nested
 * maps, multi-document streams and duplicate keys are rejected with a typed
 * `FrontmatterError` rather than guessed at: the OKF subset never needs them,
 * and a silent misparse is worse than a refused page.
 */

/** A bundle page as the library sees it: a POSIX relative path and its text. */
export interface BundlePage {
  /** Bundle-relative POSIX path, no leading `./` (for example `concepts/alpha.md`). */
  path: string;
  /** The whole file, frontmatter block included. */
  text: string;
}

/** The value shapes the supported frontmatter subset can hold. */
export type FrontmatterValue = string | number | boolean | string[] | number[];

/** Parsed frontmatter, keyed by the key as written on the page. */
export interface OkfFrontmatter {
  [key: string]: FrontmatterValue;
}

/** The single error code this parser reports. */
export type FrontmatterErrorCode = "unsupported_yaml";

/**
 * Raised when a page uses YAML outside the supported subset, or a key that
 * could reach `Object.prototype`.
 *
 * Fixed message and fixed code, mirroring the shape of `PathJailError` in
 * `apps/server/src/paths/jail.ts`: the rejection reason lives on the instance,
 * never in a variable message.
 */
export class FrontmatterError extends Error {
  readonly code: FrontmatterErrorCode;

  constructor(code: FrontmatterErrorCode = "unsupported_yaml") {
    super("unsupported YAML in frontmatter");
    this.name = "FrontmatterError";
    this.code = code;
  }
}

/** Frontmatter keys that must never reach the returned object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A block scalar marker (`|`, `>`, and their chomping/indent modifiers). */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** A bare integer, which parses to a number. */
const INTEGER_RE = /^-?\d+$/;

/**
 * Remove one layer of double quotes and decode the backslash escapes the
 * supported subset permits.
 */
function unquoteDouble(raw: string): string {
  let out = "";
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw.charAt(i);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw.charAt(i + 1);
    if (next === "") {
      out += "\\";
      break;
    }
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        out += "\0";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      default:
        // Unknown escape: keep the escaped character literally.
        out += next;
    }
    i += 1;
  }
  return out;
}

/** Split the inside of an inline array on commas that are not inside quotes. */
function splitArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of inner) {
    if (quote === '"') {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Parse one scalar or inline array from its raw source text. */
function parseScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) throw new FrontmatterError();
    return unquoteDouble(value);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) throw new FrontmatterError();
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new FrontmatterError();
    const items = splitArrayItems(value.slice(1, -1)).map((item) => parseScalar(item));
    for (const item of items) {
      if (typeof item !== "string" && typeof item !== "number") {
        throw new FrontmatterError();
      }
    }
    return items as FrontmatterValue;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (INTEGER_RE.test(value)) return Number(value);
  // Bare ISO dates and every other bare scalar stay strings.
  return value;
}

/**
 * Parse a page's frontmatter block.
 *
 * Returns `null` when the text does not begin with `---` or has no closing
 * `\n---`, mirroring the reference tools, where a missing block becomes a lint
 * finding rather than a crash.
 *
 * Throws `FrontmatterError` for anything outside the supported subset.
 */
export function parseFrontmatter(
  text: string,
): { data: OkfFrontmatter; body: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const block = text.slice(3, end);
  const data = Object.create(null) as OkfFrontmatter;
  const seen = new Set<string>();

  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    // An indented line is a nested map or a continuation. Both are unsupported.
    if (/^[ \t]/.test(line)) throw new FrontmatterError();

    const trimmed = line.trim();
    // A document separator inside the block starts a second document.
    if (trimmed === "---" || trimmed === "...") throw new FrontmatterError();

    const colon = trimmed.indexOf(":");
    if (colon <= 0) throw new FrontmatterError();
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();

    if (key === "" || FORBIDDEN_KEYS.has(key)) throw new FrontmatterError();
    if (seen.has(key)) throw new FrontmatterError();
    seen.add(key);

    if (BLOCK_SCALAR_RE.test(rawValue)) throw new FrontmatterError();
    if (rawValue.startsWith("&") || rawValue.startsWith("*")) {
      throw new FrontmatterError();
    }

    data[key] = parseScalar(rawValue);
  }

  let body = text.slice(end + 4);
  // Drop the single newline that closes the `---` line.
  if (body.startsWith("\n")) body = body.slice(1);
  return { data, body };
}

/**
 * `parseFrontmatter` for consumers that must not throw: an unsupported block
 * degrades to "no frontmatter data" instead of aborting the caller.
 */
export function parseFrontmatterSafe(
  text: string,
): { data: OkfFrontmatter; body: string } | null {
  try {
    return parseFrontmatter(text);
  } catch (error) {
    if (error instanceof FrontmatterError) return null;
    throw error;
  }
}

/** Characters that force a string to be quoted when rendered. */
const NEEDS_QUOTE_START_RE = /^[[{&*!|>@\-"'#%`,\]}?]/;

/** Bare words a YAML 1.2 reader turns into null or a boolean. */
const RESERVED_SCALAR_RE = /^(null|~|yes|no|on|off)$/i;

/** Quote a string and escape what the parser reads back. */
function quoteString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render one scalar value under the same rules the parser accepts. */
function renderScalar(value: string | number | boolean): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const mustQuote =
    value === "" ||
    value !== value.trim() ||
    INTEGER_RE.test(value) ||
    value === "true" ||
    value === "false" ||
    value.includes(": ") ||
    value.endsWith(":") ||
    value.includes(" #") ||
    value.includes("\t#") ||
    value.includes("\n") ||
    value.includes("\r") ||
    RESERVED_SCALAR_RE.test(value) ||
    NEEDS_QUOTE_START_RE.test(value);
  return mustQuote ? quoteString(value) : value;
}

/**
 * Render parsed frontmatter as a canonical block.
 *
 * The output is LF-only and ends with exactly one newline, and parsing then
 * re-rendering it is a fixed point.
 */
export function renderFrontmatter(data: OkfFrontmatter): string {
  const lines = ["---"];
  for (const key of Object.keys(data)) {
    const value = data[key] as FrontmatterValue;
    if (Array.isArray(value)) {
      // A bare comma would split one item into two when the block is parsed.
      const items = value.map((item) =>
        typeof item === "string" && item.includes(",")
          ? quoteString(item)
          : renderScalar(item),
      );
      lines.push(`${key}: [${items.join(", ")}]`);
    } else {
      lines.push(`${key}: ${renderScalar(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/** The three fields the reference index builder reads from a page. */
export interface IndexMeta {
  title: string;
  description: string;
  duration: string;
}

/** The reference regexes, copied exactly (`re.MULTILINE` becomes `m`). */
const FM_TITLE = /^title:\s*(.+?)\s*$/m;
const FM_DESC = /^description:\s*(.+?)\s*$/m;
const FM_DUR = /^duration:\s*(.+?)\s*$/m;

/** Reproduce Python's `str.strip()` then `str.strip('"')` then `str.strip("'")`. */
function stripQuoted(value: string): string {
  return value.trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
}

/**
 * Read `source_kind` and normalize it once, so the coverage banner and every
 * lint rule answer the same question about one page. A missing or non-scalar
 * value is `null`; a scalar is stripped of quotes, trimmed and lowercased.
 */
export function normalizeSourceKind(data: OkfFrontmatter): string | null {
  const value = data["source_kind"];
  if (value === undefined || Array.isArray(value)) return null;
  return stripQuoted(String(value)).toLowerCase();
}

/**
 * Read the metadata the reference `scripts/build_indexes.py` `meta()` reads.
 *
 * This deliberately does not use `parseFrontmatter`: the reference works on a
 * regex over a fixed slice of the file, and reproducing that behavior (quote
 * removal, bracket softening, filename-stem fallback, a value containing a
 * comment character) is the contract downstream index building depends on.
 *
 * `fallbackStem` is the page's filename without `.md`, used when no `title:` is
 * present.
 */
export function readIndexMeta(text: string, fallbackStem: string): IndexMeta {
  const frontmatter = text.startsWith("---")
    ? text.slice(3, text.indexOf("\n---", 3))
    : "";
  const titleMatch = FM_TITLE.exec(frontmatter);
  const descriptionMatch = FM_DESC.exec(frontmatter);
  const durationMatch = FM_DUR.exec(frontmatter);

  let title = stripQuoted(titleMatch ? (titleMatch[1] as string) : fallbackStem);
  const description = stripQuoted(
    descriptionMatch ? (descriptionMatch[1] as string) : "",
  );
  const duration = durationMatch
    ? (durationMatch[1] as string).trim().replace(/^"+|"+$/g, "")
    : "";

  // Brackets in a display title break markdown link syntax; the reference
  // softens them in the title only.
  title = title.replace(/\[/g, "(").replace(/\]/g, ")");

  return { title, description, duration };
}
