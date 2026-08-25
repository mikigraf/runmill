/**
 * Optional live qualification probe for a real Linux ctxlane service.
 *
 * Deliberately excluded from the default suite. Configure both absolute paths
 * and run with `vitest.live.config.ts` only when a protected local ctxlane
 * service is available:
 *
 *   RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
 *   RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
 *   npx vitest run --config vitest.live.config.ts test/live/ctxlane-service-health.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { CtxlaneMcpServiceHealthProbe } from "../../src/identity/ctxlane-service-health.js";

const executable = process.env["RUNMILL_CTXLANE_BINARY"];
const root = process.env["RUNMILL_CTXLANE_ROOT"];
const configured = process.platform === "linux" && executable !== undefined && root !== undefined;

describe.runIf(configured)("live: ctxlane authenticated service health", () => {
  it("reads the published service-health contract without promoting authority", async () => {
    const probe = new CtxlaneMcpServiceHealthProbe({
      executable: executable as string,
      root: root as string,
    });
    const health = await probe.probe();
    expect(health.schema).toBe("ctxlane.service-health/v1");
    expect(typeof health.controller_channel_ready).toBe("boolean");
    expect(typeof health.ready).toBe("boolean");
    expect(probe.qualification).toBe("authenticated-observation-only");
  }, 60_000);
});
