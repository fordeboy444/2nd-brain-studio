import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The /api prefix forwards to the single Node process that config.ts
      // defaults PORT to (3010). Same-origin in production; no CORS needed.
      "/api": {
        target: "http://localhost:3010",
        changeOrigin: true,
        // `changeOrigin` rewrites Host to the target; the same-origin guard
        // compares the browser's Origin against the forwarded host. Without
        // `xfwd`, every mutating /api request 403s in `pnpm dev`.
        xfwd: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // DOM environment so the theme spec can exercise document + localStorage.
    environment: "jsdom",
  },
});