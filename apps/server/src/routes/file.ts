import { Hono } from "hono";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PathJailError, decodePathParam, resolveInVault } from "../paths/jail.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";

/**
 * The file API (VAULT-05): `GET /api/file` and `PUT /api/file`.
 *
 * Every path is resolved through `resolveInVault` (VAULT-04). No route here
 * builds a vault-relative path from user input on its own — the jail owns path
 * construction. `hashContent` hashes the raw bytes read from disk, never a
 * re-serialised string, so a newline-normalising round trip cannot make the
 * hash disagree with the file.
 */

// One fixed message for every jail rejection, regardless of reason, so a
// caller cannot use the reason to probe which checks exist.
const JAIL_MESSAGE = "Invalid path.";

/** SHA-256 of raw bytes, lowercase hex. */
export function hashContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes as Uint8Array).digest("hex");
}

export const files = new Hono();

interface VaultRecord {
  id: string;
  name: string;
  path: string;
}

/** Resolve a vault id to its absolute directory, or null when unregistered. */
async function lookupVault(id: string): Promise<{ dir: string; record: VaultRecord } | null> {
  if (!id) return null;
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id) as VaultRecord | undefined;
  if (!record) return null;
  return { dir: vaultDirPath(record.id), record };
}

/** Map a PathJailError to a 400 with the fixed message. */
function jailResponse(c: { json: (body: unknown, status: number) => Response }): Response {
  return c.json({ error: "invalid_path", message: JAIL_MESSAGE }, 400);
}

/**
 * GET /api/file?vault=<id>&path=<rel>
 *
 * Returns 200 `{path, content, baseHash}` where `content` is UTF-8 and
 * `baseHash` is the SHA-256 of the raw bytes. 404 for a missing file or
 * unknown vault; 400 for a jail rejection.
 */
files.get("/", async (c) => {
  const vaultId = c.req.query("vault") ?? "";
  const rawPath = c.req.query("path") ?? "";

  const vault = await lookupVault(vaultId);
  if (!vault) return c.json({ error: "not_found", message: "Unknown vault." }, 404);

  let resolved: { absPath: string; relPath: string };
  try {
    const decoded = decodePathParam(rawPath);
    resolved = await resolveInVault(vault.dir, decoded);
  } catch (err) {
    if (err instanceof PathJailError) return jailResponse(c);
    throw err;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolved.absPath) as Buffer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "not_found", message: "File not found." }, 404);
    }
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      return c.json({ error: "invalid_path", message: "Path is a directory." }, 400);
    }
    throw err;
  }

  const baseHash = hashContent(buffer);
  const content = buffer.toString("utf8");
  return c.json({ path: resolved.relPath, content, baseHash }, 200);
});

const PutBody = z.object({
  vault: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  baseHash: z.union([z.string(), z.null()]),
});

/**
 * PUT /api/file  body `{vault, path, content, baseHash}`
 *
 * - Resolves the path through the jail.
 * - Re-reads the current bytes (if the file exists) and computes `currentHash`
 *   inside this same request — never from a value stored earlier.
 * - When the file exists and `currentHash !== baseHash` → 409
 *   `{message, currentContent, currentHash}`, write nothing.
 * - When the file does not exist, accept only `baseHash === null`; if a file
 *   exists but `baseHash === null` → 409.
 * - On success, write UTF-8 bytes to a sibling temp file and `rename` over the
 *   target (atomic), then 200 `{path, baseHash: newHash}`.
 */
files.put("/", async (c) => {
  let parsed: z.infer<typeof PutBody>;
  try {
    const body = await c.req.json();
    parsed = PutBody.parse(body);
  } catch {
    return c.json(
      { error: "invalid_body", message: "Request body must be JSON with `vault`, `path`, `content` and `baseHash`." },
      400,
    );
  }

  const vault = await lookupVault(parsed.vault);
  if (!vault) return c.json({ error: "not_found", message: "Unknown vault." }, 404);

  let resolved: { absPath: string; relPath: string };
  try {
    const decoded = decodePathParam(parsed.path);
    resolved = await resolveInVault(vault.dir, decoded);
  } catch (err) {
    if (err instanceof PathJailError) return jailResponse(c);
    throw err;
  }

  // Does the target already exist?
  let existing: Buffer | null = null;
  try {
    existing = (await readFile(resolved.absPath)) as Buffer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = null;
    } else if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      return c.json({ error: "invalid_path", message: "Path is a directory." }, 400);
    } else {
      throw err;
    }
  }

  if (existing === null) {
    // Create: accept only baseHash === null.
    if (parsed.baseHash !== null) {
      return c.json(
        { error: "conflict", message: "File does not exist yet; baseHash must be null to create." },
        409,
      );
    }
  } else {
    const currentHash = hashContent(existing);
    if (parsed.baseHash === null) {
      // Caller thought the file did not exist; it does. 409 with current bytes.
      return c.json(
        {
          error: "conflict",
          message: "This file changed on disk since you opened it.",
          currentContent: existing.toString("utf8"),
          currentHash,
        },
        409,
      );
    }
    if (currentHash !== parsed.baseHash) {
      return c.json(
        {
          error: "conflict",
          message: "This file changed on disk since you opened it.",
          currentContent: existing.toString("utf8"),
          currentHash,
        },
        409,
      );
    }
  }

  // Write atomically: sibling temp file + rename.
  const bytes = Buffer.from(parsed.content, "utf8");
  const dir = dirname(resolved.absPath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.file.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, bytes);
  await rename(tmp, resolved.absPath);

  const newHash = hashContent(bytes);
  return c.json({ path: resolved.relPath, baseHash: newHash }, 200);
});