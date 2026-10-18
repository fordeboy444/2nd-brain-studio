import { Hono } from "hono";
import { z } from "zod";
import { createVault, deleteVault, listVaults, readRegistry } from "../vaults/registry.js";

/**
 * GET /api/vaults — returns 200 and the ordered vault array (empty array,
 * never null, never 404).
 * POST /api/vaults — validates `{name: string}`, returns 201 with the created
 * record, or 409 naming the collision when the slug already exists. Errors
 * name the vault, never the host path.
 */
export const vaults = new Hono();

const CreateBody = z.object({
  name: z.string().min(1, "name must not be empty"),
});

vaults.get("/", async (c) => {
  const entries = await listVaults();
  return c.json(entries, 200);
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
    if (code === "invalid_name") {
      // The name is valid JSON and a non-empty string, but it cannot produce
      // a slug. That is a request error, not a server fault.
      return c.json({ error: "invalid_name", message: msg }, 400);
    }
    // Never leak a host path; the message already names the vault.
    return c.json({ error: "create_failed", message: msg }, 500);
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
  const reg = await readRegistry();
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
    throw err;
  }
  return c.json({ deleted: true, id }, 200);
});