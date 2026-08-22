import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import type {
  IdentityLease,
  IdentityLeaseRequest,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import {
  CTXLANE_AUTOMATION_REQUEST_SCHEMA,
  CTXLANE_AUTOMATION_RESPONSE_SCHEMA,
  CTXLANE_IDENTITY_LEASE_SCHEMA,
  CtxlaneIdentityProtocolError,
  CtxlaneProviderIdentityBroker,
  CtxlaneUnixAutomationClient,
  ctxlaneAutomationRequestId,
  type CtxlaneAutomationIdentityClient,
  type CtxlaneAutomationRequest,
} from "../../src/identity/ctxlane-broker.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";
const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;
const LEASE_ID = "protected-ctxlane-lease-0001";
const EXECUTION_HANDLE = "protected-ctxlane-execution-handle-0001";

function leaseRequest(overrides: Partial<IdentityLeaseRequest> = {}): IdentityLeaseRequest {
  return {
    runId: "run-01",
    workOrderId: "wo-01",
    attemptId: "attempt-01",
    role: "implementer",
    requestedProfile: "codex:asf-production",
    policyDigest: POLICY_DIGEST,
    fencingGeneration: 7,
    requestedDurationMs: 60_000,
    ...overrides,
  };
}

function directAcquireRequest(
  payloadOverrides: Record<string, unknown> = {},
): CtxlaneAutomationRequest {
  const payload = {
    schema: "ctxlane.identity-lease-request/v1",
    run_id: "run-01",
    work_order_id: "wo-01",
    attempt_id: "attempt-01",
    role: "implementer",
    requested_profile: "codex:asf-production",
    policy_digest: POLICY_DIGEST,
    fencing_generation: 7,
    requested_duration_ms: 60_000,
    ...payloadOverrides,
  } as const;
  return {
    schema: CTXLANE_AUTOMATION_REQUEST_SCHEMA,
    request_id: ctxlaneAutomationRequestId("acquire", payload),
    operation: "acquire",
    payload,
  };
}

function directRevokeRequest(
  payloadOverrides: Record<string, unknown> = {},
): CtxlaneAutomationRequest {
  const payload = {
    schema: "ctxlane.identity-lease-revocation/v1",
    lease_id: LEASE_ID,
    lease_id_digest: sha256Digest({ lease_id: LEASE_ID }),
    run_id: "run-01",
    work_order_id: "wo-01",
    attempt_id: "attempt-01",
    role: "implementer",
    policy_digest: POLICY_DIGEST,
    provider: "openai",
    principal: "ctxlane-principal-01",
    profile: "codex:asf-production",
    fencing_generation: 7,
    reason: "test cancellation",
    ...payloadOverrides,
  } as const;
  return {
    schema: CTXLANE_AUTOMATION_REQUEST_SCHEMA,
    request_id: ctxlaneAutomationRequestId("revoke", payload),
    operation: "revoke",
    payload,
  };
}

function wireLease(
  request: IdentityLeaseRequest = leaseRequest(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: CTXLANE_IDENTITY_LEASE_SCHEMA,
    lease_id: LEASE_ID,
    execution_handle: EXECUTION_HANDLE,
    run_id: request.runId,
    work_order_id: request.workOrderId,
    attempt_id: request.attemptId,
    role: request.role,
    policy_digest: request.policyDigest,
    provider: "openai",
    principal: "ctxlane-principal-01",
    profile: request.requestedProfile,
    issued_at: NOW,
    expires_at: "2026-08-21T10:01:00.000Z",
    fencing_generation: request.fencingGeneration,
    ...overrides,
  };
}

function success(request: CtxlaneAutomationRequest, result: unknown): unknown {
  return {
    schema: CTXLANE_AUTOMATION_RESPONSE_SCHEMA,
    request_id: request.request_id,
    ok: true,
    result,
  };
}

class RecordingClient implements CtxlaneAutomationIdentityClient {
  readonly requests: CtxlaneAutomationRequest[] = [];

  constructor(
    readonly respond: (request: CtxlaneAutomationRequest) => unknown | Promise<unknown>,
  ) {}

  async request(request: CtxlaneAutomationRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    return this.respond(request);
  }
}

class Fence implements IdentityOwnershipFenceValidator {
  readonly observations: IdentityOwnershipFence[] = [];
  values: boolean[] = [true];

  isCurrent(fence: IdentityOwnershipFence): boolean {
    this.observations.push(fence);
    return this.values.shift() ?? true;
  }
}

function broker(
  client: CtxlaneAutomationIdentityClient,
  fence = new Fence(),
  clock = new FakeClock(NOW),
  requestTimeoutMs?: number,
) {
  return {
    fence,
    broker: new CtxlaneProviderIdentityBroker({
      client,
      clock,
      ownershipFence: fence,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    }),
  };
}

function dispositionResult(
  request: CtxlaneAutomationRequest,
  disposition: string,
): unknown {
  return success(request, {
    lease_id_digest: request.payload["lease_id_digest"],
    disposition,
  });
}

describe("CtxlaneProviderIdentityBroker", () => {
  it("acquires a strict, fenced lease through an idempotent trusted request", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => success(request, wireLease(input)));
    const { broker: identity, fence } = broker(client);

    const lease = await identity.acquire(input);

    expect(lease).toMatchObject({
      leaseId: LEASE_ID,
      executionHandle: EXECUTION_HANDLE,
      runId: input.runId,
      workOrderId: input.workOrderId,
      attemptId: input.attemptId,
      role: "implementer",
      policyDigest: POLICY_DIGEST,
      profile: "codex:asf-production",
      fencingGeneration: 7,
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(fence.observations).toEqual([
      {
        runId: "run-01",
        workOrderId: "wo-01",
        attemptId: "attempt-01",
        fencingGeneration: 7,
      },
      {
        runId: "run-01",
        workOrderId: "wo-01",
        attemptId: "attempt-01",
        fencingGeneration: 7,
      },
    ]);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      operation: "acquire",
      payload: {
        run_id: "run-01",
        requested_profile: "codex:asf-production",
        requested_duration_ms: 60_000,
      },
    });
    const sent = client.requests[0];
    if (sent === undefined) throw new Error("ctxlane request was not recorded");
    expect(sent.request_id).toBe(
      ctxlaneAutomationRequestId("acquire", sent.payload),
    );
    expect(JSON.stringify(sent.payload)).not.toContain(EXECUTION_HANDLE);
  });

  it("does not contact ctxlane when the durable ownership fence is missing or unknown", async () => {
    const client = new RecordingClient((request) => success(request, wireLease()));
    const fence = new Fence();
    fence.values = [false];
    const identity = broker(client, fence).broker;

    await expect(identity.acquire(leaseRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    expect(client.requests).toHaveLength(0);
  });

  it.each([
    ["run", { run_id: "run-other" }],
    ["work order", { work_order_id: "wo-other" }],
    ["attempt", { attempt_id: "attempt-other" }],
    ["role", { role: "local-reviewer" }],
    ["policy", { policy_digest: `sha256:${"b".repeat(64)}` }],
    ["profile", { profile: "claude:asf-review" }],
    ["generation", { fencing_generation: 8 }],
    ["expired", { expires_at: "2026-08-21T09:59:59.000Z" }],
    ["overlong", { expires_at: "2026-08-21T10:02:00.000Z" }],
  ] as const)("refuses a %s mismatch without exposing protected values", async (_label, mutation) => {
    const input = leaseRequest();
    const client = new RecordingClient((request) =>
      success(request, wireLease(input, mutation)),
    );
    const identity = broker(client).broker;

    let error: unknown;
    try {
      await identity.acquire(input);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe("RM-AUTH-003");
    expect((error as Error).message).not.toContain(LEASE_ID);
    expect((error as Error).message).not.toContain(EXECUTION_HANDLE);
  });

  it("revokes the returned lease if ownership changes during acquisition", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") return success(request, wireLease(input));
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const fence = new Fence();
    fence.values = [true, false];
    const identity = broker(client, fence).broker;

    await expect(identity.acquire(input)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire", "revoke"]);
    expect(client.requests[1]?.payload).toMatchObject({
      lease_id: LEASE_ID,
      reason: "fencing generation changed during identity acquisition",
    });
  });

  it("revokes a well-formed lease whose authority bindings do not match", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") {
        return success(request, wireLease(input, { profile: "unexpected-profile" }));
      }
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const identity = broker(client).broker;

    await expect(identity.acquire(input)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire", "revoke"]);
    expect(client.requests[1]?.payload["reason"]).toBe(
      "ctxlane returned an invalid identity acquisition binding",
    );
  });

  it("renews only the same principal/profile and a bounded lease duration", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") return success(request, wireLease(input));
      if (request.operation === "renew") {
        return success(
          request,
          wireLease(input, {
            lease_id: "protected-ctxlane-lease-0002",
            execution_handle: "protected-ctxlane-execution-handle-0002",
            issued_at: "2026-08-21T10:00:30.000Z",
            expires_at: "2026-08-21T10:01:30.000Z",
          }),
        );
      }
      throw new Error("unexpected operation");
    });
    const identity = broker(client).broker;
    const original = await identity.acquire(input);
    const renewed = await identity.renew(original);

    expect(renewed.leaseId).not.toBe(original.leaseId);
    expect(renewed.principal).toBe(original.principal);
    expect(client.requests[1]).toMatchObject({
      operation: "renew",
      payload: {
        lease_id: LEASE_ID,
        run_id: "run-01",
        work_order_id: "wo-01",
        attempt_id: "attempt-01",
        role: "implementer",
        policy_digest: POLICY_DIGEST,
        provider: "openai",
        principal: "ctxlane-principal-01",
        profile: "codex:asf-production",
        requested_duration_ms: 60_000,
        fencing_generation: 7,
      },
    });
  });

  it("closes and revokes exact leases idempotently without requiring stale ownership", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") return success(request, wireLease(input));
      if (request.operation === "close") return dispositionResult(request, "completed");
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const fence = new Fence();
    const identity = broker(client, fence).broker;
    const lease = await identity.acquire(input);
    fence.values = [false];

    await identity.close(lease, "completed");
    await identity.revoke(lease, "forced cancellation");

    expect(client.requests.map((request) => request.operation)).toEqual([
      "acquire",
      "close",
      "revoke",
    ]);
    expect(client.requests[1]?.payload["lease_id_digest"]).toBe(
      sha256Digest({ lease_id: LEASE_ID }),
    );
    expect(client.requests[1]?.payload).toMatchObject({
      run_id: "run-01",
      work_order_id: "wo-01",
      attempt_id: "attempt-01",
      role: "implementer",
      policy_digest: POLICY_DIGEST,
      provider: "openai",
      principal: "ctxlane-principal-01",
      profile: "codex:asf-production",
      fencing_generation: 7,
    });
    expect(client.requests[2]?.payload).toMatchObject({
      run_id: "run-01",
      work_order_id: "wo-01",
      attempt_id: "attempt-01",
      role: "implementer",
      policy_digest: POLICY_DIGEST,
      provider: "openai",
      principal: "ctxlane-principal-01",
      profile: "codex:asf-production",
      fencing_generation: 7,
    });
    expect(fence.observations).toHaveLength(2);
  });

  it("runtime-validates caller objects before observing authority or contacting ctxlane", async () => {
    const client = new RecordingClient((request) => success(request, wireLease()));
    const { broker: identity, fence } = broker(client);

    await expect(
      identity.acquire(null as unknown as IdentityLeaseRequest),
    ).rejects.toMatchObject({ code: "RM-AUTH-003" });
    await expect(
      identity.acquire({ ...leaseRequest(), extra: true } as IdentityLeaseRequest),
    ).rejects.toMatchObject({ code: "RM-AUTH-003" });
    await expect(identity.renew(null as unknown as IdentityLease)).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
    await expect(
      identity.revoke(wireLease() as unknown as IdentityLease, null as unknown as string),
    ).rejects.toMatchObject({ code: "RM-AUTH-003" });

    expect(fence.observations).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
  });

  it("refuses expired and overlong forged leases before observing the fence", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => success(request, wireLease(input)));
    const clock = new FakeClock(NOW);
    const { broker: identity, fence } = broker(client, new Fence(), clock);
    const lease = await identity.acquire(input);
    const observationsAfterAcquire = fence.observations.length;

    const overlong = {
      ...lease,
      expiresAt: "2026-08-23T10:00:00.000Z",
    } as IdentityLease;
    await expect(identity.renew(overlong)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    clock.advanceMinutes(2);
    await expect(identity.renew(lease)).rejects.toMatchObject({ code: "RM-AUTH-003" });

    expect(fence.observations).toHaveLength(observationsAfterAcquire);
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire"]);
  });

  it("fails renewal on a stale fence before contacting ctxlane", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => success(request, wireLease(input)));
    const fence = new Fence();
    const identity = broker(client, fence).broker;
    const lease = await identity.acquire(input);
    fence.values = [false];

    await expect(identity.renew(lease)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire"]);
  });

  it("revokes a renewed lease if the fence changes during renewal", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") return success(request, wireLease(input));
      if (request.operation === "renew") {
        return success(
          request,
          wireLease(input, {
            lease_id: "protected-ctxlane-lease-0002",
            execution_handle: "protected-ctxlane-execution-handle-0002",
          }),
        );
      }
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const fence = new Fence();
    const identity = broker(client, fence).broker;
    const lease = await identity.acquire(input);
    fence.values = [true, false];

    await expect(identity.renew(lease)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(client.requests.map((request) => request.operation)).toEqual([
      "acquire",
      "renew",
      "revoke",
    ]);
  });

  it("revokes a renewal that regresses the lease expiry", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") return success(request, wireLease(input));
      if (request.operation === "renew") {
        return success(
          request,
          wireLease(input, {
            lease_id: "protected-ctxlane-lease-0002",
            execution_handle: "protected-ctxlane-execution-handle-0002",
            expires_at: "2026-08-21T10:00:45.000Z",
          }),
        );
      }
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const identity = broker(client).broker;
    const lease = await identity.acquire(input);

    await expect(identity.renew(lease)).rejects.toMatchObject({ code: "RM-AUTH-003" });
    expect(client.requests.map((request) => request.operation)).toEqual([
      "acquire",
      "renew",
      "revoke",
    ]);
  });

  it("revokes a strict-invalid returned capability only within the requested work attempt", async () => {
    const input = leaseRequest();
    const protectedRemoteDetail = "protected-remote-extra-0001";
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") {
        return success(request, wireLease(input, { unexpected: protectedRemoteDetail }));
      }
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const identity = broker(client).broker;

    let error: unknown;
    try {
      await identity.acquire(input);
    } catch (caught) {
      error = caught;
    }

    expect(client.requests.map((request) => request.operation)).toEqual(["acquire", "revoke"]);
    expect(client.requests[1]?.payload).toMatchObject({
      lease_id: LEASE_ID,
      run_id: input.runId,
      work_order_id: input.workOrderId,
      attempt_id: input.attemptId,
    });
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as Error).message).not.toContain(protectedRemoteDetail);
    expect((error as Error).message).not.toContain(LEASE_ID);
  });

  it.each([
    ["capability namespace collision", { execution_handle: LEASE_ID }],
    ["capability in public attribution", { principal: EXECUTION_HANDLE }],
  ])("revokes a lease with a %s before exposing it", async (_label, mutation) => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => {
      if (request.operation === "acquire") {
        return success(request, wireLease(input, mutation));
      }
      if (request.operation === "revoke") return dispositionResult(request, "revoked");
      throw new Error("unexpected operation");
    });
    const identity = broker(client).broker;

    let error: unknown;
    try {
      await identity.acquire(input);
    } catch (caught) {
      error = caught;
    }

    expect(client.requests.map((request) => request.operation)).toEqual(["acquire", "revoke"]);
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as Error).message).not.toContain(LEASE_ID);
    expect((error as Error).message).not.toContain(EXECUTION_HANDLE);
  });

  it("does not revoke a malformed capability attributed to another run", async () => {
    const client = new RecordingClient((request) =>
      success(request, wireLease(leaseRequest(), { run_id: "run-other", unexpected: true })),
    );
    const identity = broker(client).broker;

    await expect(identity.acquire(leaseRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
      runId: "run-01",
    });
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire"]);
  });

  it("bounds a hanging injected client and actively aborts it", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const client: CtxlaneAutomationIdentityClient = {
      request: async (_request, signal) => {
        observedSignal = signal;
        return await new Promise<never>(() => undefined);
      },
    };
    const identity = broker(client, new Fence(), new FakeClock(NOW), 25).broker;

    const pending = identity.acquire(leaseRequest());
    const refusal = expect(pending).rejects.toMatchObject({ code: "RM-AUTH-003" });
    await vi.advanceTimersByTimeAsync(25);
    await refusal;

    expect(observedSignal?.aborted).toBe(true);
  });

  it("refuses to put either sensitive capability into a revocation reason", async () => {
    const input = leaseRequest();
    const client = new RecordingClient((request) => success(request, wireLease(input)));
    const identity = broker(client).broker;
    const lease = await identity.acquire(input);

    for (const capability of [lease.leaseId, lease.executionHandle]) {
      let error: unknown;
      try {
        await identity.revoke(lease, `provider failure referenced ${capability}`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RunmillError);
      expect((error as Error).message).not.toContain(capability);
    }
    expect(client.requests.map((request) => request.operation)).toEqual(["acquire"]);
  });

  it("rejects unsafe timeout and clock-skew configurations", () => {
    const client = new RecordingClient((request) => success(request, wireLease()));
    const common = {
      client,
      clock: new FakeClock(NOW),
      ownershipFence: new Fence(),
    };

    expect(
      () => new CtxlaneProviderIdentityBroker({ ...common, requestTimeoutMs: 30_001 }),
    ).toThrow(CtxlaneIdentityProtocolError);
    expect(
      () => new CtxlaneProviderIdentityBroker({ ...common, maximumClockSkewMs: 30_001 }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });

  it("fails closed without reflecting a remote refusal code or hostile response getter", async () => {
    const protectedRemoteDetail = "PROTECTED_CTXLANE_EXECUTION_HANDLE_0001";
    const refusalClient = new RecordingClient((request) => ({
      schema: CTXLANE_AUTOMATION_RESPONSE_SCHEMA,
      request_id: request.request_id,
      ok: false,
      error: { code: protectedRemoteDetail, retryable: false },
    }));
    const hostileClient = new RecordingClient(() => {
      const response: Record<string, unknown> = {};
      Object.defineProperty(response, "schema", {
        enumerable: true,
        get: () => {
          throw new Error(EXECUTION_HANDLE);
        },
      });
      return response;
    });

    for (const client of [refusalClient, hostileClient]) {
      let error: unknown;
      try {
        await broker(client).broker.acquire(leaseRequest());
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RunmillError);
      expect((error as Error).message).not.toContain(protectedRemoteDetail);
      expect((error as Error).message).not.toContain(EXECUTION_HANDLE);
    }
  });

  it("never retries an ambiguous transport outcome or reflects its error text", async () => {
    const client = new RecordingClient(() => {
      throw new Error(`remote said ${EXECUTION_HANDLE}`);
    });
    const identity = broker(client).broker;

    let error: unknown;
    try {
      await identity.acquire(leaseRequest());
    } catch (caught) {
      error = caught;
    }

    expect(client.requests).toHaveLength(1);
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as Error).message).not.toContain(EXECUTION_HANDLE);
  });

  it("refuses a response correlated to another request", async () => {
    const client = new RecordingClient((request) => ({
      ...(success(request, wireLease()) as Record<string, unknown>),
      request_id: `sha256:${"f".repeat(64)}`,
    }));
    const identity = broker(client).broker;

    await expect(identity.acquire(leaseRequest())).rejects.toMatchObject({
      code: "RM-AUTH-003",
    });
  });
});

