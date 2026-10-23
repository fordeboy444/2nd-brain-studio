import { serve } from "@hono/node-server";
import { ensureAdminToken } from "./auth/adminToken.js";
import { config } from "./config.js";
import { app } from "./http/app.js";
import { configureJobQueue, resumeJobs } from "./jobs/bootstrap.js";
import { acquireInstanceLock } from "./lock.js";

// The queue exists before routes can enqueue anything. The default dependency
// set is the inert adapter set until 03-04 installs the real ingest adapters.
configureJobQueue();

// Single-instance safety (OPS-06). Active instance claims the lock.
// A secondary instance detects active lock and serves in read-only mode,
// skipping job resume and rejecting write requests.
const lockState = await acquireInstanceLock();
if (lockState.isReadOnly) {
  // eslint-disable-next-line no-console
  console.log(
    `[${config.serviceName}] running in READ-ONLY mode (active instance held by PID ${lockState.lockHolder?.pid} on ${lockState.lockHolder?.host})`,
  );
} else {
  // First-boot admin credential. A failure here must not stop the server: an
  // unreadable or unwritable /data leaves the app degraded (login answers 503),
  // which is a state the operator can see and fix, not a boot loop.
  try {
    const created = await ensureAdminToken();
    if (created) {
      // eslint-disable-next-line no-console
      console.log(
        `[${config.serviceName}] admin token created at ${config.adminTokenPath}`,
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[${config.serviceName}] admin_token_create_failed path=${config.adminTokenPath}`,
      error instanceof Error ? error.message : String(error),
    );
  }

  // Boot resume runs before the port opens only on the active primary instance.
  // A failure here must never stop the server: one corrupt job is worth less than the whole UI.
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
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[${config.serviceName}] listening on http://localhost:${info.port}`);
});