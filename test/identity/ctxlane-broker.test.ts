import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IdentityLease,
  IdentityLeaseRequest,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import { identityBrokerFailureDisposition } from "../../src/identity/broker.js";
import type { CtxlaneAcquisitionAuthority } from "../../src/identity/ctxlane-authority.js";
import {
  CtxlaneIdentityProtocolError,
  CtxlaneProviderIdentityBroker,
  strictJsonDecode,
  type CtxlaneIdentityLeaseAcquisitionClient,
  type CtxlaneLeaseCloseRequest,
  type CtxlaneLeaseLifecycleClient,
  type CtxlaneLeaseRenewalRequest,
  type CtxlaneLeaseRevocationRequest,
  type CtxlaneProviderIdentityLease,
} from "../../src/identity/ctxlane-broker.js";
import type {
  CtxlaneAutomationError,
  CtxlaneIdentityLease,
  CtxlaneIdentityLeaseRequest,
} from "../../src/identity/ctxlane-contracts.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const FIXTURE_DIRECTORY = join(
  __dirname,
  "..",
  "fixtures",
  "ctxlane",
  "examples",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), "utf8")) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const REQUEST_FIXTURE = fixture<CtxlaneIdentityLeaseRequest>(
  "identity-lease-request.v1.json",
);
const ACTIVE_FIXTURE = fixture<CtxlaneIdentityLease>(
  "identity-lease-active.v1.json",
);
const REFUSED_FIXTURE = fixture<CtxlaneIdentityLease>(
  "identity-lease-refused.v1.json",
);
const ERROR_FIXTURE = fixture<CtxlaneAutomationError>(
  "automation-error.v1.json",
);
const NOW = "2026-08-21T10:00:00.000Z";
const RUNMILL_POLICY_DIGEST = `sha256:${"c".repeat(64)}`;

function identityRequest(
  overrides: Partial<IdentityLeaseRequest> = {},
): IdentityLeaseRequest {
  return {
    runId: REQUEST_FIXTURE.run_id,
    workOrderId: REQUEST_FIXTURE.work_order_id,
    attemptId: REQUEST_FIXTURE.attempt_id,
    role: REQUEST_FIXTURE.role,
    requestedProfile: REQUEST_FIXTURE.profile_ref,
    policyDigest: RUNMILL_POLICY_DIGEST,
    fencingGeneration: 41,
    requestedDurationMs: REQUEST_FIXTURE.requested_ttl_seconds * 1_000,
    ...overrides,
  };
}

function acquisitionAuthority(
  overrides: Partial<CtxlaneAcquisitionAuthority> = {},
): CtxlaneAcquisitionAuthority {
  return {
    intent: {
      clientRequestId: REQUEST_FIXTURE.client_request_id,
      acquisitionRequest: clone(REQUEST_FIXTURE),
      expectedCallerSubject: ACTIVE_FIXTURE.caller_subject,
      expectedHostIdentity: ACTIVE_FIXTURE.host_identity,
    },
    clientRequestId: REQUEST_FIXTURE.client_request_id,
    tenantId: REQUEST_FIXTURE.tenant_id,
    workOrderDigest: REQUEST_FIXTURE.work_order_digest,
    workOrderAuthorization: clone(REQUEST_FIXTURE.work_order_authorization),
    provider: REQUEST_FIXTURE.provider,
    profileUid: REQUEST_FIXTURE.profile_uid,
    profileRef: REQUEST_FIXTURE.profile_ref,
    repository: REQUEST_FIXTURE.repository,
    workspaceId: REQUEST_FIXTURE.workspace_id,
    environment: REQUEST_FIXTURE.environment,
    expectedCallerSubject: ACTIVE_FIXTURE.caller_subject,
    expectedHostIdentity: ACTIVE_FIXTURE.host_identity,
    ctxlanePolicyDigest: REQUEST_FIXTURE.policy_digest,
    ...overrides,
  };
}

