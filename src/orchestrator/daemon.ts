import type { Clock } from "../platform/clock.js";
import type { StateStore } from "../state/store.js";
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

export const DEFAULT_BREAKERS: CircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  maxQuarantines: 1,
  minRunsBeforeRateCheck: 5,
  maxEscalationRate: 0.8,
};

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
  #consecutiveFailures = 0;
  #quarantines = 0;
  #escalations = 0;
  #completed = 0;
  #spendUsd = 0;
  #tripped: BreakerState | undefined;

  constructor(config: CircuitBreakerConfig = DEFAULT_BREAKERS) {
    this.#config = config;
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
      return this.#tripped;
    }

    if (this.#consecutiveFailures >= this.#config.maxConsecutiveFailures) {
      this.#tripped = {
        name: "consecutive-failures",
        open: true,
        openedAt: at,
        reason: `${this.#consecutiveFailures} consecutive runs did not complete`,
      };
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
  /** Hard ceiling on runs in one session; undefined means until work runs out. */
  readonly maxRuns?: number | undefined;
  readonly onIdle?: (() => void) | undefined;
  readonly onEvent?: ((message: string) => void) | undefined;
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

  constructor(options: DaemonOptions) {
    this.#opts = options;
    this.#breakers = options.breakers ?? new CircuitBreakers();
  }

  requestStop(): void {
    this.#stopRequested = true;
  }

  /**
   * @param runOnce performs exactly one run, or returns undefined when there
   *                is nothing eligible.
   */
  async loop(runOnce: () => Promise<RunOutcome | undefined>): Promise<DaemonResult> {
    const outcomes: RunOutcome[] = [];

    for (;;) {
      if (this.#stopRequested) {
        return { outcomes, stoppedBecause: "signal" };
      }

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
        this.#opts.onIdle?.();
        return { outcomes, stoppedBecause: "no-work" };
      }

      outcomes.push(outcome);
      this.#breakers.record(outcome);
      this.#opts.onEvent?.(
        `${outcome.issueId} → ${outcome.finalState} ($${outcome.costUsd.toFixed(2)})`,
      );
    }
  }
}
