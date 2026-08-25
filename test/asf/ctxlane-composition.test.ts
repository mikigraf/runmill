import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  IdentityLeaseRequest,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import type {
  CtxlaneAcquisitionAuthority,
  CtxlaneAcquisitionAuthorityResolver,
} from "../../src/identity/ctxlane-authority.js";
import type {
  CtxlaneIdentityLeaseAcquisitionClient,
  CtxlaneLeaseCloseRequest,
  CtxlaneLeaseLifecycleClient,
  CtxlaneLeaseRenewalRequest,
  CtxlaneLeaseRevocationRequest,
} from "../../src/identity/ctxlane-broker.js";
import type {
  CtxlaneIdentityLease,
  CtxlaneIdentityLeaseRequest,
} from "../../src/identity/ctxlane-contracts.js";
import {
  AsfIdentityLifecycleRefusalError,
  type AsfIdentityProfiles,
} from "../../src/asf/identity-lifecycle.js";
import type { AsfEffectInput } from "../../src/asf/delivery-runner.js";
import {
  AsfCtxlaneIdentityCompositionError,
  createAsfCtxlaneIdentityController,
} from "../../src/asf/ctxlane-composition.js";
import { sha256Digest, type JsonValue } from "../../src/asf/canonical-json.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const FIXTURES = join(__dirname, "..", "fixtures", "ctxlane", "examples");
const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
const REQUEST = readFixture<CtxlaneIdentityLeaseRequest>(
  "identity-lease-request.v1.json",
);
const ACTIVE = readFixture<CtxlaneIdentityLease>(
  "identity-lease-active.v1.json",
);
const REFUSED = readFixture<CtxlaneIdentityLease>(
  "identity-lease-refused.v1.json",
);
if (ACTIVE.execution_handle === null) {
  throw new Error("official active fixture is missing its execution handle");
}
const ACTIVE_EXECUTION_HANDLE = ACTIVE.execution_handle;
const NOW = "2026-08-21T10:00:00.000Z";
const RUNMILL_POLICY = `sha256:${"c".repeat(64)}`;
const PROFILES: AsfIdentityProfiles = {
  implementer: ACTIVE.profile_ref,
  localReviewer: "claude:automation-local-reviewer",
  prReviewer: "claude:automation-pr-reviewer",
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function suffix(value: string, marker: string): string {
  return `${value.slice(0, -1)}${marker}`;
}

function requestFor(
  request: IdentityLeaseRequest,
  role: CtxlaneIdentityLease["role"],
  profileRef: string,
): CtxlaneIdentityLeaseRequest {
  const marker = role === "implementer" ? "V" : role === "local-reviewer" ? "W" : "X";
  const clientRequestId =
    role === "implementer"
      ? REQUEST.client_request_id
      : `${REQUEST.client_request_id}-${role}`;
  const provider: CtxlaneIdentityLeaseRequest["provider"] =
    profileRef.startsWith("codex:") ? "codex" : "claude";
  const profileUid =
    role === "implementer" ? REQUEST.profile_uid : suffix(REQUEST.profile_uid, marker);
  const authorization = {
    ...clone(REQUEST.work_order_authorization),
    client_request_id: clientRequestId,
    role,
    provider,
    profile_uid: profileUid,
    profile_ref: profileRef,
  };
  return {
    ...clone(REQUEST),
    client_request_id: clientRequestId,
    work_order_authorization: authorization,
    role,
    provider,
    profile_uid: profileUid,
    profile_ref: profileRef,
    requested_ttl_seconds: request.requestedDurationMs / 1_000,
    policy_digest: null,
  };
}

function activeFor(
  request: CtxlaneIdentityLeaseRequest,
): CtxlaneIdentityLease {
  const marker = request.role === "implementer" ? "V" : request.role === "local-reviewer" ? "W" : "X";
  const digestMarker =
    request.role === "implementer" ? "b" : request.role === "local-reviewer" ? "d" : "e";
  const provider = request.provider;
  const profileRef = request.profile_ref;
  return {
    ...clone(ACTIVE),
    lease_id:
      request.role === "implementer"
        ? ACTIVE.lease_id
        : suffix(ACTIVE.lease_id, marker),
    execution_handle:
      request.role === "implementer"
        ? ACTIVE.execution_handle
        : suffix(ACTIVE_EXECUTION_HANDLE, marker),
    role: request.role,
    provider,
    profile_uid: request.profile_uid,
    profile_ref: profileRef,
    auth_mode: provider === "codex" ? "wif" : "subscription-token",
    principal_ref:
      request.role === "implementer"
        ? ACTIVE.principal_ref
        : `service-account:automation-${request.role}`,
    workspace_ref:
      provider === "codex"
        ? ACTIVE.workspace_ref
        : "claude-organization:org_automation_prod",
    effective_policy_digest:
      request.role === "implementer"
        ? ACTIVE.effective_policy_digest
        : `sha256:${digestMarker.repeat(64)}`,
  };
}

function authorityFor(
  request: CtxlaneIdentityLeaseRequest,
): CtxlaneAcquisitionAuthority {
  const active = activeFor(request);
  return {
    intent: {
      clientRequestId: request.client_request_id,
      acquisitionRequest: clone(request),
      expectedCallerSubject: ACTIVE.caller_subject,
      expectedHostIdentity: ACTIVE.host_identity,
    },
    clientRequestId: request.client_request_id,
    tenantId: request.tenant_id,
    workOrderDigest: request.work_order_digest,
    workOrderAuthorization: clone(request.work_order_authorization),
    provider: request.provider,
    profileUid: request.profile_uid,
    profileRef: request.profile_ref,
    repository: request.repository,
    workspaceId: request.workspace_id,
    environment: request.environment,
    expectedCallerSubject: active.caller_subject,
    expectedHostIdentity: active.host_identity,
    ctxlanePolicyDigest: request.policy_digest,
  };
}

class RecordingClient implements CtxlaneIdentityLeaseAcquisitionClient {
  readonly requests: CtxlaneIdentityLeaseRequest[] = [];
  constructor(readonly response: (request: CtxlaneIdentityLeaseRequest) => unknown) {}
  async acquire(request: CtxlaneIdentityLeaseRequest): Promise<unknown> {
    this.requests.push(clone(request));
    return this.response(request);
  }
}

class NoopLifecycle implements CtxlaneLeaseLifecycleClient {
  async renew(request: CtxlaneLeaseRenewalRequest): Promise<unknown> {
    return request.lease;
  }
  async close(_request: CtxlaneLeaseCloseRequest): Promise<unknown> {
    return undefined;
  }
  async revoke(_request: CtxlaneLeaseRevocationRequest): Promise<unknown> {
    return undefined;
  }
}

class Fence implements IdentityOwnershipFenceValidator {
  async isCurrent(_fence: IdentityOwnershipFence): Promise<boolean> {
    return true;
  }
}

class NoopScheduler {
  schedule(): { cancel(): void } {
    return { cancel: () => undefined };
  }
}

function effectInput(profiles: AsfIdentityProfiles = PROFILES): AsfEffectInput {
  const binding = {
    runId: REQUEST.run_id,
    workOrderId: REQUEST.work_order_id,
    attemptId: REQUEST.attempt_id,
    policyDigest: RUNMILL_POLICY,
    fencingGeneration: 41,
    candidateSha: null,
  } as const;
  const unsignedIntent = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: "identity-composition-intent",
    effect_key: "identity-composition-effect",
    stage: "identity-leases" as const,
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: null,
    event_seq: 2,
    operation_digest: sha256Digest({
      identities: profiles as unknown as JsonValue,
    }),
    created_at: NOW,
  };
  return {
    binding,
    intent: {
      ...unsignedIntent,
      intent_digest: sha256Digest(unsignedIntent),
    },
    intentMode: "observe-before-apply",
    signal: new AbortController().signal,
  };
}