class RecordingAcquisitionClient
  implements CtxlaneIdentityLeaseAcquisitionClient
{
  readonly requests: CtxlaneIdentityLeaseRequest[] = [];
  readonly signals: AbortSignal[] = [];

  constructor(
    readonly respond: (
      request: CtxlaneIdentityLeaseRequest,
      signal: AbortSignal | undefined,
    ) => unknown | Promise<unknown>,
  ) {}

  async acquire(
    request: CtxlaneIdentityLeaseRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requests.push(clone(request));
    if (signal !== undefined) this.signals.push(signal);
    return await this.respond(request, signal);
  }
}

class RecordingLifecycleClient implements CtxlaneLeaseLifecycleClient {
  readonly renewRequests: CtxlaneLeaseRenewalRequest[] = [];
  readonly closeRequests: CtxlaneLeaseCloseRequest[] = [];
  readonly revokeRequests: CtxlaneLeaseRevocationRequest[] = [];
  renewResponse: (
    request: CtxlaneLeaseRenewalRequest,
  ) => unknown | Promise<unknown> = () => {
    throw new Error("unexpected renewal");
  };
  closeResponse: (
    request: CtxlaneLeaseCloseRequest,
  ) => unknown | Promise<unknown> = () => {
    throw new Error("unexpected close");
  };
  revokeResponse: (
    request: CtxlaneLeaseRevocationRequest,
  ) => unknown | Promise<unknown> = () => {
    throw new Error("unexpected revocation");
  };

  async renew(request: CtxlaneLeaseRenewalRequest): Promise<unknown> {
    this.renewRequests.push(request);
    return await this.renewResponse(request);
  }

  async close(request: CtxlaneLeaseCloseRequest): Promise<unknown> {
    this.closeRequests.push(request);
    return await this.closeResponse(request);
  }

  async revoke(request: CtxlaneLeaseRevocationRequest): Promise<unknown> {
    this.revokeRequests.push(request);
    return await this.revokeResponse(request);
  }
}

class RecordingFence implements IdentityOwnershipFenceValidator {
  readonly observations: IdentityOwnershipFence[] = [];
  values: boolean[] = [];

  async isCurrent(fence: IdentityOwnershipFence): Promise<boolean> {
    this.observations.push(fence);
    return this.values.shift() ?? true;
  }
}

function publishedFromInternal(
  lease: CtxlaneProviderIdentityLease,
  status: "active" | "closed" | "revoked" | "expired",
  overrides: Partial<CtxlaneIdentityLease> = {},
): CtxlaneIdentityLease {
  const terminal = status !== "active";
  return {
    schema: "ctxlane.identity-lease/v1",
    lease_id: lease.leaseId,
    status,
    tenant_id: lease.ctxlane.tenantId,
    work_order_id: lease.workOrderId,
    work_order_digest: lease.ctxlane.workOrderDigest,
    run_id: lease.runId,
    attempt_id: lease.attemptId,
    role: lease.role as CtxlaneIdentityLease["role"],
    provider: lease.provider as CtxlaneIdentityLease["provider"],
    profile_uid: lease.ctxlane.profileUid,
    profile_ref: lease.profile,
    repository: lease.ctxlane.repository,
    workspace_id: lease.ctxlane.workspaceId,
    environment: lease.ctxlane.environment,
    caller_subject: lease.ctxlane.callerSubject,
    host_identity: lease.ctxlane.hostIdentity,
    worker_identity: lease.ctxlane.workerIdentity,
    principal_ref: lease.principal,
    workspace_ref: lease.ctxlane.workspaceRef,
    auth_mode: lease.ctxlane.authMode as CtxlaneIdentityLease["auth_mode"],
    fencing_generation: lease.ctxlane.fencingGeneration,
    issued_at: lease.issuedAt,
    expires_at: lease.expiresAt,
    maximum_expires_at: lease.ctxlane.maximumExpiresAt,
    execution_handle: terminal ? null : lease.executionHandle,
    isolation: lease.ctxlane.isolation as CtxlaneIdentityLease["isolation"],
    effective_policy_digest: lease.ctxlane.effectivePolicyDigest,
    refusal_code: null,
    reason_code:
      status === "closed"
        ? "completed"
        : status === "revoked"
          ? "operator-revoked"
          : status === "expired"
            ? "lease-expired"
            : null,
    ...overrides,
  };
}

