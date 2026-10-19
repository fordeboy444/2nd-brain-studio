import { Hono } from "hono";
import { config } from "../config.js";
import { getLockState } from "../lock.js";

/**
 * GET /api/health — synchronous over in-memory config only. Reads no filesystem
 * and awaits nothing, so it stays answerable while a job runner is in flight
 * (API-08). The payload is an explicit allowlist; secrets are never spread in.
 */
export const health = new Hono();

const startedAt = Date.now();

health.get("/", (c) => {
  const ok = config.llmConfigured;
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