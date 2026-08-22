import Database from "better-sqlite3";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EFFECTIVE_POLICY_SCHEMA,
  WORK_ORDER_ENVELOPE_SCHEMA,
  WORK_ORDER_SCHEMA,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "../../src/asf/work-order.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import {
  AsfApprovalService,
  approvalSigningPayload,
  validateApproval,
  type ApprovalEnvelope,
} from "../../src/asf/approval.js";
import { AsfCancellationService } from "../../src/asf/cancellation.js";
import { AsfEvidenceReadService } from "../../src/asf/evidence-service.js";
import { StateStoreAsfDeliveryReconciliationObserver } from "../../src/asf/state-delivery-intent-store.js";
import type { RunEventPhase } from "../../src/asf/run-event.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { MIGRATIONS } from "../../src/state/migrations.js";
import {
  CURRENT_SCHEMA_VERSION,
  MIN_ASF_DETAILED_EVENT_RETENTION_MS,
  StateStore,
  type AsfAtomicCheckpointInput,
  type StateAsfDeliveryStageIntent,
} from "../../src/state/store.js";
import {
  ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
  ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
  ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
  asfTerminalEvidencePlanSchema,
  asfTerminalEvidenceStatementSchema,
  portableAsfTerminalProviderBudgetEvidence,
  signAsfTerminalEvidenceBundle,
  type AsfTerminalPhase,
  validateSignedAsfTerminalEvidenceBundle,
} from "../../src/evidence/asf-terminal.js";
import { IN_TOTO_STATEMENT_V1 } from "../../src/evidence/asf-bundle.js";

const NOW = "2026-08-21T10:05:00.000Z";
const BASE_SHA = "a".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const FINAL_PROTECTION = {
  required_checks: ["ci/test"],
  requires_approval: false,
  requires_conversation_resolution: false,
  uses_merge_queue: false,
} as const;
const FINAL_PROTECTION_DIGEST = sha256Digest({
  schema: "runmill.github-base-protection/v1",
  repository: "acme/payments",
  base_ref: "refs/heads/main",
  protection: FINAL_PROTECTION,
});

function identityAttributions(fencingGeneration = 1) {
  return [
    {
      schema: "asf.identity-lease-attribution/v1" as const,
      role: "implementer" as const,
      provider: "codex",
      principal_id: "principal-implementer",
      profile: "profile-implementer",
      fencing_generation: fencingGeneration,
      issued_at: "2026-08-21T10:00:00.000Z",
      expires_at: "2026-08-21T11:00:00.000Z",
      lease_attribution_digest: DIGEST_A,
    },
    {
      schema: "asf.identity-lease-attribution/v1" as const,
      role: "local-reviewer" as const,
      provider: "claude",
      principal_id: "principal-local-reviewer",
      profile: "profile-local-reviewer",
      fencing_generation: fencingGeneration,
      issued_at: "2026-08-21T10:00:00.000Z",
      expires_at: "2026-08-21T11:00:00.000Z",
      lease_attribution_digest: DIGEST_B,
    },
    {
      schema: "asf.identity-lease-attribution/v1" as const,
      role: "pr-reviewer" as const,
      provider: "claude",
      principal_id: "principal-pr-reviewer",
      profile: "profile-pr-reviewer",
      fencing_generation: fencingGeneration,
      issued_at: "2026-08-21T10:00:00.000Z",
      expires_at: "2026-08-21T11:00:00.000Z",
      lease_attribution_digest: DIGEST_C,
    },
  ];
}

let directory: string;
let clock: FakeClock;
const openStores = new Set<StateStore>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-asf-admission-"));
  clock = new FakeClock(NOW);
});

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  return join(directory, "runmill.db");
}

function open(): StateStore {
  const store = StateStore.open(databasePath(), { clock });
  openStores.add(store);
  return store;
}

function close(store: StateStore): void {
  store.close();
  openStores.delete(store);
}

function workOrderEnvelope(
  overrides: {
    readonly workOrderId?: string;
    readonly attemptId?: string;
    readonly idempotencyKey?: string;
    readonly title?: string;
    readonly signature?: string;
  } = {},
): WorkOrderEnvelope {
  return {
    schema: WORK_ORDER_ENVELOPE_SCHEMA,
    key_id: "asf-signing-key-2026-01",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:00:00Z",
    not_before: "2026-08-21T10:00:00Z",
    expires_at: "2026-08-21T10:15:00Z",
    payload: {
      schema: WORK_ORDER_SCHEMA,
      work_order_id: overrides.workOrderId ?? "wo_01",
      tenant_id: "tenant-acme",
      work_item_id: "ENG-123",
      attempt_id: overrides.attemptId ?? "attempt_01",
      idempotency_key:
        overrides.idempotencyKey ?? "tenant-acme/ENG-123/attempt_01",
      source: {
        system: "linear",
        external_id: "ENG-123",
        snapshot_digest: DIGEST_A,
      },
      repository: {
        forge: "github",
        repository: "acme/payments",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: overrides.title ?? "Make delivery durable",
        description: "Implement the accepted delivery contract.",
        acceptance_criteria: ["The exact candidate is verified."],
        non_goals: ["Deploying the candidate."],
      },
      scope: {
        allowed_paths: ["src/**", "test/**"],
        forbidden_paths: [".github/**", ".runmill/**"],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["lint", "unit"],
        required_remote_checks: ["ci/test"],
        policy_snapshot_digest: DIGEST_B,
      },
      identities: {
        implementer: "codex:asf-production",
        local_reviewer: "claude:asf-review",
        pr_reviewer: "claude:asf-review",
      },
      runtime: {
        sandbox_profile: "linux-production-v1",
        tool_policy: "repo-change-v1",
        network_policy: "provider-only-v1",
      },
      budgets: {
        wall_seconds: 7_200,
        max_cost_usd: 10,
        max_agent_invocations: 12,
        max_fix_iterations: 3,
      },
      delivery: {
        closure_target: "pr",
        draft_pr: false,
        merge_policy_ref: null,
      },
      policy_digest: DIGEST_C,
      harness_digest: DIGEST_D,
    },
    signature: overrides.signature ?? "base64url:c2lnbmF0dXJl",
  };
}

function effectivePolicy(): EffectiveAsfPolicy {
  return {
    schema: EFFECTIVE_POLICY_SCHEMA,
    digest: DIGEST_D,
    inputs: {
      operatorPolicy: DIGEST_A,
      workOrderPolicy: DIGEST_B,
      workOrderPayload: DIGEST_C,
      harness: DIGEST_D,
      repositoryPolicy: DIGEST_C,
      repositoryPolicyBaseSha: BASE_SHA,
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: "Y2hlY2tzOiBbXQo=",
      observedBaseSha: "b".repeat(40),
      forgeProtection: FINAL_PROTECTION_DIGEST,
      forgeProtectionBaseRef: "refs/heads/main",
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [
      {
        source: "operator",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      {
        source: "work-order",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      {
        source: "repository",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
    ],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["lint", "unit"],
    requiredRemoteChecks: ["ci/test"],
    riskClass: "low",
    identities: {
      implementer: "codex:asf-production",
      localReviewer: "claude:asf-review",
      prReviewer: "claude:asf-review",
    },
    runtime: {
      sandboxProfile: "linux-production-v1",
      toolPolicy: "repo-change-v1",
      networkPolicy: "provider-only-v1",
    },
    budgets: {
      wallSeconds: 7_200,
      maxCostUsd: 10,
      maxAgentInvocations: 12,
      maxFixIterations: 3,
    },
    delivery: { closureTarget: "pr", draftPr: false },
  };
}

type AdmissionInput = Parameters<StateStore["admitAsfWorkOrder"]>[0];

function admissionInput(
  runId: string,
  envelope = workOrderEnvelope(),
): AdmissionInput {
  return {
    runId,
    envelope,
    canonicalEnvelope: canonicalJson(envelope),
    envelopeDigest: sha256Digest(envelope),
    payloadDigest: sha256Digest(envelope.payload),
    effectivePolicy: effectivePolicy(),
  };
}

function expectIdempotencyConflict(action: () => unknown): void {
  try {
    action();
    expect.unreachable("expected ASF admission to refuse the conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe("RM-WO-003");
  }
}

function cleanupCheckpoint(label: string): AsfAtomicCheckpointInput {
  return {
    kind: "lease-release-workspace-cleanup",
    durableInputs: { terminal_outcome: label },
    durableOutputs: { cleanup_evidence_digest: DIGEST_D },
    correlationMarker: null,
  };
}

function stageCheckpoint(
  eventType: string,
): AsfAtomicCheckpointInput | undefined {
  const kind = {
    "repository.lease_acquired": "repository-lease-acquisition",
    "identity.leases_acquired": "identity-lease-acquisition",
    "workspace.prepared": "workspace-sandbox-proof",
    "task_packet.created": "task-packet-creation",
    "implementation.started": "implementer-session-marker",
    "candidate.created": "candidate-commit-creation",
    "review.completed": "local-review-fixer-iteration",
    "branch.pushed": "branch-push-intent-observation",
    "pull_request.opened": "pull-request-intent-observation",
    "ci.completed": "ci-reconciliation-snapshot",
    "ci.recheck_completed": "ci-reconciliation-snapshot",
    "pr_review.completed": "pr-review-fixer-iteration",
    "ci.revalidated": "pr-review-fixer-iteration",
    "evidence.finalized": "evidence-finalization-acknowledgement",
  }[eventType] as AsfAtomicCheckpointInput["kind"] | undefined;
  return kind === undefined
    ? undefined
    : {
        kind,
        durableInputs: { event_type: eventType },
        durableOutputs: { evidence_digest: DIGEST_D },
        correlationMarker: null,
      };
}

function exactDeliveryIntent(input: {
  readonly runId: string;
  readonly generation: number;
  readonly eventSeq: number;
  readonly stage: StateAsfDeliveryStageIntent["stage"];
  readonly candidateSha: string | null;
  readonly operation: JsonValue;
}): StateAsfDeliveryStageIntent {
  const operationDigest = sha256Digest(input.operation);
  const effectKey = `delivery_effect_${sha256Digest({
    stage: input.stage,
    run_id: input.runId,
    candidate_sha: input.candidateSha,
    event_seq: input.eventSeq,
    operation_digest: operationDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const identityDigest = sha256Digest({
    effect_key: effectKey,
    generation: input.generation,
  });
  const unsigned = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: `delivery_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    effect_key: effectKey,
    stage: input.stage,
    run_id: input.runId,
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    policy_digest: DIGEST_D,
    fencing_generation: input.generation,
    candidate_sha: input.candidateSha,
    event_seq: input.eventSeq,
    operation_digest: operationDigest,
    created_at: NOW,
  };
  return { ...unsigned, intent_digest: sha256Digest(unsigned) };
}

function prepareTerminalEvidence(input: {
  readonly store: StateStore;
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly terminalPhase: AsfTerminalPhase;
  readonly stop: {
    readonly code: string;
    readonly summary: string;
    readonly interruptedPhase: string;
    readonly retryDisposition:
      | "safe"
      | "reconcile-first"
      | "new-attempt-required"
      | "prohibited";
    readonly requiredActor:
      | "asf"
      | "repository-owner"
      | "platform-operator"
      | "security"
      | "provider-administrator";
    readonly requiredAction: string;
    readonly evidenceRefs: readonly string[];
  };
  readonly cleanupDigest?: string;
  readonly afterPlan?: (input: {
    readonly planDigest: string;
    readonly cleanupIntent: StateAsfDeliveryStageIntent;
  }) => void;
}) {
  const cleanupDigest = input.cleanupDigest ?? DIGEST_D;
  const run = input.store.getAsfRun(input.runId);
  const admission = input.store.getAsfAdmissionForRun(input.runId);
  if (run === undefined || admission === undefined || run.baseCommit === null) {
    throw new Error("terminal fixture has no run admission");
  }
  const providerBudget = portableAsfTerminalProviderBudgetEvidence(
    input.store.prepareAsfTerminalProviderBudgetEvidence({
      runId: input.runId,
      ownerId: input.ownerId,
      generation: input.generation,
    }),
  );
  const sideEffects = input.store.prepareAsfTerminalEffectLedger({
    runId: input.runId,
  });
  const unsignedPlan = {
    schema: ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
    run: {
      run_id: input.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      terminal_phase: input.terminalPhase,
      terminal_event_seq: run.stateVersion + 1,
    },
    admission: {
      work_order_envelope_digest: admission.envelopeDigest,
      work_order_payload_digest: admission.payloadDigest,
      effective_policy_digest: admission.effectivePolicyDigest,
    },
    source: {
      repository: run.repo.toLowerCase(),
      base_sha: run.baseCommit,
      candidate_sha: run.candidateSha,
    },
    stop: {
      code: input.stop.code,
      summary: input.stop.summary,
      interrupted_phase: input.stop.interruptedPhase,
      retry_disposition: input.stop.retryDisposition,
      required_actor: input.stop.requiredActor,
      required_action: input.stop.requiredAction,
      evidence_refs: [...input.stop.evidenceRefs],
    },
    provider_budget: providerBudget,
    side_effects: sideEffects,
    cleanup: {
      identity_leases: "released" as const,
      repository_lease: "released" as const,
      workspace: "removed" as const,
      unresolved_effects: 0 as const,
    },
    delivery_bundle_digest: null,
    created_at: NOW,
  } as const;
  const plan = asfTerminalEvidencePlanSchema.parse({
    ...unsignedPlan,
    plan_digest: sha256Digest(unsignedPlan),
  });
  const cleanupIntent = exactDeliveryIntent({
    runId: input.runId,
    generation: input.generation,
    eventSeq: run.stateVersion,
    stage: "cleanup",
    candidateSha: run.candidateSha,
    operation: unsignedPlan,
  });
  input.store.recordAsfTerminalCleanupPlan({
    ownerId: input.ownerId,
    cleanupIntent,
    plan,
  });
  input.afterPlan?.({ planDigest: plan.plan_digest, cleanupIntent });
  const cleanupObservation = {
    schema: "asf.cleanup-observation/v1" as const,
    binding: {
      run_id: input.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      policy_digest: admission.effectivePolicyDigest,
      fencing_generation: input.generation,
      candidate_sha: run.candidateSha,
    },
    evidence_digest: cleanupDigest,
    identity_leases: "released" as const,
    repository_lease: "released" as const,
    workspace: "removed" as const,
    unresolved_effects: 0 as const,
  };
  const sealed = input.store.sealAsfTerminalEvidenceIntent({
    runId: input.runId,
    planDigest: plan.plan_digest,
    cleanupObservation,
    ownerId: input.ownerId,
    generation: input.generation,
  });
  const events = input.store.listAsfRunEvents(input.runId, 0, 1_000).events;
  const effectiveCancellation = events
    .filter(
      (event) =>
        event.type === "cancellation.requested" ||
        event.type === "cancellation.escalated",
    )
    .at(-1);
  const cancellation = (() => {
    if (input.terminalPhase !== "CANCELLED") return null;
    const requestId = effectiveCancellation?.payload["request_id"];
    const requester = effectiveCancellation?.payload["requester"];
    const reason = effectiveCancellation?.payload["reason"];
    const mode = effectiveCancellation?.payload["mode"];
    const graceSeconds = effectiveCancellation?.payload["grace_seconds"];
    if (
      effectiveCancellation === undefined ||
      (effectiveCancellation.type !== "cancellation.requested" &&
        effectiveCancellation.type !== "cancellation.escalated") ||
      typeof requestId !== "string" ||
      typeof requester !== "string" ||
      typeof reason !== "string" ||
      !reason.startsWith("protected:") ||
      (mode !== "graceful" && mode !== "forced") ||
      typeof graceSeconds !== "number"
    ) {
      throw new Error("terminal fixture has no effective cancellation event");
    }
    return {
      request_id: requestId,
      event_type: effectiveCancellation.type,
      requester_subject: requester,
      reason_digest: reason.slice("protected:".length),
      mode,
      grace_seconds: graceSeconds,
      requested_at: effectiveCancellation.occurred_at,
      event_digest: sha256Digest(effectiveCancellation),
    };
  })();
  const subjectSha = run.candidateSha ?? run.baseCommit;
  const statement = asfTerminalEvidenceStatementSchema.parse({
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: `asf-run:${input.runId}`, digest: { sha1: subjectSha } }],
    predicateType: ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
      run: {
        run_id: input.runId,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        terminal_phase: input.terminalPhase,
        terminal_event_seq: run.stateVersion + 1,
      },
      admission: {
        work_order_envelope_digest: admission.envelopeDigest,
        work_order_payload_digest: admission.payloadDigest,
        effective_policy_digest: admission.effectivePolicyDigest,
        work_order_envelope: JSON.parse(
          admission.canonicalEnvelope,
        ) as JsonValue,
        signature_verification: {
          verified: true,
          key_id: admission.signatureKeyId,
          algorithm: admission.signatureAlgorithm,
        },
        effective_policy: JSON.parse(admission.effectivePolicy) as JsonValue,
      },
      source: {
        repository: run.repo.toLowerCase(),
        base_sha: run.baseCommit,
        candidate_sha: run.candidateSha,
        subject_kind: run.candidateSha === null ? "base" : "candidate",
        subject_sha: subjectSha,
      },
      stop: {
        code: input.stop.code,
        summary: input.stop.summary,
        interrupted_phase: input.stop.interruptedPhase,
        retry_disposition: input.stop.retryDisposition,
        required_actor: input.stop.requiredActor,
        required_action: input.stop.requiredAction,
        evidence_refs: input.stop.evidenceRefs,
      },
      cancellation,
      budget: {
        wall_seconds_limit: 7_200,
        max_cost_usd: 10,
        max_agent_invocations: 12,
        max_fix_iterations: 3,
        observed_fix_iterations: 0,
        evidence_refs: [],
        provider_usage: providerBudget,
      },
      side_effects: sideEffects,
      timing: sealed.intent.timing,
      cleanup: {
        intent_id: cleanupIntent.intent_id,
        intent_digest: cleanupIntent.intent_digest,
        observation_digest: cleanupDigest,
        identity_leases: "released",
        repository_lease: "released",
        workspace: "removed",
        unresolved_effects: 0,
      },
      evidence: {
        preceding_event_count: events.length,
        preceding_event_chain_digest: sha256Digest(events),
        observations: events.map((event) => ({
          event_seq: event.seq,
          event_type: event.type,
          phase: event.phase,
          candidate_sha:
            typeof event.payload["candidate_sha"] === "string"
              ? event.payload["candidate_sha"]
              : null,
          event_digest: sha256Digest(event),
          evidence_refs: [],
        })),
        events,
        delivery_bundle_digest: null,
      },
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bundle = signAsfTerminalEvidenceBundle({
    statement,
    keyId: "terminal-fixture-key",
    privateKey,
    issuedAt: sealed.intent.created_at,
  });
  const validated = validateSignedAsfTerminalEvidenceBundle(bundle, {
    clock,
    trustedSigners: [
      {
        keyId: "terminal-fixture-key",
        publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
      },
    ],
    expected: {
      runId: input.runId,
      workOrderId: admission.workOrderId,
      attemptId: admission.attemptId,
      workOrderEnvelopeDigest: admission.envelopeDigest,
      workOrderPayloadDigest: admission.payloadDigest,
      effectivePolicyDigest: admission.effectivePolicyDigest,
      repository: run.repo.toLowerCase(),
      baseSha: run.baseCommit,
      candidateSha: run.candidateSha,
      terminalPhase: input.terminalPhase,
      terminalEventSeq: run.stateVersion + 1,
      cleanupObservationDigest: cleanupDigest,
      deliveryBundleDigest: null,
      precedingEventChainDigest: sha256Digest(events),
      providerBudget,
      sideEffects,
      admittedAt: admission.acceptedAt,
      terminalEvidenceAt: sealed.intent.created_at,
      elapsedMs:
        Date.parse(sealed.intent.created_at) - Date.parse(admission.acceptedAt),
    },
  });
  const stored = input.store.recordAsfTerminalEvidenceBundle({
    validated,
    ownerId: input.ownerId,
    generation: input.generation,
  });
  return { cleanupIntent, validated, record: stored.record };
}

describe("StateStore ASF terminal evidence", () => {
  it("refuses a terminal transition that bypasses pre-recorded signed evidence", () => {
    const store = open();
    const runId = "run_terminal_bypass";
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });

    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "ADMITTED",
        to: "REFUSED",
        expectedVersion: 1,
        eventType: "run.refused",
        payload: {
          code: "INVALID_WORK_ORDER",
          summary: "unsigned terminal transition",
          checkpoint: "ADMITTED",
          retry_disposition: "new-attempt-required",
          required_actor: "asf",
          required_action: "submit a corrected Work Order",
          evidence_refs: [],
          terminal_evidence_bundle_digest: DIGEST_A,
        },
        checkpoint: {
          ...cleanupCheckpoint("refused"),
          durableOutputs: {
            cleanup_evidence_digest: DIGEST_D,
            terminal_evidence_bundle_digest: DIGEST_A,
          },
        },
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "ADMITTED",
      stateVersion: 1,
    });
  });

  it("refuses to freeze a terminal record while another durable effect is unresolved", () => {
    const store = open();
    const runId = "run_terminal_pending_effect";
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.recordAsfDeliveryIntent({
      ownerId: "worker-a",
      intent: exactDeliveryIntent({
        runId,
        generation: 1,
        eventSeq: 1,
        stage: "repository-lease",
        candidateSha: null,
        operation: { repository: "acme/payments" },
      }),
    });

    expect(() =>
      prepareTerminalEvidence({
        store,
        runId,
        ownerId: "worker-a",
        generation: 1,
        terminalPhase: "FAILED",
        stop: {
          code: "INTERNAL_DELIVERY_FAILURE",
          summary: "cleanup contradicted the durable effect ledger",
          interruptedPhase: "ADMITTED",
          retryDisposition: "reconcile-first",
          requiredActor: "platform-operator",
          requiredAction: "reconcile the unresolved repository lease intent",
          evidenceRefs: [],
        },
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfTerminalEvidenceBundleRecord(runId)).toBeUndefined();
    expect(store.getAsfTerminalEvidencePlanRecord(runId)).toBeUndefined();
    const inspection = new Database(databasePath(), { readonly: true });
    const cleanupRows = inspection
      .prepare(
        `SELECT COUNT(*) AS count FROM asf_delivery_stage_intents
         WHERE run_id = ? AND stage = 'cleanup'`,
      )
      .get(runId) as { count: number };
    inspection.close();
    expect(cleanupRows.count).toBe(0);
  });

  it("survives a pre-transition crash, stores idempotently, and completes only with the exact terminal event and cleanup checkpoint", () => {
    let store = open();
    const runId = "run_terminal_evidence";
    const admission = admissionInput(runId);
    store.admitAsfWorkOrder(admission);
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    const providerBudget = portableAsfTerminalProviderBudgetEvidence(
      store.prepareAsfTerminalProviderBudgetEvidence({
        runId,
        ownerId: "worker-a",
        generation: 1,
      }),
    );
    const sideEffects = store.prepareAsfTerminalEffectLedger({ runId });
    const unsignedPlan = {
      schema: ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
      run: {
        run_id: runId,
        work_order_id: "wo_01",
        attempt_id: "attempt_01",
        terminal_phase: "REFUSED" as const,
        terminal_event_seq: 2,
      },
      admission: {
        work_order_envelope_digest: admission.envelopeDigest,
        work_order_payload_digest: admission.payloadDigest,
        effective_policy_digest: DIGEST_D,
      },
      source: {
        repository: "acme/payments",
        base_sha: BASE_SHA,
        candidate_sha: null,
      },
      stop: {
        code: "INVALID_WORK_ORDER",
        summary: "admitted work was refused before execution",
        interrupted_phase: "ADMITTED",
        retry_disposition: "new-attempt-required" as const,
        required_actor: "asf" as const,
        required_action: "submit a corrected Work Order as a new attempt",
        evidence_refs: [],
      },
      provider_budget: providerBudget,
      side_effects: sideEffects,
      cleanup: {
        identity_leases: "released" as const,
        repository_lease: "released" as const,
        workspace: "removed" as const,
        unresolved_effects: 0 as const,
      },
      delivery_bundle_digest: null,
      created_at: NOW,
    } as const;
    const plan = asfTerminalEvidencePlanSchema.parse({
      ...unsignedPlan,
      plan_digest: sha256Digest(unsignedPlan),
    });
    const cleanupIntent = exactDeliveryIntent({
      runId,
      generation: 1,
      eventSeq: 1,
      stage: "cleanup",
      candidateSha: null,
      operation: unsignedPlan,
    });
    store.recordAsfTerminalCleanupPlan({
      ownerId: "worker-a",
      cleanupIntent,
      plan,
    });
    const sealed = store.sealAsfTerminalEvidenceIntent({
      runId,
      planDigest: plan.plan_digest,
      cleanupObservation: {
        schema: "asf.cleanup-observation/v1",
        binding: {
          run_id: runId,
          work_order_id: "wo_01",
          attempt_id: "attempt_01",
          policy_digest: DIGEST_D,
          fencing_generation: 1,
          candidate_sha: null,
        },
        evidence_digest: DIGEST_C,
        identity_leases: "released",
        repository_lease: "released",
        workspace: "removed",
        unresolved_effects: 0,
      },
      ownerId: "worker-a",
      generation: 1,
    });
    const events = store.listAsfRunEvents(runId, 0, 100).events;
    const admittedEvent = events[0];
    if (admittedEvent === undefined) throw new Error("missing admitted event");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const statement = {
      _type: IN_TOTO_STATEMENT_V1,
      subject: [{ name: `asf-run:${runId}`, digest: { sha1: BASE_SHA } }],
      predicateType: ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
      predicate: {
        schema: ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
        run: {
          run_id: runId,
          work_order_id: "wo_01",
          attempt_id: "attempt_01",
          terminal_phase: "REFUSED" as const,
          terminal_event_seq: 2,
        },
        admission: {
          work_order_envelope_digest: admission.envelopeDigest,
          work_order_payload_digest: admission.payloadDigest,
          effective_policy_digest: DIGEST_D,
          work_order_envelope: admission.envelope,
          signature_verification: {
            verified: true as const,
            key_id: admission.envelope.key_id,
            algorithm: admission.envelope.algorithm,
          },
          effective_policy: JSON.parse(
            canonicalJson(admission.effectivePolicy as unknown as JsonValue),
          ),
        },
        source: {
          repository: "acme/payments",
          base_sha: BASE_SHA,
          candidate_sha: null,
          subject_kind: "base" as const,
          subject_sha: BASE_SHA,
        },
        stop: {
          code: "INVALID_WORK_ORDER",
          summary: "admitted work was refused before execution",
          interrupted_phase: "ADMITTED",
          retry_disposition: "new-attempt-required" as const,
          required_actor: "asf" as const,
          required_action: "submit a corrected Work Order as a new attempt",
          evidence_refs: [],
        },
        cancellation: null,
        budget: {
          wall_seconds_limit: 7_200,
          max_cost_usd: 10,
          max_agent_invocations: 12,
          max_fix_iterations: 3,
          observed_fix_iterations: 0,
          evidence_refs: [],
          provider_usage: providerBudget,
        },
        side_effects: sideEffects,
        timing: sealed.intent.timing,
        cleanup: {
          intent_id: cleanupIntent.intent_id,
          intent_digest: cleanupIntent.intent_digest,
          observation_digest: DIGEST_C,
          identity_leases: "released" as const,
          repository_lease: "released" as const,
          workspace: "removed" as const,
          unresolved_effects: 0 as const,
        },
        evidence: {
          preceding_event_count: 1,
          preceding_event_chain_digest: sha256Digest(events),
          observations: [
            {
              event_seq: 1,
              event_type: "work_order.admitted",
              phase: "ADMITTED",
              candidate_sha: null,
              event_digest: sha256Digest(admittedEvent),
              evidence_refs: [
                admission.envelopeDigest,
                admission.payloadDigest,
              ],
            },
          ],
          events: [...events],
          delivery_bundle_digest: null,
        },
      },
    };
    const signed = signAsfTerminalEvidenceBundle({
      statement,
      keyId: "terminal-evidence-key",
      privateKey,
      issuedAt: sealed.intent.created_at,
    });
    const validated = validateSignedAsfTerminalEvidenceBundle(signed, {
      clock,
      trustedSigners: [
        {
          keyId: "terminal-evidence-key",
          publicKey,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2027-01-01T00:00:00.000Z",
        },
      ],
      expected: {
        runId,
        workOrderId: "wo_01",
        attemptId: "attempt_01",
        workOrderEnvelopeDigest: admission.envelopeDigest,
        workOrderPayloadDigest: admission.payloadDigest,
        effectivePolicyDigest: DIGEST_D,
        repository: "acme/payments",
        baseSha: BASE_SHA,
        candidateSha: null,
        terminalPhase: "REFUSED",
        terminalEventSeq: 2,
        cleanupObservationDigest: DIGEST_C,
        deliveryBundleDigest: null,
        precedingEventChainDigest: sha256Digest(events),
        providerBudget,
        sideEffects,
        admittedAt: NOW,
        terminalEvidenceAt: sealed.intent.created_at,
        elapsedMs: Date.parse(sealed.intent.created_at) - Date.parse(NOW),
      },
    });

    expect(
      store.recordAsfTerminalEvidenceBundle({
        validated,
        ownerId: "worker-a",
        generation: 1,
      }),
    ).toMatchObject({ created: true, record: { candidateSha: null } });
    expect(() =>
      store.resolveAsfDeliveryIntentReconciliation({
        effectKey: cleanupIntent.effect_key,
        ownerId: "worker-a",
        generation: 1,
        outcome: "confirmed",
        observationDigest: DIGEST_C,
      }),
    ).toThrow(RunmillError);
    expect(new AsfEvidenceReadService(store).getEvidence(runId)).toMatchObject({
      status: "finalizing",
      complete: false,
      terminalBundleDigest: validated.bundleDigest,
    });
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        expectedVersion: 1,
        eventType: "repository.lease_acquired",
        payload: { repository: "acme/payments", generation: 1 },
        checkpoint: {
          kind: "repository-lease-acquisition",
          durableInputs: {},
          durableOutputs: { evidence_digest: DIGEST_A },
          correlationMarker: null,
        },
      }),
    ).toThrow(RunmillError);
    const cancellation = new AsfCancellationService(store);
    expect(() =>
      cancellation.request({
        schema: "asf.cancellation-request/v1",
        request_id: "cancel_during_terminal_commit",
        run_id: runId,
        requester: {
          subject: "service:asf-controller",
          authority: "asf:cancel",
        },
        reason: "race with terminal evidence persistence",
        mode: "forced",
        grace_seconds: 0,
      }),
    ).toThrow(RunmillError);
    expect(
      store.getAsfCancellationRequest("cancel_during_terminal_commit"),
    ).toBeUndefined();

    // Simulate a process crash after immutable persistence but before the
    // terminal transition. The same bytes are accepted; changed bytes are not.
    close(store);
    const corrupt = new Database(databasePath());
    corrupt
      .prepare(
        "UPDATE asf_terminal_evidence_bundles SET canonical_envelope = '{}' WHERE run_id = ?",
      )
      .run(runId);
    corrupt.close();
    store = open();
    expect(() => store.getAsfTerminalEvidenceBundle(runId)).toThrow();
    close(store);
    const restore = new Database(databasePath());
    restore
      .prepare(
        `UPDATE asf_terminal_evidence_bundles
         SET canonical_envelope_digest = ?, canonical_envelope = ?
         WHERE run_id = ?`,
      )
      .run(sha256Digest(signed), canonicalJson(signed), runId);
    restore.close();
    store = open();
    expect(
      store.recordAsfTerminalEvidenceBundle({
        validated,
        ownerId: "worker-a",
        generation: 1,
      }),
    ).toMatchObject({ created: false });
    const changedStatement = structuredClone(statement);
    changedStatement.predicate.stop.summary = "a conflicting terminal summary";
    const changed = signAsfTerminalEvidenceBundle({
      statement: changedStatement,
      keyId: "terminal-evidence-key",
      privateKey,
      issuedAt: NOW,
    });
    const changedValidated = validateSignedAsfTerminalEvidenceBundle(changed, {
      clock,
      trustedSigners: [
        {
          keyId: "terminal-evidence-key",
          publicKey,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2027-01-01T00:00:00.000Z",
        },
      ],
      expected: {
        runId,
        workOrderId: "wo_01",
        attemptId: "attempt_01",
        workOrderEnvelopeDigest: admission.envelopeDigest,
        workOrderPayloadDigest: admission.payloadDigest,
        effectivePolicyDigest: DIGEST_D,
        repository: "acme/payments",
        baseSha: BASE_SHA,
        candidateSha: null,
        terminalPhase: "REFUSED",
        terminalEventSeq: 2,
        cleanupObservationDigest: DIGEST_C,
        deliveryBundleDigest: null,
        precedingEventChainDigest: sha256Digest(events),
        providerBudget,
        sideEffects,
        admittedAt: NOW,
        terminalEvidenceAt: sealed.intent.created_at,
        elapsedMs: Date.parse(sealed.intent.created_at) - Date.parse(NOW),
      },
    });
    expect(() =>
      store.recordAsfTerminalEvidenceBundle({
        validated: changedValidated,
        ownerId: "worker-a",
        generation: 1,
      }),
    ).toThrow(RunmillError);

    store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REFUSED",
      expectedVersion: 1,
      eventType: "run.refused",
      payload: {
        code: "INVALID_WORK_ORDER",
        summary: "admitted work was refused before execution",
        checkpoint: "ADMITTED",
        retry_disposition: "new-attempt-required",
        required_actor: "asf",
        required_action: "submit a corrected Work Order as a new attempt",
        evidence_refs: [],
        terminal_evidence_bundle_digest: validated.bundleDigest,
      },
      checkpoint: {
        ...cleanupCheckpoint("refused"),
        durableOutputs: {
          cleanup_evidence_digest: DIGEST_C,
          terminal_evidence_bundle_digest: validated.bundleDigest,
        },
        correlationMarker: cleanupIntent.intent_id,
      },
    });
    expect(new AsfEvidenceReadService(store).getEvidence(runId)).toMatchObject({
      phase: "REFUSED",
      status: "stopped",
      complete: true,
      bundleDigest: null,
      terminalBundleDigest: validated.bundleDigest,
      signedTerminalBundle: { bundle_digest: validated.bundleDigest },
    });
  });
});

describe("StateStore.admitAsfWorkOrder", () => {
  it("atomically creates the admitted run, immutable record, transition, and event", () => {
    const store = open();
    const input = admissionInput("run_asf_01");

    expect(store.admitAsfWorkOrder(input)).toEqual({
      runId: "run_asf_01",
      created: true,
    });

    expect(store.getAsfRun("run_asf_01")).toEqual({
      runId: "run_asf_01",
      issueId: "ENG-123",
      repo: "acme/payments",
      provider: "codex:asf-production",
      state: "ADMITTED",
      stateVersion: 1,
      attempt: 1,
      baseCommit: BASE_SHA,
      candidateSha: null,
      branch: null,
      mode: "asf-worker",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      generation: 0,
      ownerId: null,
      heartbeatAt: null,
    });

    const admission = store.getAsfAdmission("tenant-acme/ENG-123/attempt_01");
    expect(admission).toEqual({
      runId: "run_asf_01",
      idempotencyKey: "tenant-acme/ENG-123/attempt_01",
      payloadDigest: input.payloadDigest,
      envelopeDigest: input.envelopeDigest,
      canonicalEnvelope: input.canonicalEnvelope,
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      tenantId: "tenant-acme",
      effectivePolicy: canonicalJson(
        input.effectivePolicy as unknown as JsonValue,
      ),
      effectivePolicyDigest: input.effectivePolicy.digest,
      signatureKeyId: "asf-signing-key-2026-01",
      signatureAlgorithm: "EdDSA",
      acceptedAt: NOW,
    });
    expect(store.transitionHistory("run_asf_01")).toEqual([
      { from: "RECEIVED", to: "ADMITTED", at: NOW },
    ]);
    expect(store.eventsFor("run_asf_01")).toEqual([
      {
        seq: 1,
        type: "work_order.admitted",
        payload: {
          work_order_id: "wo_01",
          attempt_id: "attempt_01",
          tenant_id: "tenant-acme",
          payload_digest: input.payloadDigest,
          envelope_digest: input.envelopeDigest,
          signature: {
            verified: true,
            key_id: "asf-signing-key-2026-01",
            algorithm: "EdDSA",
          },
        },
      },
    ]);
  });

  it("returns the original run for an identical payload without duplicating or rewriting", () => {
    const store = open();
    const first = admissionInput("run_asf_original");
    store.admitAsfWorkOrder(first);

    const reSignedEnvelope = workOrderEnvelope({
      signature: "base64url:bmV3LXNpZ25hdHVyZQ",
    });
    const retry = admissionInput("run_asf_retry", reSignedEnvelope);
    expect(retry.payloadDigest).toBe(first.payloadDigest);
    expect(retry.envelopeDigest).not.toBe(first.envelopeDigest);

    expect(store.admitAsfWorkOrder(retry)).toEqual({
      runId: "run_asf_original",
      created: false,
    });
    expect(store.listAsfRuns()).toHaveLength(1);
    expect(store.getRun("run_asf_retry")).toBeUndefined();
    expect(store.eventsFor("run_asf_original")).toHaveLength(1);
    expect(store.transitionHistory("run_asf_original")).toHaveLength(1);
    expect(
      store.getAsfAdmission(first.envelope.payload.idempotency_key),
    ).toMatchObject({
      runId: "run_asf_original",
      canonicalEnvelope: first.canonicalEnvelope,
      envelopeDigest: first.envelopeDigest,
      effectivePolicy: canonicalJson(
        first.effectivePolicy as unknown as JsonValue,
      ),
    });
  });

  it("refuses one idempotency key for a different payload and rolls back the second run", () => {
    const store = open();
    const first = admissionInput("run_asf_original");
    store.admitAsfWorkOrder(first);
    const conflicting = admissionInput(
      "run_asf_conflict",
      workOrderEnvelope({ title: "Different work under the same key" }),
    );
    expect(conflicting.payloadDigest).not.toBe(first.payloadDigest);

    expectIdempotencyConflict(() => store.admitAsfWorkOrder(conflicting));

    expect(store.listAsfRuns().map((run) => run.runId)).toEqual([
      "run_asf_original",
    ]);
    expect(store.getRun("run_asf_conflict")).toBeUndefined();
    expect(store.eventsFor("run_asf_original")).toHaveLength(1);
    expect(
      store.getAsfAdmission(first.envelope.payload.idempotency_key)
        ?.payloadDigest,
    ).toBe(first.payloadDigest);
  });

  it("refuses the same Work Order attempt under a different idempotency key", () => {
    const store = open();
    const first = admissionInput("run_asf_original");
    store.admitAsfWorkOrder(first);
    const duplicateAttempt = admissionInput(
      "run_asf_duplicate_attempt",
      workOrderEnvelope({
        idempotencyKey: "tenant-acme/ENG-123/attempt_01-duplicate",
      }),
    );

    expectIdempotencyConflict(() => store.admitAsfWorkOrder(duplicateAttempt));

    expect(store.listAsfRuns().map((run) => run.runId)).toEqual([
      "run_asf_original",
    ]);
    expect(store.getRun("run_asf_duplicate_attempt")).toBeUndefined();
    expect(
      store.getAsfAdmission("tenant-acme/ENG-123/attempt_01-duplicate"),
    ).toBeUndefined();
    expect(store.eventsFor("run_asf_original")).toHaveLength(1);
  });

  it("survives close and reopen with the exact admission lineage", () => {
    const firstStore = open();
    const input = admissionInput("run_asf_persisted");
    firstStore.admitAsfWorkOrder(input);
    close(firstStore);

    const reopened = open();
    expect(reopened.getAsfRun("run_asf_persisted")).toMatchObject({
      state: "ADMITTED",
      mode: "asf-worker",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      generation: 0,
    });
    expect(
      reopened.getAsfAdmission(input.envelope.payload.idempotency_key),
    ).toMatchObject({
      runId: "run_asf_persisted",
      payloadDigest: input.payloadDigest,
      envelopeDigest: input.envelopeDigest,
      canonicalEnvelope: input.canonicalEnvelope,
      acceptedAt: NOW,
    });
    expect(reopened.transitionHistory("run_asf_persisted")).toHaveLength(1);
    expect(reopened.eventsFor("run_asf_persisted")).toHaveLength(1);
  });

  it("migrates an existing standalone run and keeps it readable", () => {
    const initial = MIGRATIONS.find((migration) => migration.version === 1);
    if (initial === undefined)
      throw new Error("initial state migration is missing");

    const legacy = new Database(databasePath());
    legacy.exec(initial.up);
    legacy
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)`,
      )
      .run(initial.name, NOW);
    legacy
      .prepare(
        `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                          base_commit, candidate_sha, branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'DISCOVERED', 1, 1, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        "run_standalone",
        "ENG-OLD",
        "acme/legacy",
        "codex",
        BASE_SHA,
        NOW,
        NOW,
      );
    legacy.pragma("user_version = 1");
    legacy.close();

    const migrated = open();
    expect(migrated.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.getRun("run_standalone")).toEqual({
      runId: "run_standalone",
      issueId: "ENG-OLD",
      repo: "acme/legacy",
      provider: "codex",
      state: "DISCOVERED",
      stateVersion: 1,
      attempt: 1,
      baseCommit: BASE_SHA,
      candidateSha: null,
      branch: null,
    });
    expect(migrated.getAsfRun("run_standalone")).toBeUndefined();
  });
});

describe("ASF run ownership fencing", () => {
  it("finds recoverable work even behind more than one thousand terminal records", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_recoverable"));
    close(store);

    const raw = new Database(databasePath());
    const insert = raw.prepare(
      `INSERT INTO runs(
         run_id, issue_id, repo, provider, state, state_version, attempt,
         created_at, updated_at, mode
       ) VALUES (?, ?, 'acme/history', 'codex', 'COMPLETED', 1, 1, ?, ?, 'asf-worker')`,
    );
    raw.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        insert.run(
          `run_terminal_${String(index).padStart(4, "0")}`,
          `DONE-${index}`,
          NOW,
          NOW,
        );
      }
    })();
    raw.close();

    const reopened = open();
    expect(reopened.listRecoverableAsfRuns().map((run) => run.runId)).toEqual([
      "run_recoverable",
    ]);
  });

  it("allows one live owner and increments the generation for a stale takeover", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_owned"));

    expect(
      store.claimAsfRun({
        runId: "run_owned",
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 1, takeover: false });
    expect(store.getAsfRun("run_owned")).toMatchObject({
      ownerId: "worker-a",
      generation: 1,
      heartbeatAt: NOW,
    });

    // A process incarnation is not proven merely by reusing its worker id.
    expect(
      store.claimAsfRun({
        runId: "run_owned",
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toBeUndefined();

    expect(
      store.claimAsfRun({
        runId: "run_owned",
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toBeUndefined();

    clock.advanceMinutes(2);
    expect(
      store.claimAsfRun({
        runId: "run_owned",
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:06:00.000Z",
      }),
    ).toEqual({ generation: 2, takeover: true });
    expect(store.getAsfRun("run_owned")).toMatchObject({
      ownerId: "worker-b",
      generation: 2,
      heartbeatAt: "2026-08-21T10:07:00.000Z",
    });

    expect(() => store.heartbeatAsfRun("run_owned", "worker-a", 1)).toThrow(
      RunmillError,
    );
    expect(() =>
      store.releaseAsfRunOwnership("run_owned", "worker-a", 1),
    ).toThrow(RunmillError);
  });

  it("reports checkpoint takeover after an owner-null SQLite restart and fences the old owner", () => {
    let store = open();
    store.admitAsfWorkOrder(admissionInput("run_release"));
    expect(
      store.claimAsfRun({
        runId: "run_release",
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 1, takeover: false });

    clock.advanceMinutes(1);
    store.heartbeatAsfRun("run_release", "worker-a", 1);
    expect(store.getAsfRun("run_release")?.heartbeatAt).toBe(
      "2026-08-21T10:06:00.000Z",
    );
    store.releaseAsfRunOwnership("run_release", "worker-a", 1);
    expect(store.getAsfRun("run_release")).toMatchObject({
      ownerId: null,
      heartbeatAt: null,
    });

    close(store);
    store = open();

    expect(
      store.claimAsfRun({
        runId: "run_release",
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:05:00.000Z",
      }),
    ).toEqual({ generation: 2, takeover: true });
    expect(() => store.heartbeatAsfRun("run_release", "worker-a", 1)).toThrow(
      RunmillError,
    );
  });

  it("never claims a terminal run", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_terminal"));
    store.claimAsfRun({
      runId: "run_terminal",
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    const terminal = prepareTerminalEvidence({
      store,
      runId: "run_terminal",
      ownerId: "worker-a",
      generation: 1,
      terminalPhase: "REFUSED",
      stop: {
        code: "INVALID_WORK_ORDER",
        summary: "admitted work was refused before execution",
        interruptedPhase: "ADMITTED",
        retryDisposition: "new-attempt-required",
        requiredActor: "asf",
        requiredAction: "submit a corrected Work Order as a new attempt",
        evidenceRefs: [],
      },
    });
    store.transitionAsfRun({
      runId: "run_terminal",
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REFUSED",
      expectedVersion: 1,
      eventType: "run.refused",
      payload: {
        code: "INVALID_WORK_ORDER",
        summary: "admitted work was refused before execution",
        checkpoint: "ADMITTED",
        retry_disposition: "new-attempt-required",
        required_actor: "asf",
        required_action: "submit a corrected Work Order as a new attempt",
        evidence_refs: [],
        terminal_evidence_bundle_digest: terminal.record.bundleDigest,
      },
      checkpoint: {
        ...cleanupCheckpoint("refused"),
        durableOutputs: {
          cleanup_evidence_digest: terminal.record.cleanupDigest,
          terminal_evidence_bundle_digest: terminal.record.bundleDigest,
        },
        correlationMarker: terminal.cleanupIntent.intent_id,
      },
    });
    expect(
      store.claimAsfRun({
        runId: "run_terminal",
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("refuses every unfenced legacy mutation path for ASF runs", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_fenced_only"));

    expect(() =>
      store.transitionRun("run_fenced_only", {
        from: "ADMITTED",
        to: "COMPLETED",
        expectedVersion: 1,
      }),
    ).toThrow(/transition rejected/u);
    expect(() =>
      store.appendEvent({
        runId: "run_fenced_only",
        seq: 2,
        type: "run.completed",
        payload: {},
      }),
    ).toThrow(/cannot write ASF/u);
    expect(() =>
      store.intendSideEffect({
        runId: "run_fenced_only",
        system: "github",
        operation: "open-pr",
        target: "acme/payments",
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.recordLease({
        issueId: "ENG-123",
        runId: "run_fenced_only",
        repo: "acme/payments",
        generation: 1,
        expiresAt: "2026-08-21T10:10:00.000Z",
      }),
    ).toThrow(RunmillError);

    expect(store.getAsfRun("run_fenced_only")).toMatchObject({
      state: "ADMITTED",
    });
    expect(store.getRun("run_fenced_only")).toBeUndefined();
    expect(store.eventsFor("run_fenced_only")).toHaveLength(1);
    expect(store.listRuns()).toEqual([]);
    expect(store.attemptsFor("ENG-123")).toBe(0);
    expect(store.activeLeaseIssueIds()).toEqual(new Set());
  });
});

describe("ASF atomic transitions and event cursors", () => {
  it("rolls back the state and event when checkpoint persistence fails", () => {
    const store = open();
    const runId = "run_checkpoint_kill_window";
    store.admitAsfWorkOrder(admissionInput(runId));
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 1, takeover: false });

    const before = store.getAsfRunSnapshot(runId);
    expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
      checkpoint_kind: "work-order-admission",
      phase: "ADMITTED",
      event_seq: 1,
      fencing_generation: 1,
    });

    const fault = new Database(databasePath());
    fault.exec(`
      CREATE TRIGGER fail_repository_checkpoint
      BEFORE INSERT ON asf_checkpoints
      WHEN NEW.checkpoint_kind = 'repository-lease-acquisition'
      BEGIN
        SELECT RAISE(ABORT, 'injected checkpoint write failure');
      END;
    `);
    fault.close();

    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        expectedVersion: 1,
        eventType: "repository.lease_acquired",
        payload: { repository: "acme/payments", generation: 1 },
        checkpoint: {
          kind: "repository-lease-acquisition",
          durableInputs: { admission_checkpoint: DIGEST_A },
          durableOutputs: { repository_lease: DIGEST_B },
          correlationMarker: null,
        },
      }),
    ).toThrow(/injected checkpoint write failure/u);

    expect(store.getAsfRunSnapshot(runId)).toEqual(before);
    expect(store.listAsfRunEvents(runId).events).toHaveLength(1);
    expect(store.transitionHistory(runId)).toEqual([
      { from: "RECEIVED", to: "ADMITTED", at: NOW },
    ]);
    expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
      checkpoint_kind: "work-order-admission",
      event_seq: 1,
    });
  });

  it("commits a fenced state transition and its versioned event together", () => {
    const store = open();
    const admission = admissionInput("run_events");
    store.admitAsfWorkOrder(admission);
    store.claimAsfRun({
      runId: "run_events",
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });

    clock.advanceMinutes(1);
    const event = store.transitionAsfRun({
      runId: "run_events",
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REPOSITORY_LEASED",
      expectedVersion: 1,
      eventType: "repository.lease_acquired",
      payload: { repository: "acme/payments", generation: 1 },
      checkpoint: stageCheckpoint("repository.lease_acquired"),
      reason: "exclusive repository lease acquired",
    });

    expect(event).toEqual({
      schema: "asf.run-event/v1",
      event_id: expect.stringMatching(/^evt_[a-f0-9]{26}$/u),
      run_id: "run_events",
      work_order_id: "wo_01",
      attempt_id: "attempt_01",
      seq: 2,
      occurred_at: "2026-08-21T10:06:00.000Z",
      type: "repository.lease_acquired",
      phase: "REPOSITORY_LEASED",
      payload: { repository: "acme/payments", generation: 1 },
      policy_digest: admission.effectivePolicy.digest,
    });
    expect(store.getAsfRun("run_events")).toMatchObject({
      state: "REPOSITORY_LEASED",
      stateVersion: 2,
      ownerId: "worker-a",
      generation: 1,
      heartbeatAt: "2026-08-21T10:06:00.000Z",
    });
    expect(store.transitionHistory("run_events")).toEqual([
      { from: "RECEIVED", to: "ADMITTED", at: NOW },
      {
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        at: "2026-08-21T10:06:00.000Z",
      },
    ]);

    expect(store.listAsfRunEvents("run_events", 0, 1)).toMatchObject({
      events: [
        expect.objectContaining({ seq: 1, type: "work_order.admitted" }),
      ],
      nextCursor: 1,
      hasMore: true,
      gap: false,
      compactedThrough: null,
    });
    expect(store.listAsfRunEvents("run_events", 1, 10)).toEqual({
      events: [event],
      nextCursor: 2,
      hasMore: false,
      gap: false,
      compactedThrough: null,
      snapshot: {
        run: expect.objectContaining({
          runId: "run_events",
          state: "REPOSITORY_LEASED",
          stateVersion: 2,
        }),
        latestSequence: 2,
      },
    });
    expect(store.listAsfRunEvents("run_events", 2, 10)).toEqual({
      events: [],
      nextCursor: 2,
      hasMore: false,
      gap: false,
      compactedThrough: null,
      snapshot: {
        run: expect.objectContaining({
          runId: "run_events",
          state: "REPOSITORY_LEASED",
          stateVersion: 2,
        }),
        latestSequence: 2,
      },
    });

    const checkpoint = store.getLatestAsfCheckpoint("run_events");
    expect(checkpoint).toMatchObject({
      checkpoint_kind: "repository-lease-acquisition",
      phase: "REPOSITORY_LEASED",
      event_seq: 2,
      fencing_generation: 1,
    });
    if (checkpoint === undefined)
      throw new Error("atomic checkpoint disappeared");
    expect(
      store.recordAsfCheckpoint({
        checkpoint,
        ownerId: "worker-a",
        generation: 1,
      }),
    ).toMatchObject({ created: false });
    expect(
      store.recordAsfCheckpoint({
        checkpoint,
        ownerId: "worker-a",
        generation: 1,
      }),
    ).toMatchObject({ created: false });
    expect(store.getLatestAsfCheckpoint("run_events")).toEqual(checkpoint);
    expect(store.listAsfCheckpointSummaries("run_events")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: "asf.checkpoint-public-summary/v1",
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_digest: checkpoint.checkpoint_digest,
        }),
        expect.objectContaining({
          checkpoint_kind: "work-order-admission",
          phase: "ADMITTED",
          event_seq: 1,
        }),
      ]),
    );
    expect(() =>
      store.recordAsfCheckpoint({
        checkpoint,
        ownerId: "stale-worker",
        generation: 1,
      }),
    ).toThrow(RunmillError);
  });

  it("refuses to compact an active run and keeps event sequences monotonic", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_compacted"));
    store.claimAsfRun({
      runId: "run_compacted",
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.transitionAsfRun({
      runId: "run_compacted",
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REPOSITORY_LEASED",
      expectedVersion: 1,
      eventType: "repository.lease_acquired",
      payload: { repository: "acme/payments", generation: 1 },
      checkpoint: stageCheckpoint("repository.lease_acquired"),
    });

    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_compacted",
        expectedGeneration: 1,
        expectedBundleDigest: DIGEST_A,
        through: 1,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
    expect(store.listAsfRunEvents("run_compacted", 0, 10)).toMatchObject({
      events: [
        expect.objectContaining({ seq: 1 }),
        expect.objectContaining({ seq: 2 }),
      ],
      nextCursor: 2,
      gap: false,
      compactedThrough: null,
      snapshot: { latestSequence: 2 },
    });

    const next = store.transitionAsfRun({
      runId: "run_compacted",
      ownerId: "worker-a",
      generation: 1,
      from: "REPOSITORY_LEASED",
      to: "IDENTITY_READY",
      expectedVersion: 2,
      eventType: "identity.leases_acquired",
      payload: {
        attributions_digest: DIGEST_A,
        roles: ["implementer", "local-reviewer", "pr-reviewer"],
        attributions: identityAttributions(),
      },
      checkpoint: stageCheckpoint("identity.leases_acquired"),
    });
    expect(next.seq).toBe(3);
    expect(store.listAsfRunEvents("run_compacted", 1, 10)).toMatchObject({
      events: [
        expect.objectContaining({ seq: 2 }),
        expect.objectContaining({ seq: 3 }),
      ],
      gap: false,
      compactedThrough: null,
      snapshot: { latestSequence: 3 },
    });
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_compacted",
        expectedGeneration: 1,
        expectedBundleDigest: DIGEST_A,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
  });

  it("cannot skip or advance failed exact-candidate verification and review gates", () => {
    const store = open();
    const runId = "run_gates";
    const candidateSha = "c".repeat(40);
    const finalObservation = {
      schema: "asf.github-final-pr-delivery-observation/v1" as const,
      repository: "acme/payments",
      pull_request_number: 42,
      url: "https://github.example/acme/payments/pull/42",
      head_ref: "refs/heads/runmill/ENG-123",
      base_ref: "refs/heads/main",
      marker: "runmill:v1:run_gates",
      head_sha: candidateSha,
      current_base_sha: "b".repeat(40),
      collision_set_digest: DIGEST_A,
      base_observation_digest: DIGEST_B,
      protection_digest: FINAL_PROTECTION_DIGEST,
      protection: FINAL_PROTECTION,
      observed_at: NOW,
      state: "open" as const,
      draft: false,
    };
    const finalCiChecks = [
      { context: "ci/test", outcome: "passed" as const, evidence_digest: DIGEST_B },
    ];
    const finalCiObservation = {
      schema: "asf.ci-head-observation/v1" as const,
      binding: {
        run_id: runId,
        work_order_id: "wo_01",
        attempt_id: "attempt_01",
        policy_digest: DIGEST_D,
        fencing_generation: 1,
        candidate_sha: candidateSha,
      },
      repository: "acme/payments",
      pull_request_number: 42,
      candidate_sha: candidateSha,
      observed_head_sha: candidateSha,
      observed_at: NOW,
      checks: finalCiChecks,
    };
    const deliveredPayload = (
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      candidate_sha: candidateSha,
      repository: finalObservation.repository,
      number: finalObservation.pull_request_number,
      url: finalObservation.url,
      head_ref: finalObservation.head_ref,
      base_ref: finalObservation.base_ref,
      marker: finalObservation.marker,
      head_sha: finalObservation.head_sha,
      observed_head_sha: candidateSha,
      current_base_sha: finalObservation.current_base_sha,
      collision_set_digest: finalObservation.collision_set_digest,
      base_observation_digest: finalObservation.base_observation_digest,
      protection_digest: finalObservation.protection_digest,
      protection: finalObservation.protection,
      state: finalObservation.state,
      draft: finalObservation.draft,
      delivery_observation_intent_digest: DIGEST_C,
      delivery_observation_digest: sha256Digest(finalObservation),
      observed_at: finalObservation.observed_at,
      final_ci_observation_intent_digest: DIGEST_A,
      final_ci_observation_digest: sha256Digest(finalCiObservation),
      final_ci_observation_fencing_generation: 1,
      final_ci_checks_digest: sha256Digest(finalCiChecks),
      final_ci_checks: finalCiChecks,
      final_ci_observed_at: finalCiObservation.observed_at,
      ...overrides,
    });
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    let phase: RunEventPhase = "ADMITTED";
    let version = 1;
    const advance = (
      to: RunEventPhase,
      eventType: string,
      payload: Readonly<Record<string, unknown>>,
    ) => {
      const checkpoint =
        eventType === "verification.completed" &&
        payload["check_id"] === "unit" &&
        payload["outcome"] === "passed"
          ? {
              kind: "local-verification-pass" as const,
              durableInputs: { event_type: eventType },
              durableOutputs: { evidence_digest: DIGEST_D },
              correlationMarker: null,
            }
          : stageCheckpoint(eventType);
      const event = store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: phase,
        to,
        expectedVersion: version,
        eventType,
        payload,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      phase = to;
      version += 1;
      return event;
    };

    advance("REPOSITORY_LEASED", "repository.lease_acquired", {
      repository: "acme/payments",
      generation: 1,
    });
    advance("IDENTITY_READY", "identity.leases_acquired", {
      attributions_digest: DIGEST_A,
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
      attributions: identityAttributions(),
    });
    advance("WORKSPACE_READY", "workspace.prepared", {
      workspace_id: "workspace_01",
      sandbox_profile: "linux-production-v1",
      isolation_evidence_digest: DIGEST_A,
    });
    advance("TASK_PACKET_READY", "task_packet.created", {
      task_packet_digest: DIGEST_A,
      source_snapshot_digest: DIGEST_B,
    });
    advance("IMPLEMENTING", "implementation.started", {
      session: "new",
      checkpoint_digest: DIGEST_A,
    });
    advance("CANDIDATE_READY", "candidate.created", {
      candidate_sha: candidateSha,
      parent_sha: BASE_SHA,
      tree_digest: DIGEST_A,
    });

    expect(() =>
      advance("LOCAL_VERIFY", "verification.completed", {
        candidate_sha: candidateSha,
        check_id: "lint",
        outcome: "passed",
        evidence_digest: DIGEST_A,
      }),
    ).toThrow(/cannot transition from CANDIDATE_READY/u);
    advance("LOCAL_VERIFY", "verification.started", {
      candidate_sha: candidateSha,
      required_check_ids: ["lint", "unit"],
    });
    expect(() =>
      advance("LOCAL_REVIEW", "review.started", {
        candidate_sha: candidateSha,
        reviewer_attribution: "claude:asf-review",
      }),
    ).toThrow(/local-check gates are not satisfied/u);

    advance("LOCAL_VERIFY", "verification.completed", {
      candidate_sha: candidateSha,
      check_id: "lint",
      outcome: "passed",
      evidence_digest: DIGEST_A,
    });
    advance("LOCAL_VERIFY", "verification.completed", {
      candidate_sha: candidateSha,
      check_id: "unit",
      outcome: "failed",
      evidence_digest: DIGEST_B,
    });
    expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
      checkpoint_kind: "candidate-commit-creation",
      candidate_sha: candidateSha,
    });
    expect(() =>
      advance("LOCAL_REVIEW", "review.started", {
        candidate_sha: candidateSha,
        reviewer_attribution: "claude:asf-review",
      }),
    ).toThrow(/unit/u);
    advance("LOCAL_VERIFY", "verification.completed", {
      candidate_sha: candidateSha,
      check_id: "unit",
      outcome: "blocked",
      evidence_digest: DIGEST_C,
    });
    expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
      checkpoint_kind: "candidate-commit-creation",
      candidate_sha: candidateSha,
    });
    advance("LOCAL_VERIFY", "verification.completed", {
      candidate_sha: candidateSha,
      check_id: "unit",
      outcome: "passed",
      evidence_digest: DIGEST_C,
    });
    advance("LOCAL_REVIEW", "review.started", {
      candidate_sha: candidateSha,
      reviewer_attribution: "claude:asf-review",
    });
    expect(() =>
      advance("DELIVERY_READY", "delivery.ready", {
        candidate_sha: candidateSha,
        required_remote_checks: ["ci/test"],
      }),
    ).toThrow(/no approved local review/u);
    advance("LOCAL_REVIEW", "review.completed", {
      candidate_sha: candidateSha,
      reviewer_attribution: "claude:asf-review",
      outcome: "changes-requested",
      findings_digest: DIGEST_A,
    });
    expect(() =>
      advance("DELIVERY_READY", "delivery.ready", {
        candidate_sha: candidateSha,
        required_remote_checks: ["ci/test"],
      }),
    ).toThrow(/no approved local review/u);
    advance("LOCAL_REVIEW", "review.completed", {
      candidate_sha: candidateSha,
      reviewer_attribution: "claude:asf-review",
      outcome: "approved",
      findings_digest: DIGEST_B,
    });
    advance("DELIVERY_READY", "delivery.ready", {
      candidate_sha: candidateSha,
      required_remote_checks: ["ci/test"],
    });
    expect(() =>
      advance("PUSHED", "branch.pushed", {
        candidate_sha: candidateSha,
        remote_ref: "refs/heads/runmill/ENG-123",
        observed_remote_sha: "d".repeat(40),
      }),
    ).toThrow(/exact candidate/u);
    advance("PUSHED", "branch.pushed", {
      candidate_sha: candidateSha,
      remote_ref: "refs/heads/runmill/ENG-123",
      observed_remote_sha: candidateSha,
    });
    expect(() =>
      advance("PR_OPEN", "pull_request.opened", {
        candidate_sha: candidateSha,
        repository: "acme/payments",
        number: 42,
        url: "https://github.example/acme/payments/pull/42",
        observed_head_sha: candidateSha,
        base_sha: "d".repeat(40),
      }),
    ).toThrow(/admitted base/u);
    advance("PR_OPEN", "pull_request.opened", {
      candidate_sha: candidateSha,
      repository: "acme/payments",
      number: 42,
      url: "https://github.example/acme/payments/pull/42",
      observed_head_sha: candidateSha,
      base_sha: BASE_SHA,
    });
    advance("CI_WAIT", "ci.waiting", {
      candidate_sha: candidateSha,
      snapshot_digest: DIGEST_A,
    });
    expect(() =>
      advance("PR_REVIEW", "pr_review.started", {
        candidate_sha: candidateSha,
        reviewer_attribution: "claude:asf-review",
      }),
    ).toThrow(/remote-check gates are not satisfied/u);

    const failedChecks = [
      { context: "ci/test", outcome: "failed", evidence_digest: DIGEST_A },
    ];
    advance("CI_WAIT", "ci.completed", {
      candidate_sha: candidateSha,
      outcome: "failed",
      checks: failedChecks,
      checks_digest: sha256Digest(failedChecks),
      observed_at: NOW,
    });
    expect(() =>
      advance("PR_REVIEW", "pr_review.started", {
        candidate_sha: candidateSha,
        reviewer_attribution: "claude:asf-review",
      }),
    ).toThrow(/ci\/test/u);
    const passedChecks = [
      { context: "ci/test", outcome: "passed", evidence_digest: DIGEST_B },
    ];
    advance("CI_WAIT", "ci.completed", {
      candidate_sha: candidateSha,
      outcome: "passed",
      checks: passedChecks,
      checks_digest: sha256Digest(passedChecks),
      observed_at: NOW,
    });
    advance("PR_REVIEW", "pr_review.started", {
      candidate_sha: candidateSha,
      reviewer_attribution: "claude:asf-review",
    });
    expect(() =>
      advance("PR_DELIVERED", "pull_request.delivered", deliveredPayload()),
    ).toThrow(/no approved PR review/u);
    advance("PR_REVIEW", "pr_review.completed", {
      candidate_sha: candidateSha,
      reviewer_attribution: "claude:asf-review",
      outcome: "approved",
      findings_digest: DIGEST_C,
    });
    expect(() =>
      advance(
        "PR_DELIVERED",
        "pull_request.delivered",
        deliveredPayload({ observed_head_sha: "d".repeat(40) }),
      ),
    ).toThrow(/exact candidate/u);
    const revalidatedPayload = {
      candidate_sha: candidateSha,
      outcome: "passed",
      observation_intent_digest: DIGEST_A,
      observation_digest: sha256Digest(finalCiObservation),
      observation_fencing_generation: 1,
      checks_digest: sha256Digest(finalCiChecks),
      checks: finalCiChecks,
      observed_at: NOW,
    } as const;
    const pendingRecheckChecks = [
      { context: "ci/test", outcome: "pending" as const, evidence_digest: DIGEST_B },
    ];
    const pendingRecheckPayload = {
      candidate_sha: candidateSha,
      outcome: "pending" as const,
      observation_intent_digest: DIGEST_A,
      observation_digest: DIGEST_B,
      observation_fencing_generation: 1,
      checks_digest: sha256Digest(pendingRecheckChecks),
      checks: pendingRecheckChecks,
      observed_at: NOW,
    };
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "PR_REVIEW",
        to: "CI_WAIT",
        expectedVersion: version,
        eventType: "ci.recheck_completed",
        payload: pendingRecheckPayload,
      }),
    ).toThrow(/checkpoint/u);
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "PR_REVIEW",
        to: "CI_WAIT",
        expectedVersion: version,
        eventType: "ci.recheck_completed",
        payload: pendingRecheckPayload,
        checkpoint: stageCheckpoint("ci.revalidated"),
      }),
    ).toThrow(/checkpoint/u);
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "PR_REVIEW",
        to: "PR_REVIEW",
        expectedVersion: version,
        eventType: "ci.revalidated",
        payload: revalidatedPayload,
      }),
    ).toThrow(/checkpoint/u);
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "PR_REVIEW",
        to: "PR_REVIEW",
        expectedVersion: version,
        eventType: "ci.revalidated",
        payload: revalidatedPayload,
        checkpoint: stageCheckpoint("ci.completed"),
      }),
    ).toThrow(/checkpoint/u);
    const missingContextChecks: typeof finalCiChecks = [];
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: "PR_REVIEW",
        to: "PR_REVIEW",
        expectedVersion: version,
        eventType: "ci.revalidated",
        payload: {
          ...revalidatedPayload,
          checks: missingContextChecks,
          checks_digest: sha256Digest(missingContextChecks),
        },
        checkpoint: stageCheckpoint("ci.revalidated"),
      }),
    ).toThrow(/exact admitted required contexts/u);
    advance("PR_REVIEW", "ci.revalidated", revalidatedPayload);
    advance("PR_DELIVERED", "pull_request.delivered", deliveredPayload());

    expect(() =>
      advance("EVIDENCE_FINALIZED", "evidence.finalized", {
        candidate_sha: candidateSha,
        bundle_digest: DIGEST_D,
      }),
    ).toThrow(RunmillError);

    expect(store.getAsfRun(runId)).toMatchObject({
      state: "PR_DELIVERED",
      candidateSha,
      stateVersion: version,
    });
  });

  it("rolls the state back when the event payload or type is not valid", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_invalid_event"));
    store.claimAsfRun({
      runId: "run_invalid_event",
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });

    expect(() =>
      store.transitionAsfRun({
        runId: "run_invalid_event",
        ownerId: "worker-a",
        generation: 1,
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        expectedVersion: 1,
        eventType: "NOT-DOTTED",
        payload: { invalid: 1n },
      }),
    ).toThrow(/invalid ASF run event/u);
    expect(store.getAsfRun("run_invalid_event")).toMatchObject({
      state: "ADMITTED",
      stateVersion: 1,
    });
    expect(store.eventsFor("run_invalid_event")).toHaveLength(1);
    expect(store.transitionHistory("run_invalid_event")).toHaveLength(1);
  });

  it("rejects stale generations and malformed cursors without emitting anything", () => {
    const store = open();
    store.admitAsfWorkOrder(admissionInput("run_stale_event"));
    store.claimAsfRun({
      runId: "run_stale_event",
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    clock.advanceMinutes(2);
    store.claimAsfRun({
      runId: "run_stale_event",
      ownerId: "worker-b",
      staleBefore: "2026-08-21T10:06:00.000Z",
    });

    expect(() =>
      store.transitionAsfRun({
        runId: "run_stale_event",
        ownerId: "worker-a",
        generation: 1,
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        expectedVersion: 1,
        eventType: "repository.lease_acquired",
        payload: { repository: "acme/payments", generation: 1 },
      }),
    ).toThrow(RunmillError);
    expect(store.eventsFor("run_stale_event")).toHaveLength(1);
    expect(() => store.listAsfRunEvents("run_stale_event", -1)).toThrow(
      /cursor/u,
    );
    expect(() => store.listAsfRunEvents("run_stale_event", 0, 0)).toThrow(
      /limit/u,
    );
    expect(() => store.listAsfRunEvents("missing", 0, 10)).toThrow(
      /does not exist/u,
    );
  });

  it("records cancellation idempotently and marks owner-null cleanup as checkpoint takeover", () => {
    const store = open();
    const runId = "run_cancel";
    store.admitAsfWorkOrder(admissionInput(runId));
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-stale",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 1, takeover: false });
    const cancellations = new AsfCancellationService(store);
    const graceful = {
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_01",
      run_id: runId,
      requester: {
        subject: "service:asf-controller",
        authority: "asf:cancel",
      },
      reason: "superseded by a more specific work item",
      mode: "graceful",
      grace_seconds: 15,
    } as const;

    expect(cancellations.request(graceful)).toMatchObject({
      disposition: "requested",
      state: "CANCEL_REQUESTED",
      generation: 2,
      reconciliationRequired: false,
    });
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "CANCEL_REQUESTED",
      stateVersion: 2,
      generation: 2,
      ownerId: null,
    });
    expect(store.getAsfCancellationRequest("cancel_01")).toMatchObject({
      requester: "service:asf-controller",
      requesterAuthority: "asf:cancel",
      reason: graceful.reason,
      mode: "graceful",
    });
    const publicCancellation = store.eventsFor(runId).at(-1);
    expect(publicCancellation).toMatchObject({
      type: "cancellation.requested",
      payload: {
        request_id: "cancel_01",
        reason: expect.stringMatching(/^protected:sha256:/u),
        reconciliation_origin: "none",
      },
    });
    expect(JSON.stringify(publicCancellation)).not.toContain(graceful.reason);
    expect(() =>
      store.transitionAsfRun({
        runId,
        ownerId: "worker-stale",
        generation: 1,
        from: "ADMITTED",
        to: "REPOSITORY_LEASED",
        expectedVersion: 1,
        eventType: "repository.lease_acquired",
        payload: { repository: "acme/payments", generation: 1 },
      }),
    ).toThrow(RunmillError);

    expect(cancellations.request(graceful)).toMatchObject({
      disposition: "existing",
      generation: 2,
    });
    expect(store.eventsFor(runId)).toHaveLength(2);
    expect(() =>
      cancellations.request({ ...graceful, reason: "conflicting reuse" }),
    ).toThrow(RunmillError);

    const forced = {
      ...graceful,
      request_id: "cancel_02",
      reason: "grace window elapsed",
      mode: "forced",
      grace_seconds: 0,
    } as const;
    expect(cancellations.request(forced)).toMatchObject({
      disposition: "requested",
      state: "CANCEL_REQUESTED",
      generation: 3,
      reconciliationRequired: true,
    });
    expect(store.eventsFor(runId).at(-1)).toMatchObject({
      type: "cancellation.escalated",
      payload: {
        request_id: "cancel_02",
        mode: "forced",
        reconciliation_origin: "forced-cancellation-cleanup",
      },
    });
    expect(cancellations.request(forced)).toMatchObject({
      disposition: "existing",
      generation: 3,
    });
    expect(() =>
      cancellations.request({
        ...forced,
        request_id: "cancel_03",
        reason: "duplicate forced cancellation",
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "CANCEL_REQUESTED",
      stateVersion: 3,
      generation: 3,
    });
    expect(store.getAsfCancellationRequest("cancel_03")).toBeUndefined();
    expect(store.getLatestAsfCheckpoint(runId)?.fencing_generation).toBe(1);

    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-canceller",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 4, takeover: true });
    const stop = {
      code: "CANCELLED",
      summary: "authorized forced cancellation is being applied",
      checkpoint: "CANCEL_REQUESTED",
      retry_disposition: "reconcile-first",
      required_actor: "asf",
      required_action: "reconcile unresolved effects before retry",
      evidence_refs: ["cancellation:cancel_02"],
      request_id: "cancel_02",
      requester: "service:asf-controller",
      reason: `protected:${sha256Digest({ reason: forced.reason })}`,
      mode: "forced",
      grace_seconds: 0,
    } as const;
    store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller",
      generation: 4,
      from: "CANCEL_REQUESTED",
      to: "CANCELLING",
      expectedVersion: 3,
      eventType: "cancellation.started",
      payload: stop,
    });
    const terminal = prepareTerminalEvidence({
      store,
      runId,
      ownerId: "worker-canceller",
      generation: 4,
      terminalPhase: "CANCELLED",
      stop: {
        code: stop.code,
        summary: stop.summary,
        interruptedPhase: stop.checkpoint,
        retryDisposition: stop.retry_disposition,
        requiredActor: stop.required_actor,
        requiredAction: stop.required_action,
        evidenceRefs: stop.evidence_refs,
      },
      afterPlan: () => {
        expect(cancellations.request(forced)).toMatchObject({
          disposition: "existing",
          reconciliationRequired: true,
        });
      },
    });
    store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller",
      generation: 4,
      from: "CANCELLING",
      to: "CANCELLED",
      expectedVersion: 4,
      eventType: "run.cancelled",
      payload: {
        ...stop,
        terminal_evidence_bundle_digest: terminal.record.bundleDigest,
      },
      checkpoint: {
        ...cleanupCheckpoint("cancelled"),
        durableOutputs: {
          cleanup_evidence_digest: terminal.record.cleanupDigest,
          terminal_evidence_bundle_digest: terminal.record.bundleDigest,
        },
        correlationMarker: terminal.cleanupIntent.intent_id,
      },
    });
    expect(
      cancellations.request({
        ...graceful,
        request_id: "cancel_after_terminal",
      }),
    ).toMatchObject({
      disposition: "already-terminal",
      state: "CANCELLED",
      reconciliationRequired: false,
    });
  });

  it("does not consume a preexisting reconciliation obligation as forced-cancellation cleanup", () => {
    const store = open();
    const runId = "run_cancel_preexisting_reconciliation";
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-stale",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    const fixture = new Database(databasePath());
    fixture
      .prepare(`UPDATE runs SET requires_reconciliation = 1 WHERE run_id = ?`)
      .run(runId);
    fixture.close();
    const cancellations = new AsfCancellationService(store);
    const forced = {
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_preexisting_01",
      run_id: runId,
      requester: {
        subject: "service:asf-controller",
        authority: "asf:cancel",
      },
      reason: "forced cancellation must preserve prior reconciliation",
      mode: "forced",
      grace_seconds: 0,
    } as const;

    expect(cancellations.request(forced)).toMatchObject({
      reconciliationRequired: true,
      generation: 2,
    });
    expect(store.eventsFor(runId).at(-1)).toMatchObject({
      payload: { reconciliation_origin: "preexisting" },
    });
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-canceller",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 3, takeover: true });
    const effective = store.listAsfRunEvents(runId, 0, 100).events.at(-1);
    if (effective === undefined)
      throw new Error("cancellation event disappeared");
    store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller",
      generation: 3,
      from: "CANCEL_REQUESTED",
      to: "CANCELLING",
      expectedVersion: 2,
      eventType: "cancellation.started",
      payload: effective.payload,
    });

    expect(() =>
      prepareTerminalEvidence({
        store,
        runId,
        ownerId: "worker-canceller",
        generation: 3,
        terminalPhase: "CANCELLED",
        stop: {
          code: "CANCELLED",
          summary: "an authorized controller requested cancellation",
          interruptedPhase: "ADMITTED",
          retryDisposition: "reconcile-first",
          requiredActor: "asf",
          requiredAction:
            "reconcile every unresolved external effect before starting a new attempt",
          evidenceRefs: [`cancellation:${forced.request_id}`],
        },
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfTerminalEvidencePlanRecord(runId)).toBeUndefined();
    expect(cancellations.request(forced)).toMatchObject({
      reconciliationRequired: true,
    });
  });

  it("resumes exact cancellation cleanup after reconciling a durable effect", () => {
    const store = open();
    const runId = "run_cancel_effect_reconciliation";
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-stale",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    const unresolved = exactDeliveryIntent({
      runId,
      generation: 1,
      eventSeq: 1,
      stage: "repository-lease",
      candidateSha: null,
      operation: { repository: "acme/payments" },
    });
    store.recordAsfDeliveryIntent({
      ownerId: "worker-stale",
      intent: unresolved,
    });
    const cancellations = new AsfCancellationService(store);
    const forced = {
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_effect_01",
      run_id: runId,
      requester: {
        subject: "service:asf-controller",
        authority: "asf:cancel",
      },
      reason: "cancel after reconciling the interrupted repository lease",
      mode: "forced",
      grace_seconds: 0,
    } as const;
    expect(cancellations.request(forced)).toMatchObject({
      generation: 2,
      reconciliationRequired: true,
    });
    const cancellationEvent = store
      .listAsfRunEvents(runId, 0, 100)
      .events.at(-1);
    if (cancellationEvent === undefined) {
      throw new Error("durable cancellation event disappeared");
    }
    expect(cancellationEvent.payload).toMatchObject({
      reconciliation_origin: "durable-effects",
    });
    store.claimAsfRun({
      runId,
      ownerId: "worker-canceller",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    expect(() =>
      store.recordAsfDeliveryIntent({
        ownerId: "worker-canceller",
        intent: exactDeliveryIntent({
          runId,
          generation: 3,
          eventSeq: 2,
          stage: "workspace",
          candidateSha: null,
          operation: { workspace: "forbidden-after-cancellation-request" },
        }),
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.intendAsfEffect({
        runId,
        ownerId: "worker-canceller",
        generation: 3,
        operation: "branch.push",
        target: "refs/heads/runmill/cancelled",
        correlationMarker: "cancelled-effect",
        candidateSha: "c".repeat(40),
        policyDigest: DIGEST_D,
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.reserveAsfProviderBudget({
        ownerId: "worker-canceller",
        binding: {
          runId,
          workOrderId: "wo_01",
          attemptId: "attempt_01",
          policyDigest: DIGEST_D,
          fencingGeneration: 3,
          candidateSha: null,
        },
        effectKey: unresolved.effect_key,
        intentId: unresolved.intent_id,
        intentDigest: unresolved.intent_digest,
        intentGeneration: 1,
        intentMode: "reconcile-only",
        role: "implementer",
        invocationId: "cancelled-provider-invocation",
        providerCandidateSha: BASE_SHA,
        limits: {
          wallSeconds: 7_200,
          maxCostMicros: 10_000_000,
          maxAgentInvocations: 12,
        },
      }),
    ).toThrow(RunmillError);
    store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller",
      generation: 3,
      from: "CANCEL_REQUESTED",
      to: "CANCELLING",
      expectedVersion: 2,
      eventType: "cancellation.started",
      payload: cancellationEvent.payload,
    });
    const plantedTarget = "refs/heads/runmill/cancelled";
    const plantedMarker = "cancelled-effect";
    const plantedCandidate = "c".repeat(40);
    const effectKey = StateStore.asfEffectKey({
      runId,
      operation: "branch.push",
      target: plantedTarget,
      candidateSha: plantedCandidate,
    });
    const plantedIntentDigest = sha256Digest({
      schema: "runmill.asf-effect-intent/v1",
      effect_key: effectKey,
      run_id: runId,
      system: "github",
      operation: "branch.push",
      target: plantedTarget,
      correlation_marker: plantedMarker,
      candidate_sha: plantedCandidate,
      expected_remote_sha: null,
      policy_digest: DIGEST_D,
    });
    const fixture = new Database(databasePath());
    fixture
      .prepare(
        `INSERT INTO asf_effects(
           effect_key, run_id, generation, system, operation, target,
           correlation_marker, candidate_sha, expected_remote_sha,
           policy_digest, intent_digest, status, intended_at, updated_at
         ) VALUES (?, ?, 3, 'github', 'branch.push', ?, ?, ?, NULL, ?, ?,
                   'intended', ?, ?)`,
      )
      .run(
        effectKey,
        runId,
        plantedTarget,
        plantedMarker,
        plantedCandidate,
        DIGEST_D,
        plantedIntentDigest,
        NOW,
        NOW,
      );
    fixture.close();
    expect(() =>
      store.beginAsfEffect(effectKey, "worker-canceller", 3),
    ).toThrow(RunmillError);
    expect(() =>
      prepareTerminalEvidence({
        store,
        runId,
        ownerId: "worker-canceller",
        generation: 3,
        terminalPhase: "CANCELLED",
        stop: {
          code: "CANCELLED",
          summary: "an authorized controller requested cancellation",
          interruptedPhase: "ADMITTED",
          retryDisposition: "reconcile-first",
          requiredActor: "asf",
          requiredAction:
            "reconcile every unresolved external effect before starting a new attempt",
          evidenceRefs: [
            `cancellation:${forced.request_id}`,
            sha256Digest({ reason: forced.reason }),
          ],
        },
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfTerminalEvidencePlanRecord(runId)).toBeUndefined();

    const blocked = store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller",
      generation: 3,
      from: "CANCELLING",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 3,
      eventType: "run.blocked_external",
      payload: {
        code: "CLEANUP_RECONCILIATION_REQUIRED",
        summary: "terminal cleanup requires exact effect reconciliation",
        checkpoint: "CANCELLING",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action: "reconcile the interrupted repository lease",
        evidence_refs: [],
      },
    });
    expect(blocked.payload["continuation"]).toMatchObject({
      disposition: "finish-cancellation",
      resume_phase: "CANCELLING",
      interrupted_event_seq: 3,
      cancellation_event_id: cancellationEvent.event_id,
      cancellation_event_digest: sha256Digest(cancellationEvent),
      cancellation_request_id: forced.request_id,
    });
    expect(() =>
      store.recordAsfDeliveryIntent({
        ownerId: "worker-canceller",
        intent: exactDeliveryIntent({
          runId,
          generation: 3,
          eventSeq: 4,
          stage: "workspace",
          candidateSha: null,
          operation: { workspace: "forbidden-while-cancellation-is-blocked" },
        }),
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.confirmAsfDeliveryIntent({
        ownerId: "worker-canceller",
        intentId: unresolved.intent_id,
        intentDigest: unresolved.intent_digest,
        observationDigest: DIGEST_B,
        binding: {
          runId,
          workOrderId: "wo_01",
          attemptId: "attempt_01",
          policyDigest: DIGEST_D,
          fencingGeneration: 3,
          candidateSha: null,
        },
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.intendAsfEffect({
        runId,
        ownerId: "worker-canceller",
        generation: 3,
        operation: "branch.push",
        target: "refs/heads/runmill/blocked-cancel",
        correlationMarker: "blocked-cancel-effect",
        candidateSha: "c".repeat(40),
        policyDigest: DIGEST_D,
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.beginAsfEffect(effectKey, "worker-canceller", 3),
    ).toThrow(RunmillError);
    expect(() =>
      store.reserveAsfProviderBudget({
        ownerId: "worker-canceller",
        binding: {
          runId,
          workOrderId: "wo_01",
          attemptId: "attempt_01",
          policyDigest: DIGEST_D,
          fencingGeneration: 3,
          candidateSha: null,
        },
        effectKey: unresolved.effect_key,
        intentId: unresolved.intent_id,
        intentDigest: unresolved.intent_digest,
        intentGeneration: 1,
        intentMode: "reconcile-only",
        role: "implementer",
        invocationId: "blocked-cancel-provider-invocation",
        providerCandidateSha: BASE_SHA,
        limits: {
          wallSeconds: 7_200,
          maxCostMicros: 10_000_000,
          maxAgentInvocations: 12,
        },
      }),
    ).toThrow(RunmillError);
    store.releaseAsfRunOwnership(runId, "worker-canceller", 3);
    const pending = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 10,
      maxPendingItemsPerRun: 10,
    }).runs[0];
    if (pending === undefined)
      throw new Error("pending cancellation effect disappeared");
    const request = {
      schema: "asf.reconciliation-request/v1" as const,
      operation_id: "reconcile_cancel_effect_01",
      run_id: runId,
      requested_by: {
        subject: "service:asf-recovery",
        authority: "asf:reconcile" as const,
      },
      scope: "pending-effects" as const,
    };
    store.recordAsfReconciliationRequest({
      request,
      requestDigest: sha256Digest(request),
    });
    store.claimAsfReconciliation({
      operationId: request.operation_id,
      ownerId: "reconciler-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.resolveAsfDeliveryIntentReconciliation({
      effectKey: unresolved.effect_key,
      ownerId: "reconciler-a",
      generation: 4,
      outcome: "confirmed",
      observationDigest: DIGEST_B,
    });
    store.recordAsfEffectObservation({
      effectKey,
      ownerId: "reconciler-a",
      generation: 4,
      outcome: "confirmed",
      candidateSha: "c".repeat(40),
      detailsDigest: DIGEST_C,
      observer: "github:reconciliation",
    });
    const result = {
      schema: "asf.reconciliation-result/v1" as const,
      operation_id: request.operation_id,
      run_id: runId,
      pending_set_digest: pending.pendingSetDigest,
      observations: [
        {
          effect_class: "delivery-intent" as const,
          effect_key: unresolved.effect_key,
          outcome: "confirmed" as const,
        },
        {
          effect_class: "github-effect" as const,
          effect_key: effectKey,
          outcome: "confirmed" as const,
        },
      ],
    };
    expect(
      store.finishAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        generation: 4,
        status: "completed",
        resultDigest: sha256Digest(result),
        result,
        pendingSetBinding: { ...pending, retryBucket: 0 },
      }),
    ).toMatchObject({
      status: "completed",
      continuation: {
        disposition: "run-resumed",
        resumePhase: "CANCELLING",
      },
    });
    expect(store.listAsfRunEvents(runId, 4, 10).events[0]).toMatchObject({
      type: "run.resumed",
      phase: "CANCELLING",
      payload: {
        reconciliation: { action: "continue-cancellation" },
      },
    });
    expect(cancellations.request(forced)).toMatchObject({
      disposition: "existing",
      state: "CANCELLING",
      reconciliationRequired: false,
    });
    expect(() =>
      store.recordAsfDeliveryIntent({
        ownerId: "reconciler-a",
        intent: exactDeliveryIntent({
          runId,
          generation: 4,
          eventSeq: 5,
          stage: "workspace",
          candidateSha: null,
          operation: { workspace: "forbidden-after-cancellation-resume" },
        }),
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.recordAsfDeliveryIntent({
        ownerId: "reconciler-a",
        intent: exactDeliveryIntent({
          runId,
          generation: 4,
          eventSeq: 1,
          stage: "repository-lease",
          candidateSha: null,
          operation: { repository: "acme/payments" },
        }),
      }),
    ).toThrow(RunmillError);

    store.releaseAsfRunOwnership(runId, "reconciler-a", 4);
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-canceller-resumed",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 5, takeover: true });

    const terminal = prepareTerminalEvidence({
      store,
      runId,
      ownerId: "worker-canceller-resumed",
      generation: 5,
      terminalPhase: "CANCELLED",
      stop: {
        code: "CANCELLED",
        summary: "an authorized controller requested cancellation",
        interruptedPhase: "ADMITTED",
        retryDisposition: "reconcile-first",
        requiredActor: "asf",
        requiredAction:
          "reconcile every unresolved external effect before starting a new attempt",
        evidenceRefs: [
          `cancellation:${forced.request_id}`,
          sha256Digest({ reason: forced.reason }),
        ],
      },
    });
    const sideEffects =
      terminal.validated.bundle.statement.predicate.side_effects;
    expect(sideEffects.effects.map((effect) => effect.effect_class)).toEqual([
      "delivery-intent",
      "github-effect",
    ]);
    expect(sideEffects.reconciliations).toMatchObject([
      {
        operation_id: request.operation_id,
        status: "completed",
        effects: [
          {
            effect_class: "delivery-intent",
            effect_key: unresolved.effect_key,
            outcome: "confirmed",
          },
          {
            effect_class: "github-effect",
            effect_key: effectKey,
            outcome: "confirmed",
          },
        ],
      },
    ]);
    expect(
      sideEffects.effects.map((effect) =>
        effect.effect_class === "delivery-intent" ? String(effect.stage) : null,
      ),
    ).not.toContain("cleanup");
    const portableLedger = JSON.stringify(sideEffects);
    for (const privateValue of [
      plantedTarget,
      plantedMarker,
      "github:reconciliation",
      "service:asf-recovery",
      "worker-canceller-resumed",
    ]) {
      expect(portableLedger).not.toContain(privateValue);
    }
    store.transitionAsfRun({
      runId,
      ownerId: "worker-canceller-resumed",
      generation: 5,
      from: "CANCELLING",
      to: "CANCELLED",
      expectedVersion: 5,
      eventType: "run.cancelled",
      payload: {
        ...cancellationEvent.payload,
        terminal_evidence_bundle_digest: terminal.record.bundleDigest,
      },
      checkpoint: {
        ...cleanupCheckpoint("cancelled"),
        durableOutputs: {
          cleanup_evidence_digest: terminal.record.cleanupDigest,
          terminal_evidence_bundle_digest: terminal.record.bundleDigest,
        },
        correlationMarker: terminal.cleanupIntent.intent_id,
      },
    });
    expect(store.getAsfRun(runId)).toMatchObject({ state: "CANCELLED" });
  });

  it("persists exact GitHub effect intent before mutation and permits retry only after observation", () => {
    const store = open();
    const runId = "run_effect";
    const candidateSha = "c".repeat(40);
    const admission = admissionInput(runId);
    store.admitAsfWorkOrder(admission);
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    let phase: RunEventPhase = "ADMITTED";
    let version = 1;
    const advance = (
      to: RunEventPhase,
      eventType: string,
      payload: Readonly<Record<string, unknown>>,
    ) => {
      const checkpoint = stageCheckpoint(eventType);
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: phase,
        to,
        expectedVersion: version,
        eventType,
        payload,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      phase = to;
      version += 1;
    };
    advance("REPOSITORY_LEASED", "repository.lease_acquired", {
      repository: "acme/payments",
      generation: 1,
    });
    advance("IDENTITY_READY", "identity.leases_acquired", {
      attributions_digest: DIGEST_A,
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
      attributions: identityAttributions(),
    });
    advance("WORKSPACE_READY", "workspace.prepared", {
      workspace_id: "workspace_effect",
      sandbox_profile: "linux-production-v1",
      isolation_evidence_digest: DIGEST_A,
    });
    advance("TASK_PACKET_READY", "task_packet.created", {
      task_packet_digest: DIGEST_A,
      source_snapshot_digest: DIGEST_B,
    });
    advance("IMPLEMENTING", "implementation.started", {
      session: "new",
      checkpoint_digest: DIGEST_A,
    });
    advance("CANDIDATE_READY", "candidate.created", {
      candidate_sha: candidateSha,
      parent_sha: BASE_SHA,
      tree_digest: DIGEST_A,
    });

    const intentInput = {
      runId,
      ownerId: "worker-a",
      generation: 1,
      operation: "branch.push",
      target: "acme/payments#refs/heads/runmill/run_effect",
      correlationMarker: "runmill:v1:run=run_effect;attempt=attempt_01",
      candidateSha,
      expectedRemoteSha: null,
      policyDigest: admission.effectivePolicy.digest,
    } as const;
    const intended = store.intendAsfEffect(intentInput);
    expect(intended).toMatchObject({
      status: "intended",
      system: "github",
      operation: "branch.push",
      candidateSha,
      generation: 1,
    });
    expect(store.intendAsfEffect(intentInput)).toEqual(intended);
    expect(() =>
      store.intendAsfEffect({
        ...intentInput,
        correlationMarker: "contradictory-marker",
      }),
    ).toThrow(RunmillError);

    expect(
      store.beginAsfEffect(intended.effectKey, "worker-a", 1),
    ).toMatchObject({
      status: "in_flight",
    });
    expect(() =>
      store.beginAsfEffect(intended.effectKey, "worker-a", 1),
    ).toThrow(RunmillError);
    clock.advanceMinutes(2);
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:06:00.000Z",
      }),
    ).toEqual({ generation: 2, takeover: true });
    expect(() =>
      store.recordAsfEffectObservation({
        effectKey: intended.effectKey,
        ownerId: "worker-a",
        generation: 1,
        outcome: "confirmed",
        candidateSha,
        detailsDigest: DIGEST_A,
        observer: "github:branch",
      }),
    ).toThrow(RunmillError);

    const absent = store.recordAsfEffectObservation({
      effectKey: intended.effectKey,
      ownerId: "worker-b",
      generation: 2,
      outcome: "not_applied",
      candidateSha,
      detailsDigest: DIGEST_A,
      observer: "github:branch",
    });
    expect(absent.seq).toBe(1);
    expect(
      store.beginAsfEffect(intended.effectKey, "worker-b", 2),
    ).toMatchObject({
      status: "in_flight",
      generation: 2,
    });
    const confirmed = store.recordAsfEffectObservation({
      effectKey: intended.effectKey,
      ownerId: "worker-b",
      generation: 2,
      outcome: "confirmed",
      candidateSha,
      detailsDigest: DIGEST_B,
      observer: "github:branch",
      remoteId: "refs/heads/runmill/run_effect",
    });
    expect(confirmed.seq).toBe(2);
    expect(store.getAsfEffect(intended.effectKey)).toMatchObject({
      status: "confirmed",
      observationDigest: DIGEST_B,
      remoteId: "refs/heads/runmill/run_effect",
      retryProhibited: 0,
    });
    expect(store.listPendingAsfEffects(runId)).toEqual([]);
    expect(
      store
        .asfEffectObservations(intended.effectKey)
        .map((item) => item.outcome),
    ).toEqual(["not_applied", "confirmed"]);

    const emptyRequest = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_empty",
      run_id: runId,
      requested_by: {
        subject: "service:asf-controller",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    } as const;
    expect(
      store.recordAsfReconciliationRequest({
        request: emptyRequest,
        requestDigest: sha256Digest(emptyRequest),
      }),
    ).toMatchObject({
      disposition: "nothing-to-reconcile",
      status: "completed",
    });

    const pending = store.intendAsfEffect({
      ...intentInput,
      ownerId: "worker-b",
      generation: 2,
      operation: "pull_request.create",
      target: "acme/payments#refs/heads/runmill/run_effect->refs/heads/main",
      correlationMarker: "runmill:v1:run=run_effect;attempt=attempt_01;pr=1",
    });
    store.releaseAsfRunOwnership(runId, "worker-b", 2);
    const request = {
      ...emptyRequest,
      operation_id: "reconcile_pending",
    } as const;
    expect(
      store.recordAsfReconciliationRequest({
        request,
        requestDigest: sha256Digest(request),
      }),
    ).toMatchObject({ disposition: "queued", status: "queued" });
    expect(
      store.recordAsfReconciliationRequest({
        request,
        requestDigest: sha256Digest(request),
      }),
    ).toMatchObject({
      disposition: "existing",
      operationId: "reconcile_pending",
    });
    expect(() =>
      store.recordAsfReconciliationRequest({
        request: {
          ...request,
          requested_by: {
            subject: "service:other-controller",
            authority: "asf:reconcile",
          },
        },
        requestDigest: sha256Digest({
          ...request,
          requested_by: {
            subject: "service:other-controller",
            authority: "asf:reconcile",
          },
        }),
      }),
    ).toThrow(RunmillError);

    expect(
      store.claimAsfReconciliation({
        operationId: "reconcile_pending",
        ownerId: "reconciler-a",
        staleBefore: "2026-08-21T10:06:00.000Z",
      }),
    ).toEqual({ runId, generation: 3 });
    store.recordAsfEffectObservation({
      effectKey: pending.effectKey,
      ownerId: "reconciler-a",
      generation: 3,
      outcome: "not_applied",
      candidateSha,
      detailsDigest: DIGEST_C,
      observer: "github:pull-request",
    });
    expect(
      store.finishAsfReconciliation({
        operationId: "reconcile_pending",
        ownerId: "reconciler-a",
        generation: 3,
        status: "completed",
        resultDigest: DIGEST_D,
      }),
    ).toMatchObject({ status: "completed", resultDigest: DIGEST_D });
    expect(store.listRecoverableAsfReconciliations()).toEqual([]);
    expect(
      store.claimAsfReconciliation({
        operationId: "reconcile_pending",
        ownerId: "reconciler-b",
        staleBefore: "2026-08-21T10:06:00.000Z",
      }),
    ).toBeNull();
  });

  it("atomically resumes an exact confirmed reconciliation and reuses only the prior effect cursor", async () => {
    const store = open();
    const runId = "run_reconciliation_resume";
    store.admitAsfWorkOrder(admissionInput(runId));
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 1, takeover: false });
    store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REPOSITORY_LEASED",
      expectedVersion: 1,
      eventType: "repository.lease_acquired",
      payload: { repository: "acme/payments", generation: 1 },
      checkpoint: stageCheckpoint("repository.lease_acquired"),
    });
    const initialIntent = exactDeliveryIntent({
      runId,
      generation: 1,
      eventSeq: 2,
      stage: "identity-leases",
      candidateSha: null,
      operation: { roles: ["implementer", "local-reviewer", "pr-reviewer"] },
    });
    expect(
      store.recordAsfDeliveryIntent({
        ownerId: "worker-a",
        intent: initialIntent,
      }),
    ).toMatchObject({ disposition: "created" });
    const blocked = store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "REPOSITORY_LEASED",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 2,
      eventType: "run.blocked_external",
      payload: {
        code: "INTERNAL_DELIVERY_FAILURE",
        summary: "identity effect outcome was lost with the worker response",
        checkpoint: "REPOSITORY_LEASED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action: "observe the exact prior identity effect",
        evidence_refs: [],
      },
    });
    const continuation = blocked.payload["continuation"] as Record<
      string,
      unknown
    >;
    expect(continuation).toMatchObject({
      schema: "asf.reconciliation-continuation/v1",
      disposition: "retry-interrupted-phase",
      interrupted_event_seq: 2,
      resume_phase: "REPOSITORY_LEASED",
    });
    store.releaseAsfRunOwnership(runId, "worker-a", 1);

    const pending = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 10,
      maxPendingItemsPerRun: 10,
    }).runs[0];
    expect(pending).toMatchObject({
      runId,
      githubEffectCount: 0,
      deliveryIntentCount: 1,
    });
    if (pending === undefined)
      throw new Error("pending reconciliation fixture disappeared");
    const request = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_confirmed_resume",
      run_id: runId,
      requested_by: {
        subject: "service:asf-recovery",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    } as const;
    store.recordAsfReconciliationRequest({
      request,
      requestDigest: sha256Digest(request),
    });
    expect(
      store.claimAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ runId, generation: 2 });
    const observer = new StateStoreAsfDeliveryReconciliationObserver({
      store,
      adapter: {
        async observe(input) {
          return {
            schema: "asf.delivery-intent-reconciliation-observation/v1",
            effect_key: input.intent.effect_key,
            intent_digest: input.intent.intent_digest,
            outcome: "confirmed",
            observation_digest: DIGEST_A,
          };
        },
      },
    });
    const observations = await observer.reconcilePending({
      runId,
      ownerId: "reconciler-a",
      generation: 2,
      effectClass: "delivery-intent",
      expectedCount: 1,
      pendingSetBinding: { ...pending, retryBucket: 0 },
    });
    expect(observations).toEqual([
      {
        effectClass: "delivery-intent",
        effectKey: initialIntent.effect_key,
        status: "confirmed",
      },
    ]);
    const result = {
      schema: "asf.reconciliation-result/v1" as const,
      operation_id: request.operation_id,
      run_id: runId,
      pending_set_digest: pending.pendingSetDigest,
      observations: [
        {
          effect_class: "delivery-intent" as const,
          effect_key: initialIntent.effect_key,
          outcome: "confirmed" as const,
        },
      ],
    };
    const finished = store.finishAsfReconciliation({
      operationId: request.operation_id,
      ownerId: "reconciler-a",
      generation: 2,
      status: "completed",
      resultDigest: sha256Digest(result),
      result,
      pendingSetBinding: { ...pending, retryBucket: 0 },
    });
    expect(finished).toMatchObject({
      status: "completed",
      resumedEventSeq: 4,
      continuation: {
        disposition: "run-resumed",
        resumedEventSeq: 4,
        resumePhase: "REPOSITORY_LEASED",
      },
    });
    store.releaseAsfRunOwnership(runId, "reconciler-a", 2);
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "REPOSITORY_LEASED",
      stateVersion: 4,
      ownerId: null,
    });
    expect(store.listAsfRunEvents(runId, 3, 1).events[0]).toMatchObject({
      type: "run.resumed",
      payload: {
        interrupted_phase: "BLOCKED_EXTERNAL",
        reconciliation: {
          operation_id: request.operation_id,
          action: "continue-confirmed",
          interrupted_event_seq: 2,
        },
      },
    });

    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 3, takeover: true });
    const replayIntent = exactDeliveryIntent({
      runId,
      generation: 3,
      eventSeq: 2,
      stage: "identity-leases",
      candidateSha: null,
      operation: { roles: ["implementer", "local-reviewer", "pr-reviewer"] },
    });
    expect(
      store.recordAsfDeliveryIntent({
        ownerId: "worker-b",
        intent: replayIntent,
      }),
    ).toMatchObject({
      disposition: "existing-prior-generation",
      intent: { effect_key: initialIntent.effect_key, fencing_generation: 1 },
    });
    expect(() =>
      store.recordAsfDeliveryIntent({
        ownerId: "worker-b",
        intent: exactDeliveryIntent({
          runId,
          generation: 3,
          eventSeq: 2,
          stage: "workspace",
          candidateSha: null,
          operation: { workspace: "new-authority" },
        }),
      }),
    ).toThrow(RunmillError);
  });

  it("turns exact not-applied evidence into one durable bounded replay authorization", () => {
    const store = open();
    const runId = "run_reconciliation_not_applied";
    store.admitAsfWorkOrder(admissionInput(runId));
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "ADMITTED",
      to: "REPOSITORY_LEASED",
      expectedVersion: 1,
      eventType: "repository.lease_acquired",
      payload: { repository: "acme/payments", generation: 1 },
      checkpoint: stageCheckpoint("repository.lease_acquired"),
    });
    const intent = exactDeliveryIntent({
      runId,
      generation: 1,
      eventSeq: 2,
      stage: "identity-leases",
      candidateSha: null,
      operation: { roles: ["implementer", "local-reviewer", "pr-reviewer"] },
    });
    store.recordAsfDeliveryIntent({ ownerId: "worker-a", intent });
    store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "REPOSITORY_LEASED",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 2,
      eventType: "run.blocked_external",
      payload: {
        code: "INTERNAL_DELIVERY_FAILURE",
        summary: "effect outcome requires observation",
        checkpoint: "REPOSITORY_LEASED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action: "observe the prior effect",
        evidence_refs: [],
      },
    });
    store.releaseAsfRunOwnership(runId, "worker-a", 1);
    const pending = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 10,
      maxPendingItemsPerRun: 10,
    }).runs[0];
    if (pending === undefined)
      throw new Error("pending reconciliation fixture disappeared");
    const request = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_not_applied",
      run_id: runId,
      requested_by: {
        subject: "service:asf-recovery",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    } as const;
    store.recordAsfReconciliationRequest({
      request,
      requestDigest: sha256Digest(request),
    });
    store.claimAsfReconciliation({
      operationId: request.operation_id,
      ownerId: "reconciler-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.resolveAsfDeliveryIntentReconciliation({
      effectKey: intent.effect_key,
      ownerId: "reconciler-a",
      generation: 2,
      outcome: "not_applied",
      observationDigest: DIGEST_B,
    });
    const result = {
      schema: "asf.reconciliation-result/v1" as const,
      operation_id: request.operation_id,
      run_id: runId,
      pending_set_digest: pending.pendingSetDigest,
      observations: [
        {
          effect_class: "delivery-intent" as const,
          effect_key: intent.effect_key,
          outcome: "not_applied" as const,
        },
      ],
    };
    const finished = store.finishAsfReconciliation({
      operationId: request.operation_id,
      ownerId: "reconciler-a",
      generation: 2,
      status: "completed",
      resultDigest: sha256Digest(result),
      result,
      pendingSetBinding: { ...pending, retryBucket: 0 },
    });
    expect(finished).toMatchObject({
      status: "completed",
      continuation: {
        disposition: "run-resumed",
        resumePhase: "REPOSITORY_LEASED",
      },
    });
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "REPOSITORY_LEASED",
      stateVersion: 4,
    });
    expect(store.listAsfRunEvents(runId, 3, 1).events[0]).toMatchObject({
      type: "run.resumed",
      payload: {
        reconciliation: {
          operation_id: request.operation_id,
          action: "replay-not-applied",
          interrupted_event_seq: 2,
        },
      },
    });
    expect(store.listAsfDeliveryIntentObservations(intent.effect_key)).toEqual([
      expect.objectContaining({
        seq: 1,
        outcome: "not_applied",
        observationDigest: DIGEST_B,
        generation: 2,
        source: "reconciliation",
      }),
    ]);

    store.releaseAsfRunOwnership(runId, "reconciler-a", 2);
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 3, takeover: true });
    const replayIntent = exactDeliveryIntent({
      runId,
      generation: 3,
      eventSeq: 2,
      stage: "identity-leases",
      candidateSha: null,
      operation: { roles: ["implementer", "local-reviewer", "pr-reviewer"] },
    });
    expect(
      store.recordAsfDeliveryIntent({
        ownerId: "worker-b",
        intent: replayIntent,
      }),
    ).toMatchObject({
      disposition: "existing-prior-generation-replay-authorized",
      intent: {
        effect_key: intent.effect_key,
        observationOutcome: null,
        replayAuthorizedOperationId: request.operation_id,
        replayStartedGeneration: 3,
      },
    });
    expect(
      store.recordAsfDeliveryIntent({
        ownerId: "worker-b",
        intent: replayIntent,
      }),
    ).toMatchObject({ disposition: "existing-prior-generation" });
    const replayInterrupted = store.transitionAsfRun({
      runId,
      ownerId: "worker-b",
      generation: 3,
      from: "REPOSITORY_LEASED",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 4,
      eventType: "run.blocked_external",
      payload: {
        code: "INTERNAL_DELIVERY_FAILURE",
        summary: "worker died after consuming replay authority",
        checkpoint: "REPOSITORY_LEASED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action:
          "observe the replayed effect without invoking it again",
        evidence_refs: [],
      },
    });
    expect(replayInterrupted.payload["continuation"]).toMatchObject({
      interrupted_event_seq: 2,
      resume_phase: "REPOSITORY_LEASED",
    });
    store.releaseAsfRunOwnership(runId, "worker-b", 3);

    const replayPending = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 10,
      maxPendingItemsPerRun: 10,
    }).runs[0];
    if (replayPending === undefined)
      throw new Error("replay pending set disappeared");
    const confirmRequest = {
      ...request,
      operation_id: "reconcile_replay_confirmed",
    } as const;
    store.recordAsfReconciliationRequest({
      request: confirmRequest,
      requestDigest: sha256Digest(confirmRequest),
    });
    store.claimAsfReconciliation({
      operationId: confirmRequest.operation_id,
      ownerId: "reconciler-b",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.resolveAsfDeliveryIntentReconciliation({
      effectKey: intent.effect_key,
      ownerId: "reconciler-b",
      generation: 4,
      outcome: "confirmed",
      observationDigest: DIGEST_C,
    });
    const confirmedResult = {
      schema: "asf.reconciliation-result/v1" as const,
      operation_id: confirmRequest.operation_id,
      run_id: runId,
      pending_set_digest: replayPending.pendingSetDigest,
      observations: [
        {
          effect_class: "delivery-intent" as const,
          effect_key: intent.effect_key,
          outcome: "confirmed" as const,
        },
      ],
    };
    expect(
      store.finishAsfReconciliation({
        operationId: confirmRequest.operation_id,
        ownerId: "reconciler-b",
        generation: 4,
        status: "completed",
        resultDigest: sha256Digest(confirmedResult),
        result: confirmedResult,
        pendingSetBinding: { ...replayPending, retryBucket: 0 },
      }),
    ).toMatchObject({
      continuation: {
        disposition: "run-resumed",
        resumePhase: "REPOSITORY_LEASED",
      },
    });
    expect(
      store
        .listAsfDeliveryIntentObservations(intent.effect_key)
        .map((row) => row.outcome),
    ).toEqual(["not_applied", "confirmed"]);
  });

  it("resumes only after a canonical exact result covers mixed GitHub and delivery effects", () => {
    const store = open();
    const runId = "run_reconciliation_mixed";
    const candidateSha = "d".repeat(40);
    const admission = admissionInput(runId);
    store.admitAsfWorkOrder(admission);
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    let phase: RunEventPhase = "ADMITTED";
    let version = 1;
    const advance = (
      to: RunEventPhase,
      eventType: string,
      payload: Readonly<Record<string, unknown>>,
    ): void => {
      store.transitionAsfRun({
        runId,
        ownerId: "worker-a",
        generation: 1,
        from: phase,
        to,
        expectedVersion: version,
        eventType,
        payload,
        checkpoint: stageCheckpoint(eventType),
      });
      phase = to;
      version += 1;
    };
    advance("REPOSITORY_LEASED", "repository.lease_acquired", {
      repository: "acme/payments",
      generation: 1,
    });
    advance("IDENTITY_READY", "identity.leases_acquired", {
      attributions_digest: DIGEST_A,
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
      attributions: identityAttributions(),
    });
    advance("WORKSPACE_READY", "workspace.prepared", {
      workspace_id: "workspace_mixed",
      sandbox_profile: "linux-production-v1",
      isolation_evidence_digest: DIGEST_A,
    });
    advance("TASK_PACKET_READY", "task_packet.created", {
      task_packet_digest: DIGEST_A,
      source_snapshot_digest: DIGEST_B,
    });
    advance("IMPLEMENTING", "implementation.started", {
      session: "new",
      checkpoint_digest: DIGEST_A,
    });
    advance("CANDIDATE_READY", "candidate.created", {
      candidate_sha: candidateSha,
      parent_sha: BASE_SHA,
      tree_digest: DIGEST_C,
    });

    const deliveryIntent = exactDeliveryIntent({
      runId,
      generation: 1,
      eventSeq: version,
      stage: "local-verification",
      candidateSha,
      operation: {
        candidate_sha: candidateSha,
        required_checks: ["lint", "unit"],
      },
    });
    store.recordAsfDeliveryIntent({
      ownerId: "worker-a",
      intent: deliveryIntent,
    });
    const githubEffect = store.intendAsfEffect({
      runId,
      ownerId: "worker-a",
      generation: 1,
      operation: "branch.push",
      target: "acme/payments#refs/heads/runmill/asf/mixed",
      correlationMarker: "runmill-asf-mixed",
      candidateSha,
      expectedRemoteSha: null,
      policyDigest: admission.effectivePolicy.digest,
    });
    const blocked = store.transitionAsfRun({
      runId,
      ownerId: "worker-a",
      generation: 1,
      from: "CANDIDATE_READY",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: version,
      eventType: "run.blocked_external",
      payload: {
        code: "INTERNAL_DELIVERY_FAILURE",
        summary: "mixed effects require exact remote observation",
        checkpoint: "CANDIDATE_READY",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action: "observe every exact interrupted effect",
        evidence_refs: [],
      },
    });
    expect(blocked.payload["continuation"]).toMatchObject({
      interrupted_event_seq: version,
      resume_phase: "CANDIDATE_READY",
    });
    store.releaseAsfRunOwnership(runId, "worker-a", 1);

    const pending = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 10,
      maxPendingItemsPerRun: 10,
    }).runs[0];
    expect(pending).toMatchObject({
      githubEffectCount: 1,
      deliveryIntentCount: 1,
    });
    if (pending === undefined) throw new Error("mixed pending set disappeared");
    const request = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_mixed_confirmed",
      run_id: runId,
      requested_by: {
        subject: "service:asf-recovery",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    } as const;
    store.recordAsfReconciliationRequest({
      request,
      requestDigest: sha256Digest(request),
    });
    store.claimAsfReconciliation({
      operationId: request.operation_id,
      ownerId: "reconciler-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    store.resolveAsfDeliveryIntentReconciliation({
      effectKey: deliveryIntent.effect_key,
      ownerId: "reconciler-a",
      generation: 2,
      outcome: "confirmed",
      observationDigest: DIGEST_A,
    });
    store.recordAsfEffectObservation({
      effectKey: githubEffect.effectKey,
      ownerId: "reconciler-a",
      generation: 2,
      outcome: "confirmed",
      candidateSha,
      detailsDigest: DIGEST_B,
      observer: "github:branch",
      remoteId: "refs/heads/runmill/asf/mixed",
    });
    const observations = [
      {
        effect_class: "delivery-intent" as const,
        effect_key: deliveryIntent.effect_key,
        outcome: "confirmed" as const,
      },
      {
        effect_class: "github-effect" as const,
        effect_key: githubEffect.effectKey,
        outcome: "confirmed" as const,
      },
    ];
    const reversedResult = {
      schema: "asf.reconciliation-result/v1" as const,
      operation_id: request.operation_id,
      run_id: runId,
      pending_set_digest: pending.pendingSetDigest,
      observations: [...observations].reverse(),
    };
    expect(() =>
      store.finishAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        generation: 2,
        status: "completed",
        resultDigest: sha256Digest(reversedResult),
        result: reversedResult,
        pendingSetBinding: { ...pending, retryBucket: 0 },
      }),
    ).toThrow(RunmillError);
    expect(store.getAsfReconciliation(request.operation_id)).toMatchObject({
      status: "running",
      resumedEventSeq: null,
    });

    const result = { ...reversedResult, observations };
    expect(
      store.finishAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        generation: 2,
        status: "completed",
        resultDigest: sha256Digest(result),
        result,
        pendingSetBinding: { ...pending, retryBucket: 0 },
      }),
    ).toMatchObject({
      status: "completed",
      resumedEventSeq: version + 2,
      continuation: {
        disposition: "run-resumed",
        resumePhase: "CANDIDATE_READY",
      },
    });
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "CANDIDATE_READY",
      stateVersion: version + 2,
      generation: 2,
    });
  });

  it("resumes signed approval with owner-null checkpoint takeover and exact bindings", () => {
    const store = open();
    const runId = "run_approval";
    const candidateSha = "c".repeat(40);
    const admission = admissionInput(runId);
    store.admitAsfWorkOrder(admission);
    store.claimAsfRun({
      runId,
      ownerId: "worker-a",
      staleBefore: "2026-08-21T10:04:00.000Z",
    });
    let phase: RunEventPhase = "ADMITTED";
    let version = 1;
    let ownerId = "worker-a";
    let generation = 1;
    const advance = (
      to: RunEventPhase,
      eventType: string,
      payload: Readonly<Record<string, unknown>>,
    ) => {
      const checkpoint = stageCheckpoint(eventType);
      store.transitionAsfRun({
        runId,
        ownerId,
        generation,
        from: phase,
        to,
        expectedVersion: version,
        eventType,
        payload,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      phase = to;
      version += 1;
    };
    advance("REPOSITORY_LEASED", "repository.lease_acquired", {
      repository: "acme/payments",
      generation: 1,
    });
    advance("IDENTITY_READY", "identity.leases_acquired", {
      attributions_digest: DIGEST_A,
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
      attributions: identityAttributions(),
    });
    advance("WORKSPACE_READY", "workspace.prepared", {
      workspace_id: "workspace_approval",
      sandbox_profile: "linux-production-v1",
      isolation_evidence_digest: DIGEST_A,
    });
    advance("TASK_PACKET_READY", "task_packet.created", {
      task_packet_digest: DIGEST_A,
      source_snapshot_digest: DIGEST_B,
    });
    advance("IMPLEMENTING", "implementation.started", {
      session: "new",
      checkpoint_digest: DIGEST_A,
    });
    advance("CANDIDATE_READY", "candidate.created", {
      candidate_sha: candidateSha,
      parent_sha: BASE_SHA,
      tree_digest: DIGEST_A,
    });

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const approval: ApprovalEnvelope = {
      schema: "asf.approval-envelope/v1",
      key_id: "approval-key-01",
      algorithm: "EdDSA",
      payload: {
        schema: "asf.approval/v1",
        approval_id: "approval_01",
        work_order_id: admission.envelope.payload.work_order_id,
        work_order_digest: admission.payloadDigest,
        run_id: runId,
        attempt_id: admission.envelope.payload.attempt_id,
        candidate_sha: candidateSha,
        decision: "approved",
        decision_type: "delivery",
        requested_effect: "pull-request-delivery",
        policy_digest: admission.effectivePolicy.digest,
        approver: {
          subject: "user:release-owner",
          authority: "asf:delivery-approver",
        },
        issued_at: "2026-08-21T10:00:00Z",
        expires_at: "2026-08-21T10:15:00Z",
      },
      signature: "base64url:AA",
    };
    approval.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(approval), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    const trustedSigners = [
      {
        keyId: "approval-key-01",
        publicKey,
        subjects: ["user:release-owner"],
        authorities: ["asf:delivery-approver"],
        decisionTypes: ["delivery"],
        requestedEffects: ["pull-request-delivery"],
      },
    ];
    const approvals = new AsfApprovalService({ store, clock, trustedSigners });

    expect(approvals.record(approval)).toMatchObject({
      approvalId: "approval_01",
      disposition: "recorded",
      decision: "approved",
    });
    expect(approvals.record(approval)).toMatchObject({
      disposition: "existing",
    });
    expect(
      approvals.requireCurrent(runId, "delivery", "pull-request-delivery"),
    ).toMatchObject({ approvalId: "approval_01", decision: "approved" });

    advance("WAITING_APPROVAL", "run.waiting_approval", {
      code: "APPROVAL_REQUIRED",
      summary: "delivery approval is required",
      checkpoint: "CANDIDATE_READY",
      retry_disposition: "safe",
      required_actor: "repository-owner",
      required_action: "approve the exact candidate delivery effect",
      evidence_refs: ["approval:approval_01"],
      candidate_sha: candidateSha,
      decision_type: "delivery",
      requested_effect: "pull-request-delivery",
    });

    const atomicApproval = structuredClone(approval);
    atomicApproval.payload.approval_id = "approval_atomic_rollback";
    atomicApproval.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(atomicApproval), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    const fault = new Database(databasePath());
    fault.exec(`
      CREATE TRIGGER fail_approval_resume_event
      BEFORE INSERT ON events
      WHEN NEW.type = 'run.resumed'
      BEGIN
        SELECT RAISE(ABORT, 'injected approval resume event failure');
      END;
    `);
    expect(() => approvals.record(atomicApproval)).toThrow(
      /injected approval resume event failure/u,
    );
    expect(store.getAsfApproval("approval_atomic_rollback")).toBeUndefined();
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "WAITING_APPROVAL",
      stateVersion: version,
      ownerId: "worker-a",
      generation: 1,
    });
    fault.exec("DROP TRIGGER fail_approval_resume_event");
    fault.close();

    expect(approvals.record(approval)).toMatchObject({
      disposition: "existing",
      resumed: true,
      resumePhase: "CANDIDATE_READY",
    });
    phase = "CANDIDATE_READY";
    version += 1;
    expect(store.getAsfRun(runId)).toMatchObject({
      state: "CANDIDATE_READY",
      candidateSha,
      ownerId: null,
      generation: 2,
    });
    expect(store.getLatestAsfCheckpoint(runId)?.fencing_generation).toBe(1);
    expect(
      store.claimAsfRun({
        runId,
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ generation: 3, takeover: true });
    ownerId = "worker-b";
    generation = 3;
    expect(store.listAsfRunEvents(runId).events.at(-1)).toMatchObject({
      type: "run.resumed",
      phase: "CANDIDATE_READY",
      payload: {
        interrupted_phase: "WAITING_APPROVAL",
        resume_phase: "CANDIDATE_READY",
        approval_id: "approval_01",
        evidence_digest: sha256Digest(approval),
        candidate_sha: candidateSha,
      },
      policy_digest: admission.effectivePolicy.digest,
    });

    const databaseRace = structuredClone(approval);
    databaseRace.payload.approval_id = "approval_wrong_binding";
    databaseRace.payload.work_order_digest = DIGEST_A;
    databaseRace.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(databaseRace), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    const validatedWrongBinding = validateApproval(databaseRace, {
      clock,
      trustedSigners,
      expected: {
        workOrderId: databaseRace.payload.work_order_id,
        workOrderDigest: DIGEST_A,
        runId,
        attemptId: databaseRace.payload.attempt_id,
        candidateSha,
        policyDigest: databaseRace.payload.policy_digest,
        decisionType: databaseRace.payload.decision_type,
        requestedEffect: databaseRace.payload.requested_effect,
      },
    });
    expect(() => store.recordAsfApproval(validatedWrongBinding)).toThrow(
      RunmillError,
    );

    advance("WAITING_APPROVAL", "run.waiting_approval", {
      code: "APPROVAL_REQUIRED",
      summary: "delivery approval is required again",
      checkpoint: "CANDIDATE_READY",
      retry_disposition: "safe",
      required_actor: "repository-owner",
      required_action: "supply a current approval",
      evidence_refs: ["approval:approval_01"],
      candidate_sha: candidateSha,
      decision_type: "delivery",
      requested_effect: "pull-request-delivery",
    });
    const denied = structuredClone(approval);
    denied.payload.approval_id = "approval_denied";
    denied.payload.decision = "denied";
    denied.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(denied), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    expect(approvals.record(denied)).toMatchObject({
      decision: "denied",
      resumed: false,
      resumePhase: null,
    });
    expect(store.getAsfRun(runId)?.state).toBe("WAITING_APPROVAL");

    const expandedApprovals = new AsfApprovalService({
      store,
      clock,
      trustedSigners: [
        {
          ...trustedSigners[0]!,
          decisionTypes: ["delivery", "release"],
          requestedEffects: ["pull-request-delivery", "merge"],
        },
      ],
    });
    const wrongEffect = structuredClone(approval);
    wrongEffect.payload.approval_id = "approval_wrong_effect";
    wrongEffect.payload.requested_effect = "merge";
    wrongEffect.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(wrongEffect), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    expect(expandedApprovals.record(wrongEffect)).toMatchObject({
      approvalId: "approval_wrong_effect",
      resumed: false,
      resumePhase: null,
    });
    const wrongDecisionType = structuredClone(approval);
    wrongDecisionType.payload.approval_id = "approval_wrong_decision_type";
    wrongDecisionType.payload.decision_type = "release";
    wrongDecisionType.signature = `base64url:${signBytes(
      null,
      Buffer.from(approvalSigningPayload(wrongDecisionType), "utf8"),
      privateKey,
    ).toString("base64url")}`;
    expect(expandedApprovals.record(wrongDecisionType)).toMatchObject({
      approvalId: "approval_wrong_decision_type",
      resumed: false,
      resumePhase: null,
    });
    expect(store.getAsfRun(runId)?.state).toBe("WAITING_APPROVAL");

    clock.advanceMinutes(11);
    expect(() =>
      approvals.requireCurrent(runId, "delivery", "pull-request-delivery"),
    ).toThrow(RunmillError);
    expect(() =>
      advance("CANDIDATE_READY", "run.resumed", {
        interrupted_phase: "WAITING_APPROVAL",
        resume_phase: "CANDIDATE_READY",
        approval_id: "approval_01",
        evidence_digest: DIGEST_A,
        candidate_sha: candidateSha,
      }),
    ).toThrow(RunmillError);
  });
});
