import { z } from "zod";
import { canonicalJson, sha256Digest } from "../asf/canonical-json.js";

export const ASF_TERMINAL_EFFECT_LEDGER_SCHEMA =
  "asf.terminal-effect-ledger/v1" as const;
export const ASF_TERMINAL_EFFECT_LEDGER_SCOPE =
  "before-terminal-cleanup" as const;

export const ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS = 100_000;
export const ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS = 100_000;
export const ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS = 10_000;
export const ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS = 100_000;
export const ASF_TERMINAL_EFFECT_LEDGER_MAX_CANONICAL_BYTES = 16 * 1_024 * 1_024;
export const ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT = 10_000;

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
const timestampSchema = z.iso.datetime({ offset: true });
const definitiveOutcomeSchema = z.enum(["confirmed", "not_applied"]);
const observationOutcomeSchema = z.enum([
  "confirmed",
  "not_applied",
  "ambiguous",
]);

const deliveryStageSchema = z.enum([
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
]);

const githubOperationSchema = z.enum([
  "branch.push",
  "pull_request.create",
  "pull_request.update",
  "status.create",
  "check.create",
  "comment.create",
]);

export const asfTerminalDeliveryEffectObservationSchema = z
  .object({
    seq: z.number().int().positive().safe(),
    outcome: observationOutcomeSchema,
    observation_digest: digestSchema,
    generation: z.number().int().positive().safe(),
    source: z.enum(["confirmation", "reconciliation", "legacy"]),
    observed_at: timestampSchema,
  })
  .strict();

export const asfTerminalGithubEffectObservationSchema = z
  .object({
    seq: z.number().int().positive().safe(),
    outcome: observationOutcomeSchema,
    observation_digest: digestSchema,
    observed_at: timestampSchema,
  })
  .strict();

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(
  context: z.core.$RefinementCtx<unknown>,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateObservationHistory(
  input: {
    readonly final_outcome: "confirmed" | "not_applied";
    readonly final_observation_seq: number;
    readonly observations: readonly {
      readonly seq: number;
      readonly outcome: "confirmed" | "not_applied" | "ambiguous";
      readonly observed_at: string;
    }[];
  },
  context: z.core.$RefinementCtx<unknown>,
): void {
  const last = input.observations.at(-1);
  if (
    input.observations.some(
      (observation, index) => observation.seq !== index + 1,
    )
  ) {
    addIssue(
      context,
      ["observations"],
      "effect observations must be contiguous and sorted from sequence 1",
    );
  }
  if (
    last === undefined ||
    last.seq !== input.final_observation_seq ||
    last.outcome !== input.final_outcome
  ) {
    addIssue(
      context,
      ["final_observation_seq"],
      "final outcome and sequence must equal the last definitive observation",
    );
  }
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const observation of input.observations) {
    const observedAt = Date.parse(observation.observed_at);
    if (observedAt < previousAt) {
      addIssue(
        context,
        ["observations"],
        "effect observation times must be nondecreasing",
      );
      break;
    }
    previousAt = observedAt;
  }
}

const deliveryEffectStructuralSchema = z
  .object({
    effect_class: z.literal("delivery-intent"),
    effect_key: identifierSchema,
    stage: deliveryStageSchema,
    candidate_sha: gitShaSchema.nullable(),
    event_seq: z.number().int().positive().safe(),
    intent_id: identifierSchema,
    intent_digest: digestSchema,
    operation_digest: digestSchema,
    fencing_generation: z.number().int().positive().safe(),
    created_at: timestampSchema,
    final_outcome: definitiveOutcomeSchema,
    final_observation_seq: z.number().int().positive().safe(),
    observations: z
      .array(asfTerminalDeliveryEffectObservationSchema)
      .min(1)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT),
    // Replay columns are active authority, not immutable history. Definitive
    // terminal effects must have consumed and cleared them; historical
    // not-applied decisions remain represented by reconciliation records.
    replay: z.null(),
  })
  .strict();

