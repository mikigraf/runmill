import { z } from "zod";
import {
  ASF_REQUIRED_IDENTITY_ROLES,
  asfIdentityLeaseAttributionSchema,
} from "./identity-attribution.js";

export const RUN_EVENT_SCHEMA = "asf.run-event/v1" as const;

/** Every concrete lifecycle phase named by the ASF worker PRD. */
export const RUN_EVENT_PHASES = [
  "RECEIVED",
  "ADMITTED",
  "REPOSITORY_LEASED",
  "IDENTITY_READY",
  "WORKSPACE_READY",
  "TASK_PACKET_READY",
  "IMPLEMENTING",
  "CANDIDATE_READY",
  "LOCAL_VERIFY",
  "LOCAL_REVIEW",
  "FIXING",
  "DELIVERY_READY",
  "PUSHED",
  "PR_OPEN",
  "CI_WAIT",
  "PR_REVIEW",
  "PR_DELIVERED",
  "MERGE_QUEUE_WAIT",
  "MERGE_READY",
  "MERGED",
  "EVIDENCE_FINALIZED",
  "COMPLETED",
  "CANCEL_REQUESTED",
  "CANCELLING",
  "WAITING_APPROVAL",
  "NEEDS_SPEC",
  "BLOCKED_EXTERNAL",
  "BUDGET_EXHAUSTED",
  "REFUSED",
  "QUARANTINED",
  "CANCELLED",
  "FAILED",
] as const;

export const runEventPhaseSchema = z.enum(RUN_EVENT_PHASES);
export type RunEventPhase = z.infer<typeof runEventPhaseSchema>;

/** Terminal persisted outcomes. One table is shared by recovery and fencing. */
export const TERMINAL_RUN_EVENT_PHASES = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUSED",
  "QUARANTINED",
  "BUDGET_EXHAUSTED",
] as const satisfies readonly RunEventPhase[];

const TERMINAL_PHASE_SET: ReadonlySet<string> = new Set(TERMINAL_RUN_EVENT_PHASES);

export function isTerminalRunEventPhase(phase: string): boolean {
  return TERMINAL_PHASE_SET.has(phase);
}

const identifierSchema = z.string().min(1);
const eventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u,
    "must be a dotted lower-case identifier",
  );
const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "must be a tagged lower-case SHA-256 digest");
const payloadSchema = z.record(z.string(), z.json());
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u, "must be a lower-case Git SHA");
const repositoryNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const evidenceDigestSchema = digestSchema;
const evidenceRefsSchema = z.array(z.string().min(1).max(1_024));

const stopPayloadSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    summary: z.string().min(1).max(2_048),
    checkpoint: runEventPhaseSchema,
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
    evidence_refs: evidenceRefsSchema,
    candidate_sha: gitShaSchema.optional(),
  })
  .strict();

const reconciliationBlockContinuationSchema = z
  .object({
    schema: z.literal("asf.reconciliation-continuation/v1"),
    disposition: z.enum(["retry-interrupted-phase", "finish-cancellation"]),
    interrupted_event_seq: z.number().int().positive().safe(),
    resume_phase: runEventPhaseSchema,
    checkpoint_digest: evidenceDigestSchema,
    pending_set_digest: evidenceDigestSchema,
    cancellation_event_id: identifierSchema.optional(),
    cancellation_event_digest: evidenceDigestSchema.optional(),
    cancellation_request_id: identifierSchema.optional(),
  })
  .strict();

const blockedExternalPayloadSchema = stopPayloadSchema
  .extend({
    /**
     * Present only when the orchestrator captured an exact unresolved-effect
     * set and a durable checkpoint in the same transaction as the pause.
     * Legacy and policy/manual blocks omit it and can never auto-resume.
     */
    continuation: reconciliationBlockContinuationSchema.optional(),
  })
  .strict();