interface SetupOptions {
  readonly response?: unknown;
  readonly authority?: CtxlaneAcquisitionAuthority;
  readonly acquisition?: RecordingAcquisitionClient;
  readonly lifecycle?: RecordingLifecycleClient;
  readonly fence?: RecordingFence;
  readonly requestTimeoutMs?: number;
  readonly clock?: FakeClock;
}

function setup(options: SetupOptions = {}) {
  const acquisition =
    options.acquisition ??
    new RecordingAcquisitionClient(() =>
      clone(options.response ?? ACTIVE_FIXTURE),
    );
  const lifecycle = options.lifecycle ?? new RecordingLifecycleClient();
  const fence = options.fence ?? new RecordingFence();
  const clock = options.clock ?? new FakeClock(NOW);
  const authority = options.authority ?? acquisitionAuthority();
  const broker = new CtxlaneProviderIdentityBroker({
    client: acquisition,
    lifecycleClient: lifecycle,
    clock,
    ownershipFence: fence,
    authority: {
      resolveAcquisitionAuthority: () => authority,
    },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return { acquisition, authority, broker, clock, fence, lifecycle };
}

async function acquireActive(options: SetupOptions = {}) {
  const context = setup(options);
  const lease = (await context.broker.acquire(
    identityRequest(),
  )) as CtxlaneProviderIdentityLease;
  return { ...context, lease };
}

describe("CtxlaneProviderIdentityBroker acquisition", () => {
  it("sends the byte-faithful published request and preserves separate fences", async () => {
    const { acquisition, broker } = setup();

    const lease = (await broker.acquire(
      identityRequest(),
    )) as CtxlaneProviderIdentityLease;

    expect(acquisition.requests).toEqual([REQUEST_FIXTURE]);
    expect(
      Object.hasOwn(acquisition.requests[0] as object, "fencingGeneration"),
    ).toBe(false);
    expect(
      Object.hasOwn(acquisition.requests[0] as object, "policyDigest"),
    ).toBe(false);
    expect(
      Object.hasOwn(acquisition.requests[0] as object, "requestedDurationMs"),
    ).toBe(false);
    expect(lease.fencingGeneration).toBe(41);
    expect(lease.ctxlane.fencingGeneration).toBe(1);
    expect(lease.policyDigest).toBe(RUNMILL_POLICY_DIGEST);
    expect(lease.ctxlane.effectivePolicyDigest).toBe(
      ACTIVE_FIXTURE.effective_policy_digest,
    );
    expect(lease.ctxlane).toMatchObject({
      clientRequestId: REQUEST_FIXTURE.client_request_id,
      tenantId: REQUEST_FIXTURE.tenant_id,
      profileUid: REQUEST_FIXTURE.profile_uid,
      callerSubject: ACTIVE_FIXTURE.caller_subject,
      hostIdentity: ACTIVE_FIXTURE.host_identity,
      repository: REQUEST_FIXTURE.repository,
      status: "active",
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.ctxlane)).toBe(true);
  });

  it.each([
    ["refused lease", REFUSED_FIXTURE, "unchanged"],
    ["automation error", ERROR_FIXTURE, undefined],
  ] as const)(
    "fails closed for the official %s fixture",
    async (_label, response, disposition) => {
      const { broker } = setup({ response });
      let error: unknown;
      try {
        await broker.acquire(identityRequest());
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "RM-AUTH-003" });
      expect((error as Error).message).not.toContain(ACTIVE_FIXTURE.lease_id);
      expect((error as Error).message).not.toContain(
        ACTIVE_FIXTURE.execution_handle,
      );
      expect(identityBrokerFailureDisposition(error)).toBe(disposition);
    },
  );

  it.each([
    [
      "cross-operation automation error",
      {
        ...clone(ERROR_FIXTURE),
        operation: "service-health",
        code: "service-recovering",
        client_request_id: REQUEST_FIXTURE.client_request_id,
      },
    ],
    [
      "foreign client request error",
      {
        ...clone(ERROR_FIXTURE),
        client_request_id: "request_other",
      },
    ],
    [
      "foreign terminal lease",
      { ...clone(REFUSED_FIXTURE), tenant_id: "tenant-other" },
    ],
    [
      "transitional error lease",
      {
        ...clone(ACTIVE_FIXTURE),
        status: "error",
        execution_handle: null,
        reason_code: "service-recovery",
      },
    ],
  ] as const)("keeps %s outcome ambiguous", async (_label, response) => {
    const { broker } = setup({ response });
    let error: unknown;
    try {
      await broker.acquire(identityRequest());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "RM-AUTH-003" });
    expect(identityBrokerFailureDisposition(error)).toBeUndefined();
  });

  it("marks an exactly correlated acquisition error as unchanged", async () => {
    const response = {
      ...clone(ERROR_FIXTURE),
      code: "idempotency-conflict",
      client_request_id: REQUEST_FIXTURE.client_request_id,
    };
    const { broker } = setup({ response });
    let error: unknown;
    try {
      await broker.acquire(identityRequest());
    } catch (caught) {
      error = caught;
    }
    expect(identityBrokerFailureDisposition(error)).toBe("unchanged");
  });

  it.each(["fixer", "retrospective"] as const)(
    "rejects unsupported role %s before authority contact",
    async (role) => {
      const acquisition = new RecordingAcquisitionClient(() =>
        clone(ACTIVE_FIXTURE),
      );
      const { broker } = setup({ acquisition });
      await expect(
        broker.acquire(identityRequest({ role })),
      ).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      expect(acquisition.requests).toHaveLength(0);
    },
  );

  it("rejects a non-integral-second TTL before contact", async () => {
    const acquisition = new RecordingAcquisitionClient(() =>
      clone(ACTIVE_FIXTURE),
    );
    const { broker } = setup({ acquisition });
    await expect(
      broker.acquire(identityRequest({ requestedDurationMs: 1_500 })),
    ).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(acquisition.requests).toHaveLength(0);
  });

  it("refuses a mismatched durable acquisition intent before contact", async () => {
    const authority = acquisitionAuthority({
      intent: {
        ...acquisitionAuthority().intent,
        acquisitionRequest: {
          ...clone(REQUEST_FIXTURE),
          attempt_id: "attempt_other",
        },
      },
    });
    const { acquisition, broker } = setup({ authority });
    await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(acquisition.requests).toHaveLength(0);
  });

  it("binds replay intent to non-coordinate request fields", async () => {
    const authority = acquisitionAuthority({
      intent: {
        ...acquisitionAuthority().intent,
        acquisitionRequest: {
          ...clone(REQUEST_FIXTURE),
          policy_digest: `sha256:${"f".repeat(64)}`,
        },
      },
    });
    const { acquisition, broker } = setup({ authority });

    await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(acquisition.requests).toHaveLength(0);
  });

  it("snapshots mutable caller and authority inputs before adapter awaits", async () => {
    const mutableRequest = identityRequest() as {
      -readonly [Key in keyof IdentityLeaseRequest]: IdentityLeaseRequest[Key];
    };
    const mutableAuthority = acquisitionAuthority() as {
      -readonly [Key in keyof CtxlaneAcquisitionAuthority]: CtxlaneAcquisitionAuthority[Key];
    };
    const acquisition = new RecordingAcquisitionClient((wire) => {
      expect(Object.isFrozen(wire)).toBe(true);
      expect(Object.isFrozen(wire.work_order_authorization)).toBe(true);
      expect(() => {
        (wire as { tenant_id: string }).tenant_id = "tenant-other";
      }).toThrow(TypeError);
      mutableAuthority.expectedCallerSubject = "caller:other";
      return clone(ACTIVE_FIXTURE);
    });
    const lifecycle = new RecordingLifecycleClient();
    const broker = new CtxlaneProviderIdentityBroker({
      client: acquisition,
      lifecycleClient: lifecycle,
      clock: new FakeClock(NOW),
      ownershipFence: new RecordingFence(),
      authority: {
        resolveAcquisitionAuthority: (snapshot) => {
          expect(Object.isFrozen(snapshot)).toBe(true);
          mutableRequest.runId = "run_other";
          return mutableAuthority;
        },
      },
    });

    const lease = await broker.acquire(mutableRequest);

    expect(lease.runId).toBe(REQUEST_FIXTURE.run_id);
    expect(lease.ctxlane?.callerSubject).toBe(ACTIVE_FIXTURE.caller_subject);
  });

  it.each([
    ["profile", { profileRef: "codex:other" }],
    ["signed coordinate", { tenantId: "tenant-other" }],
  ] as const)(
    "refuses an authority %s mismatch before contact",
    async (_label, mutation) => {
      const { acquisition, broker } = setup({
        authority: acquisitionAuthority(mutation),
      });
      await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      expect(acquisition.requests).toHaveLength(0);
    },
  );

  it.each([
    ["caller", { caller_subject: "caller:other" }],
    ["host", { host_identity: "host:other" }],
  ] as const)(
    "rejects a returned %s mismatch without revoking foreign authority",
    async (_label, mutation) => {
      const lifecycle = new RecordingLifecycleClient();
      lifecycle.revokeResponse = ({ lease }) =>
        publishedFromInternal(lease, "revoked");
      const response = {
        ...clone(ACTIVE_FIXTURE),
        ...mutation,
      } as CtxlaneIdentityLease;
      const { broker } = setup({
        lifecycle,
        response,
      });

      await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      expect(lifecycle.revokeRequests).toHaveLength(0);
    },
  );

  it("rejects a returned policy mismatch and retires matching authority", async () => {
    const expectedPolicyDigest = `sha256:${"e".repeat(64)}`;
    const lifecycle = new RecordingLifecycleClient();
    lifecycle.revokeResponse = ({ lease }) =>
      publishedFromInternal(lease, "revoked");
    const response = {
      ...clone(ACTIVE_FIXTURE),
      effective_policy_digest: `sha256:${"d".repeat(64)}`,
    } as CtxlaneIdentityLease;
    const { broker } = setup({
      authority: acquisitionAuthority({
        intent: {
          ...acquisitionAuthority().intent,
          acquisitionRequest: {
            ...clone(REQUEST_FIXTURE),
            policy_digest: expectedPolicyDigest,
          },
        },
        ctxlanePolicyDigest: expectedPolicyDigest,
      }),
      lifecycle,
      response,
    });

    await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(lifecycle.revokeRequests).toHaveLength(1);
  });

  it("requires a complete lifecycle retirement boundary at construction", () => {
    const common = {
      client: new RecordingAcquisitionClient(() => clone(ACTIVE_FIXTURE)),
      clock: new FakeClock(NOW),
      ownershipFence: new RecordingFence(),
      authority: { resolveAcquisitionAuthority: () => acquisitionAuthority() },
    };
    for (const lifecycleClient of [
      {},
      { renew: async () => ACTIVE_FIXTURE },
      { renew: async () => ACTIVE_FIXTURE, close: async () => ACTIVE_FIXTURE },
    ]) {
      expect(
        () =>
          new CtxlaneProviderIdentityBroker({
            ...common,
            lifecycleClient:
              lifecycleClient as unknown as CtxlaneLeaseLifecycleClient,
          }),
      ).toThrow(CtxlaneIdentityProtocolError);
    }
  });
});

