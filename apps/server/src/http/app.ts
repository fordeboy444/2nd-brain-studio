import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { config } from "../config.js";
import { getLockState } from "../lock.js";
import { health } from "../routes/health.js";
import { vaults } from "../routes/vaults.js";
import { files } from "../routes/file.js";
import { jobs } from "../routes/jobs.js";
import { settings } from "../routes/settings.js";
import { tree } from "../routes/tree.js";
import { search } from "../routes/search.js";
import { graph } from "../routes/graph.js";
import { backlinks } from "../routes/backlinks.js";
import { frontmatter } from "../routes/frontmatter.js";
import { lint } from "../routes/lint.js";
import { reindex } from "../routes/reindex.js";

// The log level is its own setting. It must NOT follow `llmConfigured`: the
// live deployment has no OLLAMA_API_KEY, so tying the two silenced every
// request line, job event and diagnostic on the one host that needs them.
const log = pino({ name: config.serviceName, level: config.logLevel });

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

/**
 * One body cap for every API request, applied while the body is read.
 *
 * The cookie routes also check their own cap, but only after `c.req.text()`
 * has buffered the whole body: a chunked multi-gigabyte request could exhaust
 * the one process that also runs every job. `bodyLimit` rejects on the
 * declared `content-length` or while streaming, before any route parses.
 */
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) =>
      c.json(
        { error: "payload_too_large", message: "Request body exceeds 1 MiB." },
        413,
      ),
  }),
);

/**
 * Read-only gate (OPS-06).
 * When another instance holds the single-writer lock, this secondary instance
 * runs in read-only mode: all mutating HTTP methods (POST, PUT, DELETE, PATCH)
 * on `/api/*` are rejected with 403 Forbidden, except `/api/health`.
 */
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    if (c.req.path !== "/api/health" && c.req.path !== "/api/health/") {
      const { isReadOnly } = getLockState();
      if (isReadOnly) {
        return c.json(
          {
            error: "read_only",
            message:
              "This instance is read-only — another instance holds the write lock.",
          },
          403,
        );
      }
    }
  }
  await next();
});

// API routes.
app.route("/api/health", health);
app.route("/api/vaults", vaults);
app.route("/api/file", files);
app.route("/api/jobs", jobs);
// Mounted before the SPA fallback so `/api/settings/*` never returns index.html.
app.route("/api/settings", settings);
// GET /api/vaults/:id/tree lives on its own router mounted at the same prefix;
// its `:id/tree` path is distinct from the vaults router's `/` and `/:id` routes.
app.route("/api/vaults", tree);
app.route("/api/vaults", search);
app.route("/api/vaults", graph);
app.route("/api/vaults", backlinks);
app.route("/api/vaults", frontmatter);
app.route("/api/vaults", lint);
app.route("/api/vaults", reindex);

// SPA static assets + SPA fallback. Only mounted when the build exists.
// `WEB_DIST_DIR` lets a spec point at its own temporary directory, so tests
// never create or delete the shared build output under `apps/web/dist`.
const webDist = process.env.WEB_DIST_DIR ?? resolve(process.cwd(), "apps/web/dist");
const indexHtmlPath = resolve(webDist, "index.html");
let cachedIndex: string | null = null;

function getIndex(): string {
  if (cachedIndex !== null) return cachedIndex;
  cachedIndex = readFileSync(indexHtmlPath, "utf8");
  return cachedIndex;
}

if (existsSync(indexHtmlPath)) {
  app.use("/assets/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p }));
  app.get("/favicon.ico", serveStatic({ root: webDist, path: "favicon.ico" }));
  // SPA fallback: any non-API GET returns index.html.
  app.get("*", (c) => {
    // Assets and the favicon are files, not SPA routes. Handing a missing one
    // index.html with 200 makes the browser report a MIME/parse failure and
    // caches the wrong body; a 404 is the honest answer.
    if (
      c.req.path.startsWith("/api/") ||
      c.req.path.startsWith("/assets/") ||
      c.req.path === "/favicon.ico"
    ) {
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