const approvalStopPayloadSchema = stopPayloadSchema
  .extend({
    decision_type: identifierSchema.optional(),
    requested_effect: identifierSchema.optional(),
  })
  .strict();

const cancellationPayloadSchema = stopPayloadSchema
  .extend({
    request_id: identifierSchema,
    requester: identifierSchema,
    reason: z.string().min(1).max(2_048),
    mode: z.enum(["graceful", "forced"]),
    grace_seconds: z.number().int().nonnegative(),
    reconciliation_origin: z
      .enum([
        "none",
        "preexisting",
        "durable-effects",
        "forced-cancellation-cleanup",
      ])
      .optional(),
  })
  .strict();

const terminalStopPayloadSchema = stopPayloadSchema
  .extend({ terminal_evidence_bundle_digest: evidenceDigestSchema.optional() })
  .strict();

const terminalCancellationPayloadSchema = cancellationPayloadSchema
  .extend({ terminal_evidence_bundle_digest: evidenceDigestSchema.optional() })
  .strict();

interface RunEventContract {
  readonly phase: RunEventPhase | "resume-phase-from-payload";
  readonly payload: z.ZodType<Record<string, unknown>>;
}

function candidatePayload<const Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<{
  candidate_sha: typeof gitShaSchema;
} & Shape> {
  return z.object({ candidate_sha: gitShaSchema, ...shape }).strict();
}

/**
 * Versioned public event vocabulary. Unknown dotted event names are refused:
 * adding one is a schema change, not an unreviewed extension point.
 */
