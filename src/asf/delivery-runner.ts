import { z } from "zod";
import type {
  AsfProviderResult,
  TrustedImplementerResumeDescriptor,
  TrustedProviderExecution,
} from "../agent/trusted-harness.js";
import {
  ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA,
  parseAsfProviderResult,
} from "../agent/trusted-harness.js";
import type { Clock } from "../platform/clock.js";
import type {
  AsfAtomicCheckpointInput,
  AsfDurableRunSnapshot,
  AsfEventPage,
  AsfEvidenceBundleRecord,
  AsfTerminalEvidenceBundleRecord,
  AsfTerminalEvidenceIntentRecord,
  AsfTerminalEvidencePlanRecord,
  StoredAsfDeliveryStageIntent,
  StateStore,
} from "../state/store.js";
import type { ArtifactVerifiedAsfEvidenceBundle } from "../evidence/asf-validator.js";
import {
  ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
  asfTerminalEvidencePlanSchema,
  portableAsfTerminalProviderBudgetEvidence,
  type AsfTerminalCleanupObservation,
  type AsfTerminalEvidenceIntent,
  type AsfTerminalEvidencePlan,
} from "../evidence/asf-terminal.js";
import type {
  AsfTerminalEvidenceFinalizationController,
  AsfTerminalStopEvidence,
} from "./terminal-evidence-finalizer.js";
import {
  CANDIDATE_CHANGE_INVALIDATES,
  ASF_CHECKPOINT_KINDS,
  ASF_EVIDENCE_CLASSES,
  ASF_DURABLE_CHECKPOINT_SCHEMA,
  AuthorizedImplementerResume,
  createDurableAsfCheckpoint,
  getAsfCheckpointRecoveryPolicy,
  parseDurableAsfCheckpoint,
  protectedImplementerResumeMetadataSchema,
  planAsfCheckpointRecovery,
  type AsfCheckpointKind,
  type AsfCheckpointRecoveryPlan,
  type AsfEvidenceClass,
  type DurableAsfCheckpoint,
  type ProtectedImplementerResumeMetadata,
} from "./checkpoint-policy.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "./canonical-json.js";
import {
  ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA,
  asfProviderInvocationId,
  type AsfProviderBudgetAllowance,
  type AsfProviderBudgetCompletion,
  type AsfProviderBudgetController,
  type AsfProviderBudgetExhaustionReason,
  type AsfProviderBudgetRole,
} from "./budget.js";
import {
  ASF_REQUIRED_IDENTITY_ROLES,
  asfIdentityLeaseAttributionSchema,
  assertIdentityLeaseAttribution,
  identityAttributionsDigest,
  type AsfIdentityLeaseAttribution,
} from "./identity-attribution.js";
import {
  ASF_FINAL_PR_DELIVERY_OBSERVATION_SCHEMA,
  parseFinalPullRequestDeliveryObservation,
  type AsfGitHubEffectsController,
  type ConfirmedBranchEffect,
  type ConfirmedPullRequestEffect,
} from "./github-effects.js";
import {
  isTerminalRunEventPhase,
  type RunEvent,
  type RunEventPhase,
} from "./run-event.js";
import {
  AsfPendingCiRetryError,
  AsfPendingTerminalEvidenceRetryError,
  type AsfRunner,
  type AsfRunnerContext,
} from "./service.js";
import {
  evaluateEffectivePathScope,
  parseWorkOrderEnvelope,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "./work-order.js";

export const ASF_DELIVERY_STAGE_INTENT_SCHEMA =
  "asf.delivery-stage-intent/v1" as const;
export const ASF_DELIVERY_RECOVERY_ACK_SCHEMA =
  "asf.delivery-recovery-ack/v1" as const;
export const ASF_DELIVERY_RECOVERY_DISPATCH_SCHEMA =
  "asf.delivery-recovery-dispatch/v1" as const;
export const ASF_CANDIDATE_INVALIDATION_ACK_SCHEMA =
  "asf.candidate-invalidation-ack/v1" as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );
const branchRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u);

export const ASF_DELIVERY_STAGES = [
  "repository-lease",
  "identity-leases",
  "workspace",
  "task-packet",
  "implementer-session",
  "candidate",
  "local-verification",
  "local-review",
  "candidate-invalidation",
  "branch-push",
  "pull-request",
  "ci",
  "pull-request-review",
  "evidence",
  "cleanup",
] as const;

export type AsfDeliveryStage = (typeof ASF_DELIVERY_STAGES)[number];