export const asfTerminalDeliveryEffectSchema =
  deliveryEffectStructuralSchema.superRefine((effect, context) => {
    validateObservationHistory(effect, context);
    if (
      effect.observations.some(
        (observation, index) =>
          observation.generation < effect.fencing_generation ||
          (index > 0 &&
            observation.generation <
              (effect.observations[index - 1]?.generation ?? 0)),
      )
    ) {
      addIssue(
        context,
        ["observations"],
        "delivery observation generations must be fenced and nondecreasing",
      );
    }
    if (
      Date.parse(effect.observations[0]?.observed_at ?? "") <
      Date.parse(effect.created_at)
    ) {
      addIssue(
        context,
        ["replay"],
        "delivery effect timing contradicts its history",
      );
    }
  });

const githubEffectStructuralSchema = z
  .object({
    effect_class: z.literal("github-effect"),
    effect_key: identifierSchema,
    operation: githubOperationSchema,
    candidate_sha: gitShaSchema,
    intent_digest: digestSchema,
    generation: z.number().int().positive().safe(),
    intended_at: timestampSchema,
    final_outcome: definitiveOutcomeSchema,
    final_observation_seq: z.number().int().positive().safe(),
    observations: z
      .array(asfTerminalGithubEffectObservationSchema)
      .min(1)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS_PER_EFFECT),
  })
  .strict();

export const asfTerminalGithubEffectSchema =
  githubEffectStructuralSchema.superRefine((effect, context) => {
    validateObservationHistory(effect, context);
    if (
      Date.parse(effect.observations[0]?.observed_at ?? "") <
      Date.parse(effect.intended_at)
    ) {
      addIssue(
        context,
        ["observations"],
        "GitHub observations cannot precede the durable intent",
      );
    }
  });

export const asfTerminalEffectSchema = z.discriminatedUnion("effect_class", [
  asfTerminalDeliveryEffectSchema,
  asfTerminalGithubEffectSchema,
]);

export const asfTerminalReconciliationEffectSchema = z
  .object({
    effect_class: z.enum(["delivery-intent", "github-effect"]),
    effect_key: identifierSchema,
    outcome: observationOutcomeSchema,
  })
  .strict();

const reconciliationStructuralSchema = z
  .object({
    operation_id: identifierSchema,
    request_digest: digestSchema,
    pending_set_digest: digestSchema,
    result_digest: digestSchema,
    status: z.enum(["completed", "blocked"]),
    requested_at: timestampSchema,
    started_at: timestampSchema.nullable(),
    completed_at: timestampSchema,
    effects: z
      .array(asfTerminalReconciliationEffectSchema)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS),
  })
  .strict();

export const asfTerminalReconciliationSchema =
  reconciliationStructuralSchema.superRefine((reconciliation, context) => {
    const seen = new Set<string>();
    let previous = "";
    for (const [index, effect] of reconciliation.effects.entries()) {
      const key = `${effect.effect_class}\u0000${effect.effect_key}`;
      if (seen.has(key) || (index > 0 && compareStrings(previous, key) >= 0)) {
        addIssue(
          context,
          ["effects", index],
          "reconciliation effects must be unique and canonically sorted",
        );
        break;
      }
      seen.add(key);
      previous = key;
    }
    const requestedAt = Date.parse(reconciliation.requested_at);
    const completedAt = Date.parse(reconciliation.completed_at);
    const startedAt =
      reconciliation.started_at === null
        ? null
        : Date.parse(reconciliation.started_at);
    if (
      (startedAt === null &&
        (reconciliation.status !== "completed" ||
          reconciliation.effects.length !== 0 ||
          requestedAt !== completedAt)) ||
      (startedAt !== null &&
        (requestedAt > startedAt || startedAt > completedAt))
    ) {
      addIssue(
        context,
        ["completed_at"],
        "reconciliation times must exactly describe a no-op or request, start, completion order",
      );
    }
  });

const effectInputSchema = z.discriminatedUnion("effect_class", [
  deliveryEffectStructuralSchema,
  githubEffectStructuralSchema,
]);

const buildInputSchema = z
  .object({
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    effects: z
      .array(effectInputSchema)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS),
    reconciliations: z
      .array(reconciliationStructuralSchema)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS),
  })
  .strict();