describe("CtxlaneProviderIdentityBroker lifecycle", () => {
  it("renews through the in-process boundary with a greater ctxlane generation", async () => {
    const { broker, clock, lease, lifecycle } = await acquireActive();
    clock.advanceMinutes(1);
    lifecycle.renewResponse = ({ lease: current, requestedTtlSeconds }) => {
      expect(requestedTtlSeconds).toBe(900);
      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(current.ctxlane)).toBe(true);
      expect(() => {
        (current.ctxlane as { tenantId: string }).tenantId = "tenant-other";
      }).toThrow(TypeError);
      return publishedFromInternal(current, "active", {
        fencing_generation: 2,
        expires_at: "2026-08-21T10:16:00Z",
      });
    };

    const renewed = (await broker.renew(lease)) as CtxlaneProviderIdentityLease;

    expect(lifecycle.renewRequests).toHaveLength(1);
    expect(lifecycle.renewRequests[0]?.lease.leaseId).toBe(lease.leaseId);
    expect(renewed.leaseId).toBe(lease.leaseId);
    expect(renewed.executionHandle).toBe(lease.executionHandle);
    expect(renewed.fencingGeneration).toBe(41);
    expect(renewed.ctxlane.fencingGeneration).toBe(2);
  });

  it("preserves the original TTL while accepting policy narrowing and a smaller maximum", async () => {
    const { broker, clock, lease, lifecycle } = await acquireActive();
    const narrowedPolicy = `sha256:${"d".repeat(64)}`;
    const furtherNarrowedPolicy = `sha256:${"e".repeat(64)}`;
    lifecycle.renewResponse = ({ lease: current, requestedTtlSeconds }) => {
      expect(requestedTtlSeconds).toBe(900);
      const nextGeneration = (current.ctxlane.fencingGeneration ?? 0) + 1;
      return publishedFromInternal(current, "active", {
        fencing_generation: nextGeneration,
        expires_at:
          nextGeneration === 2
            ? "2026-08-21T10:16:00Z"
            : "2026-08-21T10:17:00Z",
        maximum_expires_at:
          nextGeneration === 2
            ? "2026-08-21T12:00:00Z"
            : "2026-08-21T11:00:00Z",
        effective_policy_digest:
          nextGeneration === 2 ? narrowedPolicy : furtherNarrowedPolicy,
      });
    };

    clock.advanceMinutes(1);
    const first = (await broker.renew(lease)) as CtxlaneProviderIdentityLease;
    clock.advanceMinutes(1);
    const second = (await broker.renew(first)) as CtxlaneProviderIdentityLease;

    expect(
      lifecycle.renewRequests.map((request) => request.requestedTtlSeconds),
    ).toEqual([900, 900]);
    expect(first.ctxlane).toMatchObject({
      requestedTtlSeconds: 900,
      fencingGeneration: 2,
      effectivePolicyDigest: narrowedPolicy,
      maximumExpiresAt: "2026-08-21T12:00:00Z",
    });
    expect(second.ctxlane).toMatchObject({
      requestedTtlSeconds: 900,
      fencingGeneration: 3,
      effectivePolicyDigest: furtherNarrowedPolicy,
      maximumExpiresAt: "2026-08-21T11:00:00Z",
    });
  });

  it.each([
    ["equal generation", { fencing_generation: 1 }],
    [
      "regressed expiry",
      { fencing_generation: 2, expires_at: "2026-08-21T10:14:00Z" },
    ],
  ] as const)(
    "rejects renewal with %s and revokes returned authority",
    async (_label, mutation) => {
      const { broker, lease, lifecycle } = await acquireActive();
      lifecycle.renewResponse = ({ lease: current }) =>
        publishedFromInternal(current, "active", mutation);
      lifecycle.revokeResponse = ({ lease: current }) =>
        publishedFromInternal(current, "revoked");

      await expect(broker.renew(lease)).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      expect(lifecycle.revokeRequests).toHaveLength(1);
      expect(lifecycle.revokeRequests[0]?.lease.leaseId).toBe(lease.leaseId);
      expect(lifecycle.revokeRequests[0]?.lease.ctxlane.fencingGeneration).toBe(
        mutation.fencing_generation,
      );
    },
  );

  it("retires an invalid higher-generation renewal at the returned generation", async () => {
    const { broker, lease, lifecycle } = await acquireActive();
    lifecycle.renewResponse = ({ lease: current }) =>
      publishedFromInternal(current, "active", {
        fencing_generation: 2,
        expires_at: "2026-08-21T10:14:00Z",
      });
    lifecycle.revokeResponse = ({ lease: current }) =>
      current.ctxlane.fencingGeneration === 2
        ? publishedFromInternal(current, "revoked")
        : clone(ERROR_FIXTURE);

    await expect(broker.renew(lease)).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(lifecycle.revokeRequests).toHaveLength(1);
    expect(lifecycle.revokeRequests[0]?.lease.ctxlane.fencingGeneration).toBe(
      2,
    );
  });

  it("never revokes a different lease id returned by renewal", async () => {
    const { broker, lease, lifecycle } = await acquireActive();
    const returnedLeaseId = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB9";
    lifecycle.renewResponse = ({ lease: current }) =>
      publishedFromInternal(current, "active", {
        lease_id: returnedLeaseId,
        fencing_generation: 2,
        expires_at: "2026-08-21T10:16:00Z",
      });
    lifecycle.revokeResponse = ({ lease: current }) =>
      publishedFromInternal(current, "revoked");

    await expect(broker.renew(lease)).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(lifecycle.revokeRequests).toHaveLength(1);
    expect(lifecycle.revokeRequests[0]?.lease.leaseId).toBe(lease.leaseId);
    expect(lifecycle.revokeRequests[0]?.lease.leaseId).not.toBe(
      returnedLeaseId,
    );
  });

  it("treats an exactly bound terminal renewal race as definitively retired", async () => {
    const { broker, lease, lifecycle } = await acquireActive();
    lifecycle.renewResponse = ({ lease: current }) =>
      publishedFromInternal(current, "expired");

    let error: unknown;
    try {
      await broker.renew(lease);
    } catch (caught) {
      error = caught;
    }
    expect(identityBrokerFailureDisposition(error)).toBe("retired");
    expect(lifecycle.revokeRequests).toHaveLength(0);
  });

  it.each([
    ["a skipped generation", { fencing_generation: 3 }],
    [
      "an overlong TTL",
      { fencing_generation: 2, expires_at: "2026-08-21T10:17:00Z" },
    ],
  ] as const)(
    "rejects renewal with %s and retires its exact returned generation",
    async (_label, mutation) => {
      const { broker, clock, lease, lifecycle } = await acquireActive();
      clock.advanceMinutes(1);
      lifecycle.renewResponse = ({ lease: current }) =>
        publishedFromInternal(current, "active", {
          expires_at: "2026-08-21T10:16:00Z",
          ...mutation,
        });
      lifecycle.revokeResponse = ({ lease: current }) =>
        publishedFromInternal(current, "revoked");

      let error: unknown;
      try {
        await broker.renew(lease);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "RM-AUTH-003" });
      expect(identityBrokerFailureDisposition(error)).toBe("retired");
      expect(lifecycle.revokeRequests).toHaveLength(1);
      expect(lifecycle.revokeRequests[0]?.lease.ctxlane.fencingGeneration).toBe(
        mutation.fencing_generation,
      );
    },
  );

  it.each([
    ["lease id", { leaseId: "sensitive-lease-capability-0001" }],
    [
      "execution handle",
      { executionHandle: "sensitive-execution-capability-0001" },
    ],
    [
      "maximum expiry",
      {
        ctxlane: {
          maximumExpiresAt: "2026-08-21T10:14:00Z",
        },
      },
    ],
  ] as const)(
    "rejects a corrupt protected %s snapshot before lifecycle contact",
    async (_label, mutation) => {
      const { broker, lease, lifecycle } = await acquireActive();
      const corrupted = structuredClone(lease);
      const candidate =
        "ctxlane" in mutation
          ? {
              ...corrupted,
              ctxlane: { ...corrupted.ctxlane, ...mutation.ctxlane },
            }
          : { ...corrupted, ...mutation };

      await expect(
        broker.renew(candidate as unknown as IdentityLease),
      ).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      expect(lifecycle.renewRequests).toHaveLength(0);
    },
  );

  it.each([
    ["completed", "completed"],
    ["failed", "worker-failed"],
  ] as const)(
    "maps Runmill %s to ctxlane close reason %s",
    async (disposition, reason) => {
      const { broker, lease, lifecycle } = await acquireActive();
      lifecycle.closeResponse = (request) =>
        publishedFromInternal(request.lease, "closed", { reason_code: reason });

      await broker.close(lease, disposition);

      expect(lifecycle.closeRequests).toHaveLength(1);
      expect(lifecycle.closeRequests[0]?.disposition).toBe(reason);
      expect(lifecycle.revokeRequests).toHaveLength(0);
    },
  );

  it.each([
    ["revoked", "operator-revoked"],
    ["closed with another reason", "worker-failed"],
  ] as const)(
    "treats close race ending %s as definitively retired",
    async (_label, reason) => {
      const { broker, lease, lifecycle } = await acquireActive();
      lifecycle.closeResponse = ({ lease: current }) =>
        reason === "operator-revoked"
          ? publishedFromInternal(current, "revoked")
          : publishedFromInternal(current, "closed", { reason_code: reason });

      let error: unknown;
      try {
        await broker.close(lease, "completed");
      } catch (caught) {
        error = caught;
      }
      expect(identityBrokerFailureDisposition(error)).toBe("retired");
    },
  );

  it.each(["cancelled", "refused"] as const)(
    "routes Runmill %s retirement through revoke",
    async (disposition) => {
      const { broker, lease, lifecycle } = await acquireActive();
      lifecycle.revokeResponse = ({ lease: current }) =>
        publishedFromInternal(current, "revoked");

      await broker.close(lease, disposition);

      expect(lifecycle.closeRequests).toHaveLength(0);
      expect(lifecycle.revokeRequests[0]?.reason).toBe(
        `runmill-${disposition}`,
      );
    },
  );

  it("requires a published revoked lease and keeps capabilities out of reasons", async () => {
    const { broker, lease, lifecycle } = await acquireActive();
    for (const capability of [lease.leaseId, lease.executionHandle]) {
      await expect(
        broker.revoke(lease, `failure referenced ${capability}`),
      ).rejects.toMatchObject({ code: "RM-AUTH-003" });
    }
    expect(lifecycle.revokeRequests).toHaveLength(0);

    lifecycle.revokeResponse = ({ lease: current }) =>
      publishedFromInternal(current, "revoked");
    await broker.revoke(lease, "operator cancellation");
    expect(lifecycle.revokeRequests).toHaveLength(1);
  });

  it("revokes a lease when the Runmill ownership fence changes during acquisition", async () => {
    const fence = new RecordingFence();
    fence.values = [true, false];
    const lifecycle = new RecordingLifecycleClient();
    lifecycle.revokeResponse = ({ lease }) =>
      publishedFromInternal(lease, "revoked");
    const { broker } = setup({ fence, lifecycle });

    await expect(broker.acquire(identityRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(lifecycle.revokeRequests).toHaveLength(1);
    expect(
      fence.observations.map((observation) => observation.fencingGeneration),
    ).toEqual([41, 41]);
  });

  it("reports fence loss with unresolved revocation when cleanup fails", async () => {
    const fence = new RecordingFence();
    fence.values = [true, false];
    const lifecycle = new RecordingLifecycleClient();
    lifecycle.revokeResponse = () => {
      throw new Error("protected remote detail");
    };
    const { broker } = setup({ fence, lifecycle });

    let error: unknown;
    try {
      await broker.acquire(identityRequest());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "RM-AUTH-003" });
    expect((error as Error).message).not.toContain("protected remote detail");
  });

  it("bounds and aborts a hanging acquisition client", async () => {
    vi.useFakeTimers();
    const acquisition = new RecordingAcquisitionClient(
      async () => await new Promise<never>(() => undefined),
    );
    const { broker } = setup({ acquisition, requestTimeoutMs: 25 });

    const pending = broker.acquire(identityRequest());
    const refusal = expect(pending).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    await vi.advanceTimersByTimeAsync(25);
    await refusal;
    expect(acquisition.signals[0]?.aborted).toBe(true);
  });
});

describe("strictJsonDecode", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    '{"a":1,"a":2}',
    '{"nested":{"a":1,"a":2}}',
    '{"a":1,"\\u0061":2}',
    '{"a":',
    "[1,]",
  ])("rejects ambiguous or malformed JSON", (text) => {
    expect(() => strictJsonDecode(text)).toThrow();
  });

  it("materializes __proto__ as an own key on a null-prototype object", () => {
    const decoded = strictJsonDecode(
      '{"__proto__":{"polluted":true},"safe":1}',
    );
    expect(typeof decoded).toBe("object");
    expect(decoded).not.toBeNull();
    const record = decoded as Record<string, unknown>;
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("parses nested arrays without losing an element", () => {
    expect(strictJsonDecode('[1,true,null,{"value":[2,3]}]')).toEqual([
      1,
      true,
      null,
      { value: [2, 3] },
    ]);
  });
});