const deliveryStageIntentSchema = z
  .object({
    schema: z.literal(ASF_DELIVERY_STAGE_INTENT_SCHEMA),
    intent_id: identifierSchema,
    intent_digest: digestSchema,
    effect_key: identifierSchema,
    stage: z.enum(ASF_DELIVERY_STAGES),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    candidate_sha: gitShaSchema.nullable(),
    event_seq: z.number().int().positive(),
    operation_digest: digestSchema,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

function portableDeliveryStageIntent(
  stored: StoredAsfDeliveryStageIntent,
): AsfDeliveryStageIntent {
  return deliveryStageIntentSchema.parse({
    schema: stored.schema,
    intent_id: stored.intent_id,
    intent_digest: stored.intent_digest,
    effect_key: stored.effect_key,
    stage: stored.stage,
    run_id: stored.run_id,
    work_order_id: stored.work_order_id,
    attempt_id: stored.attempt_id,
    policy_digest: stored.policy_digest,
    fencing_generation: stored.fencing_generation,
    candidate_sha: stored.candidate_sha,
    event_seq: stored.event_seq,
    operation_digest: stored.operation_digest,
    created_at: stored.created_at,
  });
}

export interface AsfDeliveryBinding {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly fencingGeneration: number;
  readonly candidateSha: string | null;
}

export interface AsfDeliveryStageIntent {
  readonly schema: typeof ASF_DELIVERY_STAGE_INTENT_SCHEMA;
  readonly intent_id: string;
  readonly intent_digest: string;
  /** Stable across ownership generations for reconciliation lookup. */
  readonly effect_key: string;
  readonly stage: AsfDeliveryStage;
  readonly run_id: string;
  readonly work_order_id: string;
  readonly attempt_id: string;
  readonly policy_digest: string;
  readonly fencing_generation: number;
  readonly candidate_sha: string | null;
  readonly event_seq: number;
  readonly operation_digest: string;
  readonly created_at: string;
}

export interface AsfDeliveryIntentRecordResult {
  readonly intent: AsfDeliveryStageIntent;
  readonly disposition:
    | "created"
    | "existing-current"
    | "existing-prior-generation"
    | "existing-prior-generation-replay-authorized";
}

/**
 * Protected durable write boundary for lifecycle effects not represented by
 * the GitHub effect table. Implementations must reject a conflicting intent
 * id and retain an unfinished intent for reconciliation after a crash.
 */
export interface AsfDeliveryIntentStore {
  record(intent: AsfDeliveryStageIntent): AsfDeliveryIntentRecordResult;
  confirm(input: {
    readonly intentId: string;
    readonly intentDigest: string;
    readonly observationDigest: string;
    readonly binding: AsfDeliveryBinding;
  }): void;
  prepareTerminal(input: {
    readonly intent: AsfDeliveryStageIntent;
    readonly plan: AsfTerminalEvidencePlan;
  }): AsfDeliveryIntentRecordResult & {
    readonly plan: AsfTerminalEvidencePlanRecord;
  };
  sealTerminal(input: {
    readonly runId: string;
    readonly planDigest: string;
    readonly cleanupObservation: AsfTerminalCleanupObservation;
    readonly generation: number;
  }): {
    readonly record: AsfTerminalEvidenceIntentRecord;
    readonly intent: AsfTerminalEvidenceIntent;
    readonly created: boolean;
  };
}

export type AsfDeliveryRunnerStore = Pick<
  StateStore,
  | "getAsfRunSnapshot"
  | "getLatestAsfCheckpoint"
  | "recordAsfCheckpoint"
  | "listAsfRunEvents"
  | "recordAsfEvidenceBundle"
  | "getAsfEvidenceBundleRecord"
  | "recordAsfTerminalEvidenceBundle"
  | "getAsfTerminalEvidencePlanRecord"
  | "getAsfTerminalEvidencePlan"
  | "getAsfTerminalEvidenceIntentRecord"
  | "getAsfTerminalEvidenceIntent"
  | "getAsfTerminalEvidenceBundleRecord"
  | "getAsfTerminalEvidenceBundle"
  | "getAsfDeliveryIntentById"
  | "prepareAsfTerminalProviderBudgetEvidence"
  | "prepareAsfTerminalEffectLedger"
>;

export interface AsfRecoveryController {
  /** Return only current observations in the strict checkpoint-policy request shape. */
  observe(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly workerId: string;
    readonly takeover: boolean;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  /**
   * Apply the already-authorized plan. This controller owns fencing and local
   * invalidation; its external adapters may only supply observations.
   */
  apply(input: {
    readonly plan: AsfCheckpointRecoveryPlan;
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export const ASF_RECOVERY_PREREQUISITES = [
  "repository-lease",
  "identity-leases",
  "workspace",
] as const;

export type AsfRecoveryPrerequisite =
  (typeof ASF_RECOVERY_PREREQUISITES)[number];

/**
 * Protected controller seam for the resource work authorized by a recovery
 * plan. The runner never advances past a replayed or takeover checkpoint on
 * the strength of plan flags alone: this controller must re-establish every
 * phase prerequisite under the current fence and, for replay-stage, dispatch
 * the recovered checkpoint's stage itself.
 */
export interface AsfRecoveryDispatchController {
  /**
   * Must durably and idempotently bind the result to checkpoint + recovery
   * acknowledgement + current fence before returning. Repeating an exact
   * call after a crash must load the same record, never re-apply an effect.
   */
  dispatch(input: {
    readonly plan: AsfCheckpointRecoveryPlan;
    readonly checkpoint: DurableAsfCheckpoint;
    readonly recoveryAcknowledgementDigest: string;
    readonly binding: AsfDeliveryBinding;
    readonly requiredPrerequisites: readonly AsfRecoveryPrerequisite[];
    readonly replayCheckpointStage: boolean;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface AsfRepositoryLeaseController {
  acquire(input: AsfEffectInput): Promise<unknown>;
}

export interface AsfIdentityController {
  acquireRequiredRoles(input: AsfEffectInput): Promise<unknown>;
}

export interface AsfWorkspaceController {
  prepare(
    input: AsfEffectInput & {
      readonly baseSha: string;
      readonly sandboxProfile: string;
    },
  ): Promise<unknown>;
  observeCurrent(input: {
    readonly binding: AsfDeliveryBinding;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface AsfTaskPacketController {
  create(
    input: AsfEffectInput & {
      readonly envelope: WorkOrderEnvelope;
      readonly effectivePolicy: EffectiveAsfPolicy;
    },
  ): Promise<unknown>;
}

export interface AsfImplementationController {
  markSession(
    input: AsfEffectInput & {
      readonly taskPacketDigest: string;
      readonly startingSha: string;
      readonly session: { readonly mode: "fresh" };
    },
  ): Promise<unknown>;
  /**
   * Read-only protected-state lookup. Implementations must derive this public
   * descriptor from the exact AuthorizedImplementerResume and must not expose
   * its protected resolver reference, lease handle, or provider capability.
   */
  describeAuthorizedResume?(input: {
    readonly authorization: AuthorizedImplementerResume;
    readonly binding: AsfDeliveryBinding;
    readonly taskPacketDigest: string;
    readonly startingSha: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  createCandidate(
    input: AsfEffectInput & {
      readonly taskPacketDigest: string;
      readonly startingSha: string;
      readonly mode: "implement" | "fix";
      readonly iteration: number;
      readonly invocationId: string;
      readonly providerBudget: AsfProviderBudgetAllowance;
      readonly session:
        | { readonly mode: "fresh" }
        | {
            readonly mode: "resume";
            readonly authorization: AuthorizedImplementerResume;
            readonly descriptorDigest: string;
          };
    },
  ): Promise<unknown>;
  /**
   * Persist a harness-issued resume capability in protected controller state
   * and return only its exact checkpoint metadata. Returning null is valid
   * only when the provider execution did not advertise a resume capability.
   */
  captureProtectedResume(input: {
    readonly execution: TrustedProviderExecution;
    readonly binding: AsfDeliveryBinding;
    readonly implementerAttribution: AsfIdentityLeaseAttribution;
    readonly taskPacketDigest: string;
    readonly startingSha: string;
    readonly checkpointCandidateSha: string;
    readonly candidateLineageDigest: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface AsfLocalVerificationController {
  verify(
    input: AsfEffectInput & {
      readonly candidateSha: string;
      readonly requiredCheckIds: readonly string[];
    },
  ): Promise<unknown>;
}

export interface AsfReviewerController {
  review(
    input: AsfEffectInput & {
      readonly candidateSha: string;
      readonly taskPacketDigest: string;
      readonly reviewKind: "local" | "pull-request";
      readonly reviewerAttribution: string;
      readonly invocationId: string;
      readonly session: { readonly mode: "fresh" };
      readonly providerBudget: AsfProviderBudgetAllowance;
    },
  ): Promise<unknown>;
}

export interface AsfCandidateInvalidationController {
  invalidate(
    input: AsfEffectInput & {
      readonly priorCandidateSha: string;
      readonly candidateSha: string;
      readonly evidenceClasses: readonly AsfEvidenceClass[];
    },
  ): Promise<unknown>;
}

export interface AsfDeliveryProposalController {
  propose(input: {
    readonly binding: AsfDeliveryBinding;
    readonly repository: string;
    readonly baseRef: string;
    readonly draft: boolean;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface AsfCiController {
  observeExactHead(
    input: AsfEffectInput & {
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly candidateSha: string;
      readonly requiredContexts: readonly string[];
    },
  ): Promise<unknown>;
}

export interface AsfEvidenceFinalizationController {
  finalize(
    input: AsfEffectInput & {
      readonly snapshot: AsfDurableRunSnapshot;
      readonly envelope: WorkOrderEnvelope;
      readonly effectivePolicy: EffectiveAsfPolicy;
      readonly events: readonly RunEvent[];
    },
  ): Promise<ArtifactVerifiedAsfEvidenceBundle>;
}

export interface AsfCleanupController {
  cleanup(
    input: AsfEffectInput & {
      readonly terminalOutcome:
        | "completed"
        | "cancelled"
        | "failed"
        | "stopped";
    },
  ): Promise<unknown>;
}

export interface AsfEffectInput {
  readonly binding: AsfDeliveryBinding;
  readonly intent: AsfDeliveryStageIntent;
  /** Existing intents can be observed and confirmed, never blindly re-applied. */
  readonly intentMode: "observe-before-apply" | "reconcile-only";
  readonly signal: AbortSignal;
}

export interface AsfPrDeliveryRunnerOptions {
  readonly store: AsfDeliveryRunnerStore;
  readonly intents: AsfDeliveryIntentStore;
  readonly recovery: AsfRecoveryController;
  readonly recoveryDispatch: AsfRecoveryDispatchController;
  readonly repositoryLease: AsfRepositoryLeaseController;
  readonly identities: AsfIdentityController;
  readonly workspace: AsfWorkspaceController;
  readonly taskPacket: AsfTaskPacketController;
  readonly implementation: AsfImplementationController;
  readonly localVerification: AsfLocalVerificationController;
  readonly reviewer: AsfReviewerController;
  readonly invalidation: AsfCandidateInvalidationController;
  readonly deliveryProposal: AsfDeliveryProposalController;
  readonly github: Pick<
    AsfGitHubEffectsController,
    "ensureBranch" | "ensurePullRequest" | "observeFinalDelivery"
  >;
  readonly ci: AsfCiController;
  readonly evidence: AsfEvidenceFinalizationController;
  readonly terminalEvidence: AsfTerminalEvidenceFinalizationController;
  readonly cleanup: AsfCleanupController;
  readonly budget: AsfProviderBudgetController;
  readonly clock: Clock;
  readonly workerId: string;
  readonly maxEventScan?: number | undefined;
}

export type AsfStructuredStopPhase =
  | "WAITING_APPROVAL"
  | "NEEDS_SPEC"
  | "BLOCKED_EXTERNAL"
  | "BUDGET_EXHAUSTED"
  | "REFUSED"
  | "QUARANTINED"
  | "FAILED";

export interface AsfStructuredStopInput {
  readonly phase: AsfStructuredStopPhase;
  readonly code: string;
  readonly summary: string;
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
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly approvalDecisionType?: string | undefined;
  readonly approvalRequestedEffect?: string | undefined;
}

/** A deliberate, public-safe lifecycle stop requested by a trusted controller. */
export class AsfDeliveryStop extends Error {
  readonly stop: AsfStructuredStopInput;

  constructor(stop: AsfStructuredStopInput) {
    super(stop.summary);
    this.name = "AsfDeliveryStop";
    this.stop = Object.freeze({
      ...stop,
      evidenceRefs: Object.freeze([...(stop.evidenceRefs ?? [])]),
    });
  }
}

const exactBindingSchema = z
  .object({
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    candidate_sha: gitShaSchema.nullable(),
  })
  .strict();

const trustedImplementerResumeDescriptorSchema = z
  .object({
    schema: z.literal(ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA),
    authorization_digest: digestSchema,
    session_identity_digest: digestSchema,
    invocation_id: identifierSchema,
    provider_candidate_sha: gitShaSchema,
    task_packet_digest: digestSchema,
    descriptor_digest: digestSchema,
  })
  .strict();

const observationBase = {
  binding: exactBindingSchema,
  evidence_digest: digestSchema,
};

const repositoryLeaseObservationSchema = z
  .object({
    schema: z.literal("asf.repository-lease-observation/v1"),
    ...observationBase,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    lease_generation: z.number().int().positive(),
  })
  .strict();

const identityObservationSchema = z
  .object({
    schema: z.literal("asf.identity-acquisition-observation/v1"),
    ...observationBase,
    attributions_digest: digestSchema,
    roles: z
      .array(z.enum(ASF_REQUIRED_IDENTITY_ROLES))
      .length(3)
      .refine((roles) => new Set(roles).size === 3),
    attributions: z.array(asfIdentityLeaseAttributionSchema).length(3),
  })
  .strict();

const workspaceObservationSchema = z
  .object({
    schema: z.literal("asf.workspace-observation/v1"),
    ...observationBase,
    workspace_id: identifierSchema,
    workspace_path: z.string().min(1).max(4_096),
    base_sha: gitShaSchema,
    sandbox_profile: identifierSchema,
    isolation_evidence_digest: digestSchema,
  })
  .strict();

const taskPacketObservationSchema = z
  .object({
    schema: z.literal("asf.task-packet-observation/v1"),
    ...observationBase,
    task_packet_digest: digestSchema,
    source_snapshot_digest: digestSchema,
  })
  .strict();

const sessionObservationSchema = z
  .object({
    schema: z.literal("asf.implementer-session-observation/v1"),
    ...observationBase,
    session: z.enum(["new", "resumed"]),
    checkpoint_digest: digestSchema,
    protected_implementer_resume:
      protectedImplementerResumeMetadataSchema.nullable(),
  })
  .strict();

const candidateObservationSchema = z
  .object({
    schema: z.literal("asf.candidate-observation/v1"),
    ...observationBase,
    candidate_sha: gitShaSchema,
    parent_sha: gitShaSchema,
    tree_digest: digestSchema,
    changed_paths: z.array(z.string().min(1).max(4_096)).max(100_000),
    provider_execution: z.custom<TrustedProviderExecution>(),
  })
  .strict();

const checkResultSchema = z
  .object({
    check_id: identifierSchema,
    outcome: z.enum(["passed", "failed", "blocked"]),
    evidence_digest: digestSchema,
  })
  .strict();

const localVerificationObservationSchema = z
  .object({
    schema: z.literal("asf.local-verification-observation/v1"),
    ...observationBase,
    candidate_sha: gitShaSchema,
    checks: z.array(checkResultSchema).max(10_000),
  })
  .strict();

const reviewObservationSchema = z
  .object({
    schema: z.literal("asf.review-observation/v1"),
    ...observationBase,
    candidate_sha: gitShaSchema,
    review_kind: z.enum(["local", "pull-request"]),
    reviewer_attribution: identifierSchema,
    invocation_id: identifierSchema,
    fresh_context: z.literal(true),
    prior_context_restored: z.literal(false),
    outcome: z.enum(["approved", "changes-requested", "blocked"]),
    findings_digest: digestSchema,
    provider_execution: z.custom<TrustedProviderExecution>(),
  })
  .strict();

const invalidationAckSchema = z
  .object({
    schema: z.literal(ASF_CANDIDATE_INVALIDATION_ACK_SCHEMA),
    binding: exactBindingSchema,
    prior_candidate_sha: gitShaSchema,
    candidate_sha: gitShaSchema,
    invalidated_evidence: z.array(z.enum(ASF_EVIDENCE_CLASSES)),
    acknowledgement_digest: digestSchema,
  })
  .strict();

const deliveryProposalSchema = z
  .object({
    schema: z.literal("asf.pull-request-delivery-proposal/v1"),
    binding: exactBindingSchema,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    head_ref: branchRefSchema,
    base_ref: branchRefSchema,
    marker: identifierSchema,
    title: z.string().min(1).max(1_024),
    body: z.string().min(1).max(65_536),
    draft: z.boolean(),
    proposal_digest: digestSchema,
  })
  .strict();

const ciObservationSchema = z
  .object({
    schema: z.literal("asf.ci-head-observation/v1"),
    ...observationBase,
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    pull_request_number: z.number().int().positive(),
    candidate_sha: gitShaSchema,
    observed_head_sha: gitShaSchema,
    observed_at: z.iso.datetime({ offset: true }),
    checks: z.array(
      z
        .object({
          context: z.string().min(1).max(512),
          outcome: z.enum(["passed", "failed", "pending", "not-scheduled"]),
          evidence_digest: digestSchema,
        })
        .strict(),
    ),
  })
  .strict();

type ParsedCiObservation = z.infer<typeof ciObservationSchema>;

interface ExactHeadCiResult {
  readonly intent: AsfDeliveryStageIntent;
  readonly observation: ParsedCiObservation;
  readonly checksDigest: string;
  readonly outcome: "passed" | "failed" | "pending" | "not-scheduled";
}

interface DurableFinalCiSnapshot {
  readonly observationIntentDigest: string;
  readonly observationDigest: string;
  readonly observationFencingGeneration: number;
  readonly checksDigest: string;
  readonly checks: ParsedCiObservation["checks"];
  readonly observedAt: string;
  readonly checkpointedAt: string;
}

const cleanupObservationSchema = z
  .object({
    schema: z.literal("asf.cleanup-observation/v1"),
    ...observationBase,
    identity_leases: z.literal("released"),
    repository_lease: z.literal("released"),
    workspace: z.literal("removed"),
    unresolved_effects: z.literal(0),
  })
  .strict();

const terminalStopPayloadSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    summary: z.string().min(1).max(2_048),
    checkpoint: identifierSchema,
    retry_disposition: z.enum([
      "safe",
      "reconcile-first",
      "new-attempt-required",
      "prohibited",
    ]),
    required_actor: z.enum([
      "asf",
      "repository-owner",
      "platform-operator",
      "security",
      "provider-administrator",
    ]),
    required_action: z.string().min(1).max(2_048),
    evidence_refs: z.array(identifierSchema).max(2_048),
  })
  .passthrough();

const recoveryAckSchema = z
  .object({
    schema: z.literal(ASF_DELIVERY_RECOVERY_ACK_SCHEMA),
    binding: exactBindingSchema,
    checkpoint_digest: digestSchema,
    action: z.enum([
      "continue-from-checkpoint",
      "continue-after-reconciliation",
      "replay-stage",
      "restart-implementer-fresh",
      "resume-implementer",
      "restart-reviewer-fresh",
    ]),
    completed_takeover_fencing: z.array(
      z.enum([
        "fence-prior-worker-generation",
        "abort-prior-provider-and-tool-work",
        "revoke-prior-identity-leases",
        "reconcile-in-flight-external-effects",
      ]),
    ),
    invalidated_evidence: z.array(z.enum(ASF_EVIDENCE_CLASSES)),
    acknowledgement_digest: digestSchema,
  })
  .strict();

const recoveryDispatchObservationSchema = z
  .object({
    schema: z.literal(ASF_DELIVERY_RECOVERY_DISPATCH_SCHEMA),
    binding: exactBindingSchema,
    checkpoint_digest: digestSchema,
    checkpoint_kind: z.enum(ASF_CHECKPOINT_KINDS),
    action: z.enum([
      "continue-from-checkpoint",
      "continue-after-reconciliation",
      "replay-stage",
      "restart-implementer-fresh",
      "resume-implementer",
      "restart-reviewer-fresh",
    ]),
    recovery_acknowledgement_digest: digestSchema,
    required_prerequisites: z.array(z.enum(ASF_RECOVERY_PREREQUISITES)),
    reestablished_prerequisites: z.array(z.enum(ASF_RECOVERY_PREREQUISITES)),
    replayed_checkpoint_stage: z.boolean(),
    identity_attributions: z
      .array(asfIdentityLeaseAttributionSchema)
      .length(3)
      .nullable(),
    durable_dispatch_record_digest: digestSchema,
  })
  .strict();

interface ParsedAdmission {
  readonly snapshot: AsfDurableRunSnapshot;
  readonly envelope: WorkOrderEnvelope;
  readonly policy: EffectiveAsfPolicy;
}

interface RuntimeState {
  latestCheckpoint: DurableAsfCheckpoint;
  fixIterations: number;
  forceFreshLocalReview: boolean;
  forceFreshPullRequestReview: boolean;
  implementationSession:
    | { readonly mode: "fresh" }
    | {
        readonly mode: "resume";
        readonly authorization: AuthorizedImplementerResume;
      };
  protectedImplementerResume: ProtectedImplementerResumeMetadata | null;
  currentIdentityAttributions: readonly AsfIdentityLeaseAttribution[] | null;
  pendingRecoveryDispatch: {
    readonly plan: AsfCheckpointRecoveryPlan;
    readonly recoveryAcknowledgementDigest: string;
  } | null;
}

interface PreparedIntent {
  readonly intent: AsfDeliveryStageIntent;
  readonly mode: AsfEffectInput["intentMode"];
}

type ObservationWithDigest = { readonly evidence_digest: string };

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function exactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((value) => expected.includes(value))
  );
}

function refuse(summary: string, evidenceRefs: readonly string[] = []): never {
  throw new AsfDeliveryStop({
    phase: "QUARANTINED",
    code: "DELIVERY_EVIDENCE_CONTRADICTORY",
    summary,
    retryDisposition: "prohibited",
    requiredActor: "platform-operator",
    requiredAction:
      "inspect protected lifecycle evidence and start a new attempt only after reconciliation",
    evidenceRefs,
  });
}

function assertBinding(
  observed: z.infer<typeof exactBindingSchema>,
  expected: AsfDeliveryBinding,
  label: string,
): void {
  if (
    observed.run_id !== expected.runId ||
    observed.work_order_id !== expected.workOrderId ||
    observed.attempt_id !== expected.attemptId ||
    observed.policy_digest !== expected.policyDigest ||
    observed.fencing_generation !== expected.fencingGeneration ||
    observed.candidate_sha !== expected.candidateSha
  ) {
    refuse(
      `${label} is not exact-bound to the current run, candidate, policy, and fence`,
    );
  }
}

function assertProviderExecution(
  raw: TrustedProviderExecution,
  binding: AsfDeliveryBinding,
  expectedRole: "implementer" | "fixer" | "local-reviewer" | "pr-reviewer",
  expectedCandidate: string,
  expectedInvocationId?: string,
) {
  if (raw === null || typeof raw !== "object" || !("result" in raw)) {
    refuse("trusted provider controller returned no normalized harness result");
  }
  const result = parseAsfProviderResult(raw.result);
  const model = result.model_result;
  if (
    model.status !== "success" ||
    model.binding.run_id !== binding.runId ||
    model.binding.work_order_id !== binding.workOrderId ||
    model.binding.attempt_id !== binding.attemptId ||
    model.binding.policy_digest !== binding.policyDigest ||
    model.binding.fencing_generation !== binding.fencingGeneration ||
    model.binding.candidate_sha !== expectedCandidate ||
    model.binding.role !== expectedRole ||
    (expectedInvocationId !== undefined &&
      model.binding.invocation_id !== expectedInvocationId)
  ) {
    refuse(
      "trusted provider result is stale, unsuccessful, or bound to another invocation",
    );
  }
  return { result, model };
}

function assertIndependentIdentityObservations(
  attributions: z.infer<typeof identityObservationSchema>["attributions"],
  binding: AsfDeliveryBinding,
  policy: EffectiveAsfPolicy,
  clock: Clock,
): void {
  const byRole = new Map(
    attributions.map((attribution) => [attribution.role, attribution]),
  );
  const implementer = byRole.get("implementer");
  const reviewers = [byRole.get("local-reviewer"), byRole.get("pr-reviewer")];
  if (
    implementer === undefined ||
    reviewers.some((attribution) => attribution === undefined)
  ) {
    return refuse(
      "identity observation is missing a required independent role lease",
    );
  }
  const expectedProfiles = {
    implementer: policy.identities.implementer,
    "local-reviewer": policy.identities.localReviewer,
    "pr-reviewer": policy.identities.prReviewer,
  } as const;
  const now = clock.now().getTime();
  const attributionBinding = {
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: null,
  } as const;
  for (const attribution of attributions) {
    try {
      assertIdentityLeaseAttribution(attributionBinding, attribution);
    } catch {
      return refuse(
        "identity lease attribution digest is malformed or contradictory",
      );
    }
    if (
      attribution.profile !== expectedProfiles[attribution.role] ||
      attribution.fencing_generation !== binding.fencingGeneration ||
      Date.parse(attribution.issued_at) > now ||
      Date.parse(attribution.expires_at) <= now
    ) {
      return refuse(
        "identity attributions are stale or not exact-bound to the admitted profiles and fence",
      );
    }
  }
  for (const reviewer of reviewers) {
    if (reviewer === undefined) return refuse("reviewer lease lookup failed");
    if (
      reviewer.provider === implementer.provider &&
      reviewer.principal_id === implementer.principal_id
    ) {
      return refuse(
        `${reviewer.role} resolved to the implementer provider principal; independence is unproven`,
      );
    }
  }
}

function eventTypeForStop(phase: AsfStructuredStopPhase): string {
  switch (phase) {
    case "WAITING_APPROVAL":
      return "run.waiting_approval";
    case "NEEDS_SPEC":
      return "run.needs_spec";
    case "BLOCKED_EXTERNAL":
      return "run.blocked_external";
    case "BUDGET_EXHAUSTED":
      return "budget.exhausted";
    case "REFUSED":
      return "run.refused";
    case "QUARANTINED":
      return "run.quarantined";
    case "FAILED":
      return "run.failed";
  }
}

function isDeliveryStop(error: unknown): error is AsfDeliveryStop {
  return error instanceof AsfDeliveryStop;
}

/**
 * Checkpoint-aware P0 PR delivery orchestrator.
 *
 * This module is deliberately not wired into standalone Runmill. Every
 * production mechanism is an explicit required dependency, so constructing an
 * ASF runner cannot silently fall back to a permissive fake or host process.
 */
export class AsfPrDeliveryRunner {
  readonly #options: AsfPrDeliveryRunnerOptions;
  readonly #maxEventScan: number;

  constructor(options: AsfPrDeliveryRunnerOptions) {
    if (options.workerId.trim() === "")
      throw new Error("ASF delivery worker id is required");
    if (typeof options.recoveryDispatch?.dispatch !== "function") {
      throw new Error(
        "ASF delivery requires a protected durable recovery dispatch controller",
      );
    }
    const maxEventScan = options.maxEventScan ?? 10_000;
    if (
      !Number.isSafeInteger(maxEventScan) ||
      maxEventScan < 1 ||
      maxEventScan > 100_000
    ) {
      throw new Error(
        "ASF delivery event scan limit must be between 1 and 100000",
      );
    }
    this.#options = options;
    this.#maxEventScan = maxEventScan;
  }

  asRunner(): AsfRunner {
    return (context) => this.run(context);
  }

  async run(context: AsfRunnerContext): Promise<void> {
    this.#throwIfAborted(context.signal);
    let parsed: ParsedAdmission;
    try {
      parsed = this.#admission(context);
    } catch (error) {
      await this.#handleError(context, error);
      return;
    }

    // The cleanup authorization and intended terminal outcome are frozen
    // before cleanup. A restart must finish that exact plan before
    // cancellation, recovery, budget checks, or ordinary stage advancement.
    if (
      !isTerminalRunEventPhase(parsed.snapshot.run.state) &&
      this.#options.store.getAsfTerminalEvidencePlanRecord(context.runId) !==
        undefined
    ) {
      try {
        await this.#finishPendingTerminalPlan(context, parsed);
      } catch (error) {
        throw new AsfPendingTerminalEvidenceRetryError(context.runId, error);
      }
      return;
    }

    try {
      if (
        !isTerminalRunEventPhase(parsed.snapshot.run.state) &&
        parsed.snapshot.run.state !== "CANCEL_REQUESTED" &&
        parsed.snapshot.run.state !== "CANCELLING"
      ) {
        this.#assertRunBudget(context, parsed);
      }
    } catch (error) {
      await this.#handleError(context, error);
      return;
    }

    if (
      parsed.snapshot.run.state === "CANCEL_REQUESTED" ||
      parsed.snapshot.run.state === "CANCELLING"
    ) {
      try {
        await this.#finishCancellation(context, parsed);
      } catch (error) {
        await this.#handleError(context, error);
      }
      return;
    }

    let runtime: RuntimeState;
    try {
      runtime = await this.#recover(context, parsed);
      runtime = await this.#dispatchRecovery(context, parsed, runtime);
    } catch (error) {
      await this.#handleError(context, error);
      return;
    }

    for (;;) {
      try {
        this.#throwIfAborted(context.signal);
        parsed = this.#admission(context);
        const phase = parsed.snapshot.run.state as RunEventPhase;

        if (phase === "CANCEL_REQUESTED" || phase === "CANCELLING") {
          await this.#finishCancellation(context, parsed);
          return;
        }
        if (isTerminalRunEventPhase(phase)) {
          await this.#ensureTerminalEvidence(context, parsed, runtime);
          return;
        }
        if (
          phase === "WAITING_APPROVAL" ||
          phase === "NEEDS_SPEC" ||
          phase === "BLOCKED_EXTERNAL"
        ) {
          return;
        }

        this.#assertRunBudget(context, parsed);

        switch (phase) {
          case "ADMITTED":
            runtime.latestCheckpoint = await this.#repositoryLease(
              context,
              parsed,
              runtime,
            );
            break;
          case "REPOSITORY_LEASED":
            runtime.latestCheckpoint = await this.#identities(
              context,
              parsed,
              runtime,
            );
            break;
          case "IDENTITY_READY":
            runtime.latestCheckpoint = await this.#workspace(
              context,
              parsed,
              runtime,
            );
            break;
          case "WORKSPACE_READY":
            runtime.latestCheckpoint = await this.#taskPacket(
              context,
              parsed,
              runtime,
            );
            break;
          case "TASK_PACKET_READY":
            runtime.latestCheckpoint = await this.#startImplementation(
              context,
              parsed,
              runtime,
            );
            break;
          case "IMPLEMENTING":
          case "FIXING":
            runtime.latestCheckpoint = await this.#candidate(
              context,
              parsed,
              runtime,
            );
            break;
          case "CANDIDATE_READY":
            runtime.latestCheckpoint = await this.#localVerification(
              context,
              parsed,
              runtime,
            );
            break;
          case "LOCAL_VERIFY":
            if (
              !this.#checkpointIsCurrent(
                runtime.latestCheckpoint,
                parsed,
                "local-verification-pass",
              )
            ) {
              runtime.latestCheckpoint = await this.#completeLocalVerification(
                context,
                parsed,
                runtime,
              );
              break;
            }
            runtime.latestCheckpoint = await this.#localReview(
              context,
              parsed,
              runtime,
            );
            runtime.forceFreshLocalReview = false;
            break;
          case "LOCAL_REVIEW":
            if (
              runtime.forceFreshLocalReview ||
              !this.#checkpointIsCurrent(
                runtime.latestCheckpoint,
                parsed,
                "local-review-fixer-iteration",
              )
            ) {
              runtime.latestCheckpoint = await this.#completeLocalReview(
                context,
                parsed,
                runtime,
              );
              runtime.forceFreshLocalReview = false;
              break;
            }
            await this.#afterLocalReview(context, parsed, runtime);
            break;
          case "DELIVERY_READY":
            runtime.latestCheckpoint = await this.#push(
              context,
              parsed,
              runtime,
            );
            break;
          case "PUSHED":
            runtime.latestCheckpoint = await this.#pullRequest(
              context,
              parsed,
              runtime,
            );
            break;
          case "PR_OPEN":
            await this.#startCi(context, parsed);
            break;
          case "CI_WAIT":
            if (
              !this.#checkpointIsCurrent(
                runtime.latestCheckpoint,
                parsed,
                "ci-reconciliation-snapshot",
              )
            ) {
              runtime.latestCheckpoint = await this.#completeCi(
                context,
                parsed,
                runtime,
              );
              break;
            }
            {
              const outcome = this.#currentCiOutcome(parsed);
              if (outcome === "pending" || outcome === "not-scheduled") {
                runtime.latestCheckpoint = await this.#completeCi(
                  context,
                  parsed,
                  runtime,
                );
                break;
              }
              if (outcome === "failed") {
                await this.#startFixing(
                  context,
                  parsed,
                  this.#requiredCandidate(parsed),
                  runtime,
                );
                break;
              }
            }
            runtime.latestCheckpoint = await this.#pullRequestReview(
              context,
              parsed,
              runtime,
            );
            runtime.forceFreshPullRequestReview = false;
            break;
          case "PR_REVIEW":
            if (
              runtime.forceFreshPullRequestReview ||
              !this.#checkpointIsCurrent(
                runtime.latestCheckpoint,
                parsed,
                "pr-review-fixer-iteration",
              )
            ) {
              runtime.latestCheckpoint = await this.#completePullRequestReview(
                context,
                parsed,
                runtime,
              );
              runtime.forceFreshPullRequestReview = false;
              break;
            }
            runtime.latestCheckpoint =
              (await this.#afterPullRequestReview(context, parsed, runtime)) ??
              runtime.latestCheckpoint;
            break;
          case "PR_DELIVERED":
            runtime.latestCheckpoint = await this.#evidence(
              context,
              parsed,
              runtime,
            );
            break;
          case "EVIDENCE_FINALIZED":
            runtime.latestCheckpoint = await this.#complete(
              context,
              parsed,
              runtime,
            );
            break;
          case "RECEIVED":
          case "MERGE_QUEUE_WAIT":
          case "MERGE_READY":
          case "MERGED":
            refuse(
              `P0 PR delivery cannot continue from unsupported phase ${phase}`,
            );
            break;
          default:
            refuse(`P0 PR delivery encountered unsupported phase ${phase}`);
        }
      } catch (error) {
        if (context.signal.aborted) throw error;
        await this.#handleError(context, error);
        return;
      }
    }
  }

  #admission(context: AsfRunnerContext): ParsedAdmission {
    const snapshot = this.#options.store.getAsfRunSnapshot(context.runId);
    if (snapshot === undefined)
      throw new Error(`ASF run ${context.runId} disappeared`);
    if (
      snapshot.run.mode !== "asf-worker" ||
      snapshot.run.ownerId !== this.#options.workerId ||
      snapshot.run.generation !== context.generation ||
      snapshot.run.workOrderId !== snapshot.admission.workOrderId ||
      snapshot.run.attemptId !== snapshot.admission.attemptId ||
      snapshot.latestSequence !== snapshot.run.stateVersion
    ) {
      throw new Error(
        "ASF delivery runner lost exact durable ownership or admission binding",
      );
    }
    let rawEnvelope: unknown;
    let rawPolicy: unknown;
    try {
      rawEnvelope = JSON.parse(snapshot.admission.canonicalEnvelope) as unknown;
      rawPolicy = JSON.parse(snapshot.admission.effectivePolicy) as unknown;
    } catch {
      return refuse("immutable ASF admission material is not valid JSON");
    }
    const envelope = parseWorkOrderEnvelope(rawEnvelope);
    const policy = rawPolicy as EffectiveAsfPolicy;
    const { digest: recordedPolicyDigest, ...unsignedPolicy } = policy;
    if (
      canonicalJson(envelope) !== snapshot.admission.canonicalEnvelope ||
      sha256Digest(envelope) !== snapshot.admission.envelopeDigest ||
      sha256Digest(envelope.payload) !== snapshot.admission.payloadDigest ||
      envelope.payload.work_order_id !== snapshot.admission.workOrderId ||
      envelope.payload.attempt_id !== snapshot.admission.attemptId ||
      envelope.payload.repository.repository.toLowerCase() !==
        snapshot.run.repo.toLowerCase() ||
      envelope.payload.repository.base_sha.toLowerCase() !==
        snapshot.run.baseCommit ||
      recordedPolicyDigest !== snapshot.admission.effectivePolicyDigest ||
      sha256Digest(json(unsignedPolicy)) !== recordedPolicyDigest ||
      policy.schema !== "runmill.effective-policy/v1" ||
      policy.delivery?.closureTarget !== "pr"
    ) {
      return refuse("immutable ASF admission material is contradictory");
    }
    return { snapshot, envelope, policy };
  }

  #binding(
    parsed: ParsedAdmission,
    context: AsfRunnerContext,
  ): AsfDeliveryBinding {
    return {
      runId: parsed.snapshot.run.runId,
      workOrderId: parsed.snapshot.admission.workOrderId,
      attemptId: parsed.snapshot.admission.attemptId,
      policyDigest: parsed.snapshot.admission.effectivePolicyDigest,
      fencingGeneration: context.generation,
      candidateSha: parsed.snapshot.run.candidateSha,
    };
  }

  #budgetLimits(parsed: ParsedAdmission) {
    return {
      wallSeconds: parsed.policy.budgets.wallSeconds,
      maxCostUsd: parsed.policy.budgets.maxCostUsd,
      maxAgentInvocations: parsed.policy.budgets.maxAgentInvocations,
    } as const;
  }

  #budgetStop(
    reason: AsfProviderBudgetExhaustionReason,
    evidenceDigest: string,
  ): AsfDeliveryStop {
    const detail = {
      "wall-deadline": {
        code: "WALL_CLOCK_BUDGET_EXHAUSTED",
        summary: "the accepted-at ASF wall-clock deadline is exhausted",
      },
      "cost-limit": {
        code: "AGENT_COST_BUDGET_EXHAUSTED",
        summary: "the aggregate ASF provider cost budget is exhausted",
      },
      "invocation-limit": {
        code: "AGENT_INVOCATION_BUDGET_EXHAUSTED",
        summary: "the aggregate ASF provider invocation budget is exhausted",
      },
    }[reason];
    return new AsfDeliveryStop({
      phase: "BUDGET_EXHAUSTED",
      code: detail.code,
      summary: detail.summary,
      retryDisposition: "new-attempt-required",
      requiredActor: "asf",
      requiredAction:
        "submit a new signed Work Order attempt if more execution is authorized",
      evidenceRefs: [evidenceDigest],
    });
  }

  #assertRunBudget(context: AsfRunnerContext, parsed: ParsedAdmission): void {
    const result = this.#options.budget.checkRun({
      binding: this.#binding(parsed, context),
      limits: this.#budgetLimits(parsed),
    });
    if (result.status === "available") return;
    if (
      !digestSchema.safeParse(result.observationDigest).success ||
      (result.reason !== "wall-deadline" && result.reason !== "cost-limit")
    ) {
      return refuse(
        "ASF budget authority returned a malformed run-budget decision",
      );
    }
    throw this.#budgetStop(result.reason, result.observationDigest);
  }

  async #recover(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<RuntimeState> {
    let checkpoint = this.#options.store.getLatestAsfCheckpoint(context.runId);
    if (checkpoint === undefined) {
      if (parsed.snapshot.run.state !== "ADMITTED") {
        return refuse("non-admitted run has no durable recovery checkpoint");
      }
      if (context.takeover) {
        return refuse(
          "takeover cannot proceed without a durable checkpoint and fencing plan",
        );
      }
      checkpoint = this.#checkpoint(context, parsed, {
        kind: "work-order-admission",
        durableInputs: {
          envelope_digest: parsed.snapshot.admission.envelopeDigest,
          payload_digest: parsed.snapshot.admission.payloadDigest,
        },
        durableOutputs: {
          admission_digest: sha256Digest({
            run_id: context.runId,
            policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
          }),
        },
        correlationMarker: null,
      });
    } else {
      checkpoint = parseDurableAsfCheckpoint(checkpoint);
      this.#assertCheckpointBinding(checkpoint, parsed, context);
      this.#assertRunBudget(context, parsed);
      const rawRecovery = await this.#options.recovery.observe({
        checkpoint,
        binding: this.#binding(parsed, context),
        workerId: this.#options.workerId,
        takeover: context.takeover,
        signal: context.signal,
      });
      this.#throwIfAborted(context.signal);
      const plan = planAsfCheckpointRecovery(rawRecovery, {
        clock: this.#options.clock,
      });
      if (
        (plan.action === "resume-implementer") !==
        plan.implementerResume instanceof AuthorizedImplementerResume
      ) {
        return refuse(
          "recovery plan returned contradictory implementer resume authority",
        );
      }
      if (plan.implementerResume !== null) {
        this.#assertAuthorizedResumeBinding(
          plan.implementerResume,
          checkpoint,
          this.#binding(parsed, context),
        );
      }
      if (context.takeover && !plan.ownershipTakeover) {
        return refuse(
          "stale-owner takeover lacks a newer-generation recovery decision",
        );
      }
      const replaysCheckpoint =
        plan.action === "replay-stage" ||
        plan.action === "restart-implementer-fresh" ||
        plan.action === "resume-implementer" ||
        plan.action === "restart-reviewer-fresh";
      if (
        replaysCheckpoint &&
        (checkpoint.phase !== parsed.snapshot.run.state ||
          checkpoint.event_seq !== parsed.snapshot.latestSequence)
      ) {
        return refuse(
          "recovery cannot replay a superseded checkpoint through the forward-only lifecycle",
        );
      }
      this.#assertRunBudget(context, parsed);
      const rawAck = await this.#options.recovery.apply({
        plan,
        checkpoint,
        binding: this.#binding(parsed, context),
        signal: context.signal,
      });
      this.#throwIfAborted(context.signal);
      const ack = recoveryAckSchema.safeParse(rawAck);
      if (!ack.success)
        return refuse("recovery controller returned malformed acknowledgement");
      assertBinding(
        ack.data.binding,
        this.#binding(parsed, context),
        "recovery acknowledgement",
      );
      if (
        ack.data.checkpoint_digest !== checkpoint.checkpoint_digest ||
        ack.data.action !== plan.action ||
        !exactSet(
          ack.data.completed_takeover_fencing,
          plan.requiredTakeoverFencing,
        ) ||
        !exactSet(ack.data.invalidated_evidence, plan.invalidatedEvidence) ||
        ack.data.acknowledgement_digest !==
          sha256Digest({
            checkpoint_digest: checkpoint.checkpoint_digest,
            action: plan.action,
            completed_takeover_fencing: ack.data.completed_takeover_fencing,
            invalidated_evidence: ack.data.invalidated_evidence,
          })
      ) {
        return refuse(
          "recovery acknowledgement does not implement the exact authorized plan",
        );
      }
      const forceFreshLocalReview =
        checkpoint.checkpoint_kind === "local-review-fixer-iteration" &&
        (plan.action === "replay-stage" ||
          plan.action === "restart-reviewer-fresh");
      const forceFreshPullRequestReview =
        checkpoint.checkpoint_kind === "pr-review-fixer-iteration" &&
        (plan.action === "replay-stage" ||
          plan.action === "restart-reviewer-fresh");
      return {
        latestCheckpoint: checkpoint,
        fixIterations: this.#countFixIterations(context.runId),
        forceFreshLocalReview,
        forceFreshPullRequestReview,
        implementationSession:
          plan.implementerResume === null
            ? { mode: "fresh" }
            : { mode: "resume", authorization: plan.implementerResume },
        protectedImplementerResume:
          plan.action === "restart-implementer-fresh"
            ? null
            : this.#recoverableProtectedResume(
                checkpoint,
                this.#binding(parsed, context),
              ),
        currentIdentityAttributions: null,
        pendingRecoveryDispatch: {
          plan,
          recoveryAcknowledgementDigest: ack.data.acknowledgement_digest,
        },
      };
    }
    return {
      latestCheckpoint: checkpoint,
      fixIterations: this.#countFixIterations(context.runId),
      forceFreshLocalReview: false,
      forceFreshPullRequestReview: false,
      implementationSession: { mode: "fresh" },
      protectedImplementerResume: null,
      currentIdentityAttributions: null,
      pendingRecoveryDispatch: null,
    };
  }

  async #dispatchRecovery(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<RuntimeState> {
    const pending = runtime.pendingRecoveryDispatch;
    if (pending === null) return runtime;
    const replayCheckpointStage = pending.plan.action === "replay-stage";
    const requiredPrerequisites = context.takeover
      ? this.#recoveryPrerequisites(parsed.snapshot.run.state as RunEventPhase)
      : [];
    if (!replayCheckpointStage && requiredPrerequisites.length === 0) {
      runtime.pendingRecoveryDispatch = null;
      return runtime;
    }

    const binding = this.#binding(parsed, context);
    const raw = await this.#options.recoveryDispatch.dispatch({
      plan: pending.plan,
      checkpoint: runtime.latestCheckpoint,
      recoveryAcknowledgementDigest: pending.recoveryAcknowledgementDigest,
      binding,
      requiredPrerequisites,
      replayCheckpointStage,
      signal: context.signal,
    });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    const dispatched = recoveryDispatchObservationSchema.safeParse(raw);
    if (!dispatched.success) {
      return refuse(
        "recovery dispatch controller returned malformed protected evidence",
      );
    }
    const value = dispatched.data;
    const {
      durable_dispatch_record_digest: dispatchRecordDigest,
      ...unsigned
    } = value;
    if (
      dispatchRecordDigest !== sha256Digest(json(unsigned)) ||
      value.checkpoint_digest !== runtime.latestCheckpoint.checkpoint_digest ||
      value.checkpoint_kind !== runtime.latestCheckpoint.checkpoint_kind ||
      value.action !== pending.plan.action ||
      value.recovery_acknowledgement_digest !==
        pending.recoveryAcknowledgementDigest ||
      value.replayed_checkpoint_stage !== replayCheckpointStage ||
      !exactSet(value.required_prerequisites, requiredPrerequisites) ||
      !exactSet(value.reestablished_prerequisites, requiredPrerequisites)
    ) {
      return refuse(
        "recovery dispatch did not exactly re-establish the authorized stage and prerequisites",
      );
    }
    assertBinding(value.binding, binding, "recovery dispatch evidence");

    const requiresIdentities =
      requiredPrerequisites.includes("identity-leases");
    if (requiresIdentities !== (value.identity_attributions !== null)) {
      return refuse(
        "recovery dispatch identity proof does not match its required prerequisites",
      );
    }
    if (value.identity_attributions !== null) {
      assertIndependentIdentityObservations(
        value.identity_attributions,
        binding,
        parsed.policy,
        this.#options.clock,
      );
      const implementer = value.identity_attributions.find(
        (attribution) => attribution.role === "implementer",
      );
      if (
        pending.plan.implementerResume !== null &&
        implementer?.lease_attribution_digest !==
          pending.plan.implementerResume.binding
            .authorizationIdentityLeaseBindingDigest
      ) {
        return refuse(
          "recovery dispatch identity does not match protected resume authorization",
        );
      }
      runtime.currentIdentityAttributions = Object.freeze([
        ...value.identity_attributions,
      ]);
    }

    runtime.pendingRecoveryDispatch = null;
    return runtime;
  }

  #recoveryPrerequisites(
    phase: RunEventPhase,
  ): readonly AsfRecoveryPrerequisite[] {
    switch (phase) {
      case "REPOSITORY_LEASED":
        return ["repository-lease"];
      case "IDENTITY_READY":
        return ["repository-lease", "identity-leases"];
      case "WORKSPACE_READY":
      case "TASK_PACKET_READY":
      case "IMPLEMENTING":
      case "CANDIDATE_READY":
      case "LOCAL_VERIFY":
      case "LOCAL_REVIEW":
      case "FIXING":
      case "DELIVERY_READY":
      case "PUSHED":
      case "PR_OPEN":
      case "CI_WAIT":
      case "PR_REVIEW":
      case "PR_DELIVERED":
      case "MERGE_QUEUE_WAIT":
      case "MERGE_READY":
      case "MERGED":
      case "EVIDENCE_FINALIZED":
        return ["repository-lease", "identity-leases", "workspace"];
      default:
        return [];
    }
  }

  #assertCheckpointBinding(
    checkpoint: DurableAsfCheckpoint,
    parsed: ParsedAdmission,
    context: AsfRunnerContext,
  ): void {
    if (
      checkpoint.run_id !== context.runId ||
      checkpoint.work_order_id !== parsed.snapshot.admission.workOrderId ||
      checkpoint.attempt_id !== parsed.snapshot.admission.attemptId ||
      checkpoint.policy_digest !==
        parsed.snapshot.admission.effectivePolicyDigest ||
      checkpoint.candidate_sha !== parsed.snapshot.run.candidateSha ||
      checkpoint.event_seq > parsed.snapshot.latestSequence ||
      checkpoint.fencing_generation > context.generation
    ) {
      refuse(
        "latest checkpoint is stale or contradicts the current run binding",
      );
    }
  }

  #assertAuthorizedResumeBinding(
    authorization: AuthorizedImplementerResume,
    checkpoint: DurableAsfCheckpoint,
    binding: AsfDeliveryBinding,
  ): void {
    const authorized = authorization.binding;
    if (
      authorized.runId !== binding.runId ||
      authorized.workOrderId !== binding.workOrderId ||
      authorized.attemptId !== binding.attemptId ||
      authorized.checkpointKind !== checkpoint.checkpoint_kind ||
      authorized.candidateSha !== binding.candidateSha ||
      authorized.policyDigest !== binding.policyDigest ||
      authorized.fencingGeneration !== checkpoint.fencing_generation ||
      authorized.authorizationFencingGeneration !== binding.fencingGeneration ||
      checkpoint.protected_implementer_resume?.session_identity_digest !==
        authorized.sessionIdentityDigest
    ) {
      refuse(
        "authorized implementer resume is not exact-bound to the recovered checkpoint",
      );
    }
  }

  #recoverableProtectedResume(
    checkpoint: DurableAsfCheckpoint,
    binding: AsfDeliveryBinding,
  ): ProtectedImplementerResumeMetadata | null {
    const metadata = checkpoint.protected_implementer_resume;
    if (metadata === null) return null;
    if (
      metadata.run_id !== binding.runId ||
      metadata.work_order_id !== binding.workOrderId ||
      metadata.attempt_id !== binding.attemptId ||
      metadata.policy_digest !== binding.policyDigest ||
      metadata.fencing_generation !== checkpoint.fencing_generation ||
      metadata.candidate_sha !== binding.candidateSha ||
      Date.parse(metadata.recorded_at) > this.#options.clock.now().getTime()
    ) {
      return refuse(
        "protected implementer resume checkpoint binding is contradictory",
      );
    }
    if (
      Date.parse(metadata.identity_lease_expires_at) <=
      this.#options.clock.now().getTime()
    ) {
      return null;
    }
    return metadata;
  }

  #checkpointIsCurrent(
    checkpoint: DurableAsfCheckpoint,
    parsed: ParsedAdmission,
    kind: AsfCheckpointKind,
  ): boolean {
    return (
      checkpoint.checkpoint_kind === kind &&
      checkpoint.event_seq === parsed.snapshot.latestSequence &&
      checkpoint.phase === parsed.snapshot.run.state &&
      checkpoint.candidate_sha === parsed.snapshot.run.candidateSha
    );
  }

  #checkpoint(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    input: {
      readonly kind: AsfCheckpointKind;
      readonly durableInputs: JsonValue;
      readonly durableOutputs: JsonValue;
      readonly correlationMarker: string | null;
    },
    runtime?: RuntimeState,
  ): DurableAsfCheckpoint {
    const policy = getAsfCheckpointRecoveryPolicy(input.kind);
    const candidate = parsed.snapshot.run.candidateSha;
    const checkpoint = createDurableAsfCheckpoint({
      schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
      checkpoint_id:
        `cp_${String(policy.number).padStart(2, "0")}_` +
        sha256Digest({
          run_id: context.runId,
          event_seq: parsed.snapshot.latestSequence,
          generation: context.generation,
          kind: input.kind,
        }).slice("sha256:".length, "sha256:".length + 32),
      checkpoint_kind: input.kind,
      run_id: context.runId,
      work_order_id: parsed.snapshot.admission.workOrderId,
      attempt_id: parsed.snapshot.admission.attemptId,
      phase: parsed.snapshot.run.state,
      event_seq: parsed.snapshot.latestSequence,
      fencing_generation: context.generation,
      policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
      candidate_sha: candidate,
      candidate_lineage_digest: this.#candidateLineageDigest(
        context.runId,
        candidate,
      ),
      durable_inputs_digest: sha256Digest(input.durableInputs),
      durable_outputs_digest: sha256Digest(input.durableOutputs),
      replay_policy: policy.replayPolicy,
      reconciliation_markers: policy.reconciliationBeforeReplay.map(
        (observation) => ({
          observation,
          correlation_marker:
            input.correlationMarker ??
            `checkpoint:${context.runId}:${input.kind}:${parsed.snapshot.latestSequence}`,
        }),
      ),
      protected_implementer_resume: this.#protectedResumeForCheckpoint(
        context,
        parsed,
        input.kind,
        runtime?.protectedImplementerResume ?? null,
      ),
      created_at: this.#options.clock.now().toISOString(),
    });
    const stored = this.#options.store.recordAsfCheckpoint({
      checkpoint,
      ownerId: this.#options.workerId,
      generation: context.generation,
    });
    if (stored.checkpoint.checkpointDigest !== checkpoint.checkpoint_digest) {
      return refuse(
        "durable checkpoint store returned a contradictory checkpoint",
      );
    }
    return checkpoint;
  }

  #candidateLineageDigest(runId: string, candidateSha: string | null): string {
    if (candidateSha === null)
      return sha256Digest({ run_id: runId, candidate_sha: null });
    const event = this.#events(runId)
      .filter(
        (item) =>
          item.type === "candidate.created" &&
          item.payload["candidate_sha"] === candidateSha,
      )
      .at(-1);
    if (event === undefined)
      return refuse(`candidate ${candidateSha} has no durable lineage event`);
    const parentSha = event.payload["parent_sha"];
    const treeDigest = event.payload["tree_digest"];
    if (typeof parentSha !== "string" || typeof treeDigest !== "string") {
      return refuse(
        `candidate ${candidateSha} has malformed durable lineage evidence`,
      );
    }
    return sha256Digest({
      candidate_sha: candidateSha,
      parent_sha: parentSha,
      tree_digest: treeDigest,
    });
  }

  #intent(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    stage: AsfDeliveryStage,
    operation: JsonValue,
    terminalPlan?: AsfTerminalEvidencePlan,
  ): PreparedIntent {
    this.#throwIfAborted(context.signal);
    if (stage !== "cleanup") this.#assertRunBudget(context, parsed);
    const binding = this.#binding(parsed, context);
    const operationDigest = sha256Digest(operation);
    const events = this.#events(context.runId);
    const latestEvent = events.at(-1);
    const reconciliation = latestEvent?.payload["reconciliation"];
    const interruptedEventSeq =
      latestEvent?.type === "run.resumed" &&
      latestEvent.phase === parsed.snapshot.run.state &&
      typeof reconciliation === "object" &&
      reconciliation !== null &&
      !Array.isArray(reconciliation) &&
      (reconciliation as Record<string, unknown>)["schema"] ===
        "asf.reconciliation-continuation-result/v1" &&
      ((reconciliation as Record<string, unknown>)["action"] ===
        "continue-confirmed" ||
        (reconciliation as Record<string, unknown>)["action"] ===
          "replay-not-applied") &&
      Number.isSafeInteger(
        (reconciliation as Record<string, unknown>)["interrupted_event_seq"],
      )
        ? ((reconciliation as Record<string, unknown>)[
            "interrupted_event_seq"
          ] as number)
        : undefined;
    const intentEventSeq =
      interruptedEventSeq ?? parsed.snapshot.latestSequence;
    const intentEvent = events.find((event) => event.seq === intentEventSeq);
    if (intentEvent === undefined) {
      return refuse(`durable ${stage} intent cursor has no exact run event`);
    }
    const effectKey = `delivery_effect_${sha256Digest({
      stage,
      run_id: binding.runId,
      candidate_sha: binding.candidateSha,
      event_seq: intentEventSeq,
      operation_digest: operationDigest,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    const unsigned = {
      schema: ASF_DELIVERY_STAGE_INTENT_SCHEMA,
      effect_key: effectKey,
      stage,
      run_id: binding.runId,
      work_order_id: binding.workOrderId,
      attempt_id: binding.attemptId,
      policy_digest: binding.policyDigest,
      fencing_generation: binding.fencingGeneration,
      candidate_sha: binding.candidateSha,
      event_seq: intentEventSeq,
      operation_digest: operationDigest,
      created_at: intentEvent.occurred_at,
    } as const;
    const identityDigest = sha256Digest({
      effect_key: effectKey,
      generation: binding.fencingGeneration,
    });
    const unsignedIntent = {
      ...unsigned,
      intent_id: `delivery_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    };
    const intent = {
      ...unsignedIntent,
      intent_digest: sha256Digest(unsignedIntent),
    } satisfies AsfDeliveryStageIntent;
    if (
      terminalPlan !== undefined &&
      (stage !== "cleanup" ||
        asfTerminalEvidencePlanSchema.parse(terminalPlan).plan_digest !==
          operationDigest)
    ) {
      return refuse("terminal cleanup intent does not bind its exact immutable plan");
    }
    let recorded: AsfDeliveryIntentRecordResult;
    if (terminalPlan === undefined) {
      recorded = this.#options.intents.record(intent);
    } else {
      const terminalRecorded = this.#options.intents.prepareTerminal({
        intent,
        plan: terminalPlan,
      });
      if (
        terminalRecorded.plan.planDigest !== terminalPlan.plan_digest ||
        terminalRecorded.plan.cleanupIntentId !==
          terminalRecorded.intent.intent_id ||
        terminalRecorded.plan.cleanupIntentDigest !==
          terminalRecorded.intent.intent_digest
      ) {
        return refuse(
          "terminal cleanup plan store returned contradictory protected state",
        );
      }
      recorded = terminalRecorded;
    }
    const parsedAuthoritative = deliveryStageIntentSchema.safeParse(
      recorded.intent,
    );
    if (!parsedAuthoritative.success) {
      return refuse(
        `durable ${stage} intent store returned malformed protected state`,
      );
    }
    const authoritative = parsedAuthoritative.data;
    const { intent_digest: authoritativeDigest, ...unsignedAuthoritative } =
      authoritative;
    if (
      sha256Digest(json(unsignedAuthoritative)) !== authoritativeDigest ||
      authoritative.effect_key !== intent.effect_key ||
      authoritative.stage !== intent.stage ||
      authoritative.run_id !== intent.run_id ||
      authoritative.work_order_id !== intent.work_order_id ||
      authoritative.attempt_id !== intent.attempt_id ||
      authoritative.policy_digest !== intent.policy_digest ||
      authoritative.candidate_sha !== intent.candidate_sha ||
      authoritative.event_seq !== intent.event_seq ||
      authoritative.operation_digest !== intent.operation_digest ||
      authoritative.fencing_generation > intent.fencing_generation ||
      (recorded.disposition === "created" &&
        canonicalJson(json(authoritative)) !== canonicalJson(json(intent))) ||
      (recorded.disposition === "existing-current" &&
        authoritative.fencing_generation !== intent.fencing_generation) ||
      (recorded.disposition === "existing-prior-generation" &&
        authoritative.fencing_generation >= intent.fencing_generation) ||
      (recorded.disposition === "existing-prior-generation-replay-authorized" &&
        authoritative.fencing_generation >= intent.fencing_generation)
    ) {
      return refuse(
        `durable ${stage} intent store returned contradictory acknowledgement`,
      );
    }
    this.#assertFence(context, binding);
    return {
      intent: authoritative,
      mode:
        recorded.disposition === "created" ||
        recorded.disposition === "existing-prior-generation-replay-authorized"
          ? "observe-before-apply"
          : "reconcile-only",
    };
  }

  async #effect<T extends ObservationWithDigest>(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    stage: AsfDeliveryStage,
    operation: JsonValue,
    invoke: (input: AsfEffectInput) => Promise<T>,
  ): Promise<{
    readonly intent: AsfDeliveryStageIntent;
    readonly observation: T;
  }> {
    if (stage !== "cleanup") this.#assertRunBudget(context, parsed);
    const binding = this.#binding(parsed, context);
    const prepared = this.#intent(context, parsed, stage, operation);
    const observation = await invoke({
      binding,
      intent: prepared.intent,
      intentMode: prepared.mode,
      signal: context.signal,
    });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    this.#options.intents.confirm({
      intentId: prepared.intent.intent_id,
      intentDigest: prepared.intent.intent_digest,
      observationDigest: observation.evidence_digest,
      binding,
    });
    return { intent: prepared.intent, observation };
  }

  #reserveProviderBudget(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    effect: AsfEffectInput,
    role: AsfProviderBudgetRole,
    invocationId: string,
    providerCandidateSha: string,
  ): AsfProviderBudgetAllowance {
    const decision = this.#options.budget.reserve({
      binding: effect.binding,
      effectKey: effect.intent.effect_key,
      intentId: effect.intent.intent_id,
      intentDigest: effect.intent.intent_digest,
      intentGeneration: effect.intent.fencing_generation,
      intentMode: effect.intentMode,
      role,
      invocationId,
      providerCandidateSha,
      limits: this.#budgetLimits(parsed),
    });
    if (decision.status === "exhausted") {
      if (
        !digestSchema.safeParse(decision.observationDigest).success ||
        !["wall-deadline", "cost-limit", "invocation-limit"].includes(
          decision.reason,
        )
      ) {
        return refuse(
          "ASF budget authority returned a malformed provider denial",
        );
      }
      this.#throwIfAborted(context.signal);
      this.#assertFence(context, effect.binding);
      const durableIntent = this.#options.store.getAsfDeliveryIntentById(
        effect.intent.intent_id,
      );
      if (
        durableIntent === undefined ||
        canonicalJson(
          portableDeliveryStageIntent(durableIntent) as unknown as JsonValue,
        ) !== canonicalJson(effect.intent as unknown as JsonValue) ||
        durableIntent.fencing_generation > effect.binding.fencingGeneration
      ) {
        return refuse(
          "provider budget denial is not bound to the exact durable lifecycle intent",
        );
      }
      if (durableIntent.observationOutcome === "confirmed") {
        if (
          durableIntent.observationDigest === null ||
          !digestSchema.safeParse(durableIntent.observationDigest).success ||
          durableIntent.confirmedGeneration === null ||
          durableIntent.confirmedGeneration <
            durableIntent.fencing_generation ||
          durableIntent.confirmedGeneration >
            effect.binding.fencingGeneration ||
          durableIntent.confirmedAt === null
        ) {
          return refuse(
            "provider budget denial found contradictory prior lifecycle confirmation",
          );
        }
        // Exact confirmed reconciliation already closed the lifecycle intent.
        // The conservative budget settlement is a separate observation and
        // must not overwrite that original effect evidence.
      } else if (
        durableIntent.observationOutcome === null &&
        durableIntent.observationDigest === null &&
        durableIntent.confirmedGeneration === null &&
        durableIntent.confirmedAt === null
      ) {
        // No provider authority was granted. Confirm the already-written
        // generic intent with this durable no-op observation so terminal
        // cleanup is not blocked by an effect known never to have happened.
        this.#options.intents.confirm({
          intentId: effect.intent.intent_id,
          intentDigest: effect.intent.intent_digest,
          observationDigest: decision.observationDigest,
          binding: effect.binding,
        });
      } else {
        return refuse(
          "provider budget denial conflicts with unresolved lifecycle evidence",
        );
      }
      throw this.#budgetStop(decision.reason, decision.observationDigest);
    }
    const allowance = decision.allowance;
    const expectedDeadline = new Date(
      Date.parse(parsed.snapshot.admission.acceptedAt) +
        parsed.policy.budgets.wallSeconds * 1_000,
    ).toISOString();
    const expectedAuthorization =
      effect.intentMode === "observe-before-apply"
        ? "invoke"
        : "reconcile-only";
    if (
      allowance.schema !== ASF_PROVIDER_BUDGET_ALLOWANCE_SCHEMA ||
      !identifierSchema.safeParse(allowance.reservationId).success ||
      !digestSchema.safeParse(allowance.reservationDigest).success ||
      allowance.authorization !== expectedAuthorization ||
      allowance.acceptedAt !== parsed.snapshot.admission.acceptedAt ||
      allowance.deadlineAt !== expectedDeadline ||
      !Number.isSafeInteger(allowance.remainingWallMs) ||
      allowance.remainingWallMs < 0 ||
      allowance.remainingWallMs > parsed.policy.budgets.wallSeconds * 1_000 ||
      !Number.isFinite(allowance.maxCostUsd) ||
      allowance.maxCostUsd < 0 ||
      allowance.maxCostUsd > parsed.policy.budgets.maxCostUsd ||
      !Number.isSafeInteger(allowance.invocationOrdinal) ||
      allowance.invocationOrdinal < 1 ||
      allowance.invocationOrdinal > parsed.policy.budgets.maxAgentInvocations ||
      allowance.maxAgentInvocations !==
        parsed.policy.budgets.maxAgentInvocations
    ) {
      return refuse(
        "ASF budget authority returned a malformed or widened provider allowance",
      );
    }
    return allowance;
  }

  #completeProviderBudget(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    effect: AsfEffectInput,
    allowance: AsfProviderBudgetAllowance,
    role: AsfProviderBudgetRole,
    invocationId: string,
    providerCandidateSha: string,
    providerResult: AsfProviderResult,
  ): AsfProviderBudgetCompletion {
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, effect.binding);
    const model = providerResult.model_result;
    const completion = this.#options.budget.complete({
      binding: effect.binding,
      reservationId: allowance.reservationId,
      reservationDigest: allowance.reservationDigest,
      effectKey: effect.intent.effect_key,
      intentId: effect.intent.intent_id,
      intentDigest: effect.intent.intent_digest,
      role,
      invocationId,
      providerCandidateSha,
      providerResultDigest: providerResult.result_digest,
      provider: model.provider,
      model: model.model,
      principal: model.principal,
      profile: model.profile,
      actualCostUsd: model.usage.cost_usd,
      limits: this.#budgetLimits(parsed),
    });
    if (
      completion.status !== "completed" ||
      !Number.isSafeInteger(completion.actualCostMicros) ||
      completion.actualCostMicros < 0 ||
      !Number.isSafeInteger(completion.conservativeCostMicros) ||
      completion.conservativeCostMicros < 0 ||
      !Number.isSafeInteger(completion.invocationCount) ||
      completion.invocationCount < 1 ||
      completion.invocationCount > parsed.policy.budgets.maxAgentInvocations ||
      typeof completion.completedAfterDeadline !== "boolean" ||
      typeof completion.exceededReservedCost !== "boolean"
    ) {
      return refuse(
        "ASF budget authority returned a malformed provider completion",
      );
    }
    return completion;
  }

  #assertFence(context: AsfRunnerContext, binding: AsfDeliveryBinding): void {
    const snapshot = this.#options.store.getAsfRunSnapshot(context.runId);
    if (
      snapshot === undefined ||
      snapshot.run.ownerId !== this.#options.workerId ||
      snapshot.run.generation !== context.generation ||
      snapshot.run.candidateSha !== binding.candidateSha ||
      snapshot.admission.effectivePolicyDigest !== binding.policyDigest
    ) {
      throw new Error(
        "ASF delivery effect lost its exact candidate, policy, or fencing binding",
      );
    }
  }

  #transition(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    to: RunEventPhase,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    checkpoint?: AsfAtomicCheckpointInput,
  ): RunEvent {
    this.#throwIfAborted(context.signal);
    return context.transition({
      from: parsed.snapshot.run.state as RunEventPhase,
      to,
      expectedVersion: parsed.snapshot.run.stateVersion,
      eventType,
      payload,
      checkpoint,
      actor: "asf-delivery-orchestrator",
    });
  }

  #transitionWithCheckpoint(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    to: RunEventPhase,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    checkpoint: AsfAtomicCheckpointInput,
    runtime?: RuntimeState,
  ): DurableAsfCheckpoint {
    const protectedImplementerResume = this.#protectedResumeForCheckpoint(
      context,
      parsed,
      checkpoint.kind,
      runtime?.protectedImplementerResume ?? null,
    );
    const material: AsfAtomicCheckpointInput = {
      ...checkpoint,
      protectedImplementerResume,
    };
    const event = this.#transition(
      context,
      parsed,
      to,
      eventType,
      payload,
      material,
    );
    const current = this.#admission(context);
    const stored = this.#options.store.getLatestAsfCheckpoint(context.runId);
    const policy = getAsfCheckpointRecoveryPolicy(material.kind);
    if (
      stored === undefined ||
      stored.checkpoint_kind !== material.kind ||
      stored.run_id !== context.runId ||
      stored.work_order_id !== current.snapshot.admission.workOrderId ||
      stored.attempt_id !== current.snapshot.admission.attemptId ||
      stored.policy_digest !==
        current.snapshot.admission.effectivePolicyDigest ||
      stored.fencing_generation !== context.generation ||
      stored.phase !== to ||
      stored.event_seq !== event.seq ||
      stored.candidate_sha !== current.snapshot.run.candidateSha ||
      stored.durable_inputs_digest !== sha256Digest(material.durableInputs) ||
      stored.durable_outputs_digest !== sha256Digest(material.durableOutputs) ||
      stored.replay_policy !== policy.replayPolicy ||
      !exactSet(
        stored.reconciliation_markers.map((marker) => marker.observation),
        policy.reconciliationBeforeReplay,
      ) ||
      stored.reconciliation_markers.some(
        (marker) =>
          material.correlationMarker !== null &&
          marker.correlation_marker !== material.correlationMarker,
      ) ||
      canonicalJson(json(stored.protected_implementer_resume)) !==
        canonicalJson(json(protectedImplementerResume))
    ) {
      return refuse(
        `atomic ${material.kind} checkpoint is missing or contradicts its lifecycle event`,
      );
    }
    return stored;
  }

  #protectedResumeForCheckpoint(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    kind: AsfCheckpointKind,
    metadata: ProtectedImplementerResumeMetadata | null,
  ): ProtectedImplementerResumeMetadata | null {
    if (
      metadata === null ||
      getAsfCheckpointRecoveryPolicy(kind).implementerSessionResume !==
        "protected-conditional"
    ) {
      return null;
    }
    if (
      metadata.run_id !== context.runId ||
      metadata.work_order_id !== parsed.snapshot.admission.workOrderId ||
      metadata.attempt_id !== parsed.snapshot.admission.attemptId ||
      metadata.policy_digest !== parsed.snapshot.admission.effectivePolicyDigest
    ) {
      return refuse(
        "protected implementer resume metadata is bound to another run or policy",
      );
    }
    if (
      metadata.fencing_generation !== context.generation ||
      Date.parse(metadata.identity_lease_expires_at) <=
        this.#options.clock.now().getTime()
    ) {
      return null;
    }
    if (
      Date.parse(metadata.recorded_at) > this.#options.clock.now().getTime()
    ) {
      return refuse(
        "protected implementer resume metadata was recorded in the future",
      );
    }
    return metadata;
  }

  async #repositoryLease(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "work-order-admission",
      parsed.snapshot.run.candidateSha,
    );
    const raw = await this.#effect(
      context,
      parsed,
      "repository-lease",
      {
        repository: parsed.envelope.payload.repository.repository,
        base_sha: parsed.envelope.payload.repository.base_sha.toLowerCase(),
      },
      async (input) => {
        const result = repositoryLeaseObservationSchema.safeParse(
          await this.#options.repositoryLease.acquire(input),
        );
        if (!result.success)
          return refuse(
            "repository lease controller returned malformed evidence",
          );
        assertBinding(
          result.data.binding,
          input.binding,
          "repository lease observation",
        );
        if (
          result.data.repository.toLowerCase() !==
            parsed.snapshot.run.repo.toLowerCase() ||
          result.data.lease_generation !== context.generation
        ) {
          return refuse(
            "repository lease observation names another repository or generation",
          );
        }
        return result.data;
      },
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "REPOSITORY_LEASED",
      "repository.lease_acquired",
      {
        repository: parsed.snapshot.run.repo,
        generation: context.generation,
      },
      {
        kind: "repository-lease-acquisition",
        durableInputs: {
          prior_checkpoint: runtime.latestCheckpoint.checkpoint_digest,
        },
        durableOutputs: { evidence_digest: raw.observation.evidence_digest },
        correlationMarker: raw.intent.intent_id,
      },
    );
  }

  async #identities(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(runtime, "repository-lease-acquisition", null);
    const raw = await this.#effect(
      context,
      parsed,
      "identity-leases",
      {
        identities: parsed.policy.identities,
      },
      async (input) => {
        const result = identityObservationSchema.safeParse(
          await this.#options.identities.acquireRequiredRoles(input),
        );
        if (!result.success)
          return refuse("identity controller returned malformed evidence");
        assertBinding(
          result.data.binding,
          input.binding,
          "identity observation",
        );
        if (
          !exactSet(result.data.roles, [
            "implementer",
            "local-reviewer",
            "pr-reviewer",
          ])
        ) {
          return refuse(
            "identity controller did not prove all three independent roles",
          );
        }
        if (
          !exactSet(
            result.data.attributions.map((attribution) => attribution.role),
            ["implementer", "local-reviewer", "pr-reviewer"],
          ) ||
          result.data.attributions_digest !==
            identityAttributionsDigest(result.data.attributions)
        ) {
          return refuse(
            "identity attribution digest does not bind each required role lease exactly once",
          );
        }
        assertIndependentIdentityObservations(
          result.data.attributions,
          input.binding,
          parsed.policy,
          this.#options.clock,
        );
        return result.data;
      },
    );
    runtime.currentIdentityAttributions = Object.freeze([
      ...raw.observation.attributions,
    ]);
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "IDENTITY_READY",
      "identity.leases_acquired",
      {
        attributions_digest: raw.observation.attributions_digest,
        roles: raw.observation.roles,
        attributions: raw.observation.attributions,
      },
      {
        kind: "identity-lease-acquisition",
        durableInputs: {
          policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
        },
        durableOutputs: {
          attributions_digest: raw.observation.attributions_digest,
        },
        correlationMarker: raw.intent.intent_id,
      },
    );
  }

  async #workspace(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(runtime, "identity-lease-acquisition", null);
    const raw = await this.#effect(
      context,
      parsed,
      "workspace",
      {
        base_sha: parsed.envelope.payload.repository.base_sha.toLowerCase(),
        sandbox_profile: parsed.policy.runtime.sandboxProfile,
      },
      async (input) => {
        const result = workspaceObservationSchema.safeParse(
          await this.#options.workspace.prepare({
            ...input,
            baseSha: parsed.envelope.payload.repository.base_sha.toLowerCase(),
            sandboxProfile: parsed.policy.runtime.sandboxProfile,
          }),
        );
        if (!result.success)
          return refuse(
            "workspace controller returned malformed isolation evidence",
          );
        assertBinding(
          result.data.binding,
          input.binding,
          "workspace observation",
        );
        if (
          result.data.base_sha !==
            parsed.envelope.payload.repository.base_sha.toLowerCase() ||
          result.data.sandbox_profile !== parsed.policy.runtime.sandboxProfile
        ) {
          return refuse(
            "workspace is not bound to the admitted base and sandbox profile",
          );
        }
        return result.data;
      },
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "WORKSPACE_READY",
      "workspace.prepared",
      {
        workspace_id: raw.observation.workspace_id,
        sandbox_profile: raw.observation.sandbox_profile,
        isolation_evidence_digest: raw.observation.isolation_evidence_digest,
      },
      {
        kind: "workspace-sandbox-proof",
        durableInputs: { base_sha: raw.observation.base_sha },
        durableOutputs: {
          isolation_evidence_digest: raw.observation.isolation_evidence_digest,
        },
        correlationMarker: raw.intent.intent_id,
      },
    );
  }

  async #taskPacket(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(runtime, "workspace-sandbox-proof", null);
    const raw = await this.#effect(
      context,
      parsed,
      "task-packet",
      {
        envelope_digest: parsed.snapshot.admission.envelopeDigest,
        policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
      },
      async (input) => {
        const result = taskPacketObservationSchema.safeParse(
          await this.#options.taskPacket.create({
            ...input,
            envelope: parsed.envelope,
            effectivePolicy: parsed.policy,
          }),
        );
        if (!result.success)
          return refuse("task-packet controller returned malformed evidence");
        assertBinding(
          result.data.binding,
          input.binding,
          "task-packet observation",
        );
        if (
          result.data.source_snapshot_digest !==
          parsed.envelope.payload.source.snapshot_digest
        ) {
          return refuse(
            "task packet does not bind the immutable source snapshot",
          );
        }
        return result.data;
      },
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "TASK_PACKET_READY",
      "task_packet.created",
      {
        task_packet_digest: raw.observation.task_packet_digest,
        source_snapshot_digest: raw.observation.source_snapshot_digest,
      },
      {
        kind: "task-packet-creation",
        durableInputs: {
          envelope_digest: parsed.snapshot.admission.envelopeDigest,
        },
        durableOutputs: {
          task_packet_digest: raw.observation.task_packet_digest,
        },
        correlationMarker: raw.intent.intent_id,
      },
    );
  }

  async #startImplementation(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(runtime, "task-packet-creation", null);
    const taskPacketDigest = this.#taskPacketDigest(context.runId);
    const startingSha =
      parsed.envelope.payload.repository.base_sha.toLowerCase();
    const raw = await this.#effect(
      context,
      parsed,
      "implementer-session",
      {
        task_packet_digest: taskPacketDigest,
        starting_sha: startingSha,
      },
      async (input) => {
        const result = sessionObservationSchema.safeParse(
          await this.#options.implementation.markSession({
            ...input,
            taskPacketDigest,
            startingSha,
            session: { mode: "fresh" },
          }),
        );
        if (!result.success)
          return refuse(
            "implementer session controller returned malformed evidence",
          );
        assertBinding(
          result.data.binding,
          input.binding,
          "implementer session observation",
        );
        if (result.data.session !== "new") {
          return refuse(
            "ordinary lifecycle start cannot consume unproven provider resume authority",
          );
        }
        runtime.protectedImplementerResume =
          this.#validateSessionCheckpointResume(
            context,
            parsed,
            runtime,
            input.binding,
            result.data.protected_implementer_resume,
          );
        return result.data;
      },
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "IMPLEMENTING",
      "implementation.started",
      {
        session: raw.observation.session,
        checkpoint_digest: raw.observation.checkpoint_digest,
      },
      {
        kind: "implementer-session-marker",
        durableInputs: { task_packet_digest: taskPacketDigest },
        durableOutputs: {
          session_evidence_digest: raw.observation.evidence_digest,
        },
        correlationMarker: raw.intent.intent_id,
      },
      runtime,
    );
  }

  #validateSessionCheckpointResume(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
    binding: AsfDeliveryBinding,
    metadata: ProtectedImplementerResumeMetadata | null,
  ): ProtectedImplementerResumeMetadata | null {
    if (metadata === null) return null;
    const attribution = this.#implementerAttribution(context, parsed, runtime);
    const expectedLineage = sha256Digest({
      run_id: binding.runId,
      candidate_sha: null,
    });
    if (
      binding.candidateSha !== null ||
      metadata.run_id !== binding.runId ||
      metadata.work_order_id !== binding.workOrderId ||
      metadata.attempt_id !== binding.attemptId ||
      metadata.policy_digest !== binding.policyDigest ||
      metadata.fencing_generation !== binding.fencingGeneration ||
      metadata.candidate_sha !== null ||
      metadata.candidate_lineage_digest !== expectedLineage ||
      metadata.identity_lease_binding_digest !==
        attribution.lease_attribution_digest ||
      metadata.identity_lease_expires_at !== attribution.expires_at ||
      metadata.provider !== attribution.provider ||
      metadata.principal !== attribution.principal_id ||
      metadata.profile !== attribution.profile ||
      Date.parse(metadata.recorded_at) > this.#options.clock.now().getTime() ||
      Date.parse(metadata.identity_lease_expires_at) <=
        this.#options.clock.now().getTime()
    ) {
      return refuse(
        "new implementer session resume metadata is not exact identity-bound",
      );
    }
    return metadata;
  }

  async #resumeDescriptor(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
    taskPacketDigest: string,
    startingSha: string,
    fixing: boolean,
  ): Promise<TrustedImplementerResumeDescriptor | null> {
    if (runtime.implementationSession.mode === "fresh") return null;
    if (fixing || parsed.snapshot.run.state !== "IMPLEMENTING") {
      return refuse(
        "protected implementer resume is authorized only for the exact IMPLEMENTING checkpoint",
      );
    }
    if (this.#options.implementation.describeAuthorizedResume === undefined) {
      return refuse(
        "implementation controller cannot resolve authorized resume state",
      );
    }
    const authorization = runtime.implementationSession.authorization;
    if (!(authorization instanceof AuthorizedImplementerResume)) {
      return refuse(
        "implementation resume authority is not an AuthorizedImplementerResume",
      );
    }
    const raw = await this.#options.implementation.describeAuthorizedResume({
      authorization,
      binding: this.#binding(parsed, context),
      taskPacketDigest,
      startingSha,
      signal: context.signal,
    });
    this.#throwIfAborted(context.signal);
    const descriptor = trustedImplementerResumeDescriptorSchema.safeParse(raw);
    if (!descriptor.success) {
      return refuse(
        "implementation controller returned a malformed resume descriptor",
      );
    }
    const { descriptor_digest: descriptorDigest, ...unsigned } =
      descriptor.data;
    if (
      sha256Digest(json(unsigned)) !== descriptorDigest ||
      descriptor.data.authorization_digest !==
        sha256Digest(json(authorization.binding)) ||
      descriptor.data.session_identity_digest !==
        authorization.binding.sessionIdentityDigest ||
      descriptor.data.provider_candidate_sha !== startingSha ||
      descriptor.data.task_packet_digest !== taskPacketDigest
    ) {
      return refuse(
        "resume descriptor is stale or contradicts its exact authorization",
      );
    }
    return descriptor.data;
  }

  async #captureProtectedResume(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
    binding: AsfDeliveryBinding,
    providerResult: AsfProviderResult,
    execution: TrustedProviderExecution,
    taskPacketDigest: string,
    startingSha: string,
    candidateSha: string,
    parentSha: string,
    treeDigest: string,
    fixing: boolean,
  ): Promise<ProtectedImplementerResumeMetadata | null> {
    const advertisedDigest = providerResult.resume_metadata_digest;
    const hasCapability = execution.protectedResume !== null;
    if (fixing && (advertisedDigest !== null || hasCapability)) {
      return refuse(
        "fixer execution returned prohibited implementer resume authority",
      );
    }
    const attribution = this.#implementerAttribution(context, parsed, runtime);
    const raw = await this.#options.implementation.captureProtectedResume({
      execution,
      binding,
      implementerAttribution: attribution,
      taskPacketDigest,
      startingSha,
      checkpointCandidateSha: candidateSha,
      candidateLineageDigest: sha256Digest({
        candidate_sha: candidateSha,
        parent_sha: parentSha,
        tree_digest: treeDigest,
      }),
      signal: context.signal,
    });
    this.#throwIfAborted(context.signal);
    if (advertisedDigest === null || !hasCapability) {
      if (advertisedDigest !== null || hasCapability || raw !== null) {
        return refuse(
          "provider resume capability and protected checkpoint metadata disagree",
        );
      }
      return null;
    }
    const metadata = protectedImplementerResumeMetadataSchema.safeParse(raw);
    if (!metadata.success) {
      return refuse(
        "protected resume controller returned malformed checkpoint metadata",
      );
    }
    const value = metadata.data;
    const model = providerResult.model_result;
    const candidateLineageDigest = sha256Digest({
      candidate_sha: candidateSha,
      parent_sha: parentSha,
      tree_digest: treeDigest,
    });
    if (
      value.session_identity_digest !== advertisedDigest ||
      value.run_id !== binding.runId ||
      value.work_order_id !== binding.workOrderId ||
      value.attempt_id !== binding.attemptId ||
      value.policy_digest !== binding.policyDigest ||
      value.fencing_generation !== binding.fencingGeneration ||
      value.candidate_sha !== candidateSha ||
      value.candidate_lineage_digest !== candidateLineageDigest ||
      value.identity_lease_binding_digest !==
        attribution.lease_attribution_digest ||
      value.identity_lease_expires_at !== attribution.expires_at ||
      value.provider !== model.provider ||
      value.provider !== attribution.provider ||
      value.principal !== model.principal ||
      value.principal !== attribution.principal_id ||
      value.profile !== model.profile ||
      value.profile !== attribution.profile ||
      Date.parse(value.recorded_at) < Date.parse(providerResult.completed_at) ||
      Date.parse(value.recorded_at) > this.#options.clock.now().getTime() ||
      Date.parse(value.identity_lease_expires_at) <=
        this.#options.clock.now().getTime()
    ) {
      return refuse(
        "protected resume checkpoint metadata is not exact identity-bound",
      );
    }
    return value;
  }

  #implementerAttribution(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): AsfIdentityLeaseAttribution {
    const current = runtime.currentIdentityAttributions?.find(
      (attribution) => attribution.role === "implementer",
    );
    if (current !== undefined) return current;
    const event = this.#latestEvent(
      context.runId,
      "identity.leases_acquired",
      null,
    );
    const raw = event.payload["attributions"];
    if (!Array.isArray(raw)) {
      return refuse("durable identity checkpoint has no role attributions");
    }
    const parsedAttributions = raw.map((attribution) => {
      try {
        return assertIdentityLeaseAttribution(
          {
            run_id: context.runId,
            work_order_id: parsed.snapshot.admission.workOrderId,
            attempt_id: parsed.snapshot.admission.attemptId,
            policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
            fencing_generation: context.generation,
            candidate_sha: null,
          },
          attribution,
        );
      } catch {
        return refuse(
          "durable implementer identity attribution is contradictory",
        );
      }
    });
    if (
      event.payload["attributions_digest"] !==
      identityAttributionsDigest(parsedAttributions)
    ) {
      return refuse(
        "durable identity attribution set has a contradictory digest",
      );
    }
    const implementer = parsedAttributions.find(
      (attribution) => attribution.role === "implementer",
    );
    if (implementer === undefined) {
      return refuse("durable identity attribution set has no implementer");
    }
    return implementer;
  }

  async #candidate(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    const fixing = parsed.snapshot.run.state === "FIXING";
    const providerRole = fixing ? ("fixer" as const) : ("implementer" as const);
    const startingSha = fixing
      ? this.#requiredCandidate(parsed)
      : parsed.envelope.payload.repository.base_sha.toLowerCase();
    const taskPacketDigest = this.#taskPacketDigest(context.runId);
    const resumeDescriptor = await this.#resumeDescriptor(
      context,
      parsed,
      runtime,
      taskPacketDigest,
      startingSha,
      fixing,
    );
    let providerCompletion: AsfProviderBudgetCompletion | undefined;
    let providerResultDigest: string | undefined;
    let capturedResume: ProtectedImplementerResumeMetadata | null = null;
    const raw = await this.#effect(
      context,
      parsed,
      "candidate",
      {
        starting_sha: startingSha,
        mode: fixing ? "fix" : "implement",
        iteration: runtime.fixIterations,
        session:
          resumeDescriptor === null
            ? { mode: "fresh" }
            : {
                mode: "resume",
                descriptor_digest: resumeDescriptor.descriptor_digest,
                session_identity_digest:
                  resumeDescriptor.session_identity_digest,
              },
      },
      async (input) => {
        const invocationId =
          resumeDescriptor?.invocation_id ??
          asfProviderInvocationId(input.intent.effect_key, providerRole);
        const providerBudget = this.#reserveProviderBudget(
          context,
          parsed,
          input,
          providerRole,
          invocationId,
          startingSha,
        );
        const result = candidateObservationSchema.safeParse(
          await this.#options.implementation.createCandidate({
            ...input,
            taskPacketDigest,
            startingSha,
            mode: fixing ? "fix" : "implement",
            iteration: runtime.fixIterations,
            invocationId,
            providerBudget,
            session:
              resumeDescriptor === null
                ? { mode: "fresh" }
                : {
                    mode: "resume",
                    authorization:
                      runtime.implementationSession.mode === "resume"
                        ? runtime.implementationSession.authorization
                        : refuse(
                            "implementer resume descriptor lost its authorization",
                          ),
                    descriptorDigest: resumeDescriptor.descriptor_digest,
                  },
          }),
        );
        if (!result.success)
          return refuse("candidate controller returned malformed evidence");
        assertBinding(
          result.data.binding,
          input.binding,
          "candidate observation",
        );
        if (
          result.data.parent_sha !== startingSha ||
          result.data.candidate_sha === startingSha
        ) {
          return refuse(
            "candidate lineage does not extend the exact trusted starting SHA",
          );
        }
        const scope = evaluateEffectivePathScope(
          result.data.changed_paths,
          parsed.policy,
        );
        if (!scope.accepted) {
          throw new AsfDeliveryStop({
            phase: "REFUSED",
            code: "CHANGE_SCOPE_REFUSED",
            summary: "candidate changes exceed the admitted path scope",
            retryDisposition: "new-attempt-required",
            requiredActor: "asf",
            requiredAction:
              "submit a new signed Work Order with an authorized scope",
            evidenceRefs: [result.data.evidence_digest],
          });
        }
        const execution = assertProviderExecution(
          result.data.provider_execution,
          input.binding,
          providerRole,
          startingSha,
          invocationId,
        );
        providerCompletion = this.#completeProviderBudget(
          context,
          parsed,
          input,
          providerBudget,
          providerRole,
          invocationId,
          startingSha,
          execution.result,
        );
        providerResultDigest = execution.result.result_digest;
        capturedResume = await this.#captureProtectedResume(
          context,
          parsed,
          runtime,
          input.binding,
          execution.result,
          result.data.provider_execution,
          taskPacketDigest,
          startingSha,
          result.data.candidate_sha,
          result.data.parent_sha,
          result.data.tree_digest,
          fixing,
        );
        return result.data;
      },
    );
    runtime.implementationSession = { mode: "fresh" };
    runtime.protectedImplementerResume = capturedResume;
    if (providerCompletion?.completedAfterDeadline === true) {
      throw this.#budgetStop(
        "wall-deadline",
        providerResultDigest ?? raw.intent.intent_digest,
      );
    }
    if (providerCompletion?.exceededReservedCost === true) {
      throw this.#budgetStop(
        "cost-limit",
        providerResultDigest ?? raw.intent.intent_digest,
      );
    }
    if (fixing) {
      await this.#invalidateCandidate(
        context,
        parsed,
        startingSha,
        raw.observation.candidate_sha,
      );
    }
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "CANDIDATE_READY",
      "candidate.created",
      {
        candidate_sha: raw.observation.candidate_sha,
        parent_sha: raw.observation.parent_sha,
        tree_digest: raw.observation.tree_digest,
      },
      {
        kind: "candidate-commit-creation",
        durableInputs: { parent_sha: raw.observation.parent_sha },
        durableOutputs: {
          candidate_sha: raw.observation.candidate_sha,
          tree_digest: raw.observation.tree_digest,
          changed_paths: raw.observation.changed_paths,
        },
        correlationMarker: raw.intent.intent_id,
      },
      runtime,
    );
  }

  async #invalidateCandidate(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    priorCandidateSha: string,
    candidateSha: string,
  ): Promise<string> {
    if (priorCandidateSha === candidateSha)
      return refuse("fixer returned the unchanged candidate");
    const raw = await this.#effect(
      context,
      parsed,
      "candidate-invalidation",
      {
        prior_candidate_sha: priorCandidateSha,
        candidate_sha: candidateSha,
        evidence_classes: CANDIDATE_CHANGE_INVALIDATES,
      },
      async (input) => {
        const result = invalidationAckSchema.safeParse(
          await this.#options.invalidation.invalidate({
            ...input,
            priorCandidateSha,
            candidateSha,
            evidenceClasses: CANDIDATE_CHANGE_INVALIDATES,
          }),
        );
        if (!result.success)
          return refuse(
            "candidate invalidation controller returned malformed acknowledgement",
          );
        assertBinding(
          result.data.binding,
          input.binding,
          "candidate invalidation acknowledgement",
        );
        if (
          result.data.prior_candidate_sha !== priorCandidateSha ||
          result.data.candidate_sha !== candidateSha ||
          !exactSet(
            result.data.invalidated_evidence,
            CANDIDATE_CHANGE_INVALIDATES,
          ) ||
          result.data.acknowledgement_digest !==
            sha256Digest({
              prior_candidate_sha: priorCandidateSha,
              candidate_sha: candidateSha,
              invalidated_evidence: result.data.invalidated_evidence,
            })
        ) {
          return refuse(
            "candidate invalidation did not cover every candidate-bound evidence class",
          );
        }
        return {
          ...result.data,
          evidence_digest: result.data.acknowledgement_digest,
        };
      },
    );
    return raw.observation.evidence_digest;
  }

  async #localVerification(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "candidate-commit-creation",
      this.#requiredCandidate(parsed),
    );
    this.#transition(context, parsed, "LOCAL_VERIFY", "verification.started", {
      candidate_sha: this.#requiredCandidate(parsed),
      required_check_ids: parsed.policy.requiredLocalCheckIds,
    });
    return this.#completeLocalVerification(
      context,
      this.#admission(context),
      runtime,
    );
  }

  async #completeLocalVerification(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    const candidateSha = this.#requiredCandidate(parsed);
    const raw = await this.#effect(
      context,
      parsed,
      "local-verification",
      {
        candidate_sha: candidateSha,
        required_check_ids: parsed.policy.requiredLocalCheckIds,
      },
      async (input) => {
        const result = localVerificationObservationSchema.safeParse(
          await this.#options.localVerification.verify({
            ...input,
            candidateSha,
            requiredCheckIds: parsed.policy.requiredLocalCheckIds,
          }),
        );
        if (!result.success)
          return refuse(
            "local verification controller returned malformed evidence",
          );
        assertBinding(
          result.data.binding,
          input.binding,
          "local verification observation",
        );
        if (
          result.data.candidate_sha !== candidateSha ||
          !exactSet(
            result.data.checks.map((check) => check.check_id),
            parsed.policy.requiredLocalCheckIds,
          )
        ) {
          return refuse(
            "local verification does not cover the exact required candidate-bound checks",
          );
        }
        return result.data;
      },
    );
    let current = parsed;
    const checkpointMaterial = {
      kind: "local-verification-pass",
      durableInputs: { candidate_sha: candidateSha },
      durableOutputs: { checks: raw.observation.checks },
      correlationMarker: raw.intent.intent_id,
    } as const satisfies AsfAtomicCheckpointInput;
    const passed = raw.observation.checks.every(
      (check) => check.outcome === "passed",
    );
    let checkpoint: DurableAsfCheckpoint | undefined;
    for (const [index, check] of raw.observation.checks.entries()) {
      const payload = {
        candidate_sha: candidateSha,
        check_id: check.check_id,
        outcome: check.outcome,
        evidence_digest: check.evidence_digest,
      } as const;
      if (passed && index === raw.observation.checks.length - 1) {
        checkpoint = this.#transitionWithCheckpoint(
          context,
          current,
          "LOCAL_VERIFY",
          "verification.completed",
          payload,
          checkpointMaterial,
          runtime,
        );
      } else {
        this.#transition(
          context,
          current,
          "LOCAL_VERIFY",
          "verification.completed",
          payload,
        );
      }
      current = this.#admission(context);
    }
    const failed = raw.observation.checks.some(
      (check) => check.outcome === "failed",
    );
    const blocked = raw.observation.checks.some(
      (check) => check.outcome === "blocked",
    );
    if (blocked) {
      throw new AsfDeliveryStop({
        phase: "BLOCKED_EXTERNAL",
        code: "LOCAL_CHECK_BLOCKED",
        summary: "a required local check could not produce a definitive result",
        retryDisposition: "reconcile-first",
        requiredActor: "repository-owner",
        requiredAction:
          "repair the trusted check environment and reconcile this candidate",
        evidenceRefs: [raw.observation.evidence_digest],
      });
    }
    if (failed) {
      await this.#startFixing(context, current, candidateSha, runtime);
      return runtime.latestCheckpoint;
    }
    return (
      checkpoint ??
      this.#checkpoint(context, current, checkpointMaterial, runtime)
    );
  }

  async #localReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "local-verification-pass",
      this.#requiredCandidate(parsed),
    );
    this.#transition(context, parsed, "LOCAL_REVIEW", "review.started", {
      candidate_sha: this.#requiredCandidate(parsed),
      reviewer_attribution: parsed.policy.identities.localReviewer,
    });
    return this.#completeLocalReview(
      context,
      this.#admission(context),
      runtime,
    );
  }

  async #completeLocalReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    return this.#review(context, parsed, "local", runtime);
  }

  async #pullRequestReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "ci-reconciliation-snapshot",
      this.#requiredCandidate(parsed),
    );
    this.#transition(context, parsed, "PR_REVIEW", "pr_review.started", {
      candidate_sha: this.#requiredCandidate(parsed),
      reviewer_attribution: parsed.policy.identities.prReviewer,
    });
    return this.#completePullRequestReview(
      context,
      this.#admission(context),
      runtime,
    );
  }

  async #completePullRequestReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    return this.#review(context, parsed, "pull-request", runtime);
  }

  async #review(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    reviewKind: "local" | "pull-request",
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    const candidateSha = this.#requiredCandidate(parsed);
    const reviewerAttribution =
      reviewKind === "local"
        ? parsed.policy.identities.localReviewer
        : parsed.policy.identities.prReviewer;
    const invocationId = `review_${sha256Digest({
      run_id: parsed.snapshot.run.runId,
      work_order_id: parsed.snapshot.admission.workOrderId,
      attempt_id: parsed.snapshot.admission.attemptId,
      policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
      candidate_sha: candidateSha,
      review_kind: reviewKind,
      event_seq: parsed.snapshot.latestSequence,
      recovery_restart: (
        reviewKind === "local"
          ? runtime.forceFreshLocalReview
          : runtime.forceFreshPullRequestReview
      )
        ? {
            fencing_generation: context.generation,
            checkpoint_digest: runtime.latestCheckpoint.checkpoint_digest,
          }
        : null,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    if (!identifierSchema.safeParse(invocationId).success) {
      return refuse(
        "review invocation id source returned an invalid identifier",
      );
    }
    const providerRole =
      reviewKind === "local"
        ? ("local-reviewer" as const)
        : ("pr-reviewer" as const);
    const stage =
      reviewKind === "local" ? "local-review" : "pull-request-review";
    let providerCompletion: AsfProviderBudgetCompletion | undefined;
    let providerResultDigest: string | undefined;
    const raw = await this.#effect(
      context,
      parsed,
      stage,
      {
        candidate_sha: candidateSha,
        review_kind: reviewKind,
        invocation_id: invocationId,
        session: "fresh",
      },
      async (input) => {
        const providerBudget = this.#reserveProviderBudget(
          context,
          parsed,
          input,
          providerRole,
          invocationId,
          candidateSha,
        );
        const result = reviewObservationSchema.safeParse(
          await this.#options.reviewer.review({
            ...input,
            candidateSha,
            taskPacketDigest: this.#taskPacketDigest(context.runId),
            reviewKind,
            reviewerAttribution,
            invocationId,
            session: { mode: "fresh" },
            providerBudget,
          }),
        );
        if (!result.success)
          return refuse(`${reviewKind} reviewer returned malformed evidence`);
        assertBinding(
          result.data.binding,
          input.binding,
          `${reviewKind} review observation`,
        );
        if (
          result.data.candidate_sha !== candidateSha ||
          result.data.review_kind !== reviewKind ||
          result.data.reviewer_attribution !== reviewerAttribution ||
          result.data.invocation_id !== invocationId
        ) {
          return refuse(
            `${reviewKind} review is stale or attributed to another reviewer invocation`,
          );
        }
        const execution = assertProviderExecution(
          result.data.provider_execution,
          input.binding,
          providerRole,
          candidateSha,
          invocationId,
        );
        providerCompletion = this.#completeProviderBudget(
          context,
          parsed,
          input,
          providerBudget,
          providerRole,
          invocationId,
          candidateSha,
          execution.result,
        );
        providerResultDigest = execution.result.result_digest;
        return result.data;
      },
    );
    if (providerCompletion?.completedAfterDeadline === true) {
      throw this.#budgetStop(
        "wall-deadline",
        providerResultDigest ?? raw.intent.intent_digest,
      );
    }
    if (providerCompletion?.exceededReservedCost === true) {
      throw this.#budgetStop(
        "cost-limit",
        providerResultDigest ?? raw.intent.intent_digest,
      );
    }
    const checkpoint = this.#transitionWithCheckpoint(
      context,
      parsed,
      reviewKind === "local" ? "LOCAL_REVIEW" : "PR_REVIEW",
      reviewKind === "local" ? "review.completed" : "pr_review.completed",
      {
        candidate_sha: candidateSha,
        reviewer_attribution: reviewerAttribution,
        outcome: raw.observation.outcome,
        findings_digest: raw.observation.findings_digest,
      },
      {
        kind:
          reviewKind === "local"
            ? "local-review-fixer-iteration"
            : "pr-review-fixer-iteration",
        durableInputs: {
          candidate_sha: candidateSha,
          invocation_id: invocationId,
        },
        durableOutputs: {
          outcome: raw.observation.outcome,
          findings_digest: raw.observation.findings_digest,
        },
        correlationMarker: raw.intent.intent_id,
      },
      runtime,
    );
    if (raw.observation.outcome === "blocked") {
      throw new AsfDeliveryStop({
        phase: "BLOCKED_EXTERNAL",
        code: "REVIEW_BLOCKED",
        summary: `${reviewKind} review could not reach a definitive candidate-bound verdict`,
        retryDisposition: "reconcile-first",
        requiredActor: "provider-administrator",
        requiredAction:
          "restore reviewer capacity and restart a fresh reviewer session",
        evidenceRefs: [raw.observation.findings_digest],
      });
    }
    return checkpoint;
  }

  async #afterLocalReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<void> {
    const event = this.#latestEvent(
      context.runId,
      "review.completed",
      this.#requiredCandidate(parsed),
    );
    if (event.payload["outcome"] === "changes-requested") {
      await this.#startFixing(
        context,
        parsed,
        this.#requiredCandidate(parsed),
        runtime,
      );
      return;
    }
    if (event.payload["outcome"] !== "approved") {
      return refuse(
        "local review checkpoint has no approved or fixable verdict",
      );
    }
    this.#transition(context, parsed, "DELIVERY_READY", "delivery.ready", {
      candidate_sha: this.#requiredCandidate(parsed),
      required_remote_checks: parsed.policy.requiredRemoteChecks,
    });
  }

  async #afterPullRequestReview(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint | undefined> {
    const candidateSha = this.#requiredCandidate(parsed);
    const event = this.#latestEvent(
      context.runId,
      "pr_review.completed",
      candidateSha,
    );
    if (event.payload["outcome"] === "changes-requested") {
      await this.#startFixing(context, parsed, candidateSha, runtime);
      return undefined;
    }
    if (event.payload["outcome"] !== "approved") {
      return refuse(
        "pull-request review checkpoint has no approved or fixable verdict",
      );
    }
    const tail = this.#events(context.runId).at(-1);
    let finalCi: DurableFinalCiSnapshot;
    if (tail?.type === "ci.revalidated") {
      finalCi = this.#durableFinalCiSnapshot(context, parsed, tail, event);
    } else {
      const observed = await this.#observeExactHeadCi(context, parsed, {
        purpose: "final-delivery-revalidation",
        confirmIncomplete: true,
      });
      const ciPayload = {
        candidate_sha: candidateSha,
        outcome: observed.outcome,
        observation_intent_digest: observed.intent.intent_digest,
        observation_digest: observed.observation.evidence_digest,
        observation_fencing_generation: observed.intent.fencing_generation,
        checks_digest: observed.checksDigest,
        checks: observed.observation.checks,
        observed_at: observed.observation.observed_at,
      } as const;
      if (observed.outcome === "passed") {
        return this.#transitionWithCheckpoint(
          context,
          parsed,
          "PR_REVIEW",
          "ci.revalidated",
          ciPayload,
          {
            kind: "pr-review-fixer-iteration",
            durableInputs: {
              fresh_review_checkpoint_digest:
                runtime.latestCheckpoint.checkpoint_digest,
              purpose: "final-delivery-revalidation",
              candidate_sha: candidateSha,
              required_contexts: parsed.policy.requiredRemoteChecks,
            },
            durableOutputs: {
              observation_intent_digest: observed.intent.intent_digest,
              observation_digest: observed.observation.evidence_digest,
              observation_fencing_generation:
                observed.intent.fencing_generation,
              checks_digest: observed.checksDigest,
              checks: observed.observation.checks,
              observed_at: observed.observation.observed_at,
            },
            correlationMarker: observed.intent.intent_id,
          },
          runtime,
        );
      }
      const checkpoint = this.#transitionWithCheckpoint(
        context,
        parsed,
        "CI_WAIT",
        "ci.recheck_completed",
        ciPayload,
        {
          kind: "ci-reconciliation-snapshot",
          durableInputs: {
            fresh_review_checkpoint_digest:
              runtime.latestCheckpoint.checkpoint_digest,
            purpose: "final-delivery-revalidation",
            candidate_sha: candidateSha,
            required_contexts: parsed.policy.requiredRemoteChecks,
          },
          durableOutputs: {
            observation_intent_digest: observed.intent.intent_digest,
            observation_digest: observed.observation.evidence_digest,
            observation_fencing_generation:
              observed.intent.fencing_generation,
            checks_digest: observed.checksDigest,
            checks: observed.observation.checks,
            outcome: observed.outcome,
            observed_at: observed.observation.observed_at,
          },
          correlationMarker: observed.intent.intent_id,
        },
        runtime,
      );
      if (
        observed.outcome === "pending" ||
        observed.outcome === "not-scheduled"
      ) {
        throw new AsfPendingCiRetryError({
          runId: context.runId,
          phase: "CI_WAIT",
          candidateSha,
          intentDigest: observed.intent.intent_digest,
          observationDigest: observed.observation.evidence_digest,
          checksDigest: observed.checksDigest,
        });
      }
      return checkpoint;
    }
    const pullRequest = this.#latestPullRequest(context.runId, candidateSha);
    const proposal = await this.#deliveryProposal(context, parsed);
    const expectedBaseSha = parsed.policy.inputs.observedBaseSha.toLowerCase();
    const final = await this.#effect(
      context,
      parsed,
      "pull-request-review",
      {
        operation: "final-pr-delivery-observation",
        repository: parsed.snapshot.run.repo.toLowerCase(),
        pull_request_number: pullRequest.number,
        url: pullRequest.url,
        head_ref: proposal.head_ref,
        base_ref: proposal.base_ref,
        marker: proposal.marker,
        candidate_sha: candidateSha,
        expected_base_sha: expectedBaseSha,
        expected_protection_digest: parsed.policy.inputs.forgeProtection,
      },
      async (input) => {
        let observation: ReturnType<
          typeof parseFinalPullRequestDeliveryObservation
        >;
        try {
          observation = parseFinalPullRequestDeliveryObservation(
            await this.#options.github.observeFinalDelivery({
              runId: input.binding.runId,
              observationKey: input.intent.intent_id,
              repository: parsed.snapshot.run.repo,
              pullRequestNumber: pullRequest.number,
              pullRequestUrl: pullRequest.url,
              headRef: proposal.head_ref,
              baseRef: proposal.base_ref,
              marker: proposal.marker,
              candidateSha,
              expectedBaseSha,
              expectedProtectionDigest: parsed.policy.inputs.forgeProtection,
              requiredContexts: parsed.policy.requiredRemoteChecks,
              draft: proposal.draft,
              signal: input.signal,
            }),
          );
        } catch {
          return refuse(
            "final pull-request delivery observation is missing, unknown, or contradictory",
          );
        }
        const { evidence_digest: evidenceDigest, ...unsignedObservation } =
          observation;
        const observedAt = Date.parse(observation.observed_at);
        if (
          observation.schema !== ASF_FINAL_PR_DELIVERY_OBSERVATION_SCHEMA ||
          sha256Digest(json(unsignedObservation)) !== evidenceDigest ||
          observation.repository.toLowerCase() !==
            parsed.snapshot.run.repo.toLowerCase() ||
          observation.pull_request_number !== pullRequest.number ||
          observation.url !== pullRequest.url ||
          observation.head_ref !== proposal.head_ref ||
          observation.base_ref !== proposal.base_ref ||
          observation.marker !== proposal.marker ||
          observation.head_sha !== candidateSha ||
          observation.current_base_sha !== expectedBaseSha ||
          observation.protection_digest !==
            parsed.policy.inputs.forgeProtection ||
          observation.protection_digest !==
            sha256Digest({
              schema: "runmill.github-base-protection/v1",
              repository: observation.repository.toLowerCase(),
              base_ref: observation.base_ref,
              protection: observation.protection,
            }) ||
          observation.protection.required_checks.length !==
            new Set(observation.protection.required_checks).size ||
          !observation.protection.required_checks.every((context) =>
            parsed.policy.requiredRemoteChecks.includes(context),
          ) ||
          observation.state !== "open" ||
          observation.draft !== proposal.draft ||
          !Number.isFinite(observedAt) ||
          observedAt < Date.parse(event.occurred_at) ||
          observedAt < Date.parse(finalCi.observedAt) ||
          observedAt < Date.parse(finalCi.checkpointedAt) ||
          observedAt > this.#options.clock.now().getTime()
        ) {
          return refuse(
            "final pull-request delivery observation changed after fresh review or is stale",
            [evidenceDigest],
          );
        }
        return observation;
      },
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "PR_DELIVERED",
      "pull_request.delivered",
      {
        candidate_sha: candidateSha,
        repository: final.observation.repository,
        number: final.observation.pull_request_number,
        url: final.observation.url,
        head_ref: final.observation.head_ref,
        base_ref: final.observation.base_ref,
        marker: final.observation.marker,
        head_sha: final.observation.head_sha,
        observed_head_sha: final.observation.head_sha,
        current_base_sha: final.observation.current_base_sha,
        collision_set_digest: final.observation.collision_set_digest,
        base_observation_digest: final.observation.base_observation_digest,
        protection_digest: final.observation.protection_digest,
        protection: final.observation.protection,
        state: final.observation.state,
        draft: final.observation.draft,
        delivery_observation_intent_digest: final.intent.intent_digest,
        delivery_observation_digest: final.observation.evidence_digest,
        observed_at: final.observation.observed_at,
        final_ci_observation_intent_digest:
          finalCi.observationIntentDigest,
        final_ci_observation_digest: finalCi.observationDigest,
        final_ci_observation_fencing_generation:
          finalCi.observationFencingGeneration,
        final_ci_checks_digest: finalCi.checksDigest,
        final_ci_checks: finalCi.checks,
        final_ci_observed_at: finalCi.observedAt,
      },
      {
        kind: "pr-review-fixer-iteration",
        durableInputs: {
          fresh_review_checkpoint_digest:
            runtime.latestCheckpoint.checkpoint_digest,
          observation_intent_digest: final.intent.intent_digest,
          repository: final.observation.repository,
          pull_request_number: final.observation.pull_request_number,
          head_ref: final.observation.head_ref,
          base_ref: final.observation.base_ref,
          marker: final.observation.marker,
          candidate_sha: final.observation.head_sha,
        },
        durableOutputs: {
          observation_digest: final.observation.evidence_digest,
          collision_set_digest: final.observation.collision_set_digest,
          base_observation_digest: final.observation.base_observation_digest,
          current_base_sha: final.observation.current_base_sha,
          protection_digest: final.observation.protection_digest,
          protection: final.observation.protection,
          observed_at: final.observation.observed_at,
          final_ci_observation_intent_digest:
            finalCi.observationIntentDigest,
          final_ci_observation_digest: finalCi.observationDigest,
          final_ci_observation_fencing_generation:
            finalCi.observationFencingGeneration,
          final_ci_checks_digest: finalCi.checksDigest,
          final_ci_checks: finalCi.checks,
          final_ci_observed_at: finalCi.observedAt,
        },
        correlationMarker: final.intent.intent_id,
      },
      runtime,
    );
  }

  async #startFixing(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    candidateSha: string,
    runtime?: RuntimeState,
  ): Promise<void> {
    const fixIterations =
      runtime?.fixIterations ?? this.#countFixIterations(context.runId);
    if (fixIterations >= parsed.policy.budgets.maxFixIterations) {
      throw new AsfDeliveryStop({
        phase: "BUDGET_EXHAUSTED",
        code: "FIX_ITERATION_BUDGET_EXHAUSTED",
        summary: "the admitted fix-iteration budget is exhausted",
        retryDisposition: "new-attempt-required",
        requiredActor: "asf",
        requiredAction:
          "submit a new signed Work Order attempt if more remediation is authorized",
      });
    }
    this.#transition(context, parsed, "FIXING", "fixing.started", {
      candidate_sha: candidateSha,
      iteration: fixIterations + 1,
    });
    if (runtime !== undefined) runtime.fixIterations = fixIterations + 1;
  }

  async #push(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "local-review-fixer-iteration",
      this.#requiredCandidate(parsed),
    );
    const candidateSha = this.#requiredCandidate(parsed);
    const proposal = await this.#deliveryProposal(context, parsed);
    const workspace = await this.#currentWorkspace(context, parsed);
    const expectedRemoteSha = this.#previousPushedCandidate(
      context.runId,
      candidateSha,
    );
    const binding = this.#binding(parsed, context);
    const preparedIntent = this.#intent(context, parsed, "branch-push", {
      repository: parsed.snapshot.run.repo,
      ref: proposal.head_ref,
      candidate_sha: candidateSha,
      expected_remote_sha: expectedRemoteSha,
    });
    const confirmed: ConfirmedBranchEffect =
      await this.#options.github.ensureBranch({
        runId: binding.runId,
        ownerId: this.#options.workerId,
        generation: binding.fencingGeneration,
        candidateSha,
        policyDigest: binding.policyDigest,
        repository: parsed.snapshot.run.repo,
        ref: proposal.head_ref,
        workspacePath: workspace.workspace_path,
        marker: proposal.marker,
        expectedRemoteSha,
        signal: context.signal,
      });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    if (
      confirmed.remoteSha !== candidateSha ||
      confirmed.effect.candidateSha !== candidateSha ||
      confirmed.effect.policyDigest !== binding.policyDigest ||
      confirmed.effect.generation !== binding.fencingGeneration ||
      confirmed.observation.candidateSha !== candidateSha
    ) {
      return refuse(
        "GitHub branch controller did not prove the exact current candidate and fence",
      );
    }
    this.#options.intents.confirm({
      intentId: preparedIntent.intent.intent_id,
      intentDigest: preparedIntent.intent.intent_digest,
      observationDigest: confirmed.observation.detailsDigest,
      binding,
    });
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "PUSHED",
      "branch.pushed",
      {
        candidate_sha: candidateSha,
        remote_ref: proposal.head_ref,
        observed_remote_sha: confirmed.remoteSha,
      },
      {
        kind: "branch-push-intent-observation",
        durableInputs: { intent_digest: preparedIntent.intent.intent_digest },
        durableOutputs: {
          effect_key: confirmed.effect.effectKey,
          observation_digest: confirmed.observation.detailsDigest,
        },
        correlationMarker: confirmed.effect.correlationMarker,
      },
      runtime,
    );
  }

  async #pullRequest(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "branch-push-intent-observation",
      this.#requiredCandidate(parsed),
    );
    const candidateSha = this.#requiredCandidate(parsed);
    const proposal = await this.#deliveryProposal(context, parsed);
    const binding = this.#binding(parsed, context);
    const preparedIntent = this.#intent(context, parsed, "pull-request", {
      repository: parsed.snapshot.run.repo,
      head_ref: proposal.head_ref,
      base_ref: proposal.base_ref,
      marker: proposal.marker,
      candidate_sha: candidateSha,
    });
    const confirmed: ConfirmedPullRequestEffect =
      await this.#options.github.ensurePullRequest({
        runId: binding.runId,
        ownerId: this.#options.workerId,
        generation: binding.fencingGeneration,
        candidateSha,
        policyDigest: binding.policyDigest,
        repository: parsed.snapshot.run.repo,
        headRef: proposal.head_ref,
        baseRef: proposal.base_ref,
        marker: proposal.marker,
        title: proposal.title,
        body: proposal.body,
        draft: proposal.draft,
        signal: context.signal,
      });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    const pullRequest = confirmed.pullRequest;
    if (
      pullRequest.head_sha !== candidateSha ||
      pullRequest.head_ref !== proposal.head_ref ||
      pullRequest.base_ref !== proposal.base_ref ||
      pullRequest.marker !== proposal.marker ||
      confirmed.effect.candidateSha !== candidateSha ||
      confirmed.effect.policyDigest !== binding.policyDigest ||
      confirmed.effect.generation !== binding.fencingGeneration
    ) {
      return refuse(
        "GitHub pull-request controller did not prove the exact marker, head, base, and fence",
      );
    }
    this.#options.intents.confirm({
      intentId: preparedIntent.intent.intent_id,
      intentDigest: preparedIntent.intent.intent_digest,
      observationDigest: confirmed.observation.detailsDigest,
      binding,
    });
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "PR_OPEN",
      "pull_request.opened",
      {
        candidate_sha: candidateSha,
        repository: parsed.snapshot.run.repo,
        number: pullRequest.number,
        url: pullRequest.url,
        observed_head_sha: pullRequest.head_sha,
        base_sha: parsed.envelope.payload.repository.base_sha.toLowerCase(),
      },
      {
        kind: "pull-request-intent-observation",
        durableInputs: { intent_digest: preparedIntent.intent.intent_digest },
        durableOutputs: {
          effect_key: confirmed.effect.effectKey,
          observation_digest: confirmed.observation.detailsDigest,
          pull_request_number: pullRequest.number,
        },
        correlationMarker: confirmed.effect.correlationMarker,
      },
      runtime,
    );
  }

  async #startCi(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<void> {
    this.#transition(context, parsed, "CI_WAIT", "ci.waiting", {
      candidate_sha: this.#requiredCandidate(parsed),
      snapshot_digest: sha256Digest({
        candidate_sha: this.#requiredCandidate(parsed),
        required_contexts: parsed.policy.requiredRemoteChecks,
      }),
    });
  }

  #currentCiOutcome(
    parsed: ParsedAdmission,
  ): "passed" | "failed" | "pending" | "not-scheduled" {
    const candidateSha = this.#requiredCandidate(parsed);
    const event = this.#events(parsed.snapshot.run.runId)
      .filter(
        (candidate) =>
          (candidate.type === "ci.completed" ||
            candidate.type === "ci.recheck_completed") &&
          candidate.payload["candidate_sha"] === candidateSha,
      )
      .at(-1);
    if (event === undefined) {
      return refuse("durable CI checkpoint has no exact candidate observation");
    }
    const checks = event.payload["checks"];
    const outcome = event.payload["outcome"];
    const parsedChecks = ciObservationSchema.shape.checks.safeParse(checks);
    if (
      !parsedChecks.success ||
      (outcome !== "passed" &&
        outcome !== "failed" &&
        outcome !== "pending" &&
        outcome !== "not-scheduled") ||
      event.payload["checks_digest"] !== sha256Digest(json(checks)) ||
      !exactSet(
        parsedChecks.success
          ? parsedChecks.data.map((check) => check.context)
          : [],
        parsed.policy.requiredRemoteChecks,
      )
    ) {
      return refuse("durable CI checkpoint is malformed or context-incomplete");
    }
    const outcomes = parsedChecks.data.map((check) => check.outcome);
    const derived = outcomes.every((value) => value === "passed")
      ? "passed"
      : outcomes.some((value) => value === "failed")
        ? "failed"
        : outcomes.some((value) => value === "not-scheduled")
          ? "not-scheduled"
          : "pending";
    if (derived !== outcome) {
      return refuse("durable CI checkpoint outcome contradicts its exact checks");
    }
    if (event.type === "ci.recheck_completed") {
      const observationIntentDigest =
        event.payload["observation_intent_digest"];
      const observationDigest = event.payload["observation_digest"];
      const observationFencingGeneration =
        event.payload["observation_fencing_generation"];
      const observedAt = event.payload["observed_at"];
      const review = this.#latestEvent(
        parsed.snapshot.run.runId,
        "pr_review.completed",
        candidateSha,
      );
      const pullRequest = this.#latestPullRequest(
        parsed.snapshot.run.runId,
        candidateSha,
      );
      if (
        typeof observationIntentDigest !== "string" ||
        !digestSchema.safeParse(observationIntentDigest).success ||
        typeof observationDigest !== "string" ||
        !digestSchema.safeParse(observationDigest).success ||
        !Number.isSafeInteger(observationFencingGeneration) ||
        (observationFencingGeneration as number) < 1 ||
        (observationFencingGeneration as number) >
          parsed.snapshot.run.generation ||
        typeof observedAt !== "string" ||
        Date.parse(observedAt) < Date.parse(review.occurred_at) ||
        Date.parse(observedAt) > Date.parse(event.occurred_at) ||
        observationDigest !==
          sha256Digest({
            schema: "asf.ci-head-observation/v1",
            binding: {
              run_id: parsed.snapshot.run.runId,
              work_order_id: parsed.snapshot.admission.workOrderId,
              attempt_id: parsed.snapshot.admission.attemptId,
              policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
              fencing_generation: observationFencingGeneration as number,
              candidate_sha: candidateSha,
            },
            repository: parsed.snapshot.run.repo.toLowerCase(),
            pull_request_number: pullRequest.number,
            candidate_sha: candidateSha,
            observed_head_sha: candidateSha,
            observed_at: observedAt,
            checks: parsedChecks.data,
          })
      ) {
        return refuse("durable final CI retry checkpoint is not exact-bound");
      }
    }
    return outcome;
  }

  async #observeExactHeadCi(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    input: {
      readonly purpose: "review-gate" | "final-delivery-revalidation";
      readonly confirmIncomplete: boolean;
    },
  ): Promise<ExactHeadCiResult> {
    const candidateSha = this.#requiredCandidate(parsed);
    const pullRequest = this.#latestPullRequest(context.runId, candidateSha);
    const binding = this.#binding(parsed, context);
    const prepared = this.#intent(context, parsed, "ci", {
      purpose: input.purpose,
      repository: parsed.snapshot.run.repo.toLowerCase(),
      pull_request_number: pullRequest.number,
      candidate_sha: candidateSha,
      required_contexts: parsed.policy.requiredRemoteChecks,
    });
    const result = ciObservationSchema.safeParse(
      await this.#options.ci.observeExactHead({
        binding,
        intent: prepared.intent,
        intentMode: prepared.mode,
        signal: context.signal,
        repository: parsed.snapshot.run.repo,
        pullRequestNumber: pullRequest.number,
        candidateSha,
        requiredContexts: parsed.policy.requiredRemoteChecks,
      }),
    );
    if (!result.success) {
      return refuse("CI controller returned malformed head observation");
    }
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    assertBinding(result.data.binding, binding, "CI observation");
    const { evidence_digest: evidenceDigest, ...unsignedObservation } =
      result.data;
    const observedAt = Date.parse(result.data.observed_at);
    if (
      evidenceDigest !== sha256Digest(json(unsignedObservation)) ||
      result.data.repository.toLowerCase() !==
        parsed.snapshot.run.repo.toLowerCase() ||
      result.data.pull_request_number !== pullRequest.number ||
      result.data.candidate_sha !== candidateSha ||
      result.data.observed_head_sha !== candidateSha ||
      !Number.isFinite(observedAt) ||
      observedAt < Date.parse(prepared.intent.created_at) ||
      observedAt > this.#options.clock.now().getTime() ||
      !exactSet(
        result.data.checks.map((check) => check.context),
        parsed.policy.requiredRemoteChecks,
      )
    ) {
      return refuse(
        "CI observation is stale, non-canonical, or does not cover the exact required contexts",
        [evidenceDigest],
      );
    }
    const outcomes = result.data.checks.map((check) => check.outcome);
    const outcome = outcomes.every((value) => value === "passed")
      ? "passed"
      : outcomes.some((value) => value === "failed")
        ? "failed"
        : outcomes.some((value) => value === "not-scheduled")
          ? "not-scheduled"
          : "pending";
    const checksDigest = sha256Digest(result.data.checks);
    if (input.confirmIncomplete || outcome === "passed" || outcome === "failed") {
      this.#options.intents.confirm({
        intentId: prepared.intent.intent_id,
        intentDigest: prepared.intent.intent_digest,
        observationDigest: evidenceDigest,
        binding,
      });
    }
    return {
      intent: prepared.intent,
      observation: result.data,
      checksDigest,
      outcome,
    };
  }

  #durableFinalCiSnapshot(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    event: RunEvent,
    reviewEvent: RunEvent,
  ): DurableFinalCiSnapshot {
    const candidateSha = this.#requiredCandidate(parsed);
    const pullRequest = this.#latestPullRequest(context.runId, candidateSha);
    const rawChecks = event.payload["checks"];
    const observationIntentDigest = event.payload["observation_intent_digest"];
    const observationDigest = event.payload["observation_digest"];
    const observationFencingGeneration =
      event.payload["observation_fencing_generation"];
    const checksDigest = event.payload["checks_digest"];
    const observedAt = event.payload["observed_at"];
    if (
      event.type !== "ci.revalidated" ||
      event.phase !== "PR_REVIEW" ||
      event.seq !== parsed.snapshot.latestSequence ||
      event.payload["candidate_sha"] !== candidateSha ||
      event.payload["outcome"] !== "passed" ||
      !Array.isArray(rawChecks) ||
      typeof observationIntentDigest !== "string" ||
      !digestSchema.safeParse(observationIntentDigest).success ||
      typeof observationDigest !== "string" ||
      !digestSchema.safeParse(observationDigest).success ||
      !Number.isSafeInteger(observationFencingGeneration) ||
      (observationFencingGeneration as number) < 1 ||
      (observationFencingGeneration as number) > context.generation ||
      typeof checksDigest !== "string" ||
      checksDigest !== sha256Digest(json(rawChecks)) ||
      typeof observedAt !== "string" ||
      Date.parse(observedAt) < Date.parse(reviewEvent.occurred_at) ||
      Date.parse(observedAt) > Date.parse(event.occurred_at)
    ) {
      return refuse("durable final CI revalidation is malformed, stale, or contradictory");
    }
    const checks = ciObservationSchema.shape.checks.safeParse(rawChecks);
    if (
      !checks.success ||
      checks.data.some((check) => check.outcome !== "passed") ||
      !exactSet(
        checks.data.map((check) => check.context),
        parsed.policy.requiredRemoteChecks,
      )
    ) {
      return refuse("durable final CI revalidation is not exactly passing");
    }
    const expectedObservationDigest = sha256Digest({
      schema: "asf.ci-head-observation/v1",
      binding: {
        run_id: parsed.snapshot.run.runId,
        work_order_id: parsed.snapshot.admission.workOrderId,
        attempt_id: parsed.snapshot.admission.attemptId,
        policy_digest: parsed.snapshot.admission.effectivePolicyDigest,
        fencing_generation: observationFencingGeneration as number,
        candidate_sha: candidateSha,
      },
      repository: parsed.snapshot.run.repo.toLowerCase(),
      pull_request_number: pullRequest.number,
      candidate_sha: candidateSha,
      observed_head_sha: candidateSha,
      observed_at: observedAt,
      checks: checks.data,
    });
    if (observationDigest !== expectedObservationDigest) {
      return refuse("durable final CI observation digest is not exact-bound");
    }
    return {
      observationIntentDigest,
      observationDigest,
      observationFencingGeneration: observationFencingGeneration as number,
      checksDigest,
      checks: checks.data,
      observedAt,
      checkpointedAt: event.occurred_at,
    };
  }

  async #completeCi(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    _runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    const candidateSha = this.#requiredCandidate(parsed);
    const pullRequest = this.#latestPullRequest(context.runId, candidateSha);
    const raw = await this.#observeExactHeadCi(context, parsed, {
      purpose: "review-gate",
      confirmIncomplete: true,
    });
    const checkpoint = this.#transitionWithCheckpoint(
      context,
      parsed,
      "CI_WAIT",
      "ci.completed",
      {
        candidate_sha: candidateSha,
        outcome: raw.outcome,
        checks_digest: raw.checksDigest,
        checks: raw.observation.checks,
        observed_at: raw.observation.observed_at,
      },
      {
        kind: "ci-reconciliation-snapshot",
        durableInputs: {
          candidate_sha: candidateSha,
          pull_request_number: pullRequest.number,
        },
        durableOutputs: {
          observation_intent_digest: raw.intent.intent_digest,
          observation_digest: raw.observation.evidence_digest,
          checks_digest: raw.checksDigest,
          outcome: raw.outcome,
          observed_at: raw.observation.observed_at,
        },
        correlationMarker: raw.intent.intent_id,
      },
      _runtime,
    );
    const current = this.#admission(context);
    if (raw.outcome === "failed")
      await this.#startFixing(context, current, candidateSha);
    if (raw.outcome === "pending" || raw.outcome === "not-scheduled") {
      throw new AsfPendingCiRetryError({
        runId: context.runId,
        phase: "CI_WAIT",
        candidateSha,
        intentDigest: raw.intent.intent_digest,
        observationDigest: raw.observation.evidence_digest,
        checksDigest: raw.checksDigest,
      });
    }
    return checkpoint;
  }

  async #evidence(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "pr-review-fixer-iteration",
      this.#requiredCandidate(parsed),
    );
    const binding = this.#binding(parsed, context);
    const preparedIntent = this.#intent(context, parsed, "evidence", {
      candidate_sha: binding.candidateSha,
      policy_digest: binding.policyDigest,
    });
    const validated = await this.#options.evidence.finalize({
      binding,
      intent: preparedIntent.intent,
      intentMode: preparedIntent.mode,
      signal: context.signal,
      snapshot: parsed.snapshot,
      envelope: parsed.envelope,
      effectivePolicy: parsed.policy,
      events: this.#events(context.runId),
    });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, binding);
    const predicate = validated.bundle.statement.predicate;
    if (
      validated.candidateSha !== binding.candidateSha ||
      predicate.run.run_id !== binding.runId ||
      predicate.run.work_order_id !== binding.workOrderId ||
      predicate.run.attempt_id !== binding.attemptId ||
      predicate.policy.effective_policy_digest !== binding.policyDigest ||
      predicate.source.candidate_sha !== binding.candidateSha ||
      predicate.source.remote_head_sha !== binding.candidateSha
    ) {
      return refuse(
        "final evidence bundle is not exact-bound to the delivered candidate and policy",
      );
    }
    const stored: {
      readonly record: AsfEvidenceBundleRecord;
      readonly created: boolean;
    } = this.#options.store.recordAsfEvidenceBundle({
      validated,
      ownerId: this.#options.workerId,
      generation: context.generation,
    });
    if (
      stored.record.bundleDigest !== validated.bundleDigest ||
      stored.record.candidateSha !== binding.candidateSha ||
      stored.record.policyDigest !== binding.policyDigest
    ) {
      return refuse(
        "evidence store returned a contradictory immutable bundle record",
      );
    }
    this.#options.intents.confirm({
      intentId: preparedIntent.intent.intent_id,
      intentDigest: preparedIntent.intent.intent_digest,
      observationDigest: validated.bundleDigest,
      binding,
    });
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "EVIDENCE_FINALIZED",
      "evidence.finalized",
      {
        candidate_sha: this.#requiredCandidate(parsed),
        bundle_digest: validated.bundleDigest,
      },
      {
        kind: "evidence-finalization-acknowledgement",
        durableInputs: { candidate_sha: binding.candidateSha },
        durableOutputs: { bundle_digest: validated.bundleDigest },
        correlationMarker: preparedIntent.intent.intent_id,
      },
      runtime,
    );
  }

  async #complete(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<DurableAsfCheckpoint> {
    this.#requirePriorCheckpoint(
      runtime,
      "evidence-finalization-acknowledgement",
      this.#requiredCandidate(parsed),
    );
    const evidenceEvent = this.#latestEvent(
      context.runId,
      "evidence.finalized",
      this.#requiredCandidate(parsed),
    );
    const actualBundleDigest = evidenceEvent.payload["bundle_digest"];
    if (
      typeof actualBundleDigest !== "string" ||
      !digestSchema.safeParse(actualBundleDigest).success
    ) {
      return refuse("final evidence event has no valid bundle digest");
    }
    const stop: AsfTerminalStopEvidence = {
      code: "PR_DELIVERED",
      summary:
        "the exact reviewed candidate was delivered as an open pull request",
      interruptedPhase: parsed.snapshot.run.state,
      retryDisposition: "safe",
      requiredActor: "asf",
      requiredAction:
        "acknowledge the immutable post-cleanup terminal evidence",
      evidenceRefs: [actualBundleDigest],
    };
    const cleanup = await this.#performTerminalCleanup(
      context,
      parsed,
      "COMPLETED",
      stop,
      actualBundleDigest,
      "completed",
    );
    const terminalEvidence = await this.#finalizeTerminalEvidence(
      context,
      parsed,
    );
    return this.#transitionWithCheckpoint(
      context,
      parsed,
      "COMPLETED",
      "run.completed",
      {
        candidate_sha: this.#requiredCandidate(parsed),
        closure_target: "pr",
        satisfied: true,
        evidence_bundle_digest: actualBundleDigest,
        terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
      },
      {
        kind: "lease-release-workspace-cleanup",
        durableInputs: {
          terminal_outcome: "completed",
          evidence_checkpoint: runtime.latestCheckpoint.checkpoint_digest,
        },
        durableOutputs: {
          bundle_digest: actualBundleDigest,
          cleanup_evidence_digest: cleanup.observation.evidence_digest,
          terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
        },
        correlationMarker: cleanup.intent.intent_id,
      },
    );
  }

  async #ensureTerminalEvidence(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    runtime: RuntimeState,
  ): Promise<void> {
    if (
      !this.#checkpointIsCurrent(
        runtime.latestCheckpoint,
        parsed,
        "lease-release-workspace-cleanup",
      )
    ) {
      return refuse(
        `terminal ${parsed.snapshot.run.state} run lacks the atomic lease-release/workspace-cleanup checkpoint`,
      );
    }
    const record = this.#options.store.getAsfTerminalEvidenceBundleRecord(
      context.runId,
    );
    const bundle = this.#options.store.getAsfTerminalEvidenceBundle(
      context.runId,
    );
    const latest = this.#events(context.runId).at(-1);
    if (
      record === undefined ||
      bundle === undefined ||
      latest === undefined ||
      record.runId !== context.runId ||
      record.terminalPhase !== parsed.snapshot.run.state ||
      record.terminalEventSeq !== parsed.snapshot.latestSequence ||
      record.candidateSha !== parsed.snapshot.run.candidateSha ||
      record.policyDigest !== parsed.snapshot.admission.effectivePolicyDigest ||
      bundle.bundle_digest !== record.bundleDigest ||
      bundle.statement.predicate.run.terminal_phase !==
        parsed.snapshot.run.state ||
      bundle.statement.predicate.run.terminal_event_seq !== latest.seq ||
      latest.payload["terminal_evidence_bundle_digest"] !== record.bundleDigest
    ) {
      return refuse(
        `terminal ${parsed.snapshot.run.state} run lacks exact signed post-cleanup evidence`,
      );
    }
  }

  async #finishPendingTerminalPlan(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<void> {
    const planRecord = this.#options.store.getAsfTerminalEvidencePlanRecord(
      context.runId,
    );
    const plan = this.#options.store.getAsfTerminalEvidencePlan(context.runId);
    if (planRecord === undefined || plan === undefined) {
      return refuse("pending terminal cleanup plan is missing canonical protected bytes");
    }
    if (
      planRecord.planDigest !== plan.plan_digest ||
      planRecord.terminalPhase !== plan.run.terminal_phase ||
      planRecord.terminalEventSeq !== parsed.snapshot.latestSequence + 1 ||
      planRecord.candidateSha !== parsed.snapshot.run.candidateSha ||
      planRecord.policyDigest !==
        parsed.snapshot.admission.effectivePolicyDigest ||
      plan.run.run_id !== context.runId ||
      plan.run.work_order_id !== parsed.snapshot.admission.workOrderId ||
      plan.run.attempt_id !== parsed.snapshot.admission.attemptId ||
      plan.admission.work_order_envelope_digest !==
        parsed.snapshot.admission.envelopeDigest ||
      plan.admission.work_order_payload_digest !==
        parsed.snapshot.admission.payloadDigest ||
      plan.admission.effective_policy_digest !==
        parsed.snapshot.admission.effectivePolicyDigest ||
      plan.source.repository !== parsed.snapshot.run.repo.toLowerCase() ||
      plan.source.base_sha !== parsed.snapshot.run.baseCommit ||
      plan.source.candidate_sha !== parsed.snapshot.run.candidateSha ||
      canonicalJson(plan.side_effects) !==
        canonicalJson(
          this.#options.store.prepareAsfTerminalEffectLedger({
            runId: context.runId,
          }),
        ) ||
      plan.delivery_bundle_digest !== planRecord.deliveryBundleDigest
    ) {
      return refuse(
        "pending terminal cleanup plan contradicts the current admission, cursor, or candidate",
      );
    }

    let terminalIntent =
      this.#options.store.getAsfTerminalEvidenceIntent(context.runId);
    if (terminalIntent === undefined) {
      const cleanupIntent = this.#options.store.getAsfDeliveryIntentById(
        planRecord.cleanupIntentId,
      );
      if (
        cleanupIntent === undefined ||
        cleanupIntent.stage !== "cleanup" ||
        cleanupIntent.intent_digest !== planRecord.cleanupIntentDigest ||
        cleanupIntent.operation_digest !== plan.plan_digest ||
        cleanupIntent.run_id !== context.runId ||
        cleanupIntent.work_order_id !== parsed.snapshot.admission.workOrderId ||
        cleanupIntent.attempt_id !== parsed.snapshot.admission.attemptId ||
        cleanupIntent.policy_digest !==
          parsed.snapshot.admission.effectivePolicyDigest ||
        cleanupIntent.candidate_sha !== parsed.snapshot.run.candidateSha ||
        cleanupIntent.fencing_generation > context.generation ||
        cleanupIntent.observationDigest !== null ||
        cleanupIntent.observationOutcome !== null ||
        cleanupIntent.confirmedGeneration !== null ||
        cleanupIntent.confirmedAt !== null
      ) {
        return refuse(
          "pending terminal cleanup plan has no exact unresolved cleanup authorization",
        );
      }
      const terminalOutcome =
        plan.run.terminal_phase === "COMPLETED"
          ? "completed"
          : plan.run.terminal_phase === "CANCELLED"
            ? "cancelled"
            : plan.run.terminal_phase === "FAILED"
              ? "failed"
              : "stopped";
      const binding = this.#binding(parsed, context);
      const observation = cleanupObservationSchema.safeParse(
        await this.#options.cleanup.cleanup({
          binding,
          intent: portableDeliveryStageIntent(cleanupIntent),
          intentMode: "reconcile-only",
          signal: context.signal,
          terminalOutcome,
        }),
      );
      if (!observation.success) {
        return refuse(
          "pending terminal cleanup reconciliation did not prove complete release",
        );
      }
      assertBinding(observation.data.binding, binding, "cleanup observation");
      this.#throwIfAborted(context.signal);
      this.#assertFence(context, binding);
      const sealed = this.#options.intents.sealTerminal({
        runId: context.runId,
        planDigest: plan.plan_digest,
        cleanupObservation: observation.data,
        generation: context.generation,
      });
      terminalIntent = sealed.intent;
    }
    if (
      terminalIntent.plan_digest !== plan.plan_digest ||
      terminalIntent.run.terminal_phase !== plan.run.terminal_phase ||
      canonicalJson(terminalIntent.stop) !== canonicalJson(plan.stop) ||
      canonicalJson(terminalIntent.side_effects) !==
        canonicalJson(plan.side_effects)
    ) {
      return refuse("sealed terminal evidence intent contradicts its immutable plan");
    }
    if (
      this.#options.store.getAsfTerminalEvidenceBundleRecord(context.runId) ===
      undefined
    ) {
      await this.#finalizeTerminalEvidence(context, parsed);
    } else {
      this.#options.store.getAsfTerminalEvidenceBundle(context.runId);
    }
    this.#finishPendingTerminalEvidence(context, parsed);
  }

  #finishPendingTerminalEvidence(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): void {
    const record = this.#options.store.getAsfTerminalEvidenceBundleRecord(
      context.runId,
    );
    const bundle = this.#options.store.getAsfTerminalEvidenceBundle(
      context.runId,
    );
    if (record === undefined || bundle === undefined) {
      return refuse("pending terminal evidence record is missing canonical signed bytes");
    }
    const predicate = bundle.statement.predicate;
    const events = this.#events(context.runId);
    const delivery = this.#options.store.getAsfEvidenceBundleRecord(
      context.runId,
    );
    const expectedSubject =
      parsed.snapshot.run.candidateSha ?? parsed.snapshot.run.baseCommit;
    const observationsMatch =
      predicate.evidence.observations.length === events.length &&
      predicate.evidence.observations.every((observation, index) => {
        const event = events[index];
        if (event === undefined) return false;
        const candidate = event.payload["candidate_sha"];
        return (
          observation.event_seq === event.seq &&
          observation.event_type === event.type &&
          observation.phase === event.phase &&
          observation.candidate_sha ===
            (typeof candidate === "string" &&
            gitShaSchema.safeParse(candidate).success
              ? candidate
              : null) &&
          observation.event_digest === sha256Digest(event)
        );
      });
    if (
      record.runId !== context.runId ||
      record.terminalEventSeq !== parsed.snapshot.latestSequence + 1 ||
      record.candidateSha !== parsed.snapshot.run.candidateSha ||
      record.policyDigest !== parsed.snapshot.admission.effectivePolicyDigest ||
      record.bundleDigest !== bundle.bundle_digest ||
      record.bundleDigest !== sha256Digest(bundle.statement) ||
      record.cleanupIntentId !== predicate.cleanup.intent_id ||
      record.cleanupIntentDigest !== predicate.cleanup.intent_digest ||
      record.cleanupDigest !== predicate.cleanup.observation_digest ||
      record.deliveryBundleDigest !==
        predicate.evidence.delivery_bundle_digest ||
      predicate.run.run_id !== context.runId ||
      predicate.run.work_order_id !== parsed.snapshot.admission.workOrderId ||
      predicate.run.attempt_id !== parsed.snapshot.admission.attemptId ||
      predicate.run.terminal_phase !== record.terminalPhase ||
      predicate.run.terminal_event_seq !== record.terminalEventSeq ||
      predicate.admission.work_order_envelope_digest !==
        parsed.snapshot.admission.envelopeDigest ||
      predicate.admission.work_order_payload_digest !==
        parsed.snapshot.admission.payloadDigest ||
      predicate.admission.effective_policy_digest !==
        parsed.snapshot.admission.effectivePolicyDigest ||
      predicate.source.repository !== parsed.snapshot.run.repo.toLowerCase() ||
      predicate.source.base_sha !== parsed.snapshot.run.baseCommit ||
      predicate.source.candidate_sha !== parsed.snapshot.run.candidateSha ||
      predicate.source.subject_sha !== expectedSubject ||
      predicate.cleanup.identity_leases !== "released" ||
      predicate.cleanup.repository_lease !== "released" ||
      predicate.cleanup.workspace !== "removed" ||
      predicate.cleanup.unresolved_effects !== 0 ||
      predicate.evidence.preceding_event_count !== events.length ||
      predicate.evidence.preceding_event_chain_digest !== sha256Digest(events) ||
      !observationsMatch ||
      (record.deliveryBundleDigest !== null &&
        record.deliveryBundleDigest !== delivery?.bundleDigest) ||
      (record.terminalPhase === "COMPLETED" && delivery === undefined)
    ) {
      return refuse(
        "pending terminal evidence is not exact-bound to admission, lifecycle, candidate, cleanup, and delivery evidence",
      );
    }

    const terminalDigest = record.bundleDigest;
    let eventType: string;
    let payload: Readonly<Record<string, unknown>>;
    if (record.terminalPhase === "COMPLETED") {
      if (
        parsed.snapshot.run.candidateSha === null ||
        record.deliveryBundleDigest === null
      ) {
        return refuse("pending completion evidence has no exact delivered candidate");
      }
      eventType = "run.completed";
      payload = {
        candidate_sha: parsed.snapshot.run.candidateSha,
        closure_target: "pr",
        satisfied: true,
        evidence_bundle_digest: record.deliveryBundleDigest,
        terminal_evidence_bundle_digest: terminalDigest,
      };
    } else if (record.terminalPhase === "CANCELLED") {
      const cancellation = predicate.cancellation;
      const cancellationEvent =
        cancellation === null
          ? undefined
          : events.find(
              (event) => sha256Digest(event) === cancellation.event_digest,
            );
      if (
        cancellation === null ||
        cancellationEvent === undefined ||
        cancellationEvent.type !== cancellation.event_type ||
        cancellationEvent.occurred_at !== cancellation.requested_at ||
        cancellationEvent.payload["request_id"] !== cancellation.request_id ||
        cancellationEvent.payload["requester"] !==
          cancellation.requester_subject ||
        cancellationEvent.payload["reason"] !==
          `protected:${cancellation.reason_digest}` ||
        cancellationEvent.payload["mode"] !== cancellation.mode ||
        cancellationEvent.payload["grace_seconds"] !==
          cancellation.grace_seconds
      ) {
        return refuse(
          "pending cancellation evidence has no exact durable cancellation request",
        );
      }
      eventType = "run.cancelled";
      payload = {
        code: predicate.stop.code,
        summary: predicate.stop.summary,
        checkpoint: predicate.stop.interrupted_phase,
        retry_disposition: predicate.stop.retry_disposition,
        required_actor: predicate.stop.required_actor,
        required_action: predicate.stop.required_action,
        evidence_refs: predicate.stop.evidence_refs,
        ...(record.candidateSha === null
          ? {}
          : { candidate_sha: record.candidateSha }),
        request_id: cancellation.request_id,
        requester: cancellation.requester_subject,
        reason: `protected:${cancellation.reason_digest}`,
        mode: cancellation.mode,
        grace_seconds: cancellation.grace_seconds,
        terminal_evidence_bundle_digest: terminalDigest,
      };
    } else {
      eventType = eventTypeForStop(record.terminalPhase);
      payload = {
        code: predicate.stop.code,
        summary: predicate.stop.summary,
        checkpoint: predicate.stop.interrupted_phase,
        retry_disposition: predicate.stop.retry_disposition,
        required_actor: predicate.stop.required_actor,
        required_action: predicate.stop.required_action,
        evidence_refs: predicate.stop.evidence_refs,
        ...(record.candidateSha === null
          ? {}
          : { candidate_sha: record.candidateSha }),
        terminal_evidence_bundle_digest: terminalDigest,
      };
    }
    this.#transitionWithCheckpoint(
      context,
      parsed,
      record.terminalPhase,
      eventType,
      payload,
      {
        kind: "lease-release-workspace-cleanup",
        durableInputs: {
          terminal_outcome: record.terminalPhase.toLowerCase(),
          recovered_terminal_evidence: terminalDigest,
        },
        durableOutputs: {
          cleanup_evidence_digest: record.cleanupDigest,
          terminal_evidence_bundle_digest: terminalDigest,
          ...(record.deliveryBundleDigest === null
            ? {}
            : { bundle_digest: record.deliveryBundleDigest }),
        },
        correlationMarker: record.cleanupIntentId,
      },
    );
  }

  async #finalizeTerminalEvidence(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<AsfTerminalEvidenceBundleRecord> {
    const terminalIntent = this.#options.store.getAsfTerminalEvidenceIntent(
      context.runId,
    );
    const terminalIntentRecord =
      this.#options.store.getAsfTerminalEvidenceIntentRecord(context.runId);
    if (terminalIntent === undefined || terminalIntentRecord === undefined) {
      return refuse("terminal evidence intent has not sealed confirmed cleanup");
    }
    const cleanupIntent = this.#options.store.getAsfDeliveryIntentById(
      terminalIntent.cleanup.intent_id,
    );
    if (
      cleanupIntent === undefined ||
      cleanupIntent.observationOutcome !== "confirmed" ||
      cleanupIntent.observationDigest !==
        terminalIntent.cleanup.observation.evidence_digest ||
      cleanupIntent.confirmedGeneration === null ||
      terminalIntentRecord.planDigest !== terminalIntent.plan_digest
    ) {
      return refuse(
        "terminal evidence intent is not exact-bound to durable confirmed cleanup",
      );
    }
    const terminalPhase = terminalIntent.run.terminal_phase;
    const stop: AsfTerminalStopEvidence = {
      code: terminalIntent.stop.code,
      summary: terminalIntent.stop.summary,
      interruptedPhase: terminalIntent.stop.interrupted_phase,
      retryDisposition: terminalIntent.stop.retry_disposition,
      requiredActor: terminalIntent.stop.required_actor,
      requiredAction: terminalIntent.stop.required_action,
      evidenceRefs: terminalIntent.stop.evidence_refs,
    };
    const deliveryBundleDigest = terminalIntent.delivery_bundle_digest;
    const validated = await this.#options.terminalEvidence.finalizeTerminal({
      binding: this.#binding(parsed, context),
      cleanupIntent: portableDeliveryStageIntent(cleanupIntent),
      cleanupConfirmedGeneration: cleanupIntent.confirmedGeneration,
      intentMode:
        cleanupIntent.fencing_generation === context.generation
          ? "observe-before-apply"
          : "reconcile-only",
      cleanup: terminalIntent.cleanup.observation,
      terminalIntentCreatedAt: terminalIntent.created_at,
      snapshot: parsed.snapshot,
      envelope: parsed.envelope,
      effectivePolicy: parsed.policy,
      providerBudget: terminalIntent.provider_budget,
      sideEffects: terminalIntent.side_effects,
      events: this.#events(context.runId),
      terminalPhase,
      stop,
      deliveryBundleDigest,
      signal: context.signal,
    });
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, this.#binding(parsed, context));
    if (
      validated.terminalPhase !== terminalPhase ||
      validated.candidateSha !== parsed.snapshot.run.candidateSha ||
      validated.terminalEventSeq !== parsed.snapshot.latestSequence + 1 ||
      validated.bundle.statement.predicate.cleanup.observation_digest !==
        terminalIntent.cleanup.observation.evidence_digest ||
      validated.bundle.statement.predicate.evidence.delivery_bundle_digest !==
        deliveryBundleDigest ||
      canonicalJson(
        validated.bundle.statement.predicate.budget.provider_usage,
      ) !== canonicalJson(terminalIntent.provider_budget) ||
      canonicalJson(validated.bundle.statement.predicate.side_effects) !==
        canonicalJson(terminalIntent.side_effects) ||
      validated.bundle.statement.predicate.timing.terminal_evidence_at !==
        terminalIntent.created_at
    ) {
      return refuse(
        "terminal evidence is not exact-bound to the intended outcome and confirmed cleanup",
      );
    }
    const stored = this.#options.store.recordAsfTerminalEvidenceBundle({
      validated,
      ownerId: this.#options.workerId,
      generation: context.generation,
    });
    if (
      stored.record.bundleDigest !== validated.bundleDigest ||
      stored.record.terminalPhase !== terminalPhase ||
      stored.record.terminalEventSeq !== parsed.snapshot.latestSequence + 1 ||
      stored.record.cleanupDigest !==
        terminalIntent.cleanup.observation.evidence_digest
    ) {
      return refuse(
        "terminal evidence store returned a contradictory immutable record",
      );
    }
    return stored.record;
  }

  #terminalEvidencePlan(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    terminalPhase:
      | "COMPLETED"
      | "CANCELLED"
      | "FAILED"
      | "REFUSED"
      | "QUARANTINED"
      | "BUDGET_EXHAUSTED",
    stop: AsfTerminalStopEvidence,
    deliveryBundleDigest: string | null,
  ): AsfTerminalEvidencePlan {
    const baseSha = parsed.snapshot.run.baseCommit;
    if (baseSha === null) return refuse("terminal evidence plan has no admitted base commit");
    const unsigned = {
      schema: ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
      run: {
        run_id: context.runId,
        work_order_id: parsed.snapshot.admission.workOrderId,
        attempt_id: parsed.snapshot.admission.attemptId,
        terminal_phase: terminalPhase,
        terminal_event_seq: parsed.snapshot.latestSequence + 1,
      },
      admission: {
        work_order_envelope_digest: parsed.snapshot.admission.envelopeDigest,
        work_order_payload_digest: parsed.snapshot.admission.payloadDigest,
        effective_policy_digest:
          parsed.snapshot.admission.effectivePolicyDigest,
      },
      source: {
        repository: parsed.snapshot.run.repo.toLowerCase(),
        base_sha: baseSha,
        candidate_sha: parsed.snapshot.run.candidateSha,
      },
      stop: {
        code: stop.code,
        summary: stop.summary,
        interrupted_phase: stop.interruptedPhase,
        retry_disposition: stop.retryDisposition,
        required_actor: stop.requiredActor,
        required_action: stop.requiredAction,
        evidence_refs: [...new Set(stop.evidenceRefs)].sort(),
      },
      provider_budget: portableAsfTerminalProviderBudgetEvidence(
        this.#options.store.prepareAsfTerminalProviderBudgetEvidence({
          runId: context.runId,
          ownerId: this.#options.workerId,
          generation: context.generation,
        }),
      ),
      side_effects: this.#options.store.prepareAsfTerminalEffectLedger({
        runId: context.runId,
      }),
      cleanup: {
        identity_leases: "released",
        repository_lease: "released",
        workspace: "removed",
        unresolved_effects: 0,
      },
      delivery_bundle_digest: deliveryBundleDigest,
      created_at: this.#options.clock.now().toISOString(),
    } as const;
    return asfTerminalEvidencePlanSchema.parse({
      ...unsigned,
      plan_digest: sha256Digest(unsigned),
    });
  }

  async #performTerminalCleanup(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
    terminalPhase:
      | "COMPLETED"
      | "CANCELLED"
      | "FAILED"
      | "REFUSED"
      | "QUARANTINED"
      | "BUDGET_EXHAUSTED",
    stop: AsfTerminalStopEvidence,
    deliveryBundleDigest: string | null,
    outcome: "completed" | "cancelled" | "failed" | "stopped",
  ): Promise<{
    readonly intent: AsfDeliveryStageIntent;
    readonly observation: z.infer<typeof cleanupObservationSchema>;
  }> {
    const plan = this.#terminalEvidencePlan(
      context,
      parsed,
      terminalPhase,
      stop,
      deliveryBundleDigest,
    );
    const { plan_digest: planDigest, ...unsignedPlan } = plan;
    const prepared = this.#intent(
      context,
      parsed,
      "cleanup",
      unsignedPlan,
      plan,
    );
    if (prepared.intent.operation_digest !== planDigest) {
      return refuse("cleanup authorization does not bind the terminal plan digest");
    }
    const result = cleanupObservationSchema.safeParse(
      await this.#options.cleanup.cleanup({
        binding: this.#binding(parsed, context),
        intent: prepared.intent,
        intentMode: prepared.mode,
        signal: context.signal,
        terminalOutcome: outcome,
      }),
    );
    if (!result.success) {
      return refuse("cleanup controller did not prove complete resource release");
    }
    assertBinding(
      result.data.binding,
      this.#binding(parsed, context),
      "cleanup observation",
    );
    this.#throwIfAborted(context.signal);
    this.#assertFence(context, this.#binding(parsed, context));
    const sealed = this.#options.intents.sealTerminal({
      runId: context.runId,
      planDigest,
      cleanupObservation: result.data,
      generation: context.generation,
    });
    if (
      sealed.record.planDigest !== planDigest ||
      sealed.record.cleanupDigest !== result.data.evidence_digest ||
      sealed.intent.plan_digest !== planDigest ||
      canonicalJson(sealed.intent.cleanup.observation) !== canonicalJson(result.data)
    ) {
      return refuse("terminal cleanup seal returned contradictory protected state");
    }
    return { intent: prepared.intent, observation: result.data };
  }

  async #finishCancellation(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<void> {
    const events = this.#events(context.runId);
    const latest = events.at(-1);
    const effective = events
      .filter(
        (event) =>
          event.type === "cancellation.requested" ||
          event.type === "cancellation.escalated",
      )
      .at(-1);
    const resumedReconciliation = latest?.payload["reconciliation"];
    const interruptedCancellation =
      typeof resumedReconciliation === "object" &&
      resumedReconciliation !== null &&
      !Array.isArray(resumedReconciliation) &&
      typeof (resumedReconciliation as Record<string, unknown>)[
        "interrupted_event_seq"
      ] === "number"
        ? events.find(
            (event) =>
              event.seq ===
              (resumedReconciliation as Record<string, unknown>)[
                "interrupted_event_seq"
              ],
          )
        : undefined;
    const exactCancellationResume =
      latest?.type === "run.resumed" &&
      latest.phase === "CANCELLING" &&
      latest.payload["interrupted_phase"] === "BLOCKED_EXTERNAL" &&
      latest.payload["resume_phase"] === "CANCELLING" &&
      typeof resumedReconciliation === "object" &&
      resumedReconciliation !== null &&
      !Array.isArray(resumedReconciliation) &&
      (resumedReconciliation as Record<string, unknown>)["action"] ===
        "continue-cancellation" &&
      interruptedCancellation?.type === "cancellation.started" &&
      interruptedCancellation.phase === "CANCELLING" &&
      interruptedCancellation.payload["request_id"] ===
        effective?.payload["request_id"];
    if (
      latest === undefined ||
      effective === undefined ||
      (latest.type !== "cancellation.requested" &&
        latest.type !== "cancellation.escalated" &&
        latest.type !== "cancellation.started" &&
        !exactCancellationResume)
    ) {
      return refuse(
        "cancellation phase has no exact durable cancellation request event",
      );
    }
    let current = parsed;
    if (current.snapshot.run.state === "CANCEL_REQUESTED") {
      this.#transition(
        context,
        current,
        "CANCELLING",
        "cancellation.started",
        effective.payload,
      );
      current = this.#admission(context);
    }
    const stopPayload = terminalStopPayloadSchema.safeParse(effective.payload);
    if (!stopPayload.success) {
      return refuse("cancellation event has malformed terminal stop evidence");
    }
    const stop: AsfTerminalStopEvidence = {
      code: stopPayload.data.code,
      summary: stopPayload.data.summary,
      interruptedPhase: stopPayload.data.checkpoint,
      retryDisposition: stopPayload.data.retry_disposition,
      requiredActor: stopPayload.data.required_actor,
      requiredAction: stopPayload.data.required_action,
      evidenceRefs: stopPayload.data.evidence_refs,
    };
    const deliveryBundleDigest =
      this.#options.store.getAsfEvidenceBundleRecord(context.runId)
        ?.bundleDigest ?? null;
    const cleanup = await this.#performTerminalCleanup(
      context,
      current,
      "CANCELLED",
      stop,
      deliveryBundleDigest,
      "cancelled",
    );
    current = this.#admission(context);
    const terminalEvidence = await this.#finalizeTerminalEvidence(
      context,
      current,
    );
    this.#transitionWithCheckpoint(
      context,
      current,
      "CANCELLED",
      "run.cancelled",
      {
        ...effective.payload,
        terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
      },
      {
        kind: "lease-release-workspace-cleanup",
        durableInputs: { cancellation_event: effective.event_id },
        durableOutputs: {
          cleanup_evidence_digest: cleanup.observation.evidence_digest,
          terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
        },
        correlationMarker: cleanup.intent.intent_id,
      },
    );
  }

  async #deliveryProposal(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<z.infer<typeof deliveryProposalSchema>> {
    this.#assertRunBudget(context, parsed);
    const binding = this.#binding(parsed, context);
    const result = deliveryProposalSchema.safeParse(
      await this.#options.deliveryProposal.propose({
        binding,
        repository: parsed.snapshot.run.repo,
        baseRef: parsed.envelope.payload.repository.base_ref,
        draft: parsed.policy.delivery.draftPr,
        signal: context.signal,
      }),
    );
    if (!result.success)
      return refuse("delivery proposal controller returned malformed proposal");
    assertBinding(result.data.binding, binding, "delivery proposal");
    const { proposal_digest: proposalDigest, ...unsigned } = result.data;
    if (
      result.data.repository.toLowerCase() !==
        parsed.snapshot.run.repo.toLowerCase() ||
      result.data.base_ref !== parsed.envelope.payload.repository.base_ref ||
      result.data.draft !== parsed.policy.delivery.draftPr ||
      sha256Digest(json(unsigned)) !== proposalDigest
    ) {
      return refuse(
        "delivery proposal is not deterministic and exact-bound to the admitted PR target",
      );
    }
    return result.data;
  }

  async #currentWorkspace(
    context: AsfRunnerContext,
    parsed: ParsedAdmission,
  ): Promise<z.infer<typeof workspaceObservationSchema>> {
    this.#assertRunBudget(context, parsed);
    const binding = this.#binding(parsed, context);
    const result = workspaceObservationSchema.safeParse(
      await this.#options.workspace.observeCurrent({
        binding,
        signal: context.signal,
      }),
    );
    if (!result.success)
      return refuse("current workspace observation is malformed");
    assertBinding(
      result.data.binding,
      binding,
      "current workspace observation",
    );
    if (
      result.data.base_sha !==
        parsed.envelope.payload.repository.base_sha.toLowerCase() ||
      result.data.sandbox_profile !== parsed.policy.runtime.sandboxProfile
    ) {
      return refuse(
        "current workspace observation is stale or bound to another base",
      );
    }
    return result.data;
  }

  #requiredCandidate(parsed: ParsedAdmission): string {
    const candidate = parsed.snapshot.run.candidateSha;
    if (candidate === null || !gitShaSchema.safeParse(candidate).success) {
      return refuse(
        `phase ${parsed.snapshot.run.state} has no exact candidate SHA`,
      );
    }
    return candidate;
  }

  #requirePriorCheckpoint(
    runtime: RuntimeState,
    kind: AsfCheckpointKind,
    candidateSha: string | null,
  ): void {
    if (
      runtime.latestCheckpoint.checkpoint_kind !== kind ||
      runtime.latestCheckpoint.candidate_sha !== candidateSha
    ) {
      refuse(
        `stage requires durable ${kind} checkpoint for the exact candidate`,
      );
    }
  }

  #taskPacketDigest(runId: string): string {
    const event = this.#latestEvent(runId, "task_packet.created", null);
    const digest = event.payload["task_packet_digest"];
    if (typeof digest !== "string" || !digestSchema.safeParse(digest).success) {
      return refuse("durable task-packet event has no valid digest");
    }
    return digest;
  }

  #latestPullRequest(
    runId: string,
    candidateSha: string,
  ): { readonly number: number; readonly url: string } {
    const event = this.#latestEvent(runId, "pull_request.opened", candidateSha);
    const number = event.payload["number"];
    const url = event.payload["url"];
    if (typeof number !== "number" || typeof url !== "string") {
      return refuse("durable pull-request event is incomplete");
    }
    return { number, url };
  }

  #previousPushedCandidate(runId: string, candidateSha: string): string | null {
    const prior = this.#events(runId)
      .filter(
        (event) =>
          event.type === "branch.pushed" &&
          typeof event.payload["candidate_sha"] === "string" &&
          event.payload["candidate_sha"] !== candidateSha,
      )
      .at(-1);
    const sha = prior?.payload["candidate_sha"];
    return typeof sha === "string" ? sha : null;
  }

  #countFixIterations(runId: string): number {
    return this.#events(runId).filter(
      (event) => event.type === "fixing.started",
    ).length;
  }

  #latestEvent(
    runId: string,
    type: string,
    candidateSha: string | null,
  ): RunEvent {
    const event = this.#events(runId)
      .filter(
        (item) =>
          item.type === type &&
          (candidateSha === null ||
            item.payload["candidate_sha"] === candidateSha),
      )
      .at(-1);
    if (event === undefined) return refuse(`durable event ${type} is missing`);
    return event;
  }

  #events(runId: string): readonly RunEvent[] {
    const events: RunEvent[] = [];
    let after = 0;
    while (events.length < this.#maxEventScan) {
      const limit = Math.min(1_000, this.#maxEventScan - events.length);
      const page: AsfEventPage = this.#options.store.listAsfRunEvents(
        runId,
        after,
        limit,
      );
      if (page.gap)
        return refuse(
          "required lifecycle events have been compacted without a bound snapshot",
        );
      events.push(...page.events);
      if (!page.hasMore) return events;
      if (page.nextCursor <= after)
        return refuse("durable event cursor did not advance");
      after = page.nextCursor;
    }
    return refuse("durable lifecycle exceeds the bounded recovery event scan");
  }

  async #handleError(context: AsfRunnerContext, error: unknown): Promise<void> {
    if (context.signal.aborted) throw error;
    if (error instanceof AsfPendingCiRetryError) throw error;
    const current = this.#options.store.getAsfRunSnapshot(context.runId);
    if (
      current === undefined ||
      current.run.ownerId !== this.#options.workerId ||
      current.run.generation !== context.generation ||
      isTerminalRunEventPhase(current.run.state)
    ) {
      throw error;
    }
    if (
      this.#options.store.getAsfTerminalEvidencePlanRecord(context.runId) !==
      undefined
    ) {
      throw new AsfPendingTerminalEvidenceRetryError(context.runId, error);
    }
    const stop = isDeliveryStop(error)
      ? error.stop
      : {
          phase: "FAILED" as const,
          code: "INTERNAL_DELIVERY_FAILURE",
          summary: "ASF PR delivery failed; inspect protected diagnostics",
          retryDisposition: "reconcile-first" as const,
          requiredActor: "platform-operator" as const,
          requiredAction:
            "inspect protected diagnostics and reconcile every unfinished intent",
          evidenceRefs: [] as readonly string[],
        };
    const payload = {
      code: stop.code,
      summary: stop.summary,
      checkpoint: current.run.state,
      retry_disposition: stop.retryDisposition,
      required_actor: stop.requiredActor,
      required_action: stop.requiredAction,
      evidence_refs: [...(stop.evidenceRefs ?? [])],
      ...(stop.phase === "WAITING_APPROVAL" &&
      stop.approvalDecisionType !== undefined &&
      stop.approvalRequestedEffect !== undefined
        ? {
            decision_type: stop.approvalDecisionType,
            requested_effect: stop.approvalRequestedEffect,
          }
        : {}),
      ...(current.run.candidateSha === null
        ? {}
        : { candidate_sha: current.run.candidateSha }),
    } as const;

    if (!isTerminalRunEventPhase(stop.phase)) {
      context.transition({
        from: current.run.state as RunEventPhase,
        to: stop.phase,
        expectedVersion: current.run.stateVersion,
        eventType: eventTypeForStop(stop.phase),
        payload,
        reason: "structured ASF delivery stop",
        actor: "asf-delivery-orchestrator",
      });
      return;
    }

    let parsed: ParsedAdmission;
    try {
      parsed = this.#admission(context);
    } catch {
      context.transition({
        from: current.run.state as RunEventPhase,
        to: "BLOCKED_EXTERNAL",
        expectedVersion: current.run.stateVersion,
        eventType: "run.blocked_external",
        payload: {
          code: "ADMISSION_RECONCILIATION_REQUIRED",
          summary:
            "terminal cleanup cannot proceed from contradictory admission state",
          checkpoint: current.run.state,
          retry_disposition: "reconcile-first",
          required_actor: "platform-operator",
          required_action:
            "repair protected admission state before cleanup and terminalization",
          evidence_refs: [],
          ...(current.run.candidateSha === null
            ? {}
            : { candidate_sha: current.run.candidateSha }),
        },
        reason: "terminal cleanup blocked by invalid admission",
        actor: "asf-delivery-orchestrator",
      });
      return;
    }

    let cleanup: {
      readonly intent: AsfDeliveryStageIntent;
      readonly observation: z.infer<typeof cleanupObservationSchema>;
    };
    const terminalStop: AsfTerminalStopEvidence = {
      code: stop.code,
      summary: stop.summary,
      interruptedPhase: current.run.state,
      retryDisposition: stop.retryDisposition,
      requiredActor: stop.requiredActor,
      requiredAction: stop.requiredAction,
      evidenceRefs: [...(stop.evidenceRefs ?? [])],
    };
    const deliveryBundleDigest =
      this.#options.store.getAsfEvidenceBundleRecord(context.runId)
        ?.bundleDigest ?? null;
    try {
      cleanup = await this.#performTerminalCleanup(
        context,
        parsed,
        stop.phase as "FAILED" | "REFUSED" | "QUARANTINED" | "BUDGET_EXHAUSTED",
        terminalStop,
        deliveryBundleDigest,
        stop.phase === "FAILED" ? "failed" : "stopped",
      );
    } catch (terminalEvidenceError) {
      if (context.signal.aborted) throw terminalEvidenceError;
      if (
        this.#options.store.getAsfTerminalEvidencePlanRecord(context.runId) !==
        undefined
      ) {
        throw new AsfPendingTerminalEvidenceRetryError(
          context.runId,
          terminalEvidenceError,
        );
      }
      const blocked = this.#admission(context);
      context.transition({
        from: blocked.snapshot.run.state as RunEventPhase,
        to: "BLOCKED_EXTERNAL",
        expectedVersion: blocked.snapshot.run.stateVersion,
        eventType: "run.blocked_external",
        payload: {
          code: "CLEANUP_RECONCILIATION_REQUIRED",
          summary: "terminal cleanup could not prove complete resource release",
          checkpoint: blocked.snapshot.run.state,
          retry_disposition: "reconcile-first",
          required_actor: "platform-operator",
          required_action:
            "reconcile cleanup intent before terminalizing the run",
          evidence_refs: [],
          ...(blocked.snapshot.run.candidateSha === null
            ? {}
            : { candidate_sha: blocked.snapshot.run.candidateSha }),
        },
        reason: "terminal cleanup requires reconciliation",
        actor: "asf-delivery-orchestrator",
      });
      return;
    }
    parsed = this.#admission(context);
    let terminalEvidence: AsfTerminalEvidenceBundleRecord;
    try {
      terminalEvidence = await this.#finalizeTerminalEvidence(context, parsed);
    } catch (error) {
      throw new AsfPendingTerminalEvidenceRetryError(context.runId, error);
    }
    try {
      this.#transitionWithCheckpoint(
        context,
        parsed,
        stop.phase,
        eventTypeForStop(stop.phase),
        {
          ...payload,
          terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
        },
        {
          kind: "lease-release-workspace-cleanup",
          durableInputs: { terminal_outcome: stop.phase, stop_code: stop.code },
          durableOutputs: {
            cleanup_evidence_digest: cleanup.observation.evidence_digest,
            terminal_evidence_bundle_digest: terminalEvidence.bundleDigest,
          },
          correlationMarker: cleanup.intent.intent_id,
        },
      );
    } catch (transitionError) {
      throw new AsfPendingTerminalEvidenceRetryError(
        context.runId,
        transitionError,
      );
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("ASF delivery invocation was cancelled or fenced");
  }
}

export function createAsfPrDeliveryRunner(
  options: AsfPrDeliveryRunnerOptions,
): AsfRunner {
  return new AsfPrDeliveryRunner(options).asRunner();
}
