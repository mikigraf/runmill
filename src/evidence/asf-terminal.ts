import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as signBytes,
  verify as verifySignature,
  type KeyLike,
} from "node:crypto";
import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../asf/canonical-json.js";
import { IN_TOTO_STATEMENT_V1 } from "./asf-bundle.js";
import { runEventSchema } from "../asf/run-event.js";
import { workOrderEnvelopeSchema } from "../asf/work-order.js";
import { asfCostLimitUsdToMicros } from "../asf/budget.js";
import {
  AsfEvidenceValidationError,
  type AsfEvidenceValidationFailure,
  type TrustedAsfEvidenceSigner,
} from "./asf-validator.js";
import {
  asfTerminalEffectLedgerSchema,
  type AsfTerminalEffectLedger,
} from "./asf-terminal-effects.js";

export const ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE =
  "https://runmill.dev/attestations/asf-terminal-evidence/v1" as const;
export const ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA =
  "asf.terminal-evidence/v1" as const;
export const ASF_SIGNED_TERMINAL_EVIDENCE_SCHEMA =
  "asf.signed-terminal-evidence/v1" as const;
export const ASF_TERMINAL_EVIDENCE_INTENT_SCHEMA =
  "asf.terminal-evidence-intent/v1" as const;
export const ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA =
  "asf.terminal-evidence-plan/v1" as const;

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
const repositorySchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const evidenceReferenceSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const ASF_TERMINAL_PHASES = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUSED",
  "QUARANTINED",
  "BUDGET_EXHAUSTED",
] as const;

const terminalPhaseSchema = z.enum(ASF_TERMINAL_PHASES);

const availableObservationSchema = z
  .object({
    event_seq: z.number().int().positive().safe(),
    event_type: identifierSchema,
    phase: identifierSchema,
    candidate_sha: gitShaSchema.nullable(),
    event_digest: digestSchema,
    evidence_refs: z.array(evidenceReferenceSchema).max(1_024),
  })
  .strict();

export const asfTerminalStopEvidenceSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    summary: z.string().min(1).max(2_048),
    interrupted_phase: identifierSchema,
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
    evidence_refs: z.array(evidenceReferenceSchema).max(2_048),
  })
  .strict();

export const asfTerminalCleanupObservationSchema = z
  .object({
    schema: z.literal("asf.cleanup-observation/v1"),
    binding: z
      .object({
        run_id: identifierSchema,
        work_order_id: identifierSchema,
        attempt_id: identifierSchema,
        policy_digest: digestSchema,
        fencing_generation: z.number().int().positive().safe(),
        candidate_sha: gitShaSchema.nullable(),
      })
      .strict(),
    evidence_digest: digestSchema,
    identity_leases: z.literal("released"),
    repository_lease: z.literal("released"),
    workspace: z.literal("removed"),
    unresolved_effects: z.literal(0),
  })
  .strict();

