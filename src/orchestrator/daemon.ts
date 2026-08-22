import type { Clock } from "../platform/clock.js";
import type {
  DurableCircuitBreakerState,
  StateStore,
} from "../state/store.js";
import type { RunOutcome } from "./orchestrator.js";

export type BreakerName = "consecutive-failures" | "daily-cost" | "quarantine" | "escalation-rate";

export interface BreakerState {
  readonly name: BreakerName;
  readonly open: boolean;
  readonly reason?: string | undefined;
  readonly openedAt?: string | undefined;
}

export interface CircuitBreakerConfig {
  readonly maxConsecutiveFailures: number;
  readonly maxQuarantines: number;
  readonly dailyCostUsd?: number | undefined;
  /** Fraction of runs that may escalate before the worker stops. */
  readonly maxEscalationRate?: number | undefined;
  readonly minRunsBeforeRateCheck?: number | undefined;
}

export type DailyWindow = "utc" | "local";

/** Calendar bucket used by the durable daily ledger. */
export function budgetDayBucket(at: Date, window: DailyWindow): string {
  if (window === "utc") return at.toISOString().slice(0, 10);
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const DEFAULT_BREAKERS: CircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  maxQuarantines: 1,
  minRunsBeforeRateCheck: 5,
  maxEscalationRate: 0.8,
};

export interface CircuitBreakerPersistence {
  getCircuitBreakerState(): DurableCircuitBreakerState;
  saveCircuitBreakerState(state: DurableCircuitBreakerState): void;
}

/**
 * Stop conditions for unattended operation.
 *
 * A worker that keeps going after repeated failures does not produce more
 * value, it produces more cleanup. Quarantine trips immediately because a
 * quarantine means something happened that policy could not classify, and
 * continuing past that is how one bad run becomes ten.
 */
export class CircuitBreakers {
  readonly #config: CircuitBreakerConfig;
  readonly #persistence: CircuitBreakerPersistence | undefined;
  #consecutiveFailures = 0;
  #quarantines = 0;
  #escalations = 0;
  #completed = 0;
  #spendUsd = 0;
  #dailyBucket: string | undefined;
  #tripped: BreakerState | undefined;

  constructor(
    config: CircuitBreakerConfig = DEFAULT_BREAKERS,
    persistence?: CircuitBreakerPersistence,
  ) {
    this.#config = config;
    this.#persistence = persistence;
    const durable = persistence?.getCircuitBreakerState();
    if (durable !== undefined) {
      this.#consecutiveFailures = durable.consecutiveFailures;
      this.#quarantines = durable.quarantines;
      this.#escalations = durable.escalations;
      this.#completed = durable.completed;
      if (durable.tripped !== null) {
        this.#tripped = { ...durable.tripped, open: true };
      }
    }
  }

  #persistNonDailyState(): void {
    const tripped = this.#tripped;
    let durableTrip: DurableCircuitBreakerState["tripped"] = null;
    if (tripped !== undefined && tripped.name !== "daily-cost") {
      if (tripped.openedAt === undefined || tripped.reason === undefined) {
        throw new Error("non-daily circuit breaker trip is missing durable metadata");
      }
      durableTrip = {
        name: tripped.name,
        openedAt: tripped.openedAt,
        reason: tripped.reason,
      };
    }
    this.#persistence?.saveCircuitBreakerState({
      consecutiveFailures: this.#consecutiveFailures,
      quarantines: this.#quarantines,
      escalations: this.#escalations,
      completed: this.#completed,
      tripped: durableTrip,
    });
  }

  record(outcome: RunOutcome): void {
    this.#completed += 1;
    this.#spendUsd += outcome.costUsd;

    const escalated =
      outcome.finalState === "NEEDS_HUMAN" || outcome.finalState === "AWAITING_APPROVAL";
    const failed = outcome.finalState === "QUARANTINED" || escalated;

    if (escalated) this.#escalations += 1;
    if (outcome.finalState === "QUARANTINED") this.#quarantines += 1;
    this.#consecutiveFailures = failed ? this.#consecutiveFailures + 1 : 0;
    this.#persistNonDailyState();
  }

  /** Synchronize spend from SQLite and reset only the daily breaker at a new day. */
  setDailySpend(dayBucket: string, costUsd: number): void {
    if (this.#dailyBucket !== dayBucket) {
      this.#dailyBucket = dayBucket;
      if (this.#tripped?.name === "daily-cost") this.#tripped = undefined;
    }
    this.#spendUsd = costUsd;
  }

  /** Non-destructive: returns the first tripped breaker, or undefined. */
  evaluate(clock: Clock): BreakerState | undefined {
    if (this.#tripped !== undefined) return this.#tripped;
    const at = clock.now().toISOString();

    if (this.#quarantines >= this.#config.maxQuarantines) {
      this.#tripped = {
        name: "quarantine",
        open: true,
        openedAt: at,
        reason: `${this.#quarantines} quarantined run(s); a quarantine means policy could not classify what happened`,
      };
      this.#persistNonDailyState();
      return this.#tripped;
    }

    if (this.#consecutiveFailures >= this.#config.maxConsecutiveFailures) {
      this.#tripped = {
        name: "consecutive-failures",
        open: true,
        openedAt: at,
        reason: `${this.#consecutiveFailures} consecutive runs did not complete`,
      };
      this.#persistNonDailyState();
      return this.#tripped;
    }

    if (this.#config.dailyCostUsd !== undefined && this.#spendUsd >= this.#config.dailyCostUsd) {
      this.#tripped = {
        name: "daily-cost",
        open: true,
        openedAt: at,
        reason: `spent $${this.#spendUsd.toFixed(2)} against a $${this.#config.dailyCostUsd} daily cap`,
      };
      return this.#tripped;
    }

    const minRuns = this.#config.minRunsBeforeRateCheck ?? 5;
    const maxRate = this.#config.maxEscalationRate;
    if (maxRate !== undefined && this.#completed >= minRuns) {
      const rate = this.#escalations / this.#completed;
      if (rate >= maxRate) {
        this.#tripped = {
          name: "escalation-rate",
          open: true,
          openedAt: at,
          reason:
            `${Math.round(rate * 100)}% of ${this.#completed} runs escalated to a human. ` +
            `The backlog is likely underspecified rather than the worker being broken.`,
        };
        this.#persistNonDailyState();
        return this.#tripped;
      }
    }

    return undefined;
  }

  get spendUsd(): number {
    return this.#spendUsd;
  }
}

