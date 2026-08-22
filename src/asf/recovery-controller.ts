import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import {
  ASF_EVIDENCE_CLASSES,
  ASF_RECOVERY_ACTIONS,
  ASF_RECOVERY_REQUEST_SCHEMA,
  AuthorizedImplementerResume,
  getAsfCheckpointRecoveryPolicy,
  parseDurableAsfCheckpoint,
  planAsfCheckpointRecovery,
  type AsfCheckpointRecoveryPlan,
  type AsfEvidenceClass,
  type AsfReconciliationObservation,
  type DurableAsfCheckpoint,
  type ImplementerResumeObservations,
} from "./checkpoint-policy.js";
import { sha256Digest, type JsonValue } from "./canonical-json.js";
import {
  ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
  type AsfDeliveryBinding,
  type AsfRecoveryController,
} from "./delivery-runner.js";

export const ASF_RECOVERY_DIRECTIVE_SCHEMA =
  "asf.recovery-directive/v1" as const;
export const ASF_RECOVERY_AUTHORIZATION_RECORD_SCHEMA =
  "asf.recovery-authorization-record/v1" as const;
export const ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA =
  "asf.recovery-operation-receipt/v1" as const;
export const ASF_RECOVERY_INVALIDATION_RECEIPT_SCHEMA =
  "asf.recovery-invalidation-receipt/v1" as const;
export const ASF_RECOVERY_DURABLE_ACKNOWLEDGEMENT_SCHEMA =
  "asf.recovery-durable-acknowledgement/v1" as const;

export const ASF_TAKEOVER_FENCING_OPERATIONS = [
  "fence-prior-worker-generation",
  "abort-prior-provider-and-tool-work",
  "revoke-prior-identity-leases",
  "reconcile-in-flight-external-effects",
] as const;

export type AsfTakeoverFencingOperation =
  (typeof ASF_TAKEOVER_FENCING_OPERATIONS)[number];

export const ASF_RECOVERY_CONTROLLER_REFUSAL_CODES = [
  "INVALID_INPUT",
  "OBSERVATION_UNPROVEN",
  "AUTHORITY_UNPROVEN",
  "FENCE_LOST",
  "PLAN_MISMATCH",
  "FENCING_INCOMPLETE",
  "INVALIDATION_INCOMPLETE",
  "DURABILITY_UNPROVEN",
  "CANCELLED",
] as const;

export type AsfRecoveryControllerRefusalCode =
  (typeof ASF_RECOVERY_CONTROLLER_REFUSAL_CODES)[number];

export class AsfRecoveryControllerRefusedError extends Error {
  readonly code: AsfRecoveryControllerRefusalCode;

  constructor(code: AsfRecoveryControllerRefusalCode, message: string) {
    super(message);
    this.name = "AsfRecoveryControllerRefusedError";
    this.code = code;
  }
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

const bindingSchema = z
  .object({
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    candidate_sha: gitShaSchema.nullable(),
  })
  .strict();

type BindingWire = z.infer<typeof bindingSchema>;

const observationWindowShape = {
  observed_at: timestampSchema,
  valid_until: timestampSchema,
  evidence_digest: digestSchema,
};

const checkpointObservationSchema = z
  .object({
    state: z.enum(["verified", "missing", "unknown", "contradictory"]),
    checkpoint_digest: digestSchema,
    ...observationWindowShape,
  })
  .strict();

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

const remoteObservationSchema = z
  .object({
    observation: z.enum([
      "identity-lease-state",
      "provider-session-state",
      "github-branch-state",
      "github-pull-request-state",
      "github-ci-state",
      "github-merge-queue-state",
      "github-merge-state",
      "asf-acknowledgement-state",
      "repository-lease-state",
    ]),
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

const recoveryActorDirectiveSchema = z.discriminatedUnion("role", [
  z
    .object({ role: z.literal("orchestrator"), mode: z.literal("automatic") })
    .strict(),
  z
    .object({
      role: z.literal("implementer"),
      mode: z.enum(["fresh", "resume"]),
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

const unsignedDirectiveSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_DIRECTIVE_SCHEMA),
    checkpoint_digest: digestSchema,
    binding: bindingSchema,
    worker_id: identifierSchema,
    takeover: z.boolean(),
    replay_requested: z.boolean(),
    actor: recoveryActorDirectiveSchema,
    issued_at: timestampSchema,
    valid_until: timestampSchema,
  })
  .strict();

const directiveSchema = unsignedDirectiveSchema
  .extend({ directive_digest: digestSchema })
  .strict();

export type AsfRecoveryDirective = z.infer<typeof directiveSchema>;

const publicImplementerResumeBindingSchema = z
  .object({
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    checkpointKind: z.enum([
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
    ]),
    candidateSha: gitShaSchema.nullable(),
    policyDigest: digestSchema,
    fencingGeneration: z.number().int().positive(),
    authorizationFencingGeneration: z.number().int().positive(),
    authorizationIdentityLeaseBindingDigest: digestSchema,
    sessionIdentityDigest: digestSchema,
  })
  .strict();

const planDescriptorSchema = z
  .object({
    checkpoint_kind: publicImplementerResumeBindingSchema.shape.checkpointKind,
    action: z.enum(ASF_RECOVERY_ACTIONS),
    replay_policy: z.enum([
      "replayable",
      "reconcile-first",
      "fresh-context",
      "not-replayable",
    ]),
    confirmed_reconciliations: z.array(
      remoteObservationSchema.shape.observation,
    ),
    replay_reconciliations: z.array(remoteObservationSchema.shape.observation),
    skip_confirmed_effects: z.array(remoteObservationSchema.shape.observation),
    invalidated_evidence: z.array(z.enum(ASF_EVIDENCE_CLASSES)),
    cleanup_and_fencing: z.array(z.string().min(1).max(1_024)),
    ownership_takeover: z.boolean(),
    required_takeover_fencing: z.array(z.enum(ASF_TAKEOVER_FENCING_OPERATIONS)),
    implementer_resume: publicImplementerResumeBindingSchema.nullable(),
    protected_resume_ref_digest: digestSchema.nullable(),
  })
  .strict();

const unsignedAuthorizationRecordSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_AUTHORIZATION_RECORD_SCHEMA),
    authorization_id: identifierSchema,
    checkpoint_digest: digestSchema,
    binding: bindingSchema,
    worker_id: identifierSchema,
    directive_digest: digestSchema,
    request_digest: digestSchema,
    plan_digest: digestSchema,
    authorized_at: timestampSchema,
    valid_until: timestampSchema,
  })
  .strict();

const authorizationRecordSchema = unsignedAuthorizationRecordSchema
  .extend({ authorization_record_digest: digestSchema })
  .strict();

export type DurableAsfRecoveryAuthorization = z.infer<
  typeof authorizationRecordSchema
>;

const unsignedOperationReceiptSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA),
    operation: z.enum(ASF_TAKEOVER_FENCING_OPERATIONS),
    ordinal: z
      .number()
      .int()
      .min(1)
      .max(ASF_TAKEOVER_FENCING_OPERATIONS.length),
    checkpoint_digest: digestSchema,
    binding: bindingSchema,
    authorization_record_digest: digestSchema,
    previous_receipt_digest: digestSchema.nullable(),
    completed_at: timestampSchema,
    evidence_digest: digestSchema,
  })
  .strict();