export const asfTerminalProviderBudgetEvidenceSchema = z
  .object({
    schema: z.literal("asf.provider-budget-evidence-summary/v1"),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    candidate_sha: gitShaSchema.nullable(),
    usage: z
      .object({
        max_cost_micros: z.number().int().nonnegative().safe(),
        reported_actual_cost_micros: z.number().int().nonnegative().safe(),
        settled_unknown_cost_micros: z.number().int().nonnegative().safe(),
        outstanding_reserved_cost_micros: z.number().int().nonnegative().safe(),
        conservative_cost_micros: z.number().int().nonnegative().safe(),
        invocation_count: z.number().int().nonnegative().safe(),
        completed_invocation_count: z.number().int().nonnegative().safe(),
        settled_unknown_invocation_count: z.number().int().nonnegative().safe(),
        outstanding_invocation_count: z.number().int().nonnegative().safe(),
        denied_count: z.number().int().nonnegative().safe(),
      })
      .strict(),
    invocations: z
      .array(
        z
          .object({
            reservation_id: identifierSchema,
            reservation_digest: digestSchema,
            effect_key: identifierSchema,
            intent_id: identifierSchema,
            intent_digest: digestSchema,
            invocation_id: identifierSchema,
            role: z.enum([
              "implementer",
              "fixer",
              "local-reviewer",
              "pr-reviewer",
            ]),
            lifecycle_candidate_sha: gitShaSchema.nullable(),
            provider_candidate_sha: gitShaSchema,
            initial_generation: z.number().int().positive().safe(),
            completed_generation: z.number().int().positive().safe(),
            status: z.enum(["completed", "settled_unknown"]),
            reserved_cost_micros: z.number().int().nonnegative().safe(),
            charged_cost_micros: z.number().int().nonnegative().safe(),
            attribution_status: z.enum(["reported", "provider_unknown"]),
            provider_result_digest: digestSchema.nullable(),
            provider: identifierSchema.nullable(),
            model: identifierSchema.nullable(),
            principal: identifierSchema.nullable(),
            profile: identifierSchema.nullable(),
            settlement_outcome: z.enum(["confirmed", "not_applied"]).nullable(),
            settlement_observation_digest: digestSchema.nullable(),
            settlement_digest: digestSchema.nullable(),
            completed_at: z.iso.datetime({ offset: true }),
          })
          .strict()
          .superRefine((invocation, context) => {
            const reported = invocation.status === "completed";
            if (
              reported !== (invocation.attribution_status === "reported") ||
              reported !== (invocation.provider_result_digest !== null) ||
              reported !== (invocation.provider !== null) ||
              reported !== (invocation.model !== null) ||
              reported !== (invocation.principal !== null) ||
              reported !== (invocation.profile !== null) ||
              reported === (invocation.settlement_outcome !== null) ||
              reported ===
                (invocation.settlement_observation_digest !== null) ||
              reported === (invocation.settlement_digest !== null) ||
              (!reported &&
                invocation.charged_cost_micros !==
                  invocation.reserved_cost_micros)
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "provider attribution and settlement evidence contradict invocation status",
              });
            }
          }),
      )
      .max(10_000),
    settlement_digests: z.array(digestSchema).max(10_000),
    ledger_digest: digestSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const usage = evidence.usage;
    if (
      usage.conservative_cost_micros !==
      usage.reported_actual_cost_micros +
        usage.settled_unknown_cost_micros +
        usage.outstanding_reserved_cost_micros
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage", "conservative_cost_micros"],
        message: "conservative cost must cover reported, unknown, and outstanding usage",
      });
    }
    if (
      usage.invocation_count !==
      usage.completed_invocation_count +
        usage.settled_unknown_invocation_count +
        usage.outstanding_invocation_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage", "invocation_count"],
        message: "invocation count must cover every charged invocation state",
      });
    }
    if (
      usage.outstanding_reserved_cost_micros !== 0 ||
      usage.outstanding_invocation_count !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage", "outstanding_reserved_cost_micros"],
        message: "terminal provider budget evidence cannot retain outstanding authority",
      });
    }
    const completed = evidence.invocations.filter(
      (invocation) => invocation.status === "completed",
    );
    const settled = evidence.invocations.filter(
      (invocation) => invocation.status === "settled_unknown",
    );
    const sum = (
      invocations: typeof evidence.invocations,
    ): number =>
      invocations.reduce(
        (total, invocation) => total + invocation.charged_cost_micros,
        0,
      );
    if (
      evidence.invocations.length !== usage.invocation_count ||
      completed.length !== usage.completed_invocation_count ||
      settled.length !== usage.settled_unknown_invocation_count ||
      sum(completed) !== usage.reported_actual_cost_micros ||
      sum(settled) !== usage.settled_unknown_cost_micros ||
      evidence.invocations.some((invocation, index) => {
        const previous = evidence.invocations[index - 1];
        return (
          index > 0 &&
          previous !== undefined &&
          invocation.reservation_id <= previous.reservation_id
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["invocations"],
        message: "provider invocations must be sorted and equal aggregate usage",
      });
    }
    const invocationSettlementDigests = settled
      .map((invocation) => invocation.settlement_digest)
      .filter((digest): digest is string => digest !== null)
      .sort();
    if (
      evidence.settlement_digests.length !==
        usage.settled_unknown_invocation_count ||
      canonicalJson(evidence.settlement_digests) !==
        canonicalJson(invocationSettlementDigests) ||
      evidence.settlement_digests.some(
        (digest, index) => {
          const previous = evidence.settlement_digests[index - 1];
          return index > 0 && previous !== undefined && digest <= previous;
        },
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["settlement_digests"],
        message: "settlement digests must be unique, sorted, and complete",
      });
    }
  });

