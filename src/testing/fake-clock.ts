import type { Clock } from "../platform/clock.js";

/**
 * Deterministic clock for tests.
 *
 * Ships as part of the package (not only the test tree) because adapter and
 * policy tests outside this repository need the same control over time.
 */
export class FakeClock implements Clock {
  #wallMs: number;
  #monotonicMs = 0;

  constructor(start: string | number | Date = "2026-01-01T00:00:00Z") {
    this.#wallMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#wallMs);
  }

  monotonicMs(): number {
    return this.#monotonicMs;
  }

  /** Advance wall and monotonic time together, as ordinary elapsed time does. */
  advanceMs(ms: number): void {
    if (ms < 0) throw new Error("FakeClock cannot move backwards");
    this.#wallMs += ms;
    this.#monotonicMs += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  /**
   * Simulate a suspended laptop: wall time leaps forward, and monotonic time
   * advances with it. This is the scenario that expires a lease while the run
   * is still legitimately working, so it gets a first-class helper.
   */
  simulateSuspend(ms: number): void {
    this.advanceMs(ms);
  }

  /**
   * A view of this clock offset by a fixed skew, for cross-host lease tests.
   * The view tracks subsequent advancement of the parent.
   */
  withSkewMs(skewMs: number): Clock {
    const parent = this;
    return {
      now: () => new Date(parent.now().getTime() + skewMs),
      monotonicMs: () => parent.monotonicMs(),
    };
  }
}
