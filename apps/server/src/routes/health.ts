import { Hono } from "hono";
import { config } from "../config.js";
import { getLockState } from "../lock.js";
import { resolveOllamaKey } from "../settings/ollamaKey.js";

/**
 * GET /api/health — answers over in-memory config plus the on-disk Ollama key
 * file. The key file read is a single small `stat`+`read`; it is awaited so a
 * job runner in flight never gets a stale `degraded` after a key was saved in
 * Settings (API-08). The payload is an explicit allowlist; the key body is
 * never spread in — only the boolean `ok`.
 */
export const health = new Hono();

const startedAt = Date.now();

health.get("/", async (c) => {
  const ok = (await resolveOllamaKey()) !== undefined;
  const lockState = getLockState();
  const payload = {
    ok,
    status: ok ? ("healthy" as const) : ("degraded" as const),
    service: config.serviceName,
    version: config.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
    readOnly: lockState.isReadOnly,
  };
  return c.json(payload, 200);
});