export const asfTerminalTimingEvidenceSchema = z
  .object({
    admitted_at: z.iso.datetime({ offset: true }),
    terminal_evidence_at: z.iso.datetime({ offset: true }),
    elapsed_ms: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((timing, context) => {
    const admittedAt = Date.parse(timing.admitted_at);
    const terminalEvidenceAt = Date.parse(timing.terminal_evidence_at);
    if (
      !Number.isFinite(admittedAt) ||
      !Number.isFinite(terminalEvidenceAt) ||
      terminalEvidenceAt < admittedAt ||
      timing.elapsed_ms !== terminalEvidenceAt - admittedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["elapsed_ms"],
        message: "elapsed time must exactly bind admission through terminal evidence",
      });
    }
  });

export const asfTerminalEvidencePredicateSchema = z
  .object({
    schema: z.literal(ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA),
    run: z
      .object({
        run_id: identifierSchema,
        work_order_id: identifierSchema,
        attempt_id: identifierSchema,
        terminal_phase: terminalPhaseSchema,
        terminal_event_seq: z.number().int().positive().safe(),
      })
      .strict(),
    admission: z
      .object({
        work_order_envelope_digest: digestSchema,
        work_order_payload_digest: digestSchema,
        effective_policy_digest: digestSchema,
        work_order_envelope: workOrderEnvelopeSchema,
        signature_verification: z
          .object({
            verified: z.literal(true),
            key_id: identifierSchema,
            algorithm: z.literal("EdDSA"),
          })
          .strict(),
        effective_policy: z.json(),
      })
      .strict(),
    source: z
      .object({
        repository: repositorySchema,
        base_sha: gitShaSchema,
        candidate_sha: gitShaSchema.nullable(),
        subject_kind: z.enum(["base", "candidate"]),
        subject_sha: gitShaSchema,
      })
      .strict(),
    stop: asfTerminalStopEvidenceSchema,
    cancellation: z
      .object({
        request_id: identifierSchema,
        event_type: z.enum(["cancellation.requested", "cancellation.escalated"]),
        requester_subject: identifierSchema,
        reason_digest: digestSchema,
        mode: z.enum(["graceful", "forced"]),
        grace_seconds: z.number().int().min(0).max(300),
        requested_at: z.iso.datetime({ offset: true }),
        event_digest: digestSchema,
      })
      .strict()
      .nullable(),
    budget: z
      .object({
        wall_seconds_limit: z.number().int().nonnegative().safe(),
        max_cost_usd: z.number().finite().nonnegative(),
        max_agent_invocations: z.number().int().nonnegative().safe(),
        max_fix_iterations: z.number().int().nonnegative().safe(),
        observed_fix_iterations: z.number().int().nonnegative().safe(),
        evidence_refs: z.array(evidenceReferenceSchema).max(2_048),
        provider_usage: asfTerminalProviderBudgetEvidenceSchema,
      })
      .strict(),
    side_effects: asfTerminalEffectLedgerSchema,
    timing: asfTerminalTimingEvidenceSchema,
    cleanup: z
      .object({
        intent_id: identifierSchema,
        intent_digest: digestSchema,
        observation_digest: digestSchema,
        identity_leases: z.literal("released"),
        repository_lease: z.literal("released"),
        workspace: z.literal("removed"),
        unresolved_effects: z.literal(0),
      })
      .strict(),
    evidence: z
      .object({
        preceding_event_count: z.number().int().positive().safe(),
        preceding_event_chain_digest: digestSchema,
        observations: z.array(availableObservationSchema).max(10_000),
        events: z.array(runEventSchema).max(10_000),
        delivery_bundle_digest: digestSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((predicate, context) => {
    const expectedSubject =
      predicate.source.candidate_sha === null
        ? { kind: "base", sha: predicate.source.base_sha }
        : { kind: "candidate", sha: predicate.source.candidate_sha };
    if (
      predicate.source.subject_kind !== expectedSubject.kind ||
      predicate.source.subject_sha !== expectedSubject.sha
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "subject_sha"],
        message: "subject must truthfully name the candidate or admitted base",
      });
    }
    if (
      predicate.run.terminal_phase === "CANCELLED" &&
      predicate.cancellation === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["cancellation"],
        message: "cancellation evidence is required for CANCELLED",
      });
    }
    if (
      predicate.run.terminal_phase === "COMPLETED" &&
      predicate.evidence.delivery_bundle_digest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "delivery_bundle_digest"],
        message: "COMPLETED evidence must chain the immutable delivery bundle",
      });
    }
    if (
      predicate.budget.provider_usage.run_id !== predicate.run.run_id ||
      predicate.budget.provider_usage.work_order_id !==
        predicate.run.work_order_id ||
      predicate.budget.provider_usage.attempt_id !== predicate.run.attempt_id ||
      predicate.budget.provider_usage.policy_digest !==
        predicate.admission.effective_policy_digest ||
      predicate.budget.provider_usage.candidate_sha !==
        predicate.source.candidate_sha ||
      predicate.budget.provider_usage.usage.max_cost_micros !==
        asfCostLimitUsdToMicros(predicate.budget.max_cost_usd)
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget", "provider_usage"],
        message: "provider budget evidence must bind the terminal run",
      });
    }
    if (
      predicate.side_effects.run_id !== predicate.run.run_id ||
      predicate.side_effects.work_order_id !== predicate.run.work_order_id ||
      predicate.side_effects.attempt_id !== predicate.run.attempt_id ||
      predicate.side_effects.policy_digest !==
        predicate.admission.effective_policy_digest
    ) {
      context.addIssue({
        code: "custom",
        path: ["side_effects"],
        message: "terminal side-effect ledger must bind the terminal run",
      });
    }
    const envelope = predicate.admission.work_order_envelope;
    const policy = predicate.admission.effective_policy;
    if (
      sha256Digest(envelope) !==
        predicate.admission.work_order_envelope_digest ||
      sha256Digest(envelope.payload) !==
        predicate.admission.work_order_payload_digest ||
      envelope.key_id !==
        predicate.admission.signature_verification.key_id ||
      envelope.algorithm !==
        predicate.admission.signature_verification.algorithm ||
      !isJsonObject(policy)
    ) {
      context.addIssue({
        code: "custom",
        path: ["admission"],
        message: "portable admission evidence is incomplete or contradictory",
      });
    } else {
      const { digest } = policy;
      if (digest !== predicate.admission.effective_policy_digest) {
        context.addIssue({
          code: "custom",
          path: ["admission", "effective_policy"],
          message: "portable effective policy digest is contradictory",
        });
      }
    }
  });