function composition(
  client: CtxlaneIdentityLeaseAcquisitionClient,
  authority: CtxlaneAcquisitionAuthorityResolver,
  profiles: AsfIdentityProfiles = PROFILES,
) {
  const clock = new FakeClock(NOW);
  return createAsfCtxlaneIdentityController({
    client,
    lifecycleClient: new NoopLifecycle(),
    authority,
    clock,
    ownershipFence: new Fence(),
    profiles: { resolve: () => profiles },
    requestedDurationMs: REQUEST.requested_ttl_seconds * 1_000,
    renewalLeadMs: 60_000,
    fenceCheckIntervalMs: 2_000,
    scheduler: new NoopScheduler(),
    onAuthorityLost: () => undefined,
  });
}

function profileForRole(role: CtxlaneIdentityLease["role"]): string {
  switch (role) {
    case "implementer":
      return PROFILES.implementer;
    case "local-reviewer":
      return PROFILES.localReviewer;
    case "pr-reviewer":
      return PROFILES.prReviewer;
  }
}

function ctxlaneRole(
  role: IdentityLeaseRequest["role"],
): CtxlaneIdentityLease["role"] {
  if (
    role === "implementer" ||
    role === "local-reviewer" ||
    role === "pr-reviewer"
  ) {
    return role;
  }
  throw new Error("unexpected non-ctxlane role");
}

