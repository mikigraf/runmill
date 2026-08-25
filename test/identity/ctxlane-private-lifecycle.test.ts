import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
  CtxlaneIdentityProtocolError,
  CtxlanePrivateLifecycleClient,
  type CtxlanePrivateLifecycleExchange,
} from "../../src/identity/ctxlane-broker.js";

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ctxlane", "examples");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as Record<
    string,
    unknown
  >;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const activeLease = loadFixture("identity-lease-active.v1.json");
const activeView = loadFixture("lease-view-active.v1.json");
const inspectRequest = loadFixture("lease-inspect-request.v1.json");
const clientRequestId = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function privateRequest(
  operation: "renew" | "revoke" | "close",
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
    operation,
    client_request_id: clientRequestId,
    lease: clone(activeLease),
    ...fields,
  };
}

function privateLeaseResponse(
  operation: "renew" | "revoke" | "close",
  mutate: (lease: Record<string, unknown>) => void,
): Record<string, unknown> {
  const lease = clone(activeLease);
  mutate(lease);
  return {
    schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
    operation,
    client_request_id: clientRequestId,
    result: { kind: "lease", lease },
  };
}

function exchangeFor(response: unknown, inspectResponse: unknown = activeView): {
  exchange: CtxlanePrivateLifecycleExchange;
  sentPrivate: { value?: Record<string, unknown> };
  sentInspect: { value?: Record<string, unknown> };
} {
  const sentPrivate: { value?: Record<string, unknown> } = {};
  const sentInspect: { value?: Record<string, unknown> } = {};
  return {
    sentPrivate,
    sentInspect,
    exchange: {
      privateLifecycle: async (request) => {
        sentPrivate.value = request;
        return response;
      },
      inspect: async (request) => {
        sentInspect.value = request;
        return inspectResponse;
      },
    },
  };
}

describe("ctxlane private lifecycle client", () => {
  it("sends an exact renew request and accepts only a renewing higher generation", async () => {
    const response = privateLeaseResponse("renew", (lease) => {
      lease.status = "renewing";
      lease.fencing_generation = 2;
    });
    const harness = exchangeFor(response);
    const client = new CtxlanePrivateLifecycleClient(harness.exchange);
    const request = privateRequest("renew", { requested_ttl_seconds: 900 });

    const parsed = await client.renew(request);
    expect(parsed.operation).toBe("renew");
    expect(harness.sentPrivate.value?.client_request_id).toBe(clientRequestId);
    const sentLease = harness.sentPrivate.value?.lease as Record<string, unknown>;
    expect(sentLease.work_order_digest).toBe(activeLease.work_order_digest);
    expect(sentLease.effective_policy_digest).toBe(activeLease.effective_policy_digest);
  });

  it.each([
    ["active", "renew", { requested_ttl_seconds: 900 }, (lease: Record<string, unknown>) => {
      lease.status = "active";
      lease.fencing_generation = 2;
    }],
    ["revoked", "close", { reason: "completed" }, (lease: Record<string, unknown>) => {
      lease.status = "revoked";
      lease.execution_handle = null;
      lease.reason_code = "operator-revoked";
    }],
    ["closed", "revoke", { reason: "operator-revoked" }, (lease: Record<string, unknown>) => {
      lease.status = "closed";
      lease.execution_handle = null;
      lease.reason_code = "completed";
    }],
  ] as const)("rejects a %s response for the %s state transition", async (_label, operation, fields, mutate) => {
    const response = privateLeaseResponse(operation, mutate);
    const client = new CtxlanePrivateLifecycleClient(exchangeFor(response).exchange);
    const request = privateRequest(operation, fields);

    await expect(client[operation](request)).rejects.toThrow(CtxlaneIdentityProtocolError);
  });

  it.each([
    ["work_order_digest", "sha256:b36dbc1704725260b0896399529c16a86acabb6849bb1c9abeb251d7ffd16e6c"],
    ["client_request_id", "req_01ARZ3NDEKTSV4RRFFQ69G5FAX"],
  ] as const)("rejects a response with a mismatched %s", async (field, value) => {
    const response = privateLeaseResponse("renew", (lease) => {
      lease.status = "renewing";
      lease.fencing_generation = 2;
      if (field === "work_order_digest") lease.work_order_digest = value;
    });
    if (field === "client_request_id") response.client_request_id = value;
    const client = new CtxlanePrivateLifecycleClient(exchangeFor(response).exchange);

    await expect(
      client.renew(privateRequest("renew", { requested_ttl_seconds: 900 })),
    ).rejects.toThrow(CtxlaneIdentityProtocolError);
  });

  it("validates revoke and close terminal reason/state combinations", async () => {
    const revokeResponse = privateLeaseResponse("revoke", (lease) => {
      lease.status = "revoked";
      lease.execution_handle = null;
      lease.reason_code = "operator-revoked";
    });
    const revokeClient = new CtxlanePrivateLifecycleClient(exchangeFor(revokeResponse).exchange);
    await expect(
      revokeClient.revoke(privateRequest("revoke", { reason: "operator-revoked" })),
    ).resolves.toMatchObject({ operation: "revoke" });

    const closeResponse = privateLeaseResponse("close", (lease) => {
      lease.status = "closed";
      lease.execution_handle = null;
      lease.reason_code = "completed";
    });
    const closeClient = new CtxlanePrivateLifecycleClient(exchangeFor(closeResponse).exchange);
    await expect(
      closeClient.close(privateRequest("close", { reason: "completed" })),
    ).resolves.toMatchObject({ operation: "close" });
  });

  it("accepts correlated private errors without inventing a response lease", async () => {
    const response = {
      schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
      operation: "revoke",
      client_request_id: clientRequestId,
      result: {
        kind: "error",
        error: {
          schema: "ctxlane.automation-error/v1",
          operation: "lease-revoke",
          code: "lease-not-active",
          client_request_id: clientRequestId,
          lease_id: activeLease.lease_id,
        },
      },
    };
    const client = new CtxlanePrivateLifecycleClient(exchangeFor(response).exchange);
    const parsed = await client.revoke(
      privateRequest("revoke", { reason: "operator-revoked" }),
    );
    expect(parsed.result.kind).toBe("error");
  });

  it("keeps inspect on the capability-free published view contract", async () => {
    const harness = exchangeFor({}, activeView);
    const client = new CtxlanePrivateLifecycleClient(harness.exchange);
    const view = await client.inspect(inspectRequest);

    expect(harness.sentInspect.value).toEqual(inspectRequest);
    expect(view.lease_id).toBe(inspectRequest.lease_id);
    expect("execution_handle" in view).toBe(false);
    expect("fencing_generation" in view).toBe(false);
  });

  it("rejects an inspect response for another lease or with capability fields", async () => {
    const wrongLease = { ...activeView, lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FAX" };
    const wrongClient = new CtxlanePrivateLifecycleClient(exchangeFor({}, wrongLease).exchange);
    await expect(wrongClient.inspect(inspectRequest)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );

    const capabilityBearing = { ...activeView, execution_handle: activeLease.execution_handle };
    const capabilityClient = new CtxlanePrivateLifecycleClient(
      exchangeFor({}, capabilityBearing).exchange,
    );
    await expect(capabilityClient.inspect(inspectRequest)).rejects.toThrow(
      CtxlaneIdentityProtocolError,
    );
  });
});
