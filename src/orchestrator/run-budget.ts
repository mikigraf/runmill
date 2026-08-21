import type { AgentEvent } from "../agent/events.js";
import { accumulateUsage } from "../agent/events.js";
import type { Clock } from "../platform/clock.js";
import { RunmillError } from "../errors/runmill-error.js";

export type InvocationBudgetRole =
  | "implementer"
  | "localReview"
  | "fixer"
  | "prReview"
  | "prFixer";

export interface RunBudgetOptions {
  readonly clock: Clock;
  readonly maxWallMs: number;
  readonly maxCostUsd?: number | undefined;
  readonly maxInvocations: Readonly<Record<InvocationBudgetRole | "total", number>>;
  readonly clampInvocationTimeout: boolean;
  readonly costEnforcement: "auto" | "wall-and-invocations-only";
}

/** Runtime enforcement for the issue-local limits in operator policy. */
export class RunBudget {
  readonly #options: RunBudgetOptions;
  readonly #startedAt: number;
  readonly #counts: Record<InvocationBudgetRole | "total", number> = {
    total: 0,
    implementer: 0,
    localReview: 0,
    fixer: 0,
    prReview: 0,
    prFixer: 0,
  };
  #costUsd = 0;

  constructor(options: RunBudgetOptions) {
    this.#options = options;
    this.#startedAt = options.clock.monotonicMs();
  }

  get costUsd(): number {
    return this.#costUsd;
  }

  get invocationCount(): number {
    return this.#counts.total;
  }

  get elapsedMs(): number {
    return Math.max(0, this.#options.clock.monotonicMs() - this.#startedAt);
  }

  assertActive(stage: string): void {
    if (this.elapsedMs >= this.#options.maxWallMs) {
      this.#exhausted(
        `wall-time cap reached before ${stage}: ${this.elapsedMs}ms elapsed against ${this.#options.maxWallMs}ms`,
      );
    }
  }

  /** Reserve one provider call and return its policy-bounded timeout. */
  beginInvocation(role: InvocationBudgetRole, requestedTimeoutMs: number): number {
    this.assertActive(`${role} invocation`);
    if (this.#counts.total >= this.#options.maxInvocations.total) {
      this.#exhausted(
        `agent invocation total exhausted (${this.#counts.total}/${this.#options.maxInvocations.total})`,
      );
    }
    if (this.#counts[role] >= this.#options.maxInvocations[role]) {
      this.#exhausted(
        `${role} invocation budget exhausted (${this.#counts[role]}/${this.#options.maxInvocations[role]})`,
      );
    }
    this.#counts.total += 1;
    this.#counts[role] += 1;

    if (!this.#options.clampInvocationTimeout) return requestedTimeoutMs;
    const remaining = Math.max(1, this.#options.maxWallMs - this.elapsedMs);
    return Math.min(requestedTimeoutMs, remaining);
  }

  /** Account for a completed call, refusing when a configured cost cap is unknown or exceeded. */
  finishInvocation(events: readonly AgentEvent[]): void {
    const usage = accumulateUsage(events);
    this.#costUsd += usage.costUsd;
    const cap = this.#options.maxCostUsd;
    if (cap !== undefined && this.#options.costEnforcement !== "wall-and-invocations-only") {
      if (!usage.costReported) {
        this.#exhausted(
          "a dollar cap is configured but this provider invocation reported no cost; refusing to treat unknown spend as zero",
        );
      }
      if (this.#costUsd > cap) {
        this.#exhausted(
          `issue cost cap exceeded ($${this.#costUsd.toFixed(4)} spent against $${cap.toFixed(4)})`,
        );
      }
    }
    this.assertActive("the next delivery stage");
  }

  #exhausted(detail: string): never {
    throw RunmillError.fromCatalog("RM-PROVIDER-002", { whatHappened: detail });
  }
}
