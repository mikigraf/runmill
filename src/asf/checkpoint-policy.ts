import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import { runEventPhaseSchema, type RunEventPhase } from "./run-event.js";
import { sha256Digest, type JsonValue } from "./canonical-json.js";

export const ASF_DURABLE_CHECKPOINT_SCHEMA =
  "asf.durable-checkpoint/v1" as const;
export const ASF_RECOVERY_REQUEST_SCHEMA =
  "asf.checkpoint-recovery-request/v1" as const;
export const ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA =
  "asf.implementer-resume-observation/v1" as const;
export const ASF_CHECKPOINT_PUBLIC_SUMMARY_SCHEMA =
  "asf.checkpoint-public-summary/v1" as const;

/** The numbered checkpoint list in ASF Worker PRD section 11.2. */
export const ASF_CHECKPOINT_KINDS = [
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
  "merge-queue-candidate-state",
  "merge-intent-observation",
  "evidence-finalization-acknowledgement",
  "lease-release-workspace-cleanup",
] as const;

export type AsfCheckpointKind = (typeof ASF_CHECKPOINT_KINDS)[number];

export const ASF_CHECKPOINT_REPLAY_POLICIES = [
  "replayable",
  "reconcile-first",
  "fresh-context",
  "not-replayable",
] as const;

export type AsfCheckpointReplayPolicy =
  (typeof ASF_CHECKPOINT_REPLAY_POLICIES)[number];

export const ASF_RECONCILIATION_OBSERVATIONS = [
  "identity-lease-state",
  "provider-session-state",
  "github-branch-state",
  "github-pull-request-state",
  "github-ci-state",
  "github-merge-queue-state",
  "github-merge-state",
  "asf-acknowledgement-state",
  "repository-lease-state",
] as const;

export type AsfReconciliationObservation =
  (typeof ASF_RECONCILIATION_OBSERVATIONS)[number];

export const ASF_EVIDENCE_CLASSES = [
  "repository-lease",
  "identity-lease",
  "sandbox-proof",
  "task-packet",
  "implementer-session",
  "candidate",
  "local-verification",
  "local-review",
  "push-equivalence",
  "pull-request-identity",
  "ci",
  "pr-review",
  "approval",
  "merge-queue",
  "merge-readiness",
  "merge-provenance",
  "evidence-bundle",
  "asf-acknowledgement",
  "cleanup",
] as const;

export type AsfEvidenceClass = (typeof ASF_EVIDENCE_CLASSES)[number];

export const CANDIDATE_CHANGE_INVALIDATES = Object.freeze([
  "local-verification",
  "local-review",
  "push-equivalence",
  "pull-request-identity",
  "ci",
  "pr-review",
  "approval",
  "merge-queue",
  "merge-readiness",
  "merge-provenance",
  "evidence-bundle",
  "asf-acknowledgement",
] as const satisfies readonly AsfEvidenceClass[]);

export const MERGE_BASE_CHANGE_INVALIDATES = Object.freeze([
  "local-verification",
  "local-review",
  "push-equivalence",
  "ci",
  "pr-review",
  "approval",
  "merge-queue",
  "merge-readiness",
  "merge-provenance",
  "evidence-bundle",
  "asf-acknowledgement",
] as const satisfies readonly AsfEvidenceClass[]);

export interface AsfCheckpointRecoveryPolicy {
  readonly number: number;
  readonly kind: AsfCheckpointKind;
  readonly phases: readonly RunEventPhase[];
  readonly durableInputs: readonly string[];
  readonly durableOutputs: readonly string[];
  readonly replayPolicy: AsfCheckpointReplayPolicy;
  /** Exact current observations required before any remote replay decision. */
  readonly reconciliationBeforeReplay: readonly AsfReconciliationObservation[];
  readonly invalidatesOnReplay: readonly AsfEvidenceClass[];
  readonly candidateBinding: "none" | "required" | "optional";
  readonly implementerSessionResume: "never" | "protected-conditional";
  /** This is deliberately global: reviewer sessions are never resumable. */
  readonly reviewerSessionResume: "fresh-only";
  readonly allowedRecoveryRoles: readonly (
    | "orchestrator"
    | "implementer"
    | "local-reviewer"
    | "pr-reviewer"
  )[];
  readonly cleanupAndFencing: readonly string[];
}

type PolicyInput = Omit<AsfCheckpointRecoveryPolicy, "reviewerSessionResume">;

function frozenPolicy(input: PolicyInput): AsfCheckpointRecoveryPolicy {
  return Object.freeze({
    ...input,
    phases: Object.freeze([...input.phases]),
    durableInputs: Object.freeze([...input.durableInputs]),
    durableOutputs: Object.freeze([...input.durableOutputs]),
    reconciliationBeforeReplay: Object.freeze([
      ...input.reconciliationBeforeReplay,
    ]),
    invalidatesOnReplay: Object.freeze([...input.invalidatesOnReplay]),
    allowedRecoveryRoles: Object.freeze([...input.allowedRecoveryRoles]),
    cleanupAndFencing: Object.freeze([...input.cleanupAndFencing]),
    reviewerSessionResume: "fresh-only" as const,
  });
}

const TERMINAL_PHASES = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUSED",
  "QUARANTINED",
  "BUDGET_EXHAUSTED",
] as const satisfies readonly RunEventPhase[];

const CANDIDATE_EVIDENCE = CANDIDATE_CHANGE_INVALIDATES;

/**
 * Immutable, operator-owned recovery policy. Repository data can select no
 * entry and can never widen one of these entries at runtime.
 */
