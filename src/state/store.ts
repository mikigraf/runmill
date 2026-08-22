import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "../platform/clock.js";
import { SystemClock } from "../platform/clock.js";
import { RunmillError } from "../errors/runmill-error.js";
import type {
  AsfAdmissionRow,
  EffectiveAsfPolicy,
  WorkOrderEnvelope,
} from "../asf/work-order.js";
import {
  RUN_EVENT_PHASES,
  assertRunEventTransition,
  assertRunPhaseTransition,
  isTerminalRunEventPhase,
  parseRunEvent,
  TERMINAL_RUN_EVENT_PHASES,
  type RunEvent,
  type RunEventPhase,
} from "../asf/run-event.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../asf/canonical-json.js";
import {
  approvalBindingDigest,
  parseApprovalEnvelope,
  type ValidatedApproval,
} from "../asf/approval.js";
import type {
  CancellationRequest,
  CancellationResult,
} from "../asf/cancellation.js";
import type {
  AcknowledgeOutcomeResult,
  OutcomeAcknowledgement,
} from "../asf/outcome.js";
import {
  reconciliationRequestSchema,
  type AsfPendingReconciliationPage,
  type AsfDurableReconciliationContinuation,
  type AsfReconciliationRecord,
  type AsfReconciliationResultEnvelope,
  type AsfReconciliationPendingSetBinding,
  type AsfReconciliationRecoveryCursor,
  type ReconciliationRequest,
  type ReconciliationRequestResult,
} from "../asf/reconciliation.js";
import {
  ASF_DURABLE_CHECKPOINT_SCHEMA,
  createDurableAsfCheckpoint,
  getAsfCheckpointRecoveryPolicy,
  parseDurableAsfCheckpoint,
  publicAsfCheckpointSummary,
  type AsfCheckpointKind,
  type DurableAsfCheckpoint,
  type ProtectedImplementerResumeMetadata,
  type PublicAsfCheckpointSummary,
} from "../asf/checkpoint-policy.js";
import {
  signedAsfEvidenceBundleSchema,
  type SignedAsfEvidenceBundle,
} from "../evidence/asf-bundle.js";
import type { ArtifactVerifiedAsfEvidenceBundle } from "../evidence/asf-validator.js";
import {
  ASF_TERMINAL_EVIDENCE_INTENT_SCHEMA,
  asfTerminalCleanupObservationSchema,
  asfTerminalEvidencePlanSchema,
  asfTerminalEvidenceIntentSchema,
  portableAsfTerminalProviderBudgetEvidence,
  signedAsfTerminalEvidenceBundleSchema,
  type AsfTerminalEvidencePlan,
  type AsfTerminalCleanupObservation,
  type AsfTerminalEvidenceIntent,
  type SignedAsfTerminalEvidenceBundle,
  type ValidatedAsfTerminalEvidenceBundle,
} from "../evidence/asf-terminal.js";
import {
  ASF_TERMINAL_EFFECT_LEDGER_MAX_CANONICAL_BYTES,
  ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS,
  ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS,
  ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT,
  ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS,
  ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS,
  buildAsfTerminalEffectLedger,
  type AsfTerminalEffectLedger,
  type AsfTerminalEffect,
  type AsfTerminalReconciliation,
} from "../evidence/asf-terminal-effects.js";
import {
  ASF_PROVIDER_BUDGET_ROLES,
  asfProviderBudgetReservationId,
  asfProviderInvocationId,
  type AsfProviderBudgetCompletion,
  type AsfProviderBudgetExhaustionReason,
  type AsfProviderBudgetRole,
  type AsfRunBudgetCheck,
} from "../asf/budget.js";
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from "./migrations.js";

export { CURRENT_SCHEMA_VERSION };

const BUSY_TIMEOUT_MS = 5_000;

/** Detailed ASF lifecycle events remain available for at least seven days. */
export const MIN_ASF_DETAILED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function canonicalEnvelopeDigest(
  canonicalEnvelope: string,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalEnvelope, "utf8")
    .digest("hex")}`;
}

const ASF_EXTERNAL_AUTHORITY_FROZEN_PHASES: ReadonlySet<string> = new Set([
  "CANCEL_REQUESTED",
  "CANCELLING",
  "WAITING_APPROVAL",
  "NEEDS_SPEC",
  "BLOCKED_EXTERNAL",
]);

function asfPhaseFreezesExternalAuthority(phase: string): boolean {
  return (
    ASF_EXTERNAL_AUTHORITY_FROZEN_PHASES.has(phase) ||
    isTerminalRunEventPhase(phase)
  );
}

function isJsonObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ASF_EVENT_CHECKPOINT_REQUIREMENTS = Object.freeze({
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
} as const satisfies Readonly<Record<string, AsfCheckpointKind>>);

export interface RunRow {
  runId: string;
  issueId: string;
  repo: string;
  provider: string;
  state: string;
  stateVersion: number;
  attempt: number;
  baseCommit: string | null;
  candidateSha: string | null;
  branch: string | null;
}

/** ASF-only ownership fields kept out of the existing standalone JSON contract. */
export interface AsfRunRow extends RunRow {
  mode: "asf-worker";
  workOrderId: string;
  attemptId: string;
  generation: number;
  ownerId: string | null;
  heartbeatAt: string | null;
}

export interface AsfAdmissionRecord extends AsfAdmissionRow {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly canonicalEnvelope: string;
  readonly effectivePolicy: string;
  readonly effectivePolicyDigest: string;
  readonly signatureKeyId: string;
  readonly signatureAlgorithm: string;
  readonly acceptedAt: string;
}

export interface AsfApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly workOrderDigest: string;
  readonly candidateSha: string;
  readonly decision: "approved" | "denied";
  readonly decisionType: string;
  readonly requestedEffect: string;
  readonly policyDigest: string;
  readonly approverSubject: string;
  readonly approverAuthority: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signatureKeyId: string;
  readonly signatureAlgorithm: "EdDSA";
  readonly canonicalEnvelope: string;
  readonly envelopeDigest: string;
  readonly bindingDigest: string;
  readonly recordedAt: string;
}

export interface AsfCancellationRecord {
  readonly requestId: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly requester: string;
  readonly requesterAuthority: string;
  readonly reason: string;
  readonly mode: "graceful" | "forced";
  readonly graceSeconds: number;
  readonly requestedAt: string;
  readonly recordedAt: string;
}

export type AsfEffectStatus =
  | "intended"
  | "in_flight"
  | "confirmed"
  | "not_applied"
  | "ambiguous";

export type AsfGitHubEffectOperation =
  | "branch.push"
  | "pull_request.create"
  | "pull_request.update"
  | "status.create"
  | "check.create"
  | "comment.create";

export interface AsfEffectRow {
  readonly effectKey: string;
  readonly runId: string;
  readonly generation: number;
  readonly system: "github";
  readonly operation: AsfGitHubEffectOperation;
  readonly target: string;
  readonly correlationMarker: string;
  readonly candidateSha: string;
  readonly expectedRemoteSha: string | null;
  readonly policyDigest: string;
  readonly intentDigest: string;
  readonly status: AsfEffectStatus;
  readonly remoteId: string | null;
  readonly observationDigest: string | null;
  readonly retryProhibited: 0 | 1;
  readonly intendedAt: string;
  readonly updatedAt: string;
}

export interface AsfEffectObservationRow {
  readonly effectKey: string;
  readonly seq: number;
  readonly outcome: "confirmed" | "not_applied" | "ambiguous";
  readonly candidateSha: string;
  readonly detailsDigest: string;
  readonly observer: string;
  readonly observedAt: string;
}

export interface AsfEvidenceBundleRecord {
  readonly runId: string;
  readonly candidateSha: string;
  readonly policyDigest: string;
  readonly bundleDigest: string;
  readonly canonicalEnvelopeDigest: string;
  readonly canonicalEnvelope: string;
  readonly finalizedAt: string;
}

export interface AsfTerminalEvidenceBundleRecord {
  readonly runId: string;
  readonly terminalPhase:
    | "COMPLETED"
    | "CANCELLED"
    | "FAILED"
    | "REFUSED"
    | "QUARANTINED"
    | "BUDGET_EXHAUSTED";
  readonly terminalEventSeq: number;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  readonly cleanupIntentId: string;
  readonly cleanupIntentDigest: string;
  readonly cleanupDigest: string;
  readonly deliveryBundleDigest: string | null;
  readonly bundleDigest: string;
  readonly canonicalEnvelopeDigest: string;
  readonly canonicalEnvelope: string;
  readonly finalizedAt: string;
}

/**
 * Durable scheduling hint for acknowledged terminal event retention. This is
 * not authority to compact: the write transaction revalidates every binding.
 */
export interface AsfEventRetentionCandidate {
  readonly runId: string;
  readonly generation: number;
  readonly ownerId: string | null;
  readonly terminalEventSeq: number;
  readonly terminalEventAt: string;
  readonly bundleDigest: string;
  readonly compactedThrough: number;
}

function parseAsfEventRetentionCandidate(
  row: AsfEventRetentionCandidate,
): AsfEventRetentionCandidate {
  if (
    typeof row.runId !== "string" ||
    row.runId === "" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    (row.ownerId !== null &&
      (typeof row.ownerId !== "string" || row.ownerId === "")) ||
    !Number.isSafeInteger(row.terminalEventSeq) ||
    row.terminalEventSeq < 2 ||
    typeof row.terminalEventAt !== "string" ||
    !Number.isFinite(Date.parse(row.terminalEventAt)) ||
    !/^sha256:[a-f0-9]{64}$/u.test(row.bundleDigest) ||
    !Number.isSafeInteger(row.compactedThrough) ||
    row.compactedThrough < 0 ||
    row.compactedThrough >= row.terminalEventSeq - 1
  ) {
    throw new Error("stored ASF event-retention candidate is malformed");
  }
  return row;
}

export interface AsfTerminalEvidenceIntentRecord {
  readonly runId: string;
  readonly terminalPhase: AsfTerminalEvidenceBundleRecord["terminalPhase"];
  readonly terminalEventSeq: number;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  readonly cleanupIntentId: string;
  readonly cleanupIntentDigest: string;
  readonly cleanupDigest: string;
  readonly deliveryBundleDigest: string | null;
  readonly planDigest: string;
  readonly intentDigest: string;
  readonly canonicalIntent: string;
  readonly createdAt: string;
}

export interface AsfTerminalEvidencePlanRecord {
  readonly runId: string;
  readonly terminalPhase: AsfTerminalEvidenceBundleRecord["terminalPhase"];
  readonly terminalEventSeq: number;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  readonly cleanupIntentId: string;
  readonly cleanupIntentDigest: string;
  readonly deliveryBundleDigest: string | null;
  readonly planDigest: string;
  readonly canonicalPlan: string;
  readonly createdAt: string;
}

export interface AsfCheckpointRecord {
  readonly checkpointId: string;
  readonly runId: string;
  readonly checkpointKind: string;
  readonly phase: string;
  readonly eventSeq: number;
  readonly fencingGeneration: number;
  readonly candidateSha: string | null;
  readonly policyDigest: string;
  readonly checkpointDigest: string;
  readonly replayPolicy: string;
  readonly canonicalCheckpoint: string;
  readonly createdAt: string;
  readonly recordedAt: string;
}

/**
 * Protected checkpoint material whose run/event/fence bindings are derived by
 * StateStore inside the lifecycle transition transaction. Callers can supply
 * evidence content, but cannot choose the authoritative phase, sequence,
 * candidate lineage, policy, Work Order, timestamp, or generation.
 */
export interface AsfAtomicCheckpointInput {
  readonly kind: AsfCheckpointKind;
  readonly durableInputs: JsonValue;
  readonly durableOutputs: JsonValue;
  readonly correlationMarker: string | null;
  /** Protected controller metadata; StateStore rebinds and validates it atomically. */
  readonly protectedImplementerResume?:
    | ProtectedImplementerResumeMetadata
    | null
    | undefined;
}

/** Exact wire-shaped delivery intent persisted before a lifecycle adapter call. */
export interface StateAsfDeliveryStageIntent {
  readonly schema: "asf.delivery-stage-intent/v1";
  readonly intent_id: string;
  readonly intent_digest: string;
  readonly effect_key: string;
  readonly stage:
    | "repository-lease"
    | "identity-leases"
    | "workspace"
    | "task-packet"
    | "implementer-session"
    | "candidate"
    | "local-verification"
    | "local-review"
    | "candidate-invalidation"
    | "branch-push"
    | "pull-request"
    | "ci"
    | "pull-request-review"
    | "evidence"
    | "cleanup";
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

export interface StoredAsfDeliveryStageIntent
  extends StateAsfDeliveryStageIntent {
  readonly observationDigest: string | null;
  readonly observationOutcome: "confirmed" | "not_applied" | "ambiguous" | null;
  readonly confirmedGeneration: number | null;
  readonly confirmedAt: string | null;
  /** Exact completed reconciliation whose not-applied result authorized one replay. */
  readonly replayAuthorizedOperationId: string | null;
  /** Generation that consumed the replay authorization before calling the adapter. */
  readonly replayStartedGeneration: number | null;
}

export interface AsfDeliveryIntentObservationRow {
  readonly effectKey: string;
  readonly seq: number;
  readonly outcome: "confirmed" | "not_applied" | "ambiguous";
  readonly observationDigest: string;
  readonly generation: number;
  readonly source: "confirmation" | "reconciliation" | "legacy";
  readonly observedAt: string;
}

interface AsfDeliveryStageIntentDatabaseRow
  extends StoredAsfDeliveryStageIntent {
  readonly canonicalIntent: string;
}

interface CanonicalAsfPendingEffect {
  readonly effect_class: "github-effect" | "delivery-intent";
  readonly effect_key: string;
  readonly candidate_sha: string | null;
  readonly policy_digest: string;
  readonly intent_digest: string;
  readonly operation: string;
  readonly event_seq: number | null;
}

interface CanonicalAsfPendingSet {
  readonly schema: "asf.pending-reconciliation-set/v2";
  readonly run_id: string;
  readonly effects: readonly CanonicalAsfPendingEffect[];
}

interface CanonicalAsfPendingSetSnapshot {
  readonly value: CanonicalAsfPendingSet;
  readonly canonical: string;
  readonly digest: string;
  readonly githubEffectCount: number;
  readonly deliveryIntentCount: number;
}

export interface StateAsfDeliveryBinding {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly fencingGeneration: number;
  readonly candidateSha: string | null;
}

export interface AsfEventPage {
  readonly events: readonly RunEvent[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly gap: boolean;
  readonly compactedThrough: number | null;
  readonly snapshot: AsfRunCursorSnapshot;
}

export interface AsfRunCursorSnapshot {
  readonly run: AsfRunRow;
  readonly latestSequence: number;
}

export interface AsfDurableRunSnapshot extends AsfRunCursorSnapshot {
  readonly admission: AsfAdmissionRecord;
}

export interface LeaseRow {
  issueId: string;
  runId: string;
  repo: string;
  generation: number;
  expiresAt: string;
  heartbeatAt: string | null;
  releasedAt: string | null;
}

export type SideEffectStatus =
  | "intended"
  | "in_flight"
  | "confirmed"
  | "failed";

export interface SideEffectRow {
  key: string;
  runId: string;
  system: string;
  operation: string;
  target: string;
  status: SideEffectStatus;
  remoteId: string | null;
  lastError: string | null;
}

export interface BudgetLedgerRow {
  readonly dayBucket: string;
  readonly repo: string;
  readonly costUsd: number;
  readonly invocations: number;
}

export type AsfProviderBudgetReservationStatus =
  | "reserved"
  | "completed"
  | "denied"
  | "settled_unknown";

/** Non-secret, exact-bound provider usage record suitable for evidence assembly. */
export interface AsfProviderBudgetReservationRecord {
  readonly reservationId: string;
  readonly reservationDigest: string;
  readonly effectKey: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly initialGeneration: number;
  readonly completedGeneration: number | null;
  readonly lifecycleCandidateSha: string | null;
  readonly providerCandidateSha: string;
  readonly role: AsfProviderBudgetRole;
  readonly invocationId: string;
  readonly reservedCostMicros: number;
  readonly actualCostMicros: number | null;
  readonly maxCostMicros: number;
  readonly maxAgentInvocations: number;
  readonly acceptedAt: string;
  readonly deadlineAt: string;
  readonly status: AsfProviderBudgetReservationStatus;
  readonly denialReason: AsfProviderBudgetExhaustionReason | null;
  readonly denialObservationDigest: string | null;
  readonly providerResultDigest: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly principal: string | null;
  readonly profile: string | null;
  /** Reconciliation outcome that closed an invocation whose cost stayed unknown. */
  readonly settlementOutcome: "confirmed" | "not_applied" | null;
  readonly settlementObservationDigest: string | null;
  readonly settlementDigest: string | null;
  readonly settlementGeneration: number | null;
  readonly settlementAt: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface AsfProviderBudgetUsage {
  readonly runId: string;
  readonly acceptedAt: string;
  readonly deadlineAt: string;
  readonly maxCostMicros: number;
  readonly completedCostMicros: number;
  readonly settledUnknownCostMicros: number;
  readonly outstandingReservedCostMicros: number;
  readonly conservativeCostMicros: number;
  readonly maxAgentInvocations: number;
  readonly invocationCount: number;
  readonly deniedCount: number;
  readonly settlementCount: number;
}

/** Deterministic public provider ledger commitment for signed terminal evidence. */
export interface AsfProviderBudgetEvidenceSummary {
  readonly schema: "asf.provider-budget-evidence-summary/v1";
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly candidateSha: string | null;
  readonly usage: {
    readonly maxCostMicros: number;
    /** Cost reported by completed provider results; excludes unknown settlements. */
    readonly reportedActualCostMicros: number;
    /** Full reservation caps charged because provider cost stayed unknown. */
    readonly settledUnknownCostMicros: number;
    readonly outstandingReservedCostMicros: number;
    readonly conservativeCostMicros: number;
    readonly invocationCount: number;
    readonly completedInvocationCount: number;
    readonly settledUnknownInvocationCount: number;
    readonly outstandingInvocationCount: number;
    readonly deniedCount: number;
  };
  readonly invocations: readonly {
    readonly reservationId: string;
    readonly reservationDigest: string;
    readonly effectKey: string;
    readonly intentId: string;
    readonly intentDigest: string;
    readonly invocationId: string;
    readonly role: AsfProviderBudgetRole;
    readonly lifecycleCandidateSha: string | null;
    readonly providerCandidateSha: string;
    readonly initialGeneration: number;
    readonly completedGeneration: number;
    readonly status: "completed" | "settled_unknown";
    readonly reservedCostMicros: number;
    readonly chargedCostMicros: number;
    readonly attributionStatus: "reported" | "provider_unknown";
    readonly providerResultDigest: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly principal: string | null;
    readonly profile: string | null;
    readonly settlementOutcome: "confirmed" | "not_applied" | null;
    readonly settlementObservationDigest: string | null;
    readonly settlementDigest: string | null;
    readonly completedAt: string;
  }[];
  readonly settlementDigests: readonly string[];
  readonly ledgerDigest: string;
}

/** Non-daily daemon breaker names backed by the circuit_breakers table. */
export type DurableCircuitBreakerName =
  | "consecutive-failures"
  | "quarantine"
  | "escalation-rate";

export interface DurableCircuitBreakerTrip {
  readonly name: DurableCircuitBreakerName;
  readonly openedAt: string;
  readonly reason: string;
}

/**
 * Complete persistent breaker snapshot. Daily cost is deliberately absent:
 * its durable source of truth is budget_ledger, bucketed by calendar day.
 */
export interface DurableCircuitBreakerState {
  readonly consecutiveFailures: number;
  readonly quarantines: number;
  readonly escalations: number;
  readonly completed: number;
  readonly tripped: DurableCircuitBreakerTrip | null;
}

export interface StateAsfBudgetLimits {
  readonly wallSeconds: number;
  readonly maxCostMicros: number;
  readonly maxAgentInvocations: number;
}

export type StateAsfBudgetBinding = StateAsfDeliveryBinding;

interface EffectiveAsfBudgetPolicy extends StateAsfBudgetLimits {
  readonly acceptedAt: string;
  readonly deadlineAt: string;
}

export interface StateStoreOptions {
  readonly clock?: Clock;
}

const DURABLE_CIRCUIT_BREAKER_NAMES = [
  "consecutive-failures",
  "escalation-rate",
  "quarantine",
] as const satisfies readonly DurableCircuitBreakerName[];
const DURABLE_CIRCUIT_BREAKER_NAME_SET = new Set<string>(
  DURABLE_CIRCUIT_BREAKER_NAMES,
);
const CIRCUIT_BREAKER_COUNTER_SCHEMA = "runmill.circuit-breaker-counter/v1";
const CIRCUIT_BREAKER_RATE_SCHEMA = "runmill.circuit-breaker-rate/v1";
const CIRCUIT_BREAKER_REASON = /^[^\u0000-\u001f\u007f]{1,4096}$/u;

interface CircuitBreakerStorageRow {
  readonly name: unknown;
  readonly state: unknown;
  readonly openedAt: unknown;
  readonly reason: unknown;
}

function circuitBreakerStateError(message: string): RunmillError {
  return RunmillError.fromCatalog("RM-STATE-002", { whatHappened: message });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertValidCircuitBreakerCount(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw circuitBreakerStateError(
      `durable circuit breaker ${field} is not a non-negative integer`,
    );
  }
}

function assertValidDurableCircuitBreakerState(
  value: unknown,
): asserts value is DurableCircuitBreakerState {
  if (
    !isObjectRecord(value) ||
    !hasExactKeys(value, [
      "completed",
      "consecutiveFailures",
      "escalations",
      "quarantines",
      "tripped",
    ])
  ) {
    throw circuitBreakerStateError(
      "durable circuit breaker snapshot has unknown or missing fields",
    );
  }

  assertValidCircuitBreakerCount(value["completed"], "completed count");
  assertValidCircuitBreakerCount(
    value["consecutiveFailures"],
    "consecutive failure count",
  );
  assertValidCircuitBreakerCount(value["escalations"], "escalation count");
  assertValidCircuitBreakerCount(value["quarantines"], "quarantine count");

  const completed = value["completed"];
  const consecutiveFailures = value["consecutiveFailures"];
  const escalations = value["escalations"];
  const quarantines = value["quarantines"];
  if (
    consecutiveFailures > completed ||
    escalations > completed ||
    quarantines > completed
  ) {
    throw circuitBreakerStateError(
      "durable circuit breaker counters contradict the completed run count",
    );
  }

  const tripped = value["tripped"];
  if (tripped === null) return;
  if (
    !isObjectRecord(tripped) ||
    !hasExactKeys(tripped, ["name", "openedAt", "reason"]) ||
    typeof tripped["name"] !== "string" ||
    !DURABLE_CIRCUIT_BREAKER_NAME_SET.has(tripped["name"]) ||
    typeof tripped["openedAt"] !== "string" ||
    !isCanonicalIsoTimestamp(tripped["openedAt"]) ||
    typeof tripped["reason"] !== "string" ||
    !CIRCUIT_BREAKER_REASON.test(tripped["reason"]) ||
    tripped["reason"].trim() !== tripped["reason"]
  ) {
    throw circuitBreakerStateError(
      "durable circuit breaker trip is malformed or unknown",
    );
  }
  if (
    (tripped["name"] === "consecutive-failures" && consecutiveFailures === 0) ||
    (tripped["name"] === "quarantine" && quarantines === 0) ||
    (tripped["name"] === "escalation-rate" &&
      (completed === 0 || escalations === 0))
  ) {
    throw circuitBreakerStateError(
      "durable circuit breaker trip contradicts its counters",
    );
  }
}

const ASF_DELIVERY_INTENT_KEYS = [
  "attempt_id",
  "candidate_sha",
  "created_at",
  "effect_key",
  "event_seq",
  "fencing_generation",
  "intent_digest",
  "intent_id",
  "operation_digest",
  "policy_digest",
  "run_id",
  "schema",
  "stage",
  "work_order_id",
] as const;

const ASF_DELIVERY_INTENT_STAGES = new Set<
  StateAsfDeliveryStageIntent["stage"]
>([
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
]);

const ASF_DELIVERY_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ASF_DELIVERY_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ASF_DELIVERY_GIT_SHA = /^[a-f0-9]{40}$/u;

function asfDeliveryStateError(message: string, runId?: string): RunmillError {
  return RunmillError.fromCatalog("RM-STATE-002", {
    whatHappened: message,
    ...(runId === undefined ? {} : { runId }),
  });
}

function asfReconciliationStateError(
  message: string,
  runId?: string,
): RunmillError {
  return RunmillError.fromCatalog("RM-RECON-001", {
    whatHappened: message,
    ...(runId === undefined ? {} : { runId }),
  });
}

function asfDeliveryUnsignedIntent(intent: StateAsfDeliveryStageIntent) {
  return {
    schema: intent.schema,
    intent_id: intent.intent_id,
    effect_key: intent.effect_key,
    stage: intent.stage,
    run_id: intent.run_id,
    work_order_id: intent.work_order_id,
    attempt_id: intent.attempt_id,
    policy_digest: intent.policy_digest,
    fencing_generation: intent.fencing_generation,
    candidate_sha: intent.candidate_sha,
    event_seq: intent.event_seq,
    operation_digest: intent.operation_digest,
    created_at: intent.created_at,
  } as const;
}

/**
 * Reject malformed or non-deterministic intent identities before any durable
 * mutation. This repeats the runner's derivation deliberately: the durable
 * authority must not trust a caller's self-attestation.
 */
function assertValidAsfDeliveryIntent(
  intent: StateAsfDeliveryStageIntent,
): string {
  const keys = Object.keys(intent).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify([...ASF_DELIVERY_INTENT_KEYS].sort())
  ) {
    throw asfDeliveryStateError(
      "ASF delivery intent has unknown or missing fields",
    );
  }
  if (
    intent.schema !== "asf.delivery-stage-intent/v1" ||
    !ASF_DELIVERY_INTENT_STAGES.has(intent.stage) ||
    !ASF_DELIVERY_IDENTIFIER.test(intent.intent_id) ||
    !ASF_DELIVERY_IDENTIFIER.test(intent.effect_key) ||
    !ASF_DELIVERY_IDENTIFIER.test(intent.run_id) ||
    !ASF_DELIVERY_IDENTIFIER.test(intent.work_order_id) ||
    !ASF_DELIVERY_IDENTIFIER.test(intent.attempt_id) ||
    !ASF_DELIVERY_DIGEST.test(intent.intent_digest) ||
    !ASF_DELIVERY_DIGEST.test(intent.policy_digest) ||
    !ASF_DELIVERY_DIGEST.test(intent.operation_digest) ||
    (intent.candidate_sha !== null &&
      !ASF_DELIVERY_GIT_SHA.test(intent.candidate_sha)) ||
    !Number.isSafeInteger(intent.fencing_generation) ||
    intent.fencing_generation < 1 ||
    !Number.isSafeInteger(intent.event_seq) ||
    intent.event_seq < 1 ||
    !Number.isFinite(Date.parse(intent.created_at))
  ) {
    throw asfDeliveryStateError(
      "ASF delivery intent is malformed",
      intent.run_id,
    );
  }
  const expectedEffectKey = `delivery_effect_${sha256Digest({
    stage: intent.stage,
    run_id: intent.run_id,
    candidate_sha: intent.candidate_sha,
    event_seq: intent.event_seq,
    operation_digest: intent.operation_digest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  if (intent.effect_key !== expectedEffectKey) {
    throw asfDeliveryStateError(
      `ASF delivery effect key ${intent.effect_key} is not deterministically bound to its operation`,
      intent.run_id,
    );
  }
  const identityDigest = sha256Digest({
    effect_key: intent.effect_key,
    generation: intent.fencing_generation,
  });
  const expectedIntentId = `delivery_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`;
  if (intent.intent_id !== expectedIntentId) {
    throw asfDeliveryStateError(
      `ASF delivery intent id ${intent.intent_id} is not deterministically fenced`,
      intent.run_id,
    );
  }
  if (
    sha256Digest(asfDeliveryUnsignedIntent(intent)) !== intent.intent_digest
  ) {
    throw asfDeliveryStateError(
      "ASF delivery intent digest is internally contradictory",
      intent.run_id,
    );
  }
  return canonicalJson({
    ...asfDeliveryUnsignedIntent(intent),
    intent_digest: intent.intent_digest,
  });
}

function sameAsfDeliveryEffect(
  left: StateAsfDeliveryStageIntent,
  right: StateAsfDeliveryStageIntent,
): boolean {
  return (
    canonicalJson({
      schema: left.schema,
      effect_key: left.effect_key,
      stage: left.stage,
      run_id: left.run_id,
      work_order_id: left.work_order_id,
      attempt_id: left.attempt_id,
      policy_digest: left.policy_digest,
      candidate_sha: left.candidate_sha,
      event_seq: left.event_seq,
      operation_digest: left.operation_digest,
      created_at: left.created_at,
    }) ===
    canonicalJson({
      schema: right.schema,
      effect_key: right.effect_key,
      stage: right.stage,
      run_id: right.run_id,
      work_order_id: right.work_order_id,
      attempt_id: right.attempt_id,
      policy_digest: right.policy_digest,
      candidate_sha: right.candidate_sha,
      event_seq: right.event_seq,
      operation_digest: right.operation_digest,
      created_at: right.created_at,
    })
  );
}

function asfBudgetReservationMaterial(input: {
  readonly reservationId: string;
  readonly effectKey: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly initialGeneration: number;
  readonly lifecycleCandidateSha: string | null;
  readonly providerCandidateSha: string;
  readonly role: AsfProviderBudgetRole;
  readonly invocationId: string;
  readonly reservedCostMicros: number;
  readonly maxCostMicros: number;
  readonly maxAgentInvocations: number;
  readonly acceptedAt: string;
  readonly deadlineAt: string;
  readonly createdAt: string;
}) {
  return {
    schema: "asf.provider-budget-reservation/v1" as const,
    reservation_id: input.reservationId,
    effect_key: input.effectKey,
    intent_id: input.intentId,
    intent_digest: input.intentDigest,
    run_id: input.runId,
    work_order_id: input.workOrderId,
    attempt_id: input.attemptId,
    policy_digest: input.policyDigest,
    initial_generation: input.initialGeneration,
    lifecycle_candidate_sha: input.lifecycleCandidateSha,
    provider_candidate_sha: input.providerCandidateSha,
    role: input.role,
    invocation_id: input.invocationId,
    reserved_cost_micros: input.reservedCostMicros,
    max_cost_micros: input.maxCostMicros,
    max_agent_invocations: input.maxAgentInvocations,
    accepted_at: input.acceptedAt,
    deadline_at: input.deadlineAt,
    created_at: input.createdAt,
  } as const;
}

function asfBudgetUnknownSettlementMaterial(input: {
  readonly reservation: AsfProviderBudgetReservationRecord;
  readonly outcome: "confirmed" | "not_applied";
  readonly observationDigest: string;
  readonly settlementGeneration: number;
  readonly settlementAt: string;
}) {
  const reservation = input.reservation;
  return {
    schema: "asf.provider-budget-unknown-settlement/v1" as const,
    reservation_id: reservation.reservationId,
    reservation_digest: reservation.reservationDigest,
    effect_key: reservation.effectKey,
    intent_id: reservation.intentId,
    intent_digest: reservation.intentDigest,
    run_id: reservation.runId,
    work_order_id: reservation.workOrderId,
    attempt_id: reservation.attemptId,
    policy_digest: reservation.policyDigest,
    initial_generation: reservation.initialGeneration,
    settlement_generation: input.settlementGeneration,
    lifecycle_candidate_sha: reservation.lifecycleCandidateSha,
    provider_candidate_sha: reservation.providerCandidateSha,
    role: reservation.role,
    invocation_id: reservation.invocationId,
    reconciliation_outcome: input.outcome,
    reconciliation_observation_digest: input.observationDigest,
    settled_cost_micros: reservation.reservedCostMicros,
    settled_at: input.settlementAt,
  } as const;
}

function expectedAsfBudgetUnknownSettlementDigest(
  reservation: AsfProviderBudgetReservationRecord,
): string | null {
  if (
    reservation.settlementOutcome === null ||
    reservation.settlementObservationDigest === null ||
    reservation.settlementGeneration === null ||
    reservation.settlementAt === null
  ) {
    return null;
  }
  return sha256Digest(
    asfBudgetUnknownSettlementMaterial({
      reservation,
      outcome: reservation.settlementOutcome,
      observationDigest: reservation.settlementObservationDigest,
      settlementGeneration: reservation.settlementGeneration,
      settlementAt: reservation.settlementAt,
    }),
  );
}

/**
 * Durable run state.
 *
 * Single-writer by design: a flock on the data directory enforces one
 * orchestrator, and writers use short IMMEDIATE transactions so concurrent
 * readers (`status`, `logs --follow`) never see a partial state.
 */
export class StateStore {
  readonly #db: Database.Database;
  readonly #clock: Clock;

  private constructor(db: Database.Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  static open(path: string, options: StateStoreOptions = {}): StateStore {
    const clock = options.clock ?? new SystemClock();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const existedBefore = existsSync(path);
    const db = new Database(path);

    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");

    const store = new StateStore(db, clock);
    try {
      store.#migrate(path, existedBefore);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #userVersion(): number {
    return Number(this.#db.pragma("user_version", { simple: true }));
  }

  /** Runs multi-statement DDL. `Database#exec` is better-sqlite3's API; it is
   *  not `child_process`, and no user input ever reaches it: every string
   *  comes from the compiled-in MIGRATIONS table. */
  #applyDdl(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * Migration v10 cannot hash signed envelopes in SQLite. Validate and bind
   * every legacy envelope while the migration's IMMEDIATE transaction is
   * still open, then exercise the ordinary strict readers before committing.
   */
  #backfillAsfSignedEnvelopeDigests(): void {
    const deliveryRows = this.#db
      .prepare(
        `SELECT run_id AS runId, canonical_envelope AS canonicalEnvelope
         FROM asf_evidence_bundles ORDER BY run_id`,
      )
      .all() as {
      readonly runId: string;
      readonly canonicalEnvelope: string;
    }[];
    for (const row of deliveryRows) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.canonicalEnvelope) as unknown;
      } catch {
        throw new Error(
          `cannot migrate non-JSON ASF evidence envelope for ${row.runId}`,
        );
      }
      const parsed = signedAsfEvidenceBundleSchema.safeParse(raw);
      if (
        !parsed.success ||
        canonicalJson(parsed.data) !== row.canonicalEnvelope
      ) {
        throw new Error(
          `cannot migrate malformed or non-canonical ASF evidence envelope for ${row.runId}`,
        );
      }
      const updated = this.#db
        .prepare(
          `UPDATE asf_evidence_bundles
           SET canonical_envelope_digest = ?
           WHERE run_id = ? AND canonical_envelope = ?`,
        )
        .run(
          canonicalEnvelopeDigest(row.canonicalEnvelope),
          row.runId,
          row.canonicalEnvelope,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `cannot bind migrated ASF evidence envelope for ${row.runId}`,
        );
      }
    }

    const terminalRows = this.#db
      .prepare(
        `SELECT run_id AS runId, canonical_envelope AS canonicalEnvelope
         FROM asf_terminal_evidence_bundles ORDER BY run_id`,
      )
      .all() as {
      readonly runId: string;
      readonly canonicalEnvelope: string;
    }[];
    for (const row of terminalRows) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.canonicalEnvelope) as unknown;
      } catch {
        throw new Error(
          `cannot migrate non-JSON ASF terminal evidence envelope for ${row.runId}`,
        );
      }
      const parsed = signedAsfTerminalEvidenceBundleSchema.safeParse(raw);
      if (
        !parsed.success ||
        canonicalJson(parsed.data) !== row.canonicalEnvelope
      ) {
        throw new Error(
          `cannot migrate malformed or non-canonical ASF terminal evidence envelope for ${row.runId}`,
        );
      }
      const updated = this.#db
        .prepare(
          `UPDATE asf_terminal_evidence_bundles
           SET canonical_envelope_digest = ?
           WHERE run_id = ? AND canonical_envelope = ?`,
        )
        .run(
          canonicalEnvelopeDigest(row.canonicalEnvelope),
          row.runId,
          row.canonicalEnvelope,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `cannot bind migrated ASF terminal evidence envelope for ${row.runId}`,
        );
      }
    }

    for (const row of deliveryRows) {
      if (this.getAsfEvidenceBundle(row.runId) === undefined) {
        throw new Error(`migrated ASF evidence disappeared for ${row.runId}`);
      }
    }
    for (const row of terminalRows) {
      if (this.getAsfTerminalEvidenceBundle(row.runId) === undefined) {
        throw new Error(
          `migrated ASF terminal evidence disappeared for ${row.runId}`,
        );
      }
    }
  }

  #migrate(path: string, existedBefore: boolean): void {
    const observed = this.#userVersion();

    if (observed > CURRENT_SCHEMA_VERSION) {
      throw RunmillError.fromCatalog("RM-STATE-001", {
        whatHappened:
          `Database at ${path} is at schema version ${observed}; ` +
          `this binary understands up to ${CURRENT_SCHEMA_VERSION}.`,
      });
    }

    if (observed === CURRENT_SCHEMA_VERSION) return;

    // VACUUM INTO uses SQLite's snapshot machinery, so the backup includes
    // committed WAL pages. A filesystem copy of only the main file does not.
    if (existedBefore) {
      const stamp = this.#clock.now().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${path}.backup-${stamp}-${process.pid}-${randomUUID()}`;
      try {
        this.#db.prepare("VACUUM INTO ?").run(backupPath);
      } catch (cause) {
        throw RunmillError.fromCatalog("RM-STATE-003", {
          whatHappened:
            `Could not create a consistent pre-migration backup for ${path}: ` +
            (cause instanceof Error ? cause.message : String(cause)),
        });
      }
    }

    const tx = this.#db.transaction(() => {
      // A second opener may have completed the migration while this process
      // waited for SQLite's write lock. Re-read only after BEGIN IMMEDIATE.
      const current = this.#userVersion();
      if (current > CURRENT_SCHEMA_VERSION) {
        throw RunmillError.fromCatalog("RM-STATE-001", {
          whatHappened:
            `Database at ${path} is at schema version ${current}; ` +
            `this binary understands up to ${CURRENT_SCHEMA_VERSION}.`,
        });
      }
      const pending = MIGRATIONS.filter(
        (migration) => migration.version > current,
      ).sort((a, b) => a.version - b.version);
      for (const migration of pending) {
        this.#applyDdl(migration.up);
        if (migration.version === 10) {
          this.#backfillAsfSignedEnvelopeDigests();
        }
        this.#db
          .prepare(
            "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)",
          )
          .run(
            migration.version,
            migration.name,
            this.#clock.now().toISOString(),
          );
        this.#db.pragma(`user_version = ${migration.version}`);
      }
    });
    tx.immediate();
  }

  schemaVersion(): number {
    return this.#userVersion();
  }

  appliedMigrations(): { version: number; name: string }[] {
    return this.#db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
  }

  pragma(name: string): string | number {
    return this.#db.pragma(name, { simple: true }) as string | number;
  }

  /** Test-only escape hatch for exercising migration and refusal paths. */
  forceSchemaVersionForTest(version: number): void {
    this.#db.pragma(`user_version = ${version}`);
  }

  close(): void {
    this.#db.close();
  }

  // -- runs --------------------------------------------------------------

  createRun(input: {
    runId: string;
    issueId: string;
    repo: string;
    provider: string;
    attempt?: number;
    baseCommit?: string;
    branch?: string;
  }): void {
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                          base_commit, branch, created_at, updated_at)
         VALUES (?,?,?,?,'DISCOVERED',1,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.issueId,
        input.repo,
        input.provider,
        input.attempt ?? 1,
        input.baseCommit ?? null,
        input.branch ?? null,
        at,
        at,
      );
  }

  getRun(runId: string): RunRow | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch
         FROM runs WHERE run_id = ? AND mode <> 'asf-worker'`,
      )
      .get(runId) as RunRow | undefined;
  }

  /**
   * Compare-and-swap state transition.
   *
   * Guards on both the source state and the version, so two processes cannot
   * both advance a run and a resumed stale process cannot replay a transition
   * that already happened.
   */
  transitionRun(
    runId: string,
    opts: {
      from: string;
      to: string;
      expectedVersion: number;
      reason?: string;
      actor?: string;
    },
  ): void {
    const at = this.#clock.now().toISOString();
    const tx = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE runs SET state = ?, state_version = state_version + 1, updated_at = ?
           WHERE run_id = ? AND state = ? AND state_version = ? AND mode <> 'asf-worker'`,
        )
        .run(opts.to, at, runId, opts.from, opts.expectedVersion);

      if (result.changes === 0) {
        const actual = this.getRun(runId);
        throw new Error(
          `transition rejected for ${runId}: expected state ${opts.from} at version ` +
            `${opts.expectedVersion}, found ${actual?.state ?? "<missing run>"} at version ` +
            `${actual?.stateVersion ?? "-"}`,
        );
      }

      const seq =
        (
          this.#db
            .prepare(
              "SELECT COALESCE(MAX(seq), 0) AS s FROM state_transitions WHERE run_id = ?",
            )
            .get(runId) as { s: number }
        ).s + 1;

      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          runId,
          seq,
          opts.from,
          opts.to,
          opts.reason ?? null,
          opts.actor ?? "orchestrator",
          at,
        );
    });
    tx();
  }

  /** Newest first. Backs `runmill list` and `list --needs-attention`. */
  listRuns(limit = 50): RunRow[] {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch
         FROM runs WHERE mode <> 'asf-worker' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as RunRow[];
  }

  // -- ASF Work Order admission -----------------------------------------

  getAsfAdmission(idempotencyKey: string): AsfAdmissionRecord | undefined {
    return this.#db
      .prepare(
        `SELECT idempotency_key AS idempotencyKey, payload_digest AS payloadDigest,
                envelope_digest AS envelopeDigest, canonical_envelope AS canonicalEnvelope,
                work_order_id AS workOrderId, attempt_id AS attemptId, tenant_id AS tenantId,
                run_id AS runId, effective_policy AS effectivePolicy,
                effective_policy_digest AS effectivePolicyDigest,
                signature_key_id AS signatureKeyId,
                signature_algorithm AS signatureAlgorithm, accepted_at AS acceptedAt
         FROM asf_work_order_admissions WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as AsfAdmissionRecord | undefined;
  }

  getAsfAdmissionForRun(runId: string): AsfAdmissionRecord | undefined {
    return this.#db
      .prepare(
        `SELECT idempotency_key AS idempotencyKey, payload_digest AS payloadDigest,
                envelope_digest AS envelopeDigest, canonical_envelope AS canonicalEnvelope,
                work_order_id AS workOrderId, attempt_id AS attemptId, tenant_id AS tenantId,
                run_id AS runId, effective_policy AS effectivePolicy,
                effective_policy_digest AS effectivePolicyDigest,
                signature_key_id AS signatureKeyId,
                signature_algorithm AS signatureAlgorithm, accepted_at AS acceptedAt
         FROM asf_work_order_admissions WHERE run_id = ?`,
      )
      .get(runId) as AsfAdmissionRecord | undefined;
  }

  getAsfRun(runId: string): AsfRunRow | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch, mode,
                work_order_id AS workOrderId, attempt_id AS attemptId,
                generation, owner_id AS ownerId, heartbeat_at AS heartbeatAt
         FROM runs WHERE run_id = ? AND mode = 'asf-worker'`,
      )
      .get(runId) as AsfRunRow | undefined;
  }

  /** One SQLite read transaction: run, admission, and cursor can never tear. */
  getAsfRunSnapshot(runId: string): AsfDurableRunSnapshot | undefined {
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(runId);
      if (run === undefined) return undefined;
      const admission = this.getAsfAdmissionForRun(runId);
      if (admission === undefined) {
        throw new Error(
          `ASF run ${runId} has no immutable Work Order admission`,
        );
      }
      const latestSequence = (
        this.#db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?",
          )
          .get(runId) as { seq: number }
      ).seq;
      if (latestSequence !== run.stateVersion) {
        throw new Error(
          `ASF run ${runId} event sequence ${latestSequence} does not match state version ` +
            run.stateVersion,
        );
      }
      return { run, admission, latestSequence };
    });
    return transaction.deferred();
  }

  listAsfRuns(limit = 1_000): AsfRunRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(
        "ASF run list limit must be an integer from 1 through 10000",
      );
    }
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch, mode,
                work_order_id AS workOrderId, attempt_id AS attemptId,
                generation, owner_id AS ownerId, heartbeat_at AS heartbeatAt
         FROM runs WHERE mode = 'asf-worker' ORDER BY created_at LIMIT ?`,
      )
      .all(limit) as AsfRunRow[];
  }

  /** All durable work that recovery must consider; terminal history cannot hide it. */
  listRecoverableAsfRuns(): AsfRunRow[] {
    const placeholders = TERMINAL_RUN_EVENT_PHASES.map(() => "?").join(",");
    return this.#db
      .prepare(
        `SELECT run_id AS runId, issue_id AS issueId, repo, provider, state,
                state_version AS stateVersion, attempt, base_commit AS baseCommit,
                candidate_sha AS candidateSha, branch, mode,
                work_order_id AS workOrderId, attempt_id AS attemptId,
                generation, owner_id AS ownerId, heartbeat_at AS heartbeatAt
         FROM runs
         WHERE mode = 'asf-worker' AND state NOT IN (${placeholders})
         ORDER BY created_at, run_id`,
      )
      .all(...TERMINAL_RUN_EVENT_PHASES) as AsfRunRow[];
  }

  /**
   * Durably create one admitted ASF run.
   *
   * The immutable admission, run ownership generation, state transition, and
   * first public event commit together. An acknowledgement therefore never
   * names a run that recovery cannot find, even if the process dies immediately
   * after this method returns.
   */
  admitAsfWorkOrder(input: {
    readonly runId: string;
    readonly envelope: WorkOrderEnvelope;
    readonly canonicalEnvelope: string;
    readonly envelopeDigest: string;
    readonly payloadDigest: string;
    readonly effectivePolicy: EffectiveAsfPolicy;
  }): { readonly runId: string; readonly created: boolean } {
    const payload = input.envelope.payload;
    const transaction = this.#db.transaction(() => {
      const existing = this.getAsfAdmission(payload.idempotency_key);
      if (existing !== undefined) {
        if (existing.payloadDigest !== input.payloadDigest) {
          throw RunmillError.fromCatalog("RM-WO-003", {
            whatHappened:
              `idempotency key ${JSON.stringify(payload.idempotency_key)} is already bound ` +
              `to payload ${existing.payloadDigest}, not ${input.payloadDigest}`,
          });
        }
        return { runId: existing.runId, created: false } as const;
      }

      const sameAttempt = this.#db
        .prepare(
          `SELECT idempotency_key AS idempotencyKey, payload_digest AS payloadDigest,
                  run_id AS runId
           FROM asf_work_order_admissions
           WHERE work_order_id = ? AND attempt_id = ?`,
        )
        .get(payload.work_order_id, payload.attempt_id) as
        | { idempotencyKey: string; payloadDigest: string; runId: string }
        | undefined;
      if (sameAttempt !== undefined) {
        throw RunmillError.fromCatalog("RM-WO-003", {
          whatHappened:
            `Work Order ${payload.work_order_id} attempt ${payload.attempt_id} was already admitted ` +
            `as ${sameAttempt.runId} with idempotency key ${JSON.stringify(sameAttempt.idempotencyKey)}`,
        });
      }

      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                            base_commit, branch, created_at, updated_at, mode, work_order_id,
                            attempt_id, generation, owner_id, heartbeat_at)
           VALUES (?,?,?,?, 'ADMITTED', 1, 1, ?, NULL, ?, ?, 'asf-worker', ?, ?, 0, NULL, NULL)`,
        )
        .run(
          input.runId,
          payload.work_item_id,
          payload.repository.repository,
          payload.identities.implementer,
          payload.repository.base_sha.toLowerCase(),
          at,
          at,
          payload.work_order_id,
          payload.attempt_id,
        );

      this.#db
        .prepare(
          `INSERT INTO asf_work_order_admissions(
             idempotency_key, payload_digest, envelope_digest, canonical_envelope,
             work_order_id, attempt_id, tenant_id, run_id, effective_policy,
             effective_policy_digest, signature_key_id, signature_algorithm, accepted_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          payload.idempotency_key,
          input.payloadDigest,
          input.envelopeDigest,
          input.canonicalEnvelope,
          payload.work_order_id,
          payload.attempt_id,
          payload.tenant_id,
          input.runId,
          canonicalJson(input.effectivePolicy as unknown as JsonValue),
          input.effectivePolicy.digest,
          input.envelope.key_id,
          input.envelope.algorithm,
          at,
        );

      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?, 1, 'RECEIVED', 'ADMITTED', 'signed Work Order accepted', 'orchestrator', ?)`,
        )
        .run(input.runId, at);

      const eventId = `evt_${createHash("sha256")
        .update(`${input.runId}:1:work_order.admitted`)
        .digest("hex")
        .slice(0, 26)}`;
      this.#db
        .prepare(
          `INSERT INTO events(run_id, seq, type, payload, artifact_ref,
                              redaction_ruleset_version, at, event_id, schema, phase, policy_digest)
           VALUES (?, 1, 'work_order.admitted', ?, NULL, 'asf-public-v1', ?, ?,
                   'asf.run-event/v1', 'ADMITTED', ?)`,
        )
        .run(
          input.runId,
          JSON.stringify({
            work_order_id: payload.work_order_id,
            attempt_id: payload.attempt_id,
            tenant_id: payload.tenant_id,
            payload_digest: input.payloadDigest,
            envelope_digest: input.envelopeDigest,
            signature: {
              verified: true,
              key_id: input.envelope.key_id,
              algorithm: input.envelope.algorithm,
            },
          }),
          at,
          eventId,
          input.effectivePolicy.digest,
        );

      return { runId: input.runId, created: true } as const;
    });
    return transaction.immediate();
  }

  /**
   * Persist a cryptographically validated approval only if its durable run,
   * Work Order, policy and candidate bindings are still current in the same
   * transaction. Replaying identical bytes is idempotent; rebinding an
   * approval id is refused.
   */
  #approvalResumeTarget(input: {
    readonly run: AsfRunRow;
    readonly admission: AsfAdmissionRecord;
    readonly approval: ValidatedApproval["envelope"]["payload"];
    readonly at: string;
  }): RunEventPhase | undefined {
    if (input.run.state !== "WAITING_APPROVAL") return undefined;
    const interruption = this.#db
      .prepare(`SELECT resume_phase AS resumePhase FROM runs WHERE run_id = ?`)
      .get(input.run.runId) as { resumePhase: string | null } | undefined;
    const resumePhase = RUN_EVENT_PHASES.find(
      (phase) => phase === interruption?.resumePhase,
    );
    if (resumePhase === undefined) {
      throw new Error(
        `WAITING_APPROVAL run ${input.run.runId} has no durable resume phase`,
      );
    }
    const row = this.#db
      .prepare(
        `SELECT event_id AS eventId, schema, type, payload, phase,
                policy_digest AS policyDigest, at
         FROM events WHERE run_id = ? AND seq = ?`,
      )
      .get(input.run.runId, input.run.stateVersion) as
      | {
          eventId: string | null;
          schema: string | null;
          type: string;
          payload: string;
          phase: string | null;
          policyDigest: string | null;
          at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error(
        `WAITING_APPROVAL run ${input.run.runId} has no interruption event`,
      );
    }
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(row.payload) as unknown;
    } catch {
      throw new Error(
        `WAITING_APPROVAL run ${input.run.runId} has malformed event JSON`,
      );
    }
    const event = parseRunEvent({
      schema: row.schema,
      event_id: row.eventId,
      run_id: input.run.runId,
      work_order_id: input.admission.workOrderId,
      attempt_id: input.admission.attemptId,
      seq: input.run.stateVersion,
      occurred_at: row.at,
      type: row.type,
      phase: row.phase,
      payload: rawPayload,
      policy_digest: row.policyDigest,
    });
    if (
      event.type !== "run.waiting_approval" ||
      event.phase !== "WAITING_APPROVAL" ||
      event.policy_digest !== input.admission.effectivePolicyDigest ||
      event.payload["candidate_sha"] !== input.run.candidateSha
    ) {
      throw new Error(
        `WAITING_APPROVAL run ${input.run.runId} has contradictory interruption state`,
      );
    }
    if (
      input.approval.decision !== "approved" ||
      event.payload["decision_type"] !== input.approval.decision_type ||
      event.payload["requested_effect"] !== input.approval.requested_effect
    ) {
      return undefined;
    }
    if (
      input.approval.candidate_sha !== input.run.candidateSha ||
      input.approval.policy_digest !== input.admission.effectivePolicyDigest ||
      Date.parse(input.approval.issued_at) > Date.parse(input.at) ||
      Date.parse(input.approval.expires_at) <= Date.parse(input.at)
    ) {
      throw RunmillError.fromCatalog("RM-APPROVAL-003", {
        whatHappened: `approval ${input.approval.approval_id} is stale for paused run ${input.run.runId}`,
        runId: input.run.runId,
      });
    }
    assertRunPhaseTransition("WAITING_APPROVAL", resumePhase);
    return resumePhase;
  }

  recordAsfApproval(input: ValidatedApproval): {
    readonly approval: AsfApprovalRecord;
    readonly created: boolean;
    readonly resumed: boolean;
    readonly resumePhase: string | null;
  } {
    const transaction = this.#db.transaction(() => {
      const payload = input.envelope.payload;
      if (
        input.canonicalEnvelope !== canonicalJson(input.envelope) ||
        input.envelopeDigest !== sha256Digest(input.envelope) ||
        input.bindingDigest !== approvalBindingDigest(payload) ||
        input.signature.verified !== true ||
        input.signature.keyId !== input.envelope.key_id ||
        input.signature.algorithm !== input.envelope.algorithm
      ) {
        throw RunmillError.fromCatalog("RM-APPROVAL-002", {
          whatHappened:
            "validated approval metadata is internally contradictory",
        });
      }

      const existing = this.getAsfApproval(payload.approval_id);
      if (existing !== undefined) {
        if (existing.envelopeDigest !== input.envelopeDigest) {
          throw RunmillError.fromCatalog("RM-APPROVAL-003", {
            whatHappened:
              `approval id ${JSON.stringify(payload.approval_id)} is already bound to ` +
              `${existing.envelopeDigest}, not ${input.envelopeDigest}`,
            runId: existing.runId,
          });
        }
      }

      const run = this.getAsfRun(payload.run_id);
      const admission = this.getAsfAdmissionForRun(payload.run_id);
      if (run === undefined || admission === undefined) {
        throw RunmillError.fromCatalog("RM-APPROVAL-003", {
          whatHappened: `approval names unknown ASF run ${JSON.stringify(payload.run_id)}`,
        });
      }
      if (
        !isTerminalRunEventPhase(run.state) &&
        this.getAsfTerminalEvidencePlanRecord(payload.run_id) !== undefined
      ) {
        this.getAsfTerminalEvidencePlan(payload.run_id);
        throw RunmillError.fromCatalog("RM-APPROVAL-003", {
          whatHappened:
            `run ${payload.run_id} has an immutable terminal outcome pending; ` +
            "approval cannot resume or supersede it",
          runId: payload.run_id,
        });
      }
      if (
        payload.work_order_id !== admission.workOrderId ||
        payload.work_order_digest !== admission.payloadDigest ||
        payload.attempt_id !== admission.attemptId ||
        payload.candidate_sha !== run.candidateSha ||
        payload.policy_digest !== admission.effectivePolicyDigest
      ) {
        throw RunmillError.fromCatalog("RM-APPROVAL-003", {
          whatHappened:
            `approval ${payload.approval_id} no longer binds the durable Work Order, attempt, ` +
            `candidate, and policy for ${payload.run_id}`,
          runId: payload.run_id,
        });
      }

      const recordedAt = this.#clock.now().toISOString();
      const now = Date.parse(recordedAt);
      if (
        Date.parse(payload.issued_at) > now ||
        now >= Date.parse(payload.expires_at)
      ) {
        throw RunmillError.fromCatalog("RM-APPROVAL-003", {
          whatHappened: `approval ${payload.approval_id} is not current at durable commit`,
          runId: payload.run_id,
        });
      }
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO asf_approvals(
             approval_id, run_id, work_order_id, attempt_id, work_order_digest,
             candidate_sha, decision, decision_type, requested_effect, policy_digest,
             approver_subject, approver_authority, issued_at, expires_at,
             signature_key_id, signature_algorithm, canonical_envelope,
             envelope_digest, binding_digest, recorded_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            payload.approval_id,
            payload.run_id,
            payload.work_order_id,
            payload.attempt_id,
            payload.work_order_digest,
            payload.candidate_sha,
            payload.decision,
            payload.decision_type,
            payload.requested_effect,
            payload.policy_digest,
            payload.approver.subject,
            payload.approver.authority,
            payload.issued_at,
            payload.expires_at,
            input.envelope.key_id,
            input.envelope.algorithm,
            input.canonicalEnvelope,
            input.envelopeDigest,
            input.bindingDigest,
            recordedAt,
          );
      }
      const approval = this.getAsfApproval(payload.approval_id);
      if (approval === undefined)
        throw new Error("recorded ASF approval disappeared");
      const resumePhase = this.#approvalResumeTarget({
        run,
        admission,
        approval: payload,
        at: recordedAt,
      });
      if (resumePhase === undefined) {
        return {
          approval,
          created: existing === undefined,
          resumed: false,
          resumePhase: null,
        } as const;
      }

      const seq = run.stateVersion + 1;
      const event = parseRunEvent({
        schema: "asf.run-event/v1",
        event_id: `evt_${createHash("sha256")
          .update(`${run.runId}:${seq}:run.resumed`)
          .digest("hex")
          .slice(0, 26)}`,
        run_id: run.runId,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        seq,
        occurred_at: recordedAt,
        type: "run.resumed",
        phase: resumePhase,
        payload: {
          interrupted_phase: "WAITING_APPROVAL",
          resume_phase: resumePhase,
          approval_id: approval.approvalId,
          evidence_digest: approval.envelopeDigest,
          candidate_sha: payload.candidate_sha,
        },
        policy_digest: admission.effectivePolicyDigest,
      });
      assertRunEventTransition("WAITING_APPROVAL", event);
      const nextGeneration =
        run.ownerId === null ? run.generation : run.generation + 1;
      const updated = this.#db
        .prepare(
          `UPDATE runs
           SET state = ?, state_version = state_version + 1, resume_phase = NULL,
               owner_id = NULL, heartbeat_at = NULL, generation = ?, updated_at = ?
           WHERE run_id = ? AND mode = 'asf-worker' AND state = 'WAITING_APPROVAL'
             AND state_version = ? AND candidate_sha = ?`,
        )
        .run(
          resumePhase,
          nextGeneration,
          recordedAt,
          run.runId,
          run.stateVersion,
          payload.candidate_sha,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `WAITING_APPROVAL run ${run.runId} changed before approval resume`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?,?,'WAITING_APPROVAL',?,'current signed approval recorded','approval-control',?)`,
        )
        .run(run.runId, seq, resumePhase, recordedAt);
      this.#db
        .prepare(
          `INSERT INTO events(run_id, seq, type, payload, artifact_ref,
                              redaction_ruleset_version, at, event_id, schema, phase, policy_digest)
           VALUES (?,?,'run.resumed',?,NULL,'asf-public-v1',?,?,?,?,?)`,
        )
        .run(
          run.runId,
          seq,
          JSON.stringify(event.payload),
          event.occurred_at,
          event.event_id,
          event.schema,
          event.phase,
          event.policy_digest,
        );
      return {
        approval,
        created: existing === undefined,
        resumed: true,
        resumePhase,
      } as const;
    });
    return transaction.immediate();
  }

  getAsfApproval(approvalId: string): AsfApprovalRecord | undefined {
    return this.#db
      .prepare(
        `SELECT approval_id AS approvalId, run_id AS runId,
                work_order_id AS workOrderId, attempt_id AS attemptId,
                work_order_digest AS workOrderDigest, candidate_sha AS candidateSha,
                decision, decision_type AS decisionType,
                requested_effect AS requestedEffect, policy_digest AS policyDigest,
                approver_subject AS approverSubject,
                approver_authority AS approverAuthority, issued_at AS issuedAt,
                expires_at AS expiresAt, signature_key_id AS signatureKeyId,
                signature_algorithm AS signatureAlgorithm,
                canonical_envelope AS canonicalEnvelope,
                envelope_digest AS envelopeDigest, binding_digest AS bindingDigest,
                recorded_at AS recordedAt
         FROM asf_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as AsfApprovalRecord | undefined;
  }

  listAsfApprovals(input: {
    readonly runId: string;
    readonly candidateSha: string;
    readonly policyDigest: string;
    readonly decisionType: string;
    readonly requestedEffect: string;
  }): AsfApprovalRecord[] {
    return this.#db
      .prepare(
        `SELECT approval_id AS approvalId, run_id AS runId,
                work_order_id AS workOrderId, attempt_id AS attemptId,
                work_order_digest AS workOrderDigest, candidate_sha AS candidateSha,
                decision, decision_type AS decisionType,
                requested_effect AS requestedEffect, policy_digest AS policyDigest,
                approver_subject AS approverSubject,
                approver_authority AS approverAuthority, issued_at AS issuedAt,
                expires_at AS expiresAt, signature_key_id AS signatureKeyId,
                signature_algorithm AS signatureAlgorithm,
                canonical_envelope AS canonicalEnvelope,
                envelope_digest AS envelopeDigest, binding_digest AS bindingDigest,
                recorded_at AS recordedAt
         FROM asf_approvals
         WHERE run_id = ? AND candidate_sha = ? AND policy_digest = ?
           AND decision_type = ? AND requested_effect = ?
         ORDER BY issued_at, approval_id`,
      )
      .all(
        input.runId,
        input.candidateSha,
        input.policyDigest,
        input.decisionType,
        input.requestedEffect,
      ) as AsfApprovalRecord[];
  }

  getAsfCancellationRequest(
    requestId: string,
  ): AsfCancellationRecord | undefined {
    return this.#db
      .prepare(
        `SELECT request_id AS requestId, run_id AS runId,
                request_digest AS requestDigest, requester,
                requester_authority AS requesterAuthority, reason, mode,
                grace_seconds AS graceSeconds, requested_at AS requestedAt,
                recorded_at AS recordedAt
         FROM asf_cancellation_requests WHERE request_id = ?`,
      )
      .get(requestId) as AsfCancellationRecord | undefined;
  }

  /**
   * Record cancellation and revoke the current generation in one transaction.
   * A stale worker loses both event and side-effect authority before this call
   * acknowledges the request.
   */
  requestAsfCancellation(input: {
    readonly request: CancellationRequest;
    readonly requestDigest: string;
  }): CancellationResult {
    const transaction = this.#db.transaction(() => {
      const request = input.request;
      if (input.requestDigest !== sha256Digest(request)) {
        throw RunmillError.fromCatalog("RM-CANCEL-001", {
          whatHappened:
            "cancellation request digest is internally contradictory",
          runId: request.run_id,
        });
      }
      const existing = this.getAsfCancellationRequest(request.request_id);
      if (existing !== undefined) {
        if (
          existing.requestDigest !== input.requestDigest ||
          existing.runId !== request.run_id
        ) {
          throw RunmillError.fromCatalog("RM-CANCEL-001", {
            whatHappened:
              `cancellation request id ${JSON.stringify(request.request_id)} is already bound ` +
              `to ${existing.requestDigest}, not ${input.requestDigest}`,
            runId: existing.runId,
          });
        }
        const current = this.getAsfRun(existing.runId);
        if (current === undefined) {
          throw new Error(`cancelled ASF run ${existing.runId} disappeared`);
        }
        const reconciliationRequired =
          (
            this.#db
              .prepare(
                `SELECT requires_reconciliation AS required FROM runs WHERE run_id = ?`,
              )
              .get(existing.runId) as { required: 0 | 1 }
          ).required === 1;
        return {
          requestId: existing.requestId,
          runId: existing.runId,
          disposition: isTerminalRunEventPhase(current.state)
            ? "already-terminal"
            : "existing",
          state: current.state,
          generation: current.generation,
          requestDigest: existing.requestDigest,
          reconciliationRequired,
        } as const;
      }

      const current = this.getAsfRun(request.run_id);
      if (current === undefined) {
        throw RunmillError.fromCatalog("RM-CANCEL-001", {
          whatHappened: `cancellation names unknown ASF run ${JSON.stringify(request.run_id)}`,
          runId: request.run_id,
        });
      }
      const currentPhase = RUN_EVENT_PHASES.find(
        (phase) => phase === current.state,
      );
      if (currentPhase === undefined) {
        throw new Error(
          `ASF run ${request.run_id} has unknown phase ${current.state}`,
        );
      }
      if (
        !isTerminalRunEventPhase(currentPhase) &&
        this.getAsfTerminalEvidencePlanRecord(request.run_id) !== undefined
      ) {
        // The signed cleanup-backed terminal outcome is already immutable.
        // Advancing the cursor for a later cancellation would orphan it.
        this.getAsfTerminalEvidencePlan(request.run_id);
        throw RunmillError.fromCatalog("RM-CANCEL-001", {
          whatHappened:
            `run ${request.run_id} has an immutable terminal outcome pending at its next event; ` +
            "retry cancellation after terminalization completes",
          runId: request.run_id,
        });
      }
      if (
        currentPhase === "CANCEL_REQUESTED" ||
        currentPhase === "CANCELLING"
      ) {
        const effective = this.#db
          .prepare(
            `SELECT payload FROM events
             WHERE run_id = ? AND type IN ('cancellation.requested', 'cancellation.escalated')
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(request.run_id) as { payload: string } | undefined;
        let priorMode: unknown;
        try {
          const raw =
            effective === undefined
              ? undefined
              : (JSON.parse(effective.payload) as unknown);
          priorMode =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)["mode"]
              : undefined;
        } catch {
          priorMode = undefined;
        }
        if (
          (priorMode !== "graceful" && priorMode !== "forced") ||
          priorMode === "forced" ||
          request.mode !== "forced"
        ) {
          throw RunmillError.fromCatalog("RM-CANCEL-001", {
            whatHappened:
              priorMode === "forced"
                ? `run ${request.run_id} already has an effective forced cancellation; ` +
                  "another request cannot advance its fence"
                : `run ${request.run_id} permits only one graceful-to-forced cancellation escalation`,
            runId: request.run_id,
          });
        }
      }
      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO asf_cancellation_requests(
             request_id, run_id, request_digest, requester, requester_authority,
             reason, mode, grace_seconds, requested_at, recorded_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          request.request_id,
          request.run_id,
          input.requestDigest,
          request.requester.subject,
          request.requester.authority,
          request.reason,
          request.mode,
          request.grace_seconds,
          at,
          at,
        );

      if (isTerminalRunEventPhase(currentPhase)) {
        const reconciliationRequired =
          (
            this.#db
              .prepare(
                "SELECT requires_reconciliation AS required FROM runs WHERE run_id = ?",
              )
              .get(request.run_id) as { required: 0 | 1 }
          ).required === 1;
        return {
          requestId: request.request_id,
          runId: request.run_id,
          disposition: "already-terminal",
          state: currentPhase,
          generation: current.generation,
          requestDigest: input.requestDigest,
          reconciliationRequired,
        } as const;
      }

      const pendingEffects = this.#asfPendingReconciliationCounts(
        request.run_id,
      );
      const priorReconciliation = (
        this.#db
          .prepare(
            "SELECT requires_reconciliation AS required FROM runs WHERE run_id = ?",
          )
          .get(request.run_id) as { required: 0 | 1 }
      ).required;
      const reconciliationOrigin =
        priorReconciliation === 1
          ? ("preexisting" as const)
          : pendingEffects.total > 0
            ? ("durable-effects" as const)
            : request.mode === "forced"
              ? ("forced-cancellation-cleanup" as const)
              : ("none" as const);
      const reconciliationRequired = reconciliationOrigin !== "none";
      const seq = current.stateVersion + 1;
      const eventType =
        currentPhase === "CANCEL_REQUESTED" || currentPhase === "CANCELLING"
          ? "cancellation.escalated"
          : "cancellation.requested";
      const admission = this.getAsfAdmissionForRun(request.run_id);
      if (admission === undefined) {
        throw new Error(
          `ASF run ${request.run_id} has no immutable Work Order admission`,
        );
      }
      const reasonDigest = sha256Digest({ reason: request.reason });
      const payload = {
        code: "CANCELLED",
        summary: "an authorized controller requested cancellation",
        checkpoint: currentPhase,
        retry_disposition: reconciliationRequired ? "reconcile-first" : "safe",
        required_actor: "asf",
        required_action: reconciliationRequired
          ? reconciliationOrigin === "forced-cancellation-cleanup"
            ? "reconcile forced cancellation process state and complete resource cleanup before retry"
            : "reconcile every unresolved external effect before starting a new attempt"
          : "wait for the worker to revoke identities and complete cancellation",
        evidence_refs: [`cancellation:${request.request_id}`, reasonDigest],
        ...(current.candidateSha === null
          ? {}
          : { candidate_sha: current.candidateSha }),
        request_id: request.request_id,
        requester: request.requester.subject,
        reason: `protected:${reasonDigest}`,
        mode: request.mode,
        grace_seconds: request.grace_seconds,
        reconciliation_origin: reconciliationOrigin,
      } as const;
      const event = parseRunEvent({
        schema: "asf.run-event/v1",
        event_id: `evt_${createHash("sha256")
          .update(`${request.run_id}:${seq}:${eventType}`)
          .digest("hex")
          .slice(0, 26)}`,
        run_id: request.run_id,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        seq,
        occurred_at: at,
        type: eventType,
        phase: "CANCEL_REQUESTED",
        payload,
        policy_digest: admission.effectivePolicyDigest,
      });
      assertRunEventTransition(currentPhase, event);
      const generation = current.generation + 1;
      const updated = this.#db
        .prepare(
          `UPDATE runs
           SET state = 'CANCEL_REQUESTED', state_version = state_version + 1,
               generation = ?, owner_id = NULL, heartbeat_at = NULL,
               resume_phase = COALESCE(resume_phase, ?),
               requires_reconciliation = MAX(requires_reconciliation, ?), updated_at = ?
           WHERE run_id = ? AND mode = 'asf-worker' AND state = ?
             AND state_version = ? AND generation = ?`,
        )
        .run(
          generation,
          currentPhase,
          reconciliationRequired ? 1 : 0,
          at,
          request.run_id,
          currentPhase,
          current.stateVersion,
          current.generation,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `ASF run ${request.run_id} changed during cancellation fencing`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          request.run_id,
          seq,
          currentPhase,
          "CANCEL_REQUESTED",
          "authorized cancellation request",
          request.requester.subject,
          at,
        );
      this.#db
        .prepare(
          `INSERT INTO events(run_id, seq, type, payload, artifact_ref,
                              redaction_ruleset_version, at, event_id, schema, phase, policy_digest)
           VALUES (?,?,?,?,NULL,'asf-public-v1',?,?,?,?,?)`,
        )
        .run(
          request.run_id,
          seq,
          event.type,
          JSON.stringify(event.payload),
          event.occurred_at,
          event.event_id,
          event.schema,
          event.phase,
          event.policy_digest,
        );
      return {
        requestId: request.request_id,
        runId: request.run_id,
        disposition: "requested",
        state: "CANCEL_REQUESTED",
        generation,
        requestDigest: input.requestDigest,
        reconciliationRequired,
      } as const;
    });
    return transaction.immediate();
  }

  #decodeAsfDeliveryIntentRow(
    row: AsfDeliveryStageIntentDatabaseRow,
  ): StoredAsfDeliveryStageIntent {
    const intent: StateAsfDeliveryStageIntent = {
      schema: row.schema,
      intent_id: row.intent_id,
      intent_digest: row.intent_digest,
      effect_key: row.effect_key,
      stage: row.stage,
      run_id: row.run_id,
      work_order_id: row.work_order_id,
      attempt_id: row.attempt_id,
      policy_digest: row.policy_digest,
      fencing_generation: row.fencing_generation,
      candidate_sha: row.candidate_sha,
      event_seq: row.event_seq,
      operation_digest: row.operation_digest,
      created_at: row.created_at,
    };
    const canonicalIntent = assertValidAsfDeliveryIntent(intent);
    if (row.canonicalIntent !== canonicalIntent) {
      throw asfDeliveryStateError(
        `stored ASF delivery intent ${row.intent_id} is internally contradictory`,
        row.run_id,
      );
    }
    const confirmationAbsent =
      row.observationDigest === null &&
      row.observationOutcome === null &&
      row.confirmedGeneration === null &&
      row.confirmedAt === null;
    const confirmationPresent =
      row.observationDigest !== null &&
      row.observationOutcome !== null &&
      row.confirmedGeneration !== null &&
      row.confirmedAt !== null;
    const replayAbsent =
      row.replayAuthorizedOperationId === null &&
      row.replayStartedGeneration === null;
    const replayPresent =
      row.replayAuthorizedOperationId !== null &&
      row.replayStartedGeneration !== null;
    const runFence = this.#db
      .prepare(
        `SELECT generation FROM runs
         WHERE run_id = ? AND mode = 'asf-worker'`,
      )
      .get(row.run_id) as { readonly generation: number } | undefined;
    if (
      runFence === undefined ||
      !Number.isSafeInteger(runFence.generation) ||
      runFence.generation < 1 ||
      !isCanonicalIsoTimestamp(row.created_at) ||
      Date.parse(row.created_at) > this.#clock.now().getTime() ||
      (!confirmationAbsent && !confirmationPresent) ||
      (!replayAbsent && !replayPresent) ||
      (confirmationPresent && replayPresent) ||
      (row.observationDigest !== null &&
        !ASF_DELIVERY_DIGEST.test(row.observationDigest)) ||
      (row.observationOutcome !== null &&
        !["confirmed", "not_applied", "ambiguous"].includes(
          row.observationOutcome,
        )) ||
      (row.confirmedGeneration !== null &&
        (!Number.isSafeInteger(row.confirmedGeneration) ||
          row.confirmedGeneration < row.fencing_generation ||
          row.confirmedGeneration > runFence.generation)) ||
      (row.confirmedAt !== null &&
        (!isCanonicalIsoTimestamp(row.confirmedAt) ||
          Date.parse(row.confirmedAt) < Date.parse(row.created_at) ||
          Date.parse(row.confirmedAt) > this.#clock.now().getTime())) ||
      (row.replayAuthorizedOperationId !== null &&
        !ASF_DELIVERY_IDENTIFIER.test(row.replayAuthorizedOperationId)) ||
      (row.replayStartedGeneration !== null &&
        (!Number.isSafeInteger(row.replayStartedGeneration) ||
          row.replayStartedGeneration <= row.fencing_generation ||
          row.replayStartedGeneration > runFence.generation ||
          (row.confirmedGeneration !== null &&
            row.replayStartedGeneration > row.confirmedGeneration)))
    ) {
      throw asfDeliveryStateError(
        `stored ASF delivery confirmation ${row.intent_id} is internally contradictory`,
        row.run_id,
      );
    }
    return {
      ...intent,
      observationDigest: row.observationDigest,
      observationOutcome: row.observationOutcome,
      confirmedGeneration: row.confirmedGeneration,
      confirmedAt: row.confirmedAt,
      replayAuthorizedOperationId: row.replayAuthorizedOperationId,
      replayStartedGeneration: row.replayStartedGeneration,
    };
  }

  getAsfDeliveryIntent(
    effectKey: string,
  ): StoredAsfDeliveryStageIntent | undefined {
    const row = this.#db
      .prepare(
        `SELECT schema, intent_id, intent_digest, effect_key, stage, run_id,
                work_order_id, attempt_id, policy_digest, fencing_generation,
                candidate_sha, event_seq, operation_digest, canonical_intent AS canonicalIntent,
                created_at, observation_digest AS observationDigest,
                observation_outcome AS observationOutcome,
                confirmed_generation AS confirmedGeneration, confirmed_at AS confirmedAt,
                replay_authorized_operation_id AS replayAuthorizedOperationId,
                replay_started_generation AS replayStartedGeneration
         FROM asf_delivery_stage_intents WHERE effect_key = ?`,
      )
      .get(effectKey) as AsfDeliveryStageIntentDatabaseRow | undefined;
    return row === undefined
      ? undefined
      : this.#decodeAsfDeliveryIntentRow(row);
  }

  #getAsfDeliveryIntentById(
    intentId: string,
  ): StoredAsfDeliveryStageIntent | undefined {
    const row = this.#db
      .prepare(
        `SELECT schema, intent_id, intent_digest, effect_key, stage, run_id,
                work_order_id, attempt_id, policy_digest, fencing_generation,
                candidate_sha, event_seq, operation_digest, canonical_intent AS canonicalIntent,
                created_at, observation_digest AS observationDigest,
                observation_outcome AS observationOutcome,
                confirmed_generation AS confirmedGeneration, confirmed_at AS confirmedAt,
                replay_authorized_operation_id AS replayAuthorizedOperationId,
                replay_started_generation AS replayStartedGeneration
         FROM asf_delivery_stage_intents WHERE intent_id = ?`,
      )
      .get(intentId) as AsfDeliveryStageIntentDatabaseRow | undefined;
    return row === undefined
      ? undefined
      : this.#decodeAsfDeliveryIntentRow(row);
  }

  /** Read an exact durable intent by its immutable id for terminal replay. */
  getAsfDeliveryIntentById(
    intentId: string,
  ): StoredAsfDeliveryStageIntent | undefined {
    return this.#getAsfDeliveryIntentById(intentId);
  }

  listAsfDeliveryIntentObservations(
    effectKey: string,
  ): AsfDeliveryIntentObservationRow[] {
    if (!ASF_DELIVERY_IDENTIFIER.test(effectKey)) {
      throw asfDeliveryStateError(
        "ASF delivery observation effect key is malformed",
      );
    }
    return this.#db
      .prepare(
        `SELECT effect_key AS effectKey, seq, outcome,
                observation_digest AS observationDigest, generation, source,
                observed_at AS observedAt
         FROM asf_delivery_intent_observations
         WHERE effect_key = ? ORDER BY seq`,
      )
      .all(effectKey) as AsfDeliveryIntentObservationRow[];
  }

  #recordAsfDeliveryIntentObservation(input: {
    readonly effectKey: string;
    readonly outcome: AsfDeliveryIntentObservationRow["outcome"];
    readonly observationDigest: string;
    readonly generation: number;
    readonly source: Exclude<
      AsfDeliveryIntentObservationRow["source"],
      "legacy"
    >;
    readonly observedAt: string;
  }): void {
    const seq = (
      this.#db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
           FROM asf_delivery_intent_observations WHERE effect_key = ?`,
        )
        .get(input.effectKey) as { seq: number }
    ).seq;
    this.#db
      .prepare(
        `INSERT INTO asf_delivery_intent_observations(
           effect_key, seq, outcome, observation_digest, generation, source, observed_at
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.effectKey,
        seq,
        input.outcome,
        input.observationDigest,
        input.generation,
        input.source,
        input.observedAt,
      );
  }

  #authorizedReconciliationIntentCursor(
    run: AsfRunRow,
    eventSeq: number,
    effectKey: string,
  ): {
    readonly operationId: string;
    readonly action: "continue-confirmed" | "replay-not-applied";
    readonly outcome: "confirmed" | "not_applied";
  } | null {
    if (eventSeq >= run.stateVersion) return null;
    const admission = this.getAsfAdmissionForRun(run.runId);
    if (admission === undefined) return null;
    const row = this.#db
      .prepare(
        `SELECT event_id AS eventId, schema, type, payload, phase,
                policy_digest AS policyDigest, at
         FROM events WHERE run_id = ? AND seq = ?`,
      )
      .get(run.runId, run.stateVersion) as
      | {
          eventId: string | null;
          schema: string | null;
          type: string;
          payload: string;
          phase: string | null;
          policyDigest: string | null;
          at: string;
        }
      | undefined;
    if (row === undefined) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload) as unknown;
    } catch {
      return null;
    }
    let event: RunEvent;
    try {
      event = parseRunEvent({
        schema: row.schema,
        event_id: row.eventId,
        run_id: run.runId,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        seq: run.stateVersion,
        occurred_at: row.at,
        type: row.type,
        phase: row.phase,
        payload,
        policy_digest: row.policyDigest,
      });
    } catch {
      return null;
    }
    const reconciliation = event.payload["reconciliation"];
    if (
      event.type !== "run.resumed" ||
      event.phase !== run.state ||
      typeof reconciliation !== "object" ||
      reconciliation === null ||
      Array.isArray(reconciliation)
    ) {
      return null;
    }
    const binding = reconciliation as Record<string, unknown>;
    if (
      binding["schema"] !== "asf.reconciliation-continuation-result/v1" ||
      (binding["action"] !== "continue-confirmed" &&
        binding["action"] !== "replay-not-applied") ||
      binding["interrupted_event_seq"] !== eventSeq ||
      typeof binding["operation_id"] !== "string" ||
      typeof binding["result_digest"] !== "string"
    ) {
      return null;
    }
    const operation = this.getAsfReconciliation(binding["operation_id"]);
    if (
      operation?.runId !== run.runId ||
      operation.status !== "completed" ||
      operation.resultDigest !== binding["result_digest"] ||
      operation.resumedEventSeq !== run.stateVersion ||
      operation.canonicalResult === undefined ||
      operation.canonicalResult === null
    ) {
      return null;
    }
    let rawResult: unknown;
    try {
      rawResult = JSON.parse(operation.canonicalResult) as unknown;
    } catch {
      return null;
    }
    if (
      typeof rawResult !== "object" ||
      rawResult === null ||
      Array.isArray(rawResult) ||
      canonicalJson(rawResult as JsonValue) !== operation.canonicalResult ||
      sha256Digest(rawResult as JsonValue) !== operation.resultDigest
    ) {
      return null;
    }
    const result = rawResult as Record<string, unknown>;
    if (
      result["schema"] !== "asf.reconciliation-result/v1" ||
      result["operation_id"] !== operation.operationId ||
      result["run_id"] !== run.runId ||
      result["pending_set_digest"] !== binding["pending_set_digest"] ||
      !Array.isArray(result["observations"])
    ) {
      return null;
    }
    let matched: "confirmed" | "not_applied" | null = null;
    let notApplied = 0;
    for (const rawObservation of result["observations"]) {
      if (
        typeof rawObservation !== "object" ||
        rawObservation === null ||
        Array.isArray(rawObservation)
      ) {
        return null;
      }
      const observation = rawObservation as Record<string, unknown>;
      if (
        Object.keys(observation).sort().join("\u0000") !==
          ["effect_class", "effect_key", "outcome"].sort().join("\u0000") ||
        (observation["effect_class"] !== "github-effect" &&
          observation["effect_class"] !== "delivery-intent") ||
        (observation["outcome"] !== "confirmed" &&
          observation["outcome"] !== "not_applied")
      ) {
        return null;
      }
      if (observation["outcome"] === "not_applied") notApplied += 1;
      if (
        observation["effect_class"] === "delivery-intent" &&
        observation["effect_key"] === effectKey
      ) {
        if (matched !== null) return null;
        matched = observation["outcome"];
      }
    }
    const action = binding["action"];
    if (
      matched === null ||
      (action === "continue-confirmed" && notApplied !== 0) ||
      (action === "replay-not-applied" && notApplied === 0)
    ) {
      return null;
    }
    return {
      operationId: operation.operationId,
      action,
      outcome: matched,
    };
  }

  /**
   * Commit an exact lifecycle intent under the current run fence. A takeover
   * can retrieve an identical prior-generation intent for reconciliation, but
   * never replace it with a new authorization to apply the effect blindly.
   */
  recordAsfDeliveryIntent(input: {
    readonly ownerId: string;
    readonly intent: StateAsfDeliveryStageIntent;
  }): {
    readonly intent: StateAsfDeliveryStageIntent;
    readonly disposition:
      | "created"
      | "existing-current"
      | "existing-prior-generation"
      | "existing-prior-generation-replay-authorized";
  } {
    return this.#recordAsfDeliveryIntent(input, false);
  }

  #recordAsfDeliveryIntent(
    input: {
      readonly ownerId: string;
      readonly intent: StateAsfDeliveryStageIntent;
    },
    terminalCleanup: boolean,
  ): {
    readonly intent: StateAsfDeliveryStageIntent;
    readonly disposition:
      | "created"
      | "existing-current"
      | "existing-prior-generation"
      | "existing-prior-generation-replay-authorized";
  } {
    if (!ASF_DELIVERY_IDENTIFIER.test(input.ownerId)) {
      throw asfDeliveryStateError("ASF delivery intent owner id is malformed");
    }
    const canonicalIntent = assertValidAsfDeliveryIntent(input.intent);
    const transaction = this.#db.transaction(() => {
      const intent = input.intent;
      const run = this.getAsfRun(intent.run_id);
      const admission = this.getAsfAdmissionForRun(intent.run_id);
      if (
        run === undefined ||
        admission === undefined ||
        run.ownerId !== input.ownerId ||
        run.generation !== intent.fencing_generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${intent.fencing_generation} ` +
            `cannot record delivery intent ${intent.intent_id}`,
          runId: intent.run_id,
        });
      }
      if (
        asfPhaseFreezesExternalAuthority(run.state) &&
        !(
          run.state === "CANCELLING" &&
          terminalCleanup &&
          intent.stage === "cleanup"
        )
      ) {
        throw asfDeliveryStateError(
          `ASF phase ${run.state} forbids ${intent.stage} delivery authority`,
          intent.run_id,
        );
      }
      const existing = this.getAsfDeliveryIntent(intent.effect_key);
      const terminalPlan = this.getAsfTerminalEvidencePlanRecord(intent.run_id);
      if (terminalPlan !== undefined) {
        this.getAsfTerminalEvidencePlan(intent.run_id);
        if (
          existing === undefined ||
          existing.intent_id !== terminalPlan.cleanupIntentId ||
          !sameAsfDeliveryEffect(existing, intent)
        ) {
          throw asfDeliveryStateError(
            `immutable terminal evidence already owns the next event for ${intent.run_id}; ` +
              `new ${intent.stage} intent ${intent.intent_id} is forbidden`,
            intent.run_id,
          );
        }
        return {
          intent: existing,
          disposition:
            existing.fencing_generation === intent.fencing_generation
              ? "existing-current"
              : "existing-prior-generation",
        } as const;
      }
      const currentCursor = run?.stateVersion === intent.event_seq;
      const reconciliationAuthorization = !currentCursor
        ? this.#authorizedReconciliationIntentCursor(
            run,
            intent.event_seq,
            intent.effect_key,
          )
        : null;
      const reconciliationCursor = reconciliationAuthorization !== null;
      if (
        run.workOrderId !== intent.work_order_id ||
        run.attemptId !== intent.attempt_id ||
        admission.workOrderId !== intent.work_order_id ||
        admission.attemptId !== intent.attempt_id ||
        run.candidateSha !== intent.candidate_sha ||
        admission.effectivePolicyDigest !== intent.policy_digest ||
        (!currentCursor && !reconciliationCursor)
      ) {
        throw asfDeliveryStateError(
          `ASF delivery intent ${intent.intent_id} does not bind the current Work Order, ` +
            "attempt, candidate, policy, and event cursor",
          intent.run_id,
        );
      }
      const event = this.#db
        .prepare(
          `SELECT at, policy_digest AS policyDigest FROM events
           WHERE run_id = ? AND seq = ?`,
        )
        .get(intent.run_id, intent.event_seq) as
        | { at: string; policyDigest: string | null }
        | undefined;
      if (
        event === undefined ||
        event.at !== intent.created_at ||
        event.policyDigest !== intent.policy_digest
      ) {
        throw asfDeliveryStateError(
          `ASF delivery intent ${intent.intent_id} does not bind the current durable event`,
          intent.run_id,
        );
      }

      const sameId = this.#getAsfDeliveryIntentById(intent.intent_id);
      if (sameId !== undefined && sameId.effect_key !== intent.effect_key) {
        throw asfDeliveryStateError(
          `ASF delivery intent id ${intent.intent_id} is already bound to another effect`,
          intent.run_id,
        );
      }
      if (existing !== undefined) {
        if (!sameAsfDeliveryEffect(existing, intent)) {
          throw asfDeliveryStateError(
            `ASF delivery effect key ${intent.effect_key} is bound to contradictory intent`,
            intent.run_id,
          );
        }
        if (existing.fencing_generation === intent.fencing_generation) {
          if (
            canonicalJson(asfDeliveryUnsignedIntent(existing)) !==
              canonicalJson(asfDeliveryUnsignedIntent(intent)) ||
            existing.intent_digest !== intent.intent_digest
          ) {
            throw asfDeliveryStateError(
              `ASF delivery intent ${intent.intent_id} conflicts within one ownership generation`,
              intent.run_id,
            );
          }
          return {
            intent: existing,
            disposition: "existing-current",
          } as const;
        }
        if (existing.fencing_generation >= intent.fencing_generation) {
          throw asfDeliveryStateError(
            `ASF delivery effect ${intent.effect_key} is already fenced at generation ` +
              existing.fencing_generation,
            intent.run_id,
          );
        }
        if (reconciliationAuthorization?.outcome === "not_applied") {
          if (
            existing.observationOutcome === null &&
            existing.replayAuthorizedOperationId ===
              reconciliationAuthorization.operationId &&
            existing.replayStartedGeneration !== null
          ) {
            // A prior worker already consumed the single replay grant before
            // calling the adapter. Any replacement may observe and confirm,
            // but it cannot invoke the effect again without a new exact
            // not-applied reconciliation result.
            return {
              intent: existing,
              disposition: "existing-prior-generation",
            } as const;
          }
          if (
            existing.observationOutcome !== "not_applied" ||
            existing.observationDigest === null ||
            existing.confirmedGeneration === null ||
            existing.confirmedAt === null
          ) {
            throw asfDeliveryStateError(
              `ASF delivery replay ${intent.effect_key} no longer has its exact not-applied evidence`,
              intent.run_id,
            );
          }
          // A lifecycle not-applied observation does not prove that the
          // provider invocation itself was free. Close any pre-v9 reserved
          // crash window at its full cap before consuming replay authority.
          this.#settleResolvedAsfProviderBudgetForIntent(existing);
          const consumed = this.#db
            .prepare(
              `UPDATE asf_delivery_stage_intents
               SET observation_digest = NULL, observation_outcome = NULL,
                   confirmed_generation = NULL, confirmed_at = NULL,
                   replay_authorized_operation_id = ?, replay_started_generation = ?
               WHERE effect_key = ? AND observation_outcome = 'not_applied'
                 AND observation_digest = ? AND confirmed_generation = ?`,
            )
            .run(
              reconciliationAuthorization.operationId,
              intent.fencing_generation,
              intent.effect_key,
              existing.observationDigest,
              existing.confirmedGeneration,
            );
          if (consumed.changes !== 1) {
            throw asfDeliveryStateError(
              `ASF delivery replay ${intent.effect_key} lost its durable not-applied fence`,
              intent.run_id,
            );
          }
          const replaying = this.getAsfDeliveryIntent(intent.effect_key);
          if (replaying === undefined) {
            throw new Error(
              `replaying ASF delivery intent ${intent.effect_key} disappeared`,
            );
          }
          return {
            intent: replaying,
            disposition: "existing-prior-generation-replay-authorized",
          } as const;
        }
        if (
          reconciliationAuthorization?.outcome === "confirmed" &&
          existing.observationOutcome !== "confirmed"
        ) {
          throw asfDeliveryStateError(
            `ASF delivery continuation ${intent.effect_key} lost its confirmed observation`,
            intent.run_id,
          );
        }
        return {
          intent: existing,
          disposition: "existing-prior-generation",
        } as const;
      }
      if (sameId !== undefined) {
        throw asfDeliveryStateError(
          `ASF delivery intent id ${intent.intent_id} is already bound to contradictory state`,
          intent.run_id,
        );
      }
      if (reconciliationCursor) {
        throw asfDeliveryStateError(
          `reconciliation continuation cannot create new effect authority at cursor ${intent.event_seq}`,
          intent.run_id,
        );
      }

      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO asf_delivery_stage_intents(
             effect_key, intent_id, intent_digest, schema, stage, run_id,
             work_order_id, attempt_id, policy_digest, fencing_generation,
             candidate_sha, event_seq, operation_digest, canonical_intent, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          intent.effect_key,
          intent.intent_id,
          intent.intent_digest,
          intent.schema,
          intent.stage,
          intent.run_id,
          intent.work_order_id,
          intent.attempt_id,
          intent.policy_digest,
          intent.fencing_generation,
          intent.candidate_sha,
          intent.event_seq,
          intent.operation_digest,
          canonicalIntent,
          intent.created_at,
        );
      const created = this.getAsfDeliveryIntent(intent.effect_key);
      if (created === undefined) {
        throw asfDeliveryStateError(
          `recorded ASF delivery intent ${intent.intent_id} disappeared at ${at}`,
          intent.run_id,
        );
      }
      return { intent: created, disposition: "created" } as const;
    });
    return transaction.immediate();
  }

  /** Confirm only an exact observation while the calling worker still owns the run. */
  confirmAsfDeliveryIntent(input: {
    readonly ownerId: string;
    readonly intentId: string;
    readonly intentDigest: string;
    readonly observationDigest: string;
    readonly binding: StateAsfDeliveryBinding;
  }): void {
    this.#confirmAsfDeliveryIntent(input, false);
  }

  #confirmAsfDeliveryIntent(
    input: {
      readonly ownerId: string;
      readonly intentId: string;
      readonly intentDigest: string;
      readonly observationDigest: string;
      readonly binding: StateAsfDeliveryBinding;
      readonly confirmedAt?: string | undefined;
    },
    terminalSeal: boolean,
  ): void {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.ownerId) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.intentId) ||
      !ASF_DELIVERY_DIGEST.test(input.intentDigest) ||
      !ASF_DELIVERY_DIGEST.test(input.observationDigest) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.binding.runId) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.binding.workOrderId) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.binding.attemptId) ||
      !ASF_DELIVERY_DIGEST.test(input.binding.policyDigest) ||
      !Number.isSafeInteger(input.binding.fencingGeneration) ||
      input.binding.fencingGeneration < 1 ||
      (input.binding.candidateSha !== null &&
        !ASF_DELIVERY_GIT_SHA.test(input.binding.candidateSha))
    ) {
      throw asfDeliveryStateError(
        "ASF delivery intent confirmation is malformed",
      );
    }
    const transaction = this.#db.transaction(() => {
      const binding = input.binding;
      const run = this.getAsfRun(binding.runId);
      const admission = this.getAsfAdmissionForRun(binding.runId);
      if (
        run === undefined ||
        admission === undefined ||
        run.ownerId !== input.ownerId ||
        run.generation !== binding.fencingGeneration
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${binding.fencingGeneration} ` +
            `cannot confirm delivery intent ${input.intentId}`,
          runId: binding.runId,
        });
      }
      if (
        run.workOrderId !== binding.workOrderId ||
        run.attemptId !== binding.attemptId ||
        admission.workOrderId !== binding.workOrderId ||
        admission.attemptId !== binding.attemptId ||
        run.candidateSha !== binding.candidateSha ||
        admission.effectivePolicyDigest !== binding.policyDigest
      ) {
        throw asfDeliveryStateError(
          `ASF delivery confirmation ${input.intentId} does not bind the current Work Order, ` +
            "attempt, candidate, and policy",
          binding.runId,
        );
      }
      if (!terminalSeal && asfPhaseFreezesExternalAuthority(run.state)) {
        throw asfDeliveryStateError(
          `ASF phase ${run.state} forbids ordinary delivery confirmation ${input.intentId}`,
          binding.runId,
        );
      }
      const stored = this.#getAsfDeliveryIntentById(input.intentId);
      if (
        stored === undefined ||
        stored.intent_digest !== input.intentDigest ||
        stored.run_id !== binding.runId ||
        stored.work_order_id !== binding.workOrderId ||
        stored.attempt_id !== binding.attemptId ||
        stored.policy_digest !== binding.policyDigest ||
        stored.candidate_sha !== binding.candidateSha ||
        stored.fencing_generation > binding.fencingGeneration ||
        stored.event_seq > run.stateVersion
      ) {
        throw asfDeliveryStateError(
          `ASF delivery confirmation ${input.intentId} does not bind its exact durable intent`,
          binding.runId,
        );
      }
      const terminalPlan = this.getAsfTerminalEvidencePlanRecord(binding.runId);
      if (
        !terminalSeal &&
        terminalPlan !== undefined &&
        terminalPlan.cleanupIntentId === input.intentId
      ) {
        this.getAsfTerminalEvidencePlan(binding.runId);
        throw asfDeliveryStateError(
          `terminal cleanup intent ${input.intentId} must be confirmed atomically with its ` +
            "canonical terminal evidence intent",
          binding.runId,
        );
      }
      if (stored.observationDigest !== null) {
        if (
          stored.observationOutcome !== "confirmed" ||
          stored.observationDigest !== input.observationDigest
        ) {
          throw asfDeliveryStateError(
            `ASF delivery intent ${input.intentId} is already confirmed by another observation`,
            binding.runId,
          );
        }
        return;
      }
      const confirmedAt = input.confirmedAt ?? this.#clock.now().toISOString();
      if (
        !isCanonicalIsoTimestamp(confirmedAt) ||
        Date.parse(confirmedAt) > this.#clock.now().getTime()
      ) {
        throw asfDeliveryStateError(
          `ASF delivery confirmation ${input.intentId} has an invalid durable timestamp`,
          binding.runId,
        );
      }
      this.#recordAsfDeliveryIntentObservation({
        effectKey: stored.effect_key,
        outcome: "confirmed",
        observationDigest: input.observationDigest,
        generation: binding.fencingGeneration,
        source: "confirmation",
        observedAt: confirmedAt,
      });
      const confirmed = this.#db
        .prepare(
          `UPDATE asf_delivery_stage_intents
           SET observation_digest = ?, observation_outcome = 'confirmed',
               confirmed_generation = ?, confirmed_at = ?,
               replay_authorized_operation_id = NULL,
               replay_started_generation = NULL
           WHERE intent_id = ? AND intent_digest = ? AND observation_digest IS NULL`,
        )
        .run(
          input.observationDigest,
          binding.fencingGeneration,
          confirmedAt,
          input.intentId,
          input.intentDigest,
        );
      if (confirmed.changes !== 1) {
        throw asfDeliveryStateError(
          `ASF delivery intent ${input.intentId} confirmation lost its durable binding`,
          binding.runId,
        );
      }
    });
    transaction.immediate();
  }

  /**
   * Persist an observation-only reconciliation outcome for a generic stage
   * intent. `not_applied` resolves ambiguity but does not authorize replay;
   * the checkpoint recovery policy must make that separate decision.
   */
  resolveAsfDeliveryIntentReconciliation(input: {
    readonly effectKey: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly outcome: "confirmed" | "not_applied";
    readonly observationDigest: string;
  }): StoredAsfDeliveryStageIntent {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.effectKey) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.ownerId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !ASF_DELIVERY_DIGEST.test(input.observationDigest)
    ) {
      throw asfDeliveryStateError(
        "ASF delivery reconciliation outcome is malformed",
      );
    }
    const transaction = this.#db.transaction(() => {
      const stored = this.getAsfDeliveryIntent(input.effectKey);
      if (stored === undefined) {
        throw asfDeliveryStateError(
          `ASF delivery reconciliation effect ${input.effectKey} does not exist`,
        );
      }
      if (this.getAsfTerminalEvidencePlanRecord(stored.run_id) !== undefined) {
        this.getAsfTerminalEvidencePlan(stored.run_id);
        throw asfDeliveryStateError(
          `immutable terminal cleanup plan forbids generic reconciliation of ${input.effectKey}`,
          stored.run_id,
        );
      }
      const run = this.getAsfRun(stored.run_id);
      const admission = this.getAsfAdmissionForRun(stored.run_id);
      if (
        run === undefined ||
        admission === undefined ||
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot resolve ` +
            input.effectKey,
          runId: stored.run_id,
        });
      }
      if (
        run.workOrderId !== stored.work_order_id ||
        run.attemptId !== stored.attempt_id ||
        admission.effectivePolicyDigest !== stored.policy_digest ||
        run.candidateSha !== stored.candidate_sha ||
        stored.fencing_generation > input.generation
      ) {
        throw asfDeliveryStateError(
          `ASF delivery reconciliation ${input.effectKey} is not exact-bound to the current run`,
          stored.run_id,
        );
      }
      if (stored.observationOutcome !== null) {
        if (
          stored.observationOutcome !== input.outcome ||
          stored.observationDigest !== input.observationDigest
        ) {
          throw asfDeliveryStateError(
            `ASF delivery reconciliation ${input.effectKey} contradicts its prior outcome`,
            stored.run_id,
          );
        }
        this.#settleResolvedAsfProviderBudgetForIntent(stored);
        return stored;
      }
      const at = this.#clock.now().toISOString();
      this.#recordAsfDeliveryIntentObservation({
        effectKey: input.effectKey,
        outcome: input.outcome,
        observationDigest: input.observationDigest,
        generation: input.generation,
        source: "reconciliation",
        observedAt: at,
      });
      const updated = this.#db
        .prepare(
          `UPDATE asf_delivery_stage_intents
           SET observation_digest = ?, observation_outcome = ?,
               confirmed_generation = ?, confirmed_at = ?,
               replay_authorized_operation_id = NULL,
               replay_started_generation = NULL
           WHERE effect_key = ? AND observation_outcome IS NULL`,
        )
        .run(
          input.observationDigest,
          input.outcome,
          input.generation,
          at,
          input.effectKey,
        );
      if (updated.changes !== 1) {
        throw asfDeliveryStateError(
          `ASF delivery reconciliation ${input.effectKey} lost its durable fence`,
          stored.run_id,
        );
      }
      const resolved = this.getAsfDeliveryIntent(input.effectKey);
      if (resolved === undefined) {
        throw new Error(
          `resolved ASF delivery intent ${input.effectKey} disappeared`,
        );
      }
      this.#settleResolvedAsfProviderBudgetForIntent(resolved);
      return resolved;
    });
    return transaction.immediate();
  }

  // -- ASF provider budgets ---------------------------------------------

  #effectiveAsfBudgetPolicy(
    admission: AsfAdmissionRecord,
  ): EffectiveAsfBudgetPolicy {
    let raw: unknown;
    try {
      raw = JSON.parse(admission.effectivePolicy) as unknown;
    } catch {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has malformed effective budget policy JSON`,
        admission.runId,
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has malformed effective budget policy`,
        admission.runId,
      );
    }
    const policy = raw as Record<string, unknown>;
    const rawBudgets = policy["budgets"];
    if (
      policy["digest"] !== admission.effectivePolicyDigest ||
      typeof rawBudgets !== "object" ||
      rawBudgets === null ||
      Array.isArray(rawBudgets)
    ) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has incomplete effective budget policy`,
        admission.runId,
      );
    }
    const budgets = rawBudgets as Record<string, unknown>;
    const wallSeconds = budgets["wallSeconds"];
    const maxCostUsd = budgets["maxCostUsd"];
    const maxAgentInvocations = budgets["maxAgentInvocations"];
    if (
      !Number.isSafeInteger(wallSeconds) ||
      (wallSeconds as number) < 1 ||
      typeof maxCostUsd !== "number" ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd < 0 ||
      !Number.isSafeInteger(maxAgentInvocations) ||
      (maxAgentInvocations as number) < 1
    ) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has invalid effective budget limits`,
        admission.runId,
      );
    }
    // Keep the durable authority integer-only. Policy values below one
    // micro-dollar round down and therefore never widen the signed cap.
    const costText = maxCostUsd.toString().toLowerCase();
    const [mantissa = "", rawExponent = "0"] = costText.split("e");
    const exponent = Number(rawExponent);
    const [whole = "", fraction = ""] = mantissa.split(".");
    const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
    if (!Number.isSafeInteger(exponent) || !/^\d+$/u.test(digits)) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has an unrepresentable cost limit`,
        admission.runId,
      );
    }
    const microExponent = exponent - fraction.length + 6;
    const coefficient = BigInt(digits);
    const micros =
      microExponent >= 0
        ? coefficient * 10n ** BigInt(microExponent)
        : coefficient / 10n ** BigInt(-microExponent);
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} cost limit exceeds durable range`,
        admission.runId,
      );
    }
    const acceptedMs = Date.parse(admission.acceptedAt);
    const durationMs = (wallSeconds as number) * 1_000;
    const deadlineMs = acceptedMs + durationMs;
    if (
      !Number.isFinite(acceptedMs) ||
      !Number.isSafeInteger(durationMs) ||
      !Number.isFinite(deadlineMs)
    ) {
      throw asfDeliveryStateError(
        `ASF run ${admission.runId} has an invalid accepted-at wall deadline`,
        admission.runId,
      );
    }
    return {
      wallSeconds: wallSeconds as number,
      maxCostMicros: Number(micros),
      maxAgentInvocations: maxAgentInvocations as number,
      acceptedAt: admission.acceptedAt,
      deadlineAt: new Date(deadlineMs).toISOString(),
    };
  }

  #assertAsfBudgetLimits(
    admission: AsfAdmissionRecord,
    limits: StateAsfBudgetLimits,
  ): EffectiveAsfBudgetPolicy {
    if (
      !Number.isSafeInteger(limits.wallSeconds) ||
      limits.wallSeconds < 1 ||
      !Number.isSafeInteger(limits.maxCostMicros) ||
      limits.maxCostMicros < 0 ||
      !Number.isSafeInteger(limits.maxAgentInvocations) ||
      limits.maxAgentInvocations < 1
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget limits are malformed",
        admission.runId,
      );
    }
    const authoritative = this.#effectiveAsfBudgetPolicy(admission);
    if (
      limits.wallSeconds !== authoritative.wallSeconds ||
      limits.maxCostMicros !== authoritative.maxCostMicros ||
      limits.maxAgentInvocations !== authoritative.maxAgentInvocations
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget request does not equal the immutable effective policy",
        admission.runId,
      );
    }
    return authoritative;
  }

  #assertCurrentAsfBudgetBinding(input: {
    readonly ownerId: string;
    readonly binding: StateAsfBudgetBinding;
  }): { readonly run: AsfRunRow; readonly admission: AsfAdmissionRecord } {
    const { binding } = input;
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.ownerId) ||
      !ASF_DELIVERY_IDENTIFIER.test(binding.runId) ||
      !ASF_DELIVERY_IDENTIFIER.test(binding.workOrderId) ||
      !ASF_DELIVERY_IDENTIFIER.test(binding.attemptId) ||
      !ASF_DELIVERY_DIGEST.test(binding.policyDigest) ||
      !Number.isSafeInteger(binding.fencingGeneration) ||
      binding.fencingGeneration < 1 ||
      (binding.candidateSha !== null &&
        !ASF_DELIVERY_GIT_SHA.test(binding.candidateSha))
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget binding is malformed",
        binding.runId,
      );
    }
    const run = this.getAsfRun(binding.runId);
    const admission = this.getAsfAdmissionForRun(binding.runId);
    if (
      run === undefined ||
      admission === undefined ||
      run.ownerId !== input.ownerId ||
      run.generation !== binding.fencingGeneration
    ) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened:
          `stale ASF worker ${input.ownerId} generation ${binding.fencingGeneration} ` +
          `cannot access provider budget for ${binding.runId}`,
        runId: binding.runId,
      });
    }
    if (
      run.workOrderId !== binding.workOrderId ||
      run.attemptId !== binding.attemptId ||
      admission.workOrderId !== binding.workOrderId ||
      admission.attemptId !== binding.attemptId ||
      admission.effectivePolicyDigest !== binding.policyDigest ||
      run.candidateSha !== binding.candidateSha
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget does not bind the current Work Order, attempt, policy, and candidate",
        binding.runId,
      );
    }
    return { run, admission };
  }

  #asfProviderBudgetUsage(
    runId: string,
    policy: EffectiveAsfBudgetPolicy,
  ): AsfProviderBudgetUsage {
    const aggregate = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'completed'
                             THEN actual_cost_micros ELSE 0 END), 0)
             AS completedCostMicros,
           COALESCE(SUM(CASE WHEN status = 'settled_unknown'
                             THEN actual_cost_micros ELSE 0 END), 0)
             AS settledUnknownCostMicros,
           COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_cost_micros ELSE 0 END), 0)
             AS outstandingReservedCostMicros,
           COALESCE(SUM(CASE WHEN status IN ('reserved','completed','settled_unknown')
                             THEN 1 ELSE 0 END), 0)
             AS invocationCount,
           COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0)
             AS deniedCount,
           COALESCE(SUM(CASE WHEN status = 'settled_unknown' THEN 1 ELSE 0 END), 0)
             AS settlementCount
         FROM asf_provider_budget_reservations WHERE run_id = ?`,
      )
      .get(runId) as {
      completedCostMicros: number;
      settledUnknownCostMicros: number;
      outstandingReservedCostMicros: number;
      invocationCount: number;
      deniedCount: number;
      settlementCount: number;
    };
    for (const value of [
      aggregate.completedCostMicros,
      aggregate.settledUnknownCostMicros,
      aggregate.outstandingReservedCostMicros,
      aggregate.invocationCount,
      aggregate.deniedCount,
      aggregate.settlementCount,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw asfDeliveryStateError(
          `ASF run ${runId} has corrupt provider budget aggregates`,
          runId,
        );
      }
    }
    const conservativeCostMicros =
      aggregate.completedCostMicros +
      aggregate.settledUnknownCostMicros +
      aggregate.outstandingReservedCostMicros;
    if (!Number.isSafeInteger(conservativeCostMicros)) {
      throw asfDeliveryStateError(
        `ASF run ${runId} provider cost aggregate exceeds durable range`,
        runId,
      );
    }
    return {
      runId,
      acceptedAt: policy.acceptedAt,
      deadlineAt: policy.deadlineAt,
      maxCostMicros: policy.maxCostMicros,
      completedCostMicros: aggregate.completedCostMicros,
      settledUnknownCostMicros: aggregate.settledUnknownCostMicros,
      outstandingReservedCostMicros: aggregate.outstandingReservedCostMicros,
      conservativeCostMicros,
      maxAgentInvocations: policy.maxAgentInvocations,
      invocationCount: aggregate.invocationCount,
      deniedCount: aggregate.deniedCount,
      settlementCount: aggregate.settlementCount,
    };
  }

  getAsfProviderBudgetUsage(runId: string): AsfProviderBudgetUsage {
    const admission = this.getAsfAdmissionForRun(runId);
    if (admission === undefined || this.getAsfRun(runId) === undefined) {
      throw asfDeliveryStateError(`ASF run ${runId} does not exist`, runId);
    }
    return this.#asfProviderBudgetUsage(
      runId,
      this.#effectiveAsfBudgetPolicy(admission),
    );
  }

  listAsfProviderBudgetReservations(
    runId: string,
    limit = 1_000,
  ): readonly AsfProviderBudgetReservationRecord[] {
    const run = this.getAsfRun(runId);
    if (run === undefined) {
      throw asfDeliveryStateError(`ASF run ${runId} does not exist`, runId);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new Error(
        "ASF provider budget record limit must be from 1 through 100000",
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT reservation_id AS reservationId, reservation_digest AS reservationDigest,
                effect_key AS effectKey, intent_id AS intentId, intent_digest AS intentDigest,
                run_id AS runId, work_order_id AS workOrderId, attempt_id AS attemptId,
                policy_digest AS policyDigest, initial_generation AS initialGeneration,
                completed_generation AS completedGeneration,
                lifecycle_candidate_sha AS lifecycleCandidateSha,
                provider_candidate_sha AS providerCandidateSha, role,
                invocation_id AS invocationId, reserved_cost_micros AS reservedCostMicros,
                actual_cost_micros AS actualCostMicros, max_cost_micros AS maxCostMicros,
                max_agent_invocations AS maxAgentInvocations, accepted_at AS acceptedAt,
                deadline_at AS deadlineAt, status, denial_reason AS denialReason,
                denial_observation_digest AS denialObservationDigest,
                provider_result_digest AS providerResultDigest, provider, model, principal, profile,
                settlement_outcome AS settlementOutcome,
                settlement_observation_digest AS settlementObservationDigest,
                settlement_digest AS settlementDigest,
                settlement_generation AS settlementGeneration,
                settlement_at AS settlementAt,
                created_at AS createdAt, completed_at AS completedAt
         FROM asf_provider_budget_reservations
         WHERE run_id = ? ORDER BY created_at, reservation_id LIMIT ?`,
      )
      .all(runId, limit) as AsfProviderBudgetReservationRecord[];
    for (const row of rows) {
      const expectedId = asfProviderBudgetReservationId({
        effectKey: row.effectKey,
        role: row.role,
        invocationId: row.invocationId,
      });
      const expectedDigest = sha256Digest(
        asfBudgetReservationMaterial({
          ...row,
          reservationId: row.reservationId,
        }),
      );
      const expectedSettlementDigest =
        expectedAsfBudgetUnknownSettlementDigest(row);
      const intent = this.getAsfDeliveryIntent(row.effectKey);
      const expectedRole =
        intent?.stage === "candidate"
          ? intent.candidate_sha === null
            ? "implementer"
            : "fixer"
          : intent?.stage === "local-review"
            ? "local-reviewer"
            : intent?.stage === "pull-request-review"
              ? "pr-reviewer"
              : null;
      const expectedProviderCandidateSha =
        intent?.stage === "candidate"
          ? (intent.candidate_sha ?? run.baseCommit)
          : intent?.candidate_sha;
      const settlementFieldsAbsent =
        row.settlementOutcome === null &&
        row.settlementObservationDigest === null &&
        row.settlementDigest === null &&
        row.settlementGeneration === null &&
        row.settlementAt === null;
      const exactUnknownSettlement =
        row.status === "settled_unknown" &&
        (row.settlementOutcome === "confirmed" ||
          row.settlementOutcome === "not_applied") &&
        row.actualCostMicros === row.reservedCostMicros &&
        row.reservedCostMicros > 0 &&
        row.completedGeneration === row.settlementGeneration &&
        row.completedAt === row.settlementAt &&
        row.providerResultDigest === null &&
        row.provider === null &&
        row.model === null &&
        row.principal === null &&
        row.profile === null &&
        row.denialReason === null &&
        row.denialObservationDigest === null &&
        row.settlementDigest !== null &&
        row.settlementDigest === expectedSettlementDigest &&
        ASF_DELIVERY_DIGEST.test(row.settlementDigest) &&
        row.settlementObservationDigest !== null &&
        ASF_DELIVERY_DIGEST.test(row.settlementObservationDigest) &&
        row.settlementGeneration !== null &&
        Number.isSafeInteger(row.settlementGeneration) &&
        row.settlementGeneration >= row.initialGeneration &&
        row.settlementGeneration <= run.generation &&
        row.settlementAt !== null &&
        isCanonicalIsoTimestamp(row.settlementAt);
      const completedAtValid =
        row.completedAt === null ||
        (isCanonicalIsoTimestamp(row.completedAt) &&
          Date.parse(row.completedAt) >= Date.parse(row.createdAt) &&
          Date.parse(row.completedAt) <= this.#clock.now().getTime());
      const reservedShape =
        row.status === "reserved" &&
        row.actualCostMicros === null &&
        row.completedGeneration === null &&
        row.denialReason === null &&
        row.denialObservationDigest === null &&
        row.providerResultDigest === null &&
        row.provider === null &&
        row.model === null &&
        row.principal === null &&
        row.profile === null &&
        settlementFieldsAbsent &&
        row.completedAt === null;
      const completedShape =
        row.status === "completed" &&
        row.actualCostMicros !== null &&
        Number.isSafeInteger(row.actualCostMicros) &&
        row.actualCostMicros >= 0 &&
        row.completedGeneration !== null &&
        Number.isSafeInteger(row.completedGeneration) &&
        row.completedGeneration >= row.initialGeneration &&
        row.completedGeneration <= run.generation &&
        row.denialReason === null &&
        row.denialObservationDigest === null &&
        row.providerResultDigest !== null &&
        ASF_DELIVERY_DIGEST.test(row.providerResultDigest) &&
        row.provider !== null &&
        ASF_DELIVERY_IDENTIFIER.test(row.provider) &&
        row.model !== null &&
        ASF_DELIVERY_IDENTIFIER.test(row.model) &&
        row.principal !== null &&
        ASF_DELIVERY_IDENTIFIER.test(row.principal) &&
        row.profile !== null &&
        ASF_DELIVERY_IDENTIFIER.test(row.profile) &&
        settlementFieldsAbsent &&
        row.completedAt !== null &&
        completedAtValid;
      const deniedShape =
        row.status === "denied" &&
        row.reservedCostMicros === 0 &&
        row.actualCostMicros === null &&
        row.completedGeneration === null &&
        row.denialReason !== null &&
        ["wall-deadline", "cost-limit", "invocation-limit"].includes(
          row.denialReason,
        ) &&
        row.denialObservationDigest !== null &&
        ASF_DELIVERY_DIGEST.test(row.denialObservationDigest) &&
        row.providerResultDigest === null &&
        row.provider === null &&
        row.model === null &&
        row.principal === null &&
        row.profile === null &&
        settlementFieldsAbsent &&
        row.completedAt !== null &&
        completedAtValid;
      if (
        !ASF_PROVIDER_BUDGET_ROLES.includes(row.role) ||
        intent === undefined ||
        intent.run_id !== row.runId ||
        intent.work_order_id !== row.workOrderId ||
        intent.attempt_id !== row.attemptId ||
        intent.policy_digest !== row.policyDigest ||
        intent.intent_id !== row.intentId ||
        intent.intent_digest !== row.intentDigest ||
        intent.fencing_generation !== row.initialGeneration ||
        intent.candidate_sha !== row.lifecycleCandidateSha ||
        expectedRole !== row.role ||
        expectedProviderCandidateSha !== row.providerCandidateSha ||
        asfProviderInvocationId(row.effectKey, row.role) !== row.invocationId ||
        !ASF_DELIVERY_IDENTIFIER.test(row.effectKey) ||
        !ASF_DELIVERY_IDENTIFIER.test(row.intentId) ||
        !ASF_DELIVERY_IDENTIFIER.test(row.runId) ||
        row.runId !== runId ||
        !ASF_DELIVERY_IDENTIFIER.test(row.workOrderId) ||
        !ASF_DELIVERY_IDENTIFIER.test(row.attemptId) ||
        !ASF_DELIVERY_IDENTIFIER.test(row.invocationId) ||
        row.reservationId !== expectedId ||
        row.reservationDigest !== expectedDigest ||
        !ASF_DELIVERY_DIGEST.test(row.reservationDigest) ||
        !ASF_DELIVERY_DIGEST.test(row.intentDigest) ||
        !ASF_DELIVERY_DIGEST.test(row.policyDigest) ||
        !ASF_DELIVERY_GIT_SHA.test(row.providerCandidateSha) ||
        (row.lifecycleCandidateSha !== null &&
          !ASF_DELIVERY_GIT_SHA.test(row.lifecycleCandidateSha)) ||
        !Number.isSafeInteger(row.initialGeneration) ||
        row.initialGeneration < 1 ||
        row.initialGeneration > run.generation ||
        !Number.isSafeInteger(row.reservedCostMicros) ||
        row.reservedCostMicros < 0 ||
        !Number.isSafeInteger(row.maxCostMicros) ||
        row.maxCostMicros < 0 ||
        !Number.isSafeInteger(row.maxAgentInvocations) ||
        row.maxAgentInvocations < 1 ||
        row.reservedCostMicros > row.maxCostMicros ||
        !isCanonicalIsoTimestamp(row.acceptedAt) ||
        !isCanonicalIsoTimestamp(row.deadlineAt) ||
        !isCanonicalIsoTimestamp(row.createdAt) ||
        Date.parse(row.acceptedAt) >= Date.parse(row.deadlineAt) ||
        Date.parse(row.createdAt) < Date.parse(row.acceptedAt) ||
        Date.parse(row.createdAt) > this.#clock.now().getTime() ||
        !completedAtValid ||
        (!reservedShape &&
          !completedShape &&
          !deniedShape &&
          !exactUnknownSettlement)
      ) {
        throw asfDeliveryStateError(
          `stored ASF provider budget reservation ${row.reservationId} is contradictory`,
          runId,
        );
      }
    }
    return rows;
  }

  getAsfProviderBudgetEvidenceSummary(
    runId: string,
  ): AsfProviderBudgetEvidenceSummary {
    const run = this.getAsfRun(runId);
    const admission = this.getAsfAdmissionForRun(runId);
    if (
      run === undefined ||
      admission === undefined ||
      run.mode !== "asf-worker" ||
      run.workOrderId !== admission.workOrderId ||
      run.attemptId !== admission.attemptId
    ) {
      throw asfDeliveryStateError(
        `ASF provider budget evidence names an unknown or contradictory run ${runId}`,
        runId,
      );
    }
    const recordCount = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM asf_provider_budget_reservations
           WHERE run_id = ?`,
        )
        .get(runId) as { count: number }
    ).count;
    if (
      !Number.isSafeInteger(recordCount) ||
      recordCount < 0 ||
      recordCount > 100_000
    ) {
      throw asfDeliveryStateError(
        `ASF provider budget evidence for ${runId} exceeds its bounded ledger`,
        runId,
      );
    }
    const reservations = this.listAsfProviderBudgetReservations(
      runId,
      Math.max(1, recordCount),
    );
    if (reservations.length !== recordCount) {
      throw asfDeliveryStateError(
        `ASF provider budget evidence for ${runId} lost a ledger row`,
        runId,
      );
    }
    const usage = this.getAsfProviderBudgetUsage(runId);
    if (
      reservations.some(
        (row) =>
          row.runId !== runId ||
          row.workOrderId !== admission.workOrderId ||
          row.attemptId !== admission.attemptId ||
          row.policyDigest !== admission.effectivePolicyDigest ||
          row.acceptedAt !== usage.acceptedAt ||
          row.deadlineAt !== usage.deadlineAt ||
          row.maxCostMicros !== usage.maxCostMicros ||
          row.maxAgentInvocations !== usage.maxAgentInvocations,
      )
    ) {
      throw asfDeliveryStateError(
        `ASF provider budget evidence for ${runId} contains a cross-bound ledger row`,
        runId,
      );
    }
    const completed = reservations.filter((row) => row.status === "completed");
    const settled = reservations.filter(
      (row) => row.status === "settled_unknown",
    );
    const outstanding = reservations.filter((row) => row.status === "reserved");
    const denied = reservations.filter((row) => row.status === "denied");
    const sum = (
      rows: readonly AsfProviderBudgetReservationRecord[],
      field: "actualCostMicros" | "reservedCostMicros",
    ): number => {
      const total = rows.reduce((value, row) => value + (row[field] ?? 0), 0);
      if (!Number.isSafeInteger(total) || total < 0) {
        throw asfDeliveryStateError(
          `ASF provider budget evidence for ${runId} exceeds the durable cost range`,
          runId,
        );
      }
      return total;
    };
    const reportedActualCostMicros = sum(completed, "actualCostMicros");
    const settledUnknownCostMicros = sum(settled, "actualCostMicros");
    const outstandingReservedCostMicros = sum(
      outstanding,
      "reservedCostMicros",
    );
    if (
      usage.completedCostMicros !== reportedActualCostMicros ||
      usage.settledUnknownCostMicros !== settledUnknownCostMicros ||
      usage.outstandingReservedCostMicros !== outstandingReservedCostMicros ||
      usage.invocationCount !==
        completed.length + settled.length + outstanding.length ||
      usage.deniedCount !== denied.length ||
      usage.settlementCount !== settled.length
    ) {
      throw asfDeliveryStateError(
        `ASF provider budget evidence for ${runId} contradicts its aggregate usage`,
        runId,
      );
    }
    const invocations = [...completed, ...settled]
      .sort((left, right) =>
        left.reservationId.localeCompare(right.reservationId),
      )
      .map((row) => {
        if (
          row.actualCostMicros === null ||
          row.completedGeneration === null ||
          row.completedAt === null
        ) {
          throw asfDeliveryStateError(
            `ASF provider budget evidence for ${runId} has an incomplete charged invocation`,
            runId,
          );
        }
        return Object.freeze({
          reservationId: row.reservationId,
          reservationDigest: row.reservationDigest,
          effectKey: row.effectKey,
          intentId: row.intentId,
          intentDigest: row.intentDigest,
          invocationId: row.invocationId,
          role: row.role,
          lifecycleCandidateSha: row.lifecycleCandidateSha,
          providerCandidateSha: row.providerCandidateSha,
          initialGeneration: row.initialGeneration,
          completedGeneration: row.completedGeneration,
          status: row.status as "completed" | "settled_unknown",
          reservedCostMicros: row.reservedCostMicros,
          chargedCostMicros: row.actualCostMicros,
          attributionStatus:
            row.status === "completed"
              ? ("reported" as const)
              : ("provider_unknown" as const),
          providerResultDigest: row.providerResultDigest,
          provider: row.provider,
          model: row.model,
          principal: row.principal,
          profile: row.profile,
          settlementOutcome: row.settlementOutcome,
          settlementObservationDigest: row.settlementObservationDigest,
          settlementDigest: row.settlementDigest,
          completedAt: row.completedAt,
        });
      });
    const canonicalLedger = {
      schema: "asf.provider-budget-public-ledger/v1" as const,
      run_id: runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      policy_digest: admission.effectivePolicyDigest,
      candidate_sha: run.candidateSha,
      limits: {
        accepted_at: usage.acceptedAt,
        deadline_at: usage.deadlineAt,
        max_cost_micros: usage.maxCostMicros,
        max_agent_invocations: usage.maxAgentInvocations,
      },
      reservations: reservations.map((row) => ({
        reservation_id: row.reservationId,
        reservation_digest: row.reservationDigest,
        effect_key: row.effectKey,
        intent_id: row.intentId,
        intent_digest: row.intentDigest,
        run_id: row.runId,
        work_order_id: row.workOrderId,
        attempt_id: row.attemptId,
        policy_digest: row.policyDigest,
        initial_generation: row.initialGeneration,
        completed_generation: row.completedGeneration,
        lifecycle_candidate_sha: row.lifecycleCandidateSha,
        provider_candidate_sha: row.providerCandidateSha,
        role: row.role,
        invocation_id: row.invocationId,
        reserved_cost_micros: row.reservedCostMicros,
        actual_cost_micros: row.actualCostMicros,
        max_cost_micros: row.maxCostMicros,
        max_agent_invocations: row.maxAgentInvocations,
        accepted_at: row.acceptedAt,
        deadline_at: row.deadlineAt,
        status: row.status,
        denial_reason: row.denialReason,
        denial_observation_digest: row.denialObservationDigest,
        provider_result_digest: row.providerResultDigest,
        provider: row.provider,
        model: row.model,
        principal: row.principal,
        profile: row.profile,
        settlement_outcome: row.settlementOutcome,
        settlement_observation_digest: row.settlementObservationDigest,
        settlement_digest: row.settlementDigest,
        settlement_generation: row.settlementGeneration,
        settlement_at: row.settlementAt,
        created_at: row.createdAt,
        completed_at: row.completedAt,
      })),
    };
    const settlementDigests = settled.map((row) => {
      if (row.settlementDigest === null) {
        throw asfDeliveryStateError(
          `ASF provider budget evidence for ${runId} has an incomplete settlement`,
          runId,
        );
      }
      return row.settlementDigest;
    });
    settlementDigests.sort();
    return Object.freeze({
      schema: "asf.provider-budget-evidence-summary/v1",
      runId,
      workOrderId: admission.workOrderId,
      attemptId: admission.attemptId,
      policyDigest: admission.effectivePolicyDigest,
      candidateSha: run.candidateSha,
      usage: Object.freeze({
        maxCostMicros: usage.maxCostMicros,
        reportedActualCostMicros,
        settledUnknownCostMicros,
        outstandingReservedCostMicros,
        conservativeCostMicros: usage.conservativeCostMicros,
        invocationCount: usage.invocationCount,
        completedInvocationCount: completed.length,
        settledUnknownInvocationCount: settled.length,
        outstandingInvocationCount: outstanding.length,
        deniedCount: denied.length,
      }),
      invocations: Object.freeze(invocations),
      settlementDigests: Object.freeze(settlementDigests),
      ledgerDigest: sha256Digest(canonicalLedger as unknown as JsonValue),
    });
  }

  /**
   * Fenced pre-terminal snapshot. The only mutation it may perform is healing
   * a pre-v9 reserved row whose linked intent already has exact definitive
   * reconciliation evidence; genuinely unresolved usage remains refused.
   */
  prepareAsfTerminalProviderBudgetEvidence(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
  }): AsfProviderBudgetEvidenceSummary {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.runId) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.ownerId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    ) {
      throw asfDeliveryStateError(
        "ASF terminal provider budget evidence fence is malformed",
        input.runId,
      );
    }
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(input.runId);
      const admission = this.getAsfAdmissionForRun(input.runId);
      if (
        run === undefined ||
        admission === undefined ||
        run.mode !== "asf-worker" ||
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot prepare ` +
            `terminal provider evidence for ${input.runId}`,
          runId: input.runId,
        });
      }
      if (this.getAsfTerminalEvidencePlanRecord(input.runId) !== undefined) {
        this.getAsfTerminalEvidencePlan(input.runId);
        throw asfDeliveryStateError(
          `immutable terminal plan for ${input.runId} already froze provider budget evidence`,
          input.runId,
        );
      }
      this.#settleResolvedAsfProviderBudgets(input.runId);
      const summary = this.getAsfProviderBudgetEvidenceSummary(input.runId);
      if (
        summary.workOrderId !== admission.workOrderId ||
        summary.attemptId !== admission.attemptId ||
        summary.policyDigest !== admission.effectivePolicyDigest ||
        summary.candidateSha !== run.candidateSha ||
        summary.usage.outstandingReservedCostMicros !== 0 ||
        summary.usage.outstandingInvocationCount !== 0
      ) {
        throw asfDeliveryStateError(
          `terminal provider budget evidence for ${input.runId} has unresolved or stale usage`,
          input.runId,
        );
      }
      return summary;
    });
    return transaction.immediate();
  }

  #getAsfProviderBudgetReservationByEffectKey(
    effectKey: string,
  ): AsfProviderBudgetReservationRecord | undefined {
    return this.#db
      .prepare(
        `SELECT reservation_id AS reservationId, reservation_digest AS reservationDigest,
                effect_key AS effectKey, intent_id AS intentId, intent_digest AS intentDigest,
                run_id AS runId, work_order_id AS workOrderId, attempt_id AS attemptId,
                policy_digest AS policyDigest, initial_generation AS initialGeneration,
                completed_generation AS completedGeneration,
                lifecycle_candidate_sha AS lifecycleCandidateSha,
                provider_candidate_sha AS providerCandidateSha, role,
                invocation_id AS invocationId, reserved_cost_micros AS reservedCostMicros,
                actual_cost_micros AS actualCostMicros, max_cost_micros AS maxCostMicros,
                max_agent_invocations AS maxAgentInvocations, accepted_at AS acceptedAt,
                deadline_at AS deadlineAt, status, denial_reason AS denialReason,
                denial_observation_digest AS denialObservationDigest,
                provider_result_digest AS providerResultDigest, provider, model, principal, profile,
                settlement_outcome AS settlementOutcome,
                settlement_observation_digest AS settlementObservationDigest,
                settlement_digest AS settlementDigest,
                settlement_generation AS settlementGeneration,
                settlement_at AS settlementAt,
                created_at AS createdAt, completed_at AS completedAt
         FROM asf_provider_budget_reservations WHERE effect_key = ?`,
      )
      .get(effectKey) as AsfProviderBudgetReservationRecord | undefined;
  }

  /**
   * Close an exact provider crash window without inventing provider output.
   * This is intentionally private: only the durable lifecycle reconciliation
   * transaction may convert unknown usage into a conservative full charge.
   */
  #settleUnknownAsfProviderBudgetForIntent(input: {
    readonly intent: StoredAsfDeliveryStageIntent;
    readonly outcome: "confirmed" | "not_applied";
    readonly observationDigest: string;
    readonly generation: number;
    readonly at: string;
  }): string | null {
    if (
      !ASF_DELIVERY_DIGEST.test(input.observationDigest) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < input.intent.fencing_generation ||
      !isCanonicalIsoTimestamp(input.at)
    ) {
      throw asfDeliveryStateError(
        `provider settlement for ${input.intent.effect_key} has malformed reconciliation evidence`,
        input.intent.run_id,
      );
    }
    const reservation = this.#getAsfProviderBudgetReservationByEffectKey(
      input.intent.effect_key,
    );
    if (reservation === undefined) return null;
    const expectedReservationId = asfProviderBudgetReservationId({
      effectKey: reservation.effectKey,
      role: reservation.role,
      invocationId: reservation.invocationId,
    });
    const expectedReservationDigest = sha256Digest(
      asfBudgetReservationMaterial({
        ...reservation,
        reservationId: reservation.reservationId,
      }),
    );
    if (
      reservation.reservationId !== expectedReservationId ||
      reservation.reservationDigest !== expectedReservationDigest ||
      reservation.effectKey !== input.intent.effect_key ||
      reservation.intentId !== input.intent.intent_id ||
      reservation.intentDigest !== input.intent.intent_digest ||
      reservation.runId !== input.intent.run_id ||
      reservation.workOrderId !== input.intent.work_order_id ||
      reservation.attemptId !== input.intent.attempt_id ||
      reservation.policyDigest !== input.intent.policy_digest ||
      reservation.lifecycleCandidateSha !== input.intent.candidate_sha ||
      reservation.initialGeneration !== input.intent.fencing_generation ||
      reservation.initialGeneration > input.generation
    ) {
      throw asfDeliveryStateError(
        `provider settlement for ${input.intent.effect_key} contradicts its exact reservation`,
        input.intent.run_id,
      );
    }
    if (reservation.status === "completed" || reservation.status === "denied") {
      return null;
    }
    if (reservation.status === "settled_unknown") {
      const expectedSettlementDigest =
        expectedAsfBudgetUnknownSettlementDigest(reservation);
      if (
        reservation.actualCostMicros !== reservation.reservedCostMicros ||
        reservation.completedGeneration !== input.generation ||
        reservation.settlementOutcome !== input.outcome ||
        reservation.settlementObservationDigest !== input.observationDigest ||
        reservation.settlementGeneration !== input.generation ||
        reservation.settlementAt !== input.at ||
        reservation.completedAt !== input.at ||
        reservation.settlementDigest === null ||
        reservation.settlementDigest !== expectedSettlementDigest
      ) {
        throw asfDeliveryStateError(
          `provider settlement for ${input.intent.effect_key} contradicts its durable evidence`,
          input.intent.run_id,
        );
      }
      return reservation.settlementDigest;
    }
    if (
      reservation.status !== "reserved" ||
      reservation.reservedCostMicros <= 0
    ) {
      throw asfDeliveryStateError(
        `provider settlement for ${input.intent.effect_key} has no chargeable reservation`,
        input.intent.run_id,
      );
    }
    const settlementDigest = sha256Digest(
      asfBudgetUnknownSettlementMaterial({
        reservation,
        outcome: input.outcome,
        observationDigest: input.observationDigest,
        settlementGeneration: input.generation,
        settlementAt: input.at,
      }),
    );
    const settled = this.#db
      .prepare(
        `UPDATE asf_provider_budget_reservations
         SET status = 'settled_unknown', actual_cost_micros = reserved_cost_micros,
             completed_generation = ?, settlement_outcome = ?,
             settlement_observation_digest = ?, settlement_digest = ?,
             settlement_generation = ?, settlement_at = ?, completed_at = ?
         WHERE reservation_id = ? AND reservation_digest = ? AND effect_key = ?
           AND intent_id = ? AND intent_digest = ? AND status = 'reserved'`,
      )
      .run(
        input.generation,
        input.outcome,
        input.observationDigest,
        settlementDigest,
        input.generation,
        input.at,
        input.at,
        reservation.reservationId,
        reservation.reservationDigest,
        input.intent.effect_key,
        input.intent.intent_id,
        input.intent.intent_digest,
      );
    if (settled.changes !== 1) {
      throw asfDeliveryStateError(
        `provider settlement for ${input.intent.effect_key} lost its durable reservation`,
        input.intent.run_id,
      );
    }
    return settlementDigest;
  }

  #settleResolvedAsfProviderBudgetForIntent(
    intent: StoredAsfDeliveryStageIntent,
  ): string | null {
    if (
      (intent.observationOutcome !== "confirmed" &&
        intent.observationOutcome !== "not_applied") ||
      intent.observationDigest === null ||
      intent.confirmedGeneration === null ||
      intent.confirmedAt === null
    ) {
      return null;
    }
    return this.#settleUnknownAsfProviderBudgetForIntent({
      intent,
      outcome: intent.observationOutcome,
      observationDigest: intent.observationDigest,
      generation: intent.confirmedGeneration,
      at: intent.confirmedAt,
    });
  }

  #settleResolvedAsfProviderBudgets(runId: string): readonly string[] {
    const effectKeys = this.#db
      .prepare(
        `SELECT effect_key AS effectKey
         FROM asf_provider_budget_reservations
         WHERE run_id = ? AND status = 'reserved'
         ORDER BY effect_key`,
      )
      .all(runId) as { effectKey: string }[];
    const digests: string[] = [];
    for (const { effectKey } of effectKeys) {
      const intent = this.getAsfDeliveryIntent(effectKey);
      if (intent === undefined || intent.run_id !== runId) {
        throw asfDeliveryStateError(
          `provider reservation ${effectKey} has no exact delivery intent`,
          runId,
        );
      }
      const digest = this.#settleResolvedAsfProviderBudgetForIntent(intent);
      if (digest !== null) digests.push(digest);
    }
    return Object.freeze([...new Set(digests)].sort());
  }

  checkAsfRunBudget(input: {
    readonly ownerId: string;
    readonly binding: StateAsfBudgetBinding;
    readonly limits: StateAsfBudgetLimits;
  }): AsfRunBudgetCheck {
    const transaction = this.#db.transaction(() => {
      const { admission } = this.#assertCurrentAsfBudgetBinding(input);
      const policy = this.#assertAsfBudgetLimits(admission, input.limits);
      const usage = this.#asfProviderBudgetUsage(input.binding.runId, policy);
      const checkedAt = this.#clock.now().toISOString();
      const reason =
        Date.parse(checkedAt) >= Date.parse(policy.deadlineAt)
          ? ("wall-deadline" as const)
          : usage.conservativeCostMicros > policy.maxCostMicros
            ? ("cost-limit" as const)
            : undefined;
      if (reason === undefined) return { status: "available" } as const;
      return {
        status: "exhausted",
        reason,
        observationDigest: sha256Digest({
          schema: "asf.provider-budget-check/v1",
          run_id: input.binding.runId,
          work_order_id: input.binding.workOrderId,
          attempt_id: input.binding.attemptId,
          policy_digest: input.binding.policyDigest,
          fencing_generation: input.binding.fencingGeneration,
          candidate_sha: input.binding.candidateSha,
          checked_at: checkedAt,
          reason,
          conservative_cost_micros: usage.conservativeCostMicros,
          max_cost_micros: usage.maxCostMicros,
          invocation_count: usage.invocationCount,
          max_agent_invocations: usage.maxAgentInvocations,
          deadline_at: usage.deadlineAt,
        }),
      } as const;
    });
    return transaction.deferred();
  }

  reserveAsfProviderBudget(input: {
    readonly ownerId: string;
    readonly binding: StateAsfBudgetBinding;
    readonly effectKey: string;
    readonly intentId: string;
    readonly intentDigest: string;
    readonly intentGeneration: number;
    readonly intentMode: "observe-before-apply" | "reconcile-only";
    readonly role: AsfProviderBudgetRole;
    readonly invocationId: string;
    readonly providerCandidateSha: string;
    readonly limits: StateAsfBudgetLimits;
  }):
    | {
        readonly status: "reserved";
        readonly reservationId: string;
        readonly reservationDigest: string;
        readonly authorization: "invoke" | "reconcile-only";
        readonly acceptedAt: string;
        readonly deadlineAt: string;
        readonly remainingWallMs: number;
        readonly reservedCostMicros: number;
        readonly invocationOrdinal: number;
        readonly maxAgentInvocations: number;
      }
    | {
        readonly status: "exhausted";
        readonly reason: AsfProviderBudgetExhaustionReason;
        readonly observationDigest: string;
      } {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.effectKey) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.intentId) ||
      !ASF_DELIVERY_DIGEST.test(input.intentDigest) ||
      !Number.isSafeInteger(input.intentGeneration) ||
      input.intentGeneration < 1 ||
      !ASF_PROVIDER_BUDGET_ROLES.includes(input.role) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.invocationId) ||
      !ASF_DELIVERY_GIT_SHA.test(input.providerCandidateSha)
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget reservation is malformed",
      );
    }
    const transaction = this.#db.transaction(() => {
      const { run, admission } = this.#assertCurrentAsfBudgetBinding(input);
      const policy = this.#assertAsfBudgetLimits(admission, input.limits);
      const intent = this.#getAsfDeliveryIntentById(input.intentId);
      if (
        intent === undefined ||
        intent.effect_key !== input.effectKey ||
        intent.intent_digest !== input.intentDigest ||
        intent.run_id !== input.binding.runId ||
        intent.work_order_id !== input.binding.workOrderId ||
        intent.attempt_id !== input.binding.attemptId ||
        intent.policy_digest !== input.binding.policyDigest ||
        intent.candidate_sha !== input.binding.candidateSha ||
        intent.fencing_generation !== input.intentGeneration ||
        intent.fencing_generation > input.binding.fencingGeneration
      ) {
        throw asfDeliveryStateError(
          "ASF provider budget reservation does not bind its durable delivery intent",
          input.binding.runId,
        );
      }
      if (asfPhaseFreezesExternalAuthority(run.state)) {
        const existingReservation = this.#db
          .prepare(
            `SELECT reservation_id AS reservationId
             FROM asf_provider_budget_reservations WHERE effect_key = ?`,
          )
          .get(input.effectKey) as { reservationId: string } | undefined;
        if (existingReservation === undefined) {
          throw asfDeliveryStateError(
            `ASF phase ${run.state} forbids a new provider reservation for ` +
              input.binding.runId,
            input.binding.runId,
          );
        }
      }
      const expectedRole =
        intent.stage === "candidate"
          ? run.candidateSha === null
            ? "implementer"
            : "fixer"
          : intent.stage === "local-review"
            ? "local-reviewer"
            : intent.stage === "pull-request-review"
              ? "pr-reviewer"
              : undefined;
      const expectedProviderCandidate =
        intent.stage === "candidate"
          ? (run.candidateSha ?? run.baseCommit)
          : run.candidateSha;
      if (
        expectedRole === undefined ||
        input.role !== expectedRole ||
        expectedProviderCandidate === null ||
        input.providerCandidateSha !== expectedProviderCandidate ||
        (intent.stage === "candidate" &&
          input.invocationId !==
            asfProviderInvocationId(input.effectKey, input.role))
      ) {
        throw asfDeliveryStateError(
          "ASF provider reservation role, invocation, or provider candidate is contradictory",
          input.binding.runId,
        );
      }
      const reservationId = asfProviderBudgetReservationId({
        effectKey: input.effectKey,
        role: input.role,
        invocationId: input.invocationId,
      });
      const existing = this.#db
        .prepare(
          `SELECT reservation_id AS reservationId, reservation_digest AS reservationDigest,
                  effect_key AS effectKey, intent_id AS intentId, intent_digest AS intentDigest,
                  run_id AS runId, work_order_id AS workOrderId, attempt_id AS attemptId,
                  policy_digest AS policyDigest, initial_generation AS initialGeneration,
                  completed_generation AS completedGeneration,
                  lifecycle_candidate_sha AS lifecycleCandidateSha,
                  provider_candidate_sha AS providerCandidateSha, role,
                  invocation_id AS invocationId, reserved_cost_micros AS reservedCostMicros,
                  actual_cost_micros AS actualCostMicros, max_cost_micros AS maxCostMicros,
                  max_agent_invocations AS maxAgentInvocations, accepted_at AS acceptedAt,
                  deadline_at AS deadlineAt, status, denial_reason AS denialReason,
                  denial_observation_digest AS denialObservationDigest,
                  provider_result_digest AS providerResultDigest, provider, model, principal, profile,
                  settlement_outcome AS settlementOutcome,
                  settlement_observation_digest AS settlementObservationDigest,
                  settlement_digest AS settlementDigest,
                  settlement_generation AS settlementGeneration,
                  settlement_at AS settlementAt,
                  created_at AS createdAt, completed_at AS completedAt
           FROM asf_provider_budget_reservations WHERE effect_key = ?`,
        )
        .get(input.effectKey) as AsfProviderBudgetReservationRecord | undefined;
      if (existing !== undefined) {
        const immutableDigest = sha256Digest(
          asfBudgetReservationMaterial({
            ...existing,
            reservationId: existing.reservationId,
          }),
        );
        if (
          existing.reservationId !== reservationId ||
          existing.reservationDigest !== immutableDigest ||
          existing.intentId !== input.intentId ||
          existing.intentDigest !== input.intentDigest ||
          existing.runId !== input.binding.runId ||
          existing.workOrderId !== input.binding.workOrderId ||
          existing.attemptId !== input.binding.attemptId ||
          existing.policyDigest !== input.binding.policyDigest ||
          existing.lifecycleCandidateSha !== input.binding.candidateSha ||
          existing.providerCandidateSha !== input.providerCandidateSha ||
          existing.role !== input.role ||
          existing.invocationId !== input.invocationId ||
          existing.initialGeneration !== input.intentGeneration ||
          existing.initialGeneration > input.binding.fencingGeneration ||
          existing.maxCostMicros !== policy.maxCostMicros ||
          existing.maxAgentInvocations !== policy.maxAgentInvocations ||
          existing.acceptedAt !== policy.acceptedAt ||
          existing.deadlineAt !== policy.deadlineAt
        ) {
          throw asfDeliveryStateError(
            `ASF provider budget reservation ${reservationId} is contradictory`,
            input.binding.runId,
          );
        }
        if (existing.status === "denied") {
          if (
            existing.denialReason === null ||
            existing.denialObservationDigest === null
          ) {
            throw asfDeliveryStateError(
              `ASF provider budget denial ${reservationId} is incomplete`,
              input.binding.runId,
            );
          }
          return {
            status: "exhausted",
            reason: existing.denialReason,
            observationDigest: existing.denialObservationDigest,
          } as const;
        }
        if (existing.status === "settled_unknown") {
          const expectedSettlementDigest =
            expectedAsfBudgetUnknownSettlementDigest(existing);
          if (
            existing.actualCostMicros !== existing.reservedCostMicros ||
            existing.completedGeneration !== existing.settlementGeneration ||
            existing.completedAt !== existing.settlementAt ||
            existing.settlementDigest === null ||
            existing.settlementDigest !== expectedSettlementDigest ||
            existing.providerResultDigest !== null ||
            existing.provider !== null ||
            existing.model !== null ||
            existing.principal !== null ||
            existing.profile !== null
          ) {
            throw asfDeliveryStateError(
              `ASF provider budget settlement ${reservationId} is incomplete`,
              input.binding.runId,
            );
          }
          // The linked lifecycle observation did not prove provider-call
          // non-application. Its full cap is already conservatively charged,
          // so this exact replay becomes a durable no-op denial.
          return {
            status: "exhausted",
            reason: "cost-limit",
            observationDigest: existing.settlementDigest,
          } as const;
        }
        const usage = this.#asfProviderBudgetUsage(input.binding.runId, policy);
        const ordinal = (
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM asf_provider_budget_reservations
               WHERE run_id = ? AND status <> 'denied'
                 AND (created_at < ? OR (created_at = ? AND reservation_id <= ?))`,
            )
            .get(
              input.binding.runId,
              existing.createdAt,
              existing.createdAt,
              reservationId,
            ) as { count: number }
        ).count;
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
          throw asfDeliveryStateError(
            `ASF provider budget reservation ${reservationId} has no valid invocation ordinal`,
            input.binding.runId,
          );
        }
        return {
          status: "reserved",
          reservationId,
          reservationDigest: existing.reservationDigest,
          authorization: "reconcile-only",
          acceptedAt: policy.acceptedAt,
          deadlineAt: policy.deadlineAt,
          remainingWallMs: Math.max(
            0,
            Date.parse(policy.deadlineAt) - this.#clock.now().getTime(),
          ),
          reservedCostMicros: 0,
          invocationOrdinal: ordinal,
          maxAgentInvocations: usage.maxAgentInvocations,
        } as const;
      }

      if (asfPhaseFreezesExternalAuthority(run.state)) {
        throw asfDeliveryStateError(
          `ASF phase ${run.state} forbids a new provider reservation for ` +
            input.binding.runId,
          input.binding.runId,
        );
      }

      if (
        this.getAsfTerminalEvidencePlanRecord(input.binding.runId) !== undefined
      ) {
        this.getAsfTerminalEvidencePlan(input.binding.runId);
        throw asfDeliveryStateError(
          `immutable terminal cleanup plan forbids a new provider reservation for ` +
            input.binding.runId,
          input.binding.runId,
        );
      }

      const usage = this.#asfProviderBudgetUsage(input.binding.runId, policy);
      const createdAt = this.#clock.now().toISOString();
      const deadlineExpired =
        Date.parse(createdAt) >= Date.parse(policy.deadlineAt);
      const availableCost = policy.maxCostMicros - usage.conservativeCostMicros;
      const reason: AsfProviderBudgetExhaustionReason | undefined =
        deadlineExpired
          ? "wall-deadline"
          : usage.invocationCount >= policy.maxAgentInvocations
            ? "invocation-limit"
            : availableCost <= 0
              ? "cost-limit"
              : undefined;
      const reservedCostMicros =
        reason === undefined ? Math.max(0, availableCost) : 0;
      const material = asfBudgetReservationMaterial({
        reservationId,
        effectKey: input.effectKey,
        intentId: input.intentId,
        intentDigest: input.intentDigest,
        runId: input.binding.runId,
        workOrderId: input.binding.workOrderId,
        attemptId: input.binding.attemptId,
        policyDigest: input.binding.policyDigest,
        initialGeneration: input.intentGeneration,
        lifecycleCandidateSha: input.binding.candidateSha,
        providerCandidateSha: input.providerCandidateSha,
        role: input.role,
        invocationId: input.invocationId,
        reservedCostMicros,
        maxCostMicros: policy.maxCostMicros,
        maxAgentInvocations: policy.maxAgentInvocations,
        acceptedAt: policy.acceptedAt,
        deadlineAt: policy.deadlineAt,
        createdAt,
      });
      const reservationDigest = sha256Digest(material);
      const denialObservationDigest =
        reason === undefined
          ? null
          : sha256Digest({
              schema: "asf.provider-budget-denial/v1",
              reservation_digest: reservationDigest,
              reason,
              conservative_cost_micros: usage.conservativeCostMicros,
              invocation_count: usage.invocationCount,
              denied_at: createdAt,
            });
      this.#db
        .prepare(
          `INSERT INTO asf_provider_budget_reservations(
             reservation_id, reservation_digest, effect_key, intent_id, intent_digest,
             run_id, work_order_id, attempt_id, policy_digest, initial_generation,
             lifecycle_candidate_sha, provider_candidate_sha, role, invocation_id,
             reserved_cost_micros, max_cost_micros, max_agent_invocations,
             accepted_at, deadline_at, status, denial_reason,
             denial_observation_digest, created_at, completed_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          reservationId,
          reservationDigest,
          input.effectKey,
          input.intentId,
          input.intentDigest,
          input.binding.runId,
          input.binding.workOrderId,
          input.binding.attemptId,
          input.binding.policyDigest,
          input.intentGeneration,
          input.binding.candidateSha,
          input.providerCandidateSha,
          input.role,
          input.invocationId,
          reservedCostMicros,
          policy.maxCostMicros,
          policy.maxAgentInvocations,
          policy.acceptedAt,
          policy.deadlineAt,
          reason === undefined ? "reserved" : "denied",
          reason ?? null,
          denialObservationDigest,
          createdAt,
          reason === undefined ? null : createdAt,
        );
      if (reason !== undefined && denialObservationDigest !== null) {
        return {
          status: "exhausted",
          reason,
          observationDigest: denialObservationDigest,
        } as const;
      }
      return {
        status: "reserved",
        reservationId,
        reservationDigest,
        authorization:
          input.intentMode === "observe-before-apply"
            ? "invoke"
            : "reconcile-only",
        acceptedAt: policy.acceptedAt,
        deadlineAt: policy.deadlineAt,
        remainingWallMs: Math.max(
          0,
          Date.parse(policy.deadlineAt) - Date.parse(createdAt),
        ),
        reservedCostMicros,
        invocationOrdinal: usage.invocationCount + 1,
        maxAgentInvocations: policy.maxAgentInvocations,
      } as const;
    });
    return transaction.immediate();
  }

  completeAsfProviderBudget(input: {
    readonly ownerId: string;
    readonly binding: StateAsfBudgetBinding;
    readonly reservationId: string;
    readonly reservationDigest: string;
    readonly effectKey: string;
    readonly intentId: string;
    readonly intentDigest: string;
    readonly role: AsfProviderBudgetRole;
    readonly invocationId: string;
    readonly providerCandidateSha: string;
    readonly providerResultDigest: string;
    readonly provider: string;
    readonly model: string;
    readonly principal: string;
    readonly profile: string;
    readonly actualCostMicros: number;
    readonly limits: StateAsfBudgetLimits;
  }): AsfProviderBudgetCompletion {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(input.reservationId) ||
      !ASF_DELIVERY_DIGEST.test(input.reservationDigest) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.effectKey) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.intentId) ||
      !ASF_DELIVERY_DIGEST.test(input.intentDigest) ||
      !ASF_PROVIDER_BUDGET_ROLES.includes(input.role) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.invocationId) ||
      !ASF_DELIVERY_GIT_SHA.test(input.providerCandidateSha) ||
      !ASF_DELIVERY_DIGEST.test(input.providerResultDigest) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.provider) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.model) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.principal) ||
      !ASF_DELIVERY_IDENTIFIER.test(input.profile) ||
      !Number.isSafeInteger(input.actualCostMicros) ||
      input.actualCostMicros < 0
    ) {
      throw asfDeliveryStateError(
        "ASF provider budget completion is malformed",
      );
    }
    const transaction = this.#db.transaction(() => {
      const { run, admission } = this.#assertCurrentAsfBudgetBinding(input);
      if (asfPhaseFreezesExternalAuthority(run.state)) {
        throw asfDeliveryStateError(
          `ASF phase ${run.state} forbids ordinary provider completion ${input.reservationId}`,
          input.binding.runId,
        );
      }
      const policy = this.#assertAsfBudgetLimits(admission, input.limits);
      const reservation = this.#db
        .prepare(
          `SELECT reservation_id AS reservationId, reservation_digest AS reservationDigest,
                  effect_key AS effectKey, intent_id AS intentId, intent_digest AS intentDigest,
                  run_id AS runId, work_order_id AS workOrderId, attempt_id AS attemptId,
                  policy_digest AS policyDigest, initial_generation AS initialGeneration,
                  completed_generation AS completedGeneration,
                  lifecycle_candidate_sha AS lifecycleCandidateSha,
                  provider_candidate_sha AS providerCandidateSha, role,
                  invocation_id AS invocationId, reserved_cost_micros AS reservedCostMicros,
                  actual_cost_micros AS actualCostMicros, max_cost_micros AS maxCostMicros,
                  max_agent_invocations AS maxAgentInvocations, accepted_at AS acceptedAt,
                  deadline_at AS deadlineAt, status, denial_reason AS denialReason,
                  denial_observation_digest AS denialObservationDigest,
                  provider_result_digest AS providerResultDigest, provider, model, principal, profile,
                  settlement_outcome AS settlementOutcome,
                  settlement_observation_digest AS settlementObservationDigest,
                  settlement_digest AS settlementDigest,
                  settlement_generation AS settlementGeneration,
                  settlement_at AS settlementAt,
                  created_at AS createdAt, completed_at AS completedAt
           FROM asf_provider_budget_reservations WHERE reservation_id = ?`,
        )
        .get(input.reservationId) as
        | AsfProviderBudgetReservationRecord
        | undefined;
      if (
        reservation === undefined ||
        reservation.reservationDigest !==
          sha256Digest(
            asfBudgetReservationMaterial({
              ...reservation,
              reservationId: reservation.reservationId,
            }),
          ) ||
        reservation.reservationDigest !== input.reservationDigest ||
        reservation.effectKey !== input.effectKey ||
        reservation.intentId !== input.intentId ||
        reservation.intentDigest !== input.intentDigest ||
        reservation.runId !== input.binding.runId ||
        reservation.workOrderId !== input.binding.workOrderId ||
        reservation.attemptId !== input.binding.attemptId ||
        reservation.policyDigest !== input.binding.policyDigest ||
        reservation.lifecycleCandidateSha !== input.binding.candidateSha ||
        reservation.providerCandidateSha !== input.providerCandidateSha ||
        reservation.role !== input.role ||
        reservation.invocationId !== input.invocationId ||
        reservation.initialGeneration > input.binding.fencingGeneration ||
        reservation.maxCostMicros !== policy.maxCostMicros ||
        reservation.maxAgentInvocations !== policy.maxAgentInvocations ||
        reservation.acceptedAt !== policy.acceptedAt ||
        reservation.deadlineAt !== policy.deadlineAt ||
        reservation.status === "denied"
      ) {
        throw asfDeliveryStateError(
          `ASF provider budget completion ${input.reservationId} is stale or contradictory`,
          input.binding.runId,
        );
      }
      if (reservation.status === "completed") {
        if (
          reservation.actualCostMicros !== input.actualCostMicros ||
          reservation.providerResultDigest !== input.providerResultDigest ||
          reservation.provider !== input.provider ||
          reservation.model !== input.model ||
          reservation.principal !== input.principal ||
          reservation.profile !== input.profile
        ) {
          throw asfDeliveryStateError(
            `ASF provider budget completion ${input.reservationId} conflicts with durable usage`,
            input.binding.runId,
          );
        }
      } else {
        const completedAt = this.#clock.now().toISOString();
        const updated = this.#db
          .prepare(
            `UPDATE asf_provider_budget_reservations
             SET status = 'completed', actual_cost_micros = ?, completed_generation = ?,
                 provider_result_digest = ?, provider = ?, model = ?, principal = ?, profile = ?,
                 completed_at = ?
             WHERE reservation_id = ? AND reservation_digest = ? AND status = 'reserved'`,
          )
          .run(
            input.actualCostMicros,
            input.binding.fencingGeneration,
            input.providerResultDigest,
            input.provider,
            input.model,
            input.principal,
            input.profile,
            completedAt,
            input.reservationId,
            input.reservationDigest,
          );
        if (updated.changes !== 1) {
          throw asfDeliveryStateError(
            `ASF provider budget completion ${input.reservationId} lost its durable reservation`,
            input.binding.runId,
          );
        }
      }
      const usage = this.#asfProviderBudgetUsage(input.binding.runId, policy);
      return {
        status: "completed",
        actualCostMicros: input.actualCostMicros,
        conservativeCostMicros: usage.conservativeCostMicros,
        invocationCount: usage.invocationCount,
        completedAfterDeadline:
          this.#clock.now().getTime() >= Date.parse(policy.deadlineAt),
        exceededReservedCost:
          input.actualCostMicros > reservation.reservedCostMicros,
      } as const;
    });
    return transaction.immediate();
  }

  static asfEffectKey(input: {
    readonly runId: string;
    readonly operation: AsfGitHubEffectOperation;
    readonly target: string;
    readonly candidateSha: string;
  }): string {
    return `effect_${sha256Digest({
      run_id: input.runId,
      system: "github",
      operation: input.operation,
      target: input.target,
      candidate_sha: input.candidateSha,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
  }

  /** Durable intent must commit under the current fence before any remote call. */
  intendAsfEffect(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly operation: AsfGitHubEffectOperation;
    readonly target: string;
    readonly correlationMarker: string;
    readonly candidateSha: string;
    readonly expectedRemoteSha?: string | null | undefined;
    readonly policyDigest: string;
  }): AsfEffectRow {
    if (!/^[a-f0-9]{40}$/u.test(input.candidateSha)) {
      throw new Error("ASF effect candidate must be a lower-case Git SHA");
    }
    if (
      input.expectedRemoteSha !== undefined &&
      input.expectedRemoteSha !== null &&
      !/^[a-f0-9]{40}$/u.test(input.expectedRemoteSha)
    ) {
      throw new Error(
        "ASF effect expected remote SHA must be null or a lower-case Git SHA",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.policyDigest)) {
      throw new Error(
        "ASF effect policy must be a tagged lower-case SHA-256 digest",
      );
    }
    if (
      input.target.trim() === "" ||
      input.target.length > 2_048 ||
      input.correlationMarker.trim() === "" ||
      input.correlationMarker.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(input.target + input.correlationMarker)
    ) {
      throw new Error(
        "ASF effect target and correlation marker must be bounded public text",
      );
    }
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(input.runId);
      const admission = this.getAsfAdmissionForRun(input.runId);
      if (
        run === undefined ||
        admission === undefined ||
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot record ` +
            `a GitHub effect for ${input.runId}`,
          runId: input.runId,
        });
      }
      if (asfPhaseFreezesExternalAuthority(run.state)) {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened: `ASF phase ${run.state} forbids GitHub effect authority for ${input.runId}`,
          runId: input.runId,
        });
      }
      if (
        run.candidateSha !== input.candidateSha ||
        admission.effectivePolicyDigest !== input.policyDigest
      ) {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened:
            `GitHub effect does not bind the current candidate and effective policy for ` +
            input.runId,
          runId: input.runId,
        });
      }
      const effectKey = StateStore.asfEffectKey(input);
      const intentDigest = sha256Digest({
        schema: "runmill.asf-effect-intent/v1",
        effect_key: effectKey,
        run_id: input.runId,
        system: "github",
        operation: input.operation,
        target: input.target,
        correlation_marker: input.correlationMarker,
        candidate_sha: input.candidateSha,
        expected_remote_sha: input.expectedRemoteSha ?? null,
        policy_digest: input.policyDigest,
      });
      const existing = this.getAsfEffect(effectKey);
      if (existing !== undefined) {
        if (
          existing.intentDigest !== intentDigest ||
          existing.correlationMarker !== input.correlationMarker
        ) {
          throw RunmillError.fromCatalog("RM-STATE-002", {
            whatHappened: `ASF effect key ${effectKey} is bound to contradictory intent`,
            runId: input.runId,
          });
        }
        return existing;
      }
      if (this.getAsfTerminalEvidencePlanRecord(input.runId) !== undefined) {
        this.getAsfTerminalEvidencePlan(input.runId);
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `immutable terminal cleanup plan forbids a new GitHub effect for ${input.runId}`,
          runId: input.runId,
        });
      }
      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO asf_effects(
             effect_key, run_id, generation, system, operation, target,
             correlation_marker, candidate_sha, expected_remote_sha,
             policy_digest, intent_digest,
             status, intended_at, updated_at
           ) VALUES (?,?,?,'github',?,?,?,?,?,?,?,'intended',?,?)`,
        )
        .run(
          effectKey,
          input.runId,
          input.generation,
          input.operation,
          input.target,
          input.correlationMarker,
          input.candidateSha,
          input.expectedRemoteSha ?? null,
          input.policyDigest,
          intentDigest,
          at,
          at,
        );
      const created = this.getAsfEffect(effectKey);
      if (created === undefined)
        throw new Error("recorded ASF effect intent disappeared");
      return created;
    });
    return transaction.immediate();
  }

  getAsfEffect(effectKey: string): AsfEffectRow | undefined {
    return this.#db
      .prepare(
        `SELECT effect_key AS effectKey, run_id AS runId, generation, system,
                operation, target, correlation_marker AS correlationMarker,
                candidate_sha AS candidateSha,
                expected_remote_sha AS expectedRemoteSha,
                policy_digest AS policyDigest,
                intent_digest AS intentDigest, status, remote_id AS remoteId,
                observation_digest AS observationDigest,
                retry_prohibited AS retryProhibited, intended_at AS intendedAt,
                updated_at AS updatedAt
         FROM asf_effects WHERE effect_key = ?`,
      )
      .get(effectKey) as AsfEffectRow | undefined;
  }

  listPendingAsfEffects(runId?: string): AsfEffectRow[] {
    const select = `SELECT effect_key AS effectKey, run_id AS runId, generation, system,
                           operation, target, correlation_marker AS correlationMarker,
                           candidate_sha AS candidateSha,
                           expected_remote_sha AS expectedRemoteSha,
                           policy_digest AS policyDigest,
                           intent_digest AS intentDigest, status, remote_id AS remoteId,
                           observation_digest AS observationDigest,
                           retry_prohibited AS retryProhibited, intended_at AS intendedAt,
                           updated_at AS updatedAt
                    FROM asf_effects
                    WHERE status IN ('intended', 'in_flight', 'ambiguous')`;
    return (
      runId === undefined
        ? this.#db.prepare(`${select} ORDER BY updated_at, effect_key`).all()
        : this.#db
            .prepare(`${select} AND run_id = ? ORDER BY updated_at, effect_key`)
            .all(runId)
    ) as AsfEffectRow[];
  }

  /** A mutation may start only from a fresh intent or exact not-applied observation. */
  beginAsfEffect(
    effectKey: string,
    ownerId: string,
    generation: number,
  ): AsfEffectRow {
    const transaction = this.#db.transaction(() => {
      const effect = this.getAsfEffect(effectKey);
      if (effect === undefined)
        throw new Error(`ASF effect ${effectKey} does not exist`);
      const run = this.getAsfRun(effect.runId);
      if (
        run === undefined ||
        run.ownerId !== ownerId ||
        run.generation !== generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened: `stale ASF worker ${ownerId} generation ${generation} cannot begin ${effectKey}`,
          runId: effect.runId,
        });
      }
      if (asfPhaseFreezesExternalAuthority(run.state)) {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened: `ASF phase ${run.state} forbids beginning GitHub effect ${effectKey}`,
          runId: effect.runId,
        });
      }
      if (this.getAsfTerminalEvidencePlanRecord(effect.runId) !== undefined) {
        this.getAsfTerminalEvidencePlan(effect.runId);
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `immutable terminal cleanup plan forbids beginning GitHub effect ${effectKey}`,
          runId: effect.runId,
        });
      }
      if (effect.status !== "intended" && effect.status !== "not_applied") {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened: `ASF effect ${effectKey} is ${effect.status}; observe it instead of retrying blindly`,
          runId: effect.runId,
        });
      }
      this.#db
        .prepare(
          `UPDATE asf_effects
           SET status = 'in_flight', generation = ?, updated_at = ?
           WHERE effect_key = ? AND status = ?`,
        )
        .run(
          generation,
          this.#clock.now().toISOString(),
          effectKey,
          effect.status,
        );
      const updated = this.getAsfEffect(effectKey);
      if (updated === undefined)
        throw new Error(`ASF effect ${effectKey} disappeared`);
      return updated;
    });
    return transaction.immediate();
  }

  recordAsfEffectObservation(input: {
    readonly effectKey: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly outcome: "confirmed" | "not_applied" | "ambiguous";
    readonly candidateSha: string;
    readonly detailsDigest: string;
    readonly observer: string;
    readonly remoteId?: string | undefined;
  }): AsfEffectObservationRow {
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.detailsDigest)) {
      throw new Error(
        "ASF effect observation requires a tagged SHA-256 details digest",
      );
    }
    const transaction = this.#db.transaction(() => {
      const effect = this.getAsfEffect(input.effectKey);
      if (effect === undefined)
        throw new Error(`ASF effect ${input.effectKey} does not exist`);
      const run = this.getAsfRun(effect.runId);
      if (
        run === undefined ||
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot observe ` +
            input.effectKey,
          runId: effect.runId,
        });
      }
      if (input.candidateSha !== effect.candidateSha) {
        throw RunmillError.fromCatalog("RM-STATE-002", {
          whatHappened:
            `observation candidate ${input.candidateSha} does not match effect candidate ` +
            effect.candidateSha,
          runId: effect.runId,
        });
      }
      const seq = (
        this.#db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
             FROM asf_effect_observations WHERE effect_key = ?`,
          )
          .get(input.effectKey) as { seq: number }
      ).seq;
      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO asf_effect_observations(
             effect_key, seq, outcome, candidate_sha, details_digest, observer, observed_at
           ) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          input.effectKey,
          seq,
          input.outcome,
          input.candidateSha,
          input.detailsDigest,
          input.observer,
          at,
        );
      this.#db
        .prepare(
          `UPDATE asf_effects
           SET status = ?, generation = ?, remote_id = COALESCE(?, remote_id),
               observation_digest = ?, retry_prohibited = ?, updated_at = ?
           WHERE effect_key = ?`,
        )
        .run(
          input.outcome,
          input.generation,
          input.remoteId ?? null,
          input.detailsDigest,
          input.outcome === "ambiguous" ? 1 : 0,
          at,
          input.effectKey,
        );
      if (input.outcome === "ambiguous") {
        this.#db
          .prepare(
            `UPDATE runs SET requires_reconciliation = 1, updated_at = ? WHERE run_id = ?`,
          )
          .run(at, effect.runId);
      }
      return {
        effectKey: input.effectKey,
        seq,
        outcome: input.outcome,
        candidateSha: input.candidateSha,
        detailsDigest: input.detailsDigest,
        observer: input.observer,
        observedAt: at,
      } as const;
    });
    return transaction.immediate();
  }

  asfEffectObservations(effectKey: string): AsfEffectObservationRow[] {
    return this.#db
      .prepare(
        `SELECT effect_key AS effectKey, seq, outcome,
                candidate_sha AS candidateSha, details_digest AS detailsDigest,
                observer, observed_at AS observedAt
         FROM asf_effect_observations WHERE effect_key = ? ORDER BY seq`,
      )
      .all(effectKey) as AsfEffectObservationRow[];
  }

  #canonicalAsfPendingSet(runId: string): CanonicalAsfPendingSetSnapshot {
    const github = this.#db
      .prepare(
        `SELECT effect_key AS effectKey, operation, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, intent_digest AS intentDigest
         FROM asf_effects
         WHERE run_id = ? AND status IN ('intended', 'in_flight', 'ambiguous')
         ORDER BY effect_key`,
      )
      .all(runId) as {
      effectKey: string;
      operation: string;
      candidateSha: string;
      policyDigest: string;
      intentDigest: string;
    }[];
    const delivery = this.#db
      .prepare(
        `SELECT effect_key AS effectKey, stage, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, intent_digest AS intentDigest,
                event_seq AS eventSeq
         FROM asf_delivery_stage_intents
         WHERE run_id = ? AND observation_outcome IS NULL
         ORDER BY effect_key`,
      )
      .all(runId) as {
      effectKey: string;
      stage: string;
      candidateSha: string | null;
      policyDigest: string;
      intentDigest: string;
      eventSeq: number;
    }[];
    const effects: CanonicalAsfPendingEffect[] = [
      ...github.map((effect) => ({
        effect_class: "github-effect" as const,
        effect_key: effect.effectKey,
        candidate_sha: effect.candidateSha,
        policy_digest: effect.policyDigest,
        intent_digest: effect.intentDigest,
        operation: effect.operation,
        event_seq: null,
      })),
      ...delivery.map((intent) => ({
        effect_class: "delivery-intent" as const,
        effect_key: intent.effectKey,
        candidate_sha: intent.candidateSha,
        policy_digest: intent.policyDigest,
        intent_digest: intent.intentDigest,
        operation: intent.stage,
        event_seq: intent.eventSeq,
      })),
    ].sort(
      (left, right) =>
        left.effect_class.localeCompare(right.effect_class) ||
        left.effect_key.localeCompare(right.effect_key),
    );
    if (effects.length > 100_000) {
      throw asfReconciliationStateError(
        `run ${runId} pending-effect set exceeds the durable safety bound`,
        runId,
      );
    }
    const value: CanonicalAsfPendingSet = {
      schema: "asf.pending-reconciliation-set/v2",
      run_id: runId,
      effects,
    };
    const canonical = canonicalJson(value as unknown as JsonValue);
    return {
      value,
      canonical,
      digest: sha256Digest(value as unknown as JsonValue),
      githubEffectCount: github.length,
      deliveryIntentCount: delivery.length,
    };
  }

  #asfPendingReconciliationCounts(runId: string): {
    readonly githubEffects: number;
    readonly deliveryIntents: number;
    readonly total: number;
  } {
    const githubEffects = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM asf_effects
           WHERE run_id = ? AND status IN ('intended', 'in_flight', 'ambiguous')`,
        )
        .get(runId) as { count: number }
    ).count;
    const deliveryIntents = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM asf_delivery_stage_intents
           WHERE run_id = ? AND observation_outcome IS NULL`,
        )
        .get(runId) as { count: number }
    ).count;
    return {
      githubEffects,
      deliveryIntents,
      total: githubEffects + deliveryIntents,
    };
  }

  getPendingAsfReconciliationRun(
    runId: string,
    maxPendingItems = 20_000,
  ): AsfPendingReconciliationPage["runs"][number] | undefined {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(runId) ||
      !Number.isSafeInteger(maxPendingItems) ||
      maxPendingItems < 1 ||
      maxPendingItems > 100_000
    ) {
      throw asfReconciliationStateError(
        "pending reconciliation lookup is malformed",
        runId,
      );
    }
    const run = this.#db
      .prepare("SELECT mode FROM runs WHERE run_id = ?")
      .get(runId) as { mode: string } | undefined;
    if (run?.mode !== "asf-worker") return undefined;
    const pending = this.#canonicalAsfPendingSet(runId);
    const total = pending.githubEffectCount + pending.deliveryIntentCount;
    if (total === 0) return undefined;
    if (total > maxPendingItems) {
      throw asfReconciliationStateError(
        `run ${runId} pending-effect set exceeds its protected bound`,
        runId,
      );
    }
    return {
      runId,
      pendingSetDigest: pending.digest,
      githubEffectCount: pending.githubEffectCount,
      deliveryIntentCount: pending.deliveryIntentCount,
    };
  }

  listPendingAsfDeliveryIntents(
    runId: string,
    limit = 20_000,
  ): StoredAsfDeliveryStageIntent[] {
    if (
      !ASF_DELIVERY_IDENTIFIER.test(runId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100_000
    ) {
      throw asfReconciliationStateError(
        "pending delivery-intent lookup is malformed",
        runId,
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT effect_key AS effectKey FROM asf_delivery_stage_intents
         WHERE run_id = ? AND observation_outcome IS NULL
         ORDER BY effect_key LIMIT ?`,
      )
      .all(runId, limit + 1) as { effectKey: string }[];
    if (rows.length > limit) {
      throw asfReconciliationStateError(
        `run ${runId} pending delivery-intent set exceeds its protected bound`,
        runId,
      );
    }
    return rows.map((row) => {
      const intent = this.getAsfDeliveryIntent(row.effectKey);
      if (intent === undefined) {
        throw asfReconciliationStateError(
          `pending delivery intent ${row.effectKey} disappeared`,
          runId,
        );
      }
      return intent;
    });
  }

  /**
   * Discover missing reconciliation requests from the two durable ASF effect
   * classes. Standalone runs are excluded in SQL, and each page plus each
   * per-run pending set is bounded before its identity digest is constructed.
   */
  discoverPendingAsfReconciliationRuns(input: {
    readonly afterRunId: string | null;
    readonly limit: number;
    readonly maxPendingItemsPerRun: number;
  }): AsfPendingReconciliationPage {
    if (
      (input.afterRunId !== null &&
        !ASF_DELIVERY_IDENTIFIER.test(input.afterRunId)) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000 ||
      !Number.isSafeInteger(input.maxPendingItemsPerRun) ||
      input.maxPendingItemsPerRun < 1 ||
      input.maxPendingItemsPerRun > 100_000
    ) {
      throw asfReconciliationStateError(
        "pending-effect discovery bounds or cursor are malformed",
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT r.run_id AS runId
         FROM runs r
         WHERE r.mode = 'asf-worker'
           AND (? IS NULL OR r.run_id > ?)
           AND (
             EXISTS (
               SELECT 1 FROM asf_effects e
               WHERE e.run_id = r.run_id
                 AND e.status IN ('intended', 'in_flight', 'ambiguous')
             )
             OR EXISTS (
               SELECT 1 FROM asf_delivery_stage_intents i
               WHERE i.run_id = r.run_id AND i.observation_outcome IS NULL
             )
           )
         ORDER BY r.run_id
         LIMIT ?`,
      )
      .all(input.afterRunId, input.afterRunId, input.limit) as {
      runId: string;
    }[];
    const runs = rows.map((row) => {
      const pending = this.#canonicalAsfPendingSet(row.runId);
      const total = pending.githubEffectCount + pending.deliveryIntentCount;
      if (total > input.maxPendingItemsPerRun) {
        throw asfReconciliationStateError(
          `run ${row.runId} pending-effect set exceeds its protected bound`,
          row.runId,
        );
      }
      if (total === 0) {
        throw asfReconciliationStateError(
          `run ${row.runId} disappeared from pending-effect discovery`,
          row.runId,
        );
      }
      if (!ASF_DELIVERY_IDENTIFIER.test(row.runId)) {
        throw asfReconciliationStateError(
          `run ${row.runId} has malformed pending-effect evidence`,
          row.runId,
        );
      }
      return {
        runId: row.runId,
        pendingSetDigest: pending.digest,
        githubEffectCount: pending.githubEffectCount,
        deliveryIntentCount: pending.deliveryIntentCount,
      };
    });
    return {
      runs,
      nextRunId:
        rows.length === input.limit ? (rows.at(-1)?.runId ?? null) : null,
    };
  }

  getAsfReconciliation(
    operationId: string,
  ): AsfReconciliationRecord | undefined {
    return this.#db
      .prepare(
        `SELECT operation_id AS operationId, run_id AS runId,
                request_digest AS requestDigest, requested_by AS requestedBy,
                requested_authority AS requestedAuthority, scope, status,
                generation, owner_id AS ownerId, requested_at AS requestedAt,
                started_at AS startedAt, completed_at AS completedAt,
                result_digest AS resultDigest,
                pending_set_digest AS pendingSetDigest,
                pending_github_effects AS pendingGithubEffects,
                pending_delivery_intents AS pendingDeliveryIntents,
                canonical_pending_set AS canonicalPendingSet,
                canonical_result AS canonicalResult,
                resumed_event_seq AS resumedEventSeq
         FROM asf_reconciliation_requests WHERE operation_id = ?`,
      )
      .get(operationId) as AsfReconciliationRecord | undefined;
  }

  /** Durably enqueue exact observation of this run's unresolved effects. */
  recordAsfReconciliationRequest(input: {
    readonly request: ReconciliationRequest;
    readonly requestDigest: string;
  }): ReconciliationRequestResult {
    const request = input.request;
    if (input.requestDigest !== sha256Digest(request)) {
      throw RunmillError.fromCatalog("RM-RECON-001", {
        whatHappened:
          "reconciliation request digest is internally contradictory",
        runId: request.run_id,
      });
    }
    const transaction = this.#db.transaction(() => {
      const existing = this.getAsfReconciliation(request.operation_id);
      if (existing !== undefined) {
        if (existing.requestDigest !== input.requestDigest) {
          throw RunmillError.fromCatalog("RM-RECON-001", {
            whatHappened: `reconciliation operation ${request.operation_id} is already bound to another request`,
            runId: existing.runId,
          });
        }
        return {
          operationId: existing.operationId,
          runId: existing.runId,
          disposition:
            existing.status === "completed" && existing.startedAt === null
              ? "nothing-to-reconcile"
              : "existing",
          status: existing.status,
          requestDigest: existing.requestDigest,
          requestedAt: existing.requestedAt,
        } as const;
      }
      const run = this.#db
        .prepare(
          `SELECT run_id AS runId, requires_reconciliation AS requiresReconciliation
           FROM runs WHERE run_id = ? AND mode = 'asf-worker'`,
        )
        .get(request.run_id) as
        | { runId: string; requiresReconciliation: 0 | 1 }
        | undefined;
      if (run === undefined) {
        throw RunmillError.fromCatalog("RM-RECON-001", {
          whatHappened: `reconciliation names unknown ASF run ${JSON.stringify(request.run_id)}`,
          runId: request.run_id,
        });
      }
      if (this.getAsfTerminalEvidencePlanRecord(request.run_id) !== undefined) {
        this.getAsfTerminalEvidencePlan(request.run_id);
        throw asfReconciliationStateError(
          "immutable terminal cleanup plan forbids a new reconciliation request",
          request.run_id,
        );
      }
      const active = this.#db
        .prepare(
          `SELECT operation_id AS operationId
           FROM asf_reconciliation_requests
           WHERE run_id = ? AND status IN ('queued', 'running')`,
        )
        .get(request.run_id) as { operationId: string } | undefined;
      if (active !== undefined) {
        const activeRecord = this.getAsfReconciliation(active.operationId);
        if (activeRecord === undefined) {
          throw new Error(
            `active ASF reconciliation ${active.operationId} disappeared`,
          );
        }
        return {
          operationId: activeRecord.operationId,
          runId: activeRecord.runId,
          disposition: "existing",
          status: activeRecord.status,
          requestDigest: activeRecord.requestDigest,
          requestedAt: activeRecord.requestedAt,
        } as const;
      }
      const pending = this.#canonicalAsfPendingSet(request.run_id);
      const pendingTotal =
        pending.githubEffectCount + pending.deliveryIntentCount;
      if (pendingTotal === 0 && run.requiresReconciliation === 1) {
        throw RunmillError.fromCatalog("RM-RECON-001", {
          whatHappened: `run ${request.run_id} requires reconciliation but has no observable effect record`,
          runId: request.run_id,
        });
      }
      const requestedAt = this.#clock.now().toISOString();
      const status = pendingTotal === 0 ? "completed" : "queued";
      const emptyResult: AsfReconciliationResultEnvelope = {
        schema: "asf.reconciliation-result/v1",
        operation_id: request.operation_id,
        run_id: request.run_id,
        pending_set_digest: pending.digest,
        observations: [],
      };
      const canonicalResult =
        pendingTotal === 0
          ? canonicalJson(emptyResult as unknown as JsonValue)
          : null;
      const resultDigest =
        pendingTotal === 0
          ? sha256Digest(emptyResult as unknown as JsonValue)
          : null;
      this.#db
        .prepare(
          `INSERT INTO asf_reconciliation_requests(
             operation_id, run_id, request_digest, requested_by,
             requested_authority, scope, status, generation, owner_id,
             requested_at, started_at, completed_at, result_digest,
             pending_set_digest, pending_github_effects,
             pending_delivery_intents, canonical_pending_set, canonical_result
           ) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,NULL,?,?,?,?,?,?,?)`,
        )
        .run(
          request.operation_id,
          request.run_id,
          input.requestDigest,
          request.requested_by.subject,
          request.requested_by.authority,
          request.scope,
          status,
          requestedAt,
          pendingTotal === 0 ? requestedAt : null,
          resultDigest,
          pending.digest,
          pending.githubEffectCount,
          pending.deliveryIntentCount,
          pending.canonical,
          canonicalResult,
        );
      return {
        operationId: request.operation_id,
        runId: request.run_id,
        disposition: pendingTotal === 0 ? "nothing-to-reconcile" : "queued",
        status,
        requestDigest: input.requestDigest,
        requestedAt,
      } as const;
    });
    return transaction.immediate();
  }

  listRecoverableAsfReconciliations(input?: {
    readonly after: AsfReconciliationRecoveryCursor | null;
    readonly limit: number;
  }): AsfReconciliationRecord[] {
    if (
      input !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1_000 ||
        (input.after !== null &&
          (!ASF_DELIVERY_IDENTIFIER.test(input.after.operationId) ||
            !Number.isFinite(Date.parse(input.after.requestedAt)))))
    ) {
      throw asfReconciliationStateError(
        "reconciliation recovery cursor or bound is malformed",
      );
    }
    const select = `SELECT operation_id AS operationId, run_id AS runId,
                           request_digest AS requestDigest, requested_by AS requestedBy,
                           requested_authority AS requestedAuthority, scope, status,
                           generation, owner_id AS ownerId, requested_at AS requestedAt,
                           started_at AS startedAt, completed_at AS completedAt,
                           result_digest AS resultDigest,
                           pending_set_digest AS pendingSetDigest,
                           pending_github_effects AS pendingGithubEffects,
                           pending_delivery_intents AS pendingDeliveryIntents,
                           canonical_pending_set AS canonicalPendingSet,
                           canonical_result AS canonicalResult,
                           resumed_event_seq AS resumedEventSeq
                    FROM asf_reconciliation_requests
                    WHERE status IN ('queued', 'running')`;
    if (input === undefined) {
      return this.#db
        .prepare(`${select} ORDER BY requested_at, operation_id`)
        .all() as AsfReconciliationRecord[];
    }
    return this.#db
      .prepare(
        `${select}
         AND (? IS NULL OR requested_at > ? OR (requested_at = ? AND operation_id > ?))
         ORDER BY requested_at, operation_id
         LIMIT ?`,
      )
      .all(
        input.after?.requestedAt ?? null,
        input.after?.requestedAt ?? null,
        input.after?.requestedAt ?? null,
        input.after?.operationId ?? null,
        input.limit,
      ) as AsfReconciliationRecord[];
  }

  /**
   * Claim read-only reconciliation under the run's normal generation fence.
   * A live lifecycle owner is never displaced; a stale or unowned run gets a
   * new generation, including terminal runs with unresolved effects.
   */
  claimAsfReconciliation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly staleBefore: string;
  }):
    | { readonly runId: string; readonly generation: number }
    | null
    | undefined {
    const transaction = this.#db.transaction(() => {
      const operation = this.getAsfReconciliation(input.operationId);
      if (operation === undefined) {
        throw RunmillError.fromCatalog("RM-RECON-001", {
          whatHappened: `reconciliation operation ${input.operationId} does not exist`,
        });
      }
      if (operation.status === "completed" || operation.status === "blocked")
        return null;
      const run = this.#db
        .prepare(
          `SELECT generation, owner_id AS ownerId, heartbeat_at AS heartbeatAt
           FROM runs WHERE run_id = ? AND mode = 'asf-worker'`,
        )
        .get(operation.runId) as
        | {
            generation: number;
            ownerId: string | null;
            heartbeatAt: string | null;
          }
        | undefined;
      if (run === undefined) {
        throw new Error(
          `ASF reconciliation run ${operation.runId} disappeared`,
        );
      }
      if (
        this.getAsfTerminalEvidencePlanRecord(operation.runId) !== undefined
      ) {
        this.getAsfTerminalEvidencePlan(operation.runId);
        throw asfReconciliationStateError(
          "immutable terminal cleanup plan forbids a reconciliation ownership claim",
          operation.runId,
        );
      }
      if (
        run.ownerId !== null &&
        run.heartbeatAt !== null &&
        run.heartbeatAt >= input.staleBefore
      ) {
        return undefined;
      }
      const generation = run.generation + 1;
      const at = this.#clock.now().toISOString();
      const claimedRun = this.#db
        .prepare(
          `UPDATE runs SET generation = ?, owner_id = ?, heartbeat_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ?
             AND (owner_id IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
        )
        .run(
          generation,
          input.ownerId,
          at,
          at,
          operation.runId,
          run.generation,
          input.staleBefore,
        );
      if (claimedRun.changes !== 1) return undefined;
      const claimedOperation = this.#db
        .prepare(
          `UPDATE asf_reconciliation_requests
           SET status = 'running', generation = ?, owner_id = ?,
               started_at = COALESCE(started_at, ?)
           WHERE operation_id = ? AND status IN ('queued', 'running')`,
        )
        .run(generation, input.ownerId, at, input.operationId);
      if (claimedOperation.changes !== 1) {
        throw new Error(
          `ASF reconciliation ${input.operationId} changed while claiming`,
        );
      }
      return { runId: operation.runId, generation } as const;
    });
    return transaction.immediate();
  }

  recoverResolvedAsfReconciliationResult(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly generation: number;
  }): AsfReconciliationResultEnvelope | undefined {
    const operation = this.getAsfReconciliation(input.operationId);
    if (
      operation === undefined ||
      operation.status !== "running" ||
      operation.ownerId !== input.ownerId ||
      operation.generation !== input.generation
    ) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened:
          `stale reconciliation worker cannot recover ${input.operationId} at generation ` +
          input.generation,
        runId: operation?.runId,
      });
    }
    const run = this.getAsfRun(operation.runId);
    if (run?.ownerId !== input.ownerId || run.generation !== input.generation) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened: `run ownership changed while recovering ${input.operationId}`,
        runId: operation.runId,
      });
    }
    if (
      operation.pendingSetDigest === undefined ||
      operation.pendingSetDigest === null ||
      operation.canonicalPendingSet === undefined ||
      operation.canonicalPendingSet === null ||
      operation.pendingGithubEffects === undefined ||
      operation.pendingGithubEffects === null ||
      operation.pendingDeliveryIntents === undefined ||
      operation.pendingDeliveryIntents === null
    ) {
      throw asfReconciliationStateError(
        "running reconciliation has no immutable pending-set snapshot",
        operation.runId,
      );
    }
    let rawPending: unknown;
    try {
      rawPending = JSON.parse(operation.canonicalPendingSet) as unknown;
    } catch {
      throw asfReconciliationStateError(
        "durable reconciliation pending set is not JSON",
        operation.runId,
      );
    }
    if (
      typeof rawPending !== "object" ||
      rawPending === null ||
      Array.isArray(rawPending) ||
      canonicalJson(rawPending as JsonValue) !==
        operation.canonicalPendingSet ||
      sha256Digest(rawPending as JsonValue) !== operation.pendingSetDigest
    ) {
      throw asfReconciliationStateError(
        "durable reconciliation pending set failed content-addressed validation",
        operation.runId,
      );
    }
    const pending = rawPending as Partial<CanonicalAsfPendingSet>;
    if (
      pending.schema !== "asf.pending-reconciliation-set/v2" ||
      pending.run_id !== operation.runId ||
      !Array.isArray(pending.effects) ||
      pending.effects.length < 1 ||
      pending.effects.length > 100_000
    ) {
      throw asfReconciliationStateError(
        "durable reconciliation pending set has an unsupported shape",
        operation.runId,
      );
    }

    const observations: AsfReconciliationResultEnvelope["observations"][number][] =
      [];
    for (const rawEffect of pending.effects as readonly unknown[]) {
      if (
        typeof rawEffect !== "object" ||
        rawEffect === null ||
        Array.isArray(rawEffect)
      ) {
        throw asfReconciliationStateError(
          "durable reconciliation pending set contains malformed effect evidence",
          operation.runId,
        );
      }
      const effect = rawEffect as Partial<CanonicalAsfPendingEffect>;
      if (
        (effect.effect_class !== "github-effect" &&
          effect.effect_class !== "delivery-intent") ||
        typeof effect.effect_key !== "string"
      ) {
        throw asfReconciliationStateError(
          "durable reconciliation pending set contains unsupported effect evidence",
          operation.runId,
        );
      }
      let outcome: string | null | undefined;
      if (effect.effect_class === "github-effect") {
        outcome = (
          this.#db
            .prepare(
              "SELECT status FROM asf_effects WHERE effect_key = ? AND run_id = ?",
            )
            .get(effect.effect_key, operation.runId) as
            | { status: string }
            | undefined
        )?.status;
      } else {
        outcome = (
          this.#db
            .prepare(
              `SELECT observation_outcome AS outcome
               FROM asf_delivery_stage_intents WHERE effect_key = ? AND run_id = ?`,
            )
            .get(effect.effect_key, operation.runId) as
            | { outcome: string | null }
            | undefined
        )?.outcome;
      }
      if (outcome !== "confirmed" && outcome !== "not_applied") {
        if (
          outcome === "intended" ||
          outcome === "in_flight" ||
          outcome === "ambiguous" ||
          outcome === null
        ) {
          return undefined;
        }
        throw asfReconciliationStateError(
          "durable reconciliation effect ledger is missing or contradictory",
          operation.runId,
        );
      }
      observations.push({
        effect_class: effect.effect_class,
        effect_key: effect.effect_key,
        outcome,
      });
    }
    observations.sort(
      (left, right) =>
        left.effect_class.localeCompare(right.effect_class) ||
        left.effect_key.localeCompare(right.effect_key),
    );
    const result: AsfReconciliationResultEnvelope = {
      schema: "asf.reconciliation-result/v1",
      operation_id: operation.operationId,
      run_id: operation.runId,
      pending_set_digest: operation.pendingSetDigest,
      observations,
    };
    const resultDigest = sha256Digest(result as unknown as JsonValue);
    this.#validateAsfReconciliationResult({
      operation,
      result,
      resultDigest,
      pendingSetBinding: null,
    });
    return Object.freeze({
      ...result,
      observations: Object.freeze(
        result.observations.map((observation) =>
          Object.freeze({ ...observation }),
        ),
      ),
    });
  }

  #validateAsfReconciliationResult(input: {
    readonly operation: AsfReconciliationRecord;
    readonly result: AsfReconciliationResultEnvelope;
    readonly resultDigest: string;
    readonly pendingSetBinding?:
      | AsfReconciliationPendingSetBinding
      | null
      | undefined;
  }): {
    readonly canonical: string;
    readonly allConfirmed: boolean;
    readonly allResolved: boolean;
    readonly observations: readonly {
      readonly effectClass: "github-effect" | "delivery-intent";
      readonly effectKey: string;
      readonly outcome: "confirmed" | "not_applied" | "ambiguous";
    }[];
  } {
    const { operation, result } = input;
    const resultKeys = Object.keys(
      result as unknown as Record<string, unknown>,
    ).sort();
    if (
      resultKeys.join("\u0000") !==
        [
          "observations",
          "operation_id",
          "pending_set_digest",
          "run_id",
          "schema",
        ]
          .sort()
          .join("\u0000") ||
      result.schema !== "asf.reconciliation-result/v1" ||
      result.operation_id !== operation.operationId ||
      result.run_id !== operation.runId ||
      operation.pendingSetDigest === undefined ||
      operation.pendingSetDigest === null ||
      operation.canonicalPendingSet === undefined ||
      operation.canonicalPendingSet === null ||
      operation.pendingGithubEffects === undefined ||
      operation.pendingGithubEffects === null ||
      operation.pendingDeliveryIntents === undefined ||
      operation.pendingDeliveryIntents === null ||
      result.pending_set_digest !== operation.pendingSetDigest ||
      !Array.isArray(result.observations)
    ) {
      throw asfReconciliationStateError(
        "reconciliation result is not exact-bound to its durable pending set",
        operation.runId,
      );
    }
    if (
      input.pendingSetBinding !== undefined &&
      input.pendingSetBinding !== null &&
      (input.pendingSetBinding.pendingSetDigest !==
        operation.pendingSetDigest ||
        input.pendingSetBinding.githubEffectCount !==
          operation.pendingGithubEffects ||
        input.pendingSetBinding.deliveryIntentCount !==
          operation.pendingDeliveryIntents)
    ) {
      throw asfReconciliationStateError(
        "reconciliation result contradicts its claimed pending-set binding",
        operation.runId,
      );
    }

    let pendingRaw: unknown;
    try {
      pendingRaw = JSON.parse(operation.canonicalPendingSet) as unknown;
    } catch {
      throw asfReconciliationStateError(
        "durable reconciliation pending set is not canonical JSON",
        operation.runId,
      );
    }
    if (
      typeof pendingRaw !== "object" ||
      pendingRaw === null ||
      Array.isArray(pendingRaw) ||
      canonicalJson(pendingRaw as JsonValue) !==
        operation.canonicalPendingSet ||
      sha256Digest(pendingRaw as JsonValue) !== operation.pendingSetDigest
    ) {
      throw asfReconciliationStateError(
        "durable reconciliation pending set failed content-addressed validation",
        operation.runId,
      );
    }
    const pending = pendingRaw as Partial<CanonicalAsfPendingSet>;
    if (
      pending.schema !== "asf.pending-reconciliation-set/v2" ||
      pending.run_id !== operation.runId ||
      !Array.isArray(pending.effects)
    ) {
      throw asfReconciliationStateError(
        "durable reconciliation pending set has an unsupported shape",
        operation.runId,
      );
    }
    const expected = new Map<string, CanonicalAsfPendingEffect>();
    let githubCount = 0;
    let deliveryCount = 0;
    for (const rawEffect of pending.effects as readonly unknown[]) {
      if (
        typeof rawEffect !== "object" ||
        rawEffect === null ||
        Array.isArray(rawEffect)
      ) {
        throw asfReconciliationStateError(
          "durable reconciliation pending set contains malformed effect evidence",
          operation.runId,
        );
      }
      const effect = rawEffect as CanonicalAsfPendingEffect;
      const key = `${effect.effect_class}\u0000${effect.effect_key}`;
      if (
        (effect.effect_class !== "github-effect" &&
          effect.effect_class !== "delivery-intent") ||
        !ASF_DELIVERY_IDENTIFIER.test(effect.effect_key) ||
        !ASF_DELIVERY_DIGEST.test(effect.policy_digest) ||
        !ASF_DELIVERY_DIGEST.test(effect.intent_digest) ||
        expected.has(key)
      ) {
        throw asfReconciliationStateError(
          "durable reconciliation pending set contains contradictory effects",
          operation.runId,
        );
      }
      expected.set(key, effect);
      if (effect.effect_class === "github-effect") githubCount += 1;
      else deliveryCount += 1;
    }
    if (
      githubCount !== operation.pendingGithubEffects ||
      deliveryCount !== operation.pendingDeliveryIntents ||
      result.observations.length !== expected.size
    ) {
      throw asfReconciliationStateError(
        "reconciliation result does not cover the exact durable effect count",
        operation.runId,
      );
    }

    let priorKey: string | null = null;
    let allConfirmed = true;
    let allResolved = true;
    const validatedObservations: {
      effectClass: "github-effect" | "delivery-intent";
      effectKey: string;
      outcome: "confirmed" | "not_applied" | "ambiguous";
    }[] = [];
    for (const rawObservation of result.observations as readonly unknown[]) {
      if (
        typeof rawObservation !== "object" ||
        rawObservation === null ||
        Array.isArray(rawObservation)
      ) {
        throw asfReconciliationStateError(
          "reconciliation result contains malformed observation evidence",
          operation.runId,
        );
      }
      const observation = rawObservation as Record<string, unknown>;
      if (
        Object.keys(observation).sort().join("\u0000") !==
          ["effect_class", "effect_key", "outcome"].sort().join("\u0000") ||
        (observation["effect_class"] !== "github-effect" &&
          observation["effect_class"] !== "delivery-intent") ||
        typeof observation["effect_key"] !== "string" ||
        (observation["outcome"] !== "confirmed" &&
          observation["outcome"] !== "not_applied" &&
          observation["outcome"] !== "ambiguous")
      ) {
        throw asfReconciliationStateError(
          "reconciliation result observation has an unsupported shape",
          operation.runId,
        );
      }
      const key = `${observation["effect_class"]}\u0000${observation["effect_key"]}`;
      const pendingEffect = expected.get(key);
      if (
        pendingEffect === undefined ||
        (priorKey !== null && key <= priorKey)
      ) {
        throw asfReconciliationStateError(
          "reconciliation result observations are duplicate, unsorted, or unexpected",
          operation.runId,
        );
      }
      priorKey = key;
      const outcome = observation["outcome"];
      if (outcome !== "confirmed") allConfirmed = false;
      if (outcome === "ambiguous") allResolved = false;
      validatedObservations.push({
        effectClass: observation["effect_class"],
        effectKey: observation["effect_key"],
        outcome,
      });
      if (observation["effect_class"] === "github-effect") {
        const row = this.#db
          .prepare(
            `SELECT status, observation_digest AS observationDigest,
                    candidate_sha AS candidateSha, policy_digest AS policyDigest,
                    intent_digest AS intentDigest
             FROM asf_effects WHERE effect_key = ? AND run_id = ?`,
          )
          .get(observation["effect_key"], operation.runId) as
          | {
              status: string;
              observationDigest: string | null;
              candidateSha: string;
              policyDigest: string;
              intentDigest: string;
            }
          | undefined;
        if (
          row === undefined ||
          row.status !== outcome ||
          row.observationDigest === null ||
          !ASF_DELIVERY_DIGEST.test(row.observationDigest) ||
          row.candidateSha !== pendingEffect.candidate_sha ||
          row.policyDigest !== pendingEffect.policy_digest ||
          row.intentDigest !== pendingEffect.intent_digest
        ) {
          throw asfReconciliationStateError(
            "GitHub reconciliation result is not proven by the durable effect ledger",
            operation.runId,
          );
        }
      } else {
        const row = this.#db
          .prepare(
            `SELECT observation_outcome AS observationOutcome,
                    observation_digest AS observationDigest,
                    candidate_sha AS candidateSha, policy_digest AS policyDigest,
                    intent_digest AS intentDigest, event_seq AS eventSeq
             FROM asf_delivery_stage_intents WHERE effect_key = ? AND run_id = ?`,
          )
          .get(observation["effect_key"], operation.runId) as
          | {
              observationOutcome: string | null;
              observationDigest: string | null;
              candidateSha: string | null;
              policyDigest: string;
              intentDigest: string;
              eventSeq: number;
            }
          | undefined;
        if (
          row === undefined ||
          row.observationOutcome !== outcome ||
          row.observationDigest === null ||
          !ASF_DELIVERY_DIGEST.test(row.observationDigest) ||
          row.candidateSha !== pendingEffect.candidate_sha ||
          row.policyDigest !== pendingEffect.policy_digest ||
          row.intentDigest !== pendingEffect.intent_digest ||
          row.eventSeq !== pendingEffect.event_seq
        ) {
          throw asfReconciliationStateError(
            "delivery reconciliation result is not proven by the durable intent ledger",
            operation.runId,
          );
        }
      }
    }
    const canonical = canonicalJson(result as unknown as JsonValue);
    if (sha256Digest(result as unknown as JsonValue) !== input.resultDigest) {
      throw asfReconciliationStateError(
        "reconciliation result digest does not match its canonical evidence",
        operation.runId,
      );
    }
    return {
      canonical,
      allConfirmed,
      allResolved,
      observations: Object.freeze(validatedObservations),
    };
  }

  #providerBudgetSettlementDigestsForReconciliation(
    runId: string,
    observations: readonly {
      readonly effectClass: "github-effect" | "delivery-intent";
      readonly effectKey: string;
      readonly outcome: "confirmed" | "not_applied" | "ambiguous";
    }[],
  ): readonly string[] {
    const digests: string[] = [];
    for (const observation of observations) {
      if (
        observation.effectClass !== "delivery-intent" ||
        observation.outcome === "ambiguous"
      ) {
        continue;
      }
      const intent = this.getAsfDeliveryIntent(observation.effectKey);
      if (
        intent === undefined ||
        intent.run_id !== runId ||
        intent.observationOutcome !== observation.outcome
      ) {
        throw asfReconciliationStateError(
          `provider settlement source ${observation.effectKey} is not exact-bound to reconciliation`,
          runId,
        );
      }
      const digest = this.#settleResolvedAsfProviderBudgetForIntent(intent);
      if (digest !== null) digests.push(digest);
    }
    return Object.freeze([...new Set(digests)].sort());
  }

  #resumeResolvedAsfReconciliation(input: {
    readonly operation: AsfReconciliationRecord;
    readonly run: AsfRunRow;
    readonly resultDigest: string;
    readonly at: string;
    readonly observations: readonly {
      readonly effectClass: "github-effect" | "delivery-intent";
      readonly effectKey: string;
      readonly outcome: "confirmed" | "not_applied" | "ambiguous";
    }[];
  }): AsfDurableReconciliationContinuation | null {
    const { operation, run } = input;
    if (run.state !== "BLOCKED_EXTERNAL") return null;
    if (this.getAsfTerminalEvidencePlanRecord(run.runId) !== undefined) {
      this.getAsfTerminalEvidencePlan(run.runId);
      throw asfReconciliationStateError(
        "immutable terminal evidence already owns the next lifecycle event",
        run.runId,
      );
    }
    const pendingSetDigest = operation.pendingSetDigest;
    if (pendingSetDigest === undefined || pendingSetDigest === null)
      return null;
    const notApplied = input.observations.filter(
      (observation) => observation.outcome === "not_applied",
    );
    if (
      input.observations.some(
        (observation) => observation.outcome === "ambiguous",
      )
    ) {
      throw asfReconciliationStateError(
        "ambiguous reconciliation evidence cannot authorize continuation",
        run.runId,
      );
    }
    for (const observation of notApplied) {
      if (observation.effectClass === "github-effect") {
        const effect = this.getAsfEffect(observation.effectKey);
        if (
          effect === undefined ||
          (effect.operation !== "branch.push" &&
            effect.operation !== "pull_request.create")
        ) {
          throw asfReconciliationStateError(
            "not-applied GitHub effect has no operator-owned P0 replay policy",
            run.runId,
          );
        }
      } else {
        const intent = this.getAsfDeliveryIntent(observation.effectKey);
        if (
          intent === undefined ||
          !ASF_DELIVERY_INTENT_STAGES.has(intent.stage)
        ) {
          throw asfReconciliationStateError(
            "not-applied lifecycle intent has no operator-owned replay policy",
            run.runId,
          );
        }
      }
    }
    const admission = this.getAsfAdmissionForRun(run.runId);
    if (admission === undefined) {
      throw asfReconciliationStateError(
        "paused reconciliation run has no immutable admission",
        run.runId,
      );
    }
    const row = this.#db
      .prepare(
        `SELECT event_id AS eventId, schema, type, payload, phase,
                policy_digest AS policyDigest, at
         FROM events WHERE run_id = ? AND seq = ?`,
      )
      .get(run.runId, run.stateVersion) as
      | {
          eventId: string | null;
          schema: string | null;
          type: string;
          payload: string;
          phase: string | null;
          policyDigest: string | null;
          at: string;
        }
      | undefined;
    if (row === undefined) {
      throw asfReconciliationStateError(
        "paused run has no interruption event",
        run.runId,
      );
    }
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(row.payload) as unknown;
    } catch {
      throw asfReconciliationStateError(
        "paused run event is not JSON",
        run.runId,
      );
    }
    const blocked = parseRunEvent({
      schema: row.schema,
      event_id: row.eventId,
      run_id: run.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      seq: run.stateVersion,
      occurred_at: row.at,
      type: row.type,
      phase: row.phase,
      payload: rawPayload,
      policy_digest: row.policyDigest,
    });
    const continuation = blocked.payload["continuation"];
    if (blocked.type !== "run.blocked_external" || continuation === undefined)
      return null;
    if (
      blocked.payload["code"] !== "INTERNAL_DELIVERY_FAILURE" &&
      blocked.payload["code"] !== "INTERNAL_WORKER_RECONCILIATION_REQUIRED" &&
      blocked.payload["code"] !== "CLEANUP_RECONCILIATION_REQUIRED"
    ) {
      throw asfReconciliationStateError(
        "paused run carries automatic continuation on an ineligible stop",
        run.runId,
      );
    }
    if (
      typeof continuation !== "object" ||
      continuation === null ||
      Array.isArray(continuation)
    ) {
      throw asfReconciliationStateError(
        "paused run continuation is malformed",
        run.runId,
      );
    }
    const binding = continuation as Record<string, unknown>;
    const resumePhase = RUN_EVENT_PHASES.find(
      (phase) => phase === binding["resume_phase"],
    );
    const interruptedEventSeq = binding["interrupted_event_seq"];
    const checkpointDigest = binding["checkpoint_digest"];
    const cancellationEventId = binding["cancellation_event_id"];
    const cancellationEventDigest = binding["cancellation_event_digest"];
    const cancellationRequestId = binding["cancellation_request_id"];
    const cancellationContinuation =
      blocked.payload["code"] === "CLEANUP_RECONCILIATION_REQUIRED";
    if (
      binding["schema"] !== "asf.reconciliation-continuation/v1" ||
      binding["disposition"] !==
        (cancellationContinuation
          ? "finish-cancellation"
          : "retry-interrupted-phase") ||
      binding["pending_set_digest"] !== pendingSetDigest ||
      typeof interruptedEventSeq !== "number" ||
      !Number.isSafeInteger(interruptedEventSeq) ||
      interruptedEventSeq < 1 ||
      interruptedEventSeq >= run.stateVersion ||
      typeof checkpointDigest !== "string" ||
      resumePhase === undefined ||
      (cancellationContinuation
        ? resumePhase !== "CANCELLING" ||
          typeof cancellationEventId !== "string" ||
          typeof cancellationEventDigest !== "string" ||
          typeof cancellationRequestId !== "string"
        : cancellationEventId !== undefined ||
          cancellationEventDigest !== undefined ||
          cancellationRequestId !== undefined)
    ) {
      throw asfReconciliationStateError(
        "paused run continuation is not an exact retry binding",
        run.runId,
      );
    }
    const interruption = this.#db
      .prepare(
        `SELECT event_id AS eventId, schema, type, payload, phase,
                policy_digest AS policyDigest, at FROM events
         WHERE run_id = ? AND seq = ?`,
      )
      .get(run.runId, interruptedEventSeq) as
      | {
          eventId: string | null;
          schema: string | null;
          type: string;
          payload: string;
          phase: string | null;
          policyDigest: string | null;
          at: string;
        }
      | undefined;
    const checkpointRow = this.#db
      .prepare(
        `SELECT checkpoint_id AS checkpointId FROM asf_checkpoints
         WHERE run_id = ? AND checkpoint_digest = ?`,
      )
      .get(run.runId, checkpointDigest) as { checkpointId: string } | undefined;
    const checkpoint =
      checkpointRow === undefined
        ? undefined
        : this.getAsfCheckpoint(checkpointRow.checkpointId);
    const resumeState = this.#db
      .prepare("SELECT resume_phase AS resumePhase FROM runs WHERE run_id = ?")
      .get(run.runId) as { resumePhase: string | null } | undefined;
    let cancellationExact = !cancellationContinuation;
    if (
      cancellationContinuation &&
      interruption !== undefined &&
      typeof cancellationEventId === "string" &&
      typeof cancellationEventDigest === "string" &&
      typeof cancellationRequestId === "string"
    ) {
      const cancellationRow = this.#db
        .prepare(
          `SELECT event_id AS eventId, schema, type, payload, phase,
                  policy_digest AS policyDigest, at, seq
           FROM events WHERE run_id = ? AND event_id = ?`,
        )
        .get(run.runId, cancellationEventId) as
        | {
            eventId: string | null;
            schema: string | null;
            type: string;
            payload: string;
            phase: string | null;
            policyDigest: string | null;
            at: string;
            seq: number;
          }
        | undefined;
      try {
        const cancellationEvent =
          cancellationRow === undefined
            ? undefined
            : parseRunEvent({
                schema: cancellationRow.schema,
                event_id: cancellationRow.eventId,
                run_id: run.runId,
                work_order_id: admission.workOrderId,
                attempt_id: admission.attemptId,
                seq: cancellationRow.seq,
                occurred_at: cancellationRow.at,
                type: cancellationRow.type,
                phase: cancellationRow.phase,
                payload: JSON.parse(cancellationRow.payload) as unknown,
                policy_digest: cancellationRow.policyDigest,
              });
        const interruptedEvent = parseRunEvent({
          schema: interruption.schema,
          event_id: interruption.eventId,
          run_id: run.runId,
          work_order_id: admission.workOrderId,
          attempt_id: admission.attemptId,
          seq: interruptedEventSeq,
          occurred_at: interruption.at,
          type: interruption.type,
          phase: interruption.phase,
          payload: JSON.parse(interruption.payload) as unknown,
          policy_digest: interruption.policyDigest,
        });
        cancellationExact =
          cancellationEvent !== undefined &&
          (cancellationEvent.type === "cancellation.requested" ||
            cancellationEvent.type === "cancellation.escalated") &&
          cancellationEvent.payload["request_id"] === cancellationRequestId &&
          sha256Digest(cancellationEvent) === cancellationEventDigest &&
          interruptedEvent.type === "cancellation.started" &&
          interruptedEvent.phase === "CANCELLING" &&
          interruptedEvent.payload["request_id"] === cancellationRequestId;
      } catch {
        cancellationExact = false;
      }
    }
    if (
      resumePhase !== resumeState?.resumePhase ||
      interruption?.phase !== resumePhase ||
      interruption.policyDigest !== admission.effectivePolicyDigest ||
      !cancellationExact ||
      checkpoint === undefined ||
      checkpoint.checkpoint_digest !== checkpointDigest ||
      checkpoint.run_id !== run.runId ||
      checkpoint.work_order_id !== admission.workOrderId ||
      checkpoint.attempt_id !== admission.attemptId ||
      checkpoint.policy_digest !== admission.effectivePolicyDigest ||
      checkpoint.candidate_sha !== run.candidateSha ||
      checkpoint.event_seq > interruptedEventSeq
    ) {
      throw asfReconciliationStateError(
        "paused run continuation does not match its exact event, checkpoint, and policy",
        run.runId,
      );
    }
    if (!cancellationContinuation) {
      assertRunPhaseTransition("BLOCKED_EXTERNAL", resumePhase);
    }
    const seq = run.stateVersion + 1;
    const action = cancellationContinuation
      ? ("continue-cancellation" as const)
      : notApplied.length === 0
        ? ("continue-confirmed" as const)
        : ("replay-not-applied" as const);
    const providerBudgetSettlementDigests =
      this.#providerBudgetSettlementDigestsForReconciliation(
        run.runId,
        input.observations,
      );
    const reconciliationBinding = {
      schema: "asf.reconciliation-continuation-result/v1",
      operation_id: operation.operationId,
      result_digest: input.resultDigest,
      pending_set_digest: pendingSetDigest,
      checkpoint_digest: checkpoint.checkpoint_digest,
      blocked_event_id: blocked.event_id,
      interrupted_event_seq: interruptedEventSeq,
      provider_budget_settlement_digests: providerBudgetSettlementDigests,
      action,
    } as const;
    const evidenceDigest = sha256Digest({
      schema: reconciliationBinding.schema,
      run_id: run.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      policy_digest: admission.effectivePolicyDigest,
      candidate_sha: run.candidateSha,
      resume_phase: resumePhase,
      reconciliation: reconciliationBinding,
    });
    const event = parseRunEvent({
      schema: "asf.run-event/v1",
      event_id: `evt_${createHash("sha256")
        .update(`${run.runId}:${seq}:run.resumed`)
        .digest("hex")
        .slice(0, 26)}`,
      run_id: run.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      seq,
      occurred_at: input.at,
      type: "run.resumed",
      phase: resumePhase,
      payload: {
        interrupted_phase: "BLOCKED_EXTERNAL",
        resume_phase: resumePhase,
        evidence_digest: evidenceDigest,
        ...(run.candidateSha === null
          ? {}
          : { candidate_sha: run.candidateSha }),
        reconciliation: reconciliationBinding,
      },
      policy_digest: admission.effectivePolicyDigest,
    });
    assertRunEventTransition("BLOCKED_EXTERNAL", event);
    const updated = this.#db
      .prepare(
        `UPDATE runs
         SET state = ?, state_version = state_version + 1, resume_phase = NULL,
             requires_reconciliation = 0, updated_at = ?, heartbeat_at = ?
         WHERE run_id = ? AND mode = 'asf-worker' AND state = 'BLOCKED_EXTERNAL'
           AND state_version = ? AND owner_id = ? AND generation = ?
           AND candidate_sha IS ?`,
      )
      .run(
        resumePhase,
        input.at,
        input.at,
        run.runId,
        run.stateVersion,
        run.ownerId,
        run.generation,
        run.candidateSha,
      );
    if (updated.changes !== 1) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened:
          "paused run changed before atomic reconciliation continuation",
        runId: run.runId,
      });
    }
    this.#db
      .prepare(
        `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
         VALUES (?,?,'BLOCKED_EXTERNAL',?,
                 ?,
                 'reconciliation-controller',?)`,
      )
      .run(
        run.runId,
        seq,
        resumePhase,
        action === "continue-cancellation"
          ? "exact reconciliation resolved cancellation effects and authorized cleanup"
          : action === "continue-confirmed"
            ? "exact reconciliation confirmed every interrupted effect"
            : "exact reconciliation proved absent effects and authorized one bounded replay",
        input.at,
      );
    this.#db
      .prepare(
        `INSERT INTO events(run_id, seq, type, payload, artifact_ref,
                            redaction_ruleset_version, at, event_id, schema, phase, policy_digest)
         VALUES (?,?,'run.resumed',?,NULL,'asf-public-v1',?,?,?,?,?)`,
      )
      .run(
        run.runId,
        seq,
        JSON.stringify(event.payload),
        event.occurred_at,
        event.event_id,
        event.schema,
        event.phase,
        event.policy_digest,
      );
    return {
      disposition: "run-resumed",
      runId: run.runId,
      operationId: operation.operationId,
      resumedEventSeq: seq,
      resumePhase,
      resultDigest: input.resultDigest,
    };
  }

  finishAsfReconciliation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly status: "completed" | "blocked";
    readonly resultDigest: string;
    readonly result?: AsfReconciliationResultEnvelope | undefined;
    readonly pendingSetBinding?:
      | AsfReconciliationPendingSetBinding
      | null
      | undefined;
  }): AsfReconciliationRecord {
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.resultDigest)) {
      throw new Error("ASF reconciliation result digest is malformed");
    }
    const transaction = this.#db.transaction(() => {
      const operation = this.getAsfReconciliation(input.operationId);
      if (
        operation === undefined ||
        operation.status !== "running" ||
        operation.ownerId !== input.ownerId ||
        operation.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale reconciliation worker cannot finish ${input.operationId} at generation ` +
            input.generation,
          runId: operation?.runId,
        });
      }
      const run = this.getAsfRun(operation.runId);
      if (
        run?.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened: `run ownership changed while finishing ${input.operationId}`,
          runId: operation.runId,
        });
      }
      if (this.getAsfTerminalEvidencePlanRecord(run.runId) !== undefined) {
        this.getAsfTerminalEvidencePlan(run.runId);
        throw asfReconciliationStateError(
          "immutable terminal evidence already owns the next lifecycle event",
          run.runId,
        );
      }
      const pending = this.#asfPendingReconciliationCounts(operation.runId);
      const status =
        input.status === "completed" && pending.total === 0
          ? "completed"
          : "blocked";
      const at = this.#clock.now().toISOString();
      const validatedResult =
        input.result === undefined
          ? undefined
          : this.#validateAsfReconciliationResult({
              operation,
              result: input.result,
              resultDigest: input.resultDigest,
              pendingSetBinding: input.pendingSetBinding,
            });
      if (status === "completed" && validatedResult === undefined) {
        // Digest-only legacy completion can clear a pending flag, but it
        // carries no authority to continue a paused lifecycle.
      }
      this.#db
        .prepare(
          `UPDATE asf_reconciliation_requests
           SET status = ?, completed_at = ?, result_digest = ?, canonical_result = ?
           WHERE operation_id = ?`,
        )
        .run(
          status,
          at,
          input.resultDigest,
          validatedResult?.canonical ?? null,
          input.operationId,
        );
      this.#db
        .prepare(
          `UPDATE runs SET requires_reconciliation = ?, updated_at = ? WHERE run_id = ?`,
        )
        .run(status === "completed" ? 0 : 1, at, operation.runId);
      const continuation =
        status === "completed" && validatedResult?.allResolved === true
          ? this.#resumeResolvedAsfReconciliation({
              operation,
              run,
              resultDigest: input.resultDigest,
              at,
              observations: validatedResult.observations,
            })
          : null;
      if (continuation !== null) {
        this.#db
          .prepare(
            `UPDATE asf_reconciliation_requests SET resumed_event_seq = ?
             WHERE operation_id = ? AND status = 'completed'`,
          )
          .run(continuation.resumedEventSeq, input.operationId);
      }
      const finished = this.getAsfReconciliation(input.operationId);
      if (finished === undefined)
        throw new Error("finished ASF reconciliation disappeared");
      return { ...finished, continuation };
    });
    return transaction.immediate();
  }

  #candidateLineageDigestForCheckpoint(input: {
    readonly runId: string;
    readonly candidateSha: string | null;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): string {
    if (input.candidateSha === null) {
      return sha256Digest({ run_id: input.runId, candidate_sha: null });
    }
    if (input.eventType === "candidate.created") {
      const candidateSha = input.payload["candidate_sha"];
      const parentSha = input.payload["parent_sha"];
      const treeDigest = input.payload["tree_digest"];
      if (
        candidateSha !== input.candidateSha ||
        typeof parentSha !== "string" ||
        typeof treeDigest !== "string"
      ) {
        throw new Error(
          "candidate checkpoint lacks exact durable lineage evidence",
        );
      }
      return sha256Digest({
        candidate_sha: candidateSha,
        parent_sha: parentSha,
        tree_digest: treeDigest,
      });
    }

    const prior = this.#db
      .prepare(
        `SELECT canonical_checkpoint AS canonicalCheckpoint
         FROM asf_checkpoints
         WHERE run_id = ? AND candidate_sha = ?
         ORDER BY event_seq DESC, recorded_at DESC, checkpoint_id DESC LIMIT 1`,
      )
      .get(input.runId, input.candidateSha) as
      | { canonicalCheckpoint: string }
      | undefined;
    if (prior !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(prior.canonicalCheckpoint) as unknown;
      } catch {
        throw new Error(
          `candidate ${input.candidateSha} checkpoint lineage is not JSON`,
        );
      }
      const checkpoint = parseDurableAsfCheckpoint(raw);
      if (
        checkpoint.run_id !== input.runId ||
        checkpoint.candidate_sha !== input.candidateSha
      ) {
        throw new Error(
          `candidate ${input.candidateSha} checkpoint lineage is contradictory`,
        );
      }
      return checkpoint.candidate_lineage_digest;
    }

    // Forward migration compatibility: an older run can have its immutable
    // candidate event but predate atomic checkpoints. Reconstruct only from
    // that exact durable event; missing/compacted/malformed lineage fails shut.
    const candidateEvent = this.#db
      .prepare(
        `SELECT payload FROM events
         WHERE run_id = ? AND type = 'candidate.created'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(input.runId) as { payload: string } | undefined;
    let payload: unknown;
    try {
      payload =
        candidateEvent === undefined
          ? undefined
          : (JSON.parse(candidateEvent.payload) as unknown);
    } catch {
      throw new Error(
        `candidate ${input.candidateSha} event lineage is not JSON`,
      );
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error(
        `candidate ${input.candidateSha} has no durable checkpoint lineage`,
      );
    }
    const eventPayload = payload as Record<string, unknown>;
    if (
      eventPayload["candidate_sha"] !== input.candidateSha ||
      typeof eventPayload["parent_sha"] !== "string" ||
      typeof eventPayload["tree_digest"] !== "string"
    ) {
      throw new Error(
        `candidate ${input.candidateSha} event lineage is contradictory`,
      );
    }
    return sha256Digest({
      candidate_sha: input.candidateSha,
      parent_sha: eventPayload["parent_sha"],
      tree_digest: eventPayload["tree_digest"],
    });
  }

  #createAsfBoundCheckpoint(input: {
    readonly runId: string;
    readonly workOrderId: string;
    readonly attemptId: string;
    readonly policyDigest: string;
    readonly phase: RunEventPhase;
    readonly eventSeq: number;
    readonly generation: number;
    readonly candidateSha: string | null;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly at: string;
    readonly material: AsfAtomicCheckpointInput;
  }): DurableAsfCheckpoint {
    const policy = getAsfCheckpointRecoveryPolicy(input.material.kind);
    return createDurableAsfCheckpoint({
      schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
      checkpoint_id:
        `cp_${String(policy.number).padStart(2, "0")}_` +
        sha256Digest({
          run_id: input.runId,
          event_seq: input.eventSeq,
          generation: input.generation,
          kind: input.material.kind,
        }).slice("sha256:".length, "sha256:".length + 32),
      checkpoint_kind: input.material.kind,
      run_id: input.runId,
      work_order_id: input.workOrderId,
      attempt_id: input.attemptId,
      phase: input.phase,
      event_seq: input.eventSeq,
      fencing_generation: input.generation,
      policy_digest: input.policyDigest,
      candidate_sha: input.candidateSha,
      candidate_lineage_digest: this.#candidateLineageDigestForCheckpoint({
        runId: input.runId,
        candidateSha: input.candidateSha,
        eventType: input.eventType,
        payload: input.payload,
      }),
      durable_inputs_digest: sha256Digest(input.material.durableInputs),
      durable_outputs_digest: sha256Digest(input.material.durableOutputs),
      replay_policy: policy.replayPolicy,
      reconciliation_markers: policy.reconciliationBeforeReplay.map(
        (observation) => ({
          observation,
          correlation_marker:
            input.material.correlationMarker ??
            `checkpoint:${input.runId}:${input.material.kind}:${input.eventSeq}`,
        }),
      ),
      protected_implementer_resume:
        input.material.protectedImplementerResume ?? null,
      created_at: input.at,
    });
  }

  #insertAsfCheckpoint(
    checkpoint: DurableAsfCheckpoint,
    canonicalCheckpoint: string,
    recordedAt: string,
  ): { readonly checkpoint: AsfCheckpointRecord; readonly created: boolean } {
    const existing = this.getAsfCheckpointRecord(checkpoint.checkpoint_id);
    if (existing !== undefined) {
      if (
        existing.checkpointDigest !== checkpoint.checkpoint_digest ||
        existing.canonicalCheckpoint !== canonicalCheckpoint
      ) {
        throw new Error(
          `checkpoint id ${checkpoint.checkpoint_id} is already bound to another record`,
        );
      }
      return { checkpoint: existing, created: false } as const;
    }
    this.#db
      .prepare(
        `INSERT INTO asf_checkpoints(
           checkpoint_id, run_id, checkpoint_kind, phase, event_seq,
           fencing_generation, candidate_sha, policy_digest, checkpoint_digest,
           replay_policy, canonical_checkpoint, created_at, recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        checkpoint.checkpoint_id,
        checkpoint.run_id,
        checkpoint.checkpoint_kind,
        checkpoint.phase,
        checkpoint.event_seq,
        checkpoint.fencing_generation,
        checkpoint.candidate_sha,
        checkpoint.policy_digest,
        checkpoint.checkpoint_digest,
        checkpoint.replay_policy,
        canonicalCheckpoint,
        checkpoint.created_at,
        recordedAt,
      );
    const persisted = this.getAsfCheckpointRecord(checkpoint.checkpoint_id);
    if (persisted === undefined)
      throw new Error("recorded ASF checkpoint disappeared");
    return { checkpoint: persisted, created: true } as const;
  }

  getAsfCheckpointRecord(
    checkpointId: string,
  ): AsfCheckpointRecord | undefined {
    return this.#db
      .prepare(
        `SELECT checkpoint_id AS checkpointId, run_id AS runId,
                checkpoint_kind AS checkpointKind, phase, event_seq AS eventSeq,
                fencing_generation AS fencingGeneration,
                candidate_sha AS candidateSha, policy_digest AS policyDigest,
                checkpoint_digest AS checkpointDigest, replay_policy AS replayPolicy,
                canonical_checkpoint AS canonicalCheckpoint,
                created_at AS createdAt, recorded_at AS recordedAt
         FROM asf_checkpoints WHERE checkpoint_id = ?`,
      )
      .get(checkpointId) as AsfCheckpointRecord | undefined;
  }

  /** Persist protected checkpoint state only under the current run fence. */
  recordAsfCheckpoint(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly ownerId: string;
    readonly generation: number;
  }): { readonly checkpoint: AsfCheckpointRecord; readonly created: boolean } {
    const checkpoint = parseDurableAsfCheckpoint(input.checkpoint);
    const canonicalCheckpoint = canonicalJson(checkpoint);
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(checkpoint.run_id);
      const admission = this.getAsfAdmissionForRun(checkpoint.run_id);
      if (run === undefined || admission === undefined) {
        throw new Error(
          `checkpoint names unknown ASF run ${checkpoint.run_id}`,
        );
      }
      if (
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale worker ${input.ownerId} generation ${input.generation} cannot checkpoint ` +
            `${checkpoint.run_id}; current owner is ${run.ownerId ?? "<none>"} generation ` +
            run.generation,
          runId: checkpoint.run_id,
        });
      }
      if (
        this.getAsfTerminalEvidencePlanRecord(checkpoint.run_id) !== undefined
      ) {
        this.getAsfTerminalEvidencePlan(checkpoint.run_id);
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `immutable terminal cleanup plan forbids a standalone checkpoint for ` +
            checkpoint.run_id,
          runId: checkpoint.run_id,
        });
      }
      const event = this.#db
        .prepare(
          `SELECT phase, policy_digest AS policyDigest, at
           FROM events WHERE run_id = ? AND seq = ?`,
        )
        .get(checkpoint.run_id, checkpoint.event_seq) as
        | { phase: string | null; policyDigest: string | null; at: string }
        | undefined;
      if (
        checkpoint.work_order_id !== admission.workOrderId ||
        checkpoint.attempt_id !== admission.attemptId ||
        checkpoint.policy_digest !== admission.effectivePolicyDigest ||
        checkpoint.fencing_generation !== input.generation ||
        checkpoint.event_seq !== run.stateVersion ||
        checkpoint.phase !== run.state ||
        checkpoint.candidate_sha !== run.candidateSha ||
        event === undefined ||
        event.phase !== checkpoint.phase ||
        event.policyDigest !== checkpoint.policy_digest ||
        Date.parse(checkpoint.created_at) < Date.parse(event?.at ?? "") ||
        Date.parse(checkpoint.created_at) > this.#clock.now().getTime()
      ) {
        throw new Error(
          `checkpoint ${checkpoint.checkpoint_id} does not bind the current run, event, ` +
            `generation, candidate, policy, and Work Order`,
        );
      }
      const recordedAt = this.#clock.now().toISOString();
      return this.#insertAsfCheckpoint(
        checkpoint,
        canonicalCheckpoint,
        recordedAt,
      );
    });
    return transaction.immediate();
  }

  getAsfCheckpoint(checkpointId: string): DurableAsfCheckpoint | undefined {
    const record = this.getAsfCheckpointRecord(checkpointId);
    if (record === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(record.canonicalCheckpoint) as unknown;
    } catch {
      throw new Error(`stored ASF checkpoint ${checkpointId} is not JSON`);
    }
    const checkpoint = parseDurableAsfCheckpoint(raw);
    if (
      canonicalJson(checkpoint) !== record.canonicalCheckpoint ||
      checkpoint.checkpoint_id !== record.checkpointId ||
      checkpoint.run_id !== record.runId ||
      checkpoint.checkpoint_kind !== record.checkpointKind ||
      checkpoint.event_seq !== record.eventSeq ||
      checkpoint.fencing_generation !== record.fencingGeneration ||
      checkpoint.checkpoint_digest !== record.checkpointDigest
    ) {
      throw new Error(`stored ASF checkpoint ${checkpointId} is contradictory`);
    }
    return checkpoint;
  }

  getLatestAsfCheckpoint(runId: string): DurableAsfCheckpoint | undefined {
    const row = this.#db
      .prepare(
        `SELECT checkpoint_id AS checkpointId FROM asf_checkpoints
         WHERE run_id = ? ORDER BY event_seq DESC, recorded_at DESC, checkpoint_id DESC LIMIT 1`,
      )
      .get(runId) as { checkpointId: string } | undefined;
    return row === undefined
      ? undefined
      : this.getAsfCheckpoint(row.checkpointId);
  }

  listAsfCheckpointSummaries(
    runId: string,
    limit = 100,
  ): PublicAsfCheckpointSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error(
        "ASF checkpoint limit must be an integer from 1 through 1000",
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT checkpoint_id AS checkpointId FROM asf_checkpoints
         WHERE run_id = ? ORDER BY event_seq DESC, recorded_at DESC, checkpoint_id DESC LIMIT ?`,
      )
      .all(runId, limit) as { checkpointId: string }[];
    return rows.map((row) => {
      const checkpoint = this.getAsfCheckpoint(row.checkpointId);
      if (checkpoint === undefined)
        throw new Error(`checkpoint ${row.checkpointId} disappeared`);
      return publicAsfCheckpointSummary(checkpoint);
    });
  }

  /**
   * Persist independently validated, portable evidence before the lifecycle
   * claims EVIDENCE_FINALIZED. A retry may finish the transition; a crash can
   * never leave a finalized event without its immutable bundle.
   */
  recordAsfEvidenceBundle(input: {
    readonly validated: ArtifactVerifiedAsfEvidenceBundle;
    readonly ownerId: string;
    readonly generation: number;
  }): {
    readonly record: AsfEvidenceBundleRecord;
    readonly created: boolean;
  } {
    const { validated } = input;
    const bundle = signedAsfEvidenceBundleSchema.parse(validated.bundle);
    const canonicalEnvelope = canonicalJson(bundle);
    if (
      validated.bundleDigest !== bundle.bundle_digest ||
      validated.candidateSha !==
        bundle.statement.predicate.source.candidate_sha ||
      validated.signer.verified !== true ||
      validated.signer.keyId !== bundle.key_id ||
      validated.signer.algorithm !== bundle.algorithm ||
      validated.artifacts.verified !== true ||
      validated.artifacts.count !==
        bundle.statement.predicate.artifacts.length ||
      validated.artifacts.totalBytes !==
        bundle.statement.predicate.artifacts.reduce(
          (total, artifact) => total + artifact.size_bytes,
          0,
        ) ||
      validated.artifacts.manifestDigest !==
        sha256Digest(bundle.statement.predicate.artifacts)
    ) {
      throw RunmillError.fromCatalog("RM-EVID-008", {
        whatHappened: "validated evidence metadata is internally contradictory",
        runId: bundle.statement.predicate.run.run_id,
      });
    }
    const transaction = this.#db.transaction(() => {
      const runId = bundle.statement.predicate.run.run_id;
      const run = this.getAsfRun(runId);
      const admission = this.getAsfAdmissionForRun(runId);
      if (run === undefined || admission === undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `evidence names unknown ASF run ${JSON.stringify(runId)}`,
          runId,
        });
      }
      if (
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot finalize ` +
            `${runId}; current owner is ${run.ownerId ?? "<none>"} generation ${run.generation}`,
          runId,
        });
      }
      const predicate = bundle.statement.predicate;
      if (
        predicate.run.work_order_id !== admission.workOrderId ||
        predicate.run.attempt_id !== admission.attemptId ||
        predicate.work_order.payload_digest !== admission.payloadDigest ||
        predicate.work_order.envelope_digest !== admission.envelopeDigest ||
        predicate.policy.effective_policy_digest !==
          admission.effectivePolicyDigest ||
        predicate.source.candidate_sha !== run.candidateSha ||
        predicate.source.remote_head_sha !== run.candidateSha ||
        (run.state !== "PR_DELIVERED" && run.state !== "EVIDENCE_FINALIZED")
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `signed evidence does not bind the current delivered candidate, Work Order, attempt, ` +
            `policy, and envelope for ${runId}`,
          runId,
        });
      }
      const existing = this.getAsfEvidenceBundleRecord(runId);
      if (existing !== undefined) {
        if (
          existing.bundleDigest !== validated.bundleDigest ||
          existing.canonicalEnvelopeDigest !==
            canonicalEnvelopeDigest(canonicalEnvelope) ||
          existing.canonicalEnvelope !== canonicalEnvelope
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `run ${runId} already finalized immutable evidence ${existing.bundleDigest}`,
            runId,
          });
        }
        return { record: existing, created: false } as const;
      }
      if (this.getAsfTerminalEvidencePlanRecord(runId) !== undefined) {
        this.getAsfTerminalEvidencePlan(runId);
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `immutable terminal cleanup plan forbids new delivery evidence for ${runId}`,
          runId,
        });
      }
      this.#db
        .prepare(
          `INSERT INTO asf_evidence_bundles(
             run_id, candidate_sha, policy_digest, bundle_digest,
             canonical_envelope_digest, canonical_envelope, finalized_at
           ) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          runId,
          validated.candidateSha,
          admission.effectivePolicyDigest,
          validated.bundleDigest,
          canonicalEnvelopeDigest(canonicalEnvelope),
          canonicalEnvelope,
          bundle.issued_at,
        );
      const record = this.getAsfEvidenceBundleRecord(runId);
      if (record === undefined)
        throw new Error("recorded ASF evidence bundle disappeared");
      return { record, created: true } as const;
    });
    return transaction.immediate();
  }

  getAsfEvidenceBundleRecord(
    runId: string,
  ): AsfEvidenceBundleRecord | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, bundle_digest AS bundleDigest,
                canonical_envelope_digest AS canonicalEnvelopeDigest,
                canonical_envelope AS canonicalEnvelope, finalized_at AS finalizedAt
         FROM asf_evidence_bundles WHERE run_id = ?`,
      )
      .get(runId) as AsfEvidenceBundleRecord | undefined;
  }

  getAsfEvidenceBundle(runId: string): SignedAsfEvidenceBundle | undefined {
    const record = this.getAsfEvidenceBundleRecord(runId);
    if (record === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(record.canonicalEnvelope) as unknown;
    } catch {
      throw new Error(`stored ASF evidence for ${runId} is not JSON`);
    }
    const bundle = signedAsfEvidenceBundleSchema.parse(raw);
    const predicate = bundle.statement.predicate;
    if (
      record.canonicalEnvelopeDigest !==
        canonicalEnvelopeDigest(record.canonicalEnvelope) ||
      canonicalJson(bundle) !== record.canonicalEnvelope ||
      bundle.bundle_digest !== record.bundleDigest ||
      bundle.bundle_digest !== sha256Digest(bundle.statement) ||
      bundle.issued_at !== record.finalizedAt ||
      predicate.run.run_id !== record.runId ||
      predicate.source.candidate_sha !== record.candidateSha ||
      predicate.policy.effective_policy_digest !== record.policyDigest
    ) {
      throw new Error(`stored ASF evidence for ${runId} is contradictory`);
    }
    return bundle;
  }

  /**
   * Project the complete pre-cleanup side-effect history into bounded portable
   * evidence. Private adapter material is used only to revalidate durable
   * intent digests and is never copied into the returned ledger.
   */
  prepareAsfTerminalEffectLedger(input: {
    readonly runId: string;
  }): AsfTerminalEffectLedger {
    const run = this.getAsfRun(input.runId);
    const admission = this.getAsfAdmissionForRun(input.runId);
    const refuse = (detail: string): never => {
      throw RunmillError.fromCatalog("RM-EVID-008", {
        whatHappened: `terminal side-effect ledger for ${input.runId} ${detail}`,
        runId: input.runId,
      });
    };
    if (
      run === undefined ||
      admission === undefined ||
      run.mode !== "asf-worker" ||
      run.workOrderId !== admission.workOrderId ||
      run.attemptId !== admission.attemptId
    ) {
      return refuse("has no exact ASF run and admission binding");
    }

    const deliveryKeys = this.#db
      .prepare(
        `SELECT effect_key AS effectKey
         FROM asf_delivery_stage_intents
         WHERE run_id = ? AND stage <> 'cleanup'
         ORDER BY effect_key LIMIT ?`,
      )
      .all(input.runId, ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS + 1) as {
      readonly effectKey: string;
    }[];
    const githubKeys = this.#db
      .prepare(
        `SELECT effect_key AS effectKey
         FROM asf_effects WHERE run_id = ?
         ORDER BY effect_key LIMIT ?`,
      )
      .all(input.runId, ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS + 1) as {
      readonly effectKey: string;
    }[];
    if (
      deliveryKeys.length + githubKeys.length >
      ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS
    ) {
      return refuse("exceeds the durable effect bound");
    }

    let observationCount = 0;
    const effects: AsfTerminalEffect[] = [];
    for (const { effectKey } of deliveryKeys) {
      const intent = this.getAsfDeliveryIntent(effectKey);
      if (
        intent === undefined ||
        intent.stage === "cleanup" ||
        intent.run_id !== input.runId ||
        intent.work_order_id !== admission.workOrderId ||
        intent.attempt_id !== admission.attemptId ||
        intent.policy_digest !== admission.effectivePolicyDigest ||
        (intent.observationOutcome !== "confirmed" &&
          intent.observationOutcome !== "not_applied") ||
        intent.observationDigest === null ||
        intent.confirmedGeneration === null ||
        intent.confirmedAt === null ||
        intent.replayAuthorizedOperationId !== null ||
        intent.replayStartedGeneration !== null
      ) {
        return refuse(
          `contains unresolved or contradictory delivery effect ${JSON.stringify(effectKey)}`,
        );
      }
      const observations = this.#db
        .prepare(
          `SELECT seq, outcome, observation_digest AS observationDigest,
                  generation, source, observed_at AS observedAt
           FROM asf_delivery_intent_observations
           WHERE effect_key = ? ORDER BY seq LIMIT ?`,
        )
        .all(
          effectKey,
          ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT + 1,
        ) as {
        readonly seq: number;
        readonly outcome: "confirmed" | "not_applied" | "ambiguous";
        readonly observationDigest: string;
        readonly generation: number;
        readonly source: "confirmation" | "reconciliation" | "legacy";
        readonly observedAt: string;
      }[];
      observationCount += observations.length;
      const last = observations.at(-1);
      if (
        observations.length === 0 ||
        observations.length >
          ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT ||
        observationCount > ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS ||
        last?.outcome !== intent.observationOutcome ||
        last.observationDigest !== intent.observationDigest ||
        last.generation !== intent.confirmedGeneration ||
        last.observedAt !== intent.confirmedAt
      ) {
        return refuse(
          `contains incomplete delivery observation history for ${JSON.stringify(effectKey)}`,
        );
      }
      effects.push({
        effect_class: "delivery-intent",
        effect_key: intent.effect_key,
        stage: intent.stage,
        candidate_sha: intent.candidate_sha,
        event_seq: intent.event_seq,
        intent_id: intent.intent_id,
        intent_digest: intent.intent_digest,
        operation_digest: intent.operation_digest,
        fencing_generation: intent.fencing_generation,
        created_at: intent.created_at,
        final_outcome: intent.observationOutcome,
        final_observation_seq: last.seq,
        observations: observations.map((observation) => ({
          seq: observation.seq,
          outcome: observation.outcome,
          observation_digest: observation.observationDigest,
          generation: observation.generation,
          source: observation.source,
          observed_at: observation.observedAt,
        })),
        replay: null,
      });
    }

    for (const { effectKey } of githubKeys) {
      const effect = this.getAsfEffect(effectKey);
      if (
        effect === undefined ||
        effect.runId !== input.runId ||
        effect.system !== "github" ||
        effect.policyDigest !== admission.effectivePolicyDigest ||
        (effect.status !== "confirmed" && effect.status !== "not_applied") ||
        effect.observationDigest === null ||
        effect.retryProhibited !== 0 ||
        !Number.isSafeInteger(effect.generation) ||
        effect.generation < 1 ||
        effect.generation > run.generation ||
        StateStore.asfEffectKey({
          runId: effect.runId,
          operation: effect.operation,
          target: effect.target,
          candidateSha: effect.candidateSha,
        }) !== effect.effectKey ||
        sha256Digest({
          schema: "runmill.asf-effect-intent/v1",
          effect_key: effect.effectKey,
          run_id: effect.runId,
          system: "github",
          operation: effect.operation,
          target: effect.target,
          correlation_marker: effect.correlationMarker,
          candidate_sha: effect.candidateSha,
          expected_remote_sha: effect.expectedRemoteSha,
          policy_digest: effect.policyDigest,
        }) !== effect.intentDigest
      ) {
        return refuse(
          `contains unresolved or contradictory GitHub effect ${JSON.stringify(effectKey)}`,
        );
      }
      const observations = this.#db
        .prepare(
          `SELECT seq, outcome, candidate_sha AS candidateSha,
                  details_digest AS detailsDigest, observed_at AS observedAt
           FROM asf_effect_observations
           WHERE effect_key = ? ORDER BY seq LIMIT ?`,
        )
        .all(
          effectKey,
          ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT + 1,
        ) as {
        readonly seq: number;
        readonly outcome: "confirmed" | "not_applied" | "ambiguous";
        readonly candidateSha: string;
        readonly detailsDigest: string;
        readonly observedAt: string;
      }[];
      observationCount += observations.length;
      const last = observations.at(-1);
      if (
        observations.length === 0 ||
        observations.length >
          ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT ||
        observationCount > ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS ||
        observations.some(
          (observation) => observation.candidateSha !== effect.candidateSha,
        ) ||
        last?.outcome !== effect.status ||
        last.detailsDigest !== effect.observationDigest ||
        last.observedAt !== effect.updatedAt
      ) {
        return refuse(
          `contains incomplete GitHub observation history for ${JSON.stringify(effectKey)}`,
        );
      }
      effects.push({
        effect_class: "github-effect",
        effect_key: effect.effectKey,
        operation: effect.operation,
        candidate_sha: effect.candidateSha,
        intent_digest: effect.intentDigest,
        generation: effect.generation,
        intended_at: effect.intendedAt,
        final_outcome: effect.status,
        final_observation_seq: last.seq,
        observations: observations.map((observation) => ({
          seq: observation.seq,
          outcome: observation.outcome,
          observation_digest: observation.detailsDigest,
          observed_at: observation.observedAt,
        })),
      });
    }

    const reconciliationIds = this.#db
      .prepare(
        `SELECT operation_id AS operationId
         FROM asf_reconciliation_requests
         WHERE run_id = ? AND status IN ('completed', 'blocked')
         ORDER BY operation_id LIMIT ?`,
      )
      .all(input.runId, ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS + 1) as {
      readonly operationId: string;
    }[];
    if (
      reconciliationIds.length > ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS
    ) {
      return refuse("exceeds the durable reconciliation bound");
    }

    let reconciliationEffectCount = 0;
    const reconciliations: AsfTerminalReconciliation[] = [];
    for (const { operationId } of reconciliationIds) {
      const operation = this.getAsfReconciliation(operationId);
      if (
        operation === undefined ||
        operation.runId !== input.runId ||
        (operation.status !== "completed" && operation.status !== "blocked") ||
        operation.completedAt === null ||
        operation.resultDigest === null ||
        operation.pendingSetDigest === undefined ||
        operation.pendingSetDigest === null ||
        operation.canonicalPendingSet === undefined ||
        operation.canonicalPendingSet === null ||
        operation.canonicalResult === undefined ||
        operation.canonicalResult === null ||
        Buffer.byteLength(operation.canonicalPendingSet, "utf8") >
          ASF_TERMINAL_EFFECT_LEDGER_MAX_CANONICAL_BYTES ||
        Buffer.byteLength(operation.canonicalResult, "utf8") >
          ASF_TERMINAL_EFFECT_LEDGER_MAX_CANONICAL_BYTES
      ) {
        return refuse(
          `contains non-portable reconciliation ${JSON.stringify(operationId)}`,
        );
      }
      const request = reconciliationRequestSchema.parse({
        schema: "asf.reconciliation-request/v1",
        operation_id: operation.operationId,
        run_id: operation.runId,
        requested_by: {
          subject: operation.requestedBy,
          authority: operation.requestedAuthority,
        },
        scope: operation.scope,
      });
      if (sha256Digest(request) !== operation.requestDigest) {
        return refuse(
          `contains contradictory reconciliation request ${JSON.stringify(operationId)}`,
        );
      }

      let pendingRaw: unknown;
      let resultRaw: unknown;
      try {
        pendingRaw = JSON.parse(operation.canonicalPendingSet) as unknown;
        resultRaw = JSON.parse(operation.canonicalResult) as unknown;
      } catch {
        return refuse(
          `contains non-JSON reconciliation evidence ${JSON.stringify(operationId)}`,
        );
      }
      if (
        !isObjectRecord(pendingRaw) ||
        !hasExactKeys(pendingRaw, ["schema", "run_id", "effects"]) ||
        pendingRaw["schema"] !== "asf.pending-reconciliation-set/v2" ||
        pendingRaw["run_id"] !== input.runId ||
        !Array.isArray(pendingRaw["effects"]) ||
        canonicalJson(pendingRaw as JsonValue) !==
          operation.canonicalPendingSet ||
        sha256Digest(pendingRaw as JsonValue) !== operation.pendingSetDigest ||
        !isObjectRecord(resultRaw) ||
        !hasExactKeys(resultRaw, [
          "schema",
          "operation_id",
          "run_id",
          "pending_set_digest",
          "observations",
        ]) ||
        resultRaw["schema"] !== "asf.reconciliation-result/v1" ||
        resultRaw["operation_id"] !== operation.operationId ||
        resultRaw["run_id"] !== input.runId ||
        resultRaw["pending_set_digest"] !== operation.pendingSetDigest ||
        !Array.isArray(resultRaw["observations"]) ||
        canonicalJson(resultRaw as JsonValue) !== operation.canonicalResult ||
        sha256Digest(resultRaw as JsonValue) !== operation.resultDigest
      ) {
        return refuse(
          `contains contradictory reconciliation evidence ${JSON.stringify(operationId)}`,
        );
      }
      const pendingEffects = pendingRaw["effects"] as unknown[];
      const resultObservations = resultRaw["observations"] as unknown[];
      if (
        pendingEffects.length !== resultObservations.length ||
        resultObservations.length >
          ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS
      ) {
        return refuse(
          `has incomplete reconciliation coverage for ${JSON.stringify(operationId)}`,
        );
      }
      const expectedEffects = new Set<string>();
      let previousPending = "";
      for (const [index, rawEffect] of pendingEffects.entries()) {
        if (
          !isObjectRecord(rawEffect) ||
          !hasExactKeys(rawEffect, [
            "effect_class",
            "effect_key",
            "candidate_sha",
            "policy_digest",
            "intent_digest",
            "operation",
            "event_seq",
          ]) ||
          (rawEffect["effect_class"] !== "github-effect" &&
            rawEffect["effect_class"] !== "delivery-intent") ||
          typeof rawEffect["effect_key"] !== "string" ||
          rawEffect["policy_digest"] !== admission.effectivePolicyDigest
        ) {
          return refuse(
            `has malformed pending evidence for ${JSON.stringify(operationId)}`,
          );
        }
        const key = `${rawEffect["effect_class"]}\u0000${rawEffect["effect_key"]}`;
        if (expectedEffects.has(key) || (index > 0 && key <= previousPending)) {
          return refuse(
            `has duplicate or unsorted pending evidence for ${JSON.stringify(operationId)}`,
          );
        }
        expectedEffects.add(key);
        previousPending = key;
      }
      const references: AsfTerminalReconciliation["effects"] = [];
      let previousResult = "";
      for (const [index, rawObservation] of resultObservations.entries()) {
        if (
          !isObjectRecord(rawObservation) ||
          !hasExactKeys(rawObservation, [
            "effect_class",
            "effect_key",
            "outcome",
          ]) ||
          (rawObservation["effect_class"] !== "github-effect" &&
            rawObservation["effect_class"] !== "delivery-intent") ||
          typeof rawObservation["effect_key"] !== "string" ||
          (rawObservation["outcome"] !== "confirmed" &&
            rawObservation["outcome"] !== "not_applied" &&
            rawObservation["outcome"] !== "ambiguous")
        ) {
          return refuse(
            `has malformed result evidence for ${JSON.stringify(operationId)}`,
          );
        }
        const key = `${rawObservation["effect_class"]}\u0000${rawObservation["effect_key"]}`;
        if (!expectedEffects.has(key) || (index > 0 && key <= previousResult)) {
          return refuse(
            `has duplicate, unsorted, or unexpected results for ${JSON.stringify(operationId)}`,
          );
        }
        previousResult = key;
        references.push({
          effect_class: rawObservation["effect_class"],
          effect_key: rawObservation["effect_key"],
          outcome: rawObservation["outcome"],
        });
      }
      if (
        operation.status === "completed" &&
        references.some((reference) => reference.outcome === "ambiguous")
      ) {
        return refuse(
          `marks ambiguous reconciliation ${JSON.stringify(operationId)} completed`,
        );
      }
      reconciliationEffectCount += references.length;
      if (
        reconciliationEffectCount >
        ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS
      ) {
        return refuse("exceeds the aggregate reconciliation-effect bound");
      }
      reconciliations.push({
        operation_id: operation.operationId,
        request_digest: operation.requestDigest,
        pending_set_digest: operation.pendingSetDigest,
        result_digest: operation.resultDigest,
        status: operation.status,
        requested_at: operation.requestedAt,
        started_at: operation.startedAt,
        completed_at: operation.completedAt,
        effects: references,
      });
    }

    try {
      return buildAsfTerminalEffectLedger({
        run_id: input.runId,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        policy_digest: admission.effectivePolicyDigest,
        effects,
        reconciliations,
      });
    } catch (error) {
      return refuse(
        `is structurally contradictory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Atomically write the generic cleanup authorization and the immutable
   * terminal outcome it serves. No cleanup adapter may run before this commit.
   */
  recordAsfTerminalCleanupPlan(input: {
    readonly ownerId: string;
    readonly cleanupIntent: StateAsfDeliveryStageIntent;
    readonly plan: AsfTerminalEvidencePlan;
  }): {
    readonly intent: StateAsfDeliveryStageIntent;
    readonly disposition:
      | "created"
      | "existing-current"
      | "existing-prior-generation"
      | "existing-prior-generation-replay-authorized";
    readonly plan: AsfTerminalEvidencePlanRecord;
    readonly planCreated: boolean;
  } {
    const transaction = this.#db.transaction(() => {
      const recordedIntent = this.#recordAsfDeliveryIntent(
        {
          ownerId: input.ownerId,
          intent: input.cleanupIntent,
        },
        true,
      );
      const recordedPlan = this.#recordAsfTerminalEvidencePlan({
        plan: input.plan,
        ownerId: input.ownerId,
        generation: input.cleanupIntent.fencing_generation,
        cleanupIntentId: input.cleanupIntent.intent_id,
        cleanupIntentDigest: input.cleanupIntent.intent_digest,
      });
      return {
        intent: recordedIntent.intent,
        disposition: recordedIntent.disposition,
        plan: recordedPlan.record,
        planCreated: recordedPlan.created,
      } as const;
    });
    return transaction.immediate();
  }

  #recordAsfTerminalEvidencePlan(input: {
    readonly plan: AsfTerminalEvidencePlan;
    readonly ownerId: string;
    readonly generation: number;
    readonly cleanupIntentId: string;
    readonly cleanupIntentDigest: string;
  }): {
    readonly record: AsfTerminalEvidencePlanRecord;
    readonly created: boolean;
  } {
    const plan = asfTerminalEvidencePlanSchema.parse(input.plan);
    const canonicalPlan = canonicalJson(plan);
    const transaction = this.#db.transaction(() => {
      const runId = plan.run.run_id;
      const run = this.getAsfRun(runId);
      const admission = this.getAsfAdmissionForRun(runId);
      if (run === undefined || admission === undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence plan names unknown ASF run ${JSON.stringify(runId)}`,
          runId,
        });
      }
      if (
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot freeze ` +
            `terminal cleanup for ${runId}`,
          runId,
        });
      }
      const cleanupIntent = this.#getAsfDeliveryIntentById(
        input.cleanupIntentId,
      );
      const expectedCleanupEffectKey = `delivery_effect_${sha256Digest({
        stage: "cleanup",
        run_id: runId,
        candidate_sha: run.candidateSha,
        event_seq: run.stateVersion,
        operation_digest: plan.plan_digest,
      }).slice("sha256:".length, "sha256:".length + 32)}`;
      const delivery = this.getAsfEvidenceBundleRecord(runId);
      const events: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = this.listAsfRunEvents(runId, after, 1_000);
        if (page.gap) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence plan cannot bind compacted lifecycle events for ${runId}`,
            runId,
          });
        }
        events.push(...page.events);
        if (!page.hasMore) break;
        if (page.nextCursor <= after || events.length > 10_000) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence plan event scan is contradictory for ${runId}`,
            runId,
          });
        }
        after = page.nextCursor;
      }
      const createdAt = Date.parse(plan.created_at);
      const latestEvent = events.at(-1);
      if (
        run.mode !== "asf-worker" ||
        isTerminalRunEventPhase(run.state) ||
        run.baseCommit === null ||
        plan.run.work_order_id !== admission.workOrderId ||
        plan.run.attempt_id !== admission.attemptId ||
        plan.run.terminal_event_seq !== run.stateVersion + 1 ||
        plan.admission.work_order_payload_digest !== admission.payloadDigest ||
        plan.admission.work_order_envelope_digest !==
          admission.envelopeDigest ||
        plan.admission.effective_policy_digest !==
          admission.effectivePolicyDigest ||
        plan.source.repository !== run.repo.toLowerCase() ||
        plan.source.base_sha !== run.baseCommit ||
        plan.source.candidate_sha !== run.candidateSha ||
        cleanupIntent === undefined ||
        cleanupIntent.stage !== "cleanup" ||
        cleanupIntent.run_id !== runId ||
        cleanupIntent.work_order_id !== admission.workOrderId ||
        cleanupIntent.attempt_id !== admission.attemptId ||
        cleanupIntent.policy_digest !== admission.effectivePolicyDigest ||
        cleanupIntent.candidate_sha !== run.candidateSha ||
        cleanupIntent.intent_digest !== input.cleanupIntentDigest ||
        cleanupIntent.operation_digest !== plan.plan_digest ||
        cleanupIntent.effect_key !== expectedCleanupEffectKey ||
        cleanupIntent.observationDigest !== null ||
        cleanupIntent.observationOutcome !== null ||
        cleanupIntent.confirmedGeneration !== null ||
        cleanupIntent.confirmedAt !== null ||
        events.length !== run.stateVersion ||
        events.some((event, index) => event.seq !== index + 1) ||
        !Number.isFinite(createdAt) ||
        createdAt > this.#clock.now().getTime() ||
        createdAt < Date.parse(cleanupIntent.created_at) ||
        (latestEvent !== undefined &&
          createdAt < Date.parse(latestEvent.occurred_at))
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `terminal evidence plan does not bind the current admission, candidate, ` +
            `next event, and cleanup authorization for ${runId}`,
          runId,
        });
      }
      if (
        (plan.run.terminal_phase === "COMPLETED" &&
          (delivery === undefined ||
            plan.delivery_bundle_digest !== delivery.bundleDigest)) ||
        (plan.delivery_bundle_digest !== null &&
          plan.delivery_bundle_digest !== delivery?.bundleDigest)
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence plan has a contradictory delivery chain for ${runId}`,
          runId,
        });
      }
      const pending = this.#asfPendingReconciliationCounts(runId);
      const solePendingDeliveryIntent = this.#db
        .prepare(
          `SELECT intent_id AS intentId, effect_key AS effectKey
           FROM asf_delivery_stage_intents
           WHERE run_id = ? AND observation_outcome IS NULL`,
        )
        .get(runId) as { intentId: string; effectKey: string } | undefined;
      const authorityState = this.#db
        .prepare(
          `SELECT requires_reconciliation AS requiresReconciliation,
                  (SELECT COUNT(*) FROM asf_reconciliation_requests
                   WHERE run_id = ? AND status IN ('queued', 'running')) AS activeReconciliations
           FROM runs WHERE run_id = ?`,
        )
        .get(runId, runId) as
        | { requiresReconciliation: 0 | 1; activeReconciliations: number }
        | undefined;
      // Heal an upgraded v8 crash window only when the linked lifecycle
      // intent already carries exact definitive reconciliation evidence.
      // Any truly unresolved provider invocation remains reserved and keeps
      // terminalization failed closed below.
      this.#settleResolvedAsfProviderBudgets(runId);
      const providerBudget = portableAsfTerminalProviderBudgetEvidence(
        this.getAsfProviderBudgetEvidenceSummary(runId),
      );
      const sideEffects = this.prepareAsfTerminalEffectLedger({ runId });
      const outstandingProviderInvocations = (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS count FROM asf_provider_budget_reservations
             WHERE run_id = ? AND status = 'reserved'`,
          )
          .get(runId) as { count: number }
      ).count;
      const effectiveCancellation = events
        .filter(
          (event) =>
            event.type === "cancellation.requested" ||
            event.type === "cancellation.escalated",
        )
        .at(-1);
      const consumesForcedCancellationReconciliation =
        authorityState?.requiresReconciliation === 1 &&
        plan.run.terminal_phase === "CANCELLED" &&
        run.state === "CANCELLING" &&
        effectiveCancellation?.payload["mode"] === "forced" &&
        effectiveCancellation.payload["reconciliation_origin"] ===
          "forced-cancellation-cleanup";
      if (
        canonicalJson(plan.provider_budget) !== canonicalJson(providerBudget) ||
        canonicalJson(plan.side_effects) !== canonicalJson(sideEffects) ||
        pending.githubEffects !== 0 ||
        pending.deliveryIntents !== 1 ||
        outstandingProviderInvocations !== 0 ||
        solePendingDeliveryIntent?.intentId !== cleanupIntent.intent_id ||
        solePendingDeliveryIntent?.effectKey !== cleanupIntent.effect_key ||
        (authorityState?.requiresReconciliation !== 0 &&
          !consumesForcedCancellationReconciliation) ||
        authorityState?.activeReconciliations !== 0
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `terminal cleanup plan for ${runId} requires its cleanup intent to be the ` +
            "only unresolved durable effect",
          runId,
        });
      }
      const existing = this.getAsfTerminalEvidencePlanRecord(runId);
      if (existing !== undefined) {
        if (
          existing.planDigest !== plan.plan_digest ||
          existing.canonicalPlan !== canonicalPlan ||
          existing.cleanupIntentId !== input.cleanupIntentId ||
          existing.cleanupIntentDigest !== input.cleanupIntentDigest
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `run ${runId} already has a different immutable terminal plan`,
            runId,
          });
        }
        return { record: existing, created: false } as const;
      }
      this.#db
        .prepare(
          `INSERT INTO asf_terminal_evidence_intents(
             run_id, terminal_phase, terminal_event_seq, candidate_sha,
             policy_digest, cleanup_intent_id, cleanup_intent_digest,
             cleanup_digest, delivery_bundle_digest, plan_digest,
             canonical_plan, intent_digest, canonical_intent, created_at
           ) VALUES (?,?,?,?,?,?,?,NULL,?,?,?,NULL,NULL,?)`,
        )
        .run(
          runId,
          plan.run.terminal_phase,
          plan.run.terminal_event_seq,
          plan.source.candidate_sha,
          admission.effectivePolicyDigest,
          input.cleanupIntentId,
          input.cleanupIntentDigest,
          plan.delivery_bundle_digest,
          plan.plan_digest,
          canonicalPlan,
          plan.created_at,
        );
      const record = this.getAsfTerminalEvidencePlanRecord(runId);
      if (record === undefined)
        throw new Error("recorded ASF terminal evidence plan disappeared");
      return { record, created: true } as const;
    });
    return transaction.immediate();
  }

  getAsfTerminalEvidencePlanRecord(
    runId: string,
  ): AsfTerminalEvidencePlanRecord | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, terminal_phase AS terminalPhase,
                terminal_event_seq AS terminalEventSeq, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, cleanup_intent_id AS cleanupIntentId,
                cleanup_intent_digest AS cleanupIntentDigest,
                delivery_bundle_digest AS deliveryBundleDigest,
                plan_digest AS planDigest, canonical_plan AS canonicalPlan,
                created_at AS createdAt
         FROM asf_terminal_evidence_intents WHERE run_id = ?`,
      )
      .get(runId) as AsfTerminalEvidencePlanRecord | undefined;
  }

  getAsfTerminalEvidencePlan(
    runId: string,
  ): AsfTerminalEvidencePlan | undefined {
    const record = this.getAsfTerminalEvidencePlanRecord(runId);
    if (record === undefined) return undefined;
    const sealState = this.#db
      .prepare(
        `SELECT cleanup_digest AS cleanupDigest, intent_digest AS intentDigest,
                canonical_intent AS canonicalIntent, sealed_at AS sealedAt
         FROM asf_terminal_evidence_intents WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          cleanupDigest: string | null;
          intentDigest: string | null;
          canonicalIntent: string | null;
          sealedAt: string | null;
        }
      | undefined;
    const unsealed =
      sealState?.cleanupDigest === null &&
      sealState.intentDigest === null &&
      sealState.canonicalIntent === null &&
      sealState.sealedAt === null;
    const sealed =
      sealState?.cleanupDigest !== null &&
      sealState?.cleanupDigest !== undefined &&
      sealState.intentDigest !== null &&
      sealState.canonicalIntent !== null &&
      sealState.sealedAt !== null;
    if (!unsealed && !sealed) {
      throw new Error(
        `stored ASF terminal evidence plan for ${runId} has partial seal state`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(record.canonicalPlan) as unknown;
    } catch {
      throw new Error(
        `stored ASF terminal evidence plan for ${runId} is not JSON`,
      );
    }
    const plan = asfTerminalEvidencePlanSchema.parse(raw);
    if (
      canonicalJson(plan) !== record.canonicalPlan ||
      plan.plan_digest !== record.planDigest ||
      plan.run.run_id !== record.runId ||
      plan.run.terminal_phase !== record.terminalPhase ||
      plan.run.terminal_event_seq !== record.terminalEventSeq ||
      plan.source.candidate_sha !== record.candidateSha ||
      plan.admission.effective_policy_digest !== record.policyDigest ||
      canonicalJson(plan.side_effects) !==
        canonicalJson(this.prepareAsfTerminalEffectLedger({ runId })) ||
      plan.delivery_bundle_digest !== record.deliveryBundleDigest ||
      plan.created_at !== record.createdAt
    ) {
      throw new Error(
        `stored ASF terminal evidence plan for ${runId} is contradictory`,
      );
    }
    return plan;
  }

  /**
   * Freeze the exact post-cleanup terminal outcome before invoking a signer.
   * The full cleanup observation retains its original fencing generation so a
   * later owner can reconcile and sign it without fabricating a new proof.
   */
  sealAsfTerminalEvidenceIntent(input: {
    readonly runId: string;
    readonly planDigest: string;
    readonly cleanupObservation: AsfTerminalCleanupObservation;
    readonly ownerId: string;
    readonly generation: number;
  }): {
    readonly record: AsfTerminalEvidenceIntentRecord;
    readonly intent: AsfTerminalEvidenceIntent;
    readonly created: boolean;
  } {
    const observation = asfTerminalCleanupObservationSchema.parse(
      input.cleanupObservation,
    );
    const binding = observation.binding;
    if (
      binding.run_id !== input.runId ||
      binding.fencing_generation !== input.generation
    ) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened:
          `terminal cleanup observation generation ${binding.fencing_generation} does not ` +
          `match current generation ${input.generation}`,
        runId: binding.run_id,
      });
    }
    const transaction = this.#db.transaction(() => {
      const planRecord = this.getAsfTerminalEvidencePlanRecord(input.runId);
      const plan = this.getAsfTerminalEvidencePlan(input.runId);
      if (
        planRecord === undefined ||
        plan === undefined ||
        plan.plan_digest !== input.planDigest
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal cleanup observation has no exact immutable plan for ${input.runId}`,
          runId: input.runId,
        });
      }
      const admission = this.getAsfAdmissionForRun(input.runId);
      if (admission === undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal cleanup plan has no admission for ${input.runId}`,
          runId: input.runId,
        });
      }
      const existing = this.getAsfTerminalEvidenceIntent(input.runId);
      if (existing !== undefined) {
        if (
          existing.plan_digest !== input.planDigest ||
          canonicalJson(existing.cleanup.observation) !==
            canonicalJson(observation)
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `run ${input.runId} already has a different sealed cleanup observation`,
            runId: input.runId,
          });
        }
        const record = this.getAsfTerminalEvidenceIntentRecord(input.runId);
        if (record === undefined)
          throw new Error("sealed ASF terminal evidence intent disappeared");
        return { record, intent: existing, created: false } as const;
      }
      const createdAt = this.#clock.now().toISOString();
      const unsignedIntent = {
        schema: ASF_TERMINAL_EVIDENCE_INTENT_SCHEMA,
        run: plan.run,
        admission: plan.admission,
        source: plan.source,
        stop: plan.stop,
        provider_budget: plan.provider_budget,
        side_effects: plan.side_effects,
        timing: {
          admitted_at: admission.acceptedAt,
          terminal_evidence_at: createdAt,
          elapsed_ms: Date.parse(createdAt) - Date.parse(admission.acceptedAt),
        },
        cleanup: {
          intent_id: planRecord.cleanupIntentId,
          intent_digest: planRecord.cleanupIntentDigest,
          observation,
        },
        delivery_bundle_digest: plan.delivery_bundle_digest,
        plan_digest: plan.plan_digest,
        created_at: createdAt,
      } as const;
      const intent = asfTerminalEvidenceIntentSchema.parse({
        ...unsignedIntent,
        intent_digest: sha256Digest(unsignedIntent),
      });
      this.#confirmAsfDeliveryIntent(
        {
          ownerId: input.ownerId,
          intentId: intent.cleanup.intent_id,
          intentDigest: intent.cleanup.intent_digest,
          observationDigest: observation.evidence_digest,
          confirmedAt: createdAt,
          binding: {
            runId: binding.run_id,
            workOrderId: binding.work_order_id,
            attemptId: binding.attempt_id,
            policyDigest: binding.policy_digest,
            fencingGeneration: binding.fencing_generation,
            candidateSha: binding.candidate_sha,
          },
        },
        true,
      );
      const sealed = this.#recordAsfTerminalEvidenceIntent({
        intent,
        ownerId: input.ownerId,
        generation: input.generation,
      });
      const authorityState = this.#db
        .prepare(
          `SELECT requires_reconciliation AS requiresReconciliation,
                  state, owner_id AS ownerId, generation,
                  (SELECT COUNT(*) FROM asf_reconciliation_requests
                   WHERE run_id = ? AND status IN ('queued', 'running')) AS activeReconciliations
           FROM runs WHERE run_id = ?`,
        )
        .get(input.runId, input.runId) as
        | {
            requiresReconciliation: 0 | 1;
            state: string;
            ownerId: string | null;
            generation: number;
            activeReconciliations: number;
          }
        | undefined;
      if (authorityState?.requiresReconciliation === 1) {
        const pending = this.#asfPendingReconciliationCounts(input.runId);
        if (
          plan.run.terminal_phase !== "CANCELLED" ||
          authorityState.state !== "CANCELLING" ||
          authorityState.ownerId !== input.ownerId ||
          authorityState.generation !== input.generation ||
          authorityState.activeReconciliations !== 0 ||
          pending.total !== 0
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal cleanup for ${input.runId} cannot consume unresolved reconciliation authority`,
            runId: input.runId,
          });
        }
        const cleared = this.#db
          .prepare(
            `UPDATE runs SET requires_reconciliation = 0, updated_at = ?
             WHERE run_id = ? AND mode = 'asf-worker' AND state = 'CANCELLING'
               AND owner_id = ? AND generation = ? AND requires_reconciliation = 1`,
          )
          .run(createdAt, input.runId, input.ownerId, input.generation);
        if (cleared.changes !== 1) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal cleanup for ${input.runId} lost its forced-cancellation reconciliation fence`,
            runId: input.runId,
          });
        }
      }
      return { ...sealed, intent } as const;
    });
    return transaction.immediate();
  }

  #recordAsfTerminalEvidenceIntent(input: {
    readonly intent: AsfTerminalEvidenceIntent;
    readonly ownerId: string;
    readonly generation: number;
  }): {
    readonly record: AsfTerminalEvidenceIntentRecord;
    readonly created: boolean;
  } {
    const intent = asfTerminalEvidenceIntentSchema.parse(input.intent);
    const canonicalIntent = canonicalJson(intent);
    const transaction = this.#db.transaction(() => {
      const runId = intent.run.run_id;
      const run = this.getAsfRun(runId);
      const admission = this.getAsfAdmissionForRun(runId);
      if (run === undefined || admission === undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence intent names unknown ASF run ${JSON.stringify(runId)}`,
          runId,
        });
      }
      if (
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot freeze ` +
            `terminal evidence for ${runId}`,
          runId,
        });
      }
      const cleanupIntent = this.#getAsfDeliveryIntentById(
        intent.cleanup.intent_id,
      );
      const planRecord = this.getAsfTerminalEvidencePlanRecord(runId);
      const plan = this.getAsfTerminalEvidencePlan(runId);
      const observation = intent.cleanup.observation;
      const binding = observation.binding;
      const delivery = this.getAsfEvidenceBundleRecord(runId);
      const events: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = this.listAsfRunEvents(runId, after, 1_000);
        if (page.gap) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence intent cannot bind compacted lifecycle events for ${runId}`,
            runId,
          });
        }
        events.push(...page.events);
        if (!page.hasMore) break;
        if (page.nextCursor <= after || events.length > 10_000) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence intent event scan is contradictory for ${runId}`,
            runId,
          });
        }
        after = page.nextCursor;
      }
      const latestEvent = events.at(-1);
      const createdAt = Date.parse(intent.created_at);
      if (
        run.mode !== "asf-worker" ||
        isTerminalRunEventPhase(run.state) ||
        run.baseCommit === null ||
        intent.run.work_order_id !== admission.workOrderId ||
        intent.run.attempt_id !== admission.attemptId ||
        intent.run.terminal_event_seq !== run.stateVersion + 1 ||
        intent.admission.work_order_payload_digest !==
          admission.payloadDigest ||
        intent.admission.work_order_envelope_digest !==
          admission.envelopeDigest ||
        intent.admission.effective_policy_digest !==
          admission.effectivePolicyDigest ||
        intent.source.repository !== run.repo.toLowerCase() ||
        intent.source.base_sha !== run.baseCommit ||
        intent.source.candidate_sha !== run.candidateSha ||
        planRecord === undefined ||
        plan === undefined ||
        intent.plan_digest !== plan.plan_digest ||
        canonicalJson(intent.run) !== canonicalJson(plan.run) ||
        canonicalJson(intent.admission) !== canonicalJson(plan.admission) ||
        canonicalJson(intent.source) !== canonicalJson(plan.source) ||
        canonicalJson(intent.stop) !== canonicalJson(plan.stop) ||
        canonicalJson(intent.provider_budget) !==
          canonicalJson(plan.provider_budget) ||
        canonicalJson(intent.side_effects) !==
          canonicalJson(plan.side_effects) ||
        canonicalJson(intent.side_effects) !==
          canonicalJson(this.prepareAsfTerminalEffectLedger({ runId })) ||
        canonicalJson(intent.provider_budget) !==
          canonicalJson(
            portableAsfTerminalProviderBudgetEvidence(
              this.getAsfProviderBudgetEvidenceSummary(runId),
            ),
          ) ||
        intent.timing.admitted_at !== admission.acceptedAt ||
        intent.timing.terminal_evidence_at !== intent.created_at ||
        intent.timing.elapsed_ms !==
          Date.parse(intent.created_at) - Date.parse(admission.acceptedAt) ||
        intent.cleanup.intent_id !== planRecord.cleanupIntentId ||
        intent.cleanup.intent_digest !== planRecord.cleanupIntentDigest ||
        intent.cleanup.observation.identity_leases !==
          plan.cleanup.identity_leases ||
        intent.cleanup.observation.repository_lease !==
          plan.cleanup.repository_lease ||
        intent.cleanup.observation.workspace !== plan.cleanup.workspace ||
        intent.cleanup.observation.unresolved_effects !==
          plan.cleanup.unresolved_effects ||
        intent.delivery_bundle_digest !== plan.delivery_bundle_digest ||
        cleanupIntent === undefined ||
        cleanupIntent.stage !== "cleanup" ||
        cleanupIntent.run_id !== runId ||
        cleanupIntent.work_order_id !== admission.workOrderId ||
        cleanupIntent.attempt_id !== admission.attemptId ||
        cleanupIntent.policy_digest !== admission.effectivePolicyDigest ||
        cleanupIntent.candidate_sha !== run.candidateSha ||
        cleanupIntent.intent_digest !== intent.cleanup.intent_digest ||
        cleanupIntent.observationOutcome !== "confirmed" ||
        cleanupIntent.observationDigest !== observation.evidence_digest ||
        binding.run_id !== runId ||
        binding.work_order_id !== admission.workOrderId ||
        binding.attempt_id !== admission.attemptId ||
        binding.policy_digest !== admission.effectivePolicyDigest ||
        binding.candidate_sha !== run.candidateSha ||
        binding.fencing_generation !== cleanupIntent.confirmedGeneration ||
        events.length !== run.stateVersion ||
        events.some((event, index) => event.seq !== index + 1) ||
        !Number.isFinite(createdAt) ||
        createdAt > this.#clock.now().getTime() ||
        createdAt < Date.parse(plan.created_at) ||
        (cleanupIntent.confirmedAt !== null &&
          createdAt < Date.parse(cleanupIntent.confirmedAt)) ||
        (latestEvent !== undefined &&
          createdAt < Date.parse(latestEvent.occurred_at))
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `terminal evidence intent does not bind the current admission, candidate, ` +
            `next event, and immutable cleanup observation for ${runId}`,
          runId,
        });
      }
      if (
        (intent.run.terminal_phase === "COMPLETED" &&
          (delivery === undefined ||
            intent.delivery_bundle_digest !== delivery.bundleDigest)) ||
        (intent.delivery_bundle_digest !== null &&
          intent.delivery_bundle_digest !== delivery?.bundleDigest)
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence intent has a contradictory delivery chain for ${runId}`,
          runId,
        });
      }
      const pending = this.#asfPendingReconciliationCounts(runId);
      if (pending.total !== 0) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `terminal evidence intent for ${runId} claims cleanup while ${pending.total} ` +
            "durable effect intent(s) remain unresolved",
          runId,
        });
      }
      const existing = this.getAsfTerminalEvidenceIntentRecord(runId);
      if (existing !== undefined) {
        if (
          existing.intentDigest !== intent.intent_digest ||
          existing.canonicalIntent !== canonicalIntent
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `run ${runId} already has a different immutable terminal intent`,
            runId,
          });
        }
        return { record: existing, created: false } as const;
      }
      const sealed = this.#db
        .prepare(
          `UPDATE asf_terminal_evidence_intents
           SET cleanup_digest = ?, intent_digest = ?, canonical_intent = ?, sealed_at = ?
           WHERE run_id = ? AND plan_digest = ? AND intent_digest IS NULL`,
        )
        .run(
          observation.evidence_digest,
          intent.intent_digest,
          canonicalIntent,
          intent.created_at,
          runId,
          intent.plan_digest,
        );
      if (sealed.changes !== 1) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence intent for ${runId} lost its immutable plan binding`,
          runId,
        });
      }
      const record = this.getAsfTerminalEvidenceIntentRecord(runId);
      if (record === undefined)
        throw new Error("recorded ASF terminal evidence intent disappeared");
      return { record, created: true } as const;
    });
    return transaction.immediate();
  }

  getAsfTerminalEvidenceIntentRecord(
    runId: string,
  ): AsfTerminalEvidenceIntentRecord | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, terminal_phase AS terminalPhase,
                terminal_event_seq AS terminalEventSeq, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, cleanup_intent_id AS cleanupIntentId,
                cleanup_intent_digest AS cleanupIntentDigest,
                cleanup_digest AS cleanupDigest,
                delivery_bundle_digest AS deliveryBundleDigest,
                plan_digest AS planDigest, intent_digest AS intentDigest,
                canonical_intent AS canonicalIntent, sealed_at AS createdAt
         FROM asf_terminal_evidence_intents
         WHERE run_id = ? AND intent_digest IS NOT NULL`,
      )
      .get(runId) as AsfTerminalEvidenceIntentRecord | undefined;
  }

  getAsfTerminalEvidenceIntent(
    runId: string,
  ): AsfTerminalEvidenceIntent | undefined {
    const record = this.getAsfTerminalEvidenceIntentRecord(runId);
    if (record === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(record.canonicalIntent) as unknown;
    } catch {
      throw new Error(
        `stored ASF terminal evidence intent for ${runId} is not JSON`,
      );
    }
    const intent = asfTerminalEvidenceIntentSchema.parse(raw);
    if (
      canonicalJson(intent) !== record.canonicalIntent ||
      intent.intent_digest !== record.intentDigest ||
      intent.run.run_id !== record.runId ||
      intent.run.terminal_phase !== record.terminalPhase ||
      intent.run.terminal_event_seq !== record.terminalEventSeq ||
      intent.source.candidate_sha !== record.candidateSha ||
      intent.admission.effective_policy_digest !== record.policyDigest ||
      intent.cleanup.intent_id !== record.cleanupIntentId ||
      intent.cleanup.intent_digest !== record.cleanupIntentDigest ||
      intent.cleanup.observation.evidence_digest !== record.cleanupDigest ||
      canonicalJson(intent.side_effects) !==
        canonicalJson(this.prepareAsfTerminalEffectLedger({ runId })) ||
      intent.delivery_bundle_digest !== record.deliveryBundleDigest ||
      intent.plan_digest !== record.planDigest ||
      intent.created_at !== record.createdAt
    ) {
      throw new Error(
        `stored ASF terminal evidence intent for ${runId} is contradictory`,
      );
    }
    return intent;
  }

  /**
   * Persist the independently validated terminal statement after its cleanup
   * effect is confirmed and before the terminal lifecycle transition. A crash
   * leaves a recoverable nonterminal run plus an immutable, idempotent record;
   * it can never leave a terminal claim without signed cleanup evidence.
   */
  recordAsfTerminalEvidenceBundle(input: {
    readonly validated: ValidatedAsfTerminalEvidenceBundle;
    readonly ownerId: string;
    readonly generation: number;
  }): {
    readonly record: AsfTerminalEvidenceBundleRecord;
    readonly created: boolean;
  } {
    const { validated } = input;
    const bundle = signedAsfTerminalEvidenceBundleSchema.parse(
      validated.bundle,
    );
    const canonicalEnvelope = canonicalJson(bundle);
    const predicate = bundle.statement.predicate;
    if (
      validated.bundleDigest !== bundle.bundle_digest ||
      validated.candidateSha !== predicate.source.candidate_sha ||
      validated.terminalPhase !== predicate.run.terminal_phase ||
      validated.terminalEventSeq !== predicate.run.terminal_event_seq ||
      validated.signer.verified !== true ||
      validated.signer.keyId !== bundle.key_id ||
      validated.signer.algorithm !== bundle.algorithm
    ) {
      throw RunmillError.fromCatalog("RM-EVID-008", {
        whatHappened:
          "validated terminal evidence metadata is internally contradictory",
        runId: predicate.run.run_id,
      });
    }
    const transaction = this.#db.transaction(() => {
      const runId = predicate.run.run_id;
      const run = this.getAsfRun(runId);
      const admission = this.getAsfAdmissionForRun(runId);
      if (run === undefined || admission === undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence names unknown ASF run ${JSON.stringify(runId)}`,
          runId,
        });
      }
      if (
        run.ownerId !== input.ownerId ||
        run.generation !== input.generation
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot finalize ` +
            `terminal evidence for ${runId}`,
          runId,
        });
      }
      const cleanupIntent = this.#getAsfDeliveryIntentById(
        predicate.cleanup.intent_id,
      );
      const terminalIntentRecord =
        this.getAsfTerminalEvidenceIntentRecord(runId);
      const terminalIntent = this.getAsfTerminalEvidenceIntent(runId);
      if (
        run.mode !== "asf-worker" ||
        isTerminalRunEventPhase(run.state) ||
        predicate.run.work_order_id !== admission.workOrderId ||
        predicate.run.attempt_id !== admission.attemptId ||
        predicate.run.terminal_event_seq !== run.stateVersion + 1 ||
        predicate.admission.work_order_payload_digest !==
          admission.payloadDigest ||
        predicate.admission.work_order_envelope_digest !==
          admission.envelopeDigest ||
        predicate.admission.effective_policy_digest !==
          admission.effectivePolicyDigest ||
        canonicalJson(predicate.admission.work_order_envelope) !==
          admission.canonicalEnvelope ||
        predicate.admission.signature_verification.verified !== true ||
        predicate.admission.signature_verification.key_id !==
          admission.signatureKeyId ||
        predicate.admission.signature_verification.algorithm !==
          admission.signatureAlgorithm ||
        canonicalJson(predicate.admission.effective_policy) !==
          admission.effectivePolicy ||
        predicate.source.repository !== run.repo.toLowerCase() ||
        predicate.source.base_sha !== run.baseCommit ||
        predicate.source.candidate_sha !== run.candidateSha ||
        cleanupIntent === undefined ||
        cleanupIntent.stage !== "cleanup" ||
        cleanupIntent.run_id !== runId ||
        cleanupIntent.work_order_id !== admission.workOrderId ||
        cleanupIntent.attempt_id !== admission.attemptId ||
        cleanupIntent.policy_digest !== admission.effectivePolicyDigest ||
        cleanupIntent.candidate_sha !== run.candidateSha ||
        cleanupIntent.intent_digest !== predicate.cleanup.intent_digest ||
        cleanupIntent.observationOutcome !== "confirmed" ||
        cleanupIntent.observationDigest !==
          predicate.cleanup.observation_digest ||
        terminalIntentRecord === undefined ||
        terminalIntent === undefined ||
        terminalIntentRecord.terminalPhase !== predicate.run.terminal_phase ||
        terminalIntentRecord.terminalEventSeq !==
          predicate.run.terminal_event_seq ||
        terminalIntentRecord.candidateSha !== predicate.source.candidate_sha ||
        terminalIntentRecord.policyDigest !==
          predicate.admission.effective_policy_digest ||
        terminalIntentRecord.cleanupIntentId !== predicate.cleanup.intent_id ||
        terminalIntentRecord.cleanupIntentDigest !==
          predicate.cleanup.intent_digest ||
        terminalIntentRecord.cleanupDigest !==
          predicate.cleanup.observation_digest ||
        terminalIntentRecord.deliveryBundleDigest !==
          predicate.evidence.delivery_bundle_digest ||
        terminalIntent.run.run_id !== predicate.run.run_id ||
        terminalIntent.run.work_order_id !== predicate.run.work_order_id ||
        terminalIntent.run.attempt_id !== predicate.run.attempt_id ||
        terminalIntent.run.terminal_phase !== predicate.run.terminal_phase ||
        terminalIntent.run.terminal_event_seq !==
          predicate.run.terminal_event_seq ||
        terminalIntent.admission.work_order_envelope_digest !==
          predicate.admission.work_order_envelope_digest ||
        terminalIntent.admission.work_order_payload_digest !==
          predicate.admission.work_order_payload_digest ||
        terminalIntent.admission.effective_policy_digest !==
          predicate.admission.effective_policy_digest ||
        terminalIntent.source.repository !== predicate.source.repository ||
        terminalIntent.source.base_sha !== predicate.source.base_sha ||
        terminalIntent.source.candidate_sha !==
          predicate.source.candidate_sha ||
        canonicalJson(terminalIntent.stop) !== canonicalJson(predicate.stop) ||
        canonicalJson(terminalIntent.provider_budget) !==
          canonicalJson(predicate.budget.provider_usage) ||
        canonicalJson(terminalIntent.side_effects) !==
          canonicalJson(predicate.side_effects) ||
        canonicalJson(predicate.side_effects) !==
          canonicalJson(this.prepareAsfTerminalEffectLedger({ runId })) ||
        canonicalJson(predicate.budget.provider_usage) !==
          canonicalJson(
            portableAsfTerminalProviderBudgetEvidence(
              this.getAsfProviderBudgetEvidenceSummary(runId),
            ),
          ) ||
        canonicalJson(terminalIntent.timing) !==
          canonicalJson(predicate.timing) ||
        predicate.timing.admitted_at !== admission.acceptedAt ||
        predicate.timing.terminal_evidence_at !== bundle.issued_at ||
        predicate.timing.elapsed_ms !==
          Date.parse(bundle.issued_at) - Date.parse(admission.acceptedAt) ||
        terminalIntent.cleanup.intent_id !== predicate.cleanup.intent_id ||
        terminalIntent.cleanup.intent_digest !==
          predicate.cleanup.intent_digest ||
        terminalIntent.cleanup.observation.evidence_digest !==
          predicate.cleanup.observation_digest ||
        terminalIntent.cleanup.observation.identity_leases !==
          predicate.cleanup.identity_leases ||
        terminalIntent.cleanup.observation.repository_lease !==
          predicate.cleanup.repository_lease ||
        terminalIntent.cleanup.observation.workspace !==
          predicate.cleanup.workspace ||
        terminalIntent.cleanup.observation.unresolved_effects !==
          predicate.cleanup.unresolved_effects ||
        terminalIntent.delivery_bundle_digest !==
          predicate.evidence.delivery_bundle_digest ||
        bundle.issued_at !== terminalIntent.created_at
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `signed terminal evidence does not bind the current admission, candidate, ` +
            `next event, and confirmed cleanup for ${runId}`,
          runId,
        });
      }
      const delivery = this.getAsfEvidenceBundleRecord(runId);
      if (
        (predicate.run.terminal_phase === "COMPLETED" &&
          (delivery === undefined ||
            predicate.evidence.delivery_bundle_digest !==
              delivery.bundleDigest)) ||
        (predicate.evidence.delivery_bundle_digest !== null &&
          predicate.evidence.delivery_bundle_digest !== delivery?.bundleDigest)
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence has a contradictory delivery-evidence chain for ${runId}`,
          runId,
        });
      }
      const pending = this.#asfPendingReconciliationCounts(runId);
      if (pending.total !== 0) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `terminal evidence for ${runId} claims cleanup while ${pending.total} ` +
            "durable effect intent(s) remain unresolved",
          runId,
        });
      }
      const events: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = this.listAsfRunEvents(runId, after, 1_000);
        if (page.gap) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence cannot bind compacted lifecycle events for ${runId}`,
            runId,
          });
        }
        events.push(...page.events);
        if (!page.hasMore) break;
        if (page.nextCursor <= after || events.length > 10_000) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `terminal evidence event scan is contradictory for ${runId}`,
            runId,
          });
        }
        after = page.nextCursor;
      }
      const observations = predicate.evidence.observations;
      if (
        events.length !== run.stateVersion ||
        observations.length !== events.length ||
        predicate.evidence.events.length !== events.length ||
        predicate.evidence.preceding_event_count !== events.length ||
        predicate.evidence.preceding_event_chain_digest !==
          sha256Digest(events) ||
        observations.some((observation, index) => {
          const event = events[index];
          if (event === undefined) return true;
          const candidate = event.payload["candidate_sha"];
          return (
            observation.event_seq !== event.seq ||
            observation.event_type !== event.type ||
            observation.phase !== event.phase ||
            observation.candidate_sha !==
              (typeof candidate === "string" &&
              /^[a-f0-9]{40}$/u.test(candidate)
                ? candidate
                : null) ||
            observation.event_digest !== sha256Digest(event)
          );
        }) ||
        predicate.evidence.events.some((event, index) => {
          const durableEvent = events[index];
          return (
            durableEvent === undefined ||
            canonicalJson(event) !== canonicalJson(durableEvent)
          );
        })
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `terminal evidence does not cover the exact durable event history for ${runId}`,
          runId,
        });
      }
      const existing = this.getAsfTerminalEvidenceBundleRecord(runId);
      if (existing !== undefined) {
        if (
          existing.bundleDigest !== bundle.bundle_digest ||
          existing.canonicalEnvelopeDigest !==
            canonicalEnvelopeDigest(canonicalEnvelope) ||
          existing.canonicalEnvelope !== canonicalEnvelope
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `run ${runId} already has different immutable terminal evidence`,
            runId,
          });
        }
        return { record: existing, created: false } as const;
      }
      this.#db
        .prepare(
          `INSERT INTO asf_terminal_evidence_bundles(
             run_id, terminal_phase, terminal_event_seq, candidate_sha,
             policy_digest, cleanup_intent_id, cleanup_intent_digest,
             cleanup_digest, delivery_bundle_digest, bundle_digest,
             canonical_envelope_digest, canonical_envelope, finalized_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          runId,
          predicate.run.terminal_phase,
          predicate.run.terminal_event_seq,
          predicate.source.candidate_sha,
          admission.effectivePolicyDigest,
          predicate.cleanup.intent_id,
          predicate.cleanup.intent_digest,
          predicate.cleanup.observation_digest,
          predicate.evidence.delivery_bundle_digest,
          bundle.bundle_digest,
          canonicalEnvelopeDigest(canonicalEnvelope),
          canonicalEnvelope,
          bundle.issued_at,
        );
      const record = this.getAsfTerminalEvidenceBundleRecord(runId);
      if (record === undefined)
        throw new Error("recorded ASF terminal evidence disappeared");
      return { record, created: true } as const;
    });
    return transaction.immediate();
  }

  getAsfTerminalEvidenceBundleRecord(
    runId: string,
  ): AsfTerminalEvidenceBundleRecord | undefined {
    return this.#db
      .prepare(
        `SELECT run_id AS runId, terminal_phase AS terminalPhase,
                terminal_event_seq AS terminalEventSeq, candidate_sha AS candidateSha,
                policy_digest AS policyDigest, cleanup_intent_id AS cleanupIntentId,
                cleanup_intent_digest AS cleanupIntentDigest,
                cleanup_digest AS cleanupDigest,
                delivery_bundle_digest AS deliveryBundleDigest,
                bundle_digest AS bundleDigest,
                canonical_envelope_digest AS canonicalEnvelopeDigest,
                canonical_envelope AS canonicalEnvelope,
                finalized_at AS finalizedAt
         FROM asf_terminal_evidence_bundles WHERE run_id = ?`,
      )
      .get(runId) as AsfTerminalEvidenceBundleRecord | undefined;
  }

  getAsfTerminalEvidenceBundle(
    runId: string,
  ): SignedAsfTerminalEvidenceBundle | undefined {
    const record = this.getAsfTerminalEvidenceBundleRecord(runId);
    if (record === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(record.canonicalEnvelope) as unknown;
    } catch {
      throw new Error(`stored ASF terminal evidence for ${runId} is not JSON`);
    }
    const bundle = signedAsfTerminalEvidenceBundleSchema.parse(raw);
    const predicate = bundle.statement.predicate;
    const intent = this.getAsfTerminalEvidenceIntent(runId);
    if (
      intent === undefined ||
      record.canonicalEnvelopeDigest !==
        canonicalEnvelopeDigest(record.canonicalEnvelope) ||
      canonicalJson(bundle) !== record.canonicalEnvelope ||
      bundle.bundle_digest !== record.bundleDigest ||
      bundle.bundle_digest !== sha256Digest(bundle.statement) ||
      bundle.issued_at !== record.finalizedAt ||
      predicate.run.run_id !== record.runId ||
      predicate.run.terminal_phase !== record.terminalPhase ||
      predicate.run.terminal_event_seq !== record.terminalEventSeq ||
      predicate.source.candidate_sha !== record.candidateSha ||
      predicate.admission.effective_policy_digest !== record.policyDigest ||
      predicate.cleanup.intent_id !== record.cleanupIntentId ||
      predicate.cleanup.intent_digest !== record.cleanupIntentDigest ||
      predicate.cleanup.observation_digest !== record.cleanupDigest ||
      predicate.evidence.delivery_bundle_digest !==
        record.deliveryBundleDigest ||
      intent.run.terminal_phase !== predicate.run.terminal_phase ||
      intent.run.terminal_event_seq !== predicate.run.terminal_event_seq ||
      canonicalJson(intent.stop) !== canonicalJson(predicate.stop) ||
      intent.cleanup.intent_id !== predicate.cleanup.intent_id ||
      intent.cleanup.intent_digest !== predicate.cleanup.intent_digest ||
      intent.cleanup.observation.evidence_digest !==
        predicate.cleanup.observation_digest ||
      canonicalJson(intent.side_effects) !==
        canonicalJson(predicate.side_effects) ||
      intent.delivery_bundle_digest !==
        predicate.evidence.delivery_bundle_digest ||
      intent.created_at !== bundle.issued_at
    ) {
      throw new Error(
        `stored ASF terminal evidence for ${runId} is contradictory`,
      );
    }
    return bundle;
  }

  acknowledgeAsfOutcome(input: {
    readonly acknowledgement: OutcomeAcknowledgement;
    readonly requestDigest: string;
  }): AcknowledgeOutcomeResult {
    const request = input.acknowledgement;
    if (input.requestDigest !== sha256Digest(request)) {
      throw RunmillError.fromCatalog("RM-EVID-008", {
        whatHappened:
          "outcome acknowledgement digest is internally contradictory",
        runId: request.run_id,
      });
    }
    const transaction = this.#db.transaction(() => {
      const existingById = this.#db
        .prepare(
          `SELECT acknowledgement_id AS acknowledgementId, run_id AS runId,
                  bundle_digest AS bundleDigest, acknowledged_at AS acknowledgedAt,
                  request_digest AS requestDigest
           FROM asf_outcome_acknowledgements WHERE acknowledgement_id = ?`,
        )
        .get(request.acknowledgement_id) as
        | {
            acknowledgementId: string;
            runId: string;
            bundleDigest: string;
            acknowledgedAt: string;
            requestDigest: string;
          }
        | undefined;
      if (existingById !== undefined) {
        if (existingById.requestDigest !== input.requestDigest) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened: `acknowledgement id ${request.acknowledgement_id} is already bound to another outcome`,
            runId: existingById.runId,
          });
        }
      }
      const run = this.getAsfRun(request.run_id);
      const deliveryEvidence = this.getAsfEvidenceBundleRecord(request.run_id);
      const terminalEvidence = this.getAsfTerminalEvidenceBundleRecord(
        request.run_id,
      );
      // A digest row alone is not evidence. Parse and cross-check the exact
      // canonical signed bytes before granting acknowledgement authority.
      // Legacy delivery evidence is considered only when no terminal record
      // exists, so it can never displace the post-cleanup terminal bundle.
      const canonicalTerminalBundle =
        terminalEvidence === undefined
          ? undefined
          : this.getAsfTerminalEvidenceBundle(request.run_id);
      const canonicalLegacyDeliveryBundle =
        terminalEvidence === undefined &&
        run?.state === "COMPLETED" &&
        deliveryEvidence !== undefined
          ? this.getAsfEvidenceBundle(request.run_id)
          : undefined;
      const exactTerminalBundle =
        canonicalTerminalBundle?.bundle_digest === request.bundle_digest;
      // Preserve acknowledgement of legacy completed delivery bundles while
      // making the post-cleanup terminal bundle authoritative for every new
      // terminal outcome, including cancelled and stopped attempts.
      const exactLegacyCompletedBundle =
        terminalEvidence === undefined &&
        run?.state === "COMPLETED" &&
        canonicalLegacyDeliveryBundle?.bundle_digest === request.bundle_digest;
      if (
        run === undefined ||
        !isTerminalRunEventPhase(run.state) ||
        (!exactTerminalBundle && !exactLegacyCompletedBundle)
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `acknowledgement does not bind a terminal run and its exact signed terminal ` +
            `evidence bundle`,
          runId: request.run_id,
        });
      }
      if (existingById !== undefined) {
        if (
          existingById.runId !== request.run_id ||
          existingById.bundleDigest !== request.bundle_digest
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened:
              `acknowledgement id ${request.acknowledgement_id} has contradictory ` +
              "durable outcome bindings",
            runId: request.run_id,
          });
        }
        return {
          acknowledgementId: existingById.acknowledgementId,
          runId: existingById.runId,
          bundleDigest: existingById.bundleDigest,
          disposition: "existing",
          acknowledgedAt: existingById.acknowledgedAt,
        } as const;
      }
      const existingRun = this.#db
        .prepare(
          `SELECT acknowledgement_id AS acknowledgementId
           FROM asf_outcome_acknowledgements WHERE run_id = ?`,
        )
        .get(request.run_id) as { acknowledgementId: string } | undefined;
      if (existingRun !== undefined) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `run ${request.run_id} was already acknowledged as ${existingRun.acknowledgementId}`,
          runId: request.run_id,
        });
      }
      const at = this.#clock.now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO asf_outcome_acknowledgements(
             acknowledgement_id, run_id, bundle_digest, acknowledged_by,
             acknowledged_at, request_digest
           ) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          request.acknowledgement_id,
          request.run_id,
          request.bundle_digest,
          request.acknowledged_by.subject,
          at,
          input.requestDigest,
        );
      return {
        acknowledgementId: request.acknowledgement_id,
        runId: request.run_id,
        bundleDigest: request.bundle_digest,
        disposition: "recorded",
        acknowledgedAt: at,
      } as const;
    });
    return transaction.immediate();
  }

  /** Acquire or renew fenced ownership. A live different owner always wins. */
  claimAsfRun(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly staleBefore: string;
    readonly maxHostConcurrency?: number | undefined;
  }): { readonly generation: number; readonly takeover: boolean } | undefined {
    const maxHostConcurrency = input.maxHostConcurrency ?? 1;
    if (!Number.isSafeInteger(maxHostConcurrency) || maxHostConcurrency < 1) {
      throw new Error("ASF host concurrency must be a positive safe integer");
    }
    const transaction = this.#db.transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT state, state_version AS stateVersion, repo, candidate_sha AS candidateSha,
                  generation, owner_id AS ownerId, heartbeat_at AS heartbeatAt
           FROM runs WHERE run_id = ? AND mode = 'asf-worker'`,
        )
        .get(input.runId) as
        | {
            state: string;
            stateVersion: number;
            repo: string;
            candidateSha: string | null;
            generation: number;
            ownerId: string | null;
            heartbeatAt: string | null;
          }
        | undefined;
      if (row === undefined || isTerminalRunEventPhase(row.state))
        return undefined;

      const at = this.#clock.now().toISOString();
      if (
        row.ownerId !== null &&
        row.heartbeatAt !== null &&
        row.heartbeatAt >= input.staleBefore
      ) {
        return undefined;
      }

      const liveOwners = (
        this.#db
          .prepare(
            `SELECT run_id AS runId, repo, state
             FROM runs
             WHERE mode = 'asf-worker' AND run_id <> ?
               AND owner_id IS NOT NULL AND heartbeat_at IS NOT NULL AND heartbeat_at >= ?`,
          )
          .all(input.runId, input.staleBefore) as {
          runId: string;
          repo: string;
          state: string;
        }[]
      ).filter((owner) => !isTerminalRunEventPhase(owner.state));
      if (
        liveOwners.some(
          (owner) => owner.repo.toLowerCase() === row.repo.toLowerCase(),
        )
      ) {
        return undefined;
      }
      if (liveOwners.length >= maxHostConcurrency) return undefined;

      const latestCheckpoint = this.getLatestAsfCheckpoint(input.runId);
      if (
        latestCheckpoint !== undefined &&
        latestCheckpoint.fencing_generation > row.generation
      ) {
        throw new Error(
          `ASF run ${input.runId} has a checkpoint from future generation ` +
            `${latestCheckpoint.fencing_generation}; current generation is ${row.generation}`,
        );
      }
      // Every acquisition (including after a graceful release) advances the
      // fence. Otherwise an old callback from the same worker id and generation
      // could become valid again after an owner A -> none -> A cycle.
      const generation = row.generation + 1;
      // Recovery takeover is a relationship between the durable checkpoint
      // fence and the newly acquired fence. A null prior owner only proves that
      // ownership was released; it does not make a newer generation fresh.
      const takeover =
        latestCheckpoint !== undefined &&
        latestCheckpoint.fencing_generation < generation;
      const updated = this.#db
        .prepare(
          `UPDATE runs
           SET owner_id = ?, generation = ?, heartbeat_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ?
             AND (owner_id IS ? OR owner_id = ?)`,
        )
        .run(
          input.ownerId,
          generation,
          at,
          at,
          input.runId,
          row.generation,
          row.ownerId,
          row.ownerId,
        );
      if (updated.changes !== 1) return undefined;

      if (latestCheckpoint === undefined) {
        if (
          row.state !== "ADMITTED" ||
          row.stateVersion !== 1 ||
          row.candidateSha !== null
        ) {
          throw new Error(
            `ASF run ${input.runId} cannot be claimed without a durable lifecycle checkpoint`,
          );
        }
        const admission = this.getAsfAdmissionForRun(input.runId);
        const event = this.#db
          .prepare(
            `SELECT type, phase, policy_digest AS policyDigest, at
             FROM events WHERE run_id = ? AND seq = 1`,
          )
          .get(input.runId) as
          | {
              type: string;
              phase: string | null;
              policyDigest: string | null;
              at: string;
            }
          | undefined;
        if (
          admission === undefined ||
          event?.type !== "work_order.admitted" ||
          event.phase !== "ADMITTED" ||
          event.policyDigest !== admission.effectivePolicyDigest ||
          Date.parse(event.at) > Date.parse(at)
        ) {
          throw new Error(
            `ASF run ${input.runId} lacks an exact durable admission event for recovery`,
          );
        }
        const checkpoint = this.#createAsfBoundCheckpoint({
          runId: input.runId,
          workOrderId: admission.workOrderId,
          attemptId: admission.attemptId,
          policyDigest: admission.effectivePolicyDigest,
          phase: "ADMITTED",
          eventSeq: 1,
          generation,
          candidateSha: null,
          eventType: event.type,
          payload: {},
          at,
          material: {
            kind: "work-order-admission",
            durableInputs: {
              envelope_digest: admission.envelopeDigest,
              payload_digest: admission.payloadDigest,
            },
            durableOutputs: {
              admission_digest: sha256Digest({
                run_id: input.runId,
                policy_digest: admission.effectivePolicyDigest,
              }),
            },
            correlationMarker: null,
          },
        });
        this.#insertAsfCheckpoint(checkpoint, canonicalJson(checkpoint), at);
      }
      return { generation, takeover } as const;
    });
    return transaction.immediate();
  }

  heartbeatAsfRun(runId: string, ownerId: string, generation: number): void {
    const at = this.#clock.now().toISOString();
    const updated = this.#db
      .prepare(
        `UPDATE runs SET heartbeat_at = ?, updated_at = ?
         WHERE run_id = ? AND mode = 'asf-worker' AND owner_id = ? AND generation = ?`,
      )
      .run(at, at, runId, ownerId, generation);
    if (updated.changes !== 1) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened: `ASF run ${runId} is no longer owned by ${ownerId} at generation ${generation}`,
        runId,
      });
    }
  }

  releaseAsfRunOwnership(
    runId: string,
    ownerId: string,
    generation: number,
  ): void {
    const updated = this.#db
      .prepare(
        `UPDATE runs SET owner_id = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE run_id = ? AND mode = 'asf-worker' AND owner_id = ? AND generation = ?`,
      )
      .run(this.#clock.now().toISOString(), runId, ownerId, generation);
    if (updated.changes !== 1) {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened: `cannot release stale ASF ownership for ${runId} generation ${generation}`,
        runId,
      });
    }
  }

  #effectiveGatePolicy(admission: AsfAdmissionRecord): {
    readonly requiredLocalCheckIds: readonly string[];
    readonly requiredRemoteChecks: readonly string[];
    readonly localReviewer: string;
    readonly prReviewer: string;
  } {
    let raw: unknown;
    try {
      raw = JSON.parse(admission.effectivePolicy) as unknown;
    } catch {
      throw new Error(
        `ASF run ${admission.runId} has malformed effective policy JSON`,
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `ASF run ${admission.runId} has malformed effective policy`,
      );
    }
    const policy = raw as Record<string, unknown>;
    const identities = policy["identities"];
    const local = policy["requiredLocalCheckIds"];
    const remote = policy["requiredRemoteChecks"];
    if (
      policy["digest"] !== admission.effectivePolicyDigest ||
      !Array.isArray(local) ||
      !local.every((value) => typeof value === "string" && value !== "") ||
      !Array.isArray(remote) ||
      !remote.every((value) => typeof value === "string" && value !== "") ||
      typeof identities !== "object" ||
      identities === null ||
      Array.isArray(identities)
    ) {
      throw new Error(
        `ASF run ${admission.runId} has incomplete effective gate policy`,
      );
    }
    const identityRecord = identities as Record<string, unknown>;
    if (
      typeof identityRecord["localReviewer"] !== "string" ||
      typeof identityRecord["prReviewer"] !== "string"
    ) {
      throw new Error(
        `ASF run ${admission.runId} has incomplete reviewer policy`,
      );
    }
    return {
      requiredLocalCheckIds: [...new Set(local as string[])].sort(),
      requiredRemoteChecks: [...new Set(remote as string[])].sort(),
      localReviewer: identityRecord["localReviewer"],
      prReviewer: identityRecord["prReviewer"],
    };
  }

  #gateResults(
    runId: string,
    candidateSha: string,
    kind: "local-check" | "remote-check" | "local-review" | "pr-review",
  ): Map<string, string> {
    const rows = this.#db
      .prepare(
        `SELECT gate_id AS gateId, outcome FROM asf_gate_results
         WHERE run_id = ? AND candidate_sha = ? AND gate_kind = ?`,
      )
      .all(runId, candidateSha, kind) as { gateId: string; outcome: string }[];
    return new Map(rows.map((row) => [row.gateId, row.outcome]));
  }

  #requirePassedGates(
    runId: string,
    candidateSha: string,
    kind: "local-check" | "remote-check",
    required: readonly string[],
  ): void {
    const results = this.#gateResults(runId, candidateSha, kind);
    const unsatisfied = required.filter((id) => results.get(id) !== "passed");
    if (unsatisfied.length > 0) {
      throw new Error(
        `ASF ${kind} gates are not satisfied for candidate ${candidateSha}: ` +
          unsatisfied.join(", "),
      );
    }
  }

  #assertAsfGatePrerequisites(
    run: AsfRunRow,
    event: RunEvent,
    admission: AsfAdmissionRecord,
  ): void {
    const gatePolicy = this.#effectiveGatePolicy(admission);
    const candidateSha = event.payload["candidate_sha"];
    if (event.type === "verification.started") {
      const requested = event.payload["required_check_ids"];
      if (
        !Array.isArray(requested) ||
        JSON.stringify([...requested].sort()) !==
          JSON.stringify(gatePolicy.requiredLocalCheckIds)
      ) {
        throw new Error(
          "verification start does not name the exact effective local check set",
        );
      }
    }
    if (typeof candidateSha !== "string") return;

    if (event.type === "review.started") {
      this.#requirePassedGates(
        run.runId,
        candidateSha,
        "local-check",
        gatePolicy.requiredLocalCheckIds,
      );
      if (event.payload["reviewer_attribution"] !== gatePolicy.localReviewer) {
        throw new Error(
          "local review attribution does not match effective policy",
        );
      }
    }
    if (event.type === "review.completed") {
      if (event.payload["reviewer_attribution"] !== gatePolicy.localReviewer) {
        throw new Error(
          "local review attribution does not match effective policy",
        );
      }
    }
    if (event.type === "delivery.ready") {
      const review = this.#gateResults(run.runId, candidateSha, "local-review");
      if (review.get("decision") !== "approved") {
        throw new Error(
          `candidate ${candidateSha} has no approved local review`,
        );
      }
      const remote = event.payload["required_remote_checks"];
      if (
        !Array.isArray(remote) ||
        JSON.stringify([...remote].sort()) !==
          JSON.stringify(gatePolicy.requiredRemoteChecks)
      ) {
        throw new Error(
          "delivery does not name the exact effective remote check set",
        );
      }
    }
    if (
      event.type === "branch.pushed" &&
      event.payload["observed_remote_sha"] !== candidateSha
    ) {
      throw new Error(
        "pushed branch observation does not equal the exact candidate",
      );
    }
    if (event.type === "pull_request.opened") {
      if (event.payload["observed_head_sha"] !== candidateSha) {
        throw new Error(
          "pull-request head observation does not equal the exact candidate",
        );
      }
      if (event.payload["base_sha"] !== run.baseCommit) {
        throw new Error(
          "pull-request base observation does not equal the admitted base",
        );
      }
    }
    if (
      event.type === "ci.completed" ||
      event.type === "ci.recheck_completed" ||
      event.type === "ci.revalidated"
    ) {
      const checks = event.payload["checks"];
      if (
        !Array.isArray(checks) ||
        sha256Digest(checks) !== event.payload["checks_digest"]
      ) {
        throw new Error(
          "CI snapshot digest does not bind the reported check observations",
        );
      }
      const outcomes = checks.map((check) =>
        typeof check === "object" && check !== null
          ? (check as Record<string, unknown>)["outcome"]
          : undefined,
      );
      const contexts = checks.map((check) =>
        typeof check === "object" && check !== null
          ? (check as Record<string, unknown>)["context"]
          : undefined,
      );
      if (
        contexts.some((context) => typeof context !== "string") ||
        new Set(contexts).size !== contexts.length ||
        contexts.length !== gatePolicy.requiredRemoteChecks.length ||
        !gatePolicy.requiredRemoteChecks.every((context) =>
          contexts.includes(context),
        )
      ) {
        throw new Error(
          "CI snapshot does not cover the exact admitted required contexts",
        );
      }
      const calculated = outcomes.every((outcome) => outcome === "passed")
        ? "passed"
        : outcomes.some((outcome) => outcome === "failed")
          ? "failed"
          : outcomes.some((outcome) => outcome === "not-scheduled")
            ? "not-scheduled"
            : "pending";
      if (event.payload["outcome"] !== calculated) {
        throw new Error(
          "CI aggregate outcome contradicts its check observations",
        );
      }
    }
    if (event.type === "pr_review.started") {
      this.#requirePassedGates(
        run.runId,
        candidateSha,
        "remote-check",
        gatePolicy.requiredRemoteChecks,
      );
      if (event.payload["reviewer_attribution"] !== gatePolicy.prReviewer) {
        throw new Error(
          "PR review attribution does not match effective policy",
        );
      }
    }
    if (event.type === "pr_review.completed") {
      if (event.payload["reviewer_attribution"] !== gatePolicy.prReviewer) {
        throw new Error(
          "PR review attribution does not match effective policy",
        );
      }
    }
    if (event.type === "pull_request.delivered") {
      if (event.payload["observed_head_sha"] !== candidateSha) {
        throw new Error(
          "delivered pull-request head does not equal the exact candidate",
        );
      }
      const review = this.#gateResults(run.runId, candidateSha, "pr-review");
      if (review.get("decision") !== "approved") {
        throw new Error(`candidate ${candidateSha} has no approved PR review`);
      }
      this.#requirePassedGates(
        run.runId,
        candidateSha,
        "remote-check",
        gatePolicy.requiredRemoteChecks,
      );
      const prior = this.listAsfRunEvents(
        run.runId,
        Math.max(0, event.seq - 2),
        1,
      ).events[0];
      if (
        prior?.type !== "ci.revalidated" ||
        prior.seq !== event.seq - 1 ||
        prior.payload["candidate_sha"] !== candidateSha ||
        prior.payload["observation_intent_digest"] !==
          event.payload["final_ci_observation_intent_digest"] ||
        prior.payload["observation_digest"] !==
          event.payload["final_ci_observation_digest"] ||
        prior.payload["observation_fencing_generation"] !==
          event.payload["final_ci_observation_fencing_generation"] ||
        prior.payload["checks_digest"] !==
          event.payload["final_ci_checks_digest"] ||
        canonicalJson(prior.payload["checks"] as JsonValue) !==
          canonicalJson(event.payload["final_ci_checks"] as JsonValue) ||
        prior.payload["observed_at"] !== event.payload["final_ci_observed_at"]
      ) {
        throw new Error(
          "delivered pull request does not bind the immediately prior exact final CI revalidation",
        );
      }
    }
    if (event.type === "evidence.finalized" || event.type === "run.completed") {
      const evidence = this.getAsfEvidenceBundleRecord(run.runId);
      const eventDigest =
        event.type === "evidence.finalized"
          ? event.payload["bundle_digest"]
          : event.payload["evidence_bundle_digest"];
      if (
        evidence === undefined ||
        evidence.bundleDigest !== eventDigest ||
        evidence.candidateSha !== candidateSha ||
        evidence.policyDigest !== admission.effectivePolicyDigest
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `${event.type} does not bind the immutable signed evidence for the current ` +
            `candidate and policy`,
          runId: run.runId,
        });
      }
      if (event.type === "run.completed") {
        let effective: unknown;
        try {
          effective = JSON.parse(admission.effectivePolicy) as unknown;
        } catch {
          throw new Error(
            `ASF run ${run.runId} has invalid effective policy JSON`,
          );
        }
        const delivery =
          typeof effective === "object" &&
          effective !== null &&
          !Array.isArray(effective)
            ? (effective as Record<string, unknown>)["delivery"]
            : undefined;
        const closureTarget =
          typeof delivery === "object" &&
          delivery !== null &&
          !Array.isArray(delivery)
            ? (delivery as Record<string, unknown>)["closureTarget"]
            : undefined;
        if (closureTarget !== "pr" && closureTarget !== "merge") {
          throw new Error(
            `ASF run ${run.runId} has incomplete delivery policy`,
          );
        }
        if (event.payload["closure_target"] !== closureTarget) {
          throw new Error(
            "completion closure target does not match effective policy",
          );
        }
      }
    }
    if (event.type === "fixing.started") {
      const gateKind =
        run.state === "LOCAL_REVIEW"
          ? "local-review"
          : run.state === "PR_REVIEW"
            ? "pr-review"
            : run.state === "LOCAL_VERIFY"
              ? "local-check"
              : "remote-check";
      const results = this.#gateResults(run.runId, candidateSha, gateKind);
      const fixable = [...results.values()].some(
        (outcome) => outcome === "failed" || outcome === "changes-requested",
      );
      if (!fixable) {
        throw new Error(
          `candidate ${candidateSha} has no failed or rejected gate to fix`,
        );
      }
    }
  }

  #recordAsfGateResults(runId: string, event: RunEvent): void {
    const candidateSha = event.payload["candidate_sha"];
    if (typeof candidateSha !== "string") return;
    const upsert = this.#db.prepare(
      `INSERT INTO asf_gate_results(
         run_id, candidate_sha, gate_kind, gate_id, outcome, evidence_digest, event_seq
       ) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(run_id, candidate_sha, gate_kind, gate_id) DO UPDATE SET
         outcome = excluded.outcome,
         evidence_digest = excluded.evidence_digest,
         event_seq = excluded.event_seq`,
    );
    if (event.type === "verification.completed") {
      upsert.run(
        runId,
        candidateSha,
        "local-check",
        event.payload["check_id"],
        event.payload["outcome"],
        event.payload["evidence_digest"],
        event.seq,
      );
    } else if (event.type === "review.completed") {
      upsert.run(
        runId,
        candidateSha,
        "local-review",
        "decision",
        event.payload["outcome"],
        event.payload["findings_digest"],
        event.seq,
      );
    } else if (
      event.type === "ci.completed" ||
      event.type === "ci.recheck_completed" ||
      event.type === "ci.revalidated"
    ) {
      for (const rawCheck of event.payload["checks"] as Record<
        string,
        unknown
      >[]) {
        upsert.run(
          runId,
          candidateSha,
          "remote-check",
          rawCheck["context"],
          rawCheck["outcome"],
          rawCheck["evidence_digest"],
          event.seq,
        );
      }
    } else if (event.type === "pr_review.completed") {
      upsert.run(
        runId,
        candidateSha,
        "pr-review",
        "decision",
        event.payload["outcome"],
        event.payload["findings_digest"],
        event.seq,
      );
    }
  }

  #verificationCompletesRequiredCoverage(
    runId: string,
    candidateSha: string | null,
    event: RunEvent,
    admission: AsfAdmissionRecord,
  ): boolean {
    if (event.type !== "verification.completed" || candidateSha === null)
      return false;
    const checkId = event.payload["check_id"];
    if (typeof checkId !== "string") return false;
    const required = this.#effectiveGatePolicy(admission).requiredLocalCheckIds;
    if (required.length === 0) return false;
    const prior = this.#db
      .prepare(
        `SELECT gate_id AS gateName, outcome FROM asf_gate_results
         WHERE run_id = ? AND candidate_sha = ? AND gate_kind = 'local-check'`,
      )
      .all(runId, candidateSha) as { gateName: string; outcome: string }[];
    const outcomes = new Map(prior.map((row) => [row.gateName, row.outcome]));
    outcomes.set(checkId, event.payload["outcome"] as string);
    return (
      outcomes.size === required.length &&
      required.every((name) => outcomes.get(name) === "passed")
    );
  }

  /** Atomically advance state and emit its candidate/policy-bound public event. */
  transitionAsfRun(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly from: RunEventPhase;
    readonly to: RunEventPhase;
    readonly expectedVersion: number;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    /** Persisted with the transition or not at all. */
    readonly checkpoint?: AsfAtomicCheckpointInput | undefined;
    readonly reason?: string | undefined;
    readonly actor?: string | undefined;
  }): RunEvent {
    const transaction = this.#db.transaction(() => {
      const current = this.getAsfRun(input.runId);
      if (
        current !== undefined &&
        (current.ownerId !== input.ownerId ||
          current.generation !== input.generation)
      ) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF worker ${input.ownerId} generation ${input.generation} cannot advance ` +
            `${input.runId}; current owner is ${current.ownerId ?? "<none>"} generation ${current.generation}`,
          runId: input.runId,
        });
      }
      if (
        current === undefined ||
        current.state !== input.from ||
        current.stateVersion !== input.expectedVersion
      ) {
        throw new Error(
          `transition rejected for ${input.runId}: expected ${input.from} at version ` +
            `${input.expectedVersion}, found ${current?.state ?? "<missing run>"} at version ` +
            `${current?.stateVersion ?? "-"}`,
        );
      }
      const pendingTerminalIntent = this.getAsfTerminalEvidencePlanRecord(
        input.runId,
      );
      if (
        pendingTerminalIntent !== undefined &&
        (!isTerminalRunEventPhase(input.to) ||
          input.to !== pendingTerminalIntent.terminalPhase ||
          input.expectedVersion + 1 !== pendingTerminalIntent.terminalEventSeq)
      ) {
        this.getAsfTerminalEvidencePlan(input.runId);
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `run ${input.runId} has immutable pending ${pendingTerminalIntent.terminalPhase} ` +
            `terminal intent for event ${pendingTerminalIntent.terminalEventSeq}; no other lifecycle ` +
            "transition may supersede it",
          runId: input.runId,
        });
      }
      assertRunPhaseTransition(input.from, input.to);
      const at = this.#clock.now().toISOString();
      const admission = this.getAsfAdmissionForRun(input.runId);
      if (admission === undefined) {
        throw new Error(
          `ASF run ${input.runId} has no immutable Work Order admission`,
        );
      }
      // state_version is the durable monotonic event cursor. It cannot reset
      // when old detailed events are compacted.
      const seq = current.stateVersion + 1;
      let eventPayload = input.payload;
      let hasAutomaticReconciliationContinuation = false;
      if (input.eventType === "run.blocked_external") {
        if (
          Object.prototype.hasOwnProperty.call(input.payload, "continuation")
        ) {
          throw new Error(
            "BLOCKED_EXTERNAL continuation authority is derived by the state orchestrator",
          );
        }
        const code = input.payload["code"];
        const autoEligible =
          code === "INTERNAL_DELIVERY_FAILURE" ||
          code === "INTERNAL_WORKER_RECONCILIATION_REQUIRED" ||
          code === "CLEANUP_RECONCILIATION_REQUIRED";
        if (autoEligible) {
          const pending = this.#canonicalAsfPendingSet(input.runId);
          const pendingTotal =
            pending.githubEffectCount + pending.deliveryIntentCount;
          const interruptedCursors = [
            ...new Set(
              pending.value.effects
                .filter((effect) => effect.effect_class === "delivery-intent")
                .map((effect) => effect.event_seq)
                .filter((eventSeq): eventSeq is number => eventSeq !== null),
            ),
          ];
          let interruptedEventSeq = interruptedCursors[0];
          let cancellationBinding:
            | {
                readonly cancellation_event_id: string;
                readonly cancellation_event_digest: string;
                readonly cancellation_request_id: string;
              }
            | undefined;
          if (code === "CLEANUP_RECONCILIATION_REQUIRED") {
            const lifecycleEvents: RunEvent[] = [];
            let lifecycleAfter = 0;
            let lifecycleGap = false;
            while (lifecycleEvents.length < input.expectedVersion) {
              const page = this.listAsfRunEvents(
                input.runId,
                lifecycleAfter,
                Math.min(1_000, input.expectedVersion - lifecycleEvents.length),
              );
              lifecycleGap ||= page.gap;
              lifecycleEvents.push(...page.events);
              if (!page.hasMore) break;
              if (page.nextCursor <= lifecycleAfter) {
                lifecycleGap = true;
                break;
              }
              lifecycleAfter = page.nextCursor;
            }
            const interrupted = lifecycleEvents.at(-1);
            const effectiveCancellation = lifecycleEvents
              .filter(
                (event) =>
                  event.type === "cancellation.requested" ||
                  event.type === "cancellation.escalated",
              )
              .at(-1);
            const requestId = effectiveCancellation?.payload["request_id"];
            if (
              lifecycleGap ||
              lifecycleEvents.length !== input.expectedVersion ||
              interrupted?.seq !== input.expectedVersion ||
              interrupted.type !== "cancellation.started" ||
              interrupted.phase !== "CANCELLING" ||
              effectiveCancellation === undefined ||
              typeof requestId !== "string" ||
              interrupted.payload["request_id"] !== requestId
            ) {
              throw asfReconciliationStateError(
                "cancellation cleanup block has no complete exact-bound cancellation history",
                input.runId,
              );
            }
            interruptedEventSeq = interrupted.seq;
            cancellationBinding = {
              cancellation_event_id: effectiveCancellation.event_id,
              cancellation_event_digest: sha256Digest(effectiveCancellation),
              cancellation_request_id: requestId,
            };
          }
          const checkpoint = this.getLatestAsfCheckpoint(input.runId);
          if (
            pendingTotal > 0 &&
            (code === "CLEANUP_RECONCILIATION_REQUIRED" ||
              interruptedCursors.length === 1) &&
            interruptedEventSeq !== undefined &&
            interruptedEventSeq <= input.expectedVersion &&
            checkpoint !== undefined &&
            checkpoint.run_id === input.runId &&
            checkpoint.work_order_id === admission.workOrderId &&
            checkpoint.attempt_id === admission.attemptId &&
            checkpoint.policy_digest === admission.effectivePolicyDigest &&
            checkpoint.candidate_sha === current.candidateSha &&
            checkpoint.event_seq <= interruptedEventSeq
          ) {
            eventPayload = {
              ...input.payload,
              continuation: {
                schema: "asf.reconciliation-continuation/v1",
                disposition:
                  code === "CLEANUP_RECONCILIATION_REQUIRED"
                    ? "finish-cancellation"
                    : "retry-interrupted-phase",
                interrupted_event_seq: interruptedEventSeq,
                resume_phase: input.from,
                checkpoint_digest: checkpoint.checkpoint_digest,
                pending_set_digest: pending.digest,
                ...(cancellationBinding ?? {}),
              },
            };
            hasAutomaticReconciliationContinuation = true;
          }
        }
      }
      const event = parseRunEvent({
        schema: "asf.run-event/v1",
        event_id: `evt_${createHash("sha256")
          .update(`${input.runId}:${seq}:${input.eventType}`)
          .digest("hex")
          .slice(0, 26)}`,
        run_id: input.runId,
        work_order_id: admission.workOrderId,
        attempt_id: admission.attemptId,
        seq,
        occurred_at: at,
        type: input.eventType,
        phase: input.to,
        payload: eventPayload,
        policy_digest: admission.effectivePolicyDigest,
      });
      assertRunEventTransition(input.from, event);
      const interruptionState = this.#db
        .prepare(
          "SELECT resume_phase AS resumePhase FROM runs WHERE run_id = ?",
        )
        .get(input.runId) as { resumePhase: string | null } | undefined;
      if (input.eventType === "run.resumed") {
        if (input.from !== "WAITING_APPROVAL") {
          throw new Error(
            `ASF ${input.from} resumption requires a dedicated remediation contract`,
          );
        }
        if (interruptionState?.resumePhase !== input.to) {
          throw new Error(
            `ASF run ${input.runId} may resume only at durable checkpoint ` +
              `${interruptionState?.resumePhase ?? "<missing>"}, not ${input.to}`,
          );
        }
        const approvalId = event.payload["approval_id"];
        if (typeof approvalId !== "string") {
          throw new Error(
            "WAITING_APPROVAL resumption requires an exact approval id",
          );
        }
        const approval = this.getAsfApproval(approvalId);
        let approvalEnvelope:
          | ReturnType<typeof parseApprovalEnvelope>
          | undefined;
        try {
          approvalEnvelope =
            approval === undefined
              ? undefined
              : parseApprovalEnvelope(
                  JSON.parse(approval.canonicalEnvelope) as unknown,
                );
        } catch {
          approvalEnvelope = undefined;
        }
        if (
          approval === undefined ||
          approvalEnvelope === undefined ||
          approval.runId !== input.runId ||
          approval.decision !== "approved" ||
          approval.workOrderId !== admission.workOrderId ||
          approval.attemptId !== admission.attemptId ||
          approval.candidateSha !== current.candidateSha ||
          approval.policyDigest !== admission.effectivePolicyDigest ||
          Date.parse(approval.expiresAt) <= Date.parse(at) ||
          this.#approvalResumeTarget({
            run: current,
            admission,
            approval: approvalEnvelope.payload,
            at,
          }) !== input.to ||
          event.payload["evidence_digest"] !== approval.envelopeDigest ||
          event.payload["interrupted_phase"] !== "WAITING_APPROVAL" ||
          event.payload["resume_phase"] !== input.to
        ) {
          throw RunmillError.fromCatalog("RM-APPROVAL-003", {
            whatHappened:
              `approval ${JSON.stringify(approvalId)} is missing, denied, expired, or stale for ` +
              input.runId,
            runId: input.runId,
          });
        }
      }
      const candidateSha = event.payload["candidate_sha"];
      if (
        typeof candidateSha === "string" &&
        input.eventType !== "candidate.created" &&
        current?.candidateSha !== candidateSha
      ) {
        throw new Error(
          `ASF event ${input.eventType} is bound to candidate ${candidateSha}, but run ` +
            `${input.runId} currently names ${current?.candidateSha ?? "<no candidate>"}`,
        );
      }
      const nextCandidateSha =
        input.eventType === "candidate.created" &&
        typeof candidateSha === "string"
          ? candidateSha
          : (current?.candidateSha ?? null);
      if (input.eventType === "candidate.created") {
        const expectedParent = current.candidateSha ?? current.baseCommit;
        const parentSha = event.payload["parent_sha"];
        if (expectedParent === null || parentSha !== expectedParent) {
          throw new Error(
            `candidate parent ${String(parentSha)} does not match current lineage ` +
              `${expectedParent ?? "<missing base>"}`,
          );
        }
        if (candidateSha === parentSha) {
          throw new Error("candidate commit must differ from its parent");
        }
      }
      this.#assertAsfGatePrerequisites(current, event, admission);
      const catalogCheckpoint = (
        ASF_EVENT_CHECKPOINT_REQUIREMENTS as Readonly<
          Record<string, AsfCheckpointKind | undefined>
        >
      )[input.eventType];
      const verificationCoverageComplete =
        this.#verificationCompletesRequiredCoverage(
          input.runId,
          nextCandidateSha,
          event,
          admission,
        );
      const requiredCheckpoint =
        catalogCheckpoint ??
        (verificationCoverageComplete ? "local-verification-pass" : undefined);
      if (
        input.checkpoint?.kind === "local-verification-pass" &&
        !verificationCoverageComplete
      ) {
        throw new Error(
          "local-verification-pass checkpoint requires complete required-check coverage",
        );
      }
      if (
        requiredCheckpoint !== undefined &&
        input.checkpoint?.kind !== requiredCheckpoint
      ) {
        throw new Error(
          `ASF transition ${input.eventType} requires atomic ${requiredCheckpoint} checkpoint`,
        );
      }
      if (
        isTerminalRunEventPhase(input.to) &&
        input.checkpoint?.kind !== "lease-release-workspace-cleanup"
      ) {
        throw new Error(
          `terminal ASF transition ${input.eventType} requires an atomic cleanup checkpoint`,
        );
      }
      if (isTerminalRunEventPhase(input.to)) {
        const terminalIntent =
          pendingTerminalIntent === undefined
            ? undefined
            : this.getAsfTerminalEvidenceIntent(input.runId);
        const terminalEvidence = this.getAsfTerminalEvidenceBundleRecord(
          input.runId,
        );
        const terminalBundle =
          terminalEvidence === undefined
            ? undefined
            : this.getAsfTerminalEvidenceBundle(input.runId);
        const predicate = terminalBundle?.statement.predicate;
        const cleanupIntent =
          terminalEvidence === undefined
            ? undefined
            : this.#getAsfDeliveryIntentById(terminalEvidence.cleanupIntentId);
        const deliveryEvidence = this.getAsfEvidenceBundleRecord(input.runId);
        const outputs = input.checkpoint?.durableOutputs;
        const outputBindings =
          outputs !== undefined && isJsonObject(outputs) ? outputs : undefined;
        const stopPayloadMatches =
          predicate === undefined || input.to === "COMPLETED"
            ? input.to === "COMPLETED" &&
              event.payload["candidate_sha"] === nextCandidateSha &&
              event.payload["closure_target"] === "pr" &&
              event.payload["satisfied"] === true &&
              event.payload["evidence_bundle_digest"] ===
                predicate?.evidence.delivery_bundle_digest
            : event.payload["code"] === predicate.stop.code &&
              event.payload["summary"] === predicate.stop.summary &&
              event.payload["checkpoint"] ===
                predicate.stop.interrupted_phase &&
              event.payload["retry_disposition"] ===
                predicate.stop.retry_disposition &&
              event.payload["required_actor"] ===
                predicate.stop.required_actor &&
              event.payload["required_action"] ===
                predicate.stop.required_action &&
              canonicalJson(event.payload["evidence_refs"] ?? null) ===
                canonicalJson(predicate.stop.evidence_refs);
        const cancellationPayloadMatches =
          input.to !== "CANCELLED" ||
          (predicate?.cancellation !== null &&
            predicate?.cancellation !== undefined &&
            event.payload["request_id"] === predicate.cancellation.request_id &&
            event.payload["requester"] ===
              predicate.cancellation.requester_subject &&
            event.payload["reason"] ===
              `protected:${predicate.cancellation.reason_digest}` &&
            event.payload["mode"] === predicate.cancellation.mode &&
            event.payload["grace_seconds"] ===
              predicate.cancellation.grace_seconds);
        if (
          terminalEvidence === undefined ||
          terminalIntent === undefined ||
          terminalBundle === undefined ||
          predicate === undefined ||
          terminalIntent.run.terminal_phase !== input.to ||
          terminalIntent.run.terminal_event_seq !== seq ||
          terminalIntent.plan_digest !== pendingTerminalIntent?.planDigest ||
          terminalEvidence.terminalPhase !== input.to ||
          terminalEvidence.terminalEventSeq !== seq ||
          terminalEvidence.candidateSha !== nextCandidateSha ||
          terminalEvidence.policyDigest !== admission.effectivePolicyDigest ||
          predicate.run.run_id !== input.runId ||
          predicate.run.work_order_id !== admission.workOrderId ||
          predicate.run.attempt_id !== admission.attemptId ||
          predicate.run.terminal_phase !== input.to ||
          predicate.run.terminal_event_seq !== seq ||
          predicate.admission.work_order_envelope_digest !==
            admission.envelopeDigest ||
          predicate.admission.work_order_payload_digest !==
            admission.payloadDigest ||
          predicate.admission.effective_policy_digest !==
            admission.effectivePolicyDigest ||
          predicate.source.repository !== current.repo.toLowerCase() ||
          predicate.source.base_sha !== current.baseCommit ||
          predicate.source.candidate_sha !== nextCandidateSha ||
          predicate.cleanup.intent_id !== terminalEvidence.cleanupIntentId ||
          predicate.cleanup.intent_digest !==
            terminalEvidence.cleanupIntentDigest ||
          predicate.cleanup.observation_digest !==
            terminalEvidence.cleanupDigest ||
          predicate.evidence.delivery_bundle_digest !==
            terminalEvidence.deliveryBundleDigest ||
          (predicate.evidence.delivery_bundle_digest !== null &&
            predicate.evidence.delivery_bundle_digest !==
              deliveryEvidence?.bundleDigest) ||
          (input.to === "COMPLETED" && deliveryEvidence === undefined) ||
          !stopPayloadMatches ||
          !cancellationPayloadMatches ||
          event.payload["terminal_evidence_bundle_digest"] !==
            terminalEvidence.bundleDigest ||
          input.checkpoint?.correlationMarker !==
            terminalEvidence.cleanupIntentId ||
          outputBindings?.["terminal_evidence_bundle_digest"] !==
            terminalEvidence.bundleDigest ||
          outputBindings?.["cleanup_evidence_digest"] !==
            terminalEvidence.cleanupDigest ||
          cleanupIntent === undefined ||
          cleanupIntent.stage !== "cleanup" ||
          cleanupIntent.run_id !== input.runId ||
          cleanupIntent.work_order_id !== admission.workOrderId ||
          cleanupIntent.attempt_id !== admission.attemptId ||
          cleanupIntent.policy_digest !== admission.effectivePolicyDigest ||
          cleanupIntent.candidate_sha !== nextCandidateSha ||
          cleanupIntent.intent_digest !==
            terminalEvidence.cleanupIntentDigest ||
          cleanupIntent.observationOutcome !== "confirmed" ||
          cleanupIntent.observationDigest !== terminalEvidence.cleanupDigest
        ) {
          throw RunmillError.fromCatalog("RM-EVID-008", {
            whatHappened:
              `terminal transition ${input.eventType} does not bind the exact pre-recorded ` +
              `terminal evidence and confirmed cleanup for ${input.runId}`,
            runId: input.runId,
          });
        }
        const pending = this.#asfPendingReconciliationCounts(input.runId);
        if (pending.total > 0) {
          throw new Error(
            `terminal ASF transition ${input.eventType} refused with ${pending.total} ` +
              "unreconciled durable effect intent(s)",
          );
        }
      }
      const checkpoint =
        input.checkpoint === undefined
          ? undefined
          : this.#createAsfBoundCheckpoint({
              runId: input.runId,
              workOrderId: admission.workOrderId,
              attemptId: admission.attemptId,
              policyDigest: admission.effectivePolicyDigest,
              phase: input.to,
              eventSeq: seq,
              generation: input.generation,
              candidateSha: nextCandidateSha,
              eventType: event.type,
              payload: event.payload,
              at,
              material: input.checkpoint,
            });
      const updated = this.#db
        .prepare(
          `UPDATE runs
           SET state = ?, state_version = state_version + 1, updated_at = ?, heartbeat_at = ?,
               candidate_sha = ?,
               resume_phase = CASE
                 WHEN ? IN ('WAITING_APPROVAL', 'NEEDS_SPEC', 'BLOCKED_EXTERNAL')
                   THEN COALESCE(resume_phase, ?)
                 WHEN ? = 'run.resumed' THEN NULL
                 ELSE resume_phase
               END
           WHERE run_id = ? AND mode = 'asf-worker' AND state = ? AND state_version = ?
             AND owner_id = ? AND generation = ?`,
        )
        .run(
          input.to,
          at,
          at,
          nextCandidateSha,
          input.to,
          input.from,
          input.eventType,
          input.runId,
          input.from,
          input.expectedVersion,
          input.ownerId,
          input.generation,
        );
      if (updated.changes !== 1) {
        const actual = this.getAsfRun(input.runId);
        if (
          actual !== undefined &&
          (actual.ownerId !== input.ownerId ||
            actual.generation !== input.generation)
        ) {
          throw RunmillError.fromCatalog("RM-LEASE-001", {
            whatHappened:
              `stale ASF worker ${input.ownerId} generation ${input.generation} cannot advance ` +
              `${input.runId}; current owner is ${actual.ownerId ?? "<none>"} generation ${actual.generation}`,
            runId: input.runId,
          });
        }
        throw new Error(
          `transition rejected for ${input.runId}: expected ${input.from} at version ` +
            `${input.expectedVersion}, found ${actual?.state ?? "<missing run>"} at version ` +
            `${actual?.stateVersion ?? "-"}`,
        );
      }
      if (hasAutomaticReconciliationContinuation) {
        this.#db
          .prepare(
            `UPDATE runs SET requires_reconciliation = 1,
                             resume_phase = CASE WHEN ? = 1 THEN 'CANCELLING'
                                                 ELSE resume_phase END
             WHERE run_id = ? AND mode = 'asf-worker' AND state = 'BLOCKED_EXTERNAL'
               AND state_version = ? AND owner_id = ? AND generation = ?`,
          )
          .run(
            input.payload["code"] === "CLEANUP_RECONCILIATION_REQUIRED" ? 1 : 0,
            input.runId,
            seq,
            input.ownerId,
            input.generation,
          );
      }

      this.#db
        .prepare(
          `INSERT INTO state_transitions(run_id, seq, from_state, to_state, reason, actor, at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          input.runId,
          seq,
          input.from,
          input.to,
          input.reason ?? null,
          input.actor ?? "orchestrator",
          at,
        );
      this.#db
        .prepare(
          `INSERT INTO events(run_id, seq, type, payload, artifact_ref,
                              redaction_ruleset_version, at, event_id, schema, phase, policy_digest)
           VALUES (?,?,?,?,NULL,'asf-public-v1',?,?,?,?,?)`,
        )
        .run(
          input.runId,
          seq,
          event.type,
          JSON.stringify(event.payload),
          event.occurred_at,
          event.event_id,
          event.schema,
          event.phase,
          event.policy_digest,
        );
      this.#recordAsfGateResults(input.runId, event);
      if (checkpoint !== undefined) {
        this.#insertAsfCheckpoint(checkpoint, canonicalJson(checkpoint), at);
      }
      return event;
    });
    return transaction.immediate();
  }

  listAsfRunEvents(runId: string, after = 0, limit = 100): AsfEventPage {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("event cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error(
        "event page limit must be an integer from 1 through 1000",
      );
    }
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(runId);
      if (run === undefined) throw new Error(`ASF run ${runId} does not exist`);
      const retention = this.#db
        .prepare(
          `SELECT compacted_through AS compactedThrough, work_order_id AS workOrderId,
                  attempt_id AS attemptId
           FROM asf_work_order_admissions WHERE run_id = ?`,
        )
        .get(runId) as
        | { compactedThrough: number; workOrderId: string; attemptId: string }
        | undefined;
      if (retention === undefined) {
        throw new Error(
          `ASF run ${runId} has no immutable Work Order admission`,
        );
      }
      const rows = this.#db
        .prepare(
          `SELECT event_id AS eventId, schema, seq, type, payload, phase,
                  policy_digest AS policyDigest, at AS occurredAt
           FROM events
           WHERE run_id = ? AND seq > ?
           ORDER BY seq
           LIMIT ?`,
        )
        .all(runId, after, limit + 1) as {
        eventId: string | null;
        schema: string | null;
        seq: number;
        type: string;
        payload: string;
        phase: string | null;
        policyDigest: string | null;
        occurredAt: string;
      }[];
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const events = visible.map((row) =>
        parseRunEvent({
          schema: row.schema,
          event_id: row.eventId,
          run_id: runId,
          work_order_id: retention.workOrderId,
          attempt_id: retention.attemptId,
          seq: row.seq,
          occurred_at: row.occurredAt,
          type: row.type,
          phase: row.phase,
          payload: JSON.parse(row.payload) as unknown,
          policy_digest: row.policyDigest,
        }),
      );
      const latestSequence = (
        this.#db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?",
          )
          .get(runId) as { seq: number }
      ).seq;
      if (latestSequence !== run.stateVersion) {
        throw new Error(
          `ASF run ${runId} event sequence ${latestSequence} does not match state version ` +
            run.stateVersion,
        );
      }
      const gap = after < retention.compactedThrough;
      return {
        events,
        nextCursor:
          events.at(-1)?.seq ?? Math.max(after, retention.compactedThrough),
        hasMore,
        gap,
        compactedThrough: gap ? retention.compactedThrough : null,
        snapshot: { run, latestSequence },
      };
    });
    return transaction.deferred();
  }

  /**
   * Return an acknowledged terminal run that still has detailed events to
   * retain. The owner is deliberately only a hint: acknowledgement can race
   * the terminal worker's final ownership release. Compaction itself requires
   * released ownership inside its write transaction.
   */
  getAsfEventRetentionCandidate(
    runId: string,
  ): AsfEventRetentionCandidate | undefined {
    const row = this.#db
      .prepare(
        `SELECT r.run_id AS runId, r.generation, r.owner_id AS ownerId,
                terminal.terminal_event_seq AS terminalEventSeq,
                event.at AS terminalEventAt,
                terminal.bundle_digest AS bundleDigest,
                admission.compacted_through AS compactedThrough
         FROM runs AS r
         JOIN asf_work_order_admissions AS admission ON admission.run_id = r.run_id
         JOIN asf_terminal_evidence_bundles AS terminal ON terminal.run_id = r.run_id
         JOIN asf_outcome_acknowledgements AS acknowledgement
           ON acknowledgement.run_id = r.run_id
          AND acknowledgement.bundle_digest = terminal.bundle_digest
         JOIN events AS event
           ON event.run_id = r.run_id AND event.seq = terminal.terminal_event_seq
         WHERE r.run_id = ? AND r.mode = 'asf-worker'
           AND r.state IN ('COMPLETED','CANCELLED','FAILED','REFUSED',
                           'QUARANTINED','BUDGET_EXHAUSTED')
           AND terminal.terminal_phase = r.state
           AND terminal.terminal_event_seq = r.state_version
           AND terminal.terminal_event_seq > 1
           AND event.phase = r.state
           AND event.schema = 'asf.run-event/v1'
           AND admission.compacted_through < terminal.terminal_event_seq - 1`,
      )
      .get(runId) as AsfEventRetentionCandidate | undefined;
    return row === undefined ? undefined : parseAsfEventRetentionCandidate(row);
  }

  /** Durable recovery scan for event-retention wake scheduling. */
  listAsfEventRetentionCandidates(
    limit = 10_000,
  ): readonly AsfEventRetentionCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(
        "ASF event-retention candidate limit must be an integer from 1 through 10000",
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT r.run_id AS runId, r.generation, r.owner_id AS ownerId,
                terminal.terminal_event_seq AS terminalEventSeq,
                event.at AS terminalEventAt,
                terminal.bundle_digest AS bundleDigest,
                admission.compacted_through AS compactedThrough
         FROM runs AS r
         JOIN asf_work_order_admissions AS admission ON admission.run_id = r.run_id
         JOIN asf_terminal_evidence_bundles AS terminal ON terminal.run_id = r.run_id
         JOIN asf_outcome_acknowledgements AS acknowledgement
           ON acknowledgement.run_id = r.run_id
          AND acknowledgement.bundle_digest = terminal.bundle_digest
         JOIN events AS event
           ON event.run_id = r.run_id AND event.seq = terminal.terminal_event_seq
         WHERE r.mode = 'asf-worker'
           AND r.state IN ('COMPLETED','CANCELLED','FAILED','REFUSED',
                           'QUARANTINED','BUDGET_EXHAUSTED')
           AND terminal.terminal_phase = r.state
           AND terminal.terminal_event_seq = r.state_version
           AND terminal.terminal_event_seq > 1
           AND event.phase = r.state
           AND event.schema = 'asf.run-event/v1'
           AND admission.compacted_through < terminal.terminal_event_seq - 1
         ORDER BY event.at, r.run_id
         LIMIT ?`,
      )
      .all(limit) as AsfEventRetentionCandidate[];
    return rows.map(parseAsfEventRetentionCandidate);
  }

  /**
   * Compact acknowledged terminal detail only after the lifecycle owner has
   * released its fence and the hard retention floor has elapsed. The terminal
   * event is always retained so current cursor/snapshot sequence cannot move
   * backwards; the durable watermark makes every resulting gap explicit.
   */
  compactAsfRunEvents(input: {
    readonly runId: string;
    readonly expectedGeneration: number;
    readonly expectedBundleDigest: string;
    readonly through: number;
    readonly minimumAgeMs: number;
  }): number {
    if (!Number.isSafeInteger(input.through) || input.through < 1) {
      throw new Error(
        "ASF compaction sequence must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1
    ) {
      throw new Error(
        "ASF compaction generation must be a positive safe integer",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.expectedBundleDigest)) {
      throw new Error(
        "ASF compaction requires an exact terminal bundle digest",
      );
    }
    if (
      !Number.isSafeInteger(input.minimumAgeMs) ||
      input.minimumAgeMs < MIN_ASF_DETAILED_EVENT_RETENTION_MS
    ) {
      throw new Error(
        `ASF detailed event retention must be at least ${MIN_ASF_DETAILED_EVENT_RETENTION_MS}ms`,
      );
    }
    const transaction = this.#db.transaction(() => {
      const run = this.getAsfRun(input.runId);
      if (run === undefined || run.generation !== input.expectedGeneration) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `stale ASF retention generation ${input.expectedGeneration} cannot compact ` +
            `${input.runId}; current generation is ${run?.generation ?? "unknown"}`,
          runId: input.runId,
        });
      }
      if (run.ownerId !== null) {
        throw RunmillError.fromCatalog("RM-LEASE-001", {
          whatHappened:
            `ASF run ${input.runId} still belongs to lifecycle owner ${run.ownerId}; ` +
            "event compaction is deferred until ownership is released",
          runId: input.runId,
        });
      }
      const terminalEvidence = this.getAsfTerminalEvidenceBundleRecord(
        input.runId,
      );
      const terminalBundle =
        terminalEvidence === undefined
          ? undefined
          : this.getAsfTerminalEvidenceBundle(input.runId);
      const acknowledgement = this.#db
        .prepare(
          `SELECT bundle_digest AS bundleDigest
           FROM asf_outcome_acknowledgements WHERE run_id = ?`,
        )
        .get(input.runId) as { bundleDigest: string } | undefined;
      const admission = this.getAsfAdmissionForRun(input.runId);
      if (
        !isTerminalRunEventPhase(run.state) ||
        terminalEvidence === undefined ||
        terminalBundle === undefined ||
        admission === undefined ||
        run.workOrderId !== admission.workOrderId ||
        run.attemptId !== admission.attemptId ||
        terminalEvidence.terminalPhase !== run.state ||
        terminalEvidence.terminalEventSeq !== run.stateVersion ||
        terminalBundle.statement.predicate.run.work_order_id !==
          admission.workOrderId ||
        terminalBundle.statement.predicate.run.attempt_id !==
          admission.attemptId ||
        terminalBundle.statement.predicate.admission.effective_policy_digest !==
          admission.effectivePolicyDigest ||
        acknowledgement?.bundleDigest !== terminalEvidence.bundleDigest ||
        input.expectedBundleDigest !== terminalEvidence.bundleDigest
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened:
            `run ${input.runId} may compact lifecycle evidence only after exact signed ` +
            "terminal evidence is acknowledged",
          runId: input.runId,
        });
      }
      if (input.through !== terminalEvidence.terminalEventSeq - 1) {
        throw new Error(
          `ASF compaction for ${input.runId} must use exact terminal predecessor ` +
            `${terminalEvidence.terminalEventSeq - 1}`,
        );
      }
      const terminalRow = this.#db
        .prepare(
          `SELECT event_id AS eventId, schema, seq, type, payload, phase,
                  policy_digest AS policyDigest, at AS occurredAt
           FROM events WHERE run_id = ? AND seq = ?`,
        )
        .get(input.runId, terminalEvidence.terminalEventSeq) as
        | {
            eventId: string | null;
            schema: string | null;
            seq: number;
            type: string;
            payload: string;
            phase: string | null;
            policyDigest: string | null;
            occurredAt: string;
          }
        | undefined;
      let terminalEvent: RunEvent | undefined;
      if (terminalRow !== undefined) {
        terminalEvent = parseRunEvent({
          schema: terminalRow.schema,
          event_id: terminalRow.eventId,
          run_id: input.runId,
          work_order_id: admission.workOrderId,
          attempt_id: admission.attemptId,
          seq: terminalRow.seq,
          occurred_at: terminalRow.occurredAt,
          type: terminalRow.type,
          phase: terminalRow.phase,
          payload: JSON.parse(terminalRow.payload) as unknown,
          policy_digest: terminalRow.policyDigest,
        });
      }
      const terminalAt =
        terminalEvent === undefined
          ? Number.NaN
          : Date.parse(terminalEvent.occurred_at);
      if (
        terminalEvent === undefined ||
        terminalEvent.seq !== terminalEvidence.terminalEventSeq ||
        terminalEvent.phase !== terminalEvidence.terminalPhase ||
        terminalEvent.policy_digest !== terminalEvidence.policyDigest ||
        terminalEvent.payload["terminal_evidence_bundle_digest"] !==
          terminalEvidence.bundleDigest ||
        !Number.isFinite(terminalAt)
      ) {
        throw RunmillError.fromCatalog("RM-EVID-008", {
          whatHappened: `run ${input.runId} terminal event does not bind its exact signed terminal evidence`,
          runId: input.runId,
        });
      }
      if (this.#clock.now().getTime() - terminalAt < input.minimumAgeMs) {
        throw new Error(
          `ASF run ${input.runId} has not reached its detailed event retention age`,
        );
      }
      const latest = (
        this.#db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?",
          )
          .get(input.runId) as { seq: number }
      ).seq;
      if (latest !== terminalEvidence.terminalEventSeq) {
        throw new Error(
          `ASF run ${input.runId} latest event ${latest} contradicts terminal sequence ` +
            terminalEvidence.terminalEventSeq,
        );
      }
      const deleted = this.#db
        .prepare("DELETE FROM events WHERE run_id = ? AND seq <= ?")
        .run(input.runId, input.through).changes;
      this.#db
        .prepare(
          `UPDATE asf_work_order_admissions
           SET compacted_through = MAX(compacted_through, ?)
           WHERE run_id = ?`,
        )
        .run(input.through, input.runId);
      return deleted;
    });
    return transaction.immediate();
  }

  latestAsfRunEventSequence(runId: string): number {
    if (this.getAsfRun(runId) === undefined)
      throw new Error(`ASF run ${runId} does not exist`);
    return (
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?",
        )
        .get(runId) as { seq: number }
    ).seq;
  }

  transitionHistory(runId: string): { from: string; to: string; at: string }[] {
    return this.#db
      .prepare(
        `SELECT from_state AS "from", to_state AS "to", at
         FROM state_transitions WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId) as { from: string; to: string; at: string }[];
  }

  // -- events ------------------------------------------------------------

  appendEvent(input: {
    runId: string;
    seq: number;
    type: string;
    payload: unknown;
    artifactRef?: string;
  }): void {
    const inserted = this.#db
      .prepare(
        `INSERT INTO events(run_id, seq, type, payload, artifact_ref, at)
         SELECT ?,?,?,?,?,?
         FROM runs WHERE run_id = ? AND mode <> 'asf-worker'`,
      )
      .run(
        input.runId,
        input.seq,
        input.type,
        JSON.stringify(input.payload),
        input.artifactRef ?? null,
        this.#clock.now().toISOString(),
        input.runId,
      );
    if (inserted.changes !== 1) {
      throw new Error(
        `legacy appendEvent cannot write ASF or missing run ${input.runId}`,
      );
    }
  }

  eventsFor(runId: string): { seq: number; type: string; payload: unknown }[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, type, payload FROM events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as { seq: number; type: string; payload: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }

  // -- side-effect outbox -------------------------------------------------

  static sideEffectKey(
    runId: string,
    operation: string,
    target: string,
  ): string {
    return createHash("sha256")
      .update(`${runId} ${operation} ${target}`)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Record the intent to perform an external mutation.
   *
   * Called BEFORE the remote call. A crash between this row and the remote
   * response leaves a durable record naming the run and the operation. New
   * runs block until an operator verifies the remote outcome and resolves it.
   */
  intendSideEffect(input: {
    runId: string;
    system: string;
    operation: string;
    target: string;
  }): string {
    this.#assertNotAsfRun(input.runId, "legacy side-effect intent");
    const key = StateStore.sideEffectKey(
      input.runId,
      input.operation,
      input.target,
    );
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO side_effects(key, run_id, system, operation, target, status, intended_at, updated_at)
         VALUES (?,?,?,?,?,'intended',?,?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(
        key,
        input.runId,
        input.system,
        input.operation,
        input.target,
        at,
        at,
      );
    return key;
  }

  #setSideEffectStatus(
    key: string,
    status: SideEffectStatus,
    patch: { remoteId?: string; lastError?: string } = {},
  ): void {
    this.#db
      .prepare(
        `UPDATE side_effects
         SET status = ?, remote_id = COALESCE(?, remote_id),
             last_error = COALESCE(?, last_error), updated_at = ?
         WHERE key = ?`,
      )
      .run(
        status,
        patch.remoteId ?? null,
        patch.lastError ?? null,
        this.#clock.now().toISOString(),
        key,
      );
  }

  markSideEffectInFlight(key: string): void {
    this.#setSideEffectStatus(key, "in_flight");
  }

  confirmSideEffect(key: string, remoteId?: string): void {
    this.#setSideEffectStatus(
      key,
      "confirmed",
      remoteId === undefined ? {} : { remoteId },
    );
  }

  /** A failed effect stays pending: failure does not prove the effect did not land. */
  failSideEffect(key: string, lastError: string): void {
    this.#setSideEffectStatus(key, "failed", { lastError });
  }

  /** Record an operator/reconciler conclusion for an ambiguous prior effect. */
  resolveSideEffect(
    key: string,
    outcome: "applied" | "not-applied",
    resolver: "operator" | "orchestrator" = "operator",
  ): void {
    const existing = this.getSideEffect(key);
    if (existing === undefined)
      throw new Error(`side effect ${key} does not exist`);
    if (!this.pendingSideEffects().some((effect) => effect.key === key)) {
      throw new Error(
        `side effect ${key} is already resolved as ${existing.status}`,
      );
    }
    // `confirmed` is the terminal outbox status. Preserve how that conclusion
    // was reached in the audit fields instead of extending the persisted enum
    // (and making older databases unreadable without a table rebuild).
    this.#setSideEffectStatus(key, "confirmed", {
      remoteId: `${resolver}:${outcome}`,
      lastError: `${resolver} resolved outcome as ${outcome}`,
    });
  }

  getSideEffect(key: string): SideEffectRow | undefined {
    return this.#db
      .prepare(
        `SELECT key, run_id AS runId, system, operation, target, status,
                remote_id AS remoteId, last_error AS lastError
         FROM side_effects WHERE key = ?`,
      )
      .get(key) as SideEffectRow | undefined;
  }

  /** Everything that blocks new work until explicitly reconciled. */
  pendingSideEffects(): SideEffectRow[] {
    return this.#db
      .prepare(
        `SELECT key, run_id AS runId, system, operation, target, status,
                remote_id AS remoteId, last_error AS lastError
         FROM side_effects
         WHERE status IN ('intended','in_flight','failed')
         ORDER BY intended_at`,
      )
      .all() as SideEffectRow[];
  }

  // -- durable budgets ---------------------------------------------------

  budgetUsage(dayBucket: string, repo: string): BudgetLedgerRow {
    const row = this.#db
      .prepare(
        `SELECT day_bucket AS dayBucket, repo, cost_usd AS costUsd, invocations
         FROM budget_ledger WHERE day_bucket = ? AND repo = ?`,
      )
      .get(dayBucket, repo) as BudgetLedgerRow | undefined;
    return row ?? { dayBucket, repo, costUsd: 0, invocations: 0 };
  }

  /** Add one completed run's observed usage atomically across daemon restarts. */
  recordBudgetUsage(input: {
    dayBucket: string;
    repo: string;
    costUsd: number;
    invocations: number;
  }): BudgetLedgerRow {
    this.#db
      .prepare(
        `INSERT INTO budget_ledger(day_bucket, repo, cost_usd, invocations)
         VALUES (?,?,?,?)
         ON CONFLICT(day_bucket, repo) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           invocations = invocations + excluded.invocations`,
      )
      .run(input.dayBucket, input.repo, input.costUsd, input.invocations);
    return this.budgetUsage(input.dayBucket, input.repo);
  }

  // -- durable non-daily circuit breakers -------------------------------

  /**
   * Read the complete breaker snapshot in one SQLite statement. Version 8
   * seeds exactly three rows; absence, legacy rows, or partial state is
   * corruption rather than an instruction to reset an opened breaker.
   */
  getCircuitBreakerState(): DurableCircuitBreakerState {
    const rows = this.#db
      .prepare(
        `SELECT name, state, opened_at AS openedAt, reason
         FROM circuit_breakers
         ORDER BY name`,
      )
      .all() as CircuitBreakerStorageRow[];

    if (rows.length !== DURABLE_CIRCUIT_BREAKER_NAMES.length) {
      throw circuitBreakerStateError(
        "durable circuit breaker snapshot is missing rows or contains unknown rows",
      );
    }

    let consecutiveFailures: number | undefined;
    let quarantines: number | undefined;
    let escalations: number | undefined;
    let completed: number | undefined;
    const trips: DurableCircuitBreakerTrip[] = [];

    for (const row of rows) {
      if (
        typeof row.name !== "string" ||
        !DURABLE_CIRCUIT_BREAKER_NAME_SET.has(row.name) ||
        typeof row.state !== "string"
      ) {
        throw circuitBreakerStateError(
          "durable circuit breaker snapshot contains an unknown name or non-text state",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.state) as unknown;
      } catch {
        throw circuitBreakerStateError(
          `durable circuit breaker ${row.name} state is not JSON`,
        );
      }
      if (
        !isObjectRecord(parsed) ||
        canonicalJson(parsed as JsonValue) !== row.state
      ) {
        throw circuitBreakerStateError(
          `durable circuit breaker ${row.name} state is not canonical JSON`,
        );
      }

      if (row.name === "escalation-rate") {
        if (
          !hasExactKeys(parsed, ["completed", "escalations", "schema"]) ||
          parsed["schema"] !== CIRCUIT_BREAKER_RATE_SCHEMA
        ) {
          throw circuitBreakerStateError(
            "durable escalation-rate state is malformed",
          );
        }
        assertValidCircuitBreakerCount(parsed["completed"], "completed count");
        assertValidCircuitBreakerCount(
          parsed["escalations"],
          "escalation count",
        );
        completed = parsed["completed"];
        escalations = parsed["escalations"];
      } else {
        if (
          !hasExactKeys(parsed, ["count", "schema"]) ||
          parsed["schema"] !== CIRCUIT_BREAKER_COUNTER_SCHEMA
        ) {
          throw circuitBreakerStateError(
            `durable ${row.name} state is malformed`,
          );
        }
        assertValidCircuitBreakerCount(parsed["count"], `${row.name} count`);
        if (row.name === "consecutive-failures") {
          consecutiveFailures = parsed["count"];
        } else {
          quarantines = parsed["count"];
        }
      }

      const hasOpenedAt = row.openedAt !== null;
      const hasReason = row.reason !== null;
      if (hasOpenedAt !== hasReason) {
        throw circuitBreakerStateError(
          `durable circuit breaker ${row.name} has contradictory trip metadata`,
        );
      }
      if (hasOpenedAt && hasReason) {
        if (
          typeof row.openedAt !== "string" ||
          typeof row.reason !== "string"
        ) {
          throw circuitBreakerStateError(
            `durable circuit breaker ${row.name} trip metadata is not text`,
          );
        }
        trips.push({
          name: row.name as DurableCircuitBreakerName,
          openedAt: row.openedAt,
          reason: row.reason,
        });
      }
    }

    if (
      consecutiveFailures === undefined ||
      quarantines === undefined ||
      escalations === undefined ||
      completed === undefined ||
      trips.length > 1
    ) {
      throw circuitBreakerStateError(
        "durable circuit breaker snapshot is incomplete or has multiple open breakers",
      );
    }

    const result: DurableCircuitBreakerState = {
      consecutiveFailures,
      quarantines,
      escalations,
      completed,
      tripped: trips[0] ?? null,
    };
    assertValidDurableCircuitBreakerState(result);
    return result;
  }

  /**
   * Persist all non-daily counters and the trip atomically. Transitions are
   * checked against the committed snapshot, preventing a stale daemon from
   * rolling counters back or clearing a trip it did not open.
   */
  saveCircuitBreakerState(input: DurableCircuitBreakerState): void {
    assertValidDurableCircuitBreakerState(input);
    const transaction = this.#db.transaction(() => {
      const prior = this.getCircuitBreakerState();
      const sameCounters =
        input.completed === prior.completed &&
        input.consecutiveFailures === prior.consecutiveFailures &&
        input.escalations === prior.escalations &&
        input.quarantines === prior.quarantines;
      const priorTrip =
        prior.tripped === null
          ? null
          : canonicalJson(prior.tripped as unknown as JsonValue);
      const nextTrip =
        input.tripped === null
          ? null
          : canonicalJson(input.tripped as unknown as JsonValue);

      if (prior.tripped !== null && priorTrip !== nextTrip) {
        throw circuitBreakerStateError(
          "an opened durable circuit breaker cannot be reset or changed",
        );
      }

      if (input.completed === prior.completed) {
        if (
          !sameCounters ||
          (prior.tripped !== null && priorTrip !== nextTrip)
        ) {
          throw circuitBreakerStateError(
            "durable circuit breaker counters changed without a completed run",
          );
        }
      } else {
        const completedExactlyOne = input.completed === prior.completed + 1;
        const quarantineDelta = input.quarantines - prior.quarantines;
        const escalationDelta = input.escalations - prior.escalations;
        const failed = quarantineDelta === 1 || escalationDelta === 1;
        const validOutcomeCounters =
          (quarantineDelta === 0 || quarantineDelta === 1) &&
          (escalationDelta === 0 || escalationDelta === 1) &&
          quarantineDelta + escalationDelta <= 1 &&
          input.consecutiveFailures ===
            (failed ? prior.consecutiveFailures + 1 : 0);
        if (!completedExactlyOne || !validOutcomeCounters) {
          throw circuitBreakerStateError(
            "durable circuit breaker update is stale or contradicts one completed run",
          );
        }
      }

      const stateByName: Readonly<Record<DurableCircuitBreakerName, string>> = {
        "consecutive-failures": canonicalJson({
          schema: CIRCUIT_BREAKER_COUNTER_SCHEMA,
          count: input.consecutiveFailures,
        }),
        quarantine: canonicalJson({
          schema: CIRCUIT_BREAKER_COUNTER_SCHEMA,
          count: input.quarantines,
        }),
        "escalation-rate": canonicalJson({
          schema: CIRCUIT_BREAKER_RATE_SCHEMA,
          completed: input.completed,
          escalations: input.escalations,
        }),
      };
      const statement = this.#db.prepare(
        `INSERT INTO circuit_breakers(name, state, opened_at, reason)
         VALUES (?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET
           state = excluded.state,
           opened_at = excluded.opened_at,
           reason = excluded.reason`,
      );
      for (const name of DURABLE_CIRCUIT_BREAKER_NAMES) {
        const isTripped = input.tripped?.name === name;
        statement.run(
          name,
          stateByName[name],
          isTripped ? input.tripped.openedAt : null,
          isTripped ? input.tripped.reason : null,
        );
      }
    });
    transaction.immediate();
  }

  // -- leases ------------------------------------------------------------

  recordLease(input: {
    issueId: string;
    runId: string;
    repo: string;
    generation: number;
    expiresAt: string;
    refName?: string;
    hostId?: string;
    pid?: number;
    bootId?: string;
    priorStateId?: string;
    priorAssigneeId?: string;
  }): void {
    this.#assertNotAsfRun(input.runId, "legacy issue lease");
    const at = this.#clock.now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO leases(issue_id, run_id, repo, generation, ref_name, acquired_at,
                            expires_at, heartbeat_at, host_id, pid, boot_id,
                            prior_state_id, prior_assignee_id, released_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        input.issueId,
        input.runId,
        input.repo,
        input.generation,
        input.refName ?? null,
        at,
        input.expiresAt,
        at,
        input.hostId ?? null,
        input.pid ?? null,
        input.bootId ?? null,
        input.priorStateId ?? null,
        input.priorAssigneeId ?? null,
      );
  }

  getLease(issueId: string): LeaseRow | undefined {
    return this.#db
      .prepare(
        `SELECT issue_id AS issueId, run_id AS runId, repo, generation,
                expires_at AS expiresAt, heartbeat_at AS heartbeatAt, released_at AS releasedAt
         FROM leases WHERE issue_id = ? AND released_at IS NULL`,
      )
      .get(issueId) as LeaseRow | undefined;
  }

  heartbeatLease(issueId: string, runId: string, newExpiresAt: string): void {
    this.#db
      .prepare(
        `UPDATE leases SET heartbeat_at = ?, expires_at = ?
         WHERE issue_id = ? AND run_id = ? AND released_at IS NULL`,
      )
      .run(this.#clock.now().toISOString(), newExpiresAt, issueId, runId);
  }

  releaseLease(issueId: string, runId: string): void {
    this.#db
      .prepare(
        "UPDATE leases SET released_at = ? WHERE issue_id = ? AND run_id = ? AND released_at IS NULL",
      )
      .run(this.#clock.now().toISOString(), issueId, runId);
  }

  // -- onboarding funnel (local only, never transmitted) -----------------

  /** First write wins: a milestone records when something first happened. */
  recordFunnelOnce(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO onboarding_funnel(key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING",
      )
      .run(key, value);
  }

  incrementFunnelCounter(key: string): void {
    this.#db
      .prepare(
        `INSERT INTO onboarding_funnel(key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      )
      .run(key);
  }

  readFunnel(): Record<string, string> {
    const rows = this.#db
      .prepare("SELECT key, value FROM onboarding_funnel")
      .all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * How many runs this issue has already had.
   *
   * The branch template is validated to contain {attempt} so that a retry does
   * not reuse a branch, which only works if something actually counts. Derived
   * from the runs table rather than tracked separately, so it stays true across
   * restarts and cannot drift from the runs it describes.
   */
  attemptsFor(issueId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE issue_id = ? AND mode <> 'asf-worker'",
      )
      .get(issueId) as { n: number };
    return row.n;
  }

  activeLeaseIssueIds(): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT l.issue_id AS issueId
         FROM leases l JOIN runs r ON r.run_id = l.run_id
         WHERE l.released_at IS NULL AND r.mode <> 'asf-worker'`,
      )
      .all() as { issueId: string }[];
    return new Set(rows.map((r) => r.issueId));
  }

  #assertNotAsfRun(runId: string, operation: string): void {
    const row = this.#db
      .prepare("SELECT mode FROM runs WHERE run_id = ?")
      .get(runId) as { mode: string } | undefined;
    if (row?.mode === "asf-worker") {
      throw RunmillError.fromCatalog("RM-LEASE-001", {
        whatHappened:
          `${operation} is not generation-fenced and cannot mutate ASF run ${runId}; ` +
          "use the ASF worker ownership API",
        runId,
      });
    }
  }
}
