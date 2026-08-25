import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASF_REFERENCE_COMPOSITION_SCHEMA,
  createAsfReferenceWorkerHostOptions,
  type AsfReferenceCompositionInput,
} from "../../src/asf/reference-composition.js";
import {
  WorkOrderAdmissionService,
  workOrderSigningPayload,
  type AsfAdmissionPolicy,
  type RepositoryAdmissionEvidence,
  type WorkOrderEnvelope,
  type WorkOrderPayload,
} from "../../src/asf/work-order.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../../src/asf/canonical-json.js";
import { StateStore } from "../../src/state/store.js";
import { createNoopAsfTelemetryRecorder } from "../../src/asf/telemetry.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { createAsfCtxlaneIdentityController } from "../../src/asf/ctxlane-composition.js";
import {
  ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
  evaluateAsfQualificationPreflight,
} from "../../src/asf/qualification.js";
import type {
  IdentityLease,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import type {
  CtxlaneAcquisitionAuthority,
  CtxlaneAcquisitionAuthorityResolver,
} from "../../src/identity/ctxlane-authority.js";
import {
  CtxlaneProviderIdentityBroker,
} from "../../src/identity/ctxlane-broker.js";
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
  ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
  AsfDeliveryStop,
  type AsfRecoveryController,
  type AsfEffectInput,
} from "../../src/asf/delivery-runner.js";
import { AsfGitHubEffectsController } from "../../src/asf/github-effects.js";
import {
  ProductionAsfEvidenceFinalizationController,
  type AsfEvidenceFinalizationMaterial,
  type AsfEvidenceFinalizationMaterialSource,
} from "../../src/asf/evidence-finalizer.js";
import { ProductionAsfTerminalEvidenceFinalizationController } from "../../src/asf/terminal-evidence-finalizer.js";
import { AsfEvidenceReadService } from "../../src/asf/evidence-service.js";
import type { AsfEvidenceSigningKey } from "../../src/asf/evidence-signing-config.js";
import {
  ASF_EVIDENCE_PREDICATE_SCHEMA,
  ASF_EVIDENCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_V1,
  type AsfEvidencePredicate,
  type AsfEvidenceStatement,
} from "../../src/evidence/asf-bundle.js";
import type { AsfIdentityLeaseAttribution } from "../../src/asf/identity-attribution.js";
import { StateStoreAsfProviderBudgetController } from "../../src/asf/budget.js";
import { StateStoreAsfDeliveryIntentStore } from "../../src/asf/state-delivery-intent-store.js";
import { ASF_RECOVERY_REQUEST_SCHEMA } from "../../src/asf/checkpoint-policy.js";
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
  ASF_TOOL_REQUEST_SCHEMA,
  RepositoryToolGateway,
  type CredentialFreeProductionSandbox,
  type CredentialFreeSandboxExecution,
  type RegisteredRepositoryTool,
} from "../../src/agent/tool-gateway.js";
import type { SandboxResult } from "../../src/workspace/sandbox.js";

const NOW = "2026-08-21T10:00:00.000Z";
const BASE_SHA = "c".repeat(40);
// The signed Work Order and the deterministic forge observation intentionally
// use the same base so the production evidence finalizer can bind both facts.
const OBSERVED_BASE_SHA = BASE_SHA;
const REPOSITORY_POLICY_BYTES = Buffer.from("checks: []\n", "utf8");
const rawDigest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const REPOSITORY_POLICY_DIGEST = rawDigest(REPOSITORY_POLICY_BYTES);
const FORGE_PROTECTION_BYTES = Buffer.from(
  canonicalJson({
    schema: "runmill.github-base-protection/v1",
    repository: "acme/e2e",
    base_ref: "refs/heads/main",
    protection: {
      required_checks: ["ci/e2e"],
      requires_approval: false,
      requires_conversation_resolution: false,
      uses_merge_queue: false,
    },
  }),
  "utf8",
);
const FORGE_PROTECTION_DIGEST = rawDigest(FORGE_PROTECTION_BYTES);
const DIGEST = {
  source: `sha256:${"e".repeat(64)}`,
  workOrderPolicy: `sha256:${"f".repeat(64)}`,
  harness: `sha256:${"a".repeat(64)}`,
  operator: `sha256:${"b".repeat(64)}`,
} as const;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const CTXLANE_FIXTURES = join(
  __dirname,
  "..",
  "fixtures",
  "ctxlane",
  "examples",
);
const readCtxlaneFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(CTXLANE_FIXTURES, name), "utf8")) as T;
const CTXLANE_REQUEST = readCtxlaneFixture<CtxlaneIdentityLeaseRequest>(
  "identity-lease-request.v1.json",
);
const CTXLANE_ACTIVE = readCtxlaneFixture<CtxlaneIdentityLease>(
  "identity-lease-active.v1.json",
);
const CTXLANE_REFUSED = readCtxlaneFixture<CtxlaneIdentityLease>(
  "identity-lease-refused.v1.json",
);
if (CTXLANE_ACTIVE.execution_handle === null) {
  throw new Error("official ctxlane active fixture lacks execution handle");
}
const CTXLANE_PROFILES = {
  implementer: CTXLANE_ACTIVE.profile_ref,
  localReviewer: "claude:automation-local-reviewer",
  prReviewer: "claude:automation-pr-reviewer",
} as const;
const E2E_PROFILES = {
  implementer: "codex:e2e-implementer",
  localReviewer: "claude:e2e-local-reviewer",
  prReviewer: "claude:e2e-pr-reviewer",
} as const;
type CtxlaneRequiredRole =
  | "implementer"
  | "local-reviewer"
  | "pr-reviewer";

function requiredCtxlaneRole(role: string): CtxlaneRequiredRole {
  if (
    role === "implementer" ||
    role === "local-reviewer" ||
    role === "pr-reviewer"
  ) {
    return role;
  }
  throw new Error(`unexpected non-ctxlane role: ${role}`);
}

function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}

function replaceLastCharacter(value: string, marker: string): string {
  return `${value.slice(0, -1)}${marker}`;
}

function ctxlaneAuthorizationSigningPayload(
  authorization: CtxlaneIdentityLeaseRequest["work_order_authorization"],
): Buffer {
  const { signature: _signature, ...unsigned } = authorization;
  return Buffer.from(
    `ctxlane.work-order-authorization/v1\u0000${canonicalJson(unsigned)}`,
    "utf8",
  );
}

function ctxlaneRequestFor(
  role: CtxlaneRequiredRole,
  profileRef: string,
): CtxlaneIdentityLeaseRequest {
  const marker = role === "implementer" ? "V" : role === "local-reviewer" ? "W" : "X";
  const clientRequestId =
    role === "implementer"
      ? CTXLANE_REQUEST.client_request_id
      : `${CTXLANE_REQUEST.client_request_id}-${role}`;
  const provider: CtxlaneIdentityLeaseRequest["provider"] =
    profileRef.startsWith("codex:") ? "codex" : "claude";
  const authorization = {
    ...cloneFixture(CTXLANE_REQUEST.work_order_authorization),
    client_request_id: clientRequestId,
    role,
    provider,
    profile_uid:
      role === "implementer"
        ? CTXLANE_REQUEST.profile_uid
        : replaceLastCharacter(CTXLANE_REQUEST.profile_uid, marker),
    profile_ref: profileRef,
  };
  return {
    ...cloneFixture(CTXLANE_REQUEST),
    client_request_id: clientRequestId,
    work_order_authorization: authorization,
    role,
    provider,
    profile_uid: authorization.profile_uid,
    profile_ref: profileRef,
    requested_ttl_seconds: CTXLANE_REQUEST.requested_ttl_seconds,
    policy_digest: null,
  };
}

function ctxlaneActiveFor(
  request: CtxlaneIdentityLeaseRequest,
): CtxlaneIdentityLease {
  const marker = request.role === "implementer" ? "V" : request.role === "local-reviewer" ? "W" : "X";
  const digestMarker =
    request.role === "implementer" ? "b" : request.role === "local-reviewer" ? "d" : "e";
  const provider = request.provider;
  return {
    ...cloneFixture(CTXLANE_ACTIVE),
    lease_id:
      request.role === "implementer"
        ? CTXLANE_ACTIVE.lease_id
        : replaceLastCharacter(CTXLANE_ACTIVE.lease_id, marker),
    execution_handle:
      request.role === "implementer"
        ? CTXLANE_ACTIVE.execution_handle
        : replaceLastCharacter(CTXLANE_ACTIVE.execution_handle!, marker),
    role: request.role,
    provider,
    tenant_id: request.tenant_id,
    work_order_id: request.work_order_id,
    work_order_digest: request.work_order_digest,
    run_id: request.run_id,
    attempt_id: request.attempt_id,
    profile_uid: request.profile_uid,
    profile_ref: request.profile_ref,
    repository: request.repository,
    workspace_id: request.workspace_id,
    environment: request.environment,
    auth_mode: provider === "codex" ? "wif" : "subscription-token",
    principal_ref:
      request.role === "implementer"
        ? CTXLANE_ACTIVE.principal_ref
        : `service-account:automation-${request.role}`,
    workspace_ref:
      provider === "codex"
        ? CTXLANE_ACTIVE.workspace_ref
        : "claude-organization:org_automation_prod",
    effective_policy_digest:
      request.role === "implementer"
        ? CTXLANE_ACTIVE.effective_policy_digest
        : `sha256:${digestMarker.repeat(64)}`,
  };
}

function ctxlaneRequestForRunmill(
  role: CtxlaneRequiredRole,
  request: {
    readonly runId: string;
    readonly workOrderId: string;
    readonly attemptId: string;
    readonly requestedProfile: string;
  },
): CtxlaneIdentityLeaseRequest {
  const profileRef = request.requestedProfile;
  const provider: CtxlaneIdentityLeaseRequest["provider"] =
    profileRef.startsWith("codex:") ? "codex" : "claude";
  const marker = role === "implementer" ? "V" : role === "local-reviewer" ? "W" : "X";
  const profileUid =
    role === "implementer"
      ? CTXLANE_ACTIVE.profile_uid
      : replaceLastCharacter(CTXLANE_REQUEST.profile_uid, marker);
  const clientRequestId = `e2e-${request.runId}-${role}`;
  const workOrderDigest = sha256Digest(e2ePayload());
  const repository = "github:acme/e2e";
  const workspaceId = `workspace-${request.runId}`;
  const environment = "local-development";
  const template = CTXLANE_REQUEST.work_order_authorization;
  const authorizationWithoutSignature = {
    schema: template.schema,
    algorithm: template.algorithm,
    key_id: template.key_id,
    client_request_id: clientRequestId,
    tenant_id: "tenant-e2e",
    work_order_id: request.workOrderId,
    work_order_digest: workOrderDigest,
    run_id: request.runId,
    attempt_id: request.attemptId,
    role,
    provider,
    profile_uid: profileUid,
    profile_ref: profileRef,
    repository,
    workspace_id: workspaceId,
    environment,
    not_before: template.not_before,
    expires_at: template.expires_at,
    maximum_ttl_seconds: template.maximum_ttl_seconds,
    maximum_session_seconds: template.maximum_session_seconds,
  };
  const signatureBytes = signBytes(
    null,
    ctxlaneAuthorizationSigningPayload({
      ...authorizationWithoutSignature,
      signature: CTXLANE_REQUEST.work_order_authorization.signature,
    }),
    privateKey,
  );
  const signature = signatureBytes.toString("base64url");
  const authorization = {
    ...authorizationWithoutSignature,
    signature,
  };
  return {
    schema: CTXLANE_REQUEST.schema,
    client_request_id: clientRequestId,
    tenant_id: authorization.tenant_id,
    work_order_id: authorization.work_order_id,
    work_order_digest: authorization.work_order_digest,
    work_order_authorization: authorization,
    run_id: authorization.run_id,
    attempt_id: authorization.attempt_id,
    role,
    provider,
    profile_uid: authorization.profile_uid,
    profile_ref: authorization.profile_ref,
    repository: authorization.repository,
    workspace_id: authorization.workspace_id,
    environment: authorization.environment,
    requested_ttl_seconds: CTXLANE_REQUEST.requested_ttl_seconds,
    policy_digest: null,
  };
}