const RUN_EVENT_CONTRACTS: Readonly<Record<string, RunEventContract>> = {
  "work_order.admitted": {
    phase: "ADMITTED",
    payload: z
      .object({
        work_order_id: identifierSchema,
        attempt_id: identifierSchema,
        tenant_id: identifierSchema,
        payload_digest: digestSchema,
        envelope_digest: digestSchema,
        signature: z
          .object({
            verified: z.literal(true),
            key_id: identifierSchema,
            algorithm: z.literal("EdDSA"),
          })
          .strict(),
      })
      .strict(),
  },
  "repository.lease_acquired": {
    phase: "REPOSITORY_LEASED",
    payload: z
      .object({ repository: repositoryNameSchema, generation: z.number().int().positive() })
      .strict(),
  },
  "identity.leases_acquired": {
    phase: "IDENTITY_READY",
    payload: z
      .object({
        attributions_digest: evidenceDigestSchema,
        roles: z
          .array(z.enum(ASF_REQUIRED_IDENTITY_ROLES))
          .length(3)
          .refine((roles) => new Set(roles).size === 3, "must contain each required role once"),
        attributions: z.array(asfIdentityLeaseAttributionSchema).length(3),
      })
      .strict(),
  },
  "workspace.prepared": {
    phase: "WORKSPACE_READY",
    payload: z
      .object({
        workspace_id: identifierSchema,
        sandbox_profile: identifierSchema,
        isolation_evidence_digest: evidenceDigestSchema,
      })
      .strict(),
  },
  "task_packet.created": {
    phase: "TASK_PACKET_READY",
    payload: z
      .object({ task_packet_digest: evidenceDigestSchema, source_snapshot_digest: digestSchema })
      .strict(),
  },
  "implementation.started": {
    phase: "IMPLEMENTING",
    payload: z
      .object({ session: z.enum(["new", "resumed"]), checkpoint_digest: evidenceDigestSchema })
      .strict(),
  },
  "candidate.created": {
    phase: "CANDIDATE_READY",
    payload: candidatePayload({
      parent_sha: gitShaSchema,
      tree_digest: evidenceDigestSchema,
    }),
  },
  "verification.started": {
    phase: "LOCAL_VERIFY",
    payload: candidatePayload({ required_check_ids: z.array(identifierSchema) }),
  },
  "verification.completed": {
    phase: "LOCAL_VERIFY",
    payload: candidatePayload({
      check_id: identifierSchema,
      outcome: z.enum(["passed", "failed", "blocked"]),
      evidence_digest: evidenceDigestSchema,
    }),
  },
  "review.started": {
    phase: "LOCAL_REVIEW",
    payload: candidatePayload({ reviewer_attribution: identifierSchema }),
  },
  "review.completed": {
    phase: "LOCAL_REVIEW",
    payload: candidatePayload({
      reviewer_attribution: identifierSchema,
      outcome: z.enum(["approved", "changes-requested", "blocked"]),
      findings_digest: evidenceDigestSchema,
    }),
  },
  "fixing.started": {
    phase: "FIXING",
    payload: candidatePayload({ iteration: z.number().int().positive() }),
  },
  "delivery.ready": {
    phase: "DELIVERY_READY",
    payload: candidatePayload({ required_remote_checks: z.array(z.string().min(1)) }),
  },
  "branch.pushed": {
    phase: "PUSHED",
    payload: candidatePayload({ remote_ref: z.string().min(1), observed_remote_sha: gitShaSchema }),
  },
  "pull_request.opened": {
    phase: "PR_OPEN",
    payload: candidatePayload({
      repository: repositoryNameSchema,
      number: z.number().int().positive(),
      url: z.url(),
      observed_head_sha: gitShaSchema,
      base_sha: gitShaSchema,
    }),
  },
  "ci.waiting": {
    phase: "CI_WAIT",
    payload: candidatePayload({ snapshot_digest: evidenceDigestSchema }),
  },
  "ci.completed": {
    phase: "CI_WAIT",
    payload: candidatePayload({
      outcome: z.enum(["passed", "failed", "pending", "not-scheduled"]),
      checks_digest: evidenceDigestSchema,
      checks: z.array(
        z
          .object({
            context: z.string().min(1).max(512),
            outcome: z.enum(["passed", "failed", "pending", "not-scheduled"]),
            evidence_digest: evidenceDigestSchema,
          })
          .strict(),
      ).max(10_000),
      observed_at: z.iso.datetime({ offset: true }),
    }),
  },
  "ci.recheck_completed": {
    phase: "CI_WAIT",
    payload: candidatePayload({
      outcome: z.enum(["failed", "pending", "not-scheduled"]),
      observation_intent_digest: evidenceDigestSchema,
      observation_digest: evidenceDigestSchema,
      observation_fencing_generation: z.number().int().positive(),
      checks_digest: evidenceDigestSchema,
      checks: z.array(
        z
          .object({
            context: z.string().min(1).max(512),
            outcome: z.enum(["passed", "failed", "pending", "not-scheduled"]),
            evidence_digest: evidenceDigestSchema,
          })
          .strict(),
      ).max(10_000),
      observed_at: z.iso.datetime({ offset: true }),
    }),
  },
  "pr_review.started": {
    phase: "PR_REVIEW",
    payload: candidatePayload({ reviewer_attribution: identifierSchema }),
  },
  "pr_review.completed": {
    phase: "PR_REVIEW",
    payload: candidatePayload({
      reviewer_attribution: identifierSchema,
      outcome: z.enum(["approved", "changes-requested", "blocked"]),
      findings_digest: evidenceDigestSchema,
    }),
  },
  "ci.revalidated": {
    phase: "PR_REVIEW",
    payload: candidatePayload({
      outcome: z.literal("passed"),
      observation_intent_digest: evidenceDigestSchema,
      observation_digest: evidenceDigestSchema,
      observation_fencing_generation: z.number().int().positive(),
      checks_digest: evidenceDigestSchema,
      checks: z.array(
        z
          .object({
            context: z.string().min(1).max(512),
            outcome: z.literal("passed"),
            evidence_digest: evidenceDigestSchema,
          })
          .strict(),
      ).max(10_000),
      observed_at: z.iso.datetime({ offset: true }),
    }),
  },
  "pull_request.delivered": {
    phase: "PR_DELIVERED",
    payload: candidatePayload({
      repository: repositoryNameSchema,
      number: z.number().int().positive(),
      url: z.url(),
      head_ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
      base_ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
      marker: identifierSchema,
      head_sha: gitShaSchema,
      observed_head_sha: gitShaSchema,
      current_base_sha: gitShaSchema,
      collision_set_digest: evidenceDigestSchema,
      base_observation_digest: evidenceDigestSchema,
      protection_digest: evidenceDigestSchema,
      protection: z
        .object({
          required_checks: z.array(z.string().min(1).max(512)).max(10_000),
          requires_approval: z.boolean(),
          requires_conversation_resolution: z.boolean(),
          uses_merge_queue: z.boolean(),
        })
        .strict(),
      state: z.literal("open"),
      draft: z.boolean(),
      delivery_observation_intent_digest: evidenceDigestSchema,
      delivery_observation_digest: evidenceDigestSchema,
      observed_at: z.iso.datetime({ offset: true }),
      final_ci_observation_intent_digest: evidenceDigestSchema,
      final_ci_observation_digest: evidenceDigestSchema,
      final_ci_observation_fencing_generation: z.number().int().positive(),
      final_ci_checks_digest: evidenceDigestSchema,
      final_ci_checks: z.array(
        z
          .object({
            context: z.string().min(1).max(512),
            outcome: z.literal("passed"),
            evidence_digest: evidenceDigestSchema,
          })
          .strict(),
      ).max(10_000),
      final_ci_observed_at: z.iso.datetime({ offset: true }),
    }),
  },
  "merge_queue.entered": {
    phase: "MERGE_QUEUE_WAIT",
    payload: candidatePayload({ merge_group_sha: gitShaSchema }),
  },
  "merge.ready": {
    phase: "MERGE_READY",
    payload: candidatePayload({ merge_group_sha: gitShaSchema, evidence_digest: evidenceDigestSchema }),
  },
  "merge.completed": {
    phase: "MERGED",
    payload: candidatePayload({ merge_sha: gitShaSchema, evidence_digest: evidenceDigestSchema }),
  },
  "evidence.finalized": {
    phase: "EVIDENCE_FINALIZED",
    payload: candidatePayload({ bundle_digest: evidenceDigestSchema }),
  },
  "run.completed": {
    phase: "COMPLETED",
    payload: candidatePayload({
      closure_target: z.enum(["pr", "merge"]),
      satisfied: z.literal(true),
      evidence_bundle_digest: evidenceDigestSchema,
      terminal_evidence_bundle_digest: evidenceDigestSchema.optional(),
    }),
  },
  "run.resumed": {
    phase: "resume-phase-from-payload",
    payload: z.union([
      z
        .object({
          interrupted_phase: z.literal("WAITING_APPROVAL"),
          resume_phase: runEventPhaseSchema,
          evidence_digest: evidenceDigestSchema,
          approval_id: identifierSchema,
          candidate_sha: gitShaSchema.optional(),
        })
        .strict(),
      z
        .object({
          interrupted_phase: z.literal("BLOCKED_EXTERNAL"),
          resume_phase: runEventPhaseSchema,
          evidence_digest: evidenceDigestSchema,
          candidate_sha: gitShaSchema.optional(),
          reconciliation: z
            .object({
              schema: z.literal("asf.reconciliation-continuation-result/v1"),
              operation_id: identifierSchema,
              result_digest: evidenceDigestSchema,
              pending_set_digest: evidenceDigestSchema,
              checkpoint_digest: evidenceDigestSchema,
              blocked_event_id: identifierSchema,
              interrupted_event_seq: z.number().int().positive().safe(),
              provider_budget_settlement_digests: z
                .array(evidenceDigestSchema)
                .max(20_000)
                .optional(),
              action: z.enum([
                "continue-confirmed",
                "replay-not-applied",
                "continue-cancellation",
              ]),
            })
            .strict(),
        })
        .strict(),
    ]),
  },
  "cancellation.requested": {
    phase: "CANCEL_REQUESTED",
    payload: cancellationPayloadSchema,
  },
  "cancellation.escalated": {
    phase: "CANCEL_REQUESTED",
    payload: cancellationPayloadSchema,
  },
  "cancellation.started": { phase: "CANCELLING", payload: cancellationPayloadSchema },
  "run.waiting_approval": {
    phase: "WAITING_APPROVAL",
    payload: approvalStopPayloadSchema,
  },
  "run.needs_spec": { phase: "NEEDS_SPEC", payload: stopPayloadSchema },
  "run.blocked_external": {
    phase: "BLOCKED_EXTERNAL",
    payload: blockedExternalPayloadSchema,
  },
  "budget.exhausted": { phase: "BUDGET_EXHAUSTED", payload: terminalStopPayloadSchema },
  "run.refused": { phase: "REFUSED", payload: terminalStopPayloadSchema },
  "run.quarantined": { phase: "QUARANTINED", payload: terminalStopPayloadSchema },
  "run.cancelled": { phase: "CANCELLED", payload: terminalCancellationPayloadSchema },
  "run.failed": { phase: "FAILED", payload: terminalStopPayloadSchema },
};

