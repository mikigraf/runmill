import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import type { AsfDurableRunSnapshot } from "../state/store.js";
import {
  ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
  ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
  type AsfTerminalProviderBudgetEvidence,
  type AsfTerminalPhase,
  type ValidatedAsfTerminalEvidenceBundle,
  asfTerminalEvidenceStatementSchema,
  signAsfTerminalEvidenceBundle,
  validateSignedAsfTerminalEvidenceBundle,
} from "../evidence/asf-terminal.js";
import { IN_TOTO_STATEMENT_V1 } from "../evidence/asf-bundle.js";
import { AsfEvidenceValidationError } from "../evidence/asf-validator.js";
import {
  validateAsfTerminalEffectLedger,
  type AsfTerminalEffectLedger,
} from "../evidence/asf-terminal-effects.js";
import type { AsfEvidenceSigningKey } from "./evidence-signing-config.js";
import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";
import { asfCostLimitUsdToMicros } from "./budget.js";
import type {
  AsfDeliveryBinding,
  AsfDeliveryStageIntent,
} from "./delivery-runner.js";
import {
  assertRunEventTransition,
  parseRunEvent,
  type RunEvent,
  type RunEventPhase,
} from "./run-event.js";
import {
  parseWorkOrderEnvelope,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "./work-order.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);

export interface AsfTerminalStopEvidence {
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
}

export interface AsfTerminalCleanupEvidence {
  readonly schema: "asf.cleanup-observation/v1";
  readonly binding: {
    readonly run_id: string;
    readonly work_order_id: string;
    readonly attempt_id: string;
    readonly policy_digest: string;
    readonly fencing_generation: number;
    readonly candidate_sha: string | null;
  };
  readonly evidence_digest: string;
  readonly identity_leases: "released";
  readonly repository_lease: "released";
  readonly workspace: "removed";
  readonly unresolved_effects: 0;
}

export interface AsfTerminalEvidenceFinalizationInput {
  readonly binding: AsfDeliveryBinding;
  readonly cleanupIntent: AsfDeliveryStageIntent;
  readonly cleanupConfirmedGeneration: number;
  readonly intentMode: "observe-before-apply" | "reconcile-only";
  readonly cleanup: AsfTerminalCleanupEvidence;
  readonly terminalIntentCreatedAt: string;
  readonly snapshot: AsfDurableRunSnapshot;
  readonly envelope: WorkOrderEnvelope;
  readonly effectivePolicy: EffectiveAsfPolicy;
  readonly providerBudget: AsfTerminalProviderBudgetEvidence;
  readonly sideEffects: AsfTerminalEffectLedger;
  readonly events: readonly RunEvent[];
  readonly terminalPhase: AsfTerminalPhase;
  readonly stop: AsfTerminalStopEvidence;
  readonly deliveryBundleDigest: string | null;
  readonly signal: AbortSignal;
}

export interface AsfTerminalEvidenceFinalizationController {
  finalizeTerminal(
    input: AsfTerminalEvidenceFinalizationInput,
  ): Promise<ValidatedAsfTerminalEvidenceBundle>;
}

export interface ProductionAsfTerminalEvidenceFinalizationControllerOptions {
  readonly signingKey: AsfEvidenceSigningKey;
  readonly clock: Clock;
}

function fail(failure: "schema" | "binding" | "missing-evidence", detail: string): never {
  throw new AsfEvidenceValidationError(failure, detail);
}

function collectEvidenceReferences(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    if (
      digestSchema.safeParse(value).success ||
      /^(?:approval|cancellation):[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ) {
      result.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceReferences(item, result);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectEvidenceReferences(item, result);
  }
}

function cancellationEvidence(events: readonly RunEvent[], phase: AsfTerminalPhase) {
  const effective = events
    .filter(
      (event) =>
        event.type === "cancellation.requested" ||
        event.type === "cancellation.escalated",
    )
    .at(-1);
  if (effective === undefined) {
    return phase === "CANCELLED"
      ? fail("missing-evidence", "CANCELLED terminalization has no cancellation request")
      : null;
  }
  const requestId = effective.payload["request_id"];
  const requester = effective.payload["requester"];
  const reason = effective.payload["reason"];
  const mode = effective.payload["mode"];
  const graceSeconds = effective.payload["grace_seconds"];
  if (
    typeof requestId !== "string" ||
    typeof requester !== "string" ||
    typeof reason !== "string" ||
    !/^protected:sha256:[a-f0-9]{64}$/u.test(reason) ||
    (mode !== "graceful" && mode !== "forced") ||
    typeof graceSeconds !== "number" ||
    !Number.isSafeInteger(graceSeconds) ||
    graceSeconds < 0 ||
    graceSeconds > 300 ||
    (mode === "graceful" && graceSeconds < 1) ||
    (mode === "forced" && graceSeconds !== 0)
  ) {
    return fail("schema", "durable cancellation request evidence is malformed");
  }
  return {
    request_id: requestId,
    event_type: effective.type,
    requester_subject: requester,
    reason_digest: reason.slice("protected:".length),
    mode,
    grace_seconds: graceSeconds,
    requested_at: effective.occurred_at,
    event_digest: sha256Digest(effective),
  };
}

function assertInput(
  input: AsfTerminalEvidenceFinalizationInput,
  now: number,
): {
  readonly snapshot: AsfDurableRunSnapshot;
  readonly envelope: WorkOrderEnvelope;
  readonly policy: EffectiveAsfPolicy;
  readonly events: readonly RunEvent[];
  readonly sideEffects: AsfTerminalEffectLedger;
} {
  if (input.signal.aborted) fail("missing-evidence", "terminal evidence finalization was cancelled");
  const snapshot = structuredClone(input.snapshot);
  const envelope = parseWorkOrderEnvelope(structuredClone(input.envelope));
  const policy = structuredClone(input.effectivePolicy);
  const events = input.events.map((event) => parseRunEvent(structuredClone(event)));
  const sideEffects = validateAsfTerminalEffectLedger(
    structuredClone(input.sideEffects),
  );
  const validIntentGeneration =
    input.intentMode === "observe-before-apply"
      ? input.cleanupIntent.fencing_generation === input.binding.fencingGeneration
      : input.cleanupIntent.fencing_generation <= input.binding.fencingGeneration;
  if (
    snapshot.run.mode !== "asf-worker" ||
    snapshot.run.ownerId === null ||
    snapshot.run.ownerId === "" ||
    snapshot.run.stateVersion !== snapshot.latestSequence ||
    snapshot.run.runId !== input.binding.runId ||
    snapshot.run.workOrderId !== input.binding.workOrderId ||
    snapshot.run.attemptId !== input.binding.attemptId ||
    snapshot.run.generation !== input.binding.fencingGeneration ||
    snapshot.run.candidateSha !== input.binding.candidateSha ||
    snapshot.admission.effectivePolicyDigest !== input.binding.policyDigest ||
    input.cleanup.binding.run_id !== input.binding.runId ||
    input.cleanup.binding.work_order_id !== input.binding.workOrderId ||
    input.cleanup.binding.attempt_id !== input.binding.attemptId ||
    input.cleanup.binding.policy_digest !== input.binding.policyDigest ||
    input.cleanup.binding.candidate_sha !== input.binding.candidateSha ||
    input.cleanup.binding.fencing_generation !==
      input.cleanupConfirmedGeneration ||
    !Number.isSafeInteger(input.cleanupConfirmedGeneration) ||
    input.cleanupConfirmedGeneration < input.cleanupIntent.fencing_generation ||
    input.cleanupConfirmedGeneration > input.binding.fencingGeneration ||
    !digestSchema.safeParse(input.cleanup.evidence_digest).success ||
    input.cleanupIntent.schema !== "asf.delivery-stage-intent/v1" ||
    input.cleanupIntent.stage !== "cleanup" ||
    input.cleanupIntent.run_id !== input.binding.runId ||
    input.cleanupIntent.work_order_id !== input.binding.workOrderId ||
    input.cleanupIntent.attempt_id !== input.binding.attemptId ||
    input.cleanupIntent.policy_digest !== input.binding.policyDigest ||
    input.cleanupIntent.candidate_sha !== input.binding.candidateSha ||
    !validIntentGeneration ||
    input.cleanupIntent.event_seq > snapshot.latestSequence
  ) {
    fail("binding", "cleanup or terminal evidence input is stale or exact-bound elsewhere");
  }
  const { intent_digest: intentDigest, ...unsignedIntent } = input.cleanupIntent;
  if (intentDigest !== sha256Digest(unsignedIntent)) {
    fail("binding", "cleanup intent digest is contradictory");
  }
  if (
    events.length !== snapshot.latestSequence ||
    events.some(
      (event, index) =>
        event.seq !== index + 1 ||
        event.run_id !== snapshot.run.runId ||
        event.work_order_id !== snapshot.admission.workOrderId ||
        event.attempt_id !== snapshot.admission.attemptId ||
        event.policy_digest !== snapshot.admission.effectivePolicyDigest,
    )
  ) {
    fail("missing-evidence", "complete uncompacted exact-bound lifecycle events are required");
  }
  let priorPhase: RunEventPhase = "RECEIVED";
  let priorTime = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    try {
      assertRunEventTransition(priorPhase, event);
    } catch {
      fail("binding", "terminal evidence event history contains an invalid transition");
    }
    priorPhase = event.phase;
    const occurredAt = Date.parse(event.occurred_at);
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt < priorTime ||
      occurredAt > now
    ) {
      fail("binding", "terminal evidence event chronology is invalid or in the future");
    }
    priorTime = occurredAt;
  }
  const intentTime = Date.parse(input.cleanupIntent.created_at);
  const terminalIntentTime = Date.parse(input.terminalIntentCreatedAt);
  const admittedAt = Date.parse(snapshot.admission.acceptedAt);
  if (
    priorPhase !== snapshot.run.state ||
    !Number.isFinite(intentTime) ||
    intentTime < priorTime ||
    intentTime > now ||
    !Number.isFinite(terminalIntentTime) ||
    terminalIntentTime < priorTime ||
    terminalIntentTime < intentTime ||
    terminalIntentTime > now ||
    !Number.isFinite(admittedAt) ||
    admittedAt > terminalIntentTime
  ) {
    fail("binding", "terminal evidence cleanup does not follow the exact current lifecycle");
  }
  if (
    envelope.payload.work_order_id !== snapshot.admission.workOrderId ||
    envelope.payload.attempt_id !== snapshot.admission.attemptId ||
    canonicalJson(envelope) !== snapshot.admission.canonicalEnvelope ||
    sha256Digest(envelope) !== snapshot.admission.envelopeDigest ||
    sha256Digest(envelope.payload) !== snapshot.admission.payloadDigest ||
    envelope.payload.repository.repository.toLowerCase() !== snapshot.run.repo.toLowerCase() ||
    envelope.payload.repository.base_sha.toLowerCase() !== snapshot.run.baseCommit
  ) {
    fail("binding", "terminal evidence admission input is contradictory");
  }
  const { digest: policyDigest, ...unsignedPolicy } = policy;
  if (
    policyDigest !== snapshot.admission.effectivePolicyDigest ||
    sha256Digest(unsignedPolicy as unknown as JsonValue) !== policyDigest ||
    canonicalJson(policy as unknown as JsonValue) !== snapshot.admission.effectivePolicy
  ) {
    fail("binding", "terminal evidence policy input is contradictory");
  }
  const providerBudget = input.providerBudget;
  if (
    providerBudget.run_id !== snapshot.run.runId ||
    providerBudget.work_order_id !== snapshot.admission.workOrderId ||
    providerBudget.attempt_id !== snapshot.admission.attemptId ||
    providerBudget.policy_digest !== snapshot.admission.effectivePolicyDigest ||
    providerBudget.candidate_sha !== snapshot.run.candidateSha ||
    providerBudget.usage.max_cost_micros !==
      asfCostLimitUsdToMicros(policy.budgets.maxCostUsd)
  ) {
    fail("binding", "terminal provider budget evidence is stale or contradictory");
  }
  if (
    sideEffects.run_id !== snapshot.run.runId ||
    sideEffects.work_order_id !== snapshot.admission.workOrderId ||
    sideEffects.attempt_id !== snapshot.admission.attemptId ||
    sideEffects.policy_digest !== snapshot.admission.effectivePolicyDigest
  ) {
    fail("binding", "terminal side-effect evidence is stale or contradictory");
  }
  if (
    input.terminalPhase === "COMPLETED" &&
    (!digestSchema.safeParse(input.deliveryBundleDigest).success ||
      input.binding.candidateSha === null)
  ) {
    fail("missing-evidence", "COMPLETED terminalization requires exact delivery evidence");
  }
  return { snapshot, envelope, policy, events, sideEffects };
}

