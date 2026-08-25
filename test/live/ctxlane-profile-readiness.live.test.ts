/**
 * Optional live qualification probe for one operator-selected ctxlane profile.
 *
 * Deliberately excluded from the default suite. Configure all values and run
 * with `vitest.live.config.ts` only when a protected local ctxlane service and
 * provider readiness evaluator are available:
 *
 *   RUNMILL_CTXLANE_BINARY=/usr/local/bin/ctxlane \
 *   RUNMILL_CTXLANE_ROOT=/var/lib/ctxlane \
 *   RUNMILL_CTXLANE_CLIENT_REQUEST_ID=req_01ARZ3NDEKTSV4RRFFQ69G5FAV \
 *   RUNMILL_CTXLANE_PROFILE_UID=profile_01ARZ3NDEKTSV4RRFFQ69G5FAV \
 *   RUNMILL_CTXLANE_PROFILE_REF=codex:automation-production \
 *   RUNMILL_CTXLANE_ENVIRONMENT=production \
 *   RUNMILL_CTXLANE_ROLE=implementer \
 *   npx vitest run --config vitest.live.config.ts test/live/ctxlane-profile-readiness.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { SystemClock } from "../../src/platform/clock.js";
import {
  CtxlaneMcpProfileReadinessProbe,
  toCtxlaneProfileReadinessObservationEnvelope,
} from "../../src/identity/ctxlane-profile-readiness.js";
import type { CtxlaneRole } from "../../src/identity/ctxlane-contracts.js";

const executable = process.env["RUNMILL_CTXLANE_BINARY"];
const root = process.env["RUNMILL_CTXLANE_ROOT"];
const clientRequestId = process.env["RUNMILL_CTXLANE_CLIENT_REQUEST_ID"];
const profileUid = process.env["RUNMILL_CTXLANE_PROFILE_UID"];
const profileRef = process.env["RUNMILL_CTXLANE_PROFILE_REF"];
const environment = process.env["RUNMILL_CTXLANE_ENVIRONMENT"];
const role = process.env["RUNMILL_CTXLANE_ROLE"] as CtxlaneRole | undefined;
const configured =
  process.platform === "linux" &&
  executable !== undefined &&
  root !== undefined &&
  clientRequestId !== undefined &&
  profileUid !== undefined &&
  profileRef !== undefined &&
  environment !== undefined &&
  role !== undefined;

describe.runIf(configured)("live: ctxlane authenticated profile readiness", () => {
  it("proves one exact profile is currently ready without acquiring authority", async () => {
    const request = {
      executable: executable as string,
      root: root as string,
      clientRequestId: clientRequestId as string,
      profileUid: profileUid as string,
      profileRef: profileRef as string,
      environment: environment as string,
      role: role as CtxlaneRole,
    };
    const probe = new CtxlaneMcpProfileReadinessProbe(request);
    const readiness = await probe.probe();
    const envelope = toCtxlaneProfileReadinessObservationEnvelope(
      readiness,
      request,
      new SystemClock(),
    );

    expect(readiness.schema).toBe("ctxlane.automation-readiness/v1");
    expect(readiness.profile_uid).toBe(request.profileUid);
    expect(readiness.profile_ref).toBe(request.profileRef);
    expect(readiness.environment).toBe(request.environment);
    expect(readiness.role).toBe(request.role);
    expect(readiness.ready).toBe(true);
    expect(readiness.probe_interactive).toBe(false);
    expect(envelope.qualification).toBe("authenticated-observation-only");
    expect(envelope.readiness).toEqual(readiness);
    expect(JSON.stringify(envelope)).not.toMatch(
      /execution_handle|lease_id|fencing_generation/i,
    );
  }, 60_000);
});