function ctxlaneAuthorityFor(
  request: CtxlaneIdentityLeaseRequest,
): CtxlaneAcquisitionAuthority {
  const active = ctxlaneActiveFor(request);
  return {
    intent: {
      clientRequestId: request.client_request_id,
      acquisitionRequest: cloneFixture(request),
      expectedCallerSubject: CTXLANE_ACTIVE.caller_subject,
      expectedHostIdentity: CTXLANE_ACTIVE.host_identity,
    },
    clientRequestId: request.client_request_id,
    tenantId: request.tenant_id,
    workOrderDigest: request.work_order_digest,
    workOrderAuthorization: cloneFixture(request.work_order_authorization),
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

class RecordingCtxlaneClient implements CtxlaneIdentityLeaseAcquisitionClient {
  readonly requests: CtxlaneIdentityLeaseRequest[] = [];
  readonly responses: unknown[] = [];
  constructor(readonly returnRefused = false) {}

  async acquire(request: CtxlaneIdentityLeaseRequest): Promise<unknown> {
    this.requests.push(cloneFixture(request));
    const response = this.returnRefused
      ? CTXLANE_REFUSED
      : ctxlaneActiveFor(request);
    this.responses.push(response);
    return response;
  }
}

class FixtureLifecycleClient implements CtxlaneLeaseLifecycleClient {
  readonly renewRequests: CtxlaneLeaseRenewalRequest[] = [];
  readonly closeRequests: CtxlaneLeaseCloseRequest[] = [];
  readonly revokeRequests: CtxlaneLeaseRevocationRequest[] = [];

  async renew(request: CtxlaneLeaseRenewalRequest): Promise<unknown> {
    this.renewRequests.push(request);
    return request.lease;
  }

  async close(request: CtxlaneLeaseCloseRequest): Promise<unknown> {
    this.closeRequests.push(request);
    return undefined;
  }

  async revoke(request: CtxlaneLeaseRevocationRequest): Promise<unknown> {
    this.revokeRequests.push(request);
    return undefined;
  }
}

class CurrentFence implements IdentityOwnershipFenceValidator {
  async isCurrent(_fence: IdentityOwnershipFence): Promise<boolean> {
    return true;
  }
}

function ctxlaneEffectInput(): AsfEffectInput {
  const binding = {
    runId: CTXLANE_REQUEST.run_id,
    workOrderId: CTXLANE_REQUEST.work_order_id,
    attemptId: CTXLANE_REQUEST.attempt_id,
    policyDigest: DIGEST.workOrderPolicy,
    fencingGeneration: 41,
    candidateSha: null,
  } as const;
  const unsignedIntent = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: "e2e-identity-intent",
    effect_key: "e2e-identity-effect",
    stage: "identity-leases" as const,
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: null,
    event_seq: 2,
    operation_digest: sha256Digest({ identities: CTXLANE_PROFILES }),
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

function e2ePayload(): WorkOrderPayload {
  return {
    schema: "asf.work-order/v1",
    work_order_id: "wo_e2e_001",
    tenant_id: "tenant-e2e",
    work_item_id: "E2E-001",
    attempt_id: "attempt_e2e_01",
    idempotency_key: "tenant-e2e/E2E-001/attempt_e2e_01",
    source: {
      system: "linear",
      external_id: "E2E-001",
      snapshot_digest: DIGEST.source,
    },
    repository: {
      forge: "github",
      repository: "acme/e2e",
      base_ref: "refs/heads/main",
      base_sha: BASE_SHA,
    },
    objective: {
      title: "End-to-end reference qualification exercise",
      description:
        "Deterministic offline integration test wiring real admission, ctxlane composition, " +
        "trusted provider harness, and durable recovery without live credentials or network.",
      acceptance_criteria: [
        "signed Work Order admitted through real WorkOrderAdmissionService",
        "three exact ctxlane role requests acquired through real identity controller",
        "harness/tool invocation capability proven without execution leakage",
        "exact candidate-bound unit and lint checks pass through local verification",
        "durable StateStore close/reopen recovery boundary crossed",
      ],
      non_goals: [
        "live ctxlane authenticated service invocation",
        "live GitHub API effects",
        "real CI observation",
        "production-qualified evidence",
      ],
    },
    scope: {
      allowed_paths: ["src/**", "test/**"],
      forbidden_paths: [".github/**", ".runmill/**"],
      risk_class: "low",
    },
    verification: {
      required_local_check_ids: ["unit", "lint"],
      required_remote_checks: ["ci/e2e"],
      policy_snapshot_digest: REPOSITORY_POLICY_DIGEST,
    },
    identities: {
      implementer: E2E_PROFILES.implementer,
      local_reviewer: E2E_PROFILES.localReviewer,
      pr_reviewer: E2E_PROFILES.prReviewer,
    },
    runtime: {
      sandbox_profile: "linux-e2e-v1",
      tool_policy: "repo-e2e-v1",
      network_policy: "provider-e2e-v1",
    },
    budgets: {
      wall_seconds: 1_800,
      max_cost_usd: 5,
      max_agent_invocations: 8,
      max_fix_iterations: 2,
    },
    delivery: {
      closure_target: "pr",
      draft_pr: false,
      merge_policy_ref: null,
    },
    policy_digest: DIGEST.workOrderPolicy,
    harness_digest: DIGEST.harness,
  };
}

function e2eEnvelope(): WorkOrderEnvelope {
  const envelope: WorkOrderEnvelope = {
    schema: "asf.work-order-envelope/v1",
    key_id: "asf-e2e-signing-key",
    algorithm: "EdDSA",
    issued_at: NOW,
    not_before: NOW,
    expires_at: new Date(Date.parse(NOW) + 30 * 60_000).toISOString(),
    payload: e2ePayload(),
    signature: "base64url:AA",
  };
  envelope.signature = `base64url:${signBytes(
    null,
    Buffer.from(workOrderSigningPayload(envelope), "utf8"),
    privateKey,
  ).toString("base64url")}`;
  return envelope;
}

function e2ePolicy(): AsfAdmissionPolicy {
  return {
    operatorPolicyDigest: DIGEST.operator,
    tenantIds: ["tenant-e2e"],
    policyDigests: [DIGEST.workOrderPolicy],
    harnessDigests: [DIGEST.harness],
    repository: {
      forge: "github",
      repository: "acme/e2e",
      baseRef: "refs/heads/main",
    },
    trustedSigners: [{ keyId: "asf-e2e-signing-key", publicKey }],
    authority: {
      pathScope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      definedLocalCheckIds: ["unit", "lint"],
      authorizedRepositoryCheckIds: [],
      requiredLocalCheckIds: ["unit", "lint"],
      requiredRemoteChecks: [],
      allowedRiskClasses: ["low"],
      allowedClosureTargets: ["pr"],
      identityProfiles: {
        implementer: [E2E_PROFILES.implementer],
        localReviewer: [E2E_PROFILES.localReviewer],
        prReviewer: [E2E_PROFILES.prReviewer],
      },
      requireIndependentReviewers: true,
      sandboxProfiles: ["linux-e2e-v1"],
      toolPolicies: ["repo-e2e-v1"],
      networkPolicies: ["provider-e2e-v1"],
      budgetLimits: {
        wallSeconds: 1_800,
        maxCostUsd: 5,
        maxAgentInvocations: 8,
        maxFixIterations: 2,
      },
    },
  };
}

function e2eRepositoryEvidence(): RepositoryAdmissionEvidence {
  return {
    forge: "github",
    repository: "acme/e2e",
    baseRef: "refs/heads/main",
    observedBaseSha: OBSERVED_BASE_SHA,
    requestedBaseShaReachable: true,
    repositoryPolicyDigest: REPOSITORY_POLICY_DIGEST,
    repositoryPolicyBaseSha: BASE_SHA,
    repositoryPolicyPath: ".runmill/checks.yaml",
    repositoryPolicyBytesBase64: REPOSITORY_POLICY_BYTES.toString("base64"),
    forgeProtectionDigest: FORGE_PROTECTION_DIGEST,
    forgeProtectionBaseRef: "refs/heads/main",
    forgeProtectionBytesBase64: FORGE_PROTECTION_BYTES.toString("base64"),
    constraints: {
      pathScope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: ["src/generated/**"],
      },
      definedLocalCheckIds: [],
      requiredLocalCheckIds: [],
      requiredRemoteChecks: [],
    },
    forgeProtection: {
      pullRequestsAllowed: true,
      requiredRemoteChecks: ["ci/e2e"],
    },
  };
}

const PROVIDER_TASK_DIGEST = `sha256:${"1".repeat(64)}`;
const PROVIDER_INSTRUCTION_DIGEST = `sha256:${"2".repeat(64)}`;
const PROVIDER_CONTEXT_DIGEST = `sha256:${"3".repeat(64)}`;
const PROVIDER_CANDIDATE_SHA = "4".repeat(40);
const PROVIDER_CREDENTIAL = "provider-credential-e2e-secret";
const PROVIDER_SESSION_KEY = "session-protection-key-e2e-0123456789";
const PROVIDER_OUTPUT_DIGEST = `sha256:${"5".repeat(64)}`;

class DeterministicCredentialFreeSandbox
  implements CredentialFreeProductionSandbox
{
  readonly mechanism = "bubblewrap" as const;
  readonly enforcement = "production-credential-free" as const;
  readonly calls: CredentialFreeSandboxExecution[] = [];

  async execute(input: CredentialFreeSandboxExecution): Promise<SandboxResult> {
    if (
      input.sandbox.policy.allowNetwork ||
      input.isolation.network !== "disabled" ||
      input.isolation.providerCredentials !== "denied" ||
      input.isolation.hostCredentialPaths !== "denied" ||
      input.isolation.hostSockets !== "denied" ||
      input.isolation.otherWorkspaces !== "denied" ||
      input.sandbox.cwd.length === 0
    ) {
      throw new Error("reference sandbox received an unsafe isolation contract");
    }
    this.calls.push(input);
    return {
      outcome: "exited",
      exitCode: 0,
      signal: null,
      stdout: "# E2E Test\n",
      stderr: "",
      durationMs: 1,
    };
  }
}

const referenceReadTool: RegisteredRepositoryTool = {
  name: "repository.read",
  access: "read",
  allowedRoles: ["implementer", "local-reviewer", "pr-reviewer"],
  buildInvocation(tool) {
    if (tool.name !== "repository.read") throw new Error("unexpected tool");
    return {
      command: "/usr/bin/sed",
      args: ["-n", "1,100p", tool.arguments.path],
      repositoryPaths: [tool.arguments.path],
    };
  },
};

function providerRequestFor(
  lease: IdentityLease,
  overrides: {
    readonly invocationId?: string;
    readonly candidateSha?: string;
    readonly taskPacketDigest?: string;
    readonly session?: { readonly mode: "fresh" };
  } = {},
): AsfProviderRequest {
  return {
    schema: ASF_PROVIDER_REQUEST_SCHEMA,
    model_request: {
      schema: ASF_MODEL_REQUEST_SCHEMA,
      request_id: "provider-e2e-request",
      binding: {
        run_id: lease.runId,
        work_order_id: lease.workOrderId,
        attempt_id: lease.attemptId,
        role: lease.role,
        invocation_id: overrides.invocationId ?? "provider-e2e-invocation",
        policy_digest: lease.policyDigest,
        candidate_sha: overrides.candidateSha ?? PROVIDER_CANDIDATE_SHA,
        fencing_generation: lease.fencingGeneration,
      },
      provider: lease.provider,
      model: "reference-model",
      principal: lease.principal,
      profile: lease.profile,
      task_packet_digest: overrides.taskPacketDigest ?? PROVIDER_TASK_DIGEST,
      instruction_digest: PROVIDER_INSTRUCTION_DIGEST,
      context_digests: [PROVIDER_CONTEXT_DIGEST],
      allowed_tools: ["repository.read"],
      allowed_check_ids: [],
      limits: {
        timeout_ms: 30_000,
        max_turns: 10,
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        max_output_bytes: 4_096,
        max_cost_usd: 10,
        max_events: 100,
        max_tool_calls: 1,
      },
    },
    session: overrides.session ?? { mode: "fresh" },
  };
}

function providerRepositoryAuthority(
  request: AsfProviderRequest,
  workspaceRoot: string,
): ProviderRepositoryAuthority {
  return {
    invocationId: request.model_request.binding.invocation_id,
    candidateSha: request.model_request.binding.candidate_sha,
    taskPacketDigest: request.model_request.task_packet_digest,
    instructionDigest: request.model_request.instruction_digest,
    contextDigests: request.model_request.context_digests,
    model: request.model_request.model,
    workspaceRoot,
    pathScope: { allowedPaths: ["README.md"], forbiddenPaths: [] },
    allowedTools: ["repository.read"],
    allowedCheckIds: [],
    toolResourceLimits: {
      cpuMillis: 1_000,
      memoryMib: 1_024,
      processes: 64,
      fileSizeBytes: 8_388_608,
      wallTimeMs: 30_000,
      maxOutputBytes: 4_096,
    },
    freshCandidate: true,
  };
}

function referenceImplementerLease(
  binding: AsfEffectInput["binding"],
): IdentityLease {
  return {
    leaseId: CTXLANE_ACTIVE.lease_id as IdentityLease["leaseId"],
    executionHandle: CTXLANE_ACTIVE.execution_handle as IdentityLease["executionHandle"],
    runId: binding.runId,
    workOrderId: binding.workOrderId,
    attemptId: binding.attemptId,
    role: "implementer",
    policyDigest: binding.policyDigest,
    provider: "codex",
    principal: CTXLANE_ACTIVE.principal_ref ?? "service-account:reference",
    profile: E2E_PROFILES.implementer,
    issuedAt: CTXLANE_ACTIVE.issued_at,
    expiresAt:
      CTXLANE_ACTIVE.expires_at ??
      new Date(Date.parse(NOW) + 15 * 60_000).toISOString(),
    fencingGeneration: binding.fencingGeneration,
  };
}

/**
 * Build the capability-bearing lease used only inside the deterministic
 * provider-harness fixture. The identity controller intentionally returns
 * capability-free observations; this adapter is the test-owned boundary that
 * proves a provider invocation can consume the exact ctxlane lease without
 * leaking its handle into Runmill evidence.
 */
function referenceLeaseForRole(
  binding: AsfEffectInput["binding"],
  role: CtxlaneRequiredRole,
): IdentityLease {
  const requestedProfile = E2E_PROFILES[
    role === "local-reviewer"
      ? "localReviewer"
      : role === "pr-reviewer"
        ? "prReviewer"
        : "implementer"
  ];
  const request = ctxlaneRequestForRunmill(role, {
    runId: binding.runId,
    workOrderId: binding.workOrderId,
    attemptId: binding.attemptId,
    requestedProfile,
  });
  const active = ctxlaneActiveFor(request);
  if (active.execution_handle === null || active.expires_at === null) {
    throw new Error("ctxlane active fixture lacks provider capability metadata");
  }
  return {
    leaseId: active.lease_id as IdentityLease["leaseId"],
    executionHandle: active.execution_handle as IdentityLease["executionHandle"],
    runId: binding.runId,
    workOrderId: binding.workOrderId,
    attemptId: binding.attemptId,
    role,
    policyDigest: binding.policyDigest,
    provider: request.provider,
    principal: active.principal_ref ?? "service-account:reference",
    profile: request.profile_ref,
    issuedAt: active.issued_at,
    expiresAt: active.expires_at,
    fencingGeneration: binding.fencingGeneration,
  };
}

class DeterministicProviderTransport implements TrustedProviderTransport {
  readonly calls: TrustedProviderTransportInput[] = [];
  readonly observedCredentials: string[] = [];
  readonly observedExecutionHandles: string[] = [];

  async execute(input: TrustedProviderTransportInput): Promise<unknown> {
    this.calls.push(input);
    input.authority.useProviderCredential((credential) =>
      this.observedCredentials.push(credential),
    );
    input.authority.useExecutionHandle((handle) =>
      this.observedExecutionHandles.push(handle),
    );
    const binding = input.request.model_request.binding;
    const toolArguments = { path: "README.md", max_bytes: 4_096 };
    const toolResult = await input.invokeTool({
      schema: ASF_TOOL_REQUEST_SCHEMA,
      request_id: "provider-e2e-tool-request",
      binding,
      tool: { name: "repository.read", arguments: toolArguments },
      limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
    });
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      tool_calls: 1,
    } as const;
    return {
      status: "success",
      output_digest: PROVIDER_OUTPUT_DIGEST,
      output_bytes: 0,
      turns: 1,
      usage,
      events: [
        {
          sequence: 1,
          observed_at: NOW,
          event: { type: "session.started" },
        },
        {
          sequence: 2,
          observed_at: NOW,
          event: {
            type: "tool.requested",
            tool_request_id: "provider-e2e-tool-request",
            tool_name: "repository.read",
            request_digest: toolResult.request_digest,
            arguments_digest: sha256Digest(toolArguments),
          },
        },
        {
          sequence: 3,
          observed_at: NOW,
          event: {
            type: "tool.completed",
            tool_request_id: "provider-e2e-tool-request",
            tool_name: "repository.read",
            status: toolResult.status,
            result_digest: toolResult.result_digest,
          },
        },
        {
          sequence: 4,
          observed_at: NOW,
          event: { type: "usage.updated", cumulative: true, usage },
        },
        {
          sequence: 5,
          observed_at: NOW,
          event: { type: "session.completed", status: "success" },
        },
      ],
      // The reference run intentionally exercises a non-resumable provider
      // session so candidate creation can advance without protected resume
      // storage. Production resumability remains an operator-owned port.
      protected_session_ref: null,
      failure: null,
    } satisfies TrustedProviderTransportResult;
  }
}

/**
 * Deterministic-reference-only composition-boundary exercise. This test wires:
 * - Real signed WorkOrderAdmissionService against vendored fixtures
 * - Real createAsfCtxlaneIdentityController() composition boundary
 * - Real TrustedProviderHarness and RepositoryToolGateway contracts with a
 *   deterministic credential-free sandbox transport
 * - Real AsfPrDeliveryRunner/AsfWorkerService structural composition from
 *   reference-composition.ts
 * - Real StateStore durable close/reopen recovery boundary
 *
 * It does NOT invoke:
 * - Live ctxlane authenticated service (request/active/refused fixtures only)
 * - Live GitHub API (deterministic adapters for PR/CI observation)
 * - Real CI schedulers or cloud harnesses
 * - Production-qualified provider sessions or live evidence stores
 *
 * This boundary exercise invokes the assembled runner through the durable
 * repository, identity, workspace, task-packet, deterministic provider
 * harness, exact candidate-bound local verification/review, deterministic
 * GitHub/CI observations, and signed evidence finalization. It does not
 * pretend that the deterministic ports are production adapters or invoke live
 * GitHub, CI, ctxlane, or evidence stores. Production qualification remains
 * false until those operator-owned integrations are supplied.
 *
 * CLASSIFICATION: deterministic-reference-only
 * PRODUCTION_QUALIFIED: false
 */
describe("ASF reference composition deterministic qualification boundary", () => {
  it("admits signed Work Order, acquires ctxlane roles, proves recovery boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "runmill-e2e-"));
    const repoPath = join(root, "repo");
    const databasePath = join(root, "state.sqlite");
    const clock = new FakeClock(NOW);

    try {
      // Prepare an isolated workspace directory for the sandbox contract. The
      // deterministic transport does not claim to execute a real Git process.
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(join(repoPath, "README.md"), "# E2E Test\n", "utf8");

      // Real durable state store
      const store = StateStore.open(databasePath, { clock });
      const telemetry = createNoopAsfTelemetryRecorder(clock);

      // Real signed admission service
      const admission = new WorkOrderAdmissionService({
        store,
        policy: e2ePolicy(),
        repository: { observe: async () => e2eRepositoryEvidence() },
        clock,
        runId: () => "run_e2e_deterministic_01",
      });

      // Real ctxlane broker/lifecycle controller, driven only by the official
      // vendored published request/active/refused fixtures. No live service is
      // contacted by this deterministic reference exercise.
      const ctxlaneClient = new RecordingCtxlaneClient();
      const ctxlaneController = createAsfCtxlaneIdentityController({
        client: ctxlaneClient,
        lifecycleClient: new FixtureLifecycleClient(),
        authority: {
          resolveAcquisitionAuthority: (request) => {
            const role = requiredCtxlaneRole(request.role);
            if (request.runId === "run_e2e_deterministic_01") {
              return ctxlaneAuthorityFor(
                ctxlaneRequestForRunmill(role, request),
              );
            }
            return ctxlaneAuthorityFor(
              ctxlaneRequestFor(role, request.requestedProfile),
            );
          },
        } satisfies CtxlaneAcquisitionAuthorityResolver,
        clock,
        ownershipFence: new CurrentFence(),
        profiles: {
          resolve: (binding) =>
            binding.runId === "run_e2e_deterministic_01"
              ? E2E_PROFILES
              : CTXLANE_PROFILES,
        },
        requestedDurationMs: CTXLANE_REQUEST.requested_ttl_seconds * 1_000,
        renewalLeadMs: 60_000,
        fenceCheckIntervalMs: 2_000,
        onAuthorityLost: () => undefined,
      });

      const identityObservation =
        await ctxlaneController.acquireRequiredRoles(ctxlaneEffectInput());
      expect(ctxlaneClient.requests[0]).toEqual(CTXLANE_REQUEST);
      expect(ctxlaneClient.requests).toHaveLength(3);
      expect(ctxlaneClient.requests.map((request) => request.role)).toEqual([
        "implementer",
        "local-reviewer",
        "pr-reviewer",
      ]);
      expect(identityObservation.roles).toEqual([
        "implementer",
        "local-reviewer",
        "pr-reviewer",
      ]);
      expect(JSON.stringify(identityObservation)).not.toContain(
        CTXLANE_ACTIVE.execution_handle!,
      );
      expect(JSON.stringify(identityObservation)).not.toContain(
        CTXLANE_ACTIVE.lease_id,
      );
      const refusedController = createAsfCtxlaneIdentityController({
        client: new RecordingCtxlaneClient(true),
        lifecycleClient: new FixtureLifecycleClient(),
        authority: {
          resolveAcquisitionAuthority: (request) =>
            ctxlaneAuthorityFor(
              ctxlaneRequestFor(
                requiredCtxlaneRole(request.role),
                request.requestedProfile,
              ),
            ),
        },
        clock,
        ownershipFence: new CurrentFence(),
        profiles: { resolve: () => CTXLANE_PROFILES },
        requestedDurationMs: CTXLANE_REQUEST.requested_ttl_seconds * 1_000,
        renewalLeadMs: 60_000,
        fenceCheckIntervalMs: 2_000,
        onAuthorityLost: () => undefined,
      });
      await expect(
        refusedController.acquireRequiredRoles(ctxlaneEffectInput()),
      ).rejects.toThrow(/identity/);

      // The production harness and repository gateway are exercised here as
      // a separate, deterministic host-side seam. The reference assembler
      // intentionally does not synthesize this transport or expose the lease
      // capability to the delivery runner.
      const brokerLifecycle = new FixtureLifecycleClient();
      const broker = new CtxlaneProviderIdentityBroker({
        client: ctxlaneClient,
        lifecycleClient: brokerLifecycle,
        authority: {
          resolveAcquisitionAuthority: (request) =>
            ctxlaneAuthorityFor(
              ctxlaneRequestFor(
                requiredCtxlaneRole(request.role),
                request.requestedProfile,
              ),
            ),
        },
        clock,
        ownershipFence: new CurrentFence(),
      });
      const implementerLease = await broker.acquire({
        runId: CTXLANE_REQUEST.run_id,
        workOrderId: CTXLANE_REQUEST.work_order_id,
        attemptId: CTXLANE_REQUEST.attempt_id,
        role: "implementer",
        requestedProfile: CTXLANE_PROFILES.implementer,
        policyDigest: DIGEST.workOrderPolicy,
        fencingGeneration: 41,
        requestedDurationMs: CTXLANE_REQUEST.requested_ttl_seconds * 1_000,
      });
      // The deterministic fixture has no authenticated lifecycle service. A
      // real broker must therefore refuse every lifecycle operation rather
      // than treating an empty fixture response as authority. This proves
      // the safe unqualified path without implying native provider readiness.
      await expect(broker.renew(implementerLease)).rejects.toMatchObject({
        code: "RM-AUTH-003",
      });
      await expect(
        broker.close(implementerLease, "completed"),
      ).rejects.toMatchObject({ code: "RM-AUTH-003" });
      await expect(
        broker.revoke(implementerLease, "fixture lifecycle unavailable"),
      ).rejects.toMatchObject({ code: "RM-AUTH-003" });
      expect(brokerLifecycle.renewRequests).toHaveLength(1);
      expect(brokerLifecycle.closeRequests).toHaveLength(1);
      expect(brokerLifecycle.revokeRequests).toHaveLength(1);
      expect(brokerLifecycle.closeRequests[0]?.disposition).toBe("completed");
      expect(brokerLifecycle.revokeRequests[0]?.reason).toBe(
        "fixture lifecycle unavailable",
      );
      const sandbox = new DeterministicCredentialFreeSandbox();
      const gateway = new RepositoryToolGateway({
        clock,
        fenceValidator: new CurrentFence(),
        sandbox,
        tools: [referenceReadTool],
        environment: {},
        sensitiveValues: [PROVIDER_CREDENTIAL, implementerLease.executionHandle],
      });
      const transport = new DeterministicProviderTransport();
      const harness = new TrustedProviderHarness({
        backend: "host-credential-harness",
        providerCredential: PROVIDER_CREDENTIAL,
        sessionProtectionKey: PROVIDER_SESSION_KEY,
        clock,
        fenceValidator: new CurrentFence(),
        transport,
        toolGateway: gateway,
        maximums: {
          timeoutMs: 60_000,
          turns: 20,
          inputTokens: 20_000,
          outputTokens: 10_000,
          outputBytes: 131_072,
          costUsd: 20,
          events: 200,
          toolCalls: 10,
        },
      });
      const providerRequest = providerRequestFor(implementerLease);
      const providerExecution = await harness.execute(
        providerRequest,
        implementerLease,
        providerRepositoryAuthority(providerRequest, repoPath),
      );
      expect(providerExecution.result.model_result.status).toBe("success");
      expect(transport.observedCredentials).toEqual([PROVIDER_CREDENTIAL]);
      expect(transport.observedExecutionHandles).toEqual([
        implementerLease.executionHandle,
      ]);
      expect(sandbox.calls).toHaveLength(1);
      expect(sandbox.calls[0]?.isolation.network).toBe("disabled");
      expect(JSON.stringify(providerExecution)).not.toContain(
        PROVIDER_CREDENTIAL,
      );
      expect(JSON.stringify(providerExecution)).not.toContain(
        implementerLease.executionHandle,
      );
      await expect(
        harness.execute(
          {
            ...providerRequest,
            model_request: {
              ...providerRequest.model_request,
              binding: {
                ...providerRequest.model_request.binding,
                candidate_sha: "9".repeat(40),
              },
            },
          },
          implementerLease,
          providerRepositoryAuthority(providerRequest, repoPath),
        ),
      ).rejects.toThrow(/provider invocation refused/);

      // Deterministic structural delivery ports (no GitHub/CI network effects).
      // The workspace and task-packet prefixes below are valid deterministic
      // observations. Later operator-owned ports remain refusal adapters: the
      // qualification gate must stay blocked until production controllers are
      // supplied.
      const refuseReferencePort = (): never => {
        throw new Error("reference delivery port is not qualified");
      };
      const refuseReferenceAsync = async (): Promise<never> => {
        throw new Error("reference delivery port is not qualified");
      };
      const prepareReferenceWorkspace = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["workspace"]["prepare"]
        >[0],
      ) => {
        // The runner's workspace stage now reaches the same deterministic
        // credential-free sandbox contract exercised by the provider/tool
        // seam above. This is a local qualification proof, not a claim that
        // the host has supplied a production workspace controller.
        const sandboxResult = await sandbox.execute({
          sandbox: {
            command: "/bin/echo",
            args: ["workspace-ready"],
            cwd: repoPath,
            timeoutMs: 1_000,
            policy: {
              writablePaths: [repoPath],
              readablePaths: [repoPath],
              allowNetwork: false,
            },
          },
          signal: input.signal,
          limits: {
            cpuMillis: 1_000,
            memoryMib: 128,
            processes: 4,
            fileSizeBytes: 8_388_608,
          },
          isolation: {
            inheritEnvironment: false,
            providerCredentials: "denied",
            hostCredentialPaths: "denied",
            hostSockets: "denied",
            otherWorkspaces: "denied",
            network: "disabled",
            candidate: input.baseSha,
            freshCandidate: false,
          },
        });
        if (sandboxResult.outcome !== "exited" || sandboxResult.exitCode !== 0) {
          throw new AsfDeliveryStop({
            phase: "BLOCKED_EXTERNAL",
            code: "REFERENCE_WORKSPACE_SANDBOX_UNQUALIFIED",
            summary: "reference workspace sandbox did not prove a clean execution",
            retryDisposition: "reconcile-first",
            requiredActor: "platform-operator",
            requiredAction:
              "supply a qualified workspace and sandbox adapter before integrated execution",
            evidenceRefs: [],
          });
        }
        const unsigned = {
          schema: "asf.workspace-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          workspace_id: `workspace-${input.binding.runId}`,
          workspace_path: repoPath,
          base_sha: input.baseSha,
          sandbox_profile: input.sandboxProfile,
          isolation_evidence_digest: sha256Digest({
            mechanism: sandbox.mechanism,
            enforcement: sandbox.enforcement,
            outcome: sandboxResult.outcome,
            exit_code: sandboxResult.exitCode,
          }),
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const observeReferenceWorkspace = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["workspace"]["observeCurrent"]
        >[0],
      ) => {
        const unsigned = {
          schema: "asf.workspace-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          workspace_id: `workspace-${input.binding.runId}`,
          workspace_path: repoPath,
          base_sha: BASE_SHA,
          sandbox_profile: e2ePayload().runtime.sandbox_profile,
          isolation_evidence_digest: sha256Digest({
            workspace_path: repoPath,
            base_sha: BASE_SHA,
          }),
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const taskPacketDigest = sha256Digest({
        schema: "asf.task-packet/v1",
        workOrderId: e2ePayload().work_order_id,
        sourceSnapshotDigest: e2ePayload().source.snapshot_digest,
      });
      const createReferenceTaskPacket = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["taskPacket"]["create"]
        >[0],
      ) => {
        const unsigned = {
          schema: "asf.task-packet-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          task_packet_digest: taskPacketDigest,
          source_snapshot_digest: input.envelope.payload.source.snapshot_digest,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const markReferenceProviderSession = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["implementation"]["markSession"]
        >[0],
      ) => {
        const binding = {
          run_id: input.binding.runId,
          work_order_id: input.binding.workOrderId,
          attempt_id: input.binding.attemptId,
          policy_digest: input.binding.policyDigest,
          fencing_generation: input.binding.fencingGeneration,
          candidate_sha: input.binding.candidateSha,
        } as const;
        const unsigned = {
          schema: "asf.implementer-session-observation/v1" as const,
          binding,
          session: "new" as const,
          checkpoint_digest: sha256Digest({
            task_packet_digest: input.taskPacketDigest,
            starting_sha: input.startingSha,
          }),
          protected_implementer_resume: null,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const createReferenceCandidate = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["implementation"]["createCandidate"]
        >[0],
      ) => {
        const lease = referenceImplementerLease(input.binding);
        const request = providerRequestFor(lease, {
          invocationId: input.invocationId,
          candidateSha: input.startingSha,
          taskPacketDigest: input.taskPacketDigest,
        });
        const providerExecution = await harness.execute(
          request,
          lease,
          providerRepositoryAuthority(request, repoPath),
        );
        const binding = {
          run_id: input.binding.runId,
          work_order_id: input.binding.workOrderId,
          attempt_id: input.binding.attemptId,
          policy_digest: input.binding.policyDigest,
          fencing_generation: input.binding.fencingGeneration,
          candidate_sha: input.binding.candidateSha,
        } as const;
        const unsigned = {
          schema: "asf.candidate-observation/v1" as const,
          binding,
          candidate_sha: PROVIDER_CANDIDATE_SHA,
          parent_sha: input.startingSha,
          tree_digest: sha256Digest({
            candidate_sha: PROVIDER_CANDIDATE_SHA,
            parent_sha: input.startingSha,
            provider_result_digest: providerExecution.result.result_digest,
          }),
          changed_paths: ["src/reference-e2e.ts"],
          provider_execution: providerExecution,
        } as const;
        const evidenceMaterial = {
          schema: unsigned.schema,
          binding: unsigned.binding,
          candidate_sha: unsigned.candidate_sha,
          parent_sha: unsigned.parent_sha,
          tree_digest: unsigned.tree_digest,
          changed_paths: unsigned.changed_paths,
          provider_result_digest: providerExecution.result.result_digest,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(evidenceMaterial),
        };
      };
      const localVerificationCandidateShas: string[] = [];
      const verifyReferenceLocalChecks = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["localVerification"]["verify"]
        >[0],
      ) => {
        localVerificationCandidateShas.push(input.candidateSha);
        const requiredCheckIds = [
          ...e2ePayload().verification.required_local_check_ids,
        ].sort();
        if (
          input.candidateSha !== PROVIDER_CANDIDATE_SHA ||
          input.requiredCheckIds.length !== requiredCheckIds.length ||
          [...input.requiredCheckIds].sort().some(
            (checkId, index) => checkId !== requiredCheckIds[index],
          )
        ) {
          throw new AsfDeliveryStop({
            phase: "BLOCKED_EXTERNAL",
            code: "REFERENCE_LOCAL_VERIFICATION_BINDING_MISMATCH",
            summary:
            "reference local verification received a non-exact candidate or check set",
            retryDisposition: "reconcile-first",
            requiredActor: "platform-operator",
            requiredAction:
              "reconcile the candidate-bound local verification request before retrying",
            evidenceRefs: [],
          });
        }
        const checks = input.requiredCheckIds.map((check_id) => ({
          check_id,
          outcome: "passed" as const,
          evidence_digest: sha256Digest({
            candidate_sha: input.candidateSha,
            check_id,
            outcome: "passed",
          }),
        }));
        const unsigned = {
          schema: "asf.local-verification-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          candidate_sha: input.candidateSha,
          checks,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const reviewReferenceLocal = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["reviewer"]["review"]
        >[0],
      ) => {
        const reviewerRole =
          input.reviewKind === "pull-request" ? "pr-reviewer" : "local-reviewer";
        const lease = referenceLeaseForRole(input.binding, reviewerRole);
        const request = providerRequestFor(lease, {
          invocationId: input.invocationId,
          candidateSha: input.candidateSha,
          taskPacketDigest: input.taskPacketDigest,
        });
        const providerExecution = await harness.execute(
          request,
          lease,
          providerRepositoryAuthority(request, repoPath),
        );
        const binding = {
          run_id: input.binding.runId,
          work_order_id: input.binding.workOrderId,
          attempt_id: input.binding.attemptId,
          policy_digest: input.binding.policyDigest,
          fencing_generation: input.binding.fencingGeneration,
          candidate_sha: input.binding.candidateSha,
        } as const;
        const unsigned = {
          schema: "asf.review-observation/v1" as const,
          binding,
          candidate_sha: input.candidateSha,
          review_kind: input.reviewKind,
          reviewer_attribution: input.reviewerAttribution,
          invocation_id: input.invocationId,
          fresh_context: true as const,
          prior_context_restored: false as const,
          outcome: "approved" as const,
          findings_digest: sha256Digest({
            candidate_sha: input.candidateSha,
            review_kind: input.reviewKind,
            outcome: "approved",
          }),
          provider_execution: providerExecution,
        } as const;
        const evidenceMaterial = {
          schema: unsigned.schema,
          binding: unsigned.binding,
          candidate_sha: unsigned.candidate_sha,
          review_kind: unsigned.review_kind,
          reviewer_attribution: unsigned.reviewer_attribution,
          invocation_id: unsigned.invocation_id,
          fresh_context: unsigned.fresh_context,
          prior_context_restored: unsigned.prior_context_restored,
          outcome: unsigned.outcome,
          findings_digest: unsigned.findings_digest,
          provider_result_digest: providerExecution.result.result_digest,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(evidenceMaterial),
        };
      };
      const proposeReferenceDelivery = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["deliveryProposal"]["propose"]
        >[0],
      ) => {
        const unsigned = {
          schema: "asf.pull-request-delivery-proposal/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          repository: "acme/e2e",
          head_ref: `refs/heads/runmill/${input.binding.runId}`,
          base_ref: "refs/heads/main",
          marker: `runmill-reference-${input.binding.runId}`,
          title: "End-to-end reference qualification exercise",
          body: "Deterministic reference delivery; production qualification remains disabled.",
          draft: false,
        } as const;
        return {
          ...unsigned,
          proposal_digest: sha256Digest(unsigned),
        };
      };
      const githubProtection = {
        required_checks: ["ci/e2e"],
        requires_approval: false,
        requires_conversation_resolution: false,
        uses_merge_queue: false,
      } as const;
      let githubBranchSha: string | null = null;
      let githubPullRequest: {
        readonly repository: string;
        readonly number: number;
        readonly url: string;
        readonly head_ref: string;
        readonly base_ref: string;
        readonly head_sha: string;
        readonly marker: string;
        readonly state: "open";
        readonly draft: false;
      } | null = null;
      const githubAdapter = {
        observeBranch: async (input: {
          readonly repository: string;
          readonly ref: string;
        }) =>
          githubBranchSha === null
            ? {
                state: "absent" as const,
                evidence_digest: sha256Digest({
                  schema: "runmill.github-branch-observation/v1",
                  repository: input.repository,
                  ref: input.ref,
                  state: "absent",
                }),
              }
            : {
                state: "present" as const,
                sha: githubBranchSha,
                evidence_digest: sha256Digest({
                  schema: "runmill.github-branch-observation/v1",
                  repository: input.repository,
                  ref: input.ref,
                  state: "present",
                  sha: githubBranchSha,
                }),
              },
        pushBranch: async (input: { readonly candidateSha: string }) => {
          githubBranchSha = input.candidateSha;
        },
        observePullRequests: async (input: {
          readonly repository: string;
          readonly headRef: string;
          readonly baseRef: string;
          readonly marker: string;
        }) => {
          if (githubPullRequest === null) {
            return {
              state: "absent" as const,
              evidence_digest: sha256Digest({
                schema: "runmill.github-pr-observation/v1",
                repository: input.repository.toLowerCase(),
                head_ref: input.headRef,
                base_ref: input.baseRef,
                marker: input.marker,
                pull_requests: [],
              }),
            };
          }
          const pull_requests = [githubPullRequest];
          return {
            state: "present" as const,
            pull_requests,
            evidence_digest: sha256Digest({
              schema: "runmill.github-pr-observation/v1",
              repository: input.repository.toLowerCase(),
              head_ref: input.headRef,
              base_ref: input.baseRef,
              marker: input.marker,
              pull_requests,
            }),
          };
        },
        observeBaseProtection: async (input: {
          readonly repository: string;
          readonly baseRef: string;
        }) => {
          const protectionDigest = sha256Digest({
            schema: "runmill.github-base-protection/v1",
            repository: input.repository.toLowerCase(),
            base_ref: input.baseRef,
            protection: githubProtection,
          });
          const unsigned = {
            state: "present" as const,
            repository: input.repository.toLowerCase(),
            base_ref: input.baseRef,
            base_sha: OBSERVED_BASE_SHA,
            protection_digest: protectionDigest,
            protection: githubProtection,
          } as const;
          return {
            ...unsigned,
            evidence_digest: sha256Digest({
              schema: "runmill.github-base-protection-observation/v1",
              ...unsigned,
            }),
          };
        },
        createPullRequest: async (input: {
          readonly repository: string;
          readonly headRef: string;
          readonly baseRef: string;
          readonly candidateSha: string;
          readonly marker: string;
          readonly draft: boolean;
        }) => {
          githubPullRequest = {
            repository: input.repository,
            number: 1,
            url: `https://github.com/${input.repository}/pull/1`,
            head_ref: input.headRef,
            base_ref: input.baseRef,
            head_sha: input.candidateSha,
            marker: input.marker,
            state: "open",
            draft: input.draft as false,
          };
        },
      };
      const githubController = new AsfGitHubEffectsController({
        store,
        adapter: githubAdapter,
        clock,
      });
      const observeReferenceCi = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["ci"]["observeExactHead"]
        >[0],
      ) => {
        const checks = input.requiredContexts.map((context) => ({
          context,
          outcome: "passed" as const,
          evidence_digest: sha256Digest({
            schema: "runmill.ci-check-observation/v1",
            repository: input.repository,
            pull_request_number: input.pullRequestNumber,
            candidate_sha: input.candidateSha,
            context,
            outcome: "passed",
          }),
        }));
        const unsigned = {
          schema: "asf.ci-head-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          repository: input.repository,
          pull_request_number: input.pullRequestNumber,
          candidate_sha: input.candidateSha,
          observed_head_sha: input.candidateSha,
          observed_at: NOW,
          checks,
        } as const;
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const referenceEvidenceArtifacts = new Map<string, Uint8Array>();
      const referenceArtifactText = (
        artifactId: string,
        kind: AsfEvidencePredicate["artifacts"][number]["kind"],
        body: string,
      ): AsfEvidencePredicate["artifacts"][number] => {
        const bytes = Buffer.from(body, "utf8");
        const artifactDigest = rawDigest(bytes);
        const prior = referenceEvidenceArtifacts.get(artifactDigest);
        if (prior !== undefined && Buffer.compare(prior, bytes) !== 0) {
          throw new Error(`reference artifact digest collision for ${artifactId}`);
        }
        referenceEvidenceArtifacts.set(artifactDigest, bytes);
        return {
          artifact_id: artifactId,
          kind,
          size_bytes: bytes.byteLength,
          media_type: "application/json",
          digest: artifactDigest,
          retention_class:
            kind === "work-order-envelope" ? "protected" : "portable",
          location_ref: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
        };
      };
      const referenceEvidenceSource: AsfEvidenceFinalizationMaterialSource = {
        async assemble(request): Promise<AsfEvidenceFinalizationMaterial> {
          const eventOf = (type: string) => {
            const event = request.events.filter((candidate) => candidate.type === type).at(-1);
            if (event === undefined) throw new Error(`reference event ${type} is missing`);
            return event;
          };
          const payloadString = (event: ReturnType<typeof eventOf>, key: string): string => {
            const value = event.payload[key];
            if (typeof value !== "string") throw new Error(`reference event field ${key} is missing`);
            return value;
          };
          const candidateEvent = eventOf("candidate.created");
          const deliveredEvent = eventOf("pull_request.delivered");
          const openedEvent = eventOf("pull_request.opened");
          const pullRequestNumber = openedEvent.payload["number"];
          if (typeof pullRequestNumber !== "number") {
            throw new Error("reference pull request number is missing");
          }
          const branchEvent = eventOf("branch.pushed");
          const finalCiEvent = eventOf("ci.revalidated");
          const localReviewEvent = eventOf("review.completed");
          const pullRequestReviewEvent = eventOf("pr_review.completed");
          const identityEvent = eventOf("identity.leases_acquired");
          const candidateSha = request.snapshot.run.candidateSha;
          if (candidateSha === null) throw new Error("reference candidate is missing");
          const treeDigest = payloadString(candidateEvent, "tree_digest");
          const identityValues = identityEvent.payload["attributions"];
          if (!Array.isArray(identityValues)) throw new Error("reference identity attributions are missing");
          const identityAttributions = identityValues as AsfIdentityLeaseAttribution[];
          const roleName = (
            role: AsfIdentityLeaseAttribution["role"],
          ): "implementer" | "local-reviewer" | "pull-request-reviewer" =>
            role === "pr-reviewer" ? "pull-request-reviewer" : role;
          const policy = request.effectivePolicy;
          const requiredLocalCheckIds = [...policy.requiredLocalCheckIds].sort();
          const requiredCiContexts = [...policy.requiredRemoteChecks].sort();
          const changedPaths = ["src/reference-e2e.ts"];
          const normalizedDiffBody = "src/reference-e2e.ts\n";
          const runtimeManifest = {
            schema: "runmill.reference-runtime-manifest/v1",
            sandbox_profile: policy.runtime.sandboxProfile,
            tool_policy: policy.runtime.toolPolicy,
            network_policy: policy.runtime.networkPolicy,
            dependency_digest: sha256Digest("runmill-reference-dependencies/v1"),
          } as const;
          const workOrderArtifact = referenceArtifactText(
            "work-order-envelope",
            "work-order-envelope",
            canonicalJson(request.envelope),
          );
          const policyArtifact = referenceArtifactText(
            "effective-policy",
            "effective-policy",
            canonicalJson(policy as unknown as JsonValue),
          );
          const diffArtifact = referenceArtifactText(
            "normalized-diff",
            "normalized-diff",
            normalizedDiffBody,
          );
          const runtimeArtifact = referenceArtifactText(
            "runtime-manifest",
            "runtime-manifest",
            canonicalJson(runtimeManifest),
          );
          const localCheckEvents = request.events.filter(
            (event) =>
              event.type === "verification.completed" &&
              event.payload["candidate_sha"] === candidateSha &&
              event.payload["outcome"] === "passed",
          );
          const localChecks = requiredLocalCheckIds.map((checkId) => {
            const event = localCheckEvents.find(
              (candidate) => candidate.payload["check_id"] === checkId,
            );
            if (event === undefined) throw new Error(`reference check ${checkId} is missing`);
            const evidenceDigest = payloadString(event, "evidence_digest");
            const checkBody = canonicalJson({
              candidate_sha: candidateSha,
              check_id: checkId,
              outcome: "passed",
            });
            const checkArtifact = referenceArtifactText(
              `check-${checkId}`,
              "verification",
              checkBody,
            );
            if (checkArtifact.digest !== evidenceDigest) {
              throw new Error(`reference check ${checkId} digest is not content-addressed`);
            }
            return {
              check_id: checkId,
              candidate_sha: candidateSha,
              tree_digest: treeDigest,
              command_digest: sha256Digest({ schema: "runmill.reference-command/v1", check_id: checkId }),
              executor_id: "runmill-reference-checks",
              toolchain_digest: sha256Digest("runmill-reference-toolchain/v1"),
              sandbox_profile_digest: sha256Digest(policy.runtime.sandboxProfile),
              started_at: event.occurred_at,
              completed_at: event.occurred_at,
              conclusion: "success" as const,
              coverage: "complete" as const,
              evidence_digest: evidenceDigest,
            };
          });
          const finalChecksRaw = deliveredEvent.payload["final_ci_checks"];
          if (!Array.isArray(finalChecksRaw)) throw new Error("reference final CI checks are missing");
          const finalChecks = finalChecksRaw.map((raw) => {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
              throw new Error("reference final CI check is malformed");
            }
            const check = raw as Record<string, unknown>;
            const context = check["context"];
            const outcome = check["outcome"];
            const evidenceDigest = check["evidence_digest"];
            if (
              typeof context !== "string" ||
              outcome !== "passed" ||
              typeof evidenceDigest !== "string"
            ) {
              throw new Error("reference final CI check is incomplete");
            }
            const checkBody = canonicalJson({
              schema: "runmill.ci-check-observation/v1",
              repository: request.snapshot.run.repo,
              pull_request_number: pullRequestNumber,
              candidate_sha: candidateSha,
              context,
              outcome,
            });
            const checkArtifact = referenceArtifactText(
              `ci-${context.replace(/[^A-Za-z0-9._:-]/gu, "_")}`,
              "ci-observation",
              checkBody,
            );
            if (checkArtifact.digest !== evidenceDigest) {
              throw new Error(`reference CI context ${context} digest is not content-addressed`);
            }
            return {
              context,
              candidate_sha: candidateSha,
              conclusion: "success" as const,
              observed_at: payloadString(finalCiEvent, "observed_at"),
              evidence_digest: evidenceDigest,
            };
          });
          const reviewArtifact = (
            artifactId: string,
            reviewKind: string,
            findingsDigest: string,
          ) =>
            referenceArtifactText(
              artifactId,
              "review",
              canonicalJson({
                schema: "runmill.reference-review-evidence/v1",
                candidate_sha: candidateSha,
                review_kind: reviewKind,
                findings_digest: findingsDigest,
              }),
            );
          const localReviewArtifact = reviewArtifact(
            "local-review",
            "local",
            payloadString(localReviewEvent, "findings_digest"),
          );
          const localFindingsDigest = payloadString(
            localReviewEvent,
            "findings_digest",
          );
          const localFindingsArtifact = referenceArtifactText(
            "local-review-findings",
            "review",
            canonicalJson({
              candidate_sha: candidateSha,
              review_kind: "local",
              outcome: "approved",
            }),
          );
          if (localFindingsArtifact.digest !== localFindingsDigest) {
            throw new Error("reference local review findings are not content-addressed");
          }
          const pullRequestReviewArtifact = reviewArtifact(
            "pull-request-review",
            "pull-request",
            payloadString(pullRequestReviewEvent, "findings_digest"),
          );
          const pullRequestFindingsDigest = payloadString(
            pullRequestReviewEvent,
            "findings_digest",
          );
          const pullRequestFindingsArtifact = referenceArtifactText(
            "pull-request-review-findings",
            "review",
            canonicalJson({
              candidate_sha: candidateSha,
              review_kind: "pull-request",
              outcome: "approved",
            }),
          );
          if (pullRequestFindingsArtifact.digest !== pullRequestFindingsDigest) {
            throw new Error("reference pull-request review findings are not content-addressed");
          }
          const providerArtifacts = identityAttributions.map((attribution) =>
            referenceArtifactText(
              `${roleName(attribution.role)}-outcome`,
              "agent-outcome",
              canonicalJson({
                schema: "runmill.reference-provider-outcome/v1",
                role: roleName(attribution.role),
                candidate_sha: candidateSha,
                attribution_digest: attribution.lease_attribution_digest,
              }),
            ),
          );
          const pushArtifact = referenceArtifactText(
            "branch-push",
            "side-effect",
            canonicalJson({
              schema: "runmill.reference-side-effect/v1",
              effect: "branch.push",
              candidate_sha: candidateSha,
              remote_ref: payloadString(branchEvent, "remote_ref"),
            }),
          );
          const pullRequestArtifact = referenceArtifactText(
            "pull-request-create",
            "side-effect",
            canonicalJson({
              schema: "runmill.reference-side-effect/v1",
              effect: "pull-request.create",
              candidate_sha: candidateSha,
              number: pullRequestNumber,
            }),
          );
          const deliveryArtifact = referenceArtifactText(
            "pull-request-delivery",
            "side-effect",
            canonicalJson({
              schema: "runmill.reference-side-effect/v1",
              effect: "pull-request.observe",
              candidate_sha: candidateSha,
              number: pullRequestNumber,
            }),
          );
          const effectDigest = (kind: string) => sha256Digest({
            schema: "runmill.reference-effect/v1",
            kind,
            candidate_sha: candidateSha,
          });
          const sideEffects = [
            {
              effect_key: effectDigest("branch.push"),
              kind: "branch.push" as const,
              candidate_sha: candidateSha,
              intent_digest: sha256Digest("runmill-reference-branch-intent/v1"),
              observation_digest: sha256Digest("runmill-reference-branch-observation/v1"),
              reconciliation_digest: null,
              confirmation_digest: sha256Digest("runmill-reference-branch-confirmation/v1"),
              status: "confirmed" as const,
              evidence_digest: pushArtifact.digest,
            },
            {
              effect_key: effectDigest("pull-request.create"),
              kind: "pull-request.create" as const,
              candidate_sha: candidateSha,
              intent_digest: sha256Digest("runmill-reference-pr-intent/v1"),
              observation_digest: sha256Digest("runmill-reference-pr-observation/v1"),
              reconciliation_digest: null,
              confirmation_digest: sha256Digest("runmill-reference-pr-confirmation/v1"),
              status: "confirmed" as const,
              evidence_digest: pullRequestArtifact.digest,
            },
          ];
          const providers = identityAttributions.map((attribution) => ({
            role: roleName(attribution.role),
            provider: attribution.provider,
            model: "reference-model",
            principal_id: attribution.principal_id,
            lease_attribution_digest: attribution.lease_attribution_digest,
          }));
          const localReviewFindings = payloadString(localReviewEvent, "findings_digest");
          const pullRequestReviewFindings = payloadString(
            pullRequestReviewEvent,
            "findings_digest",
          );
          const pullRequestUrl = payloadString(openedEvent, "url");
          const artifacts = [
            workOrderArtifact,
            policyArtifact,
            diffArtifact,
            runtimeArtifact,
            ...providerArtifacts,
            ...localChecks.map((check) =>
              referenceEvidenceArtifacts.has(check.evidence_digest)
                ? [...referenceEvidenceArtifacts.entries()].find(([digest]) => digest === check.evidence_digest)
                : undefined,
            ).filter((entry): entry is [string, Uint8Array] => entry !== undefined)
              .map(([digest]) => ({
                artifact_id: `check-${digest.slice(-8)}`,
                kind: "verification" as const,
                size_bytes: referenceEvidenceArtifacts.get(digest)?.byteLength ?? 0,
                media_type: "application/json",
                digest,
                retention_class: "portable" as const,
                location_ref: `cas://sha256/${digest.slice("sha256:".length)}`,
              })),
            ...finalChecks.map((check) =>
              [...referenceEvidenceArtifacts.entries()].find(([digest]) => digest === check.evidence_digest),
            ).filter((entry): entry is [string, Uint8Array] => entry !== undefined)
              .map(([digest]) => ({
                artifact_id: `ci-${digest.slice(-8)}`,
                kind: "ci-observation" as const,
                size_bytes: referenceEvidenceArtifacts.get(digest)?.byteLength ?? 0,
                media_type: "application/json",
                digest,
                retention_class: "portable" as const,
                location_ref: `cas://sha256/${digest.slice("sha256:".length)}`,
              })),
            localReviewArtifact,
            localFindingsArtifact,
            pullRequestReviewArtifact,
            pullRequestFindingsArtifact,
            pushArtifact,
            pullRequestArtifact,
            deliveryArtifact,
          ];
          const statement: AsfEvidenceStatement = {
            _type: IN_TOTO_STATEMENT_V1,
            subject: [{ name: "github:acme/e2e", digest: { sha1: candidateSha } }],
            predicateType: ASF_EVIDENCE_PREDICATE_TYPE,
            predicate: {
              schema: ASF_EVIDENCE_PREDICATE_SCHEMA,
              run: {
                run_id: request.snapshot.run.runId,
                attempt_id: request.snapshot.admission.attemptId,
                work_order_id: request.snapshot.admission.workOrderId,
                completed_at: deliveredEvent.occurred_at,
              },
              work_order: {
                envelope_digest: request.snapshot.admission.envelopeDigest,
                payload_digest: request.snapshot.admission.payloadDigest,
                envelope_artifact_digest: workOrderArtifact.digest,
                signature: {
                  key_id: request.snapshot.admission.signatureKeyId,
                  algorithm: "EdDSA",
                  verified: true,
                },
              },
              policy: {
                effective_policy_digest: policy.digest,
                effective_policy_artifact_digest: policyArtifact.digest,
                inputs: {
                  operator_policy_digest: policy.inputs.operatorPolicy,
                  work_order_policy_digest: policy.inputs.workOrderPolicy,
                  repository_policy_digest: policy.inputs.repositoryPolicy,
                  forge_policy_digest: policy.inputs.forgeProtection,
                },
                required_local_checks: requiredLocalCheckIds,
                required_ci_contexts: requiredCiContexts,
                require_local_review: true,
                require_pull_request_review: true,
              },
              source: {
                forge: request.envelope.payload.repository.forge,
                repository: request.snapshot.run.repo,
                base_ref: request.envelope.payload.repository.base_ref,
                base_sha: request.envelope.payload.repository.base_sha.toLowerCase(),
                candidate_sha: candidateSha,
                remote_head_sha: candidateSha,
                merge_sha: null,
                tree_digest: treeDigest,
                normalized_diff_digest: diffArtifact.digest,
                normalized_diff_artifact_digest: diffArtifact.digest,
                changed_paths: changedPaths,
              },
              runtime: {
                harness_digest: policy.inputs.harness,
                tool_policy_digest: sha256Digest(policy.runtime.toolPolicy),
                sandbox_profile_digest: sha256Digest(policy.runtime.sandboxProfile),
                dependency_digest: runtimeManifest.dependency_digest,
                runtime_digest: sha256Digest(runtimeManifest),
                runtime_manifest_digest: runtimeArtifact.digest,
                providers,
              },
              role_outcomes: providerArtifacts.map((artifact, index) => ({
                role: providers[index]?.role ?? "implementer",
                outcome: index === 0 ? "completed" as const : "passed" as const,
                candidate_sha: candidateSha,
                evidence_digest: artifact.digest,
              })),
              verification: {
                local_checks: localChecks,
                ci_contexts: finalChecks,
              },
              reviews: [
                {
                  review_id: "reference-local-review",
                  stage: "local",
                  reviewer_principal: providers.find((provider) => provider.role === "local-reviewer")?.principal_id ?? "reference-local",
                  reviewer_profile: identityAttributions.find((attribution) => attribution.role === "local-reviewer")?.profile ?? "claude:e2e-local-reviewer",
                  independent: true,
                  candidate_sha: candidateSha,
                  policy_digest: policy.digest,
                  verdict: "pass",
                  findings_digest: localReviewFindings,
                  evidence_digest: localReviewArtifact.digest,
                },
                {
                  review_id: "reference-pull-request-review",
                  stage: "pull-request",
                  reviewer_principal: providers.find((provider) => provider.role === "pull-request-reviewer")?.principal_id ?? "reference-pr-reviewer",
                  reviewer_profile: identityAttributions.find((attribution) => attribution.role === "pr-reviewer")?.profile ?? "claude:e2e-pr-reviewer",
                  independent: true,
                  candidate_sha: candidateSha,
                  policy_digest: policy.digest,
                  verdict: "pass",
                  findings_digest: pullRequestReviewFindings,
                  evidence_digest: pullRequestReviewArtifact.digest,
                },
              ],
              side_effects: sideEffects,
              approvals: [],
              cancellation: null,
              budget: {
                cost_usd: 0,
                agent_invocations: 3,
                fix_iterations: 0,
                elapsed_ms: Math.max(
                  0,
                  Date.parse(deliveredEvent.occurred_at) -
                    Date.parse(request.snapshot.admission.acceptedAt),
                ),
                stop_reason: "pr-delivered",
              },
              delivery: {
                closure_target: "pr",
                satisfied: true,
                pull_request: {
                  forge: request.envelope.payload.repository.forge,
                  repository: request.snapshot.run.repo,
                  number: pullRequestNumber,
                  url: pullRequestUrl,
                  head_ref: payloadString(deliveredEvent, "head_ref"),
                  base_ref: payloadString(deliveredEvent, "base_ref"),
                  head_sha: candidateSha,
                  observed_at: payloadString(deliveredEvent, "observed_at"),
                  evidence_digest: deliveryArtifact.digest,
                },
              },
              artifacts,
            },
          };
          const expectations = {
            runId: request.snapshot.run.runId,
            attemptId: request.snapshot.admission.attemptId,
            workOrderId: request.snapshot.admission.workOrderId,
            workOrderEnvelopeDigest: request.snapshot.admission.envelopeDigest,
            workOrderPayloadDigest: request.snapshot.admission.payloadDigest,
            effectivePolicyDigest: policy.digest,
            forge: request.envelope.payload.repository.forge,
            repository: request.snapshot.run.repo,
            baseRef: request.envelope.payload.repository.base_ref,
            baseSha: request.envelope.payload.repository.base_sha.toLowerCase(),
            candidateSha,
            treeDigest,
            normalizedDiffDigest: diffArtifact.digest,
            changedPaths,
            requiredLocalCheckIds,
            requiredCiContexts,
            requireLocalReview: true,
            requirePullRequestReview: true,
            pullRequest: {
              number: pullRequestNumber,
              url: pullRequestUrl,
              headRef: payloadString(deliveredEvent, "head_ref"),
              baseRef: payloadString(deliveredEvent, "base_ref"),
            },
          };
          return { statement, expectations };
        },
      };
      const referenceSigningKey: AsfEvidenceSigningKey = {
        keyId: "asf-reference-evidence-key",
        privateKey,
        publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
      };
      const referenceEvidenceFinalizer =
        new ProductionAsfEvidenceFinalizationController({
          materialSource: referenceEvidenceSource,
          artifactResolver: {
            async read(input) {
              const expectedLocation =
                `cas://sha256/${input.expectedDigest.slice("sha256:".length)}`;
              if (input.locationRef !== expectedLocation) {
                throw new Error("reference artifact location is not content-addressed");
              }
              const body = referenceEvidenceArtifacts.get(input.expectedDigest);
              if (body === undefined) throw new Error("reference evidence artifact is missing");
              if (body.byteLength > input.maxBytes) {
                throw new Error("reference evidence artifact exceeds the byte limit");
              }
              return body;
            },
          },
          signingKey: referenceSigningKey,
          clock,
          maxArtifactBytes: 64 * 1_024,
          maxTotalArtifactBytes: 1024 * 1024,
        });
      const referenceTerminalFinalizer =
        new ProductionAsfTerminalEvidenceFinalizationController({
          signingKey: referenceSigningKey,
          clock,
        });
      const finalizeReferenceEvidence = referenceEvidenceFinalizer.finalize.bind(
        referenceEvidenceFinalizer,
      );
      const finalizeReferenceTerminalEvidence =
        referenceTerminalFinalizer.finalizeTerminal.bind(
          referenceTerminalFinalizer,
        );
      const cleanupReferenceResources = async (
        input: Parameters<
          NonNullable<AsfReferenceCompositionInput["delivery"]>["cleanup"]["cleanup"]
        >[0],
      ) => {
        const unsigned = {
          schema: "asf.cleanup-observation/v1" as const,
          binding: {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          },
          identity_leases: "released" as const,
          repository_lease: "released" as const,
          workspace: "removed" as const,
          unresolved_effects: 0 as const,
        };
        return {
          ...unsigned,
          evidence_digest: sha256Digest(unsigned),
        };
      };
      const workerId = "worker-e2e-deterministic-01";
      const intents = new StateStoreAsfDeliveryIntentStore(store, workerId);
      const backgroundErrors: unknown[] = [];
      const recovery: AsfRecoveryController = {
        observe: async (input) => {
          const observedAt = clock.now().toISOString();
          const validUntil = new Date(
            clock.now().getTime() + 60_000,
          ).toISOString();
          const checkpointObservation = {
            state: "verified" as const,
            checkpoint_digest: input.checkpoint.checkpoint_digest,
            observed_at: observedAt,
            valid_until: validUntil,
          };
          const ownership = {
            state: "current" as const,
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            worker_id: input.workerId,
            fencing_generation: input.binding.fencingGeneration,
            observed_at: observedAt,
            valid_until: validUntil,
          };
          return {
            schema: ASF_RECOVERY_REQUEST_SCHEMA,
            requesting_worker_id: input.workerId,
            checkpoint: input.checkpoint,
            checkpoint_observation: {
              ...checkpointObservation,
              evidence_digest: sha256Digest(checkpointObservation),
            },
            ownership: {
              ...ownership,
              evidence_digest: sha256Digest(ownership),
            },
            remote_observations: [],
            replay_requested: false,
            actor: { role: "orchestrator" as const, mode: "automatic" as const },
          };
        },
        apply: async (input) => {
          const binding = {
            run_id: input.binding.runId,
            work_order_id: input.binding.workOrderId,
            attempt_id: input.binding.attemptId,
            policy_digest: input.binding.policyDigest,
            fencing_generation: input.binding.fencingGeneration,
            candidate_sha: input.binding.candidateSha,
          };
          const unsigned = {
            schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
            binding,
            checkpoint_digest: input.checkpoint.checkpoint_digest,
            action: input.plan.action,
            completed_takeover_fencing: [...input.plan.requiredTakeoverFencing],
            invalidated_evidence: [...input.plan.invalidatedEvidence],
          };
          return {
            ...unsigned,
            acknowledgement_digest: sha256Digest({
              checkpoint_digest: unsigned.checkpoint_digest,
              action: unsigned.action,
              completed_takeover_fencing:
                unsigned.completed_takeover_fencing,
              invalidated_evidence: unsigned.invalidated_evidence,
            }),
          };
        },
      };
      const deliveryInput: AsfReferenceCompositionInput["delivery"] = {
        intents,
        recovery: {
          observe: recovery.observe,
          apply: recovery.apply,
        },
        recoveryDispatch: {
          dispatch: refuseReferenceAsync,
        },
        repositoryLease: {
          acquire: async (input) => {
            const binding = {
              run_id: input.binding.runId,
              work_order_id: input.binding.workOrderId,
              attempt_id: input.binding.attemptId,
              policy_digest: input.binding.policyDigest,
              fencing_generation: input.binding.fencingGeneration,
              candidate_sha: input.binding.candidateSha,
            } as const;
            const observation = {
              schema: "asf.repository-lease-observation/v1" as const,
              binding,
              repository: "acme/e2e",
              lease_generation: input.binding.fencingGeneration,
            };
            return {
              ...observation,
              evidence_digest: sha256Digest(observation),
            };
          },
        },
        identities: ctxlaneController,
        workspace: {
          prepare: prepareReferenceWorkspace,
          observeCurrent: observeReferenceWorkspace,
        },
        taskPacket: { create: createReferenceTaskPacket },
        implementation: {
          markSession: markReferenceProviderSession,
          createCandidate: createReferenceCandidate,
          captureProtectedResume: async () => null,
        },
        localVerification: {
          verify: verifyReferenceLocalChecks,
        },
        reviewer: {
          review: reviewReferenceLocal,
        },
        invalidation: {
          invalidate: refuseReferenceAsync,
        },
        deliveryProposal: {
          propose: proposeReferenceDelivery,
        },
        github: {
          ensureBranch: githubController.ensureBranch.bind(githubController),
          ensurePullRequest:
            githubController.ensurePullRequest.bind(githubController),
          observeFinalDelivery:
            githubController.observeFinalDelivery.bind(githubController),
        },
        ci: {
          observeExactHead: observeReferenceCi,
        },
        evidence: {
          finalize: finalizeReferenceEvidence,
        },
        terminalEvidence: {
          finalizeTerminal: finalizeReferenceTerminalEvidence,
        },
        cleanup: {
          cleanup: cleanupReferenceResources,
        },
        budget: new StateStoreAsfProviderBudgetController(store, workerId),
      };

      // Deterministic service controls
      const controls: AsfReferenceCompositionInput["controls"] = {
        admission,
        cancellation: { request: refuseReferencePort },
        approval: { record: refuseReferencePort },
        evidence: { getEvidence: refuseReferencePort },
        reconciliation: {
          request: refuseReferencePort,
          recover: () => 0,
          bindDurableContinuationHandler: () => undefined,
        },
        outcome: { acknowledge: refuseReferencePort },
        health: { getHealth: refuseReferenceAsync },
      };

      // Deterministic shutdown controller
      const shutdown = {
        stopReconciliation: async () => undefined,
        retireIdentities: async () => undefined,
        cleanupResources: async () => undefined,
      };

      // Assemble real reference composition
      const input: AsfReferenceCompositionInput = {
        schema: ASF_REFERENCE_COMPOSITION_SCHEMA,
        classification: "reference-integration-boundary",
        productionQualified: false,
        mode: "asf-worker",
        store,
        clock,
        telemetry,
        workerId,
        delivery: deliveryInput,
        worker: {
          staleOwnershipMs: 30_000,
          onBackgroundError: (error) => backgroundErrors.push(error),
        },
        controls,
        shutdown,
        host: {
          repoRoot: root,
          configPath: join(root, "asf-e2e.json"),
          startedAt: NOW,
          controlAuthentication: { verify: async () => undefined },
          readiness: () => {
            throw new Error("readiness not invoked during composition");
          },
        },
      };

      const options = createAsfReferenceWorkerHostOptions(input);

      // The assembled ports are deterministic reference evidence only. The
      // qualification gate must still refuse a live integrated run until the
      // authenticated ctxlane service/lifecycle and operator-owned production
      // transport are supplied.
      const integratedPreflight = evaluateAsfQualificationPreflight({
        schema: ASF_QUALIFICATION_PREFLIGHT_INPUT_SCHEMA,
        target: "integrated",
        execute: true,
        platform: "linux",
      });
      expect(integratedPreflight).toMatchObject({
        decision: "blocked",
        readyToRun: false,
        productionQualified: false,
      });
      expect(integratedPreflight.reasons).toEqual(
        expect.arrayContaining([
          "ctxlane.authenticated-service-unavailable",
          "ctxlane.lifecycle-unavailable",
          "integrated.reference-path-unavailable",
        ]),
      );

      // Submit through the assembled service. The deterministic direct
      // identity proof above is kept separate so the requests below prove the
      // runner's exact ctxlane binding rather than the fixture-only path.
      const envelope = e2eEnvelope();
      ctxlaneClient.requests.length = 0;
      ctxlaneClient.responses.length = 0;
      const submitted = await options.service.submitWorkOrder(envelope);
      expect(submitted).toMatchObject({
        runId: "run_e2e_deterministic_01",
        disposition: "accepted",
        payloadDigest: sha256Digest(envelope.payload),
      });
      // Let the worker's queued pump claim the durable run before asking the
      // assembled service to stop; requestStop itself intentionally drains
      // queued-but-not-active work.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Admission remains durable while the assembled runner advances through
      // its first safe boundaries.
      const admittedSnapshot = options.service.getRun(
        "run_e2e_deterministic_01",
      );
      expect(admittedSnapshot).toMatchObject({
        run: {
          runId: "run_e2e_deterministic_01",
          mode: "asf-worker",
        },
        admission: {
          idempotencyKey: envelope.payload.idempotency_key,
          payloadDigest: sha256Digest(envelope.payload),
          envelopeDigest: sha256Digest(envelope),
        },
      });

      // Verify exact digest lookup (recovery after response loss) - before closing
      const lookup = options.service.lookupSubmission({
        idempotencyKey: envelope.payload.idempotency_key,
        payloadDigest: sha256Digest(envelope.payload),
        envelopeDigest: sha256Digest(envelope),
      });
      expect(lookup).toMatchObject({
        disposition: "found",
        snapshot: {
          run: { runId: "run_e2e_deterministic_01" },
          admission: {
            payloadDigest: sha256Digest(envelope.payload),
            envelopeDigest: sha256Digest(envelope),
          },
        },
      });

      // Tampered digest lookup must fail (binding proof)
      const tampered = options.service.lookupSubmission({
        idempotencyKey: envelope.payload.idempotency_key,
        payloadDigest: `sha256:${"x".repeat(64)}`,
        envelopeDigest: sha256Digest(envelope),
      });
      expect(tampered).toEqual({ disposition: "not-found" });

      // requestStop waits for the active runner. The deterministic reference
      // source now drives the same signed delivery and terminal evidence
      // controllers used by a production composition.
      await expect(options.service.requestStop()).resolves.toBeUndefined();
      expect(backgroundErrors).toEqual([]);
      const completedSnapshot = options.service.getRun(
        "run_e2e_deterministic_01",
      );
      expect(completedSnapshot).toMatchObject({
        run: {
          runId: "run_e2e_deterministic_01",
          mode: "asf-worker",
          state: "COMPLETED",
          ownerId: null,
          candidateSha: PROVIDER_CANDIDATE_SHA,
        },
        admission: {
          idempotencyKey: envelope.payload.idempotency_key,
          payloadDigest: sha256Digest(envelope.payload),
          envelopeDigest: sha256Digest(envelope),
        },
      });
      expect(localVerificationCandidateShas).toEqual([
        PROVIDER_CANDIDATE_SHA,
      ]);

      expect(ctxlaneClient.requests).toHaveLength(3);
      expect(ctxlaneClient.requests.map((request) => request.role)).toEqual([
        "implementer",
        "local-reviewer",
        "pr-reviewer",
      ]);
      expect(
        ctxlaneClient.requests.every(
          (request) =>
            request.run_id === "run_e2e_deterministic_01" &&
            request.work_order_id === envelope.payload.work_order_id &&
            request.attempt_id === envelope.payload.attempt_id &&
            request.repository === "github:acme/e2e" &&
          request.workspace_id === "workspace-run_e2e_deterministic_01",
        ),
      ).toBe(true);
      const signedRunmillRequest = ctxlaneClient.requests[0];
      if (signedRunmillRequest === undefined) {
        throw new Error("reference ctxlane request was not recorded");
      }
      expect(
        verifyBytes(
          null,
          ctxlaneAuthorizationSigningPayload(
            signedRunmillRequest.work_order_authorization,
          ),
          publicKey,
          Buffer.from(
            signedRunmillRequest.work_order_authorization.signature,
            "base64url",
          ),
        ),
      ).toBe(true);
      expect(sandbox.calls).toHaveLength(5);
      expect(transport.calls).toHaveLength(4);
      expect(transport.observedCredentials).toHaveLength(4);
      expect(transport.observedExecutionHandles).toHaveLength(4);

      const events = options.service.listRunEvents(
        "run_e2e_deterministic_01",
      ).events;
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "repository.lease_acquired",
          "identity.leases_acquired",
          "workspace.prepared",
          "task_packet.created",
          "verification.started",
          "verification.completed",
          "review.started",
          "review.completed",
          "branch.pushed",
          "pull_request.opened",
          "ci.completed",
          "pr_review.started",
          "pr_review.completed",
          "ci.revalidated",
          "pull_request.delivered",
          "evidence.finalized",
          "run.completed",
        ]),
      );
      const completedEvent = events.find(
        (event) => event.type === "run.completed",
      );
      expect(completedEvent?.payload).toMatchObject({
        candidate_sha: PROVIDER_CANDIDATE_SHA,
      });
      expect(store.getAsfEvidenceBundleRecord("run_e2e_deterministic_01"))
        .toBeDefined();
      expect(
        store.getAsfTerminalEvidenceBundleRecord("run_e2e_deterministic_01"),
      ).toBeDefined();
      const evidence = new AsfEvidenceReadService(store).getEvidence(
        "run_e2e_deterministic_01",
      );
      expect(evidence).toMatchObject({
        status: "final",
        complete: true,
        phase: "COMPLETED",
        candidateSha: PROVIDER_CANDIDATE_SHA,
      });
      expect(evidence.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(evidence.terminalBundleDigest).toMatch(
        /^sha256:[0-9a-f]{64}$/u,
      );
      expect(evidence.signedBundle).not.toBeNull();
      expect(evidence.signedTerminalBundle).not.toBeNull();
      const verificationEvents = events.filter(
        (event) => event.type === "verification.completed",
      );
      expect(verificationEvents).toHaveLength(2);
      expect(verificationEvents.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            candidate_sha: PROVIDER_CANDIDATE_SHA,
            check_id: "unit",
            outcome: "passed",
          }),
          expect.objectContaining({
            candidate_sha: PROVIDER_CANDIDATE_SHA,
            check_id: "lint",
            outcome: "passed",
          }),
        ]),
      );
      expect(JSON.stringify(events)).not.toContain(
        CTXLANE_ACTIVE.execution_handle!,
      );
      expect(JSON.stringify(events)).not.toContain(PROVIDER_CREDENTIAL);

      // Close and reopen StateStore to prove the completed checkpoint, exact
      // admission binding, and prior observations survive recovery.
      store.close();
      const reopened = StateStore.open(databasePath, { clock });

      const recoveredSnapshot = reopened.getAsfRunSnapshot(
        "run_e2e_deterministic_01",
      );
      expect(recoveredSnapshot).toMatchObject({
        run: {
          runId: "run_e2e_deterministic_01",
          mode: "asf-worker",
          state: "COMPLETED",
          ownerId: null,
          candidateSha: PROVIDER_CANDIDATE_SHA,
        },
        admission: {
          idempotencyKey: envelope.payload.idempotency_key,
          payloadDigest: sha256Digest(envelope.payload),
          envelopeDigest: sha256Digest(envelope),
        },
      });
      expect(
        reopened
          .listAsfRunEvents("run_e2e_deterministic_01")
          .events.map((event) => event.type),
      ).toEqual(
        expect.arrayContaining([
          "repository.lease_acquired",
          "identity.leases_acquired",
          "workspace.prepared",
          "task_packet.created",
          "verification.started",
          "verification.completed",
          "review.started",
          "evidence.finalized",
          "run.completed",
        ]),
      );
      expect(reopened.getAsfEvidenceBundleRecord("run_e2e_deterministic_01"))
        .toBeDefined();
      expect(
        reopened.getAsfTerminalEvidenceBundleRecord("run_e2e_deterministic_01"),
      ).toBeDefined();
      const recoveredEvidence = new AsfEvidenceReadService(reopened).getEvidence(
        "run_e2e_deterministic_01",
      );
      expect(recoveredEvidence).toMatchObject({
        status: "final",
        complete: true,
        bundleDigest: evidence.bundleDigest,
        terminalBundleDigest: evidence.terminalBundleDigest,
      });

      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