const cleanup: Array<{ server: Server; directory: string }> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const item of cleanup.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function unixFixture(
  respond: (request: CtxlaneAutomationRequest, socket: Socket) => unknown,
  timeoutMs = 5_000,
): Promise<{
  client: CtxlaneUnixAutomationClient;
  directory: string;
  socketPath: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "runmill-ctxlane-"));
  const socketPath = join(directory, "automation.sock");
  const server = createServer((socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(body.slice(0, newline)) as CtxlaneAutomationRequest;
      const result = respond(request, socket);
      if (result === undefined) return;
      if (Buffer.isBuffer(result)) {
        socket.end(result);
        return;
      }
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  cleanup.push({ server, directory });
  return {
    directory,
    socketPath,
    client: new CtxlaneUnixAutomationClient({
      endpoint: `unix://${socketPath}`,
      timeoutMs,
    }),
  };
}

describe("CtxlaneUnixAutomationClient", () => {
  it("uses one bounded request over a privately owned Unix socket", async () => {
    const fixture = await unixFixture((request) => success(request, { observed: true }));
    const request = directAcquireRequest();

    await expect(fixture.client.request(request)).resolves.toEqual(
      success(request, { observed: true }),
    );
  });

  it("refuses a group/world-writable control socket before sending authority", async () => {
    const fixture = await unixFixture((request) => success(request, {}));
    chmodSync(fixture.socketPath, 0o666);

    await expect(fixture.client.request(directAcquireRequest())).rejects.toBeInstanceOf(
      CtxlaneIdentityProtocolError,
    );
  });

  it("refuses an immediately writable socket directory before sending authority", async () => {
    let observedRequests = 0;
    const fixture = await unixFixture((request) => {
      observedRequests += 1;
      return success(request, {});
    });
    chmodSync(fixture.directory, 0o777);

    await expect(
      fixture.client.request(directAcquireRequest()),
    ).rejects.toBeInstanceOf(CtxlaneIdentityProtocolError);
    expect(observedRequests).toBe(0);
  });

  it("runtime-validates the exact request and deterministic request id before connecting", async () => {
    let observedRequests = 0;
    const fixture = await unixFixture((request) => {
      observedRequests += 1;
      return success(request, {});
    });
    const valid = directAcquireRequest();
    const malformed = [
      null,
      { ...valid, request_id: `sha256:${"f".repeat(64)}` },
      { ...valid, unexpected: true },
      { ...valid, payload: { ...valid.payload, unexpected: true } },
      { ...valid, operation: "execute" },
      { ...valid, payload: { ...valid.payload, requested_duration_ms: 0 } },
      directRevokeRequest({ lease_id_digest: `sha256:${"f".repeat(64)}` }),
    ];

    for (const request of malformed) {
      await expect(
        fixture.client.request(request as CtxlaneAutomationRequest),
      ).rejects.toBeInstanceOf(CtxlaneIdentityProtocolError);
    }
    expect(observedRequests).toBe(0);
  });

  it("rejects invalid UTF-8 without reflecting remote bytes", async () => {
    const fixture = await unixFixture(() => Buffer.from([0x7b, 0x22, 0x80, 0x0a]));

    await expect(
      fixture.client.request(directAcquireRequest()),
    ).rejects.toMatchObject({ message: "ctxlane returned invalid UTF-8" });
  });

  it("enforces an absolute deadline even while the peer trickles data", async () => {
    const fixture = await unixFixture((_request, socket) => {
      const interval = setInterval(() => socket.write(" "), 5);
      // The client intentionally destroys this connection at its absolute
      // deadline, so a server-side EPIPE is the expected end of the fixture.
      socket.once("error", () => clearInterval(interval));
      socket.once("close", () => clearInterval(interval));
      return undefined;
    }, 40);

    await expect(
      fixture.client.request(directAcquireRequest()),
    ).rejects.toMatchObject({ message: "ctxlane request timed out" });
  });

  it("rejects non-Unix and credential-bearing endpoint forms", () => {
    for (const endpoint of [
      "https://ctxlane.example",
      "unix://relative.sock",
      "unix:///run/ctxlane.sock?token=secret",
      "unix://user@/run/ctxlane.sock",
    ]) {
      expect(() => new CtxlaneUnixAutomationClient({ endpoint })).toThrow(
        CtxlaneIdentityProtocolError,
      );
    }
    expect(
      () =>
        new CtxlaneUnixAutomationClient({
          endpoint: "unix:///run/ctxlane.sock",
          timeoutMs: 30_001,
        }),
    ).toThrow(CtxlaneIdentityProtocolError);
  });
});