export const ASF_CHECKPOINT_RECOVERY_POLICIES = Object.freeze([
  frozenPolicy({
    number: 1,
    kind: "work-order-admission",
    phases: ["ADMITTED"],
    durableInputs: [
      "canonical-signed-work-order",
      "signer-trust-snapshot",
      "operator-repository-registration",
      "base-ref-and-protection-observation",
    ],
    durableOutputs: [
      "immutable-admission-record",
      "run-id",
      "work-order-and-envelope-digests",
      "effective-policy-digest",
    ],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: [],
    candidateBinding: "none",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "admission replay uses the original canonical envelope and idempotency key",
      "a conflicting payload creates no run and acquires no resource",
    ],
  }),
  frozenPolicy({
    number: 2,
    kind: "repository-lease-acquisition",
    phases: ["REPOSITORY_LEASED"],
    durableInputs: [
      "immutable-admission-record",
      "repository-and-base-binding",
    ],
    durableOutputs: ["repository-lease-id", "repository-lease-generation"],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: ["repository-lease"],
    candidateBinding: "none",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "acquire only after the durable run fence is current",
      "release or expire the prior repository lease before a new generation proceeds",
    ],
  }),
  frozenPolicy({
    number: 3,
    kind: "identity-lease-acquisition",
    phases: ["IDENTITY_READY"],
    durableInputs: [
      "work-order-role-profiles",
      "effective-policy-digest",
      "current-run-generation",
    ],
    durableOutputs: [
      "role-scoped-identity-attributions",
      "protected-identity-lease-references",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["identity-lease-state"],
    invalidatesOnReplay: ["identity-lease", "implementer-session"],
    candidateBinding: "none",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "observe and revoke any prior-generation identity lease before reacquisition",
      "never publish lease identifiers or execution handles",
    ],
  }),
  frozenPolicy({
    number: 4,
    kind: "workspace-sandbox-proof",
    phases: ["WORKSPACE_READY"],
    durableInputs: ["repository-lease", "base-sha", "sandbox-and-tool-policy"],
    durableOutputs: [
      "workspace-id",
      "workspace-base-head",
      "sandbox-denial-proof",
    ],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: ["sandbox-proof"],
    candidateBinding: "none",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "destroy an incomplete workspace before creating a fresh one",
      "prove the new sandbox rather than inheriting a prior enforcement result",
    ],
  }),
  frozenPolicy({
    number: 5,
    kind: "task-packet-creation",
    phases: ["TASK_PACKET_READY"],
    durableInputs: [
      "immutable-work-order-contract",
      "effective-policy",
      "base-commit-repository-guidance",
    ],
    durableOutputs: ["task-packet-digest", "untrusted-source-fence-digest"],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: ["task-packet"],
    candidateBinding: "none",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "regenerate only from the original immutable inputs",
      "repository guidance remains narrowing-only untrusted data",
    ],
  }),
  frozenPolicy({
    number: 6,
    kind: "implementer-session-marker",
    phases: ["IMPLEMENTING"],
    durableInputs: [
      "task-packet-digest",
      "implementer-identity-attribution",
      "provider-capability-observation",
    ],
    durableOutputs: [
      "session-start-or-resume-marker",
      "protected-provider-session-metadata",
      "session-identity-digest",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: [
      "provider-session-state",
      "identity-lease-state",
    ],
    invalidatesOnReplay: ["implementer-session"],
    candidateBinding: "none",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer"],
    cleanupAndFencing: [
      "abort or fence a prior-generation provider session before starting another",
      "resume only through protected controller state and a current identity lease",
    ],
  }),
  frozenPolicy({
    number: 7,
    kind: "candidate-commit-creation",
    phases: ["CANDIDATE_READY"],
    durableInputs: [
      "trusted-workspace-head",
      "allowed-change-scope",
      "implementer-output",
    ],
    durableOutputs: [
      "candidate-sha",
      "parent-sha",
      "tree-digest",
      "candidate-lineage-digest",
    ],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: CANDIDATE_EVIDENCE,
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer"],
    cleanupAndFencing: [
      "discard uncheckpointed changes after ownership loss",
      "a new candidate invalidates every prior candidate-bound result",
    ],
  }),
  frozenPolicy({
    number: 8,
    kind: "local-verification-pass",
    phases: ["LOCAL_VERIFY"],
    durableInputs: [
      "candidate-sha-and-tree",
      "trusted-check-definition",
      "sandbox-and-toolchain-digests",
    ],
    durableOutputs: [
      "candidate-bound-check-result",
      "coverage-status",
      "verification-evidence",
    ],
    replayPolicy: "replayable",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: [
      "local-verification",
      "local-review",
      "push-equivalence",
      "ci",
      "pr-review",
      "approval",
      "merge-readiness",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer"],
    cleanupAndFencing: [
      "terminate an incomplete verification process tree",
      "re-run in a fresh candidate-bound network-disabled sandbox",
    ],
  }),
  frozenPolicy({
    number: 9,
    kind: "local-review-fixer-iteration",
    phases: ["LOCAL_REVIEW", "FIXING", "CANDIDATE_READY"],
    durableInputs: [
      "candidate-bound-local-verification",
      "immutable-task-contract",
      "fresh-independent-reviewer-identity",
    ],
    durableOutputs: [
      "structured-review-verdict",
      "findings-digest",
      "fix-iteration-result",
    ],
    replayPolicy: "fresh-context",
    reconciliationBeforeReplay: [],
    invalidatesOnReplay: CANDIDATE_EVIDENCE,
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer", "local-reviewer"],
    cleanupAndFencing: [
      "terminate any prior reviewer and discard its conversational context",
      "a fixer may resume only the implementer session under exact protected bindings",
    ],
  }),
  frozenPolicy({
    number: 10,
    kind: "branch-push-intent-observation",
    phases: ["PUSHED"],
    durableInputs: [
      "candidate-sha",
      "deterministic-branch-ref",
      "expected-remote-sha",
      "push-intent",
    ],
    durableOutputs: [
      "branch-effect-key",
      "observed-exact-remote-sha",
      "observation-digest",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["github-branch-state"],
    invalidatesOnReplay: [
      "push-equivalence",
      "pull-request-identity",
      "ci",
      "pr-review",
      "approval",
      "merge-readiness",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "never retry an in-flight or ambiguous push without exact remote-ref observation",
      "use the durable expected remote SHA for any retry",
    ],
  }),
  frozenPolicy({
    number: 11,
    kind: "pull-request-intent-observation",
    phases: ["PR_OPEN"],
    durableInputs: [
      "candidate-bound-branch-confirmation",
      "deterministic-pr-marker",
      "head-and-base-refs",
      "pr-create-intent",
    ],
    durableOutputs: [
      "pr-effect-key",
      "observed-pr-identity",
      "observed-head-sha",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["github-pull-request-state"],
    invalidatesOnReplay: [
      "pull-request-identity",
      "ci",
      "pr-review",
      "approval",
      "merge-readiness",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "enumerate all matching PRs before create or retry",
      "multiple or mismatched marker matches quarantine instead of choosing one",
    ],
  }),
  frozenPolicy({
    number: 12,
    kind: "ci-reconciliation-snapshot",
    phases: ["CI_WAIT"],
    durableInputs: [
      "exact-pr-head-sha",
      "required-check-contexts",
      "forge-protection-snapshot",
    ],
    durableOutputs: [
      "complete-ci-snapshot",
      "per-context-evidence",
      "observation-digest",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["github-ci-state"],
    invalidatesOnReplay: [
      "ci",
      "pr-review",
      "approval",
      "merge-readiness",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer"],
    cleanupAndFencing: [
      "polling has no caller lifetime and resumes from durable required contexts",
      "missing, skipped, incomplete, or stale contexts never become success",
    ],
  }),
  frozenPolicy({
    number: 13,
    kind: "pr-review-fixer-iteration",
    phases: ["PR_REVIEW", "PR_DELIVERED", "FIXING", "CANDIDATE_READY"],
    durableInputs: [
      "exact-pr-head-and-ci-snapshot",
      "immutable-task-contract",
      "fresh-independent-pr-reviewer-identity",
      "final-pr-delivery-observation-intent",
    ],
    durableOutputs: [
      "structured-pr-review-verdict",
      "findings-digest",
      "fix-iteration-result",
      "final-pr-collision-base-and-protection-observation",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: [
      "github-pull-request-state",
      "github-ci-state",
    ],
    invalidatesOnReplay: CANDIDATE_EVIDENCE,
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer", "pr-reviewer"],
    cleanupAndFencing: [
      "reconcile exact PR head and CI before starting a new reviewer",
      "terminate any prior reviewer and never restore its context",
      "a changed candidate returns through complete verification and review gates",
      "re-read and bind the exact PR collision set and current base protection before delivery",
    ],
  }),
  frozenPolicy({
    number: 14,
    kind: "merge-queue-candidate-state",
    phases: ["MERGE_QUEUE_WAIT", "MERGE_READY"],
    durableInputs: [
      "approved-pr-and-candidate",
      "current-base-and-protection",
      "merge-queue-entry-intent",
    ],
    durableOutputs: [
      "queue-entry-identity",
      "merge-group-sha",
      "candidate-group-evidence",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["github-merge-queue-state"],
    invalidatesOnReplay: [
      "approval",
      "merge-queue",
      "merge-readiness",
      "merge-provenance",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "protected-conditional",
    allowedRecoveryRoles: ["orchestrator", "implementer"],
    cleanupAndFencing: [
      "observe queue regrouping and current base before any retry",
      "a changed merge group invalidates stale approval and merge readiness",
    ],
  }),
  frozenPolicy({
    number: 15,
    kind: "merge-intent-observation",
    phases: ["MERGED"],
    durableInputs: [
      "current-exact-approval",
      "candidate-or-merge-group-sha",
      "expected-head-protection",
      "merge-intent",
    ],
    durableOutputs: [
      "merge-effect-key",
      "observed-merge-sha",
      "candidate-provenance-evidence",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["github-merge-state"],
    invalidatesOnReplay: [
      "merge-readiness",
      "merge-provenance",
      "evidence-bundle",
      "asf-acknowledgement",
    ],
    candidateBinding: "required",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "observe the expected PR and merge provenance before any merge retry",
      "ambiguous merge outcome prohibits retry and becomes an actionable escalation",
    ],
  }),
  frozenPolicy({
    number: 16,
    kind: "evidence-finalization-acknowledgement",
    phases: ["EVIDENCE_FINALIZED", "COMPLETED"],
    durableInputs: [
      "exact-closure-evidence",
      "work-order-and-policy-bindings",
      "portable-artifact-manifest",
    ],
    durableOutputs: [
      "signed-evidence-bundle",
      "bundle-digest",
      "asf-acknowledgement",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: ["asf-acknowledgement-state"],
    invalidatesOnReplay: ["evidence-bundle", "asf-acknowledgement"],
    candidateBinding: "required",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "rebuild only from exact immutable evidence and the same candidate binding",
      "observe acknowledgement by bundle digest before retrying delivery",
    ],
  }),
  frozenPolicy({
    number: 17,
    kind: "lease-release-workspace-cleanup",
    phases: [...TERMINAL_PHASES],
    durableInputs: [
      "terminal-run-outcome",
      "protected-active-resource-inventory",
      "current-run-generation",
    ],
    durableOutputs: [
      "identity-lease-release",
      "repository-lease-release",
      "workspace-cleanup-proof",
    ],
    replayPolicy: "reconcile-first",
    reconciliationBeforeReplay: [
      "identity-lease-state",
      "repository-lease-state",
    ],
    invalidatesOnReplay: ["cleanup"],
    candidateBinding: "optional",
    implementerSessionResume: "never",
    allowedRecoveryRoles: ["orchestrator"],
    cleanupAndFencing: [
      "revoke or close identity leases before releasing repository ownership",
      "preserve artifacts needed to reconcile ambiguous effects before workspace deletion",
      "record cleanup confirmation without reopening the terminal run",
    ],
  }),
] as const satisfies readonly AsfCheckpointRecoveryPolicy[]);

const POLICY_BY_KIND = new Map<AsfCheckpointKind, AsfCheckpointRecoveryPolicy>(
  ASF_CHECKPOINT_RECOVERY_POLICIES.map((policy) => [policy.kind, policy]),
);

export const ASF_RECOVERY_REFUSAL_CODES = [
  "INVALID_REQUEST",
  "UNKNOWN_CHECKPOINT",
  "CHECKPOINT_BINDING_MISMATCH",
  "CHECKPOINT_INTEGRITY_UNPROVEN",
  "CHECKPOINT_POLICY_MISMATCH",
  "OWNERSHIP_UNPROVEN",
  "STALE_OBSERVATION",
  "REMOTE_RECONCILIATION_REQUIRED",
  "REMOTE_OUTCOME_UNRESOLVED",
  "REMOTE_BINDING_MISMATCH",
  "RECOVERY_ROLE_FORBIDDEN",
  "REVIEWER_RESUME_FORBIDDEN",
  "IMPLEMENTER_RESUME_UNPROVEN",
] as const;

export type AsfRecoveryRefusalCode =
  (typeof ASF_RECOVERY_REFUSAL_CODES)[number];

/** A deliberately non-secret recovery refusal suitable for control-plane mapping. */
export class AsfRecoveryRefusedError extends Error {
  readonly code: AsfRecoveryRefusalCode;
  readonly checkpointKind: AsfCheckpointKind | null;

  constructor(
    code: AsfRecoveryRefusalCode,
    message: string,
    checkpointKind: AsfCheckpointKind | null = null,
  ) {
    super(message);
    this.name = "AsfRecoveryRefusedError";
    this.code = code;
    this.checkpointKind = checkpointKind;
  }
}

function refuse(
  code: AsfRecoveryRefusalCode,
  message: string,
  checkpointKind: AsfCheckpointKind | null = null,
): never {
  throw new AsfRecoveryRefusedError(code, message, checkpointKind);
}

export function getAsfCheckpointRecoveryPolicy(
  kind: string,
): AsfCheckpointRecoveryPolicy {
  const parsed = z.enum(ASF_CHECKPOINT_KINDS).safeParse(kind);
  if (!parsed.success) {
    return refuse(
      "UNKNOWN_CHECKPOINT",
      "recovery refused because the durable checkpoint kind is unsupported",
    );
  }
  const policy = POLICY_BY_KIND.get(parsed.data);
  if (policy === undefined) {
    return refuse(
      "UNKNOWN_CHECKPOINT",
      "recovery refused because the checkpoint has no operator-owned policy",
      parsed.data,
    );
  }
  return policy;
}

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const checkpointKindSchema = z.enum(ASF_CHECKPOINT_KINDS);
const checkpointReplayPolicySchema = z.enum(ASF_CHECKPOINT_REPLAY_POLICIES);
const reconciliationObservationSchema = z.enum(ASF_RECONCILIATION_OBSERVATIONS);

export const protectedImplementerResumeMetadataSchema = z
  .object({
    schema: z.literal("asf.protected-implementer-resume/v1"),
    storage: z.literal("protected-runtime-state"),
    protected_resume_ref: digestSchema,
    session_identity_digest: digestSchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    candidate_sha: gitShaSchema.nullable(),
    candidate_lineage_digest: digestSchema,
    identity_lease_binding_digest: digestSchema,
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    recorded_at: timestampSchema,
    identity_lease_expires_at: timestampSchema,
  })
  .strict();

export type ProtectedImplementerResumeMetadata = z.infer<
  typeof protectedImplementerResumeMetadataSchema
>;

const newDurableCheckpointSchema = z
  .object({
    schema: z.literal(ASF_DURABLE_CHECKPOINT_SCHEMA),
    checkpoint_id: identifierSchema,
    checkpoint_kind: checkpointKindSchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    phase: runEventPhaseSchema,
    event_seq: z.number().int().positive(),
    fencing_generation: z.number().int().positive(),
    policy_digest: digestSchema,
    candidate_sha: gitShaSchema.nullable(),
    candidate_lineage_digest: digestSchema,
    durable_inputs_digest: digestSchema,
    durable_outputs_digest: digestSchema,
    replay_policy: checkpointReplayPolicySchema,
    reconciliation_markers: z.array(
      z
        .object({
          observation: reconciliationObservationSchema,
          correlation_marker: identifierSchema,
        })
        .strict(),
    ),
    protected_implementer_resume:
      protectedImplementerResumeMetadataSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

const durableCheckpointSchema = newDurableCheckpointSchema
  .extend({ checkpoint_digest: digestSchema })
  .strict();

export type NewDurableAsfCheckpoint = z.infer<
  typeof newDurableCheckpointSchema
>;
export type DurableAsfCheckpoint = z.infer<typeof durableCheckpointSchema>;

function parsedJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue;
}

function semanticCheckpointValidation(
  checkpoint: NewDurableAsfCheckpoint,
): void {
  const policy = getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind);
  if (!policy.phases.includes(checkpoint.phase)) {
    refuse(
      "CHECKPOINT_BINDING_MISMATCH",
      `checkpoint ${checkpoint.checkpoint_kind} is not valid for phase ${checkpoint.phase}`,
      checkpoint.checkpoint_kind,
    );
  }
  if (checkpoint.replay_policy !== policy.replayPolicy) {
    refuse(
      "CHECKPOINT_POLICY_MISMATCH",
      "durable checkpoint replay policy does not equal the operator-owned policy",
      checkpoint.checkpoint_kind,
    );
  }
  const reconciliationNames = checkpoint.reconciliation_markers.map(
    (marker) => marker.observation,
  );
  if (!exactSet(reconciliationNames, policy.reconciliationBeforeReplay)) {
    refuse(
      "CHECKPOINT_POLICY_MISMATCH",
      "durable checkpoint does not bind the exact required reconciliation markers",
      checkpoint.checkpoint_kind,
    );
  }
  if (
    policy.candidateBinding === "required" &&
    checkpoint.candidate_sha === null
  ) {
    refuse(
      "CHECKPOINT_BINDING_MISMATCH",
      "candidate-bound checkpoint is missing its exact candidate SHA",
      checkpoint.checkpoint_kind,
    );
  }
  if (policy.candidateBinding === "none" && checkpoint.candidate_sha !== null) {
    refuse(
      "CHECKPOINT_BINDING_MISMATCH",
      "pre-candidate checkpoint unexpectedly contains candidate authority",
      checkpoint.checkpoint_kind,
    );
  }

  const resume = checkpoint.protected_implementer_resume;
  if (resume === null) return;
  if (policy.implementerSessionResume !== "protected-conditional") {
    refuse(
      "CHECKPOINT_POLICY_MISMATCH",
      "checkpoint policy does not permit protected implementer session metadata",
      checkpoint.checkpoint_kind,
    );
  }
  for (const [label, actual, expected] of [
    ["run", resume.run_id, checkpoint.run_id],
    ["work order", resume.work_order_id, checkpoint.work_order_id],
    ["attempt", resume.attempt_id, checkpoint.attempt_id],
    ["policy", resume.policy_digest, checkpoint.policy_digest],
    ["generation", resume.fencing_generation, checkpoint.fencing_generation],
    ["candidate", resume.candidate_sha, checkpoint.candidate_sha],
    [
      "candidate lineage",
      resume.candidate_lineage_digest,
      checkpoint.candidate_lineage_digest,
    ],
  ] as const) {
    if (actual !== expected) {
      refuse(
        "CHECKPOINT_BINDING_MISMATCH",
        `protected implementer resume ${label} binding does not match the checkpoint`,
        checkpoint.checkpoint_kind,
      );
    }
  }
  const recordedAt = Date.parse(resume.recorded_at);
  const checkpointAt = Date.parse(checkpoint.created_at);
  const expiresAt = Date.parse(resume.identity_lease_expires_at);
  if (recordedAt > checkpointAt || expiresAt <= checkpointAt) {
    refuse(
      "CHECKPOINT_BINDING_MISMATCH",
      "protected implementer resume timestamps are contradictory",
      checkpoint.checkpoint_kind,
    );
  }
}

function parseNewCheckpoint(raw: unknown): NewDurableAsfCheckpoint {
  const parsed = newDurableCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    const rawKind =
      typeof raw === "object" && raw !== null && "checkpoint_kind" in raw
        ? (raw as { checkpoint_kind?: unknown }).checkpoint_kind
        : undefined;
    if (
      typeof rawKind === "string" &&
      !ASF_CHECKPOINT_KINDS.includes(rawKind as AsfCheckpointKind)
    ) {
      return refuse(
        "UNKNOWN_CHECKPOINT",
        "recovery refused because the durable checkpoint kind is unsupported",
      );
    }
    return refuse(
      "INVALID_REQUEST",
      "durable ASF checkpoint failed strict schema validation",
    );
  }
  semanticCheckpointValidation(parsed.data);
  return parsed.data;
}

export function createDurableAsfCheckpoint(raw: unknown): DurableAsfCheckpoint {
  const checkpoint = parseNewCheckpoint(raw);
  return {
    ...checkpoint,
    checkpoint_digest: sha256Digest(parsedJson(checkpoint)),
  };
}

/** Parse a persisted checkpoint and prove its content-addressed integrity. */
export function parseDurableAsfCheckpoint(raw: unknown): DurableAsfCheckpoint {
  const parsed = durableCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    const rawKind =
      typeof raw === "object" && raw !== null && "checkpoint_kind" in raw
        ? (raw as { checkpoint_kind?: unknown }).checkpoint_kind
        : undefined;
    if (
      typeof rawKind === "string" &&
      !ASF_CHECKPOINT_KINDS.includes(rawKind as AsfCheckpointKind)
    ) {
      return refuse(
        "UNKNOWN_CHECKPOINT",
        "recovery refused because the durable checkpoint kind is unsupported",
      );
    }
    return refuse(
      "INVALID_REQUEST",
      "durable ASF checkpoint failed strict schema validation",
    );
  }
  const { checkpoint_digest: recordedDigest, ...unsigned } = parsed.data;
  semanticCheckpointValidation(unsigned);
  if (sha256Digest(parsedJson(unsigned)) !== recordedDigest) {
    return refuse(
      "CHECKPOINT_INTEGRITY_UNPROVEN",
      "durable checkpoint digest does not match its canonical content",
      unsigned.checkpoint_kind,
    );
  }
  return parsed.data;
}

export interface PublicAsfCheckpointSummary {
  readonly schema: typeof ASF_CHECKPOINT_PUBLIC_SUMMARY_SCHEMA;
  readonly checkpoint_id: string;
  readonly checkpoint_kind: AsfCheckpointKind;
  readonly run_id: string;
  readonly work_order_id: string;
  readonly attempt_id: string;
  readonly phase: RunEventPhase;
  readonly event_seq: number;
  readonly policy_digest: string;
  readonly candidate_sha: string | null;
  readonly checkpoint_digest: string;
  readonly protected_implementer_resume: {
    readonly present: true;
    readonly binding_digest: string;
  } | null;
  readonly created_at: string;
}

/**
 * Produce a portable view without the protected-runtime resolver reference,
 * identity binding digest, principal, profile, or protected timestamps.
 */
export function publicAsfCheckpointSummary(
  raw: unknown,
): PublicAsfCheckpointSummary {
  const checkpoint = parseDurableAsfCheckpoint(raw);
  const resume = checkpoint.protected_implementer_resume;
  return {
    schema: ASF_CHECKPOINT_PUBLIC_SUMMARY_SCHEMA,
    checkpoint_id: checkpoint.checkpoint_id,
    checkpoint_kind: checkpoint.checkpoint_kind,
    run_id: checkpoint.run_id,
    work_order_id: checkpoint.work_order_id,
    attempt_id: checkpoint.attempt_id,
    phase: checkpoint.phase,
    event_seq: checkpoint.event_seq,
    policy_digest: checkpoint.policy_digest,
    candidate_sha: checkpoint.candidate_sha,
    checkpoint_digest: checkpoint.checkpoint_digest,
    protected_implementer_resume:
      resume === null
        ? null
        : {
            present: true,
            binding_digest: sha256Digest({
              schema: resume.schema,
              run_id: resume.run_id,
              work_order_id: resume.work_order_id,
              attempt_id: resume.attempt_id,
              policy_digest: resume.policy_digest,
              fencing_generation: resume.fencing_generation,
              candidate_sha: resume.candidate_sha,
              candidate_lineage_digest: resume.candidate_lineage_digest,
              protected_resume_ref: resume.protected_resume_ref,
              session_identity_digest: resume.session_identity_digest,
            }),
          },
    created_at: checkpoint.created_at,
  };
}

const observationWindowShape = {
  observed_at: timestampSchema,
  valid_until: timestampSchema,
  evidence_digest: digestSchema,
};

const ownershipObservationSchema = z
  .object({
    state: z.enum(["current", "stale", "unknown", "contradictory"]),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    worker_id: identifierSchema,
    fencing_generation: z.number().int().positive(),
    ...observationWindowShape,
  })
  .strict();

const providerResumeObservationSchema = z
  .object({
    capability: z.enum([
      "supported",
      "unsupported",
      "unknown",
      "contradictory",
    ]),
    session_state: z.enum(["resumable", "closed", "unknown", "contradictory"]),
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    protected_resume_ref: digestSchema,
    session_identity_digest: digestSchema,
    ...observationWindowShape,
  })
  .strict();

const identityResumeObservationSchema = z
  .object({
    state: z.enum([
      "current",
      "expired",
      "revoked",
      "unknown",
      "contradictory",
    ]),
    identity_lease_binding_digest: digestSchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    role: z.literal("implementer"),
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    expires_at: timestampSchema,
    ...observationWindowShape,
  })
  .strict();

const lineageResumeObservationSchema = z
  .object({
    state: z.enum(["exact", "changed", "unknown", "contradictory"]),
    candidate_sha: gitShaSchema.nullable(),
    candidate_lineage_digest: digestSchema,
    ...observationWindowShape,
  })
  .strict();

const policyResumeObservationSchema = z
  .object({
    state: z.enum(["permitted", "prohibited", "unknown", "contradictory"]),
    policy_digest: digestSchema,
    ...observationWindowShape,
  })
  .strict();

const implementerResumeObservationsSchema = z
  .object({
    schema: z.literal(ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA),
    requesting_worker_id: identifierSchema,
    ownership: ownershipObservationSchema,
    provider: providerResumeObservationSchema,
    identity_lease: identityResumeObservationSchema,
    candidate_lineage: lineageResumeObservationSchema,
    policy: policyResumeObservationSchema,
  })
  .strict();

export type ImplementerResumeObservations = z.infer<
  typeof implementerResumeObservationsSchema
>;

function assertFreshObservation(
  clock: Clock,
  observation: { readonly observed_at: string; readonly valid_until: string },
  checkpointKind: AsfCheckpointKind,
  label: string,
): void {
  const now = clock.now().getTime();
  const observedAt = Date.parse(observation.observed_at);
  const validUntil = Date.parse(observation.valid_until);
  if (observedAt > now || validUntil < observedAt || now >= validUntil) {
    refuse(
      "STALE_OBSERVATION",
      `${label} is missing a current observation window`,
      checkpointKind,
    );
  }
}

function assertOwnership(
  checkpoint: DurableAsfCheckpoint,
  observation: z.infer<typeof ownershipObservationSchema>,
  clock: Clock,
  options: {
    readonly requestingWorkerId: string;
    readonly allowNewerTakeoverGeneration: boolean;
  },
): { readonly takeover: boolean } {
  assertFreshObservation(
    clock,
    observation,
    checkpoint.checkpoint_kind,
    "ownership evidence",
  );
  if (observation.state !== "current") {
    refuse(
      "OWNERSHIP_UNPROVEN",
      "recovery refused because current fenced ownership is not proven",
      checkpoint.checkpoint_kind,
    );
  }
  if (
    observation.run_id !== checkpoint.run_id ||
    observation.work_order_id !== checkpoint.work_order_id ||
    observation.attempt_id !== checkpoint.attempt_id ||
    observation.worker_id !== options.requestingWorkerId
  ) {
    refuse(
      "OWNERSHIP_UNPROVEN",
      "recovery ownership does not match the exact checkpoint generation",
      checkpoint.checkpoint_kind,
    );
  }
  const exactGeneration =
    observation.fencing_generation === checkpoint.fencing_generation;
  const newerTakeoverGeneration =
    options.allowNewerTakeoverGeneration &&
    observation.fencing_generation > checkpoint.fencing_generation;
  if (!exactGeneration && !newerTakeoverGeneration) {
    refuse(
      "OWNERSHIP_UNPROVEN",
      "recovery ownership does not hold an acceptable fenced generation",
      checkpoint.checkpoint_kind,
    );
  }
  return { takeover: newerTakeoverGeneration };
}

export interface AuthorizedImplementerResumePublicBinding {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly checkpointKind: AsfCheckpointKind;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  /** Fence on the authenticated protected provider session/checkpoint. */
  readonly fencingGeneration: number;
  /** Current owner/identity fence authorized to consume the protected session. */
  readonly authorizationFencingGeneration: number;
  readonly authorizationIdentityLeaseBindingDigest: string;
  readonly sessionIdentityDigest: string;
}

/**
 * An authorization whose sealed protected-runtime reference is neither
 * enumerable nor serialized. Only the trusted provider harness/resolver should
 * call the accessor; SQLite never receives the provider session capability.
 */
export class AuthorizedImplementerResume {
  readonly binding: AuthorizedImplementerResumePublicBinding;
  readonly #protectedResumeRef: string;

  constructor(
    binding: AuthorizedImplementerResumePublicBinding,
    protectedResumeRef: string,
  ) {
    this.binding = Object.freeze({ ...binding });
    this.#protectedResumeRef = protectedResumeRef;
    Object.freeze(this);
  }

  protectedResumeRefForTrustedHarness(): string {
    return this.#protectedResumeRef;
  }

  toJSON(): AuthorizedImplementerResumePublicBinding {
    return this.binding;
  }
}

/**
 * Prove all PRD 11.3 implementer-resume predicates. Any missing, stale,
 * unknown, contradictory, or merely non-matching fact refuses the resume.
 */
export function authorizeProtectedImplementerResume(
  checkpointRaw: unknown,
  observationsRaw: unknown,
  options: { readonly clock: Clock },
): AuthorizedImplementerResume {
  const checkpoint = parseDurableAsfCheckpoint(checkpointRaw);
  const policy = getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind);
  const observations =
    implementerResumeObservationsSchema.safeParse(observationsRaw);
  if (!observations.success) {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "implementer resume observations failed strict schema validation",
      checkpoint.checkpoint_kind,
    );
  }
  if (policy.implementerSessionResume !== "protected-conditional") {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "operator policy does not permit implementer resume at this checkpoint",
      checkpoint.checkpoint_kind,
    );
  }
  const protectedResume = checkpoint.protected_implementer_resume;
  if (protectedResume === null) {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "checkpoint has no protected implementer resume metadata",
      checkpoint.checkpoint_kind,
    );
  }

  const facts = observations.data;
  const resumeOwnership = assertOwnership(
    checkpoint,
    facts.ownership,
    options.clock,
    {
      requestingWorkerId: facts.requesting_worker_id,
      allowNewerTakeoverGeneration: true,
    },
  );
  for (const [label, observation] of [
    ["provider session evidence", facts.provider],
    ["identity lease evidence", facts.identity_lease],
    ["candidate lineage evidence", facts.candidate_lineage],
    ["resume policy evidence", facts.policy],
  ] as const) {
    assertFreshObservation(
      options.clock,
      observation,
      checkpoint.checkpoint_kind,
      label,
    );
  }

  if (
    facts.provider.capability !== "supported" ||
    facts.provider.session_state !== "resumable"
  ) {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "provider capability and exact resumable session state are not proven",
      checkpoint.checkpoint_kind,
    );
  }
  if (facts.identity_lease.state !== "current") {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "implementer identity lease is not proven current",
      checkpoint.checkpoint_kind,
    );
  }
  if (facts.candidate_lineage.state !== "exact") {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "candidate lineage is not proven exact",
      checkpoint.checkpoint_kind,
    );
  }
  if (facts.policy.state !== "permitted") {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "current operator policy does not explicitly permit implementer resume",
      checkpoint.checkpoint_kind,
    );
  }
  if (
    Date.parse(facts.identity_lease.expires_at) <= options.clock.now().getTime()
  ) {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "implementer identity lease is expired",
      checkpoint.checkpoint_kind,
    );
  }

  const exactBindings: readonly [string, unknown, unknown][] = [
    ["provider", facts.provider.provider, protectedResume.provider],
    ["provider principal", facts.provider.principal, protectedResume.principal],
    ["provider profile", facts.provider.profile, protectedResume.profile],
    [
      "session identity",
      facts.provider.session_identity_digest,
      protectedResume.session_identity_digest,
    ],
    [
      "protected resume reference",
      facts.provider.protected_resume_ref,
      protectedResume.protected_resume_ref,
    ],
    ["lease run", facts.identity_lease.run_id, checkpoint.run_id],
    [
      "lease work order",
      facts.identity_lease.work_order_id,
      checkpoint.work_order_id,
    ],
    ["lease attempt", facts.identity_lease.attempt_id, checkpoint.attempt_id],
    [
      "lease policy",
      facts.identity_lease.policy_digest,
      checkpoint.policy_digest,
    ],
    [
      "lease generation",
      facts.identity_lease.fencing_generation,
      facts.ownership.fencing_generation,
    ],
    ["lease provider", facts.identity_lease.provider, protectedResume.provider],
    [
      "lease principal",
      facts.identity_lease.principal,
      protectedResume.principal,
    ],
    ["lease profile", facts.identity_lease.profile, protectedResume.profile],
    [
      "candidate",
      facts.candidate_lineage.candidate_sha,
      checkpoint.candidate_sha,
    ],
    [
      "candidate lineage",
      facts.candidate_lineage.candidate_lineage_digest,
      checkpoint.candidate_lineage_digest,
    ],
    ["policy", facts.policy.policy_digest, checkpoint.policy_digest],
  ];
  for (const [label, actual, expected] of exactBindings) {
    if (actual !== expected) {
      return refuse(
        "IMPLEMENTER_RESUME_UNPROVEN",
        `implementer resume ${label} binding is not exact`,
        checkpoint.checkpoint_kind,
      );
    }
  }
  if (
    !resumeOwnership.takeover &&
    facts.identity_lease.identity_lease_binding_digest !==
      protectedResume.identity_lease_binding_digest
  ) {
    return refuse(
      "IMPLEMENTER_RESUME_UNPROVEN",
      "same-generation implementer resume identity lease binding is not exact",
      checkpoint.checkpoint_kind,
    );
  }

  return new AuthorizedImplementerResume(
    {
      runId: checkpoint.run_id,
      workOrderId: checkpoint.work_order_id,
      attemptId: checkpoint.attempt_id,
      checkpointKind: checkpoint.checkpoint_kind,
      candidateSha: checkpoint.candidate_sha,
      policyDigest: checkpoint.policy_digest,
      fencingGeneration: checkpoint.fencing_generation,
      authorizationFencingGeneration: facts.ownership.fencing_generation,
      authorizationIdentityLeaseBindingDigest:
        facts.identity_lease.identity_lease_binding_digest,
      sessionIdentityDigest: protectedResume.session_identity_digest,
    },
    protectedResume.protected_resume_ref,
  );
}

