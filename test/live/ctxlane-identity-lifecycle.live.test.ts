/**
 * Optional live ctxlane acquisition/lifecycle qualification.
 *
 * This is deliberately excluded from the default suite. It requires an
 * operator-created, signed identity-lease request fixture and a protected
 * Linux ctxlane service. The request contains no provider credential; the
 * native channel owns peer authentication and the private lifecycle client
 * owns response correlation/state validation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CtxlaneNativeSeqpacketAutomationClient,
  CtxlaneNativeSeqpacketLifecycleExchange,
} from "../../src/identity/ctxlane-broker.js";
import {
  ctxlaneIdentityLeaseRequestSchema,
  ctxlaneIdentityLeaseSchema,
  type CtxlaneIdentityLease,
  type CtxlaneIdentityLeaseLifecyclePrivateRequest,
} from "../../src/identity/ctxlane-contracts.js";
import { CtxlanePrivateLifecycleClient } from "../../src/identity/ctxlane-private-lifecycle.js";

const endpoint = process.env["RUNMILL_CTXLANE_ENDPOINT"];
const expectedPeerExecutable = process.env["RUNMILL_CTXLANE_EXPECTED_PEER_EXECUTABLE"];
const expectedPeerCgroup = process.env["RUNMILL_CTXLANE_EXPECTED_PEER_CGROUP"];
const requestFile = process.env["RUNMILL_CTXLANE_LIVE_REQUEST_FILE"];
const configured =
  process.platform === "linux" &&
  endpoint !== undefined &&
  expectedPeerExecutable !== undefined &&
  expectedPeerCgroup !== undefined &&
  requestFile !== undefined;

function loadRequest() {
  if (requestFile === undefined) throw new Error("live request file is not configured");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(requestFile, "utf8"));
  } catch {
    throw new Error("live request file is not valid JSON");
  }
  const parsed = ctxlaneIdentityLeaseRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("live request does not match the lease contract");
  return parsed.data;
}

function requiredValue(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} is not configured`);
  }
  return value;
}

function leaseFrom(response: unknown, operation: string): CtxlaneIdentityLease {
  if (
    response === null ||
    typeof response !== "object" ||
    !("result" in response) ||
    response.result === null ||
    typeof response.result !== "object" ||
    !("kind" in response.result) ||
    response.result.kind !== "lease" ||
    !("lease" in response.result)
  ) {
    throw new Error(`ctxlane ${operation} did not return a lease`);
  }
  const parsed = ctxlaneIdentityLeaseSchema.safeParse(response.result.lease);
  if (!parsed.success) {
    throw new Error(`ctxlane ${operation} returned an invalid lease`);
  }
  return parsed.data;
}

describe.runIf(configured)("live: ctxlane identity lease lifecycle", () => {
  it("acquires, renews, and closes one signed lease over the authenticated channel", async () => {
    const request = loadRequest();
    const client = new CtxlaneNativeSeqpacketAutomationClient({
      endpoint: requiredValue(endpoint, "RUNMILL_CTXLANE_ENDPOINT"),
      expectedPeerExecutable: requiredValue(
        expectedPeerExecutable,
        "RUNMILL_CTXLANE_EXPECTED_PEER_EXECUTABLE",
      ),
      expectedPeerCgroup: requiredValue(
        expectedPeerCgroup,
        "RUNMILL_CTXLANE_EXPECTED_PEER_CGROUP",
      ),
      trustedOwnerUids: [process.getuid?.() ?? 0],
    });
    const acquired = leaseFrom(await client.acquire(request), "acquisition");
    expect(acquired.status).toBe("active");
    expect(acquired.lease_id).toBeTruthy();
    expect(acquired.execution_handle).toBeTruthy();
    if (acquired.fencing_generation === null) {
      throw new Error("ctxlane acquisition returned no fencing generation");
    }

    const lifecycle = new CtxlanePrivateLifecycleClient(
      new CtxlaneNativeSeqpacketLifecycleExchange(client),
    );
    const renewRequest: CtxlaneIdentityLeaseLifecyclePrivateRequest = {
      schema: "ctxlane.identity-lease-lifecycle-private/v1",
      operation: "renew",
      client_request_id: request.client_request_id,
      lease: acquired,
      requested_ttl_seconds: request.requested_ttl_seconds,
    };
    const renewedResponse = await lifecycle.renew(renewRequest);
    const renewed = leaseFrom(renewedResponse, "renewal");
    expect(renewed.status).toBe("renewing");
    expect(renewed.fencing_generation).toBe(acquired.fencing_generation + 1);

    const closedResponse = await lifecycle.close({
      schema: "ctxlane.identity-lease-lifecycle-private/v1",
      operation: "close",
      client_request_id: request.client_request_id,
      lease: renewed,
      reason: "completed",
    });
    const closed = leaseFrom(closedResponse, "close");
    expect(closed.status).toBe("closed");
    expect(closed.reason_code).toBe("completed");
    expect(closed.execution_handle).toBeNull();
  }, 120_000);
});
