import { Hono } from "hono";
import pino from "pino";
import { z } from "zod";
import { sameOrigin } from "../http/origin.js";
import {
  createVault,
  deleteVault,
  listVaults,
  readRegistry,
  type Registry,
} from "../vaults/registry.js";

const log = pino({ name: "vault-create" });

/**
 * Fixed copy for the filesystem failures a create can hit. The raw message of
 * an `ENOENT`/`EACCES`/`ENOSPC` names absolute source and destination paths,
 * and those must not reach the client.
 */
const CREATE_FAILURE_MESSAGES: Record<string, string> = {
  EACCES: "The server cannot write to the vault directory.",
  EPERM: "The server cannot write to the vault directory.",
  ENOSPC: "The disk is full.",
  ENOENT: "A template file needed to create the vault is missing.",
  EEXIST: "The vault directory already exists.",
};

/**
 * GET /api/vaults — returns 200 and the ordered vault array (empty array,
 * never null, never 404).
 * POST /api/vaults — validates `{name: string}`, returns 201 with the created
 * record, or 409 naming the collision when the slug already exists. Errors
 * name the vault, never the host path.
 */
export const vaults = new Hono();

/** Fixed copy for an unreadable registry; the raw error names a host path. */
const REGISTRY_INVALID_MESSAGE = "The vault registry is unreadable.";

// Create and delete write to the volume, so they get the same cross-site
// forgery guard as the jobs and settings routers.
vaults.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    return c.json(
      { error: "origin_mismatch", message: "Cross-origin requests are not accepted." },
      403,
    );
  }
  await next();
});

const CreateBody = z.object({
  name: z.string().min(1, "name must not be empty"),
});

vaults.get("/", async (c) => {
  try {
    const entries = await listVaults();
    return c.json(entries, 200);
  } catch (err) {
    if ((err as Error & { code?: string }).code === "registry_invalid") {
      return c.json(
        { error: "registry_invalid", message: REGISTRY_INVALID_MESSAGE },
        500,
      );
    }
    throw err;
  }
});

vaults.post("/", async (c) => {
  let parsed: z.infer<typeof CreateBody>;
  try {
    const body = await c.req.json();
    parsed = CreateBody.parse({ name: typeof body?.name === "string" ? body.name.trim() : "" });
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON with a non-empty `name` string." }, 400);
  }
  try {
    const entry = await createVault({ name: parsed.name });
    return c.json(entry, 201);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const msg = (err as Error).message;
    if (code === "slug_collision") {
      return c.json({ error: "slug_collision", message: msg }, 409);
    }
    if (code === "non_empty") {
      return c.json({ error: "non_empty", message: msg }, 409);
    }
    if (code === "registry_invalid") {
      return c.json(
        { error: "registry_invalid", message: REGISTRY_INVALID_MESSAGE },
        500,
      );
    }
    if (code === "invalid_name") {
      // The name is valid JSON and a non-empty string, but it cannot produce
      // a slug. That is a request error, not a server fault.
      return c.json({ error: "invalid_name", message: msg }, 400);
    }
    // Log the detail server-side and answer with fixed copy: a filesystem
    // error message can name absolute host paths.
    log.error({ err }, "vault create failed");
    const fsCode = (err as NodeJS.ErrnoException).code;
    const safe =
      fsCode !== undefined ? CREATE_FAILURE_MESSAGES[fsCode] : undefined;
    return c.json(
      { error: "create_failed", message: safe ?? "Could not create the vault." },
      500,
    );
  }
});

const DeleteBody = z.object({
  confirmName: z.string().min(1),
});

/**
 * DELETE /api/vaults/:id — body `{confirmName: string}`.
 *
 * Removes the vault only when `confirmName` exactly equals the stored vault
 * `name` (D-06). On a match, `deleteVault` removes the directory from disk
 * FIRST and then the registry entry, so a partial failure leaves an orphaned
 * registry entry rather than an orphaned directory a later create would refuse.
 * Unknown id → 404, touching neither the registry nor the volume (VAULT-03);
 * idempotent under repetition: a second call for the same id is the 404 case.
 */
vaults.delete("/:id", async (c) => {
  const id = c.req.param("id");
  let reg: Registry;
  try {
    reg = await readRegistry();
  } catch (err) {
    if ((err as Error & { code?: string }).code === "registry_invalid") {
      return c.json(
        { error: "registry_invalid", message: REGISTRY_INVALID_MESSAGE },
        500,
      );
    }
    throw err;
  }
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) return c.json({ error: "not_found", message: "Unknown vault." }, 404);

  let parsed: z.infer<typeof DeleteBody>;
  try {
    const body = await c.req.json();
    parsed = DeleteBody.parse(body);
  } catch {
    return c.json(
      { error: "invalid_body", message: "Request body must be JSON with a non-empty `confirmName` string." },
      400,
    );
  }

  if (parsed.confirmName !== record.name) {
    // Mismatched confirmation: remove nothing. The vault directory still exists.
    return c.json(
      { error: "confirm_mismatch", message: "`confirmName` does not match the vault name." },
      400,
    );
  }

  try {
    await deleteVault(id);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "not_found") {
      // Race: removed between the read above and deleteVault. 404, no recreation.
      return c.json({ error: "not_found", message: "Unknown vault." }, 404);
    }
    if (code === "registry_invalid") {
      return c.json(
        { error: "registry_invalid", message: REGISTRY_INVALID_MESSAGE },
        500,
      );
    }
    throw err;
  }
  return c.json({ deleted: true, id }, 200);
});