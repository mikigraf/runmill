import type { StateStore } from "../state/store.js";
import type { AsfGitHubEffectsController } from "./github-effects.js";
import type {
  AsfReconciliationPendingSetBinding,
  ReconciliationClassObserver,
} from "./reconciliation.js";

/**
 * Exact-set adapter from the GitHub controller's provider-specific observers
 * to the generic reconciliation coordinator. It exposes no mutation method:
 * `reconcilePending` on the GitHub controller only observes previously
 * persisted branch/PR intents.
 */
export class AsfGitHubReconciliationObserver implements ReconciliationClassObserver {
  readonly #store: StateStore;
  readonly #controller: Pick<AsfGitHubEffectsController, "reconcilePending">;
  readonly #maxPending: number;

  constructor(options: {
    readonly store: StateStore;
    readonly controller: Pick<AsfGitHubEffectsController, "reconcilePending">;
    readonly maxPending?: number | undefined;
  }) {
    const maxPending = options.maxPending ?? 20_000;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100_000) {
      throw new Error("GitHub reconciliation bound must be between 1 and 100000");
    }
    this.#store = options.store;
    this.#controller = options.controller;
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
      readonly effectClass: "github-effect";
    }[]
  > {
    if (input.effectClass !== "github-effect") {
      throw new Error("GitHub reconciliation observer received the wrong effect class");
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
      current.githubEffectCount !== input.expectedCount
    ) {
      throw new Error("GitHub reconciliation pending set changed before observation");
    }
    const effects = await this.#controller.reconcilePending({
      runId: input.runId,
      ownerId: input.ownerId,
      generation: input.generation,
    });
    if (effects.length !== input.expectedCount) {
      throw new Error("GitHub reconciliation result count is contradictory");
    }
    return Object.freeze(
      effects.map((effect) => ({
        effectClass: "github-effect" as const,
        effectKey: effect.effectKey,
        status: effect.status,
      })),
    );
  }
}
