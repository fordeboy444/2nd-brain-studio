import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./http/app.js";
import { configureJobQueue, resumeJobs } from "./jobs/bootstrap.js";

// The queue exists before routes can enqueue anything. The default dependency
// set is the inert adapter set until 03-04 installs the real ingest adapters.
configureJobQueue();

// Boot resume runs before the port opens, but a failure here must never stop
// the server: one corrupt job is worth less than the whole UI.
try {
  const resumed = await resumeJobs();
  if (resumed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[${config.serviceName}] resumed ${resumed.length} job(s)`);
  }
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(`[${config.serviceName}] resume_failed`, error);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[${config.serviceName}] listening on http://localhost:${info.port}`);
});