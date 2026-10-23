/**
 * The agent-token admin API (T-261023-02, T-261023-06).
 *
 * Admin-only by the router-level check below. Minting is the one response that
 * carries a plaintext token; the list never does, and nothing here logs either
 * the token or its hash.
 */
import { Hono, type Context } from "hono";
import pino from "pino";
import { z } from "zod";
import { isAdmin, principalOf } from "../auth/middleware.js";
import {
  listTokens,
  mintToken,
  revokeToken,
  TokenStoreInvalidError,
} from "../auth/tokens.js";
import { sameOrigin } from "../http/origin.js";

const log = pino({ name: "admin" });

export const admin = new Hono();

/** Fixed copy for an unreadable store; the raw error names a host path. */
const STORE_INVALID_MESSAGE = "The agent token store is unreadable.";

/**
 * Admin-only. `/api/admin` is a gated prefix, so an agent token reaches this
 * router authenticated but with `kind: "token"`; it must never mint or revoke.
 */
admin.use("*", async (c, next) => {
  if (!isAdmin(c)) {
    return c.json(
      { error: "forbidden", message: "This token cannot use the admin API." },
      403,
    );
  }
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    return c.json(
      { error: "origin_mismatch", message: "Cross-origin requests are not accepted." },
      403,
    );
  }
  await next();
});

const MintBody = z.object({
  name: z.string().min(1).max(64),
  vaults: z.union([
    z.literal("*"),
    z.array(z.string().min(1).max(128)).min(1),
  ]),
});

function storeInvalid(c: Context): Response {
  return c.json({ error: "token_store_invalid", message: STORE_INVALID_MESSAGE }, 500);
}

/** POST /api/admin/tokens — mint one token, returned exactly once. */
admin.post("/tokens", async (c) => {
  let parsed: z.infer<typeof MintBody>;
  try {
    const body = await c.req.json();
    parsed = MintBody.parse(body);
  } catch {
    return c.json(
      {
        error: "invalid_body",
        message:
          "Request body must be JSON with a `name` string and `vaults` as \"*\" or a non-empty array of vault ids.",
      },
      400,
    );
  }

  try {
    const { entry, token } = await mintToken(parsed);
    const principal = principalOf(c);
    // The created id and name only: the token and its hash stay out of the log.
    log.info(
      { tokenId: entry.id, name: entry.name, by: principal?.id ?? "admin" },
      "agent_token_minted",
    );
    return c.json({ token, tokenId: entry.id, entry }, 201);
  } catch (error) {
    if (error instanceof TokenStoreInvalidError) return storeInvalid(c);
    throw error;
  }
});

/** GET /api/admin/tokens — ids, names, scopes and creation times. No hashes. */
admin.get("/tokens", async (c) => {
  try {
    const tokens = await listTokens();
    return c.json({ tokens }, 200);
  } catch (error) {
    if (error instanceof TokenStoreInvalidError) return storeInvalid(c);
    throw error;
  }
});

/** DELETE /api/admin/tokens/:id — revocation takes effect on the next request. */
admin.delete("/tokens/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const deleted = await revokeToken(id);
    if (!deleted) {
      return c.json({ error: "not_found", message: "Unknown token." }, 404);
    }
    log.info({ tokenId: id }, "agent_token_revoked");
    return c.json({ deleted: true, id }, 200);
  } catch (error) {
    if (error instanceof TokenStoreInvalidError) return storeInvalid(c);
    throw error;
  }
});
