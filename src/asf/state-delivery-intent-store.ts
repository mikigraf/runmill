import { z } from "zod";
import type {
  AsfDeliveryBinding,
  AsfDeliveryIntentRecordResult,
  AsfDeliveryIntentStore,
  AsfDeliveryStageIntent,
} from "./delivery-runner.js";
import {
  ASF_DELIVERY_STAGE_INTENT_SCHEMA,
  ASF_DELIVERY_STAGES,
} from "./delivery-runner.js";
import type {
  StateAsfDeliveryStageIntent,
  StateStore,
  StoredAsfDeliveryStageIntent,
} from "../state/store.js";
import type {
  AsfReconciliationPendingSetBinding,
  ReconciliationClassObserver,
} from "./reconciliation.js";
import {
  asfTerminalCleanupObservationSchema,
  asfTerminalEvidencePlanSchema,
  type AsfTerminalCleanupObservation,
  type AsfTerminalEvidencePlan,
} from "../evidence/asf-terminal.js";

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

const intentSchema = z
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
    fencing_generation: z.number().int().positive().safe(),
    candidate_sha: gitShaSchema.nullable(),
    event_seq: z.number().int().positive().safe(),
    operation_digest: digestSchema,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

const bindingSchema = z
  .object({
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    policyDigest: digestSchema,
    fencingGeneration: z.number().int().positive().safe(),
    candidateSha: gitShaSchema.nullable(),
  })
  .strict();

const confirmationSchema = z
  .object({
    intentId: identifierSchema,
    intentDigest: digestSchema,
    observationDigest: digestSchema,
    binding: bindingSchema,
  })
  .strict();

function exactIntent(stored: StateAsfDeliveryStageIntent): AsfDeliveryStageIntent {
  return {
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
  };
}

/**
 * Production write-ahead adapter for all non-forge ASF lifecycle effects.
 * The StateStore is the authority for ownership and exact durable bindings;
 * this class only validates the runner-facing shape and supplies its fixed
 * worker identity.
 */
export class StateStoreAsfDeliveryIntentStore implements AsfDeliveryIntentStore {
  readonly #store: StateStore;
  readonly #ownerId: string;

  constructor(store: StateStore, ownerId: string) {
    this.#store = store;
    this.#ownerId = identifierSchema.parse(ownerId);
  }

  record(intent: AsfDeliveryStageIntent): AsfDeliveryIntentRecordResult {
    const parsed = intentSchema.parse(intent) as StateAsfDeliveryStageIntent;
    const result = this.#store.recordAsfDeliveryIntent({
      ownerId: this.#ownerId,
      intent: parsed,
    });
    return {
      intent: exactIntent(result.intent),
      disposition: result.disposition,
    };
  }

  confirm(input: {
    readonly intentId: string;
    readonly intentDigest: string;
    readonly observationDigest: string;
    readonly binding: AsfDeliveryBinding;
  }): void {
    const parsed = confirmationSchema.parse(input);
    this.#store.confirmAsfDeliveryIntent({
      ownerId: this.#ownerId,
      intentId: parsed.intentId,
      intentDigest: parsed.intentDigest,
      observationDigest: parsed.observationDigest,
      binding: parsed.binding,
    });
  }

  prepareTerminal(input: {
    readonly intent: AsfDeliveryStageIntent;
    readonly plan: AsfTerminalEvidencePlan;
  }) {
    const intent = intentSchema.parse(input.intent) as StateAsfDeliveryStageIntent;
    const plan = asfTerminalEvidencePlanSchema.parse(input.plan);
    const result = this.#store.recordAsfTerminalCleanupPlan({
      ownerId: this.#ownerId,
      cleanupIntent: intent,
      plan,
    });
    return {
      intent: exactIntent(result.intent),
      disposition: result.disposition,
      plan: result.plan,
    };
  }

  sealTerminal(input: {
    readonly runId: string;
    readonly planDigest: string;
    readonly cleanupObservation: AsfTerminalCleanupObservation;
    readonly generation: number;
  }) {
    return this.#store.sealAsfTerminalEvidenceIntent({
      runId: input.runId,
      planDigest: digestSchema.parse(input.planDigest),
      cleanupObservation: asfTerminalCleanupObservationSchema.parse(
        input.cleanupObservation,
      ),
      ownerId: this.#ownerId,
      generation: input.generation,
    });
  }
}