const checkpointObservationSchema = z
  .object({
    state: z.enum(["verified", "missing", "unknown", "contradictory"]),
    checkpoint_digest: digestSchema,
    ...observationWindowShape,
  })
  .strict();

const remoteRecoveryObservationSchema = z
  .object({
    observation: reconciliationObservationSchema,
    state: z.enum([
      "confirmed",
      "not-applied",
      "ambiguous",
      "unknown",
      "contradictory",
    ]),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    candidate_sha: gitShaSchema.nullable(),
    correlation_marker: identifierSchema,
    ...observationWindowShape,
  })
  .strict();

const recoveryActorSchema = z.discriminatedUnion("role", [
  z
    .object({ role: z.literal("orchestrator"), mode: z.literal("automatic") })
    .strict(),
  z
    .object({
      role: z.literal("implementer"),
      mode: z.enum(["fresh", "resume"]),
      resume_observations: implementerResumeObservationsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      role: z.literal("local-reviewer"),
      mode: z.enum(["fresh", "resume"]),
    })
    .strict(),
  z
    .object({
      role: z.literal("pr-reviewer"),
      mode: z.enum(["fresh", "resume"]),
    })
    .strict(),
]);

const recoveryRequestSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_REQUEST_SCHEMA),
    requesting_worker_id: identifierSchema,
    checkpoint: durableCheckpointSchema,
    checkpoint_observation: checkpointObservationSchema,
    ownership: ownershipObservationSchema,
    remote_observations: z.array(remoteRecoveryObservationSchema),
    replay_requested: z.boolean(),
    actor: recoveryActorSchema,
  })
  .strict();

