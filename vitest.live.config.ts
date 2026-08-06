import { defineConfig } from "vitest/config";

/**
 * Live suite: talks to real credentials and real remotes.
 *
 * Kept out of the default run so a network blip or an expired token can never
 * fail `npm test`. Run deliberately:  npx vitest run --config vitest.live.config.ts
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