describe("ASF ctxlane identity composition", () => {
  it("uses the real broker and lifecycle controller with exact explicit authority", async () => {
    const client = new RecordingClient((request) => activeFor(request));
    const authority = {
      resolveAcquisitionAuthority: (request: IdentityLeaseRequest) => {
        const role = ctxlaneRole(request.role);
        return authorityFor(requestFor(request, role, profileForRole(role)));
      },
    };
    const controller = composition(client, authority);
    const observation = await controller.acquireRequiredRoles(effectInput());

    expect(client.requests[0]).toEqual(REQUEST);
    expect(client.requests).toHaveLength(3);
    expect(observation.roles).toEqual([
      "implementer",
      "local-reviewer",
      "pr-reviewer",
    ]);
    expect(observation.attributions.map((item) => item.role)).toEqual(
      observation.roles,
    );
    expect(JSON.stringify(observation)).not.toContain(ACTIVE_EXECUTION_HANDLE);
    expect(JSON.stringify(observation)).not.toContain(ACTIVE.lease_id);
  });

  it("fails closed for the official refused lease without leaking capabilities", async () => {
    const client = new RecordingClient(() => REFUSED);
    const authority = {
      resolveAcquisitionAuthority: (request: IdentityLeaseRequest) => {
        const role = ctxlaneRole(request.role);
        return authorityFor(requestFor(request, role, profileForRole(role)));
      },
    };
    const controller = composition(client, authority);

    await expect(controller.acquireRequiredRoles(effectInput())).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(AsfIdentityLifecycleRefusalError);
        expect(error).toMatchObject({ reason: "authority-unavailable" });
        expect(String(error)).not.toContain(ACTIVE.execution_handle);
        expect(String(error)).not.toContain(ACTIVE.lease_id);
        return true;
      },
    );
  });

  it("rejects incomplete or mismatched authority before transport", async () => {
    const client = new RecordingClient((request) => activeFor(request));
    expect(() =>
      composition(
        client,
        undefined as unknown as CtxlaneAcquisitionAuthorityResolver,
      ),
    ).toThrow(AsfCtxlaneIdentityCompositionError);

    const mismatched = {
      resolveAcquisitionAuthority: () =>
        authorityFor(REQUEST),
    };
    const controller = composition(
      client,
      mismatched,
      {
        implementer: "claude:wrong-profile",
        localReviewer: "claude:wrong-profile",
        prReviewer: "claude:wrong-profile",
      },
    );
    await expect(controller.acquireRequiredRoles(effectInput({
      implementer: "claude:wrong-profile",
      localReviewer: "claude:wrong-profile",
      prReviewer: "claude:wrong-profile",
    }))).rejects.toBeInstanceOf(AsfIdentityLifecycleRefusalError);
    expect(client.requests).toHaveLength(0);
  });
});
