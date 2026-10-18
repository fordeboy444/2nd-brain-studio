/**
 * Link extraction and pure POSIX resolution for OKF bundles.
 *
 * Every function here is a pure string transform with no imports and no
 * filesystem access. The reference `lint.py` resolves a link with
 * `(page.parent / target).resolve()`, which touches disk; this module
 * normalizes the same path arithmetically and treats every escape as broken.
 */

/** Fenced block: three backticks, any characters (including newlines), three backticks. */
const FENCE_RE = /```[\s\S]*?```/g;

/** Inline code: one backtick, characters other than a backtick, one backtick. */
const INLINE_RE = /`[^`]*`/g;

/** A markdown link: `[text](target)`, where the text holds no closing bracket. */
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Remove fenced blocks first, then inline code, exactly as the reference does.
 *
 * An example link inside either form never reaches the link extractor.
 */
export function stripCode(text: string): string {
  return text.replace(FENCE_RE, "").replace(INLINE_RE, "");
}

/**
 * Return the target capture of every markdown link in `text`.
 *
 * This does not strip code: a caller that lints prose calls `stripCode` first.
 */
export function extractLinks(text: string): string[] {
  const links: string[] = [];
  const pattern = new RegExp(LINK_RE.source, "g");
  let match = pattern.exec(text);
  while (match !== null) {
    links.push(match[1] as string);
    match = pattern.exec(text);
  }
  return links;
}

/** Split a link capture the way Python's `str.split()` does: on whitespace runs. */
function firstToken(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  return parts[0] ?? "";
}

/** True when the reference lint skips the target without resolving it. */
export function isExternalTarget(link: string): boolean {
  return (
    link.startsWith("http://") ||
    link.startsWith("https://") ||
    link.startsWith("mailto:") ||
    link.startsWith("#")
  );
}

/**
 * The reference link token: drop an optional title, then drop a fragment.
 *
 * A target whose stem merely begins with `http` stays local; only a full
 * scheme is external.
 */
export function linkTarget(raw: string): string {
  const link = firstToken(raw);
  if (isExternalTarget(link)) return "";
  const hash = link.indexOf("#");
  return hash === -1 ? link : link.slice(0, hash);
}

/**
 * Resolve `target` from `fromPage` to a bundle-relative POSIX path.
 *
 * Returns `null` when the target is empty, absolute, contains a backslash, or
 * climbs above the bundle root. The result never begins or ends with `/`, so a
 * directory link such as `../tools/` matches the bundle path set entry `tools`.
 *
 * This never reads a filesystem: a path that escapes the root is broken, not
 * inspected.
 */
export function resolveBundlePath(
  fromPage: string,
  target: string,
): string | null {
  if (target === "" || target.startsWith("/") || target.includes("\\")) {
    return null;
  }

  const slash = fromPage.lastIndexOf("/");
  const base = slash === -1 ? "" : fromPage.slice(0, slash);
  const joined = base === "" ? target : `${base}/${target}`;

  const stack: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  // The target normalized to the bundle root, which is not a path in the set.
  if (stack.length === 0) return null;
  return stack.join("/");
}