const operationReceiptSchema = unsignedOperationReceiptSchema
  .extend({ receipt_digest: digestSchema })
  .strict();

export type AsfRecoveryOperationReceipt = z.infer<
  typeof operationReceiptSchema
>;

const unsignedInvalidationReceiptSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_INVALIDATION_RECEIPT_SCHEMA),
    checkpoint_digest: digestSchema,
    binding: bindingSchema,
    authorization_record_digest: digestSchema,
    previous_receipt_digest: digestSchema.nullable(),
    invalidated_evidence: z.array(z.enum(ASF_EVIDENCE_CLASSES)),
    completed_at: timestampSchema,
    evidence_digest: digestSchema,
  })
  .strict();

const invalidationReceiptSchema = unsignedInvalidationReceiptSchema
  .extend({ receipt_digest: digestSchema })
  .strict();

export type AsfRecoveryInvalidationReceipt = z.infer<
  typeof invalidationReceiptSchema
>;

const deliveryRecoveryAcknowledgementSchema = z
  .object({
    schema: z.literal(ASF_DELIVERY_RECOVERY_ACK_SCHEMA),
    binding: bindingSchema,
    checkpoint_digest: digestSchema,
    action: z.enum(ASF_RECOVERY_ACTIONS),
    completed_takeover_fencing: z.array(
      z.enum(ASF_TAKEOVER_FENCING_OPERATIONS),
    ),
    invalidated_evidence: z.array(z.enum(ASF_EVIDENCE_CLASSES)),
    acknowledgement_digest: digestSchema,
  })
  .strict();

export type DurableAsfDeliveryRecoveryAcknowledgement = z.infer<
  typeof deliveryRecoveryAcknowledgementSchema
>;

const unsignedDurableAcknowledgementSchema = z
  .object({
    schema: z.literal(ASF_RECOVERY_DURABLE_ACKNOWLEDGEMENT_SCHEMA),
    authorization_id: identifierSchema,
    authorization_record_digest: digestSchema,
    checkpoint_digest: digestSchema,
    binding: bindingSchema,
    plan_digest: digestSchema,
    operation_receipt_digests: z.array(digestSchema),
    invalidation_receipt_digest: digestSchema.nullable(),
    acknowledgement: deliveryRecoveryAcknowledgementSchema,
    recorded_at: timestampSchema,
  })
  .strict();

const durableAcknowledgementSchema = unsignedDurableAcknowledgementSchema
  .extend({ durable_record_digest: digestSchema })
  .strict();

export type DurableAsfRecoveryAcknowledgement = z.infer<
  typeof durableAcknowledgementSchema
>;

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function refuse(
  code: AsfRecoveryControllerRefusalCode,
  message: string,
): never {
  throw new AsfRecoveryControllerRefusedError(code, message);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  refuse("CANCELLED", "ASF checkpoint recovery was cancelled");
}

function exactArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function bindingWire(binding: AsfDeliveryBinding): BindingWire {
  const parsed = bindingSchema.safeParse({
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: binding.candidateSha,
  });
  if (!parsed.success) {
    return refuse(
      "INVALID_INPUT",
      "ASF recovery binding failed strict validation",
    );
  }
  return parsed.data;
}