export const asfTerminalEvidenceIntentSchema = z
  .object({
    schema: z.literal(ASF_TERMINAL_EVIDENCE_INTENT_SCHEMA),
    run: z
      .object({
        run_id: identifierSchema,
        work_order_id: identifierSchema,
        attempt_id: identifierSchema,
        terminal_phase: terminalPhaseSchema,
        terminal_event_seq: z.number().int().positive().safe(),
      })
      .strict(),
    admission: z
      .object({
        work_order_envelope_digest: digestSchema,
        work_order_payload_digest: digestSchema,
        effective_policy_digest: digestSchema,
      })
      .strict(),
    source: z
      .object({
        repository: repositorySchema,
        base_sha: gitShaSchema,
        candidate_sha: gitShaSchema.nullable(),
      })
      .strict(),
    stop: asfTerminalStopEvidenceSchema,
    provider_budget: asfTerminalProviderBudgetEvidenceSchema,
    side_effects: asfTerminalEffectLedgerSchema,
    timing: asfTerminalTimingEvidenceSchema,
    cleanup: z
      .object({
        intent_id: identifierSchema,
        intent_digest: digestSchema,
        observation: asfTerminalCleanupObservationSchema,
      })
      .strict(),
    delivery_bundle_digest: digestSchema.nullable(),
    plan_digest: digestSchema,
    created_at: z.iso.datetime({ offset: true }),
    intent_digest: digestSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.run.terminal_phase === "COMPLETED" &&
      intent.delivery_bundle_digest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery_bundle_digest"],
        message: "COMPLETED intent must bind delivery evidence",
      });
    }
    if (
      intent.provider_budget.run_id !== intent.run.run_id ||
      intent.provider_budget.work_order_id !== intent.run.work_order_id ||
      intent.provider_budget.attempt_id !== intent.run.attempt_id ||
      intent.provider_budget.policy_digest !==
        intent.admission.effective_policy_digest ||
      intent.provider_budget.candidate_sha !== intent.source.candidate_sha ||
      intent.side_effects.run_id !== intent.run.run_id ||
      intent.side_effects.work_order_id !== intent.run.work_order_id ||
      intent.side_effects.attempt_id !== intent.run.attempt_id ||
      intent.side_effects.policy_digest !==
        intent.admission.effective_policy_digest ||
      intent.timing.terminal_evidence_at !== intent.created_at
    ) {
      context.addIssue({
        code: "custom",
        path: ["provider_budget"],
        message: "terminal intent budget or timing does not bind the terminal run",
      });
    }
    const { intent_digest: intentDigest, ...unsigned } = intent;
    if (
      intentDigest !== sha256Digest(unsigned)
    ) {
      context.addIssue({
        code: "custom",
        path: ["intent_digest"],
        message: "terminal evidence intent digest is contradictory",
      });
    }
  });

