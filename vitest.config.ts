import { defineConfig } from "vitest/config";

/**
 * The root test project exists for specs that belong to the repository rather
 * than to one package — currently the structural checks over the deployment
 * artifacts in tests/. Each workspace package keeps its own vitest config and
 * its own `test` script, so `pnpm -r test` is unchanged; the root `test` script
 * runs this project alone.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