const reconciliationObservationSchema = z
  .object({
    schema: z.literal("asf.delivery-intent-reconciliation-observation/v1"),
    effect_key: identifierSchema,
    intent_digest: digestSchema,
    outcome: z.enum(["confirmed", "not_applied", "ambiguous"]),
    observation_digest: digestSchema,
  })
  .strict();

export interface AsfDeliveryIntentReconciliationAdapter {
  /** Read-only observation of the exact prior intent; this grants no replay authority. */
  observe(input: {
    readonly intent: StoredAsfDeliveryStageIntent;
    readonly binding: AsfDeliveryBinding;
    readonly intentMode: "reconcile-only";
  }): Promise<unknown>;
}

/**
 * Production state adapter for generic lifecycle-intent reconciliation. The
 * injected stage observer can only return evidence; StateStore validates and
 * commits the exact outcome under the current run generation.
 */
export class StateStoreAsfDeliveryReconciliationObserver
  implements ReconciliationClassObserver
{
  readonly #store: StateStore;
  readonly #adapter: AsfDeliveryIntentReconciliationAdapter;
  readonly #maxPending: number;

  constructor(options: {
    readonly store: StateStore;
    readonly adapter: AsfDeliveryIntentReconciliationAdapter;
    readonly maxPending?: number | undefined;
  }) {
    const maxPending = options.maxPending ?? 20_000;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100_000) {
      throw new Error("delivery reconciliation bound must be between 1 and 100000");
    }
    this.#store = options.store;
    this.#adapter = options.adapter;
    this.#maxPending = maxPending;
  }

  async reconcilePending(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly effectClass: "github-effect" | "delivery-intent";
    readonly expectedCount: number;
    readonly pendingSetBinding: AsfReconciliationPendingSetBinding;
  }): Promise<
    readonly {
      readonly status: string;
      readonly effectKey: string;
      readonly effectClass: "delivery-intent";
    }[]
  > {
    if (input.effectClass !== "delivery-intent") {
      throw new Error("delivery reconciliation observer received the wrong effect class");
    }
    const current = this.#store.getPendingAsfReconciliationRun(
      input.runId,
      this.#maxPending,
    );
    if (
      current === undefined ||
      current.pendingSetDigest !== input.pendingSetBinding.pendingSetDigest ||
      current.githubEffectCount !== input.pendingSetBinding.githubEffectCount ||
      current.deliveryIntentCount !== input.pendingSetBinding.deliveryIntentCount ||
      current.deliveryIntentCount !== input.expectedCount
    ) {
      throw new Error("delivery reconciliation pending set changed before observation");
    }
    const intents = this.#store.listPendingAsfDeliveryIntents(
      input.runId,
      this.#maxPending,
    );
    if (intents.length !== input.expectedCount) {
      throw new Error("delivery reconciliation intent count is contradictory");
    }
    const results: {
      status: string;
      effectKey: string;
      effectClass: "delivery-intent";
    }[] = [];
    for (const intent of intents) {
      const raw = await this.#adapter.observe({
        intent,
        intentMode: "reconcile-only",
        binding: {
          runId: intent.run_id,
          workOrderId: intent.work_order_id,
          attemptId: intent.attempt_id,
          policyDigest: intent.policy_digest,
          fencingGeneration: input.generation,
          candidateSha: intent.candidate_sha,
        },
      });
      const observation = reconciliationObservationSchema.parse(raw);
      if (
        observation.effect_key !== intent.effect_key ||
        observation.intent_digest !== intent.intent_digest
      ) {
        throw new Error("delivery reconciliation observation is not bound to its exact intent");
      }
      if (observation.outcome !== "ambiguous") {
        this.#store.resolveAsfDeliveryIntentReconciliation({
          effectKey: intent.effect_key,
          ownerId: input.ownerId,
          generation: input.generation,
          outcome: observation.outcome,
          observationDigest: observation.observation_digest,
        });
      }
      results.push({
        effectClass: "delivery-intent",
        effectKey: intent.effect_key,
        status: observation.outcome,
      });
    }
    return Object.freeze(results);
  }
}