export const asfTerminalEvidencePlanSchema = z
  .object({
    schema: z.literal(ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA),
    run: z
      .object({
        run_id: identifierSchema,
        work_order_id: identifierSchema,
        attempt_id: identifierSchema,
        terminal_phase: terminalPhaseSchema,
        terminal_event_seq: z.number().int().positive().safe(),
      })
      .strict(),
    admission: z
      .object({
        work_order_envelope_digest: digestSchema,
        work_order_payload_digest: digestSchema,
        effective_policy_digest: digestSchema,
      })
      .strict(),
    source: z
      .object({
        repository: repositorySchema,
        base_sha: gitShaSchema,
        candidate_sha: gitShaSchema.nullable(),
      })
      .strict(),
    stop: asfTerminalStopEvidenceSchema,
    provider_budget: asfTerminalProviderBudgetEvidenceSchema,
    side_effects: asfTerminalEffectLedgerSchema,
    cleanup: z
      .object({
        identity_leases: z.literal("released"),
        repository_lease: z.literal("released"),
        workspace: z.literal("removed"),
        unresolved_effects: z.literal(0),
      })
      .strict(),
    delivery_bundle_digest: digestSchema.nullable(),
    created_at: z.iso.datetime({ offset: true }),
    plan_digest: digestSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.run.terminal_phase === "COMPLETED" &&
      plan.delivery_bundle_digest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery_bundle_digest"],
        message: "COMPLETED plan must bind delivery evidence",
      });
    }
    if (
      plan.provider_budget.run_id !== plan.run.run_id ||
      plan.provider_budget.work_order_id !== plan.run.work_order_id ||
      plan.provider_budget.attempt_id !== plan.run.attempt_id ||
      plan.provider_budget.policy_digest !==
        plan.admission.effective_policy_digest ||
      plan.provider_budget.candidate_sha !== plan.source.candidate_sha
      || plan.side_effects.run_id !== plan.run.run_id
      || plan.side_effects.work_order_id !== plan.run.work_order_id
      || plan.side_effects.attempt_id !== plan.run.attempt_id
      || plan.side_effects.policy_digest !==
        plan.admission.effective_policy_digest
    ) {
      context.addIssue({
        code: "custom",
        path: ["provider_budget"],
        message: "terminal plan provider budget does not bind the terminal run",
      });
    }
    const { plan_digest: planDigest, ...unsigned } = plan;
    if (planDigest !== sha256Digest(unsigned)) {
      context.addIssue({
        code: "custom",
        path: ["plan_digest"],
        message: "terminal evidence plan digest is contradictory",
      });
    }
  });

