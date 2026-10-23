import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Router-level specs drive a Hono instance directly, so they never meet
    // `authenticate`. The setup file enables the test-only bypass for them;
    // the auth specs unset it per test to exercise the real path.
    setupFiles: ["src/auth/testSetup.ts"],
  },
});
