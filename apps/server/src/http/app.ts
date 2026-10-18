import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { config } from "../config.js";
import { health } from "../routes/health.js";
import { vaults } from "../routes/vaults.js";
import { files } from "../routes/file.js";
import { jobs } from "../routes/jobs.js";
import { tree } from "../routes/tree.js";

// The log level is its own setting. It must NOT follow `llmConfigured`: the
// live deployment has no OLLAMA_API_KEY, so tying the two silenced every
// request line, job event and diagnostic on the one host that needs them.
const log = pino({ name: config.serviceName, level: process.env.LOG_LEVEL ?? "info" });

/**
 * The single Hono app. One Node process serves the API and the built SPA.
 * Dev uses the Vite proxy and production is same-origin, so no cross-origin
 * sharing middleware is registered here.
 */
export const app = new Hono();

// Request logger: method, path, status only. No bodies, no headers, no secrets.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms });
});

// API routes.
app.route("/api/health", health);
app.route("/api/vaults", vaults);
app.route("/api/file", files);
app.route("/api/jobs", jobs);
// GET /api/vaults/:id/tree lives on its own router mounted at the same prefix;
// its `:id/tree` path is distinct from the vaults router's `/` and `/:id` routes.
app.route("/api/vaults", tree);

// SPA static assets + SPA fallback. Only mounted when the build exists.
const webDist = resolve(process.cwd(), "apps/web/dist");
const indexHtmlPath = resolve(webDist, "index.html");
let cachedIndex: string | null = null;

function getIndex(): string {
  if (cachedIndex !== null) return cachedIndex;
  cachedIndex = readFileSync(indexHtmlPath, "utf8");
  return cachedIndex;
}

if (existsSync(indexHtmlPath)) {
  app.use("/assets/*", serveStatic({ root: "apps/web/dist", rewriteRequestPath: (p) => p }));
  app.get("/favicon.ico", serveStatic({ root: "apps/web/dist", path: "favicon.ico" }));
  // SPA fallback: any non-API GET returns index.html.
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not_found", path: c.req.path }, 404);
    }
    return c.html(getIndex());
  });
}

// Unknown /api/* paths must return JSON 404, not SPA HTML. This runs after the
// SPA fallback route registration because Hono evaluates notFound only when no
// route matched; the fallback `app.get("*")` above already returns SPA HTML for
// non-API paths and JSON 404 for /api/* paths, so this is the catch-all for
// POST/PUT etc. to unknown /api/* paths and any other unmatched route.
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  return c.json({ error: "not_found", path: c.req.path }, 404);
});

export type App = typeof app;