const NORMAL_PHASE_SUCCESSORS: Readonly<Partial<Record<RunEventPhase, readonly RunEventPhase[]>>> = {
  RECEIVED: ["ADMITTED"],
  ADMITTED: ["REPOSITORY_LEASED"],
  REPOSITORY_LEASED: ["IDENTITY_READY"],
  IDENTITY_READY: ["WORKSPACE_READY"],
  WORKSPACE_READY: ["TASK_PACKET_READY"],
  TASK_PACKET_READY: ["IMPLEMENTING"],
  IMPLEMENTING: ["CANDIDATE_READY"],
  CANDIDATE_READY: ["LOCAL_VERIFY"],
  LOCAL_VERIFY: ["LOCAL_REVIEW", "FIXING"],
  LOCAL_REVIEW: ["FIXING", "DELIVERY_READY"],
  FIXING: ["CANDIDATE_READY"],
  DELIVERY_READY: ["PUSHED"],
  PUSHED: ["PR_OPEN"],
  PR_OPEN: ["CI_WAIT"],
  CI_WAIT: ["PR_REVIEW", "FIXING"],
  PR_REVIEW: ["FIXING", "CI_WAIT", "PR_DELIVERED"],
  PR_DELIVERED: ["MERGE_QUEUE_WAIT", "EVIDENCE_FINALIZED"],
  MERGE_QUEUE_WAIT: ["MERGE_READY"],
  MERGE_READY: ["MERGED"],
  MERGED: ["EVIDENCE_FINALIZED"],
  EVIDENCE_FINALIZED: ["COMPLETED"],
  CANCEL_REQUESTED: ["CANCELLING"],
  CANCELLING: ["CANCELLED"],
};

