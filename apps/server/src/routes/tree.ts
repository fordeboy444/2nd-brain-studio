import { Hono } from "hono";
import { PathJailError, decodePathParam } from "../paths/jail.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { listTreeLevel } from "../vaults/fsTree.js";

/**
 * The lazy tree endpoint (VAULT-03): `GET /api/vaults/:id/tree?dir=<rel>`.
 *
 * Returns one ordered level of the vault directory at `dir` (defaulting to the
 * vault root). Dot entries are pruned; directories come before files; names use
 * numeric ordering. `dir` is resolved through the jail (VAULT-04). No response
 * contains an absolute host path — `entries[*].id`/`path` are vault-relative.
 */
export const tree = new Hono();

const JAIL_MESSAGE = "Invalid path.";

tree.get("/:id/tree", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  const vaultDir = vaultDirPath(record.id);

  const rawDir = c.req.query("dir") ?? ".";
  let entries;
  try {
    const decoded = decodePathParam(rawDir);
    entries = await listTreeLevel(vaultDir, decoded);
  } catch (err) {
    if (err instanceof PathJailError) {
      return c.json({ error: "invalid_path", message: JAIL_MESSAGE }, 400);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return c.json({ error: "not_found", message: "Directory not found." }, 404);
    }
    if (code === "ENOTDIR") {
      return c.json({ error: "invalid_path", message: "Path is not a directory." }, 400);
    }
    throw err;
  }

  // `dir` echoes the resolved vault-relative path the jail accepted, not the
  // raw query, so a traversal probe cannot reflect the host layout back.
  return c.json({ dir: c.req.query("dir") ?? ".", entries }, 200);
});