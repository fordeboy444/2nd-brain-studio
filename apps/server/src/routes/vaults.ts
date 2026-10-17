import { Hono } from "hono";
import { z } from "zod";
import { createVault, listVaults } from "../vaults/registry.js";

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
    // Never leak a host path; the message already names the vault.
    return c.json({ error: "create_failed", message: msg }, 500);
  }
});