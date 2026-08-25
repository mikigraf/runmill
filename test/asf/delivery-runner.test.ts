import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASF_CANDIDATE_INVALIDATION_ACK_SCHEMA,
  ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
  ASF_DELIVERY_RECOVERY_DISPATCH_SCHEMA,
  AsfDeliveryStop,
  AsfPrDeliveryRunner,
  type AsfDeliveryBinding,
  type AsfDeliveryIntentStore,
  type AsfDeliveryStageIntent,
  type AsfPrDeliveryRunnerOptions,
} from "../../src/asf/delivery-runner.js";
import {
  ASF_DURABLE_CHECKPOINT_SCHEMA,
  ASF_RECOVERY_REQUEST_SCHEMA,
  CANDIDATE_CHANGE_INVALIDATES,
  AuthorizedImplementerResume,
  createDurableAsfCheckpoint,
  getAsfCheckpointRecoveryPolicy,
  type DurableAsfCheckpoint,
  publicAsfCheckpointSummary,
} from "../../src/asf/checkpoint-policy.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../../src/asf/canonical-json.js";
import { parseRunEvent, type RunEvent } from "../../src/asf/run-event.js";
import {
  AsfPendingCiRetryError,
  AsfPendingTerminalEvidenceRetryError,
  type AsfRunnerContext,
  type AsfRunnerTransition,
} from "../../src/asf/service.js";
import {
  StateStore,
  type AsfAdmissionRecord,
  type AsfCheckpointRecord,
  type AsfDurableRunSnapshot,
  type AsfEvidenceBundleRecord,
  type AsfTerminalEvidenceBundleRecord,
  type AsfTerminalEvidenceIntentRecord,
  type AsfTerminalEvidencePlanRecord,
  type AsfRunRow,
  type StoredAsfDeliveryStageIntent,
} from "../../src/state/store.js";
import type {
  EffectiveAsfPolicy,
  WorkOrderEnvelope,
} from "../../src/asf/work-order.js";
import type { ArtifactVerifiedAsfEvidenceBundle } from "../../src/evidence/asf-validator.js";
import {
  validateSignedAsfTerminalEvidenceBundle,
  type AsfTerminalEvidenceExpectations,
  type AsfTerminalEvidenceIntent,
  type AsfTerminalEvidencePlan,
  type SignedAsfTerminalEvidenceBundle,
  type ValidatedAsfTerminalEvidenceBundle,
} from "../../src/evidence/asf-terminal.js";
import {
  ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA,
  type TrustedProviderExecution,
} from "../../src/agent/trusted-harness.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import {
  ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
  identityAttributionsDigest,
  identityLeaseAttributionDigest,
  type AsfRequiredIdentityRole,
} from "../../src/asf/identity-attribution.js";
import {
  ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA,
  asfCostLimitUsdToMicros,
  asfMicrosToUsd,
  asfObservedCostUsdToMicros,
  asfProviderBudgetReservationId,
  type AsfProviderBudgetController,
  type AsfProviderEffectBudgetInput,
} from "../../src/asf/budget.js";
import type { Clock } from "../../src/platform/clock.js";
import { StateStoreAsfDeliveryIntentStore } from "../../src/asf/state-delivery-intent-store.js";
import { ProductionAsfTerminalEvidenceFinalizationController } from "../../src/asf/terminal-evidence-finalizer.js";
import {
  buildAsfTerminalEffectLedger,
  type AsfTerminalEffect,
} from "../../src/evidence/asf-terminal-effects.js";
import type {
  AsfTelemetryAttributeInput,
  AsfTelemetryRecorder,
} from "../../src/asf/telemetry.js";

const NOW = "2026-08-21T10:00:00.000Z";
const LATER = "2026-08-21T10:05:00.000Z";
const BASE_SHA = "0".repeat(40);
const CANDIDATE_1 = "1".repeat(40);
const CANDIDATE_2 = "2".repeat(40);
const TREE_DIGEST = `sha256:${"3".repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${"4".repeat(64)}`;
const SOURCE_DIGEST = `sha256:${"5".repeat(64)}`;
const TASK_PACKET_DIGEST = `sha256:${"6".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"7".repeat(64)}`;
const TERMINAL_BUNDLE_DIGEST = `sha256:${"8".repeat(64)}`;
const WORKER_ID = "worker-01";
const PROTECTED_RESUME_REF = `sha256:${"b".repeat(64)}`;
const SESSION_IDENTITY_DIGEST = `sha256:${"c".repeat(64)}`;
const FINAL_PROTECTION = {
  required_checks: ["ci/unit"],
  requires_approval: false,
  requires_conversation_resolution: false,
  uses_merge_queue: false,
} as const;
const FINAL_PROTECTION_DIGEST = sha256Digest({
  schema: "runmill.github-base-protection/v1",
  repository: "acme/widgets",
  base_ref: "refs/heads/main",
  protection: FINAL_PROTECTION,
});

function ciChecks(
  outcome: "passed" | "failed" | "pending" | "not-scheduled",
  context = "ci/unit",
) {
  return [{ context, outcome, evidence_digest: EVIDENCE_DIGEST }] as const;
}

function bindingWire(binding: AsfDeliveryBinding) {
  return {
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: binding.candidateSha,
  };
}

function identityAttribution(
  binding: AsfDeliveryBinding,
  role: AsfRequiredIdentityRole,
  provider: string,
  principalId: string,
  profile: string,
) {
  if (binding.candidateSha !== null)
    throw new Error("identity binding must precede a candidate");
  const exactBinding = {
    ...bindingWire(binding),
    candidate_sha: null,
  } as const;
  const unsigned = {
    schema: ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
    role,
    provider,
    principal_id: principalId,
    profile,
    fencing_generation: binding.fencingGeneration,
    issued_at: NOW,
    expires_at: LATER,
  } as const;
  return {
    ...unsigned,
    lease_attribution_digest: identityLeaseAttributionDigest(
      exactBinding,
      unsigned,
    ),
  };
}

function fixtureAdmission(
  budgetOverrides: {
    readonly wallSeconds?: number;
    readonly maxCostUsd?: number;
    readonly maxAgentInvocations?: number;
    readonly maxFixIterations?: number;
    readonly requiredRemoteChecks?: readonly string[];
  } = {},
): {
  readonly envelope: WorkOrderEnvelope;
  readonly policy: EffectiveAsfPolicy;
  readonly admission: AsfAdmissionRecord;
} {
  const envelope: WorkOrderEnvelope = {
    schema: "asf.work-order-envelope/v1",
    key_id: "key-01",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T09:00:00.000Z",
    not_before: "2026-08-21T09:00:00.000Z",
    expires_at: "2026-08-22T09:00:00.000Z",
    payload: {
      schema: "asf.work-order/v1",
      work_order_id: "wo-01",
      tenant_id: "tenant-01",
      work_item_id: "item-01",
      attempt_id: "attempt-01",
      idempotency_key: "tenant-01/item-01/attempt-01",
      source: {
        system: "asf",
        external_id: "item-01",
        snapshot_digest: SOURCE_DIGEST,
      },
      repository: {
        forge: "github",
        repository: "acme/widgets",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: "Fix widget",
        description: "Make the requested scoped change.",
        acceptance_criteria: ["check passes"],
        non_goals: ["release"],
      },
      scope: {
        allowed_paths: ["src/**"],
        forbidden_paths: ["src/private/**"],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["unit"],
        required_remote_checks: [
          ...(budgetOverrides.requiredRemoteChecks ?? ["ci/unit"]),
        ],
        policy_snapshot_digest: EVIDENCE_DIGEST,
      },
      identities: {
        implementer: "impl-profile",
        local_reviewer: "local-profile",
        pr_reviewer: "pr-profile",
      },
      runtime: {
        sandbox_profile: "sandbox-01",
        tool_policy: "tools-01",
        network_policy: "network-none",
      },
      budgets: {
        wall_seconds: budgetOverrides.wallSeconds ?? 3_600,
        max_cost_usd: budgetOverrides.maxCostUsd ?? 10,
        max_agent_invocations: budgetOverrides.maxAgentInvocations ?? 10,
        max_fix_iterations: budgetOverrides.maxFixIterations ?? 2,
      },
      delivery: {
        closure_target: "pr",
        draft_pr: false,
        merge_policy_ref: null,
      },
      policy_digest: `sha256:${"8".repeat(64)}`,
      harness_digest: `sha256:${"9".repeat(64)}`,
    },
    signature: "base64url:AQ",
  };
  const unsignedPolicy = {
    schema: "runmill.effective-policy/v1" as const,
    inputs: {
      operatorPolicy: `sha256:${"a".repeat(64)}`,
      workOrderPolicy: envelope.payload.policy_digest,
      workOrderPayload: sha256Digest(envelope.payload),
      harness: envelope.payload.harness_digest,
      repositoryPolicy: EVIDENCE_DIGEST,
      repositoryPolicyBaseSha: BASE_SHA,
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: "Y2hlY2tzOiBbXQo=",
      observedBaseSha: BASE_SHA,
      forgeProtection: FINAL_PROTECTION_DIGEST,
      forgeProtectionBaseRef: envelope.payload.repository.base_ref,
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [
      {
        source: "operator" as const,
        allowedPaths: ["src/**"],
        forbiddenPaths: [],
      },
      {
        source: "work-order" as const,
        allowedPaths: ["src/**"],
        forbiddenPaths: ["src/private/**"],
      },
      {
        source: "repository" as const,
        allowedPaths: ["src/**"],
        forbiddenPaths: [],
      },
    ],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["unit"],
    requiredRemoteChecks: [
      ...(budgetOverrides.requiredRemoteChecks ?? ["ci/unit"]),
    ],
    riskClass: "low" as const,
    identities: {
      implementer: "impl-profile",
      localReviewer: "local-profile",
      prReviewer: "pr-profile",
    },
    runtime: {
      sandboxProfile: "sandbox-01",
      toolPolicy: "tools-01",
      networkPolicy: "network-none",
    },
    budgets: {
      wallSeconds: budgetOverrides.wallSeconds ?? 3_600,
      maxCostUsd: budgetOverrides.maxCostUsd ?? 10,
      maxAgentInvocations: budgetOverrides.maxAgentInvocations ?? 10,
      maxFixIterations: budgetOverrides.maxFixIterations ?? 2,
    },
    delivery: { closureTarget: "pr" as const, draftPr: false },
  };
  const policy: EffectiveAsfPolicy = {
    ...unsignedPolicy,
    digest: sha256Digest(unsignedPolicy),
  };
  return {
    envelope,
    policy,
    admission: {
      runId: "run-01",
      idempotencyKey: envelope.payload.idempotency_key,
      payloadDigest: sha256Digest(envelope.payload),
      envelopeDigest: sha256Digest(envelope),
      workOrderId: envelope.payload.work_order_id,
      attemptId: envelope.payload.attempt_id,
      tenantId: envelope.payload.tenant_id,
      canonicalEnvelope: canonicalJson(envelope),
      effectivePolicy: canonicalJson(policy as unknown as JsonValue),
      effectivePolicyDigest: policy.digest,
      signatureKeyId: envelope.key_id,
      signatureAlgorithm: envelope.algorithm,
      acceptedAt: NOW,
    },
  };
}

class MemoryRunStore {
  readonly admission: AsfAdmissionRecord;
  run: AsfRunRow;
  readonly events: RunEvent[] = [];
  readonly checkpoints: DurableAsfCheckpoint[] = [];
  evidence: AsfEvidenceBundleRecord | undefined;
  terminalEvidence: AsfTerminalEvidenceBundleRecord | undefined;
  terminalBundle: SignedAsfTerminalEvidenceBundle | undefined;
  terminalPlan: AsfTerminalEvidencePlan | undefined;
  terminalPlanRecord: AsfTerminalEvidencePlanRecord | undefined;
  terminalIntent: AsfTerminalEvidenceIntent | undefined;
  terminalIntentRecord: AsfTerminalEvidenceIntentRecord | undefined;
  intentReader:
    | ((intentId: string) => StoredAsfDeliveryStageIntent | undefined)
    | undefined;
  terminalEffectsReader: (() => readonly AsfTerminalEffect[]) | undefined;
  readonly log: string[];

  constructor(log: string[], fixture = fixtureAdmission()) {
    this.admission = fixture.admission;
    this.log = log;
    this.run = {
      runId: "run-01",
      issueId: "item-01",
      repo: "acme/widgets",
      provider: "asf",
      state: "ADMITTED",
      stateVersion: 1,
      attempt: 1,
      baseCommit: BASE_SHA,
      candidateSha: null,
      branch: null,
      mode: "asf-worker",
      workOrderId: "wo-01",
      attemptId: "attempt-01",
      generation: 7,
      ownerId: WORKER_ID,
      heartbeatAt: NOW,
    };
    this.events.push(
      parseRunEvent({
        schema: "asf.run-event/v1",
        event_id: "evt-admitted",
        run_id: this.run.runId,
        work_order_id: this.admission.workOrderId,
        attempt_id: this.admission.attemptId,
        seq: 1,
        occurred_at: NOW,
        type: "work_order.admitted",
        phase: "ADMITTED",
        payload: {
          work_order_id: this.admission.workOrderId,
          attempt_id: this.admission.attemptId,
          tenant_id: this.admission.tenantId,
          payload_digest: this.admission.payloadDigest,
          envelope_digest: this.admission.envelopeDigest,
          signature: { verified: true, key_id: "key-01", algorithm: "EdDSA" },
        },
        policy_digest: this.admission.effectivePolicyDigest,
      }),
    );
  }

  snapshot(): AsfDurableRunSnapshot {
    return {
      run: { ...this.run },
      admission: { ...this.admission },
      latestSequence: this.run.stateVersion,
    };
  }

  transition(input: AsfRunnerTransition): RunEvent {
    if (
      input.from !== this.run.state ||
      input.expectedVersion !== this.run.stateVersion
    ) {
      throw new Error("test transition fence mismatch");
    }
    const seq = this.run.stateVersion + 1;
    const event = parseRunEvent({
      schema: "asf.run-event/v1",
      event_id: `evt-${seq}`,
      run_id: this.run.runId,
      work_order_id: this.admission.workOrderId,
      attempt_id: this.admission.attemptId,
      seq,
      occurred_at: NOW,
      type: input.eventType,
      phase: input.to,
      payload: input.payload,
      policy_digest: this.admission.effectivePolicyDigest,
    });
    const candidate = event.payload["candidate_sha"];
    this.run = {
      ...this.run,
      state: input.to,
      stateVersion: seq,
      candidateSha:
        typeof candidate === "string" ? candidate : this.run.candidateSha,
    };
    this.events.push(event);
    this.log.push(`transition:${input.to}`);
    if (input.checkpoint !== undefined) {
      const policy = getAsfCheckpointRecoveryPolicy(input.checkpoint.kind);
      let candidateLineageDigest: string | undefined;
      if (this.run.candidateSha === null) {
        candidateLineageDigest = sha256Digest({
          run_id: this.run.runId,
          candidate_sha: null,
        });
      } else if (event.type === "candidate.created") {
        const parentSha = event.payload["parent_sha"];
        const treeDigest = event.payload["tree_digest"];
        if (typeof parentSha !== "string" || typeof treeDigest !== "string") {
          throw new Error("test candidate event has malformed lineage");
        }
        candidateLineageDigest = sha256Digest({
          candidate_sha: this.run.candidateSha,
          parent_sha: parentSha,
          tree_digest: treeDigest,
        });
      } else {
        candidateLineageDigest = this.checkpoints
          .filter(
            (checkpoint) => checkpoint.candidate_sha === this.run.candidateSha,
          )
          .at(-1)?.candidate_lineage_digest;
        if (candidateLineageDigest === undefined) {
          const lineageEvent = this.events
            .filter(
              (candidateEvent) =>
                candidateEvent.type === "candidate.created" &&
                candidateEvent.payload["candidate_sha"] ===
                  this.run.candidateSha,
            )
            .at(-1);
          const parentSha = lineageEvent?.payload["parent_sha"];
          const treeDigest = lineageEvent?.payload["tree_digest"];
          if (typeof parentSha === "string" && typeof treeDigest === "string") {
            candidateLineageDigest = sha256Digest({
              candidate_sha: this.run.candidateSha,
              parent_sha: parentSha,
              tree_digest: treeDigest,
            });
          }
        }
      }
      if (candidateLineageDigest === undefined) {
        throw new Error(
          "test transition has no prior candidate lineage checkpoint",
        );
      }
      const checkpoint = createDurableAsfCheckpoint({
        schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
        checkpoint_id:
          `cp_${String(policy.number).padStart(2, "0")}_` +
          sha256Digest({
            run_id: this.run.runId,
            event_seq: seq,
            generation: this.run.generation,
            kind: input.checkpoint.kind,
          }).slice("sha256:".length, "sha256:".length + 32),
        checkpoint_kind: input.checkpoint.kind,
        run_id: this.run.runId,
        work_order_id: this.admission.workOrderId,
        attempt_id: this.admission.attemptId,
        phase: input.to,
        event_seq: seq,
        fencing_generation: this.run.generation,
        policy_digest: this.admission.effectivePolicyDigest,
        candidate_sha: this.run.candidateSha,
        candidate_lineage_digest: candidateLineageDigest,
        durable_inputs_digest: sha256Digest(input.checkpoint.durableInputs),
        durable_outputs_digest: sha256Digest(input.checkpoint.durableOutputs),
        replay_policy: policy.replayPolicy,
        reconciliation_markers: policy.reconciliationBeforeReplay.map(
          (observation) => ({
            observation,
            correlation_marker:
              input.checkpoint?.correlationMarker ??
              `checkpoint:${this.run.runId}:${input.checkpoint?.kind ?? "missing"}:${seq}`,
          }),
        ),
        protected_implementer_resume:
          input.checkpoint.protectedImplementerResume ?? null,
        created_at: NOW,
      });
      this.recordAsfCheckpoint({
        checkpoint,
        ownerId: WORKER_ID,
        generation: this.run.generation,
      });
    }
    return event;
  }

  getAsfRunSnapshot = (_runId: string): AsfDurableRunSnapshot =>
    this.snapshot();

  prepareAsfTerminalProviderBudgetEvidence = (input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
  }) => {
    if (
      input.runId !== this.run.runId ||
      input.ownerId !== this.run.ownerId ||
      input.generation !== this.run.generation
    ) {
      throw new Error("test terminal provider budget fence mismatch");
    }
    const policy = JSON.parse(
      this.admission.effectivePolicy,
    ) as unknown as EffectiveAsfPolicy;
    const maxCostMicros = asfCostLimitUsdToMicros(
      policy.budgets.maxCostUsd,
    );
    return {
      schema: "asf.provider-budget-evidence-summary/v1" as const,
      runId: this.run.runId,
      workOrderId: this.run.workOrderId,
      attemptId: this.run.attemptId,
      policyDigest: this.admission.effectivePolicyDigest,
      candidateSha: this.run.candidateSha,
      usage: {
        maxCostMicros,
        reportedActualCostMicros: 0,
        settledUnknownCostMicros: 0,
        outstandingReservedCostMicros: 0,
        conservativeCostMicros: 0,
        invocationCount: 0,
        completedInvocationCount: 0,
        settledUnknownInvocationCount: 0,
        outstandingInvocationCount: 0,
        deniedCount: 0,
      },
      invocations: [],
      settlementDigests: [],
      ledgerDigest: sha256Digest({
        schema: "test.provider-budget-public-ledger/v1",
        run_id: this.run.runId,
        reservations: [],
      }),
    };
  };

  prepareAsfTerminalEffectLedger = (input: { readonly runId: string }) => {
    if (input.runId !== this.run.runId) {
      throw new Error("test terminal effect-ledger run mismatch");
    }
    return buildAsfTerminalEffectLedger({
      run_id: this.run.runId,
      work_order_id: this.run.workOrderId,
      attempt_id: this.run.attemptId,
      policy_digest: this.admission.effectivePolicyDigest,
      effects: [...(this.terminalEffectsReader?.() ?? [])],
      reconciliations: [],
    });
  };

  getLatestAsfCheckpoint = (_runId: string): DurableAsfCheckpoint | undefined =>
    this.checkpoints.at(-1);

  recordAsfCheckpoint = (input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly ownerId: string;
    readonly generation: number;
  }): {
    readonly checkpoint: AsfCheckpointRecord;
    readonly created: boolean;
  } => {
    expect(input.ownerId).toBe(WORKER_ID);
    expect(input.generation).toBe(this.run.generation);
    expect(input.checkpoint.phase).toBe(this.run.state);
    expect(input.checkpoint.event_seq).toBe(this.run.stateVersion);
    expect(input.checkpoint.candidate_sha).toBe(this.run.candidateSha);
    const existing = this.checkpoints.find(
      (checkpoint) =>
        checkpoint.checkpoint_id === input.checkpoint.checkpoint_id,
    );
    if (existing !== undefined) {
      expect(existing.checkpoint_digest).toBe(
        input.checkpoint.checkpoint_digest,
      );
    } else {
      this.checkpoints.push(input.checkpoint);
      this.log.push(`checkpoint:${input.checkpoint.checkpoint_kind}`);
    }
    return {
      created: existing === undefined,
      checkpoint: {
        checkpointId: input.checkpoint.checkpoint_id,
        runId: input.checkpoint.run_id,
        checkpointKind: input.checkpoint.checkpoint_kind,
        phase: input.checkpoint.phase,
        eventSeq: input.checkpoint.event_seq,
        fencingGeneration: input.checkpoint.fencing_generation,
        candidateSha: input.checkpoint.candidate_sha,
        policyDigest: input.checkpoint.policy_digest,
        checkpointDigest: input.checkpoint.checkpoint_digest,
        replayPolicy: input.checkpoint.replay_policy,
        canonicalCheckpoint: canonicalJson(input.checkpoint),
        createdAt: input.checkpoint.created_at,
        recordedAt: NOW,
      },
    };
  };

  listAsfRunEvents = (_runId: string, after = 0, limit = 100) => {
    const visible = this.events
      .filter((event) => event.seq > after)
      .slice(0, limit);
    return {
      events: visible,
      nextCursor: visible.at(-1)?.seq ?? after,
      hasMore: this.events.some(
        (event) => event.seq > (visible.at(-1)?.seq ?? after),
      ),
      gap: false,
      compactedThrough: null,
      snapshot: { run: { ...this.run }, latestSequence: this.run.stateVersion },
    };
  };

  recordAsfEvidenceBundle = (input: {
    readonly validated: ArtifactVerifiedAsfEvidenceBundle;
    readonly ownerId: string;
    readonly generation: number;
  }) => {
    const canonicalEnvelope = canonicalJson(input.validated.bundle);
    const record: AsfEvidenceBundleRecord = {
      runId: this.run.runId,
      candidateSha: input.validated.candidateSha,
      policyDigest: this.admission.effectivePolicyDigest,
      bundleDigest: input.validated.bundleDigest,
      canonicalEnvelope,
      canonicalEnvelopeDigest: sha256Digest(canonicalEnvelope),
      finalizedAt: NOW,
    };
    this.evidence = record;
    return { record, created: true };
  };

  getAsfEvidenceBundleRecord = (_runId: string) => this.evidence;

  getAsfDeliveryIntentById = (intentId: string) =>
    this.intentReader?.(intentId);

  getAsfTerminalEvidencePlanRecord = (_runId: string) =>
    this.terminalPlanRecord;

  getAsfTerminalEvidencePlan = (_runId: string) => this.terminalPlan;

  getAsfTerminalEvidenceIntentRecord = (_runId: string) =>
    this.terminalIntentRecord;

  getAsfTerminalEvidenceIntent = (_runId: string) => this.terminalIntent;

  recordAsfTerminalEvidenceBundle = (input: {
    readonly validated: ValidatedAsfTerminalEvidenceBundle;
    readonly ownerId: string;
    readonly generation: number;
  }) => {
    this.terminalBundle = input.validated.bundle;
    const cleanup = input.validated.bundle.statement.predicate.cleanup;
    const canonicalEnvelope = canonicalJson(input.validated.bundle);
    const record: AsfTerminalEvidenceBundleRecord = {
      runId: this.run.runId,
      terminalPhase: input.validated.terminalPhase,
      terminalEventSeq: input.validated.terminalEventSeq,
      candidateSha: input.validated.candidateSha,
      policyDigest: this.admission.effectivePolicyDigest,
      cleanupIntentId: cleanup.intent_id,
      cleanupIntentDigest: cleanup.intent_digest,
      cleanupDigest: cleanup.observation_digest,
      deliveryBundleDigest:
        input.validated.bundle.statement.predicate.evidence
          .delivery_bundle_digest,
      bundleDigest: input.validated.bundleDigest,
      canonicalEnvelope,
      canonicalEnvelopeDigest: sha256Digest(canonicalEnvelope),
      finalizedAt: NOW,
    };
    this.terminalEvidence = record;
    return { record, created: true };
  };

  getAsfTerminalEvidenceBundleRecord = (_runId: string) =>
    this.terminalEvidence;

  getAsfTerminalEvidenceBundle = (_runId: string) => this.terminalBundle;
}