export const ASF_RECOVERY_ACTIONS = [
  "continue-from-checkpoint",
  "continue-after-reconciliation",
  "replay-stage",
  "restart-implementer-fresh",
  "resume-implementer",
  "restart-reviewer-fresh",
] as const;

export type AsfRecoveryAction = (typeof ASF_RECOVERY_ACTIONS)[number];

export interface AsfCheckpointRecoveryPlan {
  readonly checkpointKind: AsfCheckpointKind;
  readonly action: AsfRecoveryAction;
  readonly replayPolicy: AsfCheckpointReplayPolicy;
  readonly confirmedReconciliations: readonly AsfReconciliationObservation[];
  readonly replayReconciliations: readonly AsfReconciliationObservation[];
  /** Confirmed effects must be skipped when replaying the remaining stage. */
  readonly skipConfirmedEffects: readonly AsfReconciliationObservation[];
  readonly invalidatedEvidence: readonly AsfEvidenceClass[];
  readonly cleanupAndFencing: readonly string[];
  readonly ownershipTakeover: boolean;
  readonly requiredTakeoverFencing: readonly (
    | "fence-prior-worker-generation"
    | "abort-prior-provider-and-tool-work"
    | "revoke-prior-identity-leases"
    | "reconcile-in-flight-external-effects"
  )[];
  readonly implementerResume: AuthorizedImplementerResume | null;
}