const terminalEffectLedgerShape = z
  .object({
    schema: z.literal(ASF_TERMINAL_EFFECT_LEDGER_SCHEMA),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    policy_digest: digestSchema,
    scope: z.literal(ASF_TERMINAL_EFFECT_LEDGER_SCOPE),
    effect_count: z
      .number()
      .int()
      .min(0)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS),
    observation_count: z
      .number()
      .int()
      .min(0)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS),
    reconciliation_count: z
      .number()
      .int()
      .min(0)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS),
    reconciliation_effect_ref_count: z
      .number()
      .int()
      .min(0)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS),
    effects: z
      .array(asfTerminalEffectSchema)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_EFFECTS),
    reconciliations: z
      .array(asfTerminalReconciliationSchema)
      .max(ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATIONS),
    ledger_digest: digestSchema,
  })
  .strict();

export const asfTerminalEffectLedgerSchema =
  terminalEffectLedgerShape.superRefine((ledger, context) => {
    const effectKeys = new Set<string>();
    const effectByCompositeKey = new Map<
      string,
      (typeof ledger.effects)[number]
    >();
    let previousEffect = "";
    for (const [index, effect] of ledger.effects.entries()) {
      const composite = `${effect.effect_class}\u0000${effect.effect_key}`;
      if (
        effectKeys.has(effect.effect_key) ||
        (index > 0 && compareStrings(previousEffect, composite) >= 0)
      ) {
        addIssue(
          context,
          ["effects", index],
          "terminal effects must have globally unique keys and canonical order",
        );
        break;
      }
      effectKeys.add(effect.effect_key);
      effectByCompositeKey.set(composite, effect);
      previousEffect = composite;
    }

    const reconciliationIds = new Set<string>();
    let previousReconciliation = "";
    for (const [index, reconciliation] of ledger.reconciliations.entries()) {
      if (
        reconciliationIds.has(reconciliation.operation_id) ||
        (index > 0 &&
          compareStrings(
            previousReconciliation,
            reconciliation.operation_id,
          ) >= 0)
      ) {
        addIssue(
          context,
          ["reconciliations", index],
          "reconciliations must have unique operation ids and canonical order",
        );
        break;
      }
      reconciliationIds.add(reconciliation.operation_id);
      previousReconciliation = reconciliation.operation_id;
      for (const [effectIndex, reference] of reconciliation.effects.entries()) {
        const effect = effectByCompositeKey.get(
          `${reference.effect_class}\u0000${reference.effect_key}`,
        );
        if (
          effect === undefined ||
          !effect.observations.some(
            (observation) => observation.outcome === reference.outcome,
          )
        ) {
          addIssue(
            context,
            ["reconciliations", index, "effects", effectIndex],
            "reconciliation reference is absent from the terminal effect history",
          );
        }
      }
    }

    const observationCount = ledger.effects.reduce(
      (count, effect) => count + effect.observations.length,
      0,
    );
    const reconciliationEffectCount = ledger.reconciliations.reduce(
      (count, reconciliation) => count + reconciliation.effects.length,
      0,
    );
    if (
      ledger.effect_count !== ledger.effects.length ||
      ledger.observation_count !== observationCount ||
      ledger.reconciliation_count !== ledger.reconciliations.length ||
      ledger.reconciliation_effect_ref_count !== reconciliationEffectCount
    ) {
      addIssue(
        context,
        ["effect_count"],
        "terminal effect ledger counts must exactly cover every bounded record",
      );
    }
    if (
      observationCount > ASF_TERMINAL_EFFECT_LEDGER_MAX_OBSERVATIONS ||
      reconciliationEffectCount >
        ASF_TERMINAL_EFFECT_LEDGER_MAX_RECONCILIATION_EFFECTS
    ) {
      addIssue(
        context,
        ["observation_count"],
        "terminal effect ledger exceeds its aggregate evidence bound",
      );
    }
    if (
      Buffer.byteLength(canonicalJson(ledger), "utf8") >
      ASF_TERMINAL_EFFECT_LEDGER_MAX_CANONICAL_BYTES
    ) {
      addIssue(
        context,
        ["effects"],
        "terminal effect ledger exceeds its canonical byte bound",
      );
    }

    const { ledger_digest: ledgerDigest, ...unsigned } = ledger;
    if (ledgerDigest !== sha256Digest(unsigned)) {
      addIssue(
        context,
        ["ledger_digest"],
        "terminal effect ledger digest contradicts its canonical contents",
      );
    }
  });