function exactBinding(actual: BindingWire, expected: BindingWire): boolean {
  return (
    actual.run_id === expected.run_id &&
    actual.work_order_id === expected.work_order_id &&
    actual.attempt_id === expected.attempt_id &&
    actual.policy_digest === expected.policy_digest &&
    actual.fencing_generation === expected.fencing_generation &&
    actual.candidate_sha === expected.candidate_sha
  );
}

function assertCheckpointBinding(
  checkpointRaw: DurableAsfCheckpoint,
  binding: BindingWire,
  takeover: boolean | undefined,
): DurableAsfCheckpoint {
  const checkpoint = parseDurableAsfCheckpoint(checkpointRaw);
  if (
    checkpoint.run_id !== binding.run_id ||
    checkpoint.work_order_id !== binding.work_order_id ||
    checkpoint.attempt_id !== binding.attempt_id ||
    checkpoint.policy_digest !== binding.policy_digest ||
    checkpoint.candidate_sha !== binding.candidate_sha ||
    checkpoint.fencing_generation > binding.fencing_generation
  ) {
    return refuse(
      "INVALID_INPUT",
      "ASF recovery checkpoint contradicts the exact run, candidate, policy, or fence binding",
    );
  }
  const generationChanged =
    checkpoint.fencing_generation < binding.fencing_generation;
  if (takeover !== undefined && takeover !== generationChanged) {
    return refuse(
      "INVALID_INPUT",
      "ASF recovery takeover flag contradicts the checkpoint and current fencing generations",
    );
  }
  return checkpoint;
}

function assertFreshWindow(
  value: { readonly observed_at: string; readonly valid_until: string },
  clock: Clock,
  code: AsfRecoveryControllerRefusalCode,
  label: string,
): void {
  const now = clock.now().getTime();
  const observedAt = Date.parse(value.observed_at);
  const validUntil = Date.parse(value.valid_until);
  if (observedAt > now || validUntil < observedAt || now >= validUntil) {
    refuse(code, `${label} is stale or has a contradictory observation window`);
  }
}

function parseDigestRecord<T extends Record<string, unknown>>(
  raw: unknown,
  schema: z.ZodType<T & { readonly [key: string]: unknown }>,
  digestKey: string,
  code: AsfRecoveryControllerRefusalCode,
  label: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return refuse(code, `${label} failed strict validation`);
  const record = parsed.data as Record<string, unknown>;
  const recordedDigest = record[digestKey];
  const unsigned = { ...record };
  delete unsigned[digestKey];
  if (recordedDigest !== sha256Digest(json(unsigned))) {
    return refuse(code, `${label} has a contradictory content digest`);
  }
  return parsed.data;
}

export function createAsfRecoveryDirective(
  raw: z.input<typeof unsignedDirectiveSchema>,
): AsfRecoveryDirective {
  const parsed = unsignedDirectiveSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "AUTHORITY_UNPROVEN",
      "ASF recovery directive failed strict validation",
    );
  }
  return {
    ...parsed.data,
    directive_digest: sha256Digest(json(parsed.data)),
  };
}

export function createAsfRecoveryOperationReceipt(
  raw: z.input<typeof unsignedOperationReceiptSchema>,
): AsfRecoveryOperationReceipt {
  const parsed = unsignedOperationReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "FENCING_INCOMPLETE",
      "ASF recovery fencing receipt failed strict validation",
    );
  }
  return { ...parsed.data, receipt_digest: sha256Digest(json(parsed.data)) };
}

export function createAsfRecoveryInvalidationReceipt(
  raw: z.input<typeof unsignedInvalidationReceiptSchema>,
): AsfRecoveryInvalidationReceipt {
  const parsed = unsignedInvalidationReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "INVALIDATION_INCOMPLETE",
      "ASF recovery invalidation receipt failed strict validation",
    );
  }
  return { ...parsed.data, receipt_digest: sha256Digest(json(parsed.data)) };
}