const RUN_EVENT_FROM_PHASES: Readonly<Record<string, readonly RunEventPhase[]>> = {
  "work_order.admitted": ["RECEIVED"],
  "repository.lease_acquired": ["ADMITTED"],
  "identity.leases_acquired": ["REPOSITORY_LEASED"],
  "workspace.prepared": ["IDENTITY_READY"],
  "task_packet.created": ["WORKSPACE_READY"],
  "implementation.started": ["TASK_PACKET_READY", "IMPLEMENTING"],
  "candidate.created": ["IMPLEMENTING", "FIXING"],
  "verification.started": ["CANDIDATE_READY"],
  "verification.completed": ["LOCAL_VERIFY"],
  "review.started": ["LOCAL_VERIFY"],
  "review.completed": ["LOCAL_REVIEW"],
  "fixing.started": ["LOCAL_VERIFY", "LOCAL_REVIEW", "CI_WAIT", "PR_REVIEW"],
  "delivery.ready": ["LOCAL_REVIEW"],
  "branch.pushed": ["DELIVERY_READY"],
  "pull_request.opened": ["PUSHED"],
  "ci.waiting": ["PR_OPEN"],
  "ci.completed": ["CI_WAIT"],
  "ci.recheck_completed": ["PR_REVIEW"],
  "pr_review.started": ["CI_WAIT"],
  "pr_review.completed": ["PR_REVIEW"],
  "ci.revalidated": ["PR_REVIEW"],
  "pull_request.delivered": ["PR_REVIEW"],
  "merge_queue.entered": ["PR_DELIVERED"],
  "merge.ready": ["MERGE_QUEUE_WAIT"],
  "merge.completed": ["MERGE_READY"],
  "evidence.finalized": ["PR_DELIVERED", "MERGED"],
  "run.completed": ["EVIDENCE_FINALIZED"],
  "run.resumed": ["WAITING_APPROVAL", "NEEDS_SPEC", "BLOCKED_EXTERNAL"],
  "cancellation.requested": [
    "ADMITTED",
    "REPOSITORY_LEASED",
    "IDENTITY_READY",
    "WORKSPACE_READY",
    "TASK_PACKET_READY",
    "IMPLEMENTING",
    "CANDIDATE_READY",
    "LOCAL_VERIFY",
    "LOCAL_REVIEW",
    "FIXING",
    "DELIVERY_READY",
    "PUSHED",
    "PR_OPEN",
    "CI_WAIT",
    "PR_REVIEW",
    "PR_DELIVERED",
    "MERGE_QUEUE_WAIT",
    "MERGE_READY",
    "MERGED",
    "EVIDENCE_FINALIZED",
    "WAITING_APPROVAL",
    "NEEDS_SPEC",
    "BLOCKED_EXTERNAL",
  ],
  "cancellation.escalated": ["CANCEL_REQUESTED", "CANCELLING"],
  "cancellation.started": ["CANCEL_REQUESTED"],
  "run.cancelled": ["CANCELLING"],
};

/** Bind an event name to both its destination and permitted source checkpoint. */
export function assertRunEventTransition(from: RunEventPhase, event: RunEvent): void {
  const reconciliation = event.payload["reconciliation"];
  const protectedCancellationContinuation =
    from === "BLOCKED_EXTERNAL" &&
    event.type === "run.resumed" &&
    event.phase === "CANCELLING" &&
    typeof reconciliation === "object" &&
    reconciliation !== null &&
    !Array.isArray(reconciliation) &&
    (reconciliation as Readonly<Record<string, unknown>>)["action"] ===
      "continue-cancellation";
  if (!protectedCancellationContinuation) {
    assertRunPhaseTransition(from, event.phase);
  }
  const allowedFrom = RUN_EVENT_FROM_PHASES[event.type];
  if (allowedFrom !== undefined && !allowedFrom.includes(from)) {
    throw new Error(
      `ASF run-event ${event.type} cannot transition from ${from} to ${event.phase}`,
    );
  }
}

const CHECKPOINT_SELF_TRANSITIONS: ReadonlySet<RunEventPhase> = new Set([
  "IMPLEMENTING",
  "LOCAL_VERIFY",
  "LOCAL_REVIEW",
  "FIXING",
  "CI_WAIT",
  "PR_REVIEW",
  "CANCELLING",
  "CANCEL_REQUESTED",
]);

const INTERRUPTING_PHASES: ReadonlySet<RunEventPhase> = new Set([
  "CANCEL_REQUESTED",
  "WAITING_APPROVAL",
  "NEEDS_SPEC",
  "BLOCKED_EXTERNAL",
]);

const DIRECT_STOP_PHASES: ReadonlySet<RunEventPhase> = new Set([
  "BUDGET_EXHAUSTED",
  "REFUSED",
  "QUARANTINED",
  "FAILED",
]);

/** Refuse skipped, reversed, or post-terminal state changes. */
export function assertRunPhaseTransition(from: RunEventPhase, to: RunEventPhase): void {
  if (isTerminalRunEventPhase(from)) {
    throw new Error(`terminal ASF phase ${from} cannot transition to ${to}`);
  }
  const normal = NORMAL_PHASE_SUCCESSORS[from]?.includes(to) ?? false;
  const checkpoint = from === to && CHECKPOINT_SELF_TRANSITIONS.has(from);
  const interruption = INTERRUPTING_PHASES.has(to) && to !== from;
  const directStop = DIRECT_STOP_PHASES.has(to);
  const resume =
    (from === "WAITING_APPROVAL" || from === "NEEDS_SPEC" || from === "BLOCKED_EXTERNAL") &&
    !isTerminalRunEventPhase(to) &&
    !INTERRUPTING_PHASES.has(to) &&
    !DIRECT_STOP_PHASES.has(to) &&
    to !== "CANCELLING" &&
    to !== "CANCEL_REQUESTED";
  if (!normal && !checkpoint && !interruption && !directStop && !resume) {
    throw new Error(`invalid ASF lifecycle transition ${from} -> ${to}`);
  }
}

export const runEventSchema = z
  .object({
    schema: z.literal(RUN_EVENT_SCHEMA),
    event_id: identifierSchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    seq: z.number().int().positive(),
    occurred_at: z.iso.datetime({ offset: true }),
    type: eventTypeSchema,
    phase: runEventPhaseSchema,
    payload: payloadSchema,
    policy_digest: digestSchema,
  })
  .strict();

export type RunEvent = z.infer<typeof runEventSchema>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse authority-bearing event input without guessing at future schemas or phases. */
export function parseRunEvent(raw: unknown): RunEvent {
  const event = asRecord(raw);
  if (event === undefined) {
    throw new Error("ASF run event must be an object");
  }
  if (event["schema"] !== RUN_EVENT_SCHEMA) {
    throw new Error(
      `unsupported ASF run-event schema: ${JSON.stringify(event["schema"])}`,
    );
  }
  if (
    typeof event["phase"] !== "string" ||
    !RUN_EVENT_PHASES.some((phase) => phase === event["phase"])
  ) {
    throw new Error(
      `unsupported ASF run-event phase: ${JSON.stringify(event["phase"])}`,
    );
  }

  const parsed = runEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "invalid ASF run event:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  const contract = RUN_EVENT_CONTRACTS[parsed.data.type];
  if (contract === undefined) {
    throw new Error(`unsupported ASF run-event type: ${JSON.stringify(parsed.data.type)}`);
  }
  if (
    contract.phase !== "resume-phase-from-payload" &&
    parsed.data.phase !== contract.phase
  ) {
    throw new Error(
      `ASF run-event ${parsed.data.type} must use phase ${contract.phase}, got ${parsed.data.phase}`,
    );
  }
  const payload = contract.payload.safeParse(parsed.data.payload);
  if (!payload.success) {
    throw new Error(
      `invalid ASF run-event payload for ${parsed.data.type}:\n` +
        payload.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  if (
    contract.phase === "resume-phase-from-payload" &&
    (payload.data["resume_phase"] !== parsed.data.phase ||
      payload.data["interrupted_phase"] === parsed.data.phase)
  ) {
    throw new Error(
      `invalid ASF run-event payload for ${parsed.data.type}: resume phase does not bind event phase`,
    );
  }
  const candidateSha = payload.data["candidate_sha"];
  for (const observationField of ["observed_remote_sha", "observed_head_sha"] as const) {
    const observed = payload.data[observationField];
    if (typeof candidateSha === "string" && typeof observed === "string" && observed !== candidateSha) {
      throw new Error(
        `invalid ASF run-event payload for ${parsed.data.type}: ${observationField} ` +
          "does not equal the exact candidate_sha",
      );
    }
  }
  return parsed.data;
}
