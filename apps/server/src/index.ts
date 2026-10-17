import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./http/app.js";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[${config.serviceName}] listening on http://localhost:${info.port}`);
});