/** Read-only protected observations. No method in this boundary may mutate a remote. */
export interface AsfRecoveryProtectedObservationSource {
  observeCheckpoint(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  observeOwnership(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly workerId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  observeRemote(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly observation: AsfReconciliationObservation;
    readonly correlationMarker: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  observeImplementerResume(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly workerId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Operator-owned authority chooses a bounded actor and whether replay is requested. */
export interface AsfRecoveryRequestAuthority {
  authorize(input: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly workerId: string;
    readonly takeover: boolean;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Each call must be idempotent for the authorization and exact fencing generation. */
export interface AsfRecoveryTakeoverFencer {
  complete(input: {
    readonly operation: AsfTakeoverFencingOperation;
    readonly ordinal: number;
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly authorization: DurableAsfRecoveryAuthorization;
    readonly previousReceiptDigest: string | null;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Evidence invalidation is local protected state, never repository-controlled authority. */
export interface AsfRecoveryEvidenceInvalidator {
  invalidate(input: {
    readonly evidenceClasses: readonly AsfEvidenceClass[];
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: AsfDeliveryBinding;
    readonly authorization: DurableAsfRecoveryAuthorization;
    readonly previousReceiptDigest: string | null;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Durable protected state for authorizations and acknowledgements. Implementations
 * must atomically fence every write by the supplied binding and reject conflicts.
 */
export interface AsfRecoveryDurableStore {
  recordAuthorization(
    record: DurableAsfRecoveryAuthorization,
  ): Promise<unknown>;
  loadAuthorization(input: {
    readonly authorizationId: string;
    readonly checkpointDigest: string;
    readonly binding: AsfDeliveryBinding;
    readonly planDigest: string;
  }): Promise<unknown>;
  loadAcknowledgement(input: {
    readonly authorizationId: string;
    readonly checkpointDigest: string;
    readonly binding: AsfDeliveryBinding;
    readonly planDigest: string;
  }): Promise<unknown | undefined>;
  recordAcknowledgement(
    record: DurableAsfRecoveryAcknowledgement,
  ): Promise<unknown>;
}

export interface ProductionAsfRecoveryControllerOptions {
  readonly workerId: string;
  readonly observations: AsfRecoveryProtectedObservationSource;
  readonly authority: AsfRecoveryRequestAuthority;
  readonly takeoverFencer: AsfRecoveryTakeoverFencer;
  readonly invalidator: AsfRecoveryEvidenceInvalidator;
  readonly store: AsfRecoveryDurableStore;
  readonly clock: Clock;
}

function directiveFromRaw(
  raw: unknown,
  expected: {
    readonly checkpoint: DurableAsfCheckpoint;
    readonly binding: BindingWire;
    readonly workerId: string;
    readonly takeover: boolean;
  },
  clock: Clock,
): AsfRecoveryDirective {
  const directive = parseDigestRecord(
    raw,
    directiveSchema,
    "directive_digest",
    "AUTHORITY_UNPROVEN",
    "ASF recovery directive",
  );
  assertFreshWindow(
    { observed_at: directive.issued_at, valid_until: directive.valid_until },
    clock,
    "AUTHORITY_UNPROVEN",
    "ASF recovery directive",
  );
  if (
    directive.checkpoint_digest !== expected.checkpoint.checkpoint_digest ||
    !exactBinding(directive.binding, expected.binding) ||
    directive.worker_id !== expected.workerId ||
    directive.takeover !== expected.takeover
  ) {
    return refuse(
      "AUTHORITY_UNPROVEN",
      "ASF recovery directive is not exact-bound to this checkpoint, worker, and fence",
    );
  }
  return directive;
}

function planDescriptor(plan: AsfCheckpointRecoveryPlan) {
  let implementerResume: z.infer<
    typeof publicImplementerResumeBindingSchema
  > | null = null;
  let protectedResumeRefDigest: string | null = null;
  if (plan.implementerResume !== null) {
    if (!(plan.implementerResume instanceof AuthorizedImplementerResume)) {
      return refuse(
        "PLAN_MISMATCH",
        "ASF recovery plan contains an untrusted implementer resume authorization",
      );
    }
    const parsedBinding = publicImplementerResumeBindingSchema.safeParse(
      plan.implementerResume.toJSON(),
    );
    if (!parsedBinding.success) {
      return refuse(
        "PLAN_MISMATCH",
        "ASF recovery plan contains a malformed implementer resume binding",
      );
    }
    implementerResume = parsedBinding.data;
    protectedResumeRefDigest = sha256Digest({
      protected_resume_ref:
        plan.implementerResume.protectedResumeRefForTrustedHarness(),
    });
  }
  const descriptor = {
    checkpoint_kind: plan.checkpointKind,
    action: plan.action,
    replay_policy: plan.replayPolicy,
    confirmed_reconciliations: [...plan.confirmedReconciliations],
    replay_reconciliations: [...plan.replayReconciliations],
    skip_confirmed_effects: [...plan.skipConfirmedEffects],
    invalidated_evidence: [...plan.invalidatedEvidence],
    cleanup_and_fencing: [...plan.cleanupAndFencing],
    ownership_takeover: plan.ownershipTakeover,
    required_takeover_fencing: [...plan.requiredTakeoverFencing],
    implementer_resume: implementerResume,
    protected_resume_ref_digest: protectedResumeRefDigest,
  };
  const parsed = planDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    return refuse(
      "PLAN_MISMATCH",
      "ASF recovery plan failed strict validation",
    );
  }
  if (
    (parsed.data.action === "resume-implementer") !==
    (parsed.data.implementer_resume !== null)
  ) {
    return refuse(
      "PLAN_MISMATCH",
      "ASF recovery plan does not preserve exact protected implementer resume authority",
    );
  }
  return parsed.data;
}

function authorizationId(
  checkpoint: DurableAsfCheckpoint,
  binding: BindingWire,
  planDigest: string,
): string {
  return `recovery_auth_${sha256Digest({
    checkpoint_digest: checkpoint.checkpoint_digest,
    binding,
    plan_digest: planDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function parseAuthorization(raw: unknown): DurableAsfRecoveryAuthorization {
  return parseDigestRecord(
    raw,
    authorizationRecordSchema,
    "authorization_record_digest",
    "DURABILITY_UNPROVEN",
    "durable ASF recovery authorization",
  );
}

function parseDurableAcknowledgement(
  raw: unknown,
): DurableAsfRecoveryAcknowledgement {
  return parseDigestRecord(
    raw,
    durableAcknowledgementSchema,
    "durable_record_digest",
    "DURABILITY_UNPROVEN",
    "durable ASF recovery acknowledgement",
  );
}

function minimumValidUntil(
  directive: AsfRecoveryDirective,
  checkpointObservation: z.infer<typeof checkpointObservationSchema>,
  ownership: z.infer<typeof ownershipObservationSchema>,
  remotes: readonly z.infer<typeof remoteObservationSchema>[],
  resume: ImplementerResumeObservations | null,
): string {
  const values = [
    directive.valid_until,
    checkpointObservation.valid_until,
    ownership.valid_until,
    ...remotes.map((observation) => observation.valid_until),
  ];
  if (resume !== null) {
    values.push(
      resume.ownership.valid_until,
      resume.provider.valid_until,
      resume.identity_lease.valid_until,
      resume.candidate_lineage.valid_until,
      resume.policy.valid_until,
    );
  }
  return values.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest,
  );
}

/**
 * Production recovery coordinator. It has no provider, repository, or forge
 * client: observation and effect authority stay in explicit protected
 * dependencies. Every plan is independently checked and durably authorized
 * before its ordered, fenced application.
 */
export class ProductionAsfRecoveryController implements AsfRecoveryController {
  readonly #options: ProductionAsfRecoveryControllerOptions;

  constructor(options: ProductionAsfRecoveryControllerOptions) {
    if (!identifierSchema.safeParse(options.workerId).success) {
      throw new Error("ASF recovery controller worker id is invalid");
    }
    this.#options = options;
  }

  async observe(
    input: Parameters<AsfRecoveryController["observe"]>[0],
  ): Promise<unknown> {
    throwIfAborted(input.signal);
    if (input.workerId !== this.#options.workerId) {
      return refuse(
        "INVALID_INPUT",
        "ASF recovery controller cannot observe on behalf of another worker",
      );
    }
    const binding = bindingWire(input.binding);
    const checkpoint = assertCheckpointBinding(
      input.checkpoint,
      binding,
      input.takeover,
    );
    const directive = directiveFromRaw(
      await this.#options.authority.authorize({
        checkpoint,
        binding: input.binding,
        workerId: input.workerId,
        takeover: input.takeover,
        signal: input.signal,
      }),
      {
        checkpoint,
        binding,
        workerId: input.workerId,
        takeover: input.takeover,
      },
      this.#options.clock,
    );
    throwIfAborted(input.signal);

    const checkpointObservation = checkpointObservationSchema.safeParse(
      await this.#options.observations.observeCheckpoint({
        checkpoint,
        binding: input.binding,
        signal: input.signal,
      }),
    );
    if (!checkpointObservation.success) {
      return refuse(
        "OBSERVATION_UNPROVEN",
        "durable checkpoint observation failed strict validation",
      );
    }
    throwIfAborted(input.signal);

    const ownership = ownershipObservationSchema.safeParse(
      await this.#options.observations.observeOwnership({
        checkpoint,
        binding: input.binding,
        workerId: input.workerId,
        signal: input.signal,
      }),
    );
    if (!ownership.success) {
      return refuse(
        "OBSERVATION_UNPROVEN",
        "ownership observation failed strict validation",
      );
    }
    throwIfAborted(input.signal);

    const policy = getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind);
    const markerByObservation = new Map(
      checkpoint.reconciliation_markers.map((marker) => [
        marker.observation,
        marker.correlation_marker,
      ]),
    );
    const remoteObservations: z.infer<typeof remoteObservationSchema>[] = [];
    for (const observation of policy.reconciliationBeforeReplay) {
      const correlationMarker = markerByObservation.get(observation);
      if (correlationMarker === undefined) {
        return refuse(
          "OBSERVATION_UNPROVEN",
          "checkpoint is missing an operator-required reconciliation marker",
        );
      }
      const observed = remoteObservationSchema.safeParse(
        await this.#options.observations.observeRemote({
          checkpoint,
          binding: input.binding,
          observation,
          correlationMarker,
          signal: input.signal,
        }),
      );
      if (!observed.success || observed.data.observation !== observation) {
        return refuse(
          "OBSERVATION_UNPROVEN",
          `protected ${observation} observation is missing or contradictory`,
        );
      }
      remoteObservations.push(observed.data);
      throwIfAborted(input.signal);
    }

    let resumeObservations: ImplementerResumeObservations | null = null;
    let actor: unknown;
    if (directive.actor.role === "implementer") {
      if (directive.actor.mode === "resume") {
        resumeObservations =
          (await this.#options.observations.observeImplementerResume({
            checkpoint,
            binding: input.binding,
            workerId: input.workerId,
            signal: input.signal,
          })) as ImplementerResumeObservations;
      }
      actor = {
        role: directive.actor.role,
        mode: directive.actor.mode,
        resume_observations: resumeObservations,
      };
    } else {
      actor = directive.actor;
    }
    throwIfAborted(input.signal);

    const request = {
      schema: ASF_RECOVERY_REQUEST_SCHEMA,
      requesting_worker_id: input.workerId,
      checkpoint,
      checkpoint_observation: checkpointObservation.data,
      ownership: ownership.data,
      remote_observations: remoteObservations,
      replay_requested: directive.replay_requested,
      actor,
    } as const;
    // This validation is deliberate even though the delivery runner repeats it:
    // no incomplete or contradictory observation set is durably authorized.
    const plan = planAsfCheckpointRecovery(request, {
      clock: this.#options.clock,
    });
    if (plan.ownershipTakeover !== input.takeover) {
      return refuse(
        "PLAN_MISMATCH",
        "checkpoint policy produced a takeover decision that contradicts the current fence",
      );
    }
    const descriptor = planDescriptor(plan);
    const planDigest = sha256Digest(json(descriptor));
    const requestDigest = sha256Digest(json(request));
    const validUntil = minimumValidUntil(
      directive,
      checkpointObservation.data,
      ownership.data,
      remoteObservations,
      resumeObservations,
    );
    const unsignedAuthorization = {
      schema: ASF_RECOVERY_AUTHORIZATION_RECORD_SCHEMA,
      authorization_id: authorizationId(checkpoint, binding, planDigest),
      checkpoint_digest: checkpoint.checkpoint_digest,
      binding,
      worker_id: input.workerId,
      directive_digest: directive.directive_digest,
      request_digest: requestDigest,
      plan_digest: planDigest,
      authorized_at: this.#options.clock.now().toISOString(),
      valid_until: validUntil,
    } as const;
    if (
      Date.parse(unsignedAuthorization.authorized_at) >= Date.parse(validUntil)
    ) {
      return refuse(
        "OBSERVATION_UNPROVEN",
        "ASF recovery observations expired before durable authorization",
      );
    }
    const authorization: DurableAsfRecoveryAuthorization = {
      ...unsignedAuthorization,
      authorization_record_digest: sha256Digest(json(unsignedAuthorization)),
    };
    const stored = parseAuthorization(
      await this.#options.store.recordAuthorization(authorization),
    );
    if (
      stored.authorization_record_digest !==
      authorization.authorization_record_digest
    ) {
      return refuse(
        "DURABILITY_UNPROVEN",
        "durable recovery store returned a conflicting authorization",
      );
    }
    return request;
  }

  async apply(
    input: Parameters<AsfRecoveryController["apply"]>[0],
  ): Promise<unknown> {
    throwIfAborted(input.signal);
    const binding = bindingWire(input.binding);
    const checkpoint = assertCheckpointBinding(
      input.checkpoint,
      binding,
      undefined,
    );
    const descriptor = planDescriptor(input.plan);
    const planDigest = sha256Digest(json(descriptor));
    const expectedAuthorizationId = authorizationId(
      checkpoint,
      binding,
      planDigest,
    );
    this.#assertPlanBinding(input.plan, checkpoint, binding);
    await this.#assertCurrentFence(checkpoint, input.binding, input.signal);

    const priorAcknowledgement = await this.#options.store.loadAcknowledgement({
      authorizationId: expectedAuthorizationId,
      checkpointDigest: checkpoint.checkpoint_digest,
      binding: input.binding,
      planDigest,
    });
    if (priorAcknowledgement !== undefined) {
      const durable = parseDurableAcknowledgement(priorAcknowledgement);
      this.#assertDurableAcknowledgement(
        durable,
        checkpoint,
        binding,
        expectedAuthorizationId,
        planDigest,
        input.plan,
      );
      return durable.acknowledgement;
    }

    const authorization = parseAuthorization(
      await this.#options.store.loadAuthorization({
        authorizationId: expectedAuthorizationId,
        checkpointDigest: checkpoint.checkpoint_digest,
        binding: input.binding,
        planDigest,
      }),
    );
    if (
      authorization.authorization_id !== expectedAuthorizationId ||
      authorization.checkpoint_digest !== checkpoint.checkpoint_digest ||
      !exactBinding(authorization.binding, binding) ||
      authorization.worker_id !== this.#options.workerId ||
      authorization.plan_digest !== planDigest
    ) {
      return refuse(
        "DURABILITY_UNPROVEN",
        "durable authorization is absent or bound to another recovery plan",
      );
    }
    if (
      this.#options.clock.now().getTime() >=
      Date.parse(authorization.valid_until)
    ) {
      return refuse(
        "OBSERVATION_UNPROVEN",
        "durable recovery authorization is stale",
      );
    }

    const operationReceipts: AsfRecoveryOperationReceipt[] = [];
    let previousReceiptDigest: string | null = null;
    for (const [
      index,
      operation,
    ] of input.plan.requiredTakeoverFencing.entries()) {
      await this.#assertCurrentFence(checkpoint, input.binding, input.signal);
      const rawReceipt = await this.#options.takeoverFencer.complete({
        operation,
        ordinal: index + 1,
        checkpoint,
        binding: input.binding,
        authorization,
        previousReceiptDigest,
        signal: input.signal,
      });
      throwIfAborted(input.signal);
      const receipt = parseDigestRecord(
        rawReceipt,
        operationReceiptSchema,
        "receipt_digest",
        "FENCING_INCOMPLETE",
        `ASF recovery ${operation} receipt`,
      );
      this.#assertOperationReceipt(
        receipt,
        operation,
        index + 1,
        previousReceiptDigest,
        authorization,
        checkpoint,
        binding,
      );
      operationReceipts.push(receipt);
      previousReceiptDigest = receipt.receipt_digest;
    }

    let invalidationReceipt: AsfRecoveryInvalidationReceipt | null = null;
    if (input.plan.invalidatedEvidence.length > 0) {
      await this.#assertCurrentFence(checkpoint, input.binding, input.signal);
      invalidationReceipt = parseDigestRecord(
        await this.#options.invalidator.invalidate({
          evidenceClasses: input.plan.invalidatedEvidence,
          checkpoint,
          binding: input.binding,
          authorization,
          previousReceiptDigest,
          signal: input.signal,
        }),
        invalidationReceiptSchema,
        "receipt_digest",
        "INVALIDATION_INCOMPLETE",
        "ASF recovery invalidation receipt",
      );
      throwIfAborted(input.signal);
      this.#assertInvalidationReceipt(
        invalidationReceipt,
        input.plan.invalidatedEvidence,
        previousReceiptDigest,
        authorization,
        checkpoint,
        binding,
      );
    }

    await this.#assertCurrentFence(checkpoint, input.binding, input.signal);
    const completedTakeoverFencing = [...input.plan.requiredTakeoverFencing];
    const invalidatedEvidence = [...input.plan.invalidatedEvidence];
    const acknowledgementUnsigned = {
      schema: ASF_DELIVERY_RECOVERY_ACK_SCHEMA,
      binding,
      checkpoint_digest: checkpoint.checkpoint_digest,
      action: input.plan.action,
      completed_takeover_fencing: completedTakeoverFencing,
      invalidated_evidence: invalidatedEvidence,
    };
    const acknowledgement: DurableAsfDeliveryRecoveryAcknowledgement = {
      ...acknowledgementUnsigned,
      acknowledgement_digest: sha256Digest({
        checkpoint_digest: checkpoint.checkpoint_digest,
        action: input.plan.action,
        completed_takeover_fencing:
          acknowledgementUnsigned.completed_takeover_fencing,
        invalidated_evidence: acknowledgementUnsigned.invalidated_evidence,
      }),
    };
    const unsignedDurable = {
      schema: ASF_RECOVERY_DURABLE_ACKNOWLEDGEMENT_SCHEMA,
      authorization_id: authorization.authorization_id,
      authorization_record_digest: authorization.authorization_record_digest,
      checkpoint_digest: checkpoint.checkpoint_digest,
      binding,
      plan_digest: planDigest,
      operation_receipt_digests: operationReceipts.map(
        (receipt) => receipt.receipt_digest,
      ),
      invalidation_receipt_digest: invalidationReceipt?.receipt_digest ?? null,
      acknowledgement,
      recorded_at: this.#options.clock.now().toISOString(),
    } as const;
    const durable: DurableAsfRecoveryAcknowledgement = {
      ...unsignedDurable,
      durable_record_digest: sha256Digest(json(unsignedDurable)),
    };
    const stored = parseDurableAcknowledgement(
      await this.#options.store.recordAcknowledgement(durable),
    );
    if (stored.durable_record_digest !== durable.durable_record_digest) {
      return refuse(
        "DURABILITY_UNPROVEN",
        "durable recovery store returned a conflicting acknowledgement",
      );
    }
    return stored.acknowledgement;
  }

  #assertPlanBinding(
    plan: AsfCheckpointRecoveryPlan,
    checkpoint: DurableAsfCheckpoint,
    binding: BindingWire,
  ): void {
    const policy = getAsfCheckpointRecoveryPolicy(checkpoint.checkpoint_kind);
    const takeover = checkpoint.fencing_generation < binding.fencing_generation;
    if (
      plan.checkpointKind !== checkpoint.checkpoint_kind ||
      plan.replayPolicy !== policy.replayPolicy ||
      plan.ownershipTakeover !== takeover ||
      !exactArray(
        plan.requiredTakeoverFencing,
        takeover ? ASF_TAKEOVER_FENCING_OPERATIONS : [],
      ) ||
      (plan.action === "restart-reviewer-fresh" &&
        !["local-review-fixer-iteration", "pr-review-fixer-iteration"].includes(
          checkpoint.checkpoint_kind,
        ))
    ) {
      return refuse(
        "PLAN_MISMATCH",
        "ASF recovery plan contradicts checkpoint policy or the current fence",
      );
    }
    if (plan.action === "resume-implementer") {
      const resume = plan.implementerResume;
      if (
        resume === null ||
        resume.binding.runId !== binding.run_id ||
        resume.binding.workOrderId !== binding.work_order_id ||
        resume.binding.attemptId !== binding.attempt_id ||
        resume.binding.checkpointKind !== checkpoint.checkpoint_kind ||
        resume.binding.policyDigest !== binding.policy_digest ||
        resume.binding.fencingGeneration !== checkpoint.fencing_generation ||
        resume.binding.authorizationFencingGeneration !==
          binding.fencing_generation ||
        resume.binding.candidateSha !== binding.candidate_sha
      ) {
        return refuse(
          "PLAN_MISMATCH",
          "ASF recovery plan lost its exact protected implementer resume authorization",
        );
      }
    } else if (plan.implementerResume !== null) {
      return refuse(
        "PLAN_MISMATCH",
        "ASF recovery plan exposes implementer resume authority to a different action",
      );
    }
  }

  async #assertCurrentFence(
    checkpoint: DurableAsfCheckpoint,
    bindingInput: AsfDeliveryBinding,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const binding = bindingWire(bindingInput);
    const parsed = ownershipObservationSchema.safeParse(
      await this.#options.observations.observeOwnership({
        checkpoint,
        binding: bindingInput,
        workerId: this.#options.workerId,
        signal,
      }),
    );
    throwIfAborted(signal);
    if (!parsed.success) {
      return refuse(
        "FENCE_LOST",
        "current recovery fence observation failed strict validation",
      );
    }
    assertFreshWindow(
      parsed.data,
      this.#options.clock,
      "FENCE_LOST",
      "current recovery fence",
    );
    if (
      parsed.data.state !== "current" ||
      parsed.data.run_id !== binding.run_id ||
      parsed.data.work_order_id !== binding.work_order_id ||
      parsed.data.attempt_id !== binding.attempt_id ||
      parsed.data.worker_id !== this.#options.workerId ||
      parsed.data.fencing_generation !== binding.fencing_generation
    ) {
      return refuse(
        "FENCE_LOST",
        "current recovery ownership is missing, stale, or bound to another generation",
      );
    }
  }

  #assertOperationReceipt(
    receipt: AsfRecoveryOperationReceipt,
    operation: AsfTakeoverFencingOperation,
    ordinal: number,
    previousReceiptDigest: string | null,
    authorization: DurableAsfRecoveryAuthorization,
    checkpoint: DurableAsfCheckpoint,
    binding: BindingWire,
  ): void {
    const now = this.#options.clock.now().getTime();
    if (
      receipt.operation !== operation ||
      receipt.ordinal !== ordinal ||
      receipt.checkpoint_digest !== checkpoint.checkpoint_digest ||
      !exactBinding(receipt.binding, binding) ||
      receipt.authorization_record_digest !==
        authorization.authorization_record_digest ||
      receipt.previous_receipt_digest !== previousReceiptDigest ||
      Date.parse(receipt.completed_at) <
        Date.parse(authorization.authorized_at) ||
      Date.parse(receipt.completed_at) > now
    ) {
      return refuse(
        "FENCING_INCOMPLETE",
        "ASF recovery takeover receipt is stale, out of order, or bound to another plan",
      );
    }
  }

  #assertInvalidationReceipt(
    receipt: AsfRecoveryInvalidationReceipt,
    expectedEvidence: readonly AsfEvidenceClass[],
    previousReceiptDigest: string | null,
    authorization: DurableAsfRecoveryAuthorization,
    checkpoint: DurableAsfCheckpoint,
    binding: BindingWire,
  ): void {
    const now = this.#options.clock.now().getTime();
    if (
      receipt.checkpoint_digest !== checkpoint.checkpoint_digest ||
      !exactBinding(receipt.binding, binding) ||
      receipt.authorization_record_digest !==
        authorization.authorization_record_digest ||
      receipt.previous_receipt_digest !== previousReceiptDigest ||
      !exactArray(receipt.invalidated_evidence, expectedEvidence) ||
      Date.parse(receipt.completed_at) <
        Date.parse(authorization.authorized_at) ||
      Date.parse(receipt.completed_at) > now
    ) {
      return refuse(
        "INVALIDATION_INCOMPLETE",
        "ASF recovery evidence invalidation is partial, stale, or bound to another plan",
      );
    }
  }

  #assertDurableAcknowledgement(
    durable: DurableAsfRecoveryAcknowledgement,
    checkpoint: DurableAsfCheckpoint,
    binding: BindingWire,
    expectedAuthorizationId: string,
    planDigest: string,
    plan: AsfCheckpointRecoveryPlan,
  ): void {
    const acknowledgement = durable.acknowledgement;
    if (
      durable.authorization_id !== expectedAuthorizationId ||
      durable.checkpoint_digest !== checkpoint.checkpoint_digest ||
      !exactBinding(durable.binding, binding) ||
      durable.plan_digest !== planDigest ||
      acknowledgement.checkpoint_digest !== checkpoint.checkpoint_digest ||
      !exactBinding(acknowledgement.binding, binding) ||
      acknowledgement.action !== plan.action ||
      !exactArray(
        acknowledgement.completed_takeover_fencing,
        plan.requiredTakeoverFencing,
      ) ||
      !exactArray(
        acknowledgement.invalidated_evidence,
        plan.invalidatedEvidence,
      ) ||
      acknowledgement.acknowledgement_digest !==
        sha256Digest({
          checkpoint_digest: checkpoint.checkpoint_digest,
          action: plan.action,
          completed_takeover_fencing:
            acknowledgement.completed_takeover_fencing,
          invalidated_evidence: acknowledgement.invalidated_evidence,
        })
    ) {
      return refuse(
        "DURABILITY_UNPROVEN",
        "durable ASF recovery acknowledgement contradicts the authorized plan",
      );
    }
  }
}
