import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASF_MODEL_REQUEST_SCHEMA,
  ASF_PROVIDER_REQUEST_SCHEMA,
  TrustedProviderHarness,
  type AsfProviderRequest,
  type ProviderRepositoryAuthority,
  type TrustedProviderTransport,
  type TrustedProviderTransportInput,
  type TrustedProviderTransportResult,
} from "../../src/agent/trusted-harness.js";
import {
  RepositoryToolGateway,
  type CredentialFreeProductionSandbox,
} from "../../src/agent/tool-gateway.js";
import type {
  IdentityLease,
  IdentityLeaseRequest,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import type { CtxlaneAcquisitionAuthority } from "../../src/identity/ctxlane-authority.js";
import {
  CtxlaneAuthenticatedMcpLifecycleClient,
  CtxlaneProviderIdentityBroker,
  type CtxlaneIdentityLeaseAcquisitionClient,
  type CtxlaneIdentityLeaseLifecyclePrivateRequest,
} from "../../src/identity/ctxlane-broker.js";
import {
  ctxlaneIdentityLeaseInspectSchema,
  ctxlaneIdentityLeaseRequestSchema,
  parseCtxlaneIdentityLeaseLifecyclePrivateRequest,
  type CtxlaneIdentityLease,
  type CtxlaneIdentityLeaseInspect,
  type CtxlaneIdentityLeaseLifecyclePrivateResponse,
  type CtxlaneIdentityLeaseRequest,
  type CtxlaneLeaseView,
} from "../../src/identity/ctxlane-contracts.js";
import type { CtxlanePrivateLifecycleExchange } from "../../src/identity/ctxlane-private-lifecycle.js";
import type { SandboxResult } from "../../src/workspace/sandbox.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const FIXTURE_DIRECTORY = join(__dirname, "..", "fixtures", "ctxlane", "examples");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), "utf8")) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const REQUEST = fixture<CtxlaneIdentityLeaseRequest>(
  "identity-lease-request.v1.json",
);
const ACTIVE = fixture<CtxlaneIdentityLease>("identity-lease-active.v1.json");
const NOW = "2026-08-21T10:00:00.000Z";
const EXECUTION_AT = "2026-08-21T10:01:00.000Z";
const RUNMILL_POLICY_DIGEST = `sha256:${"c".repeat(64)}`;
const CANDIDATE = "d".repeat(40);

function identityRequest(): IdentityLeaseRequest {
  return {
    runId: REQUEST.run_id,
    workOrderId: REQUEST.work_order_id,
    attemptId: REQUEST.attempt_id,
    role: REQUEST.role,
    requestedProfile: REQUEST.profile_ref,
    policyDigest: RUNMILL_POLICY_DIGEST,
    fencingGeneration: 41,
    requestedDurationMs: REQUEST.requested_ttl_seconds * 1_000,
  };
}

function authority(): CtxlaneAcquisitionAuthority {
  return {
    intent: {
      clientRequestId: REQUEST.client_request_id,
      acquisitionRequest: clone(REQUEST),
      expectedCallerSubject: ACTIVE.caller_subject,
      expectedHostIdentity: ACTIVE.host_identity,
    },
    clientRequestId: REQUEST.client_request_id,
    tenantId: REQUEST.tenant_id,
    workOrderDigest: REQUEST.work_order_digest,
    workOrderAuthorization: clone(REQUEST.work_order_authorization),
    provider: REQUEST.provider,
    profileUid: REQUEST.profile_uid,
    profileRef: REQUEST.profile_ref,
    repository: REQUEST.repository,
    workspaceId: REQUEST.workspace_id,
    environment: REQUEST.environment,
    expectedCallerSubject: ACTIVE.caller_subject,
    expectedHostIdentity: ACTIVE.host_identity,
    ctxlanePolicyDigest: REQUEST.policy_digest,
  };
}

function viewFor(lease: CtxlaneIdentityLease): CtxlaneLeaseView {
  const {
    execution_handle: _executionHandle,
    fencing_generation: _fencingGeneration,
    ...view
  } = clone(lease);
  return { ...view, schema: "ctxlane.lease-view/v1" };
}

function errorFor(
  operation: "lease-renew" | "lease-revoke" | "lease-close",
  clientRequestId: string,
  leaseId: string,
): CtxlaneIdentityLeaseLifecyclePrivateResponse {
  return {
    schema: "ctxlane.identity-lease-lifecycle-private/v1",
    operation: operation === "lease-renew"
      ? "renew"
      : operation === "lease-revoke"
        ? "revoke"
        : "close",
    client_request_id: clientRequestId,
    result: {
      kind: "error",
      error: {
        schema: "ctxlane.automation-error/v1",
        operation,
        code: "idempotency-conflict",
        client_request_id: clientRequestId,
        lease_id: leaseId,
      },
    },
  };
}

/**
 * Deterministic authenticated-service double.  It models the service's
 * durable operation journal: an exact operation/request replay returns the
 * original response, while reusing the key with changed bytes returns a
 * correlated conflict and never mutates the lease.
 */
class AuthenticatedCtxlaneService
  implements CtxlaneIdentityLeaseAcquisitionClient, CtxlanePrivateLifecycleExchange
{
  readonly privateRequests: CtxlaneIdentityLeaseLifecyclePrivateRequest[] = [];
  readonly inspectRequests: CtxlaneIdentityLeaseInspect[] = [];
  #current: CtxlaneIdentityLease = clone(ACTIVE);
  readonly #journal = new Map<
    string,
    { readonly payload: string; readonly response: CtxlaneIdentityLeaseLifecyclePrivateResponse }
  >();

  async acquire(request: CtxlaneIdentityLeaseRequest): Promise<unknown> {
    const parsed = ctxlaneIdentityLeaseRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("fake service rejected malformed acquisition");
    this.#current = clone(ACTIVE);
    return clone(this.#current);
  }

  async inspect(request: CtxlaneIdentityLeaseInspect): Promise<unknown> {
    const parsed = ctxlaneIdentityLeaseInspectSchema.safeParse(request);
    if (!parsed.success || parsed.data.lease_id !== this.#current.lease_id) {
      throw new Error("fake service rejected unauthenticated or unbound inspection");
    }
    this.inspectRequests.push(clone(parsed.data));
    return viewFor(this.#current);
  }

  async privateLifecycle(
    rawRequest: CtxlaneIdentityLeaseLifecyclePrivateRequest,
  ): Promise<unknown> {
    const request = parseCtxlaneIdentityLeaseLifecyclePrivateRequest(rawRequest);
    this.privateRequests.push(clone(request));
    const key = `${request.operation}:${request.client_request_id}`;
    const payload = JSON.stringify(request);
    const previous = this.#journal.get(key);
    if (previous !== undefined) {
      return previous.payload === payload
        ? clone(previous.response)
        : errorFor(
            request.operation === "renew"
              ? "lease-renew"
              : request.operation === "revoke"
                ? "lease-revoke"
                : "lease-close",
            request.client_request_id,
            request.lease.lease_id,
          );
    }
    if (
      request.lease.caller_subject !== ACTIVE.caller_subject ||
      request.lease.host_identity !== ACTIVE.host_identity ||
      request.lease.lease_id !== this.#current.lease_id ||
      request.lease.status !== this.#current.status ||
      request.lease.fencing_generation !== this.#current.fencing_generation ||
      request.lease.expires_at !== this.#current.expires_at
    ) {
      throw new Error("fake service rejected caller/host or lease binding");
    }

    const next = clone(this.#current);
    if (request.operation === "renew") {
      next.status = "renewing";
      next.fencing_generation = (next.fencing_generation ?? 0) + 1;
      next.expires_at = "2026-08-21T10:16:00Z";
    } else if (request.operation === "close") {
      next.status = "closed";
      next.execution_handle = null;
      next.reason_code = request.reason ?? "completed";
    } else {
      next.status = "revoked";
      next.execution_handle = null;
      next.reason_code = request.reason ?? "operator-revoked";
    }
    const response: CtxlaneIdentityLeaseLifecyclePrivateResponse = {
      schema: "ctxlane.identity-lease-lifecycle-private/v1",
      operation: request.operation,
      client_request_id: request.client_request_id,
      result: { kind: "lease", lease: clone(next) },
    };
    this.#journal.set(key, { payload, response: clone(response) });
    this.#current = next;
    return response;
  }

  currentView(): CtxlaneLeaseView {
    return viewFor(this.#current);
  }
}

class CurrentFence implements IdentityOwnershipFenceValidator {
  async isCurrent(_fence: IdentityOwnershipFence): Promise<boolean> {
    return true;
  }
}

class NoopCredentialFreeSandbox implements CredentialFreeProductionSandbox {
  readonly mechanism = "bubblewrap" as const;
  readonly enforcement = "production-credential-free" as const;

  async execute(_input: {
    readonly sandbox: unknown;
  }): Promise<SandboxResult> {
    return {
      outcome: "exited",
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    };
  }
}

class RecordingProviderTransport implements TrustedProviderTransport {
  executionHandles: string[] = [];

  async execute(input: TrustedProviderTransportInput): Promise<unknown> {
    input.authority.useExecutionHandle((handle) => {
      this.executionHandles.push(handle);
    });
    const result: TrustedProviderTransportResult = {
      status: "success",
      output_digest: `sha256:${"e".repeat(64)}`,
      output_bytes: 0,
      turns: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        tool_calls: 0,
      },
      events: [
        {
          sequence: 1,
          observed_at: EXECUTION_AT,
          event: { type: "session.started" },
        },
        {
          sequence: 2,
          observed_at: EXECUTION_AT,
          event: { type: "session.completed", status: "success" },
        },
      ],
      protected_session_ref: null,
      failure: null,
    };
    return result;
  }
}

function providerRequest(lease: IdentityLease): AsfProviderRequest {
  return {
    schema: ASF_PROVIDER_REQUEST_SCHEMA,
    model_request: {
      schema: ASF_MODEL_REQUEST_SCHEMA,
      request_id: "ctxlane-e2e-provider-request",
      binding: {
        run_id: lease.runId,
        work_order_id: lease.workOrderId,
        attempt_id: lease.attemptId,
        role: lease.role,
        invocation_id: "ctxlane-e2e-invocation",
        policy_digest: lease.policyDigest,
        candidate_sha: CANDIDATE,
        fencing_generation: lease.fencingGeneration,
      },
      provider: lease.provider,
      model: "codex-test-model",
      principal: lease.principal,
      profile: lease.profile,
      task_packet_digest: `sha256:${"a".repeat(64)}`,
      instruction_digest: `sha256:${"b".repeat(64)}`,
      context_digests: [`sha256:${"c".repeat(64)}`],
      allowed_tools: [],
      allowed_check_ids: [],
      limits: {
        timeout_ms: 30_000,
        max_turns: 5,
        max_input_tokens: 1_000,
        max_output_tokens: 1_000,
        max_output_bytes: 4_096,
        max_cost_usd: 1,
        max_events: 10,
        max_tool_calls: 0,
      },
    },
    session: { mode: "fresh" },
  };
}

function repositoryAuthority(): ProviderRepositoryAuthority {
  return {
    invocationId: "ctxlane-e2e-invocation",
    candidateSha: CANDIDATE,
    taskPacketDigest: `sha256:${"a".repeat(64)}`,
    instructionDigest: `sha256:${"b".repeat(64)}`,
    contextDigests: [`sha256:${"c".repeat(64)}`],
    model: "codex-test-model",
    workspaceRoot: "/tmp/runmill-ctxlane-e2e",
    pathScope: { allowedPaths: [], forbiddenPaths: [] },
    allowedTools: [],
    allowedCheckIds: [],
    toolResourceLimits: {
      cpuMillis: 1_000,
      memoryMib: 128,
      processes: 1,
      fileSizeBytes: 4_096,
      wallTimeMs: 30_000,
      maxOutputBytes: 4_096,
    },
    freshCandidate: true,
  };
}

function brokerFor(
  service: AuthenticatedCtxlaneService,
  clock: FakeClock,
): { broker: CtxlaneProviderIdentityBroker; lifecycle: CtxlaneAuthenticatedMcpLifecycleClient } {
  const lifecycle = new CtxlaneAuthenticatedMcpLifecycleClient(service);
  const broker = new CtxlaneProviderIdentityBroker({
    client: service,
    lifecycleClient: lifecycle,
    clock,
    ownershipFence: new CurrentFence(),
    authority: {
      resolveAcquisitionAuthority: () => authority(),
    },
  });
  return { broker, lifecycle };
}

describe("authenticated local ctxlane MCP lifecycle", () => {
  it("acquires, inspects, renews, execution-admits, closes, and enforces journal replay/conflict", async () => {
    const clock = new FakeClock(NOW);
    const service = new AuthenticatedCtxlaneService();
    const { broker, lifecycle } = brokerFor(service, clock);

    const lease = await broker.acquire(identityRequest());
    const inspected = await lifecycle.inspect({
      client_request_id: REQUEST.client_request_id,
      lease_id: ACTIVE.lease_id,
    });
    expect(inspected).toEqual(service.currentView());
    expect("execution_handle" in inspected).toBe(false);
    expect("fencing_generation" in inspected).toBe(false);

    clock.advanceMinutes(1);
    const renewed = await broker.renew(lease);
    expect(renewed.ctxlane?.fencingGeneration).toBe(2);
    expect(renewed.executionHandle).toBe(lease.executionHandle);

    // The execution admission boundary consumes the protected lease and
    // proves the private handle is available only to the trusted transport.
    const transport = new RecordingProviderTransport();
    const harness = new TrustedProviderHarness({
      backend: "host-credential-harness",
      providerCredential: "test-only-host-credential",
      sessionProtectionKey: "test-only-session-protection-key",
      clock,
      fenceValidator: new CurrentFence(),
      transport,
      toolGateway: new RepositoryToolGateway({
        clock,
        fenceValidator: new CurrentFence(),
        sandbox: new NoopCredentialFreeSandbox(),
        tools: [],
        environment: {},
      }),
      maximums: {
        timeoutMs: 60_000,
        turns: 10,
        inputTokens: 2_000,
        outputTokens: 2_000,
        outputBytes: 8_192,
        costUsd: 2,
        events: 20,
        toolCalls: 0,
      },
    });
    const execution = await harness.execute(
      providerRequest(renewed),
      renewed,
      repositoryAuthority(),
    );
    expect(execution.result.model_result.status).toBe("success");
    expect(transport.executionHandles).toEqual([renewed.executionHandle]);

    // The broker's renewal already committed this exact private operation.
    // Replaying its exact bytes returns byte-identical service output.
    const renewal = service.privateRequests.find(
      (request) => request.operation === "renew",
    );
    if (renewal === undefined) throw new Error("renewal request was not recorded");
    const firstReplay = await service.privateLifecycle(clone(renewal));
    const secondReplay = await service.privateLifecycle(clone(renewal));
    expect(JSON.stringify(secondReplay)).toBe(JSON.stringify(firstReplay));
    const conflict = await service.privateLifecycle({
      ...clone(renewal),
      requested_ttl_seconds: 301,
    });
    expect((conflict as CtxlaneIdentityLeaseLifecyclePrivateResponse).result).toMatchObject({
      kind: "error",
      error: { code: "idempotency-conflict" },
    });
    expect(service.currentView().status).toBe("renewing");

    await broker.close(renewed, "completed");
    expect((await lifecycle.inspect({
      client_request_id: REQUEST.client_request_id,
      lease_id: ACTIVE.lease_id,
    })).status).toBe("closed");
  });

  it("revokes through the same authenticated private seam", async () => {
    const service = new AuthenticatedCtxlaneService();
    const { broker, lifecycle } = brokerFor(service, new FakeClock(NOW));
    const lease = await broker.acquire(identityRequest());
    await broker.revoke(lease, "operator-revoked");
    expect((await lifecycle.inspect({
      client_request_id: REQUEST.client_request_id,
      lease_id: ACTIVE.lease_id,
    })).status).toBe("revoked");
  });
});