export type AsfTerminalDeliveryEffectObservation = z.infer<
  typeof asfTerminalDeliveryEffectObservationSchema
>;
export type AsfTerminalGithubEffectObservation = z.infer<
  typeof asfTerminalGithubEffectObservationSchema
>;
export type AsfTerminalDeliveryEffect = z.infer<
  typeof asfTerminalDeliveryEffectSchema
>;
export type AsfTerminalGithubEffect = z.infer<
  typeof asfTerminalGithubEffectSchema
>;
export type AsfTerminalEffect = z.infer<typeof asfTerminalEffectSchema>;
export type AsfTerminalReconciliationEffect = z.infer<
  typeof asfTerminalReconciliationEffectSchema
>;
export type AsfTerminalReconciliation = z.infer<
  typeof asfTerminalReconciliationSchema
>;
export type AsfTerminalEffectLedger = z.infer<
  typeof asfTerminalEffectLedgerSchema
>;
export type AsfTerminalEffectLedgerBuildInput = z.infer<
  typeof buildInputSchema
>;

type UnsignedAsfTerminalEffectLedger = Omit<
  AsfTerminalEffectLedger,
  "ledger_digest"
>;

/** Compute the content address over the complete canonical ledger sans digest. */
export function asfTerminalEffectLedgerDigest(
  ledger: UnsignedAsfTerminalEffectLedger,
): `sha256:${string}` {
  return sha256Digest(ledger);
}

function effectSortKey(effect: AsfTerminalEffect): string {
  return `${effect.effect_class}\u0000${effect.effect_key}`;
}

/**
 * Build portable, privacy-safe evidence from public durable records. Arrays are
 * copied and sorted; contradictions, gaps, cleanup authority, and private
 * fields are refused by the strict schemas rather than silently discarded.
 */
export function buildAsfTerminalEffectLedger(
  raw: AsfTerminalEffectLedgerBuildInput,
): AsfTerminalEffectLedger {
  const input = buildInputSchema.parse(raw);
  const effects = input.effects
    .map((effect): AsfTerminalEffect => {
      return effect.effect_class === "delivery-intent"
        ? {
            ...effect,
            observations: [...effect.observations].sort(
              (left, right) => left.seq - right.seq,
            ),
          }
        : {
            ...effect,
            observations: [...effect.observations].sort(
              (left, right) => left.seq - right.seq,
            ),
          };
    })
    .sort((left, right) =>
      compareStrings(effectSortKey(left), effectSortKey(right)),
    );
  const reconciliations = input.reconciliations
    .map((reconciliation) => ({
      ...reconciliation,
      effects: [...reconciliation.effects].sort((left, right) =>
        compareStrings(
          `${left.effect_class}\u0000${left.effect_key}`,
          `${right.effect_class}\u0000${right.effect_key}`,
        ),
      ),
    }))
    .sort((left, right) =>
      compareStrings(left.operation_id, right.operation_id),
    );
  const unsigned: UnsignedAsfTerminalEffectLedger = {
    schema: ASF_TERMINAL_EFFECT_LEDGER_SCHEMA,
    run_id: input.run_id,
    work_order_id: input.work_order_id,
    attempt_id: input.attempt_id,
    policy_digest: input.policy_digest,
    scope: ASF_TERMINAL_EFFECT_LEDGER_SCOPE,
    effect_count: effects.length,
    observation_count: effects.reduce(
      (count, effect) => count + effect.observations.length,
      0,
    ),
    reconciliation_count: reconciliations.length,
    reconciliation_effect_ref_count: reconciliations.reduce(
      (count, reconciliation) => count + reconciliation.effects.length,
      0,
    ),
    effects,
    reconciliations,
  };
  return asfTerminalEffectLedgerSchema.parse({
    ...unsigned,
    ledger_digest: asfTerminalEffectLedgerDigest(unsigned),
  });
}

/** Validate schema, bounds, ordering, completeness, and the canonical digest. */
export function validateAsfTerminalEffectLedger(
  raw: unknown,
): AsfTerminalEffectLedger {
  return asfTerminalEffectLedgerSchema.parse(raw);
}