export interface DaemonOptions {
  readonly clock: Clock;
  readonly store: StateStore;
  readonly breakers?: CircuitBreakers | undefined;
  /** Hard ceiling on runs in one session; undefined means until stopped. */
  readonly maxRuns?: number | undefined;
  /** Exit after the current queue drains instead of waiting for new work. */
  readonly stopWhenIdle?: boolean | undefined;
  /** How often an unattended daemon re-reads the backlog while idle. */
  readonly pollIntervalMs?: number | undefined;
  readonly onIdle?: (() => void) | undefined;
  readonly onEvent?: ((message: string) => void) | undefined;
  readonly dailyBudgetLedger?:
    | { readonly repo: string; readonly window: DailyWindow }
    | undefined;
}

export interface DaemonResult {
  readonly outcomes: readonly RunOutcome[];
  readonly stoppedBecause: "no-work" | "breaker" | "max-runs" | "signal";
  readonly breaker?: BreakerState | undefined;
}

/**
 * Serial continuous execution.
 *
 * Selection happens only after the previous run has released its lease and
 * cleaned up, so two runs never contend for the same repository. Each
 * iteration re-reads state rather than trusting what it held: the backlog can
 * change under a long run, and a lease can be lost.
 */
export class Daemon {
  readonly #opts: DaemonOptions;
  readonly #breakers: CircuitBreakers;
  #stopRequested = false;
  #wakeIdle: (() => void) | undefined;

  constructor(options: DaemonOptions) {
    this.#opts = options;
    this.#breakers = options.breakers ?? new CircuitBreakers();
  }

  requestStop(): void {
    this.#stopRequested = true;
    this.#wakeIdle?.();
  }

  async #waitWhileIdle(): Promise<void> {
    const interval = this.#opts.pollIntervalMs ?? 30_000;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#wakeIdle = undefined;
        resolve();
      };
      const timer = setTimeout(finish, interval);
      this.#wakeIdle = finish;
    });
  }

  #refreshDailyBudget(): void {
    const ledger = this.#opts.dailyBudgetLedger;
    if (ledger === undefined) return;
    const bucket = budgetDayBucket(this.#opts.clock.now(), ledger.window);
    const usage = this.#opts.store.budgetUsage(bucket, ledger.repo);
    this.#breakers.setDailySpend(bucket, usage.costUsd);
  }

  /**
   * @param runOnce performs exactly one run, or returns undefined when there
   *                is nothing eligible.
   */
  async loop(runOnce: () => Promise<RunOutcome | undefined>): Promise<DaemonResult> {
    const outcomes: RunOutcome[] = [];
    let idle = false;

    for (;;) {
      if (this.#stopRequested) {
        return { outcomes, stoppedBecause: "signal" };
      }

      this.#refreshDailyBudget();
      const breaker = this.#breakers.evaluate(this.#opts.clock);
      if (breaker !== undefined) {
        this.#opts.onEvent?.(`circuit breaker "${breaker.name}" opened: ${breaker.reason ?? ""}`);
        return { outcomes, stoppedBecause: "breaker", breaker };
      }

      if (this.#opts.maxRuns !== undefined && outcomes.length >= this.#opts.maxRuns) {
        return { outcomes, stoppedBecause: "max-runs" };
      }

      const outcome = await runOnce();
      if (outcome === undefined) {
        if (!idle) this.#opts.onIdle?.();
        idle = true;
        // Keep the class's historical drain-and-exit behavior by default.
        // The CLI opts into service mode unless the operator passes --once.
        if (this.#opts.stopWhenIdle !== false) {
          return { outcomes, stoppedBecause: "no-work" };
        }
        if (this.#stopRequested) continue;
        await this.#waitWhileIdle();
        continue;
      }

      idle = false;
      outcomes.push(outcome);
      this.#breakers.record(outcome);
      const ledger = this.#opts.dailyBudgetLedger;
      if (ledger !== undefined) {
        this.#opts.store.recordBudgetUsage({
          dayBucket: budgetDayBucket(this.#opts.clock.now(), ledger.window),
          repo: ledger.repo,
          costUsd: outcome.costUsd,
          invocations: outcome.agentInvocations ?? 0,
        });
      }
      this.#opts.onEvent?.(
        `${outcome.issueId} → ${outcome.finalState} ($${outcome.costUsd.toFixed(2)})`,
      );
    }
  }
}
