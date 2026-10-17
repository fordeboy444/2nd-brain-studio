// Where does a link in a note point? (UI-10)
//
// One pure function answers it, because the read view, the sanitizer's
// broken-link pass and the click handler all have to agree. Two of them
// disagreeing is a link that renders as live and then does nothing.
//
// "Pure" is the load-bearing word. Resolution is string work — join, collapse,
// strip the fragment — and never a request. In particular a parent-relative
// target (`../note.md`) is resolved HERE, so the server is never handed a path
// it would have to re-resolve, and never a path that climbs out of the vault.
import { isExternalUrl, isSafeUrl } from "./editor/urlSafety.js";
import { baseOf, dirOf, levelContains, ROOT, type TreeState } from "./tree/lazyTree.js";

/**
 * What a link's `href` means, and therefore what a click on it should do.
 *
 * `broken` is not an error state — the UI shows it as a tolerated span
 * (UI-10/"A relative .md link with no target renders as a tolerated span and
 * never as an error"). `reason` is carried because the three ways to be broken
 * want different words: a `javascript:` href was refused, a `../../..` href
 * left the vault, and a `.md` href is simply not there.
 */
export type LinkTarget =
  /** A file in this vault, openable in the editor. */
  | { kind: "vault"; path: string; fragment: string | null }
  /** Leaves the app — http(s), mailto, or some other safe scheme. */
  | { kind: "external"; href: string }
  /** `#heading` — a jump within the rendered document. */
  | { kind: "anchor"; fragment: string }
  /** A vault-relative non-note file: an image, a PDF, a directory. Rendered, not opened. */
  | { kind: "asset"; path: string; fragment: string | null }
  /** Unresolvable. `path` is whatever could be named, for the message. */
  | {
      kind: "broken";
      href: string;
      path: string;
      reason: "unsafe" | "escapes-root" | "missing";
    };

/** `scheme:` from the front of a URL — `ftp:`, `tel:`, `file:`, `javascript:`. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** A `.md` target, with or without a query-ish tail. Case-insensitive. */
const NOTE = /\.md$/i;

/**
 * Resolve one link.
 *
 * @param href        The `href` exactly as it appears in the document.
 * @param currentPath The linking note's vault-relative path — the base for a
 *                    relative target.
 * @param treeState   What the sidebar has read so far. Only used to tell
 *                    "absent" from "not read yet" (below).
 */
export function resolveLink(
  href: string,
  currentPath: string,
  treeState: TreeState,
): LinkTarget {
  const raw = href.trim();
  // An empty target is the document itself, which is what the HTML spec says a
  // `href=""` means. Not a broken link.
  if (raw === "") return { kind: "anchor", fragment: "" };

  // Before anything looks at the href's shape: refuse the schemes that execute.
  // `isSafeUrl` strips the whitespace/control tricks (`java\tscript:`) first.
  if (!isSafeUrl(raw)) {
    return { kind: "broken", href, path: raw, reason: "unsafe" };
  }

  // A link that leaves the app keeps its whole href: the browser is better at
  // this than we are, and reassembling a URL we only half-parse is how a query
  // string gets lost.
  if (isExternalUrl(raw)) return { kind: "external", href: raw };

  // Any other scheme — `tel:`, `ftp:`, `obsidian:`. Safe (checked above) and
  // not ours: external, so a click hands it to the browser/OS rather than
  // treating `tel:555` as a vault path.
  if (SCHEME.test(raw)) return { kind: "external", href: raw };

  if (raw.startsWith("#")) return { kind: "anchor", fragment: decode(raw.slice(1)) };

  // Split the fragment off first: `note.md#heading` targets a note, and the
  // fragment is not part of the path the tree would know about.
  const hash = raw.indexOf("#");
  const target = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? null : decode(raw.slice(hash + 1));

  const path = join(currentPath, target);
  if (path === null) return { kind: "broken", href, path: target, reason: "escapes-root" };

  // A target that is not a `.md` file is an asset: an image, a PDF, a video, or
  // a directory row (a trailing slash — `join` drops it, the name is what the
  // tree knows). Nothing here opens it this phase, so it renders as a link that
  // does not navigate, which is honest about what the app can do.
  if (!NOTE.test(path)) return { kind: "asset", path, fragment };

  // The tree is the only authority on what exists, and it is LAZY: a directory
  // nobody has expanded has no level, and `levelContains` answers `null` for it.
  // Treating that as absent is how every link into an unopened folder becomes a
  // false "missing" (which the plan's verify gate names as a failure). Only a
  // level that has actually been read, and does not hold the name, is broken.
  if (levelContains(treeState, dirOf(path), baseOf(path)) === false) {
    return { kind: "broken", href, path, reason: "missing" };
  }
  return { kind: "vault", path, fragment };
}

/**
 * Join a relative target onto the linking note's directory, as strings.
 *
 * `null` means the target climbed above the vault root — `../../../etc/passwd`
 * from a note in `a/b/`. A resolved path outside the vault is not something to
 * normalise into a near-miss; it is refused.
 */
function join(currentPath: string, target: string): string | null {
  // A leading `/` is vault-absolute in an OKF bundle (see
  // `cole-medin-knowledge-base/`), not filesystem-absolute. The rest is relative
  // to the LINKING note's own directory.
  const absolute = target.startsWith("/");
  const segments = absolute ? [] : dirOf(currentPath).split("/").filter(Boolean);
  const parts = target.replace(/^\/+/, "").split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return ROOT;
  return segments.join("/");
}

/** Percent-decoded, defensively: a note with a literal `%` in a link is not worth a crash. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
