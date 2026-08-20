import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Suites that talk to a real Linear/GitHub/provider are tagged `live` and
    // never gate a local `npm test`. See prd.md "Flakiness risk".
    exclude: ["test/live/**", "node_modules/**"],
    environment: "node",
    // This suite spawns real git, real sandboxes, and real child processes
    // rather than mocking them, so individual tests legitimately take seconds.
    // Vitest's 5s default was tight enough that git-lease.test.ts passed under
    // `npm test` and timed out under `npm run test:coverage` — the same tests,
    // just slower with instrumentation attached. A flaky gate is worse than a
    // slow one, and the slowest deliberate timeouts in the suite are already
    // 30s, so that is the honest ceiling.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli/main.ts", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