/**
 * Signs a terminalization statement after cleanup confirmation and before the
 * terminal transition. The cleanup intent timestamp makes crash retries
 * byte-identical; the eventual terminal event must carry the returned digest.
 */
export class ProductionAsfTerminalEvidenceFinalizationController
  implements AsfTerminalEvidenceFinalizationController
{
  readonly #options: ProductionAsfTerminalEvidenceFinalizationControllerOptions;

  constructor(options: ProductionAsfTerminalEvidenceFinalizationControllerOptions) {
    this.#options = options;
  }

  async finalizeTerminal(
    input: AsfTerminalEvidenceFinalizationInput,
  ): Promise<ValidatedAsfTerminalEvidenceBundle> {
    const { snapshot, envelope, policy, events, sideEffects } = assertInput(
      input,
      this.#options.clock.now().getTime(),
    );
    const observations = events.map((event) => {
      const refs = new Set<string>();
      collectEvidenceReferences(event.payload, refs);
      const candidate = event.payload["candidate_sha"];
      return {
        event_seq: event.seq,
        event_type: event.type,
        phase: event.phase,
        candidate_sha:
          typeof candidate === "string" && gitShaSchema.safeParse(candidate).success
            ? candidate
            : null,
        event_digest: sha256Digest(event),
        evidence_refs: [...refs].sort(),
      };
    });
    const budgetRefs = new Set<string>();
    for (const event of events.filter((event) => event.type === "budget.exhausted")) {
      collectEvidenceReferences(event.payload, budgetRefs);
    }
    if (input.terminalPhase === "BUDGET_EXHAUSTED") {
      for (const ref of input.stop.evidenceRefs) budgetRefs.add(ref);
    }
    const candidateSha = snapshot.run.candidateSha;
    const subjectSha = candidateSha ?? envelope.payload.repository.base_sha.toLowerCase();
    const statement = asfTerminalEvidenceStatementSchema.parse({
      _type: IN_TOTO_STATEMENT_V1,
      subject: [{ name: `asf-run:${snapshot.run.runId}`, digest: { sha1: subjectSha } }],
      predicateType: ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
      predicate: {
        schema: ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
        run: {
          run_id: snapshot.run.runId,
          work_order_id: snapshot.admission.workOrderId,
          attempt_id: snapshot.admission.attemptId,
          terminal_phase: input.terminalPhase,
          terminal_event_seq: snapshot.latestSequence + 1,
        },
        admission: {
          work_order_envelope_digest: snapshot.admission.envelopeDigest,
          work_order_payload_digest: snapshot.admission.payloadDigest,
          effective_policy_digest: snapshot.admission.effectivePolicyDigest,
          work_order_envelope: envelope,
          signature_verification: {
            verified: true,
            key_id: snapshot.admission.signatureKeyId,
            algorithm: snapshot.admission.signatureAlgorithm,
          },
          effective_policy: policy as unknown as JsonValue,
        },
        source: {
          repository: snapshot.run.repo.toLowerCase(),
          base_sha: envelope.payload.repository.base_sha.toLowerCase(),
          candidate_sha: candidateSha,
          subject_kind: candidateSha === null ? "base" : "candidate",
          subject_sha: subjectSha,
        },
        stop: {
          code: input.stop.code,
          summary: input.stop.summary,
          interrupted_phase: input.stop.interruptedPhase,
          retry_disposition: input.stop.retryDisposition,
          required_actor: input.stop.requiredActor,
          required_action: input.stop.requiredAction,
          evidence_refs: [...new Set(input.stop.evidenceRefs)].sort(),
        },
        cancellation: cancellationEvidence(events, input.terminalPhase),
        budget: {
          wall_seconds_limit: policy.budgets.wallSeconds,
          max_cost_usd: policy.budgets.maxCostUsd,
          max_agent_invocations: policy.budgets.maxAgentInvocations,
          max_fix_iterations: policy.budgets.maxFixIterations,
          observed_fix_iterations: events.filter((event) => event.type === "fixing.started").length,
          evidence_refs: [...budgetRefs].sort(),
          provider_usage: input.providerBudget,
        },
        side_effects: sideEffects,
        timing: {
          admitted_at: snapshot.admission.acceptedAt,
          terminal_evidence_at: input.terminalIntentCreatedAt,
          elapsed_ms:
            Date.parse(input.terminalIntentCreatedAt) -
            Date.parse(snapshot.admission.acceptedAt),
        },
        cleanup: {
          intent_id: input.cleanupIntent.intent_id,
          intent_digest: input.cleanupIntent.intent_digest,
          observation_digest: input.cleanup.evidence_digest,
          identity_leases: input.cleanup.identity_leases,
          repository_lease: input.cleanup.repository_lease,
          workspace: input.cleanup.workspace,
          unresolved_effects: input.cleanup.unresolved_effects,
        },
        evidence: {
          preceding_event_count: events.length,
          preceding_event_chain_digest: sha256Digest(events),
          observations,
          events,
          delivery_bundle_digest: input.deliveryBundleDigest,
        },
      },
    });
    if (input.signal.aborted) fail("missing-evidence", "terminal evidence finalization was cancelled");
    const bundle = signAsfTerminalEvidenceBundle({
      statement,
      keyId: this.#options.signingKey.keyId,
      privateKey: this.#options.signingKey.privateKey,
      issuedAt: input.terminalIntentCreatedAt,
    });
    return validateSignedAsfTerminalEvidenceBundle(bundle, {
      clock: this.#options.clock,
      trustedSigners: [
        {
          keyId: this.#options.signingKey.keyId,
          publicKey: this.#options.signingKey.publicKey,
          validFrom: this.#options.signingKey.validFrom,
          validUntil: this.#options.signingKey.validUntil,
          revokedAt: null,
        },
      ],
      expected: {
        runId: snapshot.run.runId,
        workOrderId: snapshot.admission.workOrderId,
        attemptId: snapshot.admission.attemptId,
        workOrderEnvelopeDigest: snapshot.admission.envelopeDigest,
        workOrderPayloadDigest: snapshot.admission.payloadDigest,
        effectivePolicyDigest: snapshot.admission.effectivePolicyDigest,
        repository: snapshot.run.repo.toLowerCase(),
        baseSha: envelope.payload.repository.base_sha.toLowerCase(),
        candidateSha,
        terminalPhase: input.terminalPhase,
        terminalEventSeq: snapshot.latestSequence + 1,
        cleanupObservationDigest: input.cleanup.evidence_digest,
        deliveryBundleDigest: input.deliveryBundleDigest,
        precedingEventChainDigest: sha256Digest(events),
        providerBudget: input.providerBudget,
        sideEffects,
        admittedAt: snapshot.admission.acceptedAt,
        terminalEvidenceAt: input.terminalIntentCreatedAt,
        elapsedMs:
          Date.parse(input.terminalIntentCreatedAt) -
          Date.parse(snapshot.admission.acceptedAt),
      },
    });
  }
}