export const asfTerminalEvidenceStatementSchema = z
  .object({
    _type: z.literal(IN_TOTO_STATEMENT_V1),
    subject: z
      .array(
        z
          .object({
            name: z.string().regex(/^asf-run:[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
            digest: z.object({ sha1: gitShaSchema }).strict(),
          })
          .strict(),
      )
      .length(1),
    predicateType: z.literal(ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE),
    predicate: asfTerminalEvidencePredicateSchema,
  })
  .strict();

export const signedAsfTerminalEvidenceBundleSchema = z
  .object({
    schema: z.literal(ASF_SIGNED_TERMINAL_EVIDENCE_SCHEMA),
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
    issued_at: z.iso.datetime({ offset: true }),
    bundle_digest: digestSchema,
    statement: asfTerminalEvidenceStatementSchema,
    signature: z.string().regex(/^base64url:[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type AsfTerminalPhase = z.infer<typeof terminalPhaseSchema>;
export type AsfTerminalEvidenceIntent = z.infer<
  typeof asfTerminalEvidenceIntentSchema
>;
export type AsfTerminalEvidencePlan = z.infer<
  typeof asfTerminalEvidencePlanSchema
>;
export type AsfTerminalCleanupObservation = z.infer<
  typeof asfTerminalCleanupObservationSchema
>;
export type AsfTerminalProviderBudgetEvidence = z.infer<
  typeof asfTerminalProviderBudgetEvidenceSchema
>;
export type AsfTerminalTimingEvidence = z.infer<
  typeof asfTerminalTimingEvidenceSchema
>;
export type { AsfTerminalEffectLedger };
export type AsfTerminalEvidencePredicate = z.infer<
  typeof asfTerminalEvidencePredicateSchema
>;
export type AsfTerminalEvidenceStatement = z.infer<
  typeof asfTerminalEvidenceStatementSchema
>;
export type SignedAsfTerminalEvidenceBundle = z.infer<
  typeof signedAsfTerminalEvidenceBundleSchema
>;

export interface AsfTerminalProviderBudgetEvidenceSource {
  readonly schema: "asf.provider-budget-evidence-summary/v1";
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly candidateSha: string | null;
  readonly usage: {
    readonly maxCostMicros: number;
    readonly reportedActualCostMicros: number;
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
    readonly role: "implementer" | "fixer" | "local-reviewer" | "pr-reviewer";
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

export function portableAsfTerminalProviderBudgetEvidence(
  source: AsfTerminalProviderBudgetEvidenceSource,
): AsfTerminalProviderBudgetEvidence {
  return asfTerminalProviderBudgetEvidenceSchema.parse({
    schema: source.schema,
    run_id: source.runId,
    work_order_id: source.workOrderId,
    attempt_id: source.attemptId,
    policy_digest: source.policyDigest,
    candidate_sha: source.candidateSha,
    usage: {
      max_cost_micros: source.usage.maxCostMicros,
      reported_actual_cost_micros: source.usage.reportedActualCostMicros,
      settled_unknown_cost_micros: source.usage.settledUnknownCostMicros,
      outstanding_reserved_cost_micros:
        source.usage.outstandingReservedCostMicros,
      conservative_cost_micros: source.usage.conservativeCostMicros,
      invocation_count: source.usage.invocationCount,
      completed_invocation_count: source.usage.completedInvocationCount,
      settled_unknown_invocation_count:
        source.usage.settledUnknownInvocationCount,
      outstanding_invocation_count: source.usage.outstandingInvocationCount,
      denied_count: source.usage.deniedCount,
    },
    invocations: source.invocations.map((invocation) => ({
      reservation_id: invocation.reservationId,
      reservation_digest: invocation.reservationDigest,
      effect_key: invocation.effectKey,
      intent_id: invocation.intentId,
      intent_digest: invocation.intentDigest,
      invocation_id: invocation.invocationId,
      role: invocation.role,
      lifecycle_candidate_sha: invocation.lifecycleCandidateSha,
      provider_candidate_sha: invocation.providerCandidateSha,
      initial_generation: invocation.initialGeneration,
      completed_generation: invocation.completedGeneration,
      status: invocation.status,
      reserved_cost_micros: invocation.reservedCostMicros,
      charged_cost_micros: invocation.chargedCostMicros,
      attribution_status: invocation.attributionStatus,
      provider_result_digest: invocation.providerResultDigest,
      provider: invocation.provider,
      model: invocation.model,
      principal: invocation.principal,
      profile: invocation.profile,
      settlement_outcome: invocation.settlementOutcome,
      settlement_observation_digest: invocation.settlementObservationDigest,
      settlement_digest: invocation.settlementDigest,
      completed_at: invocation.completedAt,
    })),
    settlement_digests: [...source.settlementDigests],
    ledger_digest: source.ledgerDigest,
  });
}

export interface AsfTerminalEvidenceExpectations {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly workOrderEnvelopeDigest: string;
  readonly workOrderPayloadDigest: string;
  readonly effectivePolicyDigest: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly candidateSha: string | null;
  readonly terminalPhase: AsfTerminalPhase;
  readonly terminalEventSeq: number;
  readonly cleanupObservationDigest: string;
  readonly deliveryBundleDigest: string | null;
  readonly precedingEventChainDigest: string;
  readonly providerBudget: AsfTerminalProviderBudgetEvidence;
  readonly sideEffects: AsfTerminalEffectLedger;
  readonly admittedAt: string;
  readonly terminalEvidenceAt: string;
  readonly elapsedMs: number;
}

export interface ValidatedAsfTerminalEvidenceBundle {
  readonly bundle: SignedAsfTerminalEvidenceBundle;
  readonly bundleDigest: string;
  readonly candidateSha: string | null;
  readonly terminalPhase: AsfTerminalPhase;
  readonly terminalEventSeq: number;
  readonly signer: {
    readonly keyId: string;
    readonly algorithm: "EdDSA";
    readonly verified: true;
  };
}

function fail(failure: AsfEvidenceValidationFailure, detail: string): never {
  throw new AsfEvidenceValidationError(failure, detail);
}

function parseInstant(
  value: string,
  label: string,
  failure: AsfEvidenceValidationFailure,
): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(failure, `${label} is not a valid timestamp`);
  return timestamp;
}

export function asfTerminalEvidenceSigningPayload(
  bundle: SignedAsfTerminalEvidenceBundle,
): string {
  const { signature: _signature, ...unsigned } = bundle;
  return canonicalJson(unsigned);
}

export function signAsfTerminalEvidenceBundle(input: {
  readonly statement: AsfTerminalEvidenceStatement;
  readonly keyId: string;
  readonly privateKey: KeyLike;
  readonly issuedAt: string;
}): SignedAsfTerminalEvidenceBundle {
  const statement = asfTerminalEvidenceStatementSchema.parse(input.statement);
  const unsigned = {
    schema: ASF_SIGNED_TERMINAL_EVIDENCE_SCHEMA,
    key_id: identifierSchema.parse(input.keyId),
    algorithm: "EdDSA" as const,
    issued_at: z.iso.datetime({ offset: true }).parse(input.issuedAt),
    bundle_digest: sha256Digest(statement),
    statement,
  };
  const key =
    input.privateKey instanceof KeyObject
      ? input.privateKey
      : createPrivateKey(input.privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("ASF terminal evidence signing requires a private Ed25519 key");
  }
  const signature = signBytes(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    key,
  ).toString("base64url");
  return signedAsfTerminalEvidenceBundleSchema.parse({
    ...unsigned,
    signature: `base64url:${signature}`,
  });
}

function verifySigner(
  bundle: SignedAsfTerminalEvidenceBundle,
  clock: Clock,
  trustedSigners: readonly TrustedAsfEvidenceSigner[],
): void {
  const matches = trustedSigners.filter((signer) => signer.keyId === bundle.key_id);
  if (matches.length !== 1) {
    fail(
      "trust",
      matches.length === 0
        ? `signer ${JSON.stringify(bundle.key_id)} is unknown`
        : `signer ${JSON.stringify(bundle.key_id)} has contradictory trust entries`,
    );
  }
  const signer = matches[0];
  if (signer === undefined) fail("trust", "trusted signer lookup failed");
  if (signer.revokedAt !== undefined && signer.revokedAt !== null) {
    parseInstant(signer.revokedAt, "signer revocation", "trust");
    fail("trust", `signer ${JSON.stringify(bundle.key_id)} is revoked`);
  }
  const issuedAt = parseInstant(bundle.issued_at, "bundle issuance", "schema");
  const validFrom = parseInstant(signer.validFrom, "signer validFrom", "trust");
  const validUntil = parseInstant(signer.validUntil, "signer validUntil", "trust");
  if (
    validFrom >= validUntil ||
    issuedAt < validFrom ||
    issuedAt >= validUntil ||
    issuedAt > clock.now().getTime()
  ) {
    fail("trust", "terminal evidence signing time is outside the trusted key window");
  }
  const encoded = bundle.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== encoded) {
    fail("signature", "signature is not canonical Ed25519 base64url");
  }
  try {
    const publicKey =
      signer.publicKey instanceof KeyObject
        ? signer.publicKey
        : createPublicKey(signer.publicKey);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      fail("trust", "trusted terminal evidence signer must be a public Ed25519 key");
    }
    if (
      !verifySignature(
        null,
        Buffer.from(asfTerminalEvidenceSigningPayload(bundle), "utf8"),
        publicKey,
        signature,
      )
    ) {
      fail("signature", "Ed25519 signature verification returned false");
    }
  } catch (error) {
    if (error instanceof AsfEvidenceValidationError) throw error;
    fail("signature", "Ed25519 signature verification could not be completed");
  }
}

/** Independently verify the portable terminal statement against controller facts. */
export function validateSignedAsfTerminalEvidenceBundle(
  raw: unknown,
  options: {
    readonly clock: Clock;
    readonly trustedSigners: readonly TrustedAsfEvidenceSigner[];
    readonly expected: AsfTerminalEvidenceExpectations;
  },
): ValidatedAsfTerminalEvidenceBundle {
  const parsed = signedAsfTerminalEvidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      "schema",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }
  const bundle = parsed.data;
  if (bundle.bundle_digest !== sha256Digest(bundle.statement)) {
    fail("digest", "bundle digest does not match the canonical terminal statement");
  }
  verifySigner(bundle, options.clock, options.trustedSigners);
  const predicate = bundle.statement.predicate;
  const expected = options.expected;
  const bindings: readonly [unknown, unknown, string][] = [
    [predicate.run.run_id, expected.runId, "run id"],
    [predicate.run.work_order_id, expected.workOrderId, "Work Order id"],
    [predicate.run.attempt_id, expected.attemptId, "attempt id"],
    [predicate.run.terminal_phase, expected.terminalPhase, "terminal phase"],
    [predicate.run.terminal_event_seq, expected.terminalEventSeq, "terminal event sequence"],
    [predicate.admission.work_order_envelope_digest, expected.workOrderEnvelopeDigest, "Work Order envelope"],
    [predicate.admission.work_order_payload_digest, expected.workOrderPayloadDigest, "Work Order payload"],
    [predicate.admission.effective_policy_digest, expected.effectivePolicyDigest, "effective policy"],
    [predicate.source.repository, expected.repository, "repository"],
    [predicate.source.base_sha, expected.baseSha, "base SHA"],
    [predicate.source.candidate_sha, expected.candidateSha, "candidate SHA"],
    [predicate.cleanup.observation_digest, expected.cleanupObservationDigest, "cleanup observation"],
    [predicate.evidence.delivery_bundle_digest, expected.deliveryBundleDigest, "delivery evidence chain"],
    [predicate.evidence.preceding_event_chain_digest, expected.precedingEventChainDigest, "event chain"],
    [canonicalJson(predicate.budget.provider_usage), canonicalJson(expected.providerBudget), "provider budget ledger"],
    [canonicalJson(predicate.side_effects), canonicalJson(expected.sideEffects), "side-effect ledger"],
    [predicate.timing.admitted_at, expected.admittedAt, "admission time"],
    [predicate.timing.terminal_evidence_at, expected.terminalEvidenceAt, "terminal evidence time"],
    [predicate.timing.elapsed_ms, expected.elapsedMs, "terminal elapsed time"],
  ];
  for (const [actual, authoritative, label] of bindings) {
    if (actual !== authoritative) {
      fail("binding", `${label} does not match authoritative terminal state`);
    }
  }
  const subject = bundle.statement.subject[0];
  if (
    subject === undefined ||
    subject.name !== `asf-run:${expected.runId}` ||
    subject.digest.sha1 !== predicate.source.subject_sha
  ) {
    fail("binding", "in-toto subject does not match the run's truthful commit subject");
  }
  if (
    predicate.evidence.preceding_event_count + 1 !==
    predicate.run.terminal_event_seq
  ) {
    fail("binding", "terminal sequence does not immediately follow the signed event chain");
  }
  const sequences = predicate.evidence.observations.map((item) => item.event_seq);
  const events = predicate.evidence.events;
  if (
    sequences.length !== predicate.evidence.preceding_event_count ||
    events.length !== predicate.evidence.preceding_event_count ||
    sequences.some((sequence, index) => sequence !== index + 1) ||
    events.some((event, index) => event.seq !== index + 1) ||
    sha256Digest(events) !== predicate.evidence.preceding_event_chain_digest ||
    predicate.evidence.observations.some((observation, index) => {
      const event = events[index];
      if (event === undefined) return true;
      const candidate = event.payload["candidate_sha"];
      return (
        observation.event_seq !== event.seq ||
        observation.event_type !== event.type ||
        observation.phase !== event.phase ||
        observation.candidate_sha !==
          (typeof candidate === "string" && gitShaSchema.safeParse(candidate).success
            ? candidate
            : null) ||
        observation.event_digest !== sha256Digest(event)
      );
    })
  ) {
    fail("binding", "available evidence observations do not exactly cover events 1 through N");
  }
  if (bundle.issued_at !== predicate.timing.terminal_evidence_at) {
    fail("binding", "terminal evidence timing does not match its signed issuance time");
  }
  return {
    bundle,
    bundleDigest: bundle.bundle_digest,
    candidateSha: predicate.source.candidate_sha,
    terminalPhase: predicate.run.terminal_phase,
    terminalEventSeq: predicate.run.terminal_event_seq,
    signer: { keyId: bundle.key_id, algorithm: "EdDSA", verified: true },
  };
}
