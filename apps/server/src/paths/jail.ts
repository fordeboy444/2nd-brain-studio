/**
 * The path jail (VAULT-04): the single place in the server where an untrusted
 * (browser- or LLM-controlled) vault-relative path becomes an absolute path.
 *
 * Every route that touches the filesystem resolves its path through
 * `resolveInVault`. No route builds a path with `path.join`/`path.resolve` alone
 * — that would bypass the realpath re-check and reopen the symlink hole this
 * module exists to close.
 *
 * Mirrors the reference `baalda/app/apps/desktop/src-tauri/src/vault.rs`
 * (`resolve_in_vault`: component walk + lexical normalization + startsWith on a
 * path-separator boundary), with one required addition the reference omits: a
 * `realpath` re-check at the leaf (or its nearest existing ancestor) so a
 * symlink swapped in inside the vault cannot escape after the lexical check.
 *
 * Error messages name the rejection reason only — never the absolute host path —
 * so a caller cannot probe which checks exist or where the vault lives.
 */
import { realpath } from "node:fs/promises";
import { sep, resolve, isAbsolute } from "node:path";

export type PathJailReason =
  | "empty"
  | "undecodable"
  | "null-byte"
  | "parent-segment"
  | "absolute"
  | "outside";

export class PathJailError extends Error {
  readonly reason: PathJailReason;
  constructor(reason: PathJailReason) {
    // Fixed, reason-only message. Never includes the absolute path.
    super("path rejected");
    this.name = "PathJailError";
    this.reason = reason;
  }
}

/**
 * Decode a path parameter once with `decodeURIComponent`. A malformed percent
 * sequence is a 400 (reason `undecodable`), not a 500. Called at the route
 * boundary BEFORE `resolveInVault`, so an encoded escape (`%2e%2e`) is decoded
 * into its literal form and then caught by the `parent-segment` check.
 */
export function decodePathParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new PathJailError("undecodable");
  }
}

// Windows drive (C:\) and UNC (\\server\share) prefixes, checked even on POSIX
// so a Windows-shaped escape is rejected regardless of host.
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const UNC_RE = /^[\\/][\\/]/;

/**
 * Resolve a vault-relative `input` to an absolute path inside `vaultDir`.
 * Checks run in this exact order and the `{absPath, relPath}` pair is returned
 * only when all pass:
 *
 *  1. `empty`        — undefined/empty/whitespace-only, before any fs call
 *  2. `null-byte`    — contains a NUL character
 *  3. `absolute`     — starts with a separator or matches a Windows drive/UNC prefix
 *  4. `parent-segment` — any segment produced by splitting on the separator is `..`
 *  5. `outside`      — `path.resolve(vaultDir, input)` fails the separator-boundary test
 *  6. `outside`      — realpath re-check of the target (or nearest existing ancestor)
 *
 * `vaultDir` itself is resolved through `realpath` once at the top so a
 * symlinked vault root does not make every legitimate path look like an escape.
 */
export async function resolveInVault(
  vaultDir: string,
  input: string,
): Promise<{ absPath: string; relPath: string }> {
  // (1) empty — before any filesystem call.
  if (input === undefined || input === null) {
    throw new PathJailError("empty");
  }
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed === "") {
    throw new PathJailError("empty");
  }

  // (2) null-byte — before any resolution or filesystem call.
  if (input.includes("\0")) {
    throw new PathJailError("null-byte");
  }

  // (3) absolute — starts with a path separator or a Windows drive/UNC prefix.
  // Normalize backslashes to forward slashes for the segment analysis so a
  // Windows-shaped input is rejected consistently on any host.
  const normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith("/") || WIN_DRIVE_RE.test(input) || UNC_RE.test(input)) {
    throw new PathJailError("absolute");
  }

  // (4) parent-segment — any segment is a parent-directory segment.
  // Empty segments (e.g. `a//b`) are harmless and collapsed by `path.resolve`.
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new PathJailError("parent-segment");
    }
  }

  // Resolve the vault root through realpath once so a symlinked vault root
  // does not make every legitimate path look like an escape.
  let realVault: string;
  try {
    realVault = await realpath(vaultDir);
  } catch {
    // If the vault root itself does not exist, fall back to a lexical resolve
    // of the vault dir so create-targets inside a not-yet-scaffolded vault
    // still resolve. The boundary test below still applies.
    realVault = resolve(vaultDir);
  }

  // (5) lexical boundary test on `path.resolve(vaultDir, input)`.
  const candidate = resolve(realVault, input);
  if (!isInsideVault(candidate, realVault)) {
    throw new PathJailError("outside");
  }

  // (6) realpath re-check: resolve the real path of the target when it exists,
  // otherwise of its nearest existing ancestor, and re-apply the boundary test.
  // This catches a symlink planted inside the vault whose real target is
  // outside — the lexical check passes, but the real path escapes.
  const realTarget = await realpathNearestExisting(candidate);
  if (!isInsideVault(realTarget, realVault)) {
    throw new PathJailError("outside");
  }

  // The relPath is the input as given (vault-relative); absPath is the
  // lexically-resolved candidate (not the realpath, so callers write to the
  // intended path, not through a symlink target).
  return { absPath: candidate, relPath: input };
}

/**
 * True iff `absPath` is `vaultDir` itself or begins with `vaultDir + sep`.
 * Compares on a path-separator boundary, never a bare string prefix, so a
 * sibling directory whose name merely extends the vault directory name
 * (e.g. `/data/vaults/my-vault-evil` vs `/data/vaults/my-vault`) is rejected.
 */
function isInsideVault(absPath: string, vaultDir: string): boolean {
  if (absPath === vaultDir) return true;
  return absPath.startsWith(vaultDir + sep);
}

/**
 * Resolve the real path of `absPath` when it exists, otherwise walk up to the
 * nearest existing ancestor, realpath that, and re-append the missing tail so
 * the boundary test runs against the real location of the parent. If nothing
 * on the chain exists (the vault root itself is missing), returns `absPath`
 * unchanged so the caller's boundary test still runs against the lexical path.
 */
async function realpathNearestExisting(absPath: string): Promise<string> {
  try {
    return await realpath(absPath);
  } catch {
    // Target does not exist (a create). Find the nearest existing ancestor.
    const parts = absPath.split(sep);
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join(sep);
      try {
        const realAncestor = await realpath(ancestor);
        const tail = parts.slice(i).join(sep);
        return tail === "" ? realAncestor : realAncestor + sep + tail;
      } catch {
        // ancestor missing too — keep walking up
      }
    }
    return absPath;
  }
}

// Re-exported for callers that need the platform separator without importing
// from node:path directly (kept out of the route layer's import surface).
export { isAbsolute };