class MemoryIntents implements AsfDeliveryIntentStore {
  readonly values = new Map<string, AsfDeliveryStageIntent>();
  readonly confirmations = new Map<
    string,
    { readonly digest: string; readonly generation: number }
  >();

  constructor(
    readonly log: string[],
    readonly store: MemoryRunStore,
  ) {
    store.intentReader = (intentId) => {
      const intent = [...this.values.values()].find(
        (value) => value.intent_id === intentId,
      );
      if (intent === undefined) return undefined;
      const confirmation = this.confirmations.get(intentId);
      return {
        ...intent,
        observationDigest: confirmation?.digest ?? null,
        observationOutcome: confirmation === undefined ? null : "confirmed",
        confirmedGeneration: confirmation?.generation ?? null,
        confirmedAt: confirmation === undefined ? null : NOW,
        replayAuthorizedOperationId: null,
        replayStartedGeneration: null,
      };
    };
    store.terminalEffectsReader = () =>
      [...this.values.values()]
        .flatMap((intent): AsfTerminalEffect[] => {
          if (intent.stage === "cleanup") return [];
          const confirmation = this.confirmations.get(intent.intent_id);
          if (confirmation === undefined) {
            throw new Error(
              `test terminal ledger contains unresolved ${intent.stage} intent`,
            );
          }
          return [{
            effect_class: "delivery-intent" as const,
            effect_key: intent.effect_key,
            stage: intent.stage,
            candidate_sha: intent.candidate_sha,
            event_seq: intent.event_seq,
            intent_id: intent.intent_id,
            intent_digest: intent.intent_digest,
            operation_digest: intent.operation_digest,
            fencing_generation: intent.fencing_generation,
            created_at: intent.created_at,
            final_outcome: "confirmed" as const,
            final_observation_seq: 1,
            observations: [
              {
                seq: 1,
                outcome: "confirmed" as const,
                observation_digest: confirmation.digest,
                generation: confirmation.generation,
                source: "confirmation" as const,
                observed_at: NOW,
              },
            ],
            replay: null,
          }];
        });
  }

  record(intent: AsfDeliveryStageIntent) {
    const prior = this.values.get(intent.effect_key);
    if (prior === undefined) this.values.set(intent.effect_key, intent);
    this.log.push(`intent:${intent.stage}`);
    return {
      intent: prior ?? intent,
      disposition:
        prior === undefined
          ? ("created" as const)
          : prior.fencing_generation === intent.fencing_generation
            ? ("existing-current" as const)
            : ("existing-prior-generation" as const),
    };
  }

  confirm(input: {
    readonly intentId: string;
    readonly observationDigest: string;
    readonly binding: AsfDeliveryBinding;
  }) {
    const intent = [...this.values.values()].find(
      (value) => value.intent_id === input.intentId,
    );
    if (intent === undefined) throw new Error("confirmation before intent");
    this.confirmations.set(input.intentId, {
      digest: input.observationDigest,
      generation: input.binding.fencingGeneration,
    });
    const stage = intent.stage;
    this.log.push(`confirm:${stage ?? "missing"}`);
  }

  prepareTerminal(input: {
    readonly intent: AsfDeliveryStageIntent;
    readonly plan: AsfTerminalEvidencePlan;
  }) {
    const recorded = this.record(input.intent);
    const planRecord: AsfTerminalEvidencePlanRecord = {
      runId: input.plan.run.run_id,
      terminalPhase: input.plan.run.terminal_phase,
      terminalEventSeq: input.plan.run.terminal_event_seq,
      candidateSha: input.plan.source.candidate_sha,
      policyDigest: input.plan.admission.effective_policy_digest,
      cleanupIntentId: recorded.intent.intent_id,
      cleanupIntentDigest: recorded.intent.intent_digest,
      deliveryBundleDigest: input.plan.delivery_bundle_digest,
      planDigest: input.plan.plan_digest,
      canonicalPlan: canonicalJson(input.plan),
      createdAt: input.plan.created_at,
    };
    this.store.terminalPlan = input.plan;
    this.store.terminalPlanRecord = planRecord;
    return { ...recorded, plan: planRecord };
  }

  sealTerminal(input: Parameters<AsfDeliveryIntentStore["sealTerminal"]>[0]) {
    const plan = this.store.terminalPlan;
    const planRecord = this.store.terminalPlanRecord;
    if (
      plan === undefined ||
      planRecord === undefined ||
      plan.plan_digest !== input.planDigest
    ) {
      throw new Error("seal before terminal plan");
    }
    this.confirm({
      intentId: planRecord.cleanupIntentId,
      observationDigest: input.cleanupObservation.evidence_digest,
      binding: {
        runId: input.cleanupObservation.binding.run_id,
        workOrderId: input.cleanupObservation.binding.work_order_id,
        attemptId: input.cleanupObservation.binding.attempt_id,
        policyDigest: input.cleanupObservation.binding.policy_digest,
        fencingGeneration:
          input.cleanupObservation.binding.fencing_generation,
        candidateSha: input.cleanupObservation.binding.candidate_sha,
      },
    });
    const unsigned = {
      schema: "asf.terminal-evidence-intent/v1" as const,
      run: plan.run,
      admission: plan.admission,
      source: plan.source,
      stop: plan.stop,
      provider_budget: plan.provider_budget,
      side_effects: plan.side_effects,
      timing: {
        admitted_at: this.store.admission.acceptedAt,
        terminal_evidence_at: NOW,
        elapsed_ms:
          Date.parse(NOW) - Date.parse(this.store.admission.acceptedAt),
      },
      cleanup: {
        intent_id: planRecord.cleanupIntentId,
        intent_digest: planRecord.cleanupIntentDigest,
        observation: input.cleanupObservation,
      },
      delivery_bundle_digest: plan.delivery_bundle_digest,
      plan_digest: plan.plan_digest,
      created_at: NOW,
    };
    const intent: AsfTerminalEvidenceIntent = {
      ...unsigned,
      intent_digest: sha256Digest(unsigned),
    };
    const record: AsfTerminalEvidenceIntentRecord = {
      ...planRecord,
      cleanupDigest: input.cleanupObservation.evidence_digest,
      intentDigest: intent.intent_digest,
      canonicalIntent: canonicalJson(intent),
      createdAt: NOW,
    };
    this.store.terminalIntent = intent;
    this.store.terminalIntentRecord = record;
    return { record, intent, created: true };
  }
}

class MemoryProviderBudgets implements AsfProviderBudgetController {
  readonly #clock: Clock;
  readonly #acceptedAt: string;
  readonly #reservations = new Map<
    string,
    {
      readonly input: AsfProviderEffectBudgetInput;
      readonly reservationId: string;
      readonly reservationDigest: string;
      readonly reservedMicros: number;
      actualMicros: number | null;
      resultDigest: string | null;
    }
  >();

  constructor(clock: Clock, acceptedAt: string) {
    this.#clock = clock;
    this.#acceptedAt = acceptedAt;
  }

  #deadline(limits: AsfProviderEffectBudgetInput["limits"]): string {
    return new Date(
      Date.parse(this.#acceptedAt) + limits.wallSeconds * 1_000,
    ).toISOString();
  }