function exactSet<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((value) => expected.includes(value))
  );
}

/**
 * Make one bounded, deterministic recovery decision. This function never
 * performs an external effect; it returns authority to the orchestrator only
 * after exact durable, ownership, and reconciliation evidence is proven.
 */
export function planAsfCheckpointRecovery(
  raw: unknown,
  options: { readonly clock: Clock },
): AsfCheckpointRecoveryPlan {
  const parsed = recoveryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "INVALID_REQUEST",
      "ASF checkpoint recovery request failed strict validation",
    );
  }
  const request = parsed.data;
  const checkpoint = parseDurableAsfCheckpoint(request.checkpoint);
  const policy = getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind);

  assertFreshObservation(
    options.clock,
    request.checkpoint_observation,
    checkpoint.checkpoint_kind,
    "checkpoint integrity evidence",
  );
  if (
    request.checkpoint_observation.state !== "verified" ||
    request.checkpoint_observation.checkpoint_digest !==
      checkpoint.checkpoint_digest
  ) {
    return refuse(
      "CHECKPOINT_INTEGRITY_UNPROVEN",
      "recovery refused because the durable checkpoint is missing, unknown, or contradictory",
      checkpoint.checkpoint_kind,
    );
  }
  const ownership = assertOwnership(
    checkpoint,
    request.ownership,
    options.clock,
    {
      requestingWorkerId: request.requesting_worker_id,
      allowNewerTakeoverGeneration: true,
    },
  );

  if (!policy.allowedRecoveryRoles.includes(request.actor.role)) {
    return refuse(
      "RECOVERY_ROLE_FORBIDDEN",
      "the requested recovery role is not permitted at this checkpoint",
      checkpoint.checkpoint_kind,
    );
  }
  if (
    (request.actor.role === "local-reviewer" ||
      request.actor.role === "pr-reviewer") &&
    request.actor.mode !== "fresh"
  ) {
    return refuse(
      "REVIEWER_RESUME_FORBIDDEN",
      "reviewer recovery always requires a fresh session and fresh context",
      checkpoint.checkpoint_kind,
    );
  }

  const names = request.remote_observations.map(
    (observation) => observation.observation,
  );
  if (!exactSet(names, policy.reconciliationBeforeReplay)) {
    return refuse(
      "REMOTE_RECONCILIATION_REQUIRED",
      "recovery lacks the exact operator-required reconciliation observation set",
      checkpoint.checkpoint_kind,
    );
  }

  const confirmed: AsfReconciliationObservation[] = [];
  const notApplied: AsfReconciliationObservation[] = [];
  const expectedMarkers = new Map(
    checkpoint.reconciliation_markers.map((marker) => [
      marker.observation,
      marker.correlation_marker,
    ]),
  );
  for (const observation of request.remote_observations) {
    assertFreshObservation(
      options.clock,
      observation,
      checkpoint.checkpoint_kind,
      `${observation.observation} reconciliation evidence`,
    );
    if (
      observation.run_id !== checkpoint.run_id ||
      observation.work_order_id !== checkpoint.work_order_id ||
      observation.attempt_id !== checkpoint.attempt_id ||
      observation.policy_digest !== checkpoint.policy_digest ||
      observation.candidate_sha !== checkpoint.candidate_sha ||
      observation.correlation_marker !==
        expectedMarkers.get(observation.observation)
    ) {
      return refuse(
        "REMOTE_BINDING_MISMATCH",
        "remote reconciliation is not bound to the exact run, candidate, and policy",
        checkpoint.checkpoint_kind,
      );
    }
    if (observation.state === "confirmed") {
      confirmed.push(observation.observation);
    } else if (observation.state === "not-applied") {
      notApplied.push(observation.observation);
    } else {
      return refuse(
        "REMOTE_OUTCOME_UNRESOLVED",
        "ambiguous, unknown, or contradictory remote outcome prohibits replay",
        checkpoint.checkpoint_kind,
      );
    }
  }

  if (!request.replay_requested && request.actor.role !== "orchestrator") {
    return refuse(
      "RECOVERY_ROLE_FORBIDDEN",
      "only the orchestrator may advance a completed checkpoint",
      checkpoint.checkpoint_kind,
    );
  }

  let action: AsfRecoveryAction;
  let implementerResume: AuthorizedImplementerResume | null = null;
  if (!request.replay_requested && notApplied.length === 0) {
    action =
      confirmed.length === 0
        ? "continue-from-checkpoint"
        : "continue-after-reconciliation";
  } else if (
    request.actor.role === "local-reviewer" ||
    request.actor.role === "pr-reviewer"
  ) {
    action = "restart-reviewer-fresh";
  } else if (request.actor.role === "implementer") {
    if (request.actor.mode === "resume") {
      if (
        notApplied.includes("provider-session-state") ||
        notApplied.includes("identity-lease-state")
      ) {
        return refuse(
          "IMPLEMENTER_RESUME_UNPROVEN",
          "reconciliation does not prove a resumable provider session and identity lease",
          checkpoint.checkpoint_kind,
        );
      }
      if (request.actor.resume_observations === null) {
        return refuse(
          "IMPLEMENTER_RESUME_UNPROVEN",
          "implementer resume observations are required",
          checkpoint.checkpoint_kind,
        );
      }
      implementerResume = authorizeProtectedImplementerResume(
        checkpoint,
        request.actor.resume_observations,
        options,
      );
      action = "resume-implementer";
    } else {
      if (request.actor.resume_observations !== null) {
        return refuse(
          "IMPLEMENTER_RESUME_UNPROVEN",
          "fresh implementer restart must not consume protected resume observations",
          checkpoint.checkpoint_kind,
        );
      }
      action = "restart-implementer-fresh";
    }
  } else {
    if (policy.replayPolicy === "not-replayable") {
      return refuse(
        "CHECKPOINT_POLICY_MISMATCH",
        "operator policy prohibits replay at this checkpoint",
        checkpoint.checkpoint_kind,
      );
    }
    action =
      notApplied.length === 0 && confirmed.length > 0
        ? "continue-after-reconciliation"
        : "replay-stage";
  }

  const replaying =
    action === "replay-stage" ||
    action === "restart-implementer-fresh" ||
    action === "resume-implementer" ||
    action === "restart-reviewer-fresh";

  return Object.freeze({
    checkpointKind: checkpoint.checkpoint_kind,
    action,
    replayPolicy: policy.replayPolicy,
    confirmedReconciliations: Object.freeze([...confirmed]),
    replayReconciliations: Object.freeze([...notApplied]),
    skipConfirmedEffects: Object.freeze(replaying ? [...confirmed] : []),
    invalidatedEvidence: Object.freeze(
      replaying ? [...policy.invalidatesOnReplay] : [],
    ),
    cleanupAndFencing: policy.cleanupAndFencing,
    ownershipTakeover: ownership.takeover,
    requiredTakeoverFencing: Object.freeze(
      ownership.takeover
        ? ([
            "fence-prior-worker-generation",
            "abort-prior-provider-and-tool-work",
            "revoke-prior-identity-leases",
            "reconcile-in-flight-external-effects",
          ] as const)
        : [],
    ),
    implementerResume,
  });
}