  #cost(): number {
    return [...this.#reservations.values()].reduce(
      (total, row) => total + (row.actualMicros ?? row.reservedMicros),
      0,
    );
  }

  checkRun(input: Parameters<AsfProviderBudgetController["checkRun"]>[0]) {
    const deadline = this.#deadline(input.limits);
    const maxMicros = asfCostLimitUsdToMicros(input.limits.maxCostUsd);
    const reason =
      this.#clock.now().getTime() >= Date.parse(deadline)
        ? ("wall-deadline" as const)
        : this.#cost() > maxMicros
          ? ("cost-limit" as const)
          : undefined;
    return reason === undefined
      ? { status: "available" as const }
      : {
          status: "exhausted" as const,
          reason,
          observationDigest: sha256Digest({
            reason,
            deadline,
            cost_micros: this.#cost(),
          }),
        };
  }

  reserve(input: AsfProviderEffectBudgetInput) {
    const existing = this.#reservations.get(input.effectKey);
    if (existing !== undefined) {
      return {
        status: "reserved" as const,
        allowance: {
          schema: ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA,
          reservationId: existing.reservationId,
          reservationDigest: existing.reservationDigest,
          authorization: "reconcile-only" as const,
          acceptedAt: this.#acceptedAt,
          deadlineAt: this.#deadline(input.limits),
          remainingWallMs: Math.max(
            0,
            Date.parse(this.#deadline(input.limits)) -
              this.#clock.now().getTime(),
          ),
          maxCostUsd: 0,
          invocationOrdinal:
            [...this.#reservations.keys()].indexOf(input.effectKey) + 1,
          maxAgentInvocations: input.limits.maxAgentInvocations,
        },
      };
    }
    const maxMicros = asfCostLimitUsdToMicros(input.limits.maxCostUsd);
    const reason =
      this.#clock.now().getTime() >= Date.parse(this.#deadline(input.limits))
        ? ("wall-deadline" as const)
        : this.#reservations.size >= input.limits.maxAgentInvocations
          ? ("invocation-limit" as const)
          : this.#cost() >= maxMicros
            ? ("cost-limit" as const)
            : undefined;
    if (reason !== undefined) {
      return {
        status: "exhausted" as const,
        reason,
        observationDigest: sha256Digest({
          reason,
          effect_key: input.effectKey,
        }),
      };
    }
    const reservationId = asfProviderBudgetReservationId({
      effectKey: input.effectKey,
      role: input.role,
      invocationId: input.invocationId,
    });
    const reservedMicros = Math.max(0, maxMicros - this.#cost());
    const reservationDigest = sha256Digest({
      reservation_id: reservationId,
      effect_key: input.effectKey,
      intent_digest: input.intentDigest,
      reserved_cost_micros: reservedMicros,
    });
    this.#reservations.set(input.effectKey, {
      input,
      reservationId,
      reservationDigest,
      reservedMicros,
      actualMicros: null,
      resultDigest: null,
    });
    return {
      status: "reserved" as const,
      allowance: {
        schema: ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA,
        reservationId,
        reservationDigest,
        authorization:
          input.intentMode === "observe-before-apply"
            ? ("invoke" as const)
            : ("reconcile-only" as const),
        acceptedAt: this.#acceptedAt,
        deadlineAt: this.#deadline(input.limits),
        remainingWallMs: Math.max(
          0,
          Date.parse(this.#deadline(input.limits)) -
            this.#clock.now().getTime(),
        ),
        maxCostUsd: asfMicrosToUsd(reservedMicros),
        invocationOrdinal: this.#reservations.size,
        maxAgentInvocations: input.limits.maxAgentInvocations,
      },
    };
  }

  complete(input: Parameters<AsfProviderBudgetController["complete"]>[0]) {
    const row = this.#reservations.get(input.effectKey);
    if (
      row === undefined ||
      row.reservationId !== input.reservationId ||
      row.reservationDigest !== input.reservationDigest ||
      row.input.invocationId !== input.invocationId
    ) {
      throw new Error("provider budget completion before an exact reservation");
    }
    const actualMicros = asfObservedCostUsdToMicros(input.actualCostUsd);
    if (
      row.actualMicros !== null &&
      (row.actualMicros !== actualMicros ||
        row.resultDigest !== input.providerResultDigest)
    ) {
      throw new Error("conflicting provider budget completion");
    }
    row.actualMicros = actualMicros;
    row.resultDigest = input.providerResultDigest;
    return {
      status: "completed" as const,
      actualCostMicros: actualMicros,
      conservativeCostMicros: this.#cost(),
      invocationCount: this.#reservations.size,
      completedAfterDeadline:
        this.#clock.now().getTime() >=
        Date.parse(this.#deadline(row.input.limits)),
      exceededReservedCost: actualMicros > row.reservedMicros,
    };
  }
}

function providerExecution(input: {
  readonly binding: AsfDeliveryBinding;
  readonly candidateSha: string;
  readonly role: "implementer" | "fixer" | "local-reviewer" | "pr-reviewer";
  readonly invocationId: string;
  readonly costUsd?: number;
  readonly resumable?: boolean;
}): TrustedProviderExecution {
  const exactBinding = {
    run_id: input.binding.runId,
    work_order_id: input.binding.workOrderId,
    attempt_id: input.binding.attemptId,
    role: input.role,
    invocation_id: input.invocationId,
    policy_digest: input.binding.policyDigest,
    candidate_sha: input.candidateSha,
    fencing_generation: input.binding.fencingGeneration,
  };
  const modelResult = {
    schema: "asf.model-result/v1" as const,
    request_id: `request-${input.invocationId}`,
    binding: exactBinding,
    provider: "codex",
    model: "gpt-test",
    principal: `${input.role}-principal`,
    profile:
      input.role === "implementer" ? "impl-profile" : `${input.role}-profile`,
    task_packet_digest: TASK_PACKET_DIGEST,
    instruction_digest: EVIDENCE_DIGEST,
    context_set_digest: sha256Digest([]),
    status: "success" as const,
    output_digest: EVIDENCE_DIGEST,
    output_bytes: 1,
    turns: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: input.costUsd ?? 0,
      tool_calls: 0,
    },
  };
  const events = [
    {
      schema: "asf.provider-event/v1" as const,
      request_id: modelResult.request_id,
      binding: exactBinding,
      sequence: 1,
      observed_at: NOW,
      event: { type: "session.started" as const },
    },
    {
      schema: "asf.provider-event/v1" as const,
      request_id: modelResult.request_id,
      binding: exactBinding,
      sequence: 2,
      observed_at: NOW,
      event: { type: "session.completed" as const, status: "success" as const },
    },
  ];
  const unsigned = {
    schema: "asf.provider-result/v1" as const,
    started_at: NOW,
    completed_at: NOW,
    model_result: modelResult,
    events,
    resume_metadata_digest:
      input.resumable === true ? SESSION_IDENTITY_DIGEST : null,
    failure: null,
  };
  return {
    result: { ...unsigned, result_digest: sha256Digest(unsigned) },
    protectedResume:
      input.resumable === true
        ? (Object.freeze({
            useMetadata<T>(operation: (metadata: never) => T): T {
              return operation({} as never);
            },
          }) as unknown as NonNullable<
            TrustedProviderExecution["protectedResume"]
          >)
        : null,
  };
}

interface HarnessOptions {
  readonly localReviewOutcomes?: readonly ("approved" | "changes-requested")[];
  readonly localVerificationOutcomes?: readonly (
    | "passed"
    | "failed"
    | "blocked"
  )[];
  readonly stopAtRepository?: boolean;
  readonly duplicateReviewerPrincipal?: boolean;
  readonly wallSeconds?: number;
  readonly maxCostUsd?: number;
  readonly maxAgentInvocations?: number;
  readonly maxFixIterations?: number;
  readonly requiredRemoteChecks?: readonly string[];
  readonly providerCostsUsd?: readonly number[];
  readonly resumableImplementer?: boolean;
  readonly ciCheckSequences?: readonly (readonly {
    readonly context: string;
    readonly outcome: "passed" | "failed" | "pending" | "not-scheduled";
    readonly evidence_digest: string;
  }[])[];
  readonly finalDeliveryOverrides?: Readonly<
    Partial<{
      repository: string;
      pull_request_number: number;
      url: string;
      head_ref: string;
      base_ref: string;
      marker: string;
      head_sha: string;
      current_base_sha: string;
      collision_set_digest: string;
      base_observation_digest: string;
      protection_digest: string;
      protection: {
        required_checks: string[];
        requires_approval: boolean;
        requires_conversation_resolution: boolean;
        uses_merge_queue: boolean;
      };
      observed_at: string;
      state: "open";
      draft: boolean;
    }>
  >;
}

function harness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const fixture = fixtureAdmission({
    ...(options.wallSeconds === undefined
      ? {}
      : { wallSeconds: options.wallSeconds }),
    ...(options.maxCostUsd === undefined
      ? {}
      : { maxCostUsd: options.maxCostUsd }),
    ...(options.maxAgentInvocations === undefined
      ? {}
      : { maxAgentInvocations: options.maxAgentInvocations }),
    ...(options.maxFixIterations === undefined
      ? {}
      : { maxFixIterations: options.maxFixIterations }),
    ...(options.requiredRemoteChecks === undefined
      ? {}
      : { requiredRemoteChecks: options.requiredRemoteChecks }),
  });
  const store = new MemoryRunStore(log, fixture);
  const intents = new MemoryIntents(log, store);
  const runnerClock = new FakeClock(NOW);
  const localOutcomes = [...(options.localReviewOutcomes ?? ["approved"])] as (
    | "approved"
    | "changes-requested"
  )[];
  const localVerificationOutcomes = [
    ...(options.localVerificationOutcomes ?? ["passed"]),
  ];
  const providerCostsUsd = [...(options.providerCostsUsd ?? [])];
  const ciCheckSequences = (options.ciCheckSequences ?? []).map((checks) => [
    ...checks,
  ]);
  const reviewInputs: Array<{
    readonly reviewKind: string;
    readonly candidateSha: string;
    readonly invocationId: string;
    readonly session: { readonly mode: "fresh" };
  }> = [];
  const invalidations: string[][] = [];
  let candidateCount = 0;
  let effectNumber = 0;

  const effectRow = (
    stage: string,
    binding: AsfDeliveryBinding,
    target: string,
  ) => {
    effectNumber += 1;
    return {
      effectKey: `effect-${effectNumber}`,
      runId: binding.runId,
      generation: binding.fencingGeneration,
      system: "github" as const,
      operation:
        stage === "branch"
          ? ("branch.push" as const)
          : ("pull_request.create" as const),
      target,
      correlationMarker: "marker-run-01",
      candidateSha: binding.candidateSha ?? "",
      expectedRemoteSha: null,
      policyDigest: binding.policyDigest,
      intentDigest: EVIDENCE_DIGEST,
      status: "confirmed" as const,
      remoteId: target,
      observationDigest: EVIDENCE_DIGEST,
      retryProhibited: 0 as const,
      intendedAt: NOW,
      updatedAt: NOW,
    };
  };
  const observationRow = (effectKey: string, candidateSha: string) => ({
    effectKey,
    seq: 1,
    outcome: "confirmed" as const,
    candidateSha,
    detailsDigest: EVIDENCE_DIGEST,
    observer: "github:test",
    observedAt: NOW,
  });

  const runnerOptions: AsfPrDeliveryRunnerOptions = {
    store,
    intents,
    clock: runnerClock,
    budget: new MemoryProviderBudgets(
      runnerClock,
      fixture.admission.acceptedAt,
    ),
    workerId: WORKER_ID,
    recovery: {
      async observe() {
        throw new Error("recovery should not run for a fresh admitted fixture");
      },
      async apply() {
        throw new Error("recovery should not run for a fresh admitted fixture");
      },
    },
    recoveryDispatch: {
      async dispatch(input) {
        log.push(`recovery-dispatch:${input.plan.action}`);
        const identityBinding = {
          ...input.binding,
          candidateSha: null,
        };
        const identityAttributions = input.requiredPrerequisites.includes(
          "identity-leases",
        )
          ? [
              identityAttribution(
                identityBinding,
                "implementer",
                "codex",
                "implementer-principal",
                "impl-profile",
              ),
              identityAttribution(
                identityBinding,
                "local-reviewer",
                "codex",
                "local-reviewer-principal",
                "local-profile",
              ),
              identityAttribution(
                identityBinding,
                "pr-reviewer",
                "codex",
                "pr-reviewer-principal",
                "pr-profile",
              ),
            ]
          : null;
        const unsigned = {
          schema: ASF_DELIVERY_RECOVERY_DISPATCH_SCHEMA,
          binding: bindingWire(input.binding),
          checkpoint_digest: input.checkpoint.checkpoint_digest,
          checkpoint_kind: input.checkpoint.checkpoint_kind,
          action: input.plan.action,
          recovery_acknowledgement_digest: input.recoveryAcknowledgementDigest,
          required_prerequisites: [...input.requiredPrerequisites],
          reestablished_prerequisites: [...input.requiredPrerequisites],
          replayed_checkpoint_stage: input.replayCheckpointStage,
          identity_attributions: identityAttributions,
        } as const;
        return {
          ...unsigned,
          durable_dispatch_record_digest: sha256Digest(unsigned),
        };
      },
    },
    repositoryLease: {
      async acquire(input) {
        log.push("effect:repository-lease");
        if (options.stopAtRepository === true) {
          throw new AsfDeliveryStop({
            phase: "NEEDS_SPEC",
            code: "REPOSITORY_SPEC_REQUIRED",
            summary: "repository input needs clarification",
            retryDisposition: "new-attempt-required",
            requiredActor: "repository-owner",
            requiredAction: "clarify the repository contract",
          });
        }
        return {
          schema: "asf.repository-lease-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          repository: fixture.envelope.payload.repository.repository,
          lease_generation: input.binding.fencingGeneration,
        };
      },
    },
    identities: {
      async acquireRequiredRoles(input) {
        log.push("effect:identity-leases");
        const attributions = [
          identityAttribution(
            input.binding,
            "implementer",
            "codex",
            "implementer-principal",
            "impl-profile",
          ),
          identityAttribution(
            input.binding,
            "local-reviewer",
            "codex",
            options.duplicateReviewerPrincipal === true
              ? "implementer-principal"
              : "local-reviewer-principal",
            "local-profile",
          ),
          identityAttribution(
            input.binding,
            "pr-reviewer",
            "codex",
            "pr-reviewer-principal",
            "pr-profile",
          ),
        ];
        return {
          schema: "asf.identity-acquisition-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          attributions_digest: identityAttributionsDigest(attributions),
          roles: ["implementer", "local-reviewer", "pr-reviewer"],
          attributions,
        };
      },
    },
    workspace: {
      async prepare(input) {
        log.push("effect:workspace");
        return {
          schema: "asf.workspace-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          workspace_id: "workspace-01",
          workspace_path: "/protected/workspaces/run-01",
          base_sha: BASE_SHA,
          sandbox_profile: "sandbox-01",
          isolation_evidence_digest: EVIDENCE_DIGEST,
        };
      },
      async observeCurrent(input) {
        log.push("observe:workspace");
        return {
          schema: "asf.workspace-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          workspace_id: "workspace-01",
          workspace_path: "/protected/workspaces/run-01",
          base_sha: BASE_SHA,
          sandbox_profile: "sandbox-01",
          isolation_evidence_digest: EVIDENCE_DIGEST,
        };
      },
    },
    taskPacket: {
      async create(input) {
        log.push("effect:task-packet");
        return {
          schema: "asf.task-packet-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          task_packet_digest: TASK_PACKET_DIGEST,
          source_snapshot_digest: SOURCE_DIGEST,
        };
      },
    },
    implementation: {
      async markSession(input) {
        log.push("effect:implementer-session");
        const implementer = identityAttribution(
          input.binding,
          "implementer",
          "codex",
          "implementer-principal",
          "impl-profile",
        );
        return {
          schema: "asf.implementer-session-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          session: "new",
          checkpoint_digest: EVIDENCE_DIGEST,
          protected_implementer_resume:
            options.resumableImplementer === true
              ? {
                  schema: "asf.protected-implementer-resume/v1",
                  storage: "protected-runtime-state",
                  protected_resume_ref: PROTECTED_RESUME_REF,
                  session_identity_digest: SESSION_IDENTITY_DIGEST,
                  run_id: input.binding.runId,
                  work_order_id: input.binding.workOrderId,
                  attempt_id: input.binding.attemptId,
                  policy_digest: input.binding.policyDigest,
                  fencing_generation: input.binding.fencingGeneration,
                  candidate_sha: null,
                  candidate_lineage_digest: sha256Digest({
                    run_id: input.binding.runId,
                    candidate_sha: null,
                  }),
                  identity_lease_binding_digest:
                    implementer.lease_attribution_digest,
                  provider: implementer.provider,
                  principal: implementer.principal_id,
                  profile: implementer.profile,
                  recorded_at: NOW,
                  identity_lease_expires_at: implementer.expires_at,
                }
              : null,
        };
      },
      async createCandidate(input) {
        log.push("effect:candidate");
        candidateCount += 1;
        const providerCostUsd = providerCostsUsd.shift();
        const candidateSha = candidateCount === 1 ? CANDIDATE_1 : CANDIDATE_2;
        return {
          schema: "asf.candidate-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          candidate_sha: candidateSha,
          parent_sha: input.startingSha,
          tree_digest: TREE_DIGEST,
          changed_paths: ["src/widget.ts"],
          provider_execution: providerExecution({
            binding: input.binding,
            candidateSha: input.startingSha,
            role: input.mode === "fix" ? "fixer" : "implementer",
            invocationId: input.invocationId,
            resumable:
              options.resumableImplementer === true &&
              input.mode === "implement",
            ...(providerCostUsd === undefined
              ? {}
              : { costUsd: providerCostUsd }),
          }),
        };
      },
      async captureProtectedResume(input) {
        if (
          options.resumableImplementer !== true ||
          input.execution.result.model_result.binding.role !== "implementer"
        ) {
          return null;
        }
        return {
          schema: "asf.protected-implementer-resume/v1",
          storage: "protected-runtime-state",
          protected_resume_ref: PROTECTED_RESUME_REF,
          session_identity_digest: SESSION_IDENTITY_DIGEST,
          run_id: input.binding.runId,
          work_order_id: input.binding.workOrderId,
          attempt_id: input.binding.attemptId,
          policy_digest: input.binding.policyDigest,
          fencing_generation: input.binding.fencingGeneration,
          candidate_sha: input.checkpointCandidateSha,
          candidate_lineage_digest: input.candidateLineageDigest,
          identity_lease_binding_digest:
            input.implementerAttribution.lease_attribution_digest,
          provider: input.implementerAttribution.provider,
          principal: input.implementerAttribution.principal_id,
          profile: input.implementerAttribution.profile,
          recorded_at: NOW,
          identity_lease_expires_at: input.implementerAttribution.expires_at,
        };
      },
    },
    localVerification: {
      async verify(input) {
        log.push("effect:local-verification");
        const outcome = localVerificationOutcomes.shift() ?? "passed";
        return {
          schema: "asf.local-verification-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          candidate_sha: input.candidateSha,
          checks: [
            { check_id: "unit", outcome, evidence_digest: EVIDENCE_DIGEST },
          ],
        };
      },
    },
    reviewer: {
      async review(input) {
        log.push(
          `effect:${input.reviewKind === "local" ? "local-review" : "pull-request-review"}`,
        );
        reviewInputs.push(input);
        const providerCostUsd = providerCostsUsd.shift();
        const outcome =
          input.reviewKind === "local"
            ? (localOutcomes.shift() ?? "approved")
            : "approved";
        return {
          schema: "asf.review-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          candidate_sha: input.candidateSha,
          review_kind: input.reviewKind,
          reviewer_attribution: input.reviewerAttribution,
          invocation_id: input.invocationId,
          fresh_context: true,
          prior_context_restored: false,
          outcome,
          findings_digest: EVIDENCE_DIGEST,
          provider_execution: providerExecution({
            binding: input.binding,
            candidateSha: input.candidateSha,
            role:
              input.reviewKind === "local" ? "local-reviewer" : "pr-reviewer",
            invocationId: input.invocationId,
            ...(providerCostUsd === undefined
              ? {}
              : { costUsd: providerCostUsd }),
          }),
        };
      },
    },
    invalidation: {
      async invalidate(input) {
        log.push("effect:candidate-invalidation");
        invalidations.push([...input.evidenceClasses]);
        const unsigned = {
          prior_candidate_sha: input.priorCandidateSha,
          candidate_sha: input.candidateSha,
          invalidated_evidence: input.evidenceClasses,
        };
        return {
          schema: ASF_CANDIDATE_INVALIDATION_ACK_SCHEMA,
          binding: bindingWire(input.binding),
          ...unsigned,
          acknowledgement_digest: sha256Digest(unsigned),
        };
      },
    },
    deliveryProposal: {
      async propose(input) {
        const unsigned = {
          schema: "asf.pull-request-delivery-proposal/v1" as const,
          binding: bindingWire(input.binding),
          repository: input.repository,
          head_ref: "refs/heads/runmill/run-01",
          base_ref: input.baseRef,
          marker: "marker-run-01",
          title: "Fix widget",
          body: "Automated candidate delivery.",
          draft: input.draft,
        };
        return { ...unsigned, proposal_digest: sha256Digest(unsigned) };
      },
    },
    github: {
      async ensureBranch(input) {
        log.push("effect:branch-push");
        const binding: AsfDeliveryBinding = {
          runId: input.runId,
          workOrderId: "wo-01",
          attemptId: "attempt-01",
          policyDigest: input.policyDigest,
          fencingGeneration: input.generation,
          candidateSha: input.candidateSha,
        };
        const effect = effectRow("branch", binding, input.ref);
        return {
          effect,
          observation: observationRow(effect.effectKey, input.candidateSha),
          remoteSha: input.candidateSha,
        };
      },
      async ensurePullRequest(input) {
        log.push("effect:pull-request");
        const binding: AsfDeliveryBinding = {
          runId: input.runId,
          workOrderId: "wo-01",
          attemptId: "attempt-01",
          policyDigest: input.policyDigest,
          fencingGeneration: input.generation,
          candidateSha: input.candidateSha,
        };
        const effect = effectRow("pr", binding, "acme/widgets#1");
        return {
          effect,
          observation: observationRow(effect.effectKey, input.candidateSha),
          pullRequest: {
            repository: input.repository,
            number: 1,
            url: "https://github.com/acme/widgets/pull/1",
            head_ref: input.headRef,
            base_ref: input.baseRef,
            head_sha: input.candidateSha,
            marker: input.marker,
            state: "open",
            draft: input.draft,
          },
        };
      },
      async observeFinalDelivery(input) {
        log.push("effect:pull-request-review");
        log.push("observe:final-pr-delivery");
        const unsigned = {
          schema: "asf.github-final-pr-delivery-observation/v1" as const,
          repository: input.repository.toLowerCase(),
          pull_request_number: input.pullRequestNumber,
          url: input.pullRequestUrl,
          head_ref: input.headRef,
          base_ref: input.baseRef,
          marker: input.marker,
          head_sha: input.candidateSha,
          current_base_sha: BASE_SHA,
          collision_set_digest: EVIDENCE_DIGEST,
          base_observation_digest: EVIDENCE_DIGEST,
          protection_digest: FINAL_PROTECTION_DIGEST,
          protection: {
            required_checks: [...FINAL_PROTECTION.required_checks],
            requires_approval: FINAL_PROTECTION.requires_approval,
            requires_conversation_resolution:
              FINAL_PROTECTION.requires_conversation_resolution,
            uses_merge_queue: FINAL_PROTECTION.uses_merge_queue,
          },
          observed_at: NOW,
          state: "open" as const,
          draft: input.draft,
          ...options.finalDeliveryOverrides,
        };
        return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
      },
    },
    ci: {
      async observeExactHead(input) {
        log.push("effect:ci");
        const checks =
          ciCheckSequences.shift() ??
          input.requiredContexts.map((context) => ({
            context,
            outcome: "passed" as const,
            evidence_digest: EVIDENCE_DIGEST,
          }));
        const unsigned = {
          schema: "asf.ci-head-observation/v1",
          binding: bindingWire(input.binding),
          repository: input.repository,
          pull_request_number: input.pullRequestNumber,
          candidate_sha: input.candidateSha,
          observed_head_sha: input.candidateSha,
          observed_at: runnerClock.now().toISOString(),
          checks,
        };
        return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
      },
    },
    evidence: {
      async finalize(input) {
        log.push("effect:evidence");
        const candidateSha = input.binding.candidateSha ?? "";
        return {
          bundle: {
            statement: {
              predicate: {
                run: {
                  run_id: input.binding.runId,
                  work_order_id: input.binding.workOrderId,
                  attempt_id: input.binding.attemptId,
                },
                policy: { effective_policy_digest: input.binding.policyDigest },
                source: {
                  candidate_sha: candidateSha,
                  remote_head_sha: candidateSha,
                },
              },
            },
          },
          bundleDigest: BUNDLE_DIGEST,
          candidateSha,
          signer: { keyId: "evidence-key", algorithm: "EdDSA", verified: true },
          artifacts: {
            verified: true,
            count: 0,
            totalBytes: 0,
            manifestDigest: sha256Digest([]),
          },
        } as unknown as ArtifactVerifiedAsfEvidenceBundle;
      },
    },
    terminalEvidence: {
      async finalizeTerminal(input) {
        log.push("finalize:terminal-evidence");
        const subjectSha = input.binding.candidateSha ?? BASE_SHA;
        const cancellationEvent = input.events
          .filter(
            (event) =>
              event.type === "cancellation.requested" ||
              event.type === "cancellation.escalated",
          )
          .at(-1);
        const cancellation = (() => {
          if (cancellationEvent === undefined) return null;
          const requestId = cancellationEvent.payload["request_id"];
          const requester = cancellationEvent.payload["requester"];
          const reason = cancellationEvent.payload["reason"];
          const mode = cancellationEvent.payload["mode"];
          const graceSeconds = cancellationEvent.payload["grace_seconds"];
          if (
            (cancellationEvent.type !== "cancellation.requested" &&
              cancellationEvent.type !== "cancellation.escalated") ||
            typeof requestId !== "string" ||
            typeof requester !== "string" ||
            typeof reason !== "string" ||
            !reason.startsWith("protected:") ||
            (mode !== "graceful" && mode !== "forced") ||
            typeof graceSeconds !== "number"
          ) {
            throw new Error("test cancellation event is malformed");
          }
          const eventType:
            | "cancellation.requested"
            | "cancellation.escalated" = cancellationEvent.type;
          const cancellationMode: "graceful" | "forced" = mode;
          return {
            request_id: requestId,
            event_type: eventType,
            requester_subject: requester,
            reason_digest: reason.slice("protected:".length),
            mode: cancellationMode,
            grace_seconds: graceSeconds,
            requested_at: cancellationEvent.occurred_at,
            event_digest: sha256Digest(cancellationEvent),
          };
        })();
        const provisional = {
          bundle: {
            schema: "asf.signed-terminal-evidence/v1",
            key_id: "evidence-key",
            algorithm: "EdDSA" as const,
            issued_at: input.terminalIntentCreatedAt,
            bundle_digest: TERMINAL_BUNDLE_DIGEST,
            statement: {
              _type: "https://in-toto.io/Statement/v1",
              subject: [
                {
                  name: `asf-run:${input.binding.runId}`,
                  digest: { sha1: subjectSha },
                },
              ],
              predicateType:
                "https://runmill.dev/attestations/asf-terminal-evidence/v1",
              predicate: {
                schema: "asf.terminal-evidence/v1",
                run: {
                  run_id: input.binding.runId,
                  work_order_id: input.binding.workOrderId,
                  attempt_id: input.binding.attemptId,
                  terminal_phase: input.terminalPhase,
                  terminal_event_seq: input.snapshot.latestSequence + 1,
                },
                admission: {
                  work_order_envelope_digest:
                    input.snapshot.admission.envelopeDigest,
                  work_order_payload_digest:
                    input.snapshot.admission.payloadDigest,
                  effective_policy_digest: input.binding.policyDigest,
                  work_order_envelope: input.envelope,
                  signature_verification: {
                    verified: true,
                    key_id: input.snapshot.admission.signatureKeyId,
                    algorithm: "EdDSA" as const,
                  },
                  effective_policy: JSON.parse(
                    canonicalJson(input.effectivePolicy as unknown as JsonValue),
                  ),
                },
                source: {
                  repository: input.snapshot.run.repo,
                  base_sha: BASE_SHA,
                  candidate_sha: input.binding.candidateSha,
                  subject_kind:
                    input.binding.candidateSha === null ? "base" : "candidate",
                  subject_sha: subjectSha,
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
                cancellation,
                budget: {
                  wall_seconds_limit: input.effectivePolicy.budgets.wallSeconds,
                  max_cost_usd: input.effectivePolicy.budgets.maxCostUsd,
                  max_agent_invocations:
                    input.effectivePolicy.budgets.maxAgentInvocations,
                  max_fix_iterations:
                    input.effectivePolicy.budgets.maxFixIterations,
                  observed_fix_iterations: 0,
                  evidence_refs: [],
                  provider_usage: input.providerBudget,
                },
                side_effects: input.sideEffects,
                timing: {
                  admitted_at: input.snapshot.admission.acceptedAt,
                  terminal_evidence_at: input.terminalIntentCreatedAt,
                  elapsed_ms:
                    Date.parse(input.terminalIntentCreatedAt) -
                    Date.parse(input.snapshot.admission.acceptedAt),
                },
                cleanup: {
                  intent_id: input.cleanupIntent.intent_id,
                  intent_digest: input.cleanupIntent.intent_digest,
                  observation_digest: input.cleanup.evidence_digest,
                  identity_leases: "released",
                  repository_lease: "released",
                  workspace: "removed",
                  unresolved_effects: 0,
                },
                evidence: {
                  preceding_event_count: input.events.length,
                  preceding_event_chain_digest: sha256Digest(input.events),
                  observations: input.events.map((event) => ({
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
                  events: [...input.events],
                  delivery_bundle_digest: input.deliveryBundleDigest,
                },
              },
            },
            signature: `base64url:${"A".repeat(86)}`,
          },
          bundleDigest: TERMINAL_BUNDLE_DIGEST,
          candidateSha: input.binding.candidateSha,
          terminalPhase: input.terminalPhase,
          terminalEventSeq: input.snapshot.latestSequence + 1,
          signer: {
            keyId: "evidence-key",
            algorithm: "EdDSA" as const,
            verified: true,
          },
        } satisfies ValidatedAsfTerminalEvidenceBundle;
        const bundleDigest = sha256Digest(provisional.bundle.statement);
        return {
          ...provisional,
          bundle: { ...provisional.bundle, bundle_digest: bundleDigest },
          bundleDigest,
        };
      },
    },
    cleanup: {
      async cleanup(input) {
        log.push("effect:cleanup");
        return {
          schema: "asf.cleanup-observation/v1",
          binding: bindingWire(input.binding),
          evidence_digest: EVIDENCE_DIGEST,
          identity_leases: "released",
          repository_lease: "released",
          workspace: "removed",
          unresolved_effects: 0,
        };
      },
    },
  };

  const context: AsfRunnerContext = {
    runId: store.run.runId,
    generation: store.run.generation,
    takeover: false,
    signal: new AbortController().signal,
    transition: (input) => store.transition(input),
  };

  return {
    log,
    store,
    intents,
    runnerOptions,
    context,
    reviewInputs,
    invalidations,
    clock: runnerClock,
  };
}

function configureCurrentCheckpointRecovery(
  test: ReturnType<typeof harness>,
): void {
  const checkpoint = test.store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("test recovery checkpoint missing");
  test.runnerOptions.recovery.observe = async ({ binding }) => ({
    schema: ASF_RECOVERY_REQUEST_SCHEMA,
    requesting_worker_id: WORKER_ID,
    checkpoint,
    checkpoint_observation: {
      state: "verified",
      checkpoint_digest: checkpoint.checkpoint_digest,
      observed_at: NOW,
      valid_until: LATER,
      evidence_digest: EVIDENCE_DIGEST,
    },
    ownership: {
      state: "current",
      run_id: binding.runId,
      work_order_id: binding.workOrderId,
      attempt_id: binding.attemptId,
      worker_id: WORKER_ID,
      fencing_generation: binding.fencingGeneration,
      observed_at: NOW,
      valid_until: LATER,
      evidence_digest: EVIDENCE_DIGEST,
    },
    remote_observations: checkpoint.reconciliation_markers.map((marker) => ({
      observation: marker.observation,
      state: "confirmed" as const,
      run_id: binding.runId,
      work_order_id: binding.workOrderId,
      attempt_id: binding.attemptId,
      policy_digest: binding.policyDigest,
      candidate_sha: binding.candidateSha,
      correlation_marker: marker.correlation_marker,
      observed_at: NOW,
      valid_until: LATER,
      evidence_digest: EVIDENCE_DIGEST,
    })),
    replay_requested: false,
    actor: { role: "orchestrator" as const, mode: "automatic" as const },
  });
  test.runnerOptions.recovery.apply = async ({ plan, binding }) => {
    const completed = [...plan.requiredTakeoverFencing];
    const invalidated = [...plan.invalidatedEvidence];
    return {
      schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
      binding: bindingWire(binding),
      checkpoint_digest: checkpoint.checkpoint_digest,
      action: plan.action,
      completed_takeover_fencing: completed,
      invalidated_evidence: invalidated,
      acknowledgement_digest: sha256Digest({
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
      }),
    };
  };
}

async function prepareProtectedImplementerRecovery(
  test: ReturnType<typeof harness>,
  options: { readonly takeover?: boolean } = {},
) {
  const crash = new AbortController();
  const crashingContext: AsfRunnerContext = {
    ...test.context,
    signal: crash.signal,
    transition: (input) => {
      const event = test.store.transition(input);
      if (input.eventType === "implementation.started") {
        crash.abort(
          new Error("simulated restart after implementer session checkpoint"),
        );
      }
      return event;
    },
  };
  await expect(
    new AsfPrDeliveryRunner(test.runnerOptions).run(crashingContext),
  ).rejects.toThrow("simulated restart after implementer session checkpoint");
  const prior = test.store.checkpoints.at(-1);
  if (prior?.checkpoint_kind !== "implementer-session-marker") {
    throw new Error("test implementer checkpoint missing");
  }
  const metadata = prior.protected_implementer_resume;
  if (metadata === null) {
    throw new Error(
      "runner did not atomically persist protected session metadata",
    );
  }
  const checkpoint = prior;
  const authorizationGeneration =
    checkpoint.fencing_generation + (options.takeover === true ? 1 : 0);
  if (options.takeover === true) {
    test.store.run = {
      ...test.store.run,
      generation: authorizationGeneration,
      ownerId: WORKER_ID,
    };
  }
  const currentImplementer = identityAttribution(
    {
      runId: checkpoint.run_id,
      workOrderId: checkpoint.work_order_id,
      attemptId: checkpoint.attempt_id,
      policyDigest: checkpoint.policy_digest,
      fencingGeneration: authorizationGeneration,
      candidateSha: checkpoint.candidate_sha,
    },
    "implementer",
    metadata.provider,
    metadata.principal,
    metadata.profile,
  );
  const ownership = {
    state: "current" as const,
    run_id: checkpoint.run_id,
    work_order_id: checkpoint.work_order_id,
    attempt_id: checkpoint.attempt_id,
    worker_id: WORKER_ID,
    fencing_generation: authorizationGeneration,
    observed_at: NOW,
    valid_until: LATER,
    evidence_digest: EVIDENCE_DIGEST,
  };
  test.runnerOptions.recovery.observe = async () => ({
    schema: ASF_RECOVERY_REQUEST_SCHEMA,
    requesting_worker_id: WORKER_ID,
    checkpoint,
    checkpoint_observation: {
      state: "verified",
      checkpoint_digest: checkpoint.checkpoint_digest,
      observed_at: NOW,
      valid_until: LATER,
      evidence_digest: EVIDENCE_DIGEST,
    },
    ownership,
    remote_observations: checkpoint.reconciliation_markers.map((marker) => ({
      observation: marker.observation,
      state: "confirmed" as const,
      run_id: checkpoint.run_id,
      work_order_id: checkpoint.work_order_id,
      attempt_id: checkpoint.attempt_id,
      policy_digest: checkpoint.policy_digest,
      candidate_sha: checkpoint.candidate_sha,
      correlation_marker: marker.correlation_marker,
      observed_at: NOW,
      valid_until: LATER,
      evidence_digest: EVIDENCE_DIGEST,
    })),
    replay_requested: true,
    actor: {
      role: "implementer" as const,
      mode: "resume" as const,
      resume_observations: {
        schema: "asf.implementer-resume-observation/v1",
        requesting_worker_id: WORKER_ID,
        ownership,
        provider: {
          capability: "supported" as const,
          session_state: "resumable" as const,
          provider: metadata.provider,
          principal: metadata.principal,
          profile: metadata.profile,
          protected_resume_ref: metadata.protected_resume_ref,
          session_identity_digest: metadata.session_identity_digest,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
        identity_lease: {
          state: "current" as const,
          identity_lease_binding_digest:
            currentImplementer.lease_attribution_digest,
          run_id: checkpoint.run_id,
          work_order_id: checkpoint.work_order_id,
          attempt_id: checkpoint.attempt_id,
          role: "implementer" as const,
          policy_digest: checkpoint.policy_digest,
          fencing_generation: authorizationGeneration,
          provider: metadata.provider,
          principal: metadata.principal,
          profile: metadata.profile,
          expires_at: metadata.identity_lease_expires_at,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
        candidate_lineage: {
          state: "exact" as const,
          candidate_sha: checkpoint.candidate_sha,
          candidate_lineage_digest: checkpoint.candidate_lineage_digest,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
        policy: {
          state: "permitted" as const,
          policy_digest: checkpoint.policy_digest,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
      },
    },
  });
  test.runnerOptions.recovery.apply = async ({ plan, binding }) => {
    const completed = [...plan.requiredTakeoverFencing];
    const invalidated = [...plan.invalidatedEvidence];
    const acknowledgement = {
      schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
      binding: bindingWire(binding),
      checkpoint_digest: checkpoint.checkpoint_digest,
      action: plan.action,
      completed_takeover_fencing: completed,
      invalidated_evidence: invalidated,
      acknowledgement_digest: sha256Digest({
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
      }),
    };
    return acknowledgement;
  };
  return { checkpoint, metadata, authorizationGeneration };
}

describe("AsfPrDeliveryRunner", () => {
  it("refuses a zero provider-cost cap without calling the provider and confirms the no-op intent", async () => {
    const test = harness({ maxCostUsd: 0 });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
    expect(test.log).toContain("intent:candidate");
    expect(test.log).toContain("confirm:candidate");
    expect(test.log).not.toContain("effect:candidate");
    expect(test.log.indexOf("confirm:candidate")).toBeLessThan(
      test.log.indexOf("effect:cleanup"),
    );
    expect(test.store.terminalEvidence).toMatchObject({
      terminalPhase: "BUDGET_EXHAUSTED",
      candidateSha: null,
      deliveryBundleDigest: null,
      cleanupDigest: EVIDENCE_DIGEST,
    });
    expect(test.store.events.at(-1)?.payload).toMatchObject({
      terminal_evidence_bundle_digest:
        test.store.terminalEvidence?.bundleDigest,
    });
    expect(test.log.indexOf("effect:cleanup")).toBeLessThan(
      test.log.indexOf("finalize:terminal-evidence"),
    );
  });

  it.each([
    {
      priorOutcome: "confirmed" as const,
      disposition: "existing-prior-generation" as const,
      expectedConfirmationCount: 0,
    },
    {
      priorOutcome: "consumed-not-applied" as const,
      disposition: "existing-prior-generation-replay-authorized" as const,
      expectedConfirmationCount: 1,
    },
  ])(
    "stops a settled provider continuation without invoking the provider ($priorOutcome)",
    async ({
      priorOutcome,
      disposition,
      expectedConfirmationCount,
    }) => {
      const test = harness();
      const originalIntentReader = test.store.intentReader;
      const settlementDigest = sha256Digest({
        schema: "asf.provider-budget-unknown-settlement/v1",
        reservation_id: "provider-reservation-01",
        outcome: priorOutcome,
      });
      let providerCalls = 0;
      let candidateConfirmations = 0;
      let observedIntentMode: string | undefined;
      let durableCandidate: StoredAsfDeliveryStageIntent | undefined;

      const continuationIntents: AsfDeliveryIntentStore = {
        record(intent) {
          if (intent.stage !== "candidate") {
            return test.intents.record(intent);
          }
          test.log.push("intent:candidate");
          const { intent_digest: _digest, ...unsigned } = intent;
          const priorUnsigned = {
            ...unsigned,
            intent_id: `delivery-prior-${priorOutcome}`,
            fencing_generation: intent.fencing_generation - 1,
          };
          const prior = {
            ...priorUnsigned,
            intent_digest: sha256Digest(priorUnsigned),
          } satisfies AsfDeliveryStageIntent;
          durableCandidate = {
            ...prior,
            observationDigest:
              priorOutcome === "confirmed" ? EVIDENCE_DIGEST : null,
            observationOutcome:
              priorOutcome === "confirmed" ? "confirmed" : null,
            confirmedGeneration:
              priorOutcome === "confirmed"
                ? intent.fencing_generation
                : null,
            confirmedAt: priorOutcome === "confirmed" ? NOW : null,
            replayAuthorizedOperationId:
              priorOutcome === "consumed-not-applied"
                ? "reconcile-provider-01"
                : null,
            replayStartedGeneration:
              priorOutcome === "consumed-not-applied"
                ? intent.fencing_generation
                : null,
          };
          return { intent: prior, disposition };
        },
        confirm(input) {
          if (durableCandidate?.intent_id !== input.intentId) {
            test.intents.confirm(input);
            return;
          }
          candidateConfirmations += 1;
          expect(input.intentDigest).toBe(durableCandidate.intent_digest);
          expect(input.observationDigest).toBe(settlementDigest);
          durableCandidate = {
            ...durableCandidate,
            observationDigest: input.observationDigest,
            observationOutcome: "confirmed",
            confirmedGeneration: input.binding.fencingGeneration,
            confirmedAt: NOW,
            replayAuthorizedOperationId: null,
            replayStartedGeneration: null,
          };
          test.log.push("confirm:candidate");
        },
        prepareTerminal: test.intents.prepareTerminal.bind(test.intents),
        sealTerminal: test.intents.sealTerminal.bind(test.intents),
      };
      test.store.intentReader = (intentId) =>
        durableCandidate?.intent_id === intentId
          ? durableCandidate
          : originalIntentReader?.(intentId);

      const implementation = test.runnerOptions.implementation;
      const options: AsfPrDeliveryRunnerOptions = {
        ...test.runnerOptions,
        intents: continuationIntents,
        budget: {
          checkRun() {
            return { status: "available" };
          },
          reserve(input) {
            observedIntentMode = input.intentMode;
            return {
              status: "exhausted",
              reason: "cost-limit",
              observationDigest: settlementDigest,
            };
          },
          complete() {
            throw new Error(
              "a conservatively settled provider invocation must not complete",
            );
          },
        },
        implementation: {
          ...implementation,
          async createCandidate(input) {
            providerCalls += 1;
            return implementation.createCandidate(input);
          },
        },
      };

      await new AsfPrDeliveryRunner(options).run(test.context);

      expect(providerCalls).toBe(0);
      expect(candidateConfirmations).toBe(expectedConfirmationCount);
      expect(observedIntentMode).toBe(
        priorOutcome === "confirmed"
          ? "reconcile-only"
          : "observe-before-apply",
      );
      expect(test.log).not.toContain("effect:candidate");
      expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
      expect(test.store.terminalBundle?.statement.predicate.stop.code).toBe(
        "AGENT_COST_BUDGET_EXHAUSTED",
      );
    },
  );

  it("blocks a pre-candidate failure until its interrupted effect is reconciled", async () => {
    const test = harness();
    test.runnerOptions.repositoryLease.acquire = async () => {
      test.log.push("effect:repository-lease");
      throw new Error("protected repository adapter failure");
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
    expect(test.store.run.candidateSha).toBeNull();
    expect(test.store.terminalEvidence).toBeUndefined();
    expect(test.log).toContain("intent:repository-lease");
    expect(test.log).not.toContain("confirm:repository-lease");
    expect(test.log).not.toContain("finalize:terminal-evidence");
  });

  it("emits bounded stage telemetry without letting a recorder failure change a failing stage", async () => {
    const emitted: {
      readonly kind: "log" | "histogram";
      readonly name: string;
      readonly attributes: AsfTelemetryAttributeInput;
    }[] = [];
    const recorder: AsfTelemetryRecorder = {
      span() {
        throw new Error("telemetry sink is unavailable");
      },
      counter() {
        throw new Error("telemetry sink is unavailable");
      },
      histogram(name, _value, _unit, attributes = {}) {
        emitted.push({ kind: "histogram", name, attributes });
        throw new Error("telemetry sink is unavailable");
      },
      log(name, _severity, attributes = {}) {
        emitted.push({ kind: "log", name, attributes });
      },
    };
    const test = harness();
    test.runnerOptions.repositoryLease.acquire = async () => {
      test.log.push("effect:repository-lease");
      throw new Error("protected repository adapter failure");
    };

    await new AsfPrDeliveryRunner({
      ...test.runnerOptions,
      telemetry: recorder,
    }).run(test.context);

    // The failing stage still fails exactly as it does without telemetry.
    expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
    expect(test.store.run.candidateSha).toBeNull();
    expect(test.log).toContain("intent:repository-lease");
    expect(test.log).not.toContain("confirm:repository-lease");

    expect(emitted.map((signal) => `${signal.kind}:${signal.name}`)).toEqual([
      "log:runmill.asf.run.event",
      "histogram:runmill.asf.operation.duration",
    ]);
    for (const signal of emitted) {
      expect(signal.attributes).toEqual({
        component: "runner",
        stage: "admission",
        outcome: "failed",
        run_id: test.context.runId,
        work_order_id: test.store.run.workOrderId,
        attempt_id: test.store.run.attemptId,
      });
    }
  });

  it("cancels before first execution with signed cleanup evidence and no fabricated candidate", async () => {
    const test = harness();
    test.store.transition({
      from: "ADMITTED",
      to: "CANCEL_REQUESTED",
      expectedVersion: 1,
      eventType: "cancellation.requested",
      payload: {
        code: "CANCELLED",
        summary: "an authorized controller requested cancellation",
        checkpoint: "ADMITTED",
        retry_disposition: "safe",
        required_actor: "asf",
        required_action: "revoke identities and complete cancellation",
        evidence_refs: ["cancellation:cancel-01", EVIDENCE_DIGEST],
        request_id: "cancel-01",
        requester: "operator-01",
        reason: `protected:${EVIDENCE_DIGEST}`,
        mode: "graceful",
        grace_seconds: 30,
      },
    });
    test.log.length = 0;

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("CANCELLED");
    expect(test.store.run.candidateSha).toBeNull();
    expect(test.store.terminalEvidence).toMatchObject({
      terminalPhase: "CANCELLED",
      candidateSha: null,
      cleanupDigest: EVIDENCE_DIGEST,
      deliveryBundleDigest: null,
    });
    expect(test.log).not.toContain("effect:repository-lease");
    expect(test.log.indexOf("confirm:cleanup")).toBeLessThan(
      test.log.indexOf("finalize:terminal-evidence"),
    );
    expect(test.store.events.at(-1)).toMatchObject({
      type: "run.cancelled",
      phase: "CANCELLED",
      payload: {
        terminal_evidence_bundle_digest:
          test.store.terminalEvidence?.bundleDigest,
      },
    });
  });

  it.each([
    { crashAfterRecord: false, scenario: "direct" },
    { crashAfterRecord: true, scenario: "restart after terminal record" },
  ])(
    "uses the latest graceful-to-forced cancellation after EVIDENCE_FINALIZED ($scenario)",
    async ({ crashAfterRecord }) => {
      const test = harness();
      const cutoff = new AbortController();
      await expect(
        new AsfPrDeliveryRunner(test.runnerOptions).run({
          ...test.context,
          signal: cutoff.signal,
          transition: (input) => {
            const event = test.store.transition(input);
            if (input.to === "EVIDENCE_FINALIZED") {
              cutoff.abort(new Error("pause after delivery evidence"));
            }
            return event;
          },
        }),
      ).rejects.toThrow("pause after delivery evidence");
      expect(test.store.run.state).toBe("EVIDENCE_FINALIZED");
      expect(test.store.evidence?.bundleDigest).toBe(BUNDLE_DIGEST);

      test.store.transition({
        from: "EVIDENCE_FINALIZED",
        to: "CANCEL_REQUESTED",
        expectedVersion: test.store.run.stateVersion,
        eventType: "cancellation.requested",
        payload: {
          code: "CANCELLED",
          summary: "an authorized controller requested cancellation",
          checkpoint: "EVIDENCE_FINALIZED",
          retry_disposition: "safe",
          required_actor: "asf",
          required_action: "complete graceful cancellation cleanup",
          evidence_refs: ["cancellation:cancel-graceful"],
          candidate_sha: CANDIDATE_1,
          request_id: "cancel-graceful",
          requester: "operator-01",
          reason: `protected:${SOURCE_DIGEST}`,
          mode: "graceful",
          grace_seconds: 30,
        },
      });
      test.store.transition({
        from: "CANCEL_REQUESTED",
        to: "CANCEL_REQUESTED",
        expectedVersion: test.store.run.stateVersion,
        eventType: "cancellation.escalated",
        payload: {
          code: "CANCELLED",
          summary: "the graceful window elapsed; forced cancellation is effective",
          checkpoint: "CANCEL_REQUESTED",
          retry_disposition: "reconcile-first",
          required_actor: "asf",
          required_action: "reconcile effects and complete forced cleanup",
          evidence_refs: ["cancellation:cancel-forced", EVIDENCE_DIGEST],
          candidate_sha: CANDIDATE_1,
          request_id: "cancel-forced",
          requester: "operator-02",
          reason: `protected:${EVIDENCE_DIGEST}`,
          mode: "forced",
          grace_seconds: 0,
        },
      });
      test.log.length = 0;
      const crash = new AbortController();
      const cancellationContext: AsfRunnerContext = {
        ...test.context,
        signal: crash.signal,
        transition: (input) => {
          if (crashAfterRecord && input.to === "CANCELLED") {
            crash.abort(new Error("crash after cancellation evidence"));
            throw crash.signal.reason;
          }
          return test.store.transition(input);
        },
      };
      const cancellationRun = new AsfPrDeliveryRunner(
        test.runnerOptions,
      ).run(cancellationContext);
      if (crashAfterRecord) {
        await expect(cancellationRun).rejects.toThrow(
          "crash after cancellation evidence",
        );
        expect(test.store.run.state).toBe("CANCELLING");
        expect(test.store.terminalEvidence).toMatchObject({
          terminalPhase: "CANCELLED",
          deliveryBundleDigest: BUNDLE_DIGEST,
        });
        await new AsfPrDeliveryRunner(test.runnerOptions).run({
          ...test.context,
          signal: new AbortController().signal,
        });
      } else {
        await cancellationRun;
      }

      expect(test.store.run.state).toBe("CANCELLED");
      expect(
        test.store.terminalBundle?.statement.predicate.cancellation,
      ).toMatchObject({
        request_id: "cancel-forced",
        event_type: "cancellation.escalated",
        requester_subject: "operator-02",
        mode: "forced",
        grace_seconds: 0,
      });
      expect(test.store.terminalEvidence).toMatchObject({
        candidateSha: CANDIDATE_1,
        deliveryBundleDigest: BUNDLE_DIGEST,
      });
      expect(test.store.events.at(-1)).toMatchObject({
        type: "run.cancelled",
        payload: {
          request_id: "cancel-forced",
          requester: "operator-02",
          mode: "forced",
          grace_seconds: 0,
          terminal_evidence_bundle_digest:
            test.store.terminalEvidence?.bundleDigest,
        },
      });
    },
  );

  it("enforces the aggregate invocation count before a second provider call", async () => {
    const test = harness({ maxAgentInvocations: 1 });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
    expect(
      test.log.filter((entry) => entry === "effect:candidate"),
    ).toHaveLength(1);
    expect(test.log).toContain("intent:local-review");
    expect(test.log).toContain("confirm:local-review");
    expect(test.log).not.toContain("effect:local-review");
  });

  it("records an over-cap provider result before stopping without later delivery effects", async () => {
    const test = harness({ maxCostUsd: 1, providerCostsUsd: [1.5] });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
    expect(test.log).toContain("effect:candidate");
    expect(test.log).toContain("confirm:candidate");
    expect(test.log).not.toContain("transition:CANDIDATE_READY");
    expect(test.log).not.toContain("effect:branch-push");
  });

  it("stops at the accepted-at wall deadline before starting the next lifecycle effect", async () => {
    const test = harness({ wallSeconds: 1 });
    const acquire = test.runnerOptions.repositoryLease.acquire.bind(
      test.runnerOptions.repositoryLease,
    );
    test.runnerOptions.repositoryLease.acquire = async (input) => {
      const observation = await acquire(input);
      test.clock.advanceMs(1_000);
      return observation;
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
    expect(test.log).toContain("effect:repository-lease");
    expect(test.log).not.toContain("intent:identity-leases");
    expect(test.log).not.toContain("effect:identity-leases");
    expect(test.log).toContain("effect:cleanup");
  });

  it("delivers an exact PR candidate, finalizes evidence, and cleans up", async () => {
    const test = harness();
    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("COMPLETED");
    expect(test.store.run.candidateSha).toBe(CANDIDATE_1);
    expect(test.store.evidence?.bundleDigest).toBe(BUNDLE_DIGEST);
    expect(test.store.terminalEvidence).toMatchObject({
      terminalPhase: "COMPLETED",
      candidateSha: CANDIDATE_1,
      deliveryBundleDigest: BUNDLE_DIGEST,
      bundleDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(
      test.store.checkpoints.map((checkpoint) => checkpoint.checkpoint_kind),
    ).toEqual(
      expect.arrayContaining([
        "work-order-admission",
        "repository-lease-acquisition",
        "identity-lease-acquisition",
        "workspace-sandbox-proof",
        "task-packet-creation",
        "implementer-session-marker",
        "candidate-commit-creation",
        "local-verification-pass",
        "local-review-fixer-iteration",
        "branch-push-intent-observation",
        "pull-request-intent-observation",
        "ci-reconciliation-snapshot",
        "pr-review-fixer-iteration",
        "evidence-finalization-acknowledgement",
        "lease-release-workspace-cleanup",
      ]),
    );

    for (const entry of test.log.filter((item) => item.startsWith("effect:"))) {
      const stage = entry.slice("effect:".length);
      const effectIndex = test.log.indexOf(entry);
      const intentIndex = test.log.findIndex(
        (item) => item === `intent:${stage}`,
      );
      expect(
        intentIndex,
        `missing intent before ${entry}`,
      ).toBeGreaterThanOrEqual(0);
      expect(intentIndex).toBeLessThan(effectIndex);
      expect(
        test.log
          .slice(0, effectIndex)
          .some((item) => item.startsWith("checkpoint:")),
      ).toBe(true);
    }
    expect(test.log.indexOf("effect:cleanup")).toBeLessThan(
      test.log.indexOf("finalize:terminal-evidence"),
    );
    expect(test.log.indexOf("finalize:terminal-evidence")).toBeLessThan(
      test.log.indexOf("transition:COMPLETED"),
    );
    expect(test.log.indexOf("transition:COMPLETED")).toBeLessThan(
      test.log.indexOf("checkpoint:lease-release-workspace-cleanup"),
    );
    expect(
      test.reviewInputs.every((input) => input.session.mode === "fresh"),
    ).toBe(true);
    const delivered = test.store.events.find(
      (event) => event.type === "pull_request.delivered",
    );
    const finalCi = test.store.events.find(
      (event) => event.type === "ci.revalidated",
    );
    expect(finalCi).toMatchObject({
      phase: "PR_REVIEW",
      payload: {
        candidate_sha: CANDIDATE_1,
        outcome: "passed",
        observation_intent_digest: expect.stringMatching(/^sha256:/u),
        observation_digest: expect.stringMatching(/^sha256:/u),
        checks_digest: sha256Digest(ciChecks("passed")),
        checks: ciChecks("passed"),
        observed_at: NOW,
      },
    });
    expect(finalCi?.seq).toBe((delivered?.seq ?? 0) - 1);
    expect(delivered?.payload).toMatchObject({
      repository: "acme/widgets",
      number: 1,
      head_ref: "refs/heads/runmill/run-01",
      base_ref: "refs/heads/main",
      marker: "marker-run-01",
      head_sha: CANDIDATE_1,
      observed_head_sha: CANDIDATE_1,
      current_base_sha: BASE_SHA,
      protection_digest: FINAL_PROTECTION_DIGEST,
      protection: FINAL_PROTECTION,
      delivery_observation_intent_digest: expect.stringMatching(/^sha256:/u),
      delivery_observation_digest: expect.stringMatching(/^sha256:/u),
      final_ci_observation_intent_digest:
        finalCi?.payload["observation_intent_digest"],
      final_ci_observation_digest:
        finalCi?.payload["observation_digest"],
      final_ci_observation_fencing_generation: 7,
      final_ci_checks_digest: sha256Digest(ciChecks("passed")),
      final_ci_checks: ciChecks("passed"),
      final_ci_observed_at: NOW,
    });
    expect(test.store.events.at(-1)?.payload).toMatchObject({
      evidence_bundle_digest: BUNDLE_DIGEST,
      terminal_evidence_bundle_digest:
        test.store.terminalEvidence?.bundleDigest,
    });
    expect(test.log.indexOf("effect:pull-request-review")).toBeLessThan(
      test.log.indexOf("observe:final-pr-delivery"),
    );
    expect(test.log.indexOf("observe:final-pr-delivery")).toBeLessThan(
      test.log.indexOf("transition:PR_DELIVERED"),
    );
  });

  it("covers credential-free runner completion with the production terminal signer (non-qualified)", async () => {
    const test = harness();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signingKey = {
      keyId: "deterministic-terminal-key",
      privateKey,
      publicKey,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    };
    const runnerOptions: AsfPrDeliveryRunnerOptions = {
      ...test.runnerOptions,
      // This test exercises the real signer against deterministic adapters. It
      // is intentionally not a production qualification claim.
      terminalEvidence:
        new ProductionAsfTerminalEvidenceFinalizationController({
          signingKey,
          clock: test.clock,
        }),
    };

    await new AsfPrDeliveryRunner(runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("COMPLETED");
    const bundle = test.store.terminalBundle;
    if (bundle === undefined) throw new Error("terminal evidence bundle missing");
    expect(bundle.signature).toMatch(/^base64url:[A-Za-z0-9_-]{86}$/u);
    expect(bundle.signature).not.toBe(`base64url:${"A".repeat(86)}`);
    expect(bundle.statement.predicate.run.terminal_phase).toBe("COMPLETED");
    expect(bundle.statement.predicate.source.candidate_sha).toBe(CANDIDATE_1);
    expect(bundle.statement.predicate.evidence.delivery_bundle_digest).toBe(
      BUNDLE_DIGEST,
    );
    expect(bundle.statement.predicate.cleanup.observation_digest).toBe(
      EVIDENCE_DIGEST,
    );
    expect(bundle.statement.predicate.evidence.preceding_event_chain_digest).toBe(
      sha256Digest(test.store.events.slice(0, -1)),
    );

    const predicate = bundle.statement.predicate;
    const expected: AsfTerminalEvidenceExpectations = {
      runId: predicate.run.run_id,
      workOrderId: predicate.run.work_order_id,
      attemptId: predicate.run.attempt_id,
      workOrderEnvelopeDigest: predicate.admission.work_order_envelope_digest,
      workOrderPayloadDigest: predicate.admission.work_order_payload_digest,
      effectivePolicyDigest: predicate.admission.effective_policy_digest,
      repository: predicate.source.repository,
      baseSha: predicate.source.base_sha,
      candidateSha: CANDIDATE_1,
      terminalPhase: "COMPLETED",
      terminalEventSeq: predicate.run.terminal_event_seq,
      cleanupObservationDigest: EVIDENCE_DIGEST,
      deliveryBundleDigest: BUNDLE_DIGEST,
      precedingEventChainDigest:
        predicate.evidence.preceding_event_chain_digest,
      providerBudget: predicate.budget.provider_usage,
      sideEffects: predicate.side_effects,
      admittedAt: predicate.timing.admitted_at,
      terminalEvidenceAt: predicate.timing.terminal_evidence_at,
      elapsedMs: predicate.timing.elapsed_ms,
    };
    const trustedSigner = {
      keyId: signingKey.keyId,
      publicKey: signingKey.publicKey,
      validFrom: signingKey.validFrom,
      validUntil: signingKey.validUntil,
      revokedAt: null,
    };
    expect(
      validateSignedAsfTerminalEvidenceBundle(bundle, {
        clock: test.clock,
        trustedSigners: [trustedSigner],
        expected,
      }),
    ).toMatchObject({
      terminalPhase: "COMPLETED",
      candidateSha: CANDIDATE_1,
      signer: { keyId: signingKey.keyId, algorithm: "EdDSA", verified: true },
    });

    const tampered = structuredClone(bundle);
    tampered.signature = `base64url:${"A".repeat(86)}`;
    expect(() =>
      validateSignedAsfTerminalEvidenceBundle(tampered, {
        clock: test.clock,
        trustedSigners: [trustedSigner],
        expected,
      }),
    ).toThrow(/signature|Ed25519/u);
  });

  it("captures exact identity-bound resume metadata and carries it only through resumable checkpoints", async () => {
    const test = harness({ resumableImplementer: true });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("COMPLETED");
    const candidateCheckpoint = test.store.checkpoints.find(
      (checkpoint) =>
        checkpoint.checkpoint_kind === "candidate-commit-creation",
    );
    expect(candidateCheckpoint?.protected_implementer_resume).toMatchObject({
      protected_resume_ref: PROTECTED_RESUME_REF,
      session_identity_digest: SESSION_IDENTITY_DIGEST,
      candidate_sha: CANDIDATE_1,
      provider: "codex",
      principal: "implementer-principal",
      profile: "impl-profile",
      fencing_generation: 7,
    });
    const resumableAfterCandidate = test.store.checkpoints.filter(
      (checkpoint) =>
        checkpoint.event_seq >=
          (candidateCheckpoint?.event_seq ?? Number.MAX_SAFE_INTEGER) &&
        getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind)
          .implementerSessionResume === "protected-conditional",
    );
    expect(resumableAfterCandidate.length).toBeGreaterThan(1);
    expect(
      resumableAfterCandidate.every(
        (checkpoint) =>
          checkpoint.protected_implementer_resume?.session_identity_digest ===
          SESSION_IDENTITY_DIGEST,
      ),
    ).toBe(true);
    expect(
      test.store.checkpoints
        .filter(
          (checkpoint) =>
            getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind)
              .implementerSessionResume === "never",
        )
        .every(
          (checkpoint) => checkpoint.protected_implementer_resume === null,
        ),
    ).toBe(true);
    const publicSummary = publicAsfCheckpointSummary(candidateCheckpoint);
    expect(JSON.stringify(publicSummary)).not.toContain(PROTECTED_RESUME_REF);
    expect(JSON.stringify(publicSummary)).not.toContain(
      "implementer-principal",
    );
    expect(JSON.stringify(test.store.events)).not.toContain(
      PROTECTED_RESUME_REF,
    );
  });

  it("resumes a runner-produced implementer checkpoint through only an exact authorization", async () => {
    const test = harness({ resumableImplementer: true });
    const { metadata, authorizationGeneration } =
      await prepareProtectedImplementerRecovery(test, { takeover: true });
    let observedSession: unknown;
    test.runnerOptions.implementation.describeAuthorizedResume = async (
      input,
    ) => {
      expect(input.authorization).toBeInstanceOf(AuthorizedImplementerResume);
      expect(JSON.stringify(input.authorization)).not.toContain(
        PROTECTED_RESUME_REF,
      );
      const unsigned = {
        schema: ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA,
        authorization_digest: sha256Digest(
          input.authorization.binding as unknown as JsonValue,
        ),
        session_identity_digest: metadata.session_identity_digest,
        invocation_id: "resume-invocation-01",
        provider_candidate_sha: BASE_SHA,
        task_packet_digest: TASK_PACKET_DIGEST,
      } as const;
      return { ...unsigned, descriptor_digest: sha256Digest(unsigned) };
    };
    const createCandidate =
      test.runnerOptions.implementation.createCandidate.bind(
        test.runnerOptions.implementation,
      );
    test.runnerOptions.implementation.createCandidate = async (input) => {
      observedSession = input.session;
      return createCandidate(input);
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run({
      ...test.context,
      generation: authorizationGeneration,
      takeover: true,
      signal: new AbortController().signal,
    });

    expect(test.store.run.state).toBe("COMPLETED");
    expect(observedSession).toMatchObject({
      mode: "resume",
      authorization: {
        binding: {
          checkpointKind: "implementer-session-marker",
          sessionIdentityDigest: SESSION_IDENTITY_DIGEST,
          fencingGeneration: 7,
          authorizationFencingGeneration: 8,
        },
      },
    });
    expect(JSON.stringify(observedSession)).not.toContain(PROTECTED_RESUME_REF);
    expect(
      test.reviewInputs.every((input) => input.session.mode === "fresh"),
    ).toBe(true);
    expect(
      test.store.checkpoints.find(
        (checkpoint) =>
          checkpoint.checkpoint_kind === "candidate-commit-creation",
      )?.protected_implementer_resume,
    ).toMatchObject({
      protected_resume_ref: PROTECTED_RESUME_REF,
      candidate_sha: CANDIDATE_1,
    });
  });

  it("refuses a malformed resume descriptor before any provider invocation", async () => {
    const test = harness({ resumableImplementer: true });
    await prepareProtectedImplementerRecovery(test);
    let providerCalls = 0;
    test.runnerOptions.implementation.describeAuthorizedResume = async (
      input,
    ) => {
      const unsigned = {
        schema: ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA,
        authorization_digest: sha256Digest(
          input.authorization.binding as unknown as JsonValue,
        ),
        session_identity_digest: SESSION_IDENTITY_DIGEST,
        invocation_id: "resume-invocation-01",
        provider_candidate_sha: CANDIDATE_1,
        task_packet_digest: TASK_PACKET_DIGEST,
      } as const;
      return { ...unsigned, descriptor_digest: sha256Digest(unsigned) };
    };
    const createCandidate =
      test.runnerOptions.implementation.createCandidate.bind(
        test.runnerOptions.implementation,
      );
    test.runnerOptions.implementation.createCandidate = async (input) => {
      providerCalls += 1;
      return createCandidate(input);
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run({
      ...test.context,
      signal: new AbortController().signal,
    });

    expect(providerCalls).toBe(0);
    expect(test.store.run.state).toBe("QUARANTINED");
    expect(JSON.stringify(test.store.events)).not.toContain(
      PROTECTED_RESUME_REF,
    );
  });

  it.each([
    ["head", { head_sha: CANDIDATE_2 }],
    ["base", { base_ref: "refs/heads/release" }],
    ["marker", { marker: "marker-run-other" }],
  ] as const)(
    "refuses when the PR %s changes during fresh review",
    async (_field, overrides) => {
      const test = harness({ finalDeliveryOverrides: overrides });

      await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

      expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
      expect(
        test.store.events.some(
          (event) => event.type === "pull_request.delivered",
        ),
      ).toBe(false);
      expect(test.log).toContain("observe:final-pr-delivery");
      expect(test.store.terminalEvidence).toBeUndefined();
    },
  );

  it("durably yields a pending final CI recheck and completes only after restart, repoll, and fresh review", async () => {
    const test = harness({
      requiredRemoteChecks: ["ci/unit", "ci/integration"],
      ciCheckSequences: [
        [
          ...ciChecks("passed", "ci/unit"),
          ...ciChecks("passed", "ci/integration"),
        ],
        [
          ...ciChecks("passed", "ci/unit"),
          ...ciChecks("pending", "ci/integration"),
        ],
        [
          ...ciChecks("passed", "ci/unit"),
          ...ciChecks("passed", "ci/integration"),
        ],
        [
          ...ciChecks("passed", "ci/unit"),
          ...ciChecks("passed", "ci/integration"),
        ],
      ],
    });

    await expect(
      new AsfPrDeliveryRunner(test.runnerOptions).run(test.context),
    ).rejects.toBeInstanceOf(AsfPendingCiRetryError);

    expect(test.store.run.state).toBe("CI_WAIT");
    expect(test.store.events.at(-1)).toMatchObject({
      type: "ci.recheck_completed",
      phase: "CI_WAIT",
      payload: {
        outcome: "pending",
        checks_digest: sha256Digest([
          ...ciChecks("passed", "ci/unit"),
          ...ciChecks("pending", "ci/integration"),
        ]),
      },
    });
    expect(test.store.checkpoints.at(-1)).toMatchObject({
      checkpoint_kind: "ci-reconciliation-snapshot",
      phase: "CI_WAIT",
    });
    expect(
      test.store.events.some((event) => event.type === "pull_request.delivered"),
    ).toBe(false);
    expect(test.store.evidence).toBeUndefined();

    configureCurrentCheckpointRecovery(test);
    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("COMPLETED");
    expect(
      test.store.events.filter((event) => event.type === "pr_review.completed"),
    ).toHaveLength(2);
    const delivered = test.store.events.find(
      (event) => event.type === "pull_request.delivered",
    );
    const revalidated = test.store.events.findLast(
      (event) => event.type === "ci.revalidated",
    );
    expect(revalidated?.seq).toBe((delivered?.seq ?? 0) - 1);
  });

  it("never delivers when the final CI recheck fails through the admitted fix budget", async () => {
    const test = harness({
      maxFixIterations: 1,
      ciCheckSequences: [
        ciChecks("passed"),
        ciChecks("failed"),
        ciChecks("passed"),
        ciChecks("failed"),
      ],
    });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BUDGET_EXHAUSTED");
    expect(
      test.store.events.filter(
        (event) =>
          event.type === "ci.recheck_completed" &&
          event.payload["outcome"] === "failed",
      ),
    ).toHaveLength(2);
    expect(
      test.store.events.some((event) => event.type === "pull_request.delivered"),
    ).toBe(false);
    expect(test.store.evidence).toBeUndefined();
    expect(test.log).not.toContain("effect:evidence");
  });

  it("quarantines a final CI recheck whose context set changed after initial success", async () => {
    const test = harness({
      ciCheckSequences: [ciChecks("passed"), ciChecks("passed", "ci/other")],
    });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
    expect(
      test.store.events.some((event) => event.type === "pull_request.delivered"),
    ).toBe(false);
    expect(test.store.evidence).toBeUndefined();
    expect(test.log).not.toContain("effect:evidence");
  });

  it("never terminalizes when cleanup cannot prove resource release", async () => {
    const test = harness();
    test.runnerOptions.cleanup.cleanup = async () => {
      test.log.push("effect:cleanup-failed");
      throw new Error("protected cleanup failure");
    };

    await expect(
      new AsfPrDeliveryRunner(test.runnerOptions).run(test.context),
    ).rejects.toBeInstanceOf(AsfPendingTerminalEvidenceRetryError);

    expect(test.store.run.state).toBe("EVIDENCE_FINALIZED");
    expect(
      test.store.events.some((event) => event.type === "run.completed"),
    ).toBe(false);
    expect(test.store.events.some((event) => event.type === "run.failed")).toBe(
      false,
    );
    expect(test.store.checkpoints.at(-1)).toMatchObject({
      checkpoint_kind: "evidence-finalization-acknowledgement",
      phase: "EVIDENCE_FINALIZED",
    });
    expect(test.store.getAsfTerminalEvidencePlanRecord(test.store.run.runId))
      .toMatchObject({ terminalPhase: "COMPLETED" });
    expect(
      test.store.getAsfTerminalEvidenceIntentRecord(test.store.run.runId),
    ).toBeUndefined();
  });

  it("invalidates every candidate-bound result and starts fresh reviewers after a fix", async () => {
    const test = harness({
      localReviewOutcomes: ["changes-requested", "approved"],
    });
    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("COMPLETED");
    expect(test.store.run.candidateSha).toBe(CANDIDATE_2);
    expect(test.invalidations).toEqual([[...CANDIDATE_CHANGE_INVALIDATES]]);
    const local = test.reviewInputs.filter(
      (input) => input.reviewKind === "local",
    );
    expect(local.map((input) => input.candidateSha)).toEqual([
      CANDIDATE_1,
      CANDIDATE_2,
    ]);
    expect(new Set(local.map((input) => input.invocationId)).size).toBe(2);
    expect(local.every((input) => input.session.mode === "fresh")).toBe(true);
    expect(
      test.log.filter((item) => item === "effect:local-verification"),
    ).toHaveLength(2);
  });

  it("recovers after a crash following a failed final local check without inventing a pass", async () => {
    const test = harness({ localVerificationOutcomes: ["failed", "passed"] });
    const crash = new AbortController();
    let injected = false;
    const crashingContext: AsfRunnerContext = {
      ...test.context,
      signal: crash.signal,
      transition: (input) => {
        const event = test.store.transition(input);
        if (
          !injected &&
          input.eventType === "verification.completed" &&
          input.payload["outcome"] === "failed"
        ) {
          injected = true;
          crash.abort(new Error("simulated crash after failed final check"));
        }
        return event;
      },
    };

    await expect(
      new AsfPrDeliveryRunner(test.runnerOptions).run(crashingContext),
    ).rejects.toThrow("simulated crash after failed final check");
    expect(test.store.run.state).toBe("LOCAL_VERIFY");
    expect(
      test.store.getLatestAsfCheckpoint(test.store.run.runId),
    ).toMatchObject({
      checkpoint_kind: "candidate-commit-creation",
      candidate_sha: CANDIDATE_1,
    });
    expect(
      test.store.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpoint_kind === "local-verification-pass" &&
          checkpoint.candidate_sha === CANDIDATE_1,
      ),
    ).toBe(false);
    expect(
      test.store.events.some((event) => event.type === "review.started"),
    ).toBe(false);

    test.runnerOptions.recovery.observe = async ({ checkpoint, binding }) => ({
      schema: ASF_RECOVERY_REQUEST_SCHEMA,
      requesting_worker_id: WORKER_ID,
      checkpoint,
      checkpoint_observation: {
        state: "verified",
        checkpoint_digest: checkpoint.checkpoint_digest,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      ownership: {
        state: "current",
        run_id: binding.runId,
        work_order_id: binding.workOrderId,
        attempt_id: binding.attemptId,
        worker_id: WORKER_ID,
        fencing_generation: binding.fencingGeneration,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      remote_observations: [],
      replay_requested: false,
      actor: { role: "orchestrator", mode: "automatic" },
    });
    test.runnerOptions.recovery.apply = async ({
      plan,
      checkpoint,
      binding,
    }) => {
      const completed = [...plan.requiredTakeoverFencing];
      const invalidated = [...plan.invalidatedEvidence];
      return {
        schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
        binding: bindingWire(binding),
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
        acknowledgement_digest: sha256Digest({
          checkpoint_digest: checkpoint.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing: completed,
          invalidated_evidence: invalidated,
        }),
      };
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run({
      ...test.context,
      signal: new AbortController().signal,
    });

    expect(test.store.run.state).toBe("COMPLETED");
    expect(
      test.log.filter((entry) => entry === "effect:local-verification"),
    ).toHaveLength(2);
    expect(
      test.store.events.some((event) => event.type === "review.started"),
    ).toBe(true);
  });

  it("refuses an implementer and reviewer resolved to the same provider principal/profile", async () => {
    const test = harness({ duplicateReviewerPrincipal: true });

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
    expect(test.log).toContain("effect:identity-leases");
    expect(test.log).not.toContain("effect:workspace");
    expect(test.store.terminalEvidence).toBeUndefined();
    expect(test.store.events.at(-1)?.payload["summary"]).toBe(
      "terminal cleanup could not prove complete resource release",
    );
  });

  it("plans and acknowledges recovery before invoking a stage controller", async () => {
    const test = harness({ stopAtRepository: true });
    const checkpointPolicy = getAsfCheckpointRecoveryPolicy(
      "work-order-admission",
    );
    const checkpoint = createDurableAsfCheckpoint({
      schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
      checkpoint_id: "cp-admission-seeded",
      checkpoint_kind: "work-order-admission",
      run_id: test.store.run.runId,
      work_order_id: test.store.admission.workOrderId,
      attempt_id: test.store.admission.attemptId,
      phase: "ADMITTED",
      event_seq: 1,
      fencing_generation: test.store.run.generation,
      policy_digest: test.store.admission.effectivePolicyDigest,
      candidate_sha: null,
      candidate_lineage_digest: sha256Digest({
        run_id: test.store.run.runId,
        candidate_sha: null,
      }),
      durable_inputs_digest: EVIDENCE_DIGEST,
      durable_outputs_digest: EVIDENCE_DIGEST,
      replay_policy: checkpointPolicy.replayPolicy,
      reconciliation_markers: [],
      protected_implementer_resume: null,
      created_at: NOW,
    });
    test.store.checkpoints.push(checkpoint);
    test.log.push("checkpoint:work-order-admission");
    test.runnerOptions.recovery.observe = async ({
      checkpoint: observed,
      binding,
    }) => {
      test.log.push("recovery:observe");
      return {
        schema: ASF_RECOVERY_REQUEST_SCHEMA,
        requesting_worker_id: WORKER_ID,
        checkpoint: observed,
        checkpoint_observation: {
          state: "verified",
          checkpoint_digest: observed.checkpoint_digest,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
        ownership: {
          state: "current",
          run_id: binding.runId,
          work_order_id: binding.workOrderId,
          attempt_id: binding.attemptId,
          worker_id: WORKER_ID,
          fencing_generation: binding.fencingGeneration,
          observed_at: NOW,
          valid_until: LATER,
          evidence_digest: EVIDENCE_DIGEST,
        },
        remote_observations: [],
        replay_requested: false,
        actor: { role: "orchestrator", mode: "automatic" },
      };
    };
    test.runnerOptions.recovery.apply = async ({
      plan,
      checkpoint: recovered,
      binding,
    }) => {
      test.log.push("recovery:apply");
      const completed = [...plan.requiredTakeoverFencing];
      const invalidated = [...plan.invalidatedEvidence];
      return {
        schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
        binding: bindingWire(binding),
        checkpoint_digest: recovered.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
        acknowledgement_digest: sha256Digest({
          checkpoint_digest: recovered.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing: completed,
          invalidated_evidence: invalidated,
        }),
      };
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("NEEDS_SPEC");
    expect(test.log.indexOf("recovery:observe")).toBeLessThan(
      test.log.indexOf("recovery:apply"),
    );
    expect(test.log.indexOf("recovery:apply")).toBeLessThan(
      test.log.indexOf("intent:repository-lease"),
    );
    expect(test.log.indexOf("intent:repository-lease")).toBeLessThan(
      test.log.indexOf("effect:repository-lease"),
    );
  });

  it.each([
    { recoveryCase: "stale-owner crash", releaseBeforeRestart: false },
    { recoveryCase: "owner-null clean restart", releaseBeforeRestart: true },
  ])(
    "recovers a real SQLite transition checkpoint after $recoveryCase",
    async ({ releaseBeforeRestart }) => {
      const directory = mkdtempSync(
        join(tmpdir(), "runmill-delivery-recovery-"),
      );
      const databasePath = join(directory, "runmill.db");
      const clock = new FakeClock(NOW);
      const test = harness();
      const fixture = fixtureAdmission();
      const runId = "run-sqlite-recovery";
      let store = StateStore.open(databasePath, { clock });
      try {
        store.admitAsfWorkOrder({
          runId,
          envelope: fixture.envelope,
          canonicalEnvelope: fixture.admission.canonicalEnvelope,
          envelopeDigest: fixture.admission.envelopeDigest,
          payloadDigest: fixture.admission.payloadDigest,
          effectivePolicy: fixture.policy,
        });
        const firstOwnership = store.claimAsfRun({
          runId,
          ownerId: WORKER_ID,
          staleBefore: "2026-08-21T09:59:00.000Z",
        });
        expect(firstOwnership).toEqual({ generation: 1, takeover: false });
        expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
          checkpoint_kind: "work-order-admission",
          phase: "ADMITTED",
          event_seq: 1,
          fencing_generation: 1,
        });

        const recovery = {
          async observe({
            checkpoint,
            binding,
            workerId,
            takeover,
          }: Parameters<AsfPrDeliveryRunnerOptions["recovery"]["observe"]>[0]) {
            test.log.push(`sqlite-recovery:observe:${String(takeover)}`);
            const observedAt = clock.now();
            const validUntil = new Date(
              observedAt.getTime() + 60_000,
            ).toISOString();
            const request = {
              schema: ASF_RECOVERY_REQUEST_SCHEMA,
              requesting_worker_id: workerId,
              checkpoint,
              checkpoint_observation: {
                state: "verified",
                checkpoint_digest: checkpoint.checkpoint_digest,
                observed_at: observedAt.toISOString(),
                valid_until: validUntil,
                evidence_digest: EVIDENCE_DIGEST,
              },
              ownership: {
                state: "current",
                run_id: binding.runId,
                work_order_id: binding.workOrderId,
                attempt_id: binding.attemptId,
                worker_id: workerId,
                fencing_generation: binding.fencingGeneration,
                observed_at: observedAt.toISOString(),
                valid_until: validUntil,
                evidence_digest: EVIDENCE_DIGEST,
              },
              remote_observations: [],
              replay_requested: false,
              actor: { role: "orchestrator", mode: "automatic" },
            };
            return request;
          },
          async apply({
            plan,
            checkpoint,
            binding,
          }: Parameters<AsfPrDeliveryRunnerOptions["recovery"]["apply"]>[0]) {
            test.log.push(
              `sqlite-recovery:apply:${String(plan.ownershipTakeover)}`,
            );
            const completed = [...plan.requiredTakeoverFencing];
            const invalidated = [...plan.invalidatedEvidence];
            return {
              schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
              binding: bindingWire(binding),
              checkpoint_digest: checkpoint.checkpoint_digest,
              action: plan.action,
              completed_takeover_fencing: completed,
              invalidated_evidence: invalidated,
              acknowledgement_digest: sha256Digest({
                checkpoint_digest: checkpoint.checkpoint_digest,
                action: plan.action,
                completed_takeover_fencing: completed,
                invalidated_evidence: invalidated,
              }),
            };
          },
        } satisfies AsfPrDeliveryRunnerOptions["recovery"];

        const firstAbort = new AbortController();
        const firstOptions: AsfPrDeliveryRunnerOptions = {
          ...test.runnerOptions,
          store,
          clock,
          recovery,
          identities: {
            async acquireRequiredRoles() {
              firstAbort.abort(
                new Error("simulated process loss after repository checkpoint"),
              );
              throw firstAbort.signal.reason;
            },
          },
        };
        const firstContext: AsfRunnerContext = {
          runId,
          generation: 1,
          takeover: false,
          signal: firstAbort.signal,
          transition: (input) =>
            store.transitionAsfRun({
              ...input,
              runId,
              ownerId: WORKER_ID,
              generation: 1,
            }),
        };
        await expect(
          new AsfPrDeliveryRunner(firstOptions).run(firstContext),
        ).rejects.toThrow("simulated process loss");
        expect(store.getAsfRun(runId)).toMatchObject({
          state: "REPOSITORY_LEASED",
          stateVersion: 2,
          ownerId: WORKER_ID,
          generation: 1,
        });
        const repositoryCheckpoint = store.getLatestAsfCheckpoint(runId);
        expect(repositoryCheckpoint).toMatchObject({
          checkpoint_kind: "repository-lease-acquisition",
          phase: "REPOSITORY_LEASED",
          event_seq: 2,
          fencing_generation: 1,
        });
        if (releaseBeforeRestart) {
          store.releaseAsfRunOwnership(runId, WORKER_ID, 1);
          expect(store.getAsfRun(runId)).toMatchObject({
            ownerId: null,
            generation: 1,
          });
        }

        store.close();
        clock.advanceMinutes(2);
        store = StateStore.open(databasePath, { clock });
        const secondWorker = "worker-02";
        expect(
          store.claimAsfRun({
            runId,
            ownerId: secondWorker,
            staleBefore: "2026-08-21T10:01:00.000Z",
          }),
        ).toEqual({ generation: 2, takeover: true });
        expect(store.getLatestAsfCheckpoint(runId)).toEqual(
          repositoryCheckpoint,
        );

        test.log.length = 0;
        const secondOptions: AsfPrDeliveryRunnerOptions = {
          ...test.runnerOptions,
          workerId: secondWorker,
          store,
          clock,
          recovery,
          identities: {
            async acquireRequiredRoles(input) {
              expect(input.intentMode).toBe("reconcile-only");
              test.log.push("sqlite-recovery:identity-reconciled");
              throw new AsfDeliveryStop({
                phase: "NEEDS_SPEC",
                code: "IDENTITY_RECONCILIATION_REQUIRES_OPERATOR",
                summary: "identity reconciliation needs an operator decision",
                retryDisposition: "reconcile-first",
                requiredActor: "platform-operator",
                requiredAction: "resolve the protected identity intent",
              });
            },
          },
        };
        const secondContext: AsfRunnerContext = {
          runId,
          generation: 2,
          takeover: true,
          signal: new AbortController().signal,
          transition: (input) =>
            store.transitionAsfRun({
              ...input,
              runId,
              ownerId: secondWorker,
              generation: 2,
            }),
        };
        await new AsfPrDeliveryRunner(secondOptions).run(secondContext);

        expect(test.log.slice(0, 4)).toEqual([
          "sqlite-recovery:observe:true",
          "sqlite-recovery:apply:true",
          "recovery-dispatch:continue-from-checkpoint",
          "intent:identity-leases",
        ]);
        expect(test.log).toContain("sqlite-recovery:identity-reconciled");
        expect(store.getAsfRun(runId)).toMatchObject({
          state: "NEEDS_SPEC",
          generation: 2,
          ownerId: secondWorker,
        });
        expect(store.getLatestAsfCheckpoint(runId)).toEqual(
          repositoryCheckpoint,
        );
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("finishes an exact pending terminal record on SQLite restart before ordinary recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-terminal-restart-"));
    const databasePath = join(directory, "runmill.db");
    const clock = new FakeClock(NOW);
    const fixture = fixtureAdmission();
    const test = harness();
    const runId = "run-terminal-restart";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let store = StateStore.open(databasePath, { clock });
    try {
      store.admitAsfWorkOrder({
        runId,
        envelope: fixture.envelope,
        canonicalEnvelope: fixture.admission.canonicalEnvelope,
        envelopeDigest: fixture.admission.envelopeDigest,
        payloadDigest: fixture.admission.payloadDigest,
        effectivePolicy: fixture.policy,
      });
      expect(
        store.claimAsfRun({
          runId,
          ownerId: WORKER_ID,
          staleBefore: "2026-08-21T09:59:00.000Z",
        }),
      ).toEqual({ generation: 1, takeover: false });
      const recovery = {
        async observe({
          checkpoint,
          binding,
          workerId,
        }: Parameters<AsfPrDeliveryRunnerOptions["recovery"]["observe"]>[0]) {
          const observedAt = clock.now();
          return {
            schema: ASF_RECOVERY_REQUEST_SCHEMA,
            requesting_worker_id: workerId,
            checkpoint,
            checkpoint_observation: {
              state: "verified",
              checkpoint_digest: checkpoint.checkpoint_digest,
              observed_at: observedAt.toISOString(),
              valid_until: new Date(
                observedAt.getTime() + 60_000,
              ).toISOString(),
              evidence_digest: EVIDENCE_DIGEST,
            },
            ownership: {
              state: "current",
              run_id: binding.runId,
              work_order_id: binding.workOrderId,
              attempt_id: binding.attemptId,
              worker_id: workerId,
              fencing_generation: binding.fencingGeneration,
              observed_at: observedAt.toISOString(),
              valid_until: new Date(
                observedAt.getTime() + 60_000,
              ).toISOString(),
              evidence_digest: EVIDENCE_DIGEST,
            },
            remote_observations: [],
            replay_requested: false,
            actor: { role: "orchestrator", mode: "automatic" },
          };
        },
        async apply({
          plan,
          checkpoint,
          binding,
        }: Parameters<AsfPrDeliveryRunnerOptions["recovery"]["apply"]>[0]) {
          const completed = [...plan.requiredTakeoverFencing];
          const invalidated = [...plan.invalidatedEvidence];
          return {
            schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
            binding: bindingWire(binding),
            checkpoint_digest: checkpoint.checkpoint_digest,
            action: plan.action,
            completed_takeover_fencing: completed,
            invalidated_evidence: invalidated,
            acknowledgement_digest: sha256Digest({
              checkpoint_digest: checkpoint.checkpoint_digest,
              action: plan.action,
              completed_takeover_fencing: completed,
              invalidated_evidence: invalidated,
            }),
          };
        },
      } satisfies AsfPrDeliveryRunnerOptions["recovery"];
      const signingKey = {
        keyId: "terminal-restart-key",
        privateKey,
        publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
      };
      const firstOptions: AsfPrDeliveryRunnerOptions = {
        ...test.runnerOptions,
        store,
        intents: new StateStoreAsfDeliveryIntentStore(store, WORKER_ID),
        recovery,
        terminalEvidence:
          new ProductionAsfTerminalEvidenceFinalizationController({
            signingKey,
            clock,
          }),
        clock,
      };
      const firstContext: AsfRunnerContext = {
        runId,
        generation: 1,
        takeover: false,
        signal: new AbortController().signal,
        transition: (input) => {
          if (input.to === "REPOSITORY_LEASED") {
            throw new AsfDeliveryStop({
              phase: "FAILED",
              code: "INTERNAL_DELIVERY_FAILURE",
              summary: "simulated failure before repository transition",
              retryDisposition: "reconcile-first",
              requiredActor: "platform-operator",
              requiredAction: "inspect the protected repository failure",
            });
          }
          if (input.to === "FAILED") {
            throw new Error("simulated crash after terminal evidence commit");
          }
          return store.transitionAsfRun({
            ...input,
            runId,
            ownerId: WORKER_ID,
            generation: 1,
          });
        },
      };

      let firstError: unknown;
      try {
        await new AsfPrDeliveryRunner(firstOptions).run(firstContext);
      } catch (error) {
        firstError = error;
      }
      expect(firstError).toBeInstanceOf(AsfPendingTerminalEvidenceRetryError);
      expect(store.getAsfRun(runId)).toMatchObject({
        state: "ADMITTED",
        stateVersion: 1,
      });
      const pending = store.getAsfTerminalEvidenceBundleRecord(runId);
      expect(
        pending,
        firstError instanceof Error ? String(firstError.cause) : undefined,
      ).toMatchObject({
        terminalPhase: "FAILED",
        terminalEventSeq: 2,
        candidateSha: null,
      });
      store.close();

      store = StateStore.open(databasePath, { clock });
      const recoveryCallsBeforeRestart = test.log.filter((entry) =>
        entry.startsWith("recovery-dispatch:"),
      ).length;
      const secondOptions: AsfPrDeliveryRunnerOptions = {
        ...firstOptions,
        store,
        intents: new StateStoreAsfDeliveryIntentStore(store, WORKER_ID),
      };
      const secondContext: AsfRunnerContext = {
        runId,
        generation: 1,
        takeover: false,
        signal: new AbortController().signal,
        transition: (input) =>
          store.transitionAsfRun({
            ...input,
            runId,
            ownerId: WORKER_ID,
            generation: 1,
          }),
      };
      await new AsfPrDeliveryRunner(secondOptions).run(secondContext);

      expect(store.getAsfRun(runId)).toMatchObject({
        state: "FAILED",
        stateVersion: 2,
      });
      expect(store.getLatestAsfCheckpoint(runId)).toMatchObject({
        checkpoint_kind: "lease-release-workspace-cleanup",
        event_seq: 2,
        phase: "FAILED",
      });
      expect(
        test.log.filter((entry) => entry.startsWith("recovery-dispatch:"))
          .length,
      ).toBe(recoveryCallsBeforeRestart);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("re-establishes identity-stage prerequisites under the takeover fence before workspace", async () => {
    const test = harness();
    const crash = new AbortController();
    await expect(
      new AsfPrDeliveryRunner(test.runnerOptions).run({
        ...test.context,
        signal: crash.signal,
        transition: (input) => {
          const event = test.store.transition(input);
          if (input.eventType === "identity.leases_acquired") {
            crash.abort(new Error("simulated crash after identity checkpoint"));
          }
          return event;
        },
      }),
    ).rejects.toThrow("simulated crash after identity checkpoint");
    const checkpoint = test.store.checkpoints.at(-1);
    if (checkpoint?.checkpoint_kind !== "identity-lease-acquisition") {
      throw new Error("identity recovery fixture lacks its checkpoint");
    }
    test.store.run = {
      ...test.store.run,
      generation: checkpoint.fencing_generation + 1,
      ownerId: WORKER_ID,
    };
    test.log.length = 0;
    test.runnerOptions.recovery.observe = async ({ binding }) => ({
      schema: ASF_RECOVERY_REQUEST_SCHEMA,
      requesting_worker_id: WORKER_ID,
      checkpoint,
      checkpoint_observation: {
        state: "verified",
        checkpoint_digest: checkpoint.checkpoint_digest,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      ownership: {
        state: "current",
        run_id: binding.runId,
        work_order_id: binding.workOrderId,
        attempt_id: binding.attemptId,
        worker_id: WORKER_ID,
        fencing_generation: binding.fencingGeneration,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      remote_observations: checkpoint.reconciliation_markers.map((marker) => ({
        observation: marker.observation,
        state: "confirmed" as const,
        run_id: checkpoint.run_id,
        work_order_id: checkpoint.work_order_id,
        attempt_id: checkpoint.attempt_id,
        policy_digest: checkpoint.policy_digest,
        candidate_sha: checkpoint.candidate_sha,
        correlation_marker: marker.correlation_marker,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      })),
      replay_requested: false,
      actor: { role: "orchestrator", mode: "automatic" },
    });
    test.runnerOptions.recovery.apply = async ({ plan, binding }) => {
      const completed = [...plan.requiredTakeoverFencing];
      const invalidated = [...plan.invalidatedEvidence];
      return {
        schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
        binding: bindingWire(binding),
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
        acknowledgement_digest: sha256Digest({
          checkpoint_digest: checkpoint.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing: completed,
          invalidated_evidence: invalidated,
        }),
      };
    };
    const dispatch = test.runnerOptions.recoveryDispatch.dispatch.bind(
      test.runnerOptions.recoveryDispatch,
    );
    let required: readonly string[] = [];
    test.runnerOptions.recoveryDispatch.dispatch = async (input) => {
      required = input.requiredPrerequisites;
      return dispatch(input);
    };
    test.runnerOptions.workspace.prepare = async () => {
      test.log.push("workspace:after-recovery-dispatch");
      throw new AsfDeliveryStop({
        phase: "NEEDS_SPEC",
        code: "RECOVERY_WORKSPACE_TEST_STOP",
        summary: "stop after proving recovery dispatch ordering",
        retryDisposition: "new-attempt-required",
        requiredActor: "platform-operator",
        requiredAction: "end the recovery dispatch fixture",
      });
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run({
      ...test.context,
      generation: checkpoint.fencing_generation + 1,
      takeover: true,
      signal: new AbortController().signal,
    });

    expect(required).toEqual(["repository-lease", "identity-leases"]);
    expect(test.log[0]).toBe("recovery-dispatch:continue-after-reconciliation");
    expect(test.log).toContain("workspace:after-recovery-dispatch");
    expect(test.store.run.state).toBe("NEEDS_SPEC");
    expect(test.store.getLatestAsfCheckpoint(test.store.run.runId)).toEqual(
      checkpoint,
    );
  });

  it("refuses a later-phase takeover before advancing when prerequisite proof is incomplete", async () => {
    const test = harness();
    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);
    const checkpointIndex = test.store.checkpoints.findIndex(
      (item) => item.checkpoint_kind === "candidate-commit-creation",
    );
    const checkpoint = test.store.checkpoints[checkpointIndex];
    if (checkpoint === undefined) {
      throw new Error(
        "later-phase recovery fixture lacks candidate checkpoint",
      );
    }
    test.store.checkpoints.splice(checkpointIndex + 1);
    test.store.events.splice(checkpoint.event_seq);
    test.store.run = {
      ...test.store.run,
      state: "CANDIDATE_READY",
      stateVersion: checkpoint.event_seq,
      candidateSha: checkpoint.candidate_sha,
      generation: checkpoint.fencing_generation + 1,
      ownerId: WORKER_ID,
    };
    test.store.evidence = undefined;
    test.store.terminalEvidence = undefined;
    test.store.terminalBundle = undefined;
    test.store.terminalPlan = undefined;
    test.store.terminalPlanRecord = undefined;
    test.store.terminalIntent = undefined;
    test.store.terminalIntentRecord = undefined;
    test.log.length = 0;
    test.runnerOptions.recovery.observe = async ({ binding }) => ({
      schema: ASF_RECOVERY_REQUEST_SCHEMA,
      requesting_worker_id: WORKER_ID,
      checkpoint,
      checkpoint_observation: {
        state: "verified",
        checkpoint_digest: checkpoint.checkpoint_digest,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      ownership: {
        state: "current",
        run_id: binding.runId,
        work_order_id: binding.workOrderId,
        attempt_id: binding.attemptId,
        worker_id: WORKER_ID,
        fencing_generation: binding.fencingGeneration,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      remote_observations: [],
      replay_requested: false,
      actor: { role: "orchestrator", mode: "automatic" },
    });
    test.runnerOptions.recovery.apply = async ({ plan, binding }) => {
      const completed = [...plan.requiredTakeoverFencing];
      const invalidated = [...plan.invalidatedEvidence];
      return {
        schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
        binding: bindingWire(binding),
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
        acknowledgement_digest: sha256Digest({
          checkpoint_digest: checkpoint.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing: completed,
          invalidated_evidence: invalidated,
        }),
      };
    };
    const dispatch = test.runnerOptions.recoveryDispatch.dispatch.bind(
      test.runnerOptions.recoveryDispatch,
    );
    let required: readonly string[] = [];
    test.runnerOptions.recoveryDispatch.dispatch = async (input) => {
      required = input.requiredPrerequisites;
      const valid = (await dispatch(input)) as Record<string, unknown>;
      return {
        ...valid,
        reestablished_prerequisites: ["repository-lease", "identity-leases"],
        durable_dispatch_record_digest: EVIDENCE_DIGEST,
      };
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run({
      ...test.context,
      generation: checkpoint.fencing_generation + 1,
      takeover: true,
      signal: new AbortController().signal,
    });

    expect(required).toEqual([
      "repository-lease",
      "identity-leases",
      "workspace",
    ]);
    expect(test.log).not.toContain("effect:local-verification");
    expect(test.store.run.state).toBe("QUARANTINED");
  });

  it("restricts an intent from a prior generation to reconciliation-only", async () => {
    const test = harness();
    let observedMode: string | undefined;
    const priorGenerationIntents: AsfDeliveryIntentStore = {
      record(intent) {
        const { intent_digest: _digest, ...unsigned } = intent;
        const priorUnsigned = {
          ...unsigned,
          intent_id: "delivery-prior-generation",
          fencing_generation: intent.fencing_generation - 1,
        };
        return {
          intent: {
            ...priorUnsigned,
            intent_digest: sha256Digest(priorUnsigned),
          },
          disposition: "existing-prior-generation",
        };
      },
      confirm() {
        throw new Error(
          "unfinished prior intent must not be confirmed in this refusal path",
        );
      },
      prepareTerminal() {
        throw new Error("terminal cleanup is not reached in this refusal path");
      },
      sealTerminal() {
        throw new Error("terminal cleanup is not reached in this refusal path");
      },
    };
    const options: AsfPrDeliveryRunnerOptions = {
      ...test.runnerOptions,
      intents: priorGenerationIntents,
      repositoryLease: {
        async acquire(input) {
          observedMode = input.intentMode;
          throw new AsfDeliveryStop({
            phase: "BLOCKED_EXTERNAL",
            code: "PRIOR_EFFECT_NOT_APPLIED",
            summary: "the prior intent is not proven applied",
            retryDisposition: "reconcile-first",
            requiredActor: "platform-operator",
            requiredAction:
              "reconcile the protected intent before authorizing replay",
          });
        },
      },
    };

    await new AsfPrDeliveryRunner(options).run(test.context);

    expect(observedMode).toBe("reconcile-only");
    expect(test.store.run.state).toBe("BLOCKED_EXTERNAL");
  });

  it("invokes exactly once when the durable store returns bounded replay authority", async () => {
    const test = harness();
    let observedMode: string | undefined;
    let replayGrantConsumed = false;
    const replayAuthorizedIntents: AsfDeliveryIntentStore = {
      record(intent) {
        if (intent.stage !== "repository-lease") {
          return { intent, disposition: "created" };
        }
        const { intent_digest: _digest, ...unsigned } = intent;
        const priorUnsigned = {
          ...unsigned,
          intent_id: "delivery-prior-not-applied",
          fencing_generation: intent.fencing_generation - 1,
        };
        const prior = {
          ...priorUnsigned,
          intent_digest: sha256Digest(priorUnsigned),
        };
        if (replayGrantConsumed) {
          return { intent: prior, disposition: "existing-prior-generation" };
        }
        replayGrantConsumed = true;
        return {
          intent: prior,
          disposition: "existing-prior-generation-replay-authorized",
        };
      },
      confirm() {
        // The fake models the store's durable confirmation after application.
      },
      prepareTerminal: test.intents.prepareTerminal.bind(test.intents),
      sealTerminal: test.intents.sealTerminal.bind(test.intents),
    };
    const acquire = test.runnerOptions.repositoryLease.acquire.bind(
      test.runnerOptions.repositoryLease,
    );
    const options: AsfPrDeliveryRunnerOptions = {
      ...test.runnerOptions,
      intents: replayAuthorizedIntents,
      repositoryLease: {
        async acquire(input) {
          observedMode = input.intentMode;
          return acquire(input);
        },
      },
    };

    await new AsfPrDeliveryRunner(options).run(test.context);

    expect(observedMode).toBe("observe-before-apply");
    expect(replayGrantConsumed).toBe(true);
    expect(test.store.run.state).toBe("COMPLETED");
  });

  it("restarts a reviewer with fresh context when checkpoint recovery authorizes replay", async () => {
    const test = harness();
    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);
    const checkpointIndex = test.store.checkpoints.findIndex(
      (checkpoint) =>
        checkpoint.checkpoint_kind === "local-review-fixer-iteration" &&
        checkpoint.candidate_sha === CANDIDATE_1,
    );
    const checkpoint = test.store.checkpoints[checkpointIndex];
    if (checkpoint === undefined)
      throw new Error("test local-review checkpoint missing");
    const priorLocalInvocationId = test.reviewInputs.find(
      (input) =>
        input.reviewKind === "local" && input.candidateSha === CANDIDATE_1,
    )?.invocationId;
    test.store.checkpoints.splice(checkpointIndex + 1);
    test.store.events.splice(checkpoint.event_seq);
    test.store.run = {
      ...test.store.run,
      state: "LOCAL_REVIEW",
      stateVersion: checkpoint.event_seq,
      candidateSha: CANDIDATE_1,
      generation: 8,
      ownerId: WORKER_ID,
    };
    test.store.evidence = undefined;
    test.store.terminalEvidence = undefined;
    test.store.terminalBundle = undefined;
    test.store.terminalPlan = undefined;
    test.store.terminalPlanRecord = undefined;
    test.store.terminalIntent = undefined;
    test.store.terminalIntentRecord = undefined;
    test.log.length = 0;
    test.reviewInputs.length = 0;
    test.runnerOptions.recovery.observe = async ({
      checkpoint: observed,
      binding,
    }) => ({
      schema: ASF_RECOVERY_REQUEST_SCHEMA,
      requesting_worker_id: WORKER_ID,
      checkpoint: observed,
      checkpoint_observation: {
        state: "verified",
        checkpoint_digest: observed.checkpoint_digest,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      ownership: {
        state: "current",
        run_id: binding.runId,
        work_order_id: binding.workOrderId,
        attempt_id: binding.attemptId,
        worker_id: WORKER_ID,
        fencing_generation: binding.fencingGeneration,
        observed_at: NOW,
        valid_until: LATER,
        evidence_digest: EVIDENCE_DIGEST,
      },
      remote_observations: [],
      replay_requested: true,
      actor: { role: "local-reviewer", mode: "fresh" },
    });
    test.runnerOptions.recovery.apply = async ({
      plan,
      checkpoint: recovered,
      binding,
    }) => {
      test.log.push(`recovery:${plan.action}`);
      const completed = [...plan.requiredTakeoverFencing];
      const invalidated = [...plan.invalidatedEvidence];
      return {
        schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
        binding: bindingWire(binding),
        checkpoint_digest: recovered.checkpoint_digest,
        action: plan.action,
        completed_takeover_fencing: completed,
        invalidated_evidence: invalidated,
        acknowledgement_digest: sha256Digest({
          checkpoint_digest: recovered.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing: completed,
          invalidated_evidence: invalidated,
        }),
      };
    };
    const resumedContext: AsfRunnerContext = {
      ...test.context,
      generation: 8,
      takeover: false,
    };

    await new AsfPrDeliveryRunner(test.runnerOptions).run(resumedContext);

    expect(test.store.run.state).toBe("COMPLETED");
    expect(test.log[0]).toBe("recovery:restart-reviewer-fresh");
    expect(test.reviewInputs[0]).toMatchObject({
      reviewKind: "local",
      candidateSha: CANDIDATE_1,
      session: { mode: "fresh" },
    });
    expect(test.reviewInputs[0]?.invocationId).toMatch(
      /^review_[a-f0-9]{32}$/u,
    );
    expect(test.reviewInputs[0]?.invocationId).not.toBe(priorLocalInvocationId);
  });

  it("fails closed before a controller call when the durable checkpoint candidate is stale", async () => {
    const test = harness();
    test.store.run = {
      ...test.store.run,
      state: "DELIVERY_READY",
      candidateSha: CANDIDATE_2,
    };
    test.store.events.push(
      parseRunEvent({
        schema: "asf.run-event/v1",
        event_id: "evt-current-candidate",
        run_id: test.store.run.runId,
        work_order_id: test.store.admission.workOrderId,
        attempt_id: test.store.admission.attemptId,
        seq: 1,
        occurred_at: NOW,
        type: "candidate.created",
        phase: "CANDIDATE_READY",
        payload: {
          candidate_sha: CANDIDATE_2,
          parent_sha: CANDIDATE_1,
          tree_digest: TREE_DIGEST,
        },
        policy_digest: test.store.admission.effectivePolicyDigest,
      }),
    );
    const policy = getAsfCheckpointRecoveryPolicy(
      "local-review-fixer-iteration",
    );
    test.store.checkpoints.push(
      createDurableAsfCheckpoint({
        schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
        checkpoint_id: "cp-stale-review",
        checkpoint_kind: "local-review-fixer-iteration",
        run_id: test.store.run.runId,
        work_order_id: test.store.admission.workOrderId,
        attempt_id: test.store.admission.attemptId,
        phase: "LOCAL_REVIEW",
        event_seq: 1,
        fencing_generation: test.store.run.generation,
        policy_digest: test.store.admission.effectivePolicyDigest,
        candidate_sha: CANDIDATE_1,
        candidate_lineage_digest: EVIDENCE_DIGEST,
        durable_inputs_digest: EVIDENCE_DIGEST,
        durable_outputs_digest: EVIDENCE_DIGEST,
        replay_policy: policy.replayPolicy,
        reconciliation_markers: [],
        protected_implementer_resume: null,
        created_at: NOW,
      }),
    );

    await new AsfPrDeliveryRunner(test.runnerOptions).run(test.context);

    expect(test.store.run.state).toBe("QUARANTINED");
    expect(
      test.log.some(
        (entry) => entry.startsWith("effect:") && entry !== "effect:cleanup",
      ),
    ).toBe(false);
  });

  it("does not convert an ownership abort into a stop event", async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort(new Error("fenced by generation 8"));
    const context: AsfRunnerContext = {
      ...test.context,
      signal: controller.signal,
    };

    await expect(
      new AsfPrDeliveryRunner(test.runnerOptions).run(context),
    ).rejects.toThrow("fenced by generation 8");
    expect(test.store.run.state).toBe("ADMITTED");
    expect(test.log).toEqual([]);
  });
});
