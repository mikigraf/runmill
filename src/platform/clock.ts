/**
 * Injectable time.
 *
 * Nothing in runmill reads the wall clock directly. Lease expiry, heartbeat
 * margins, budgets, and timeouts all cross a laptop that sleeps and,
 * potentially, two hosts with clock skew — so time is a dependency, not an
 * ambient fact. It is also what makes expiry and budget exhaustion testable in
 * milliseconds instead of hours.
 */
export interface Clock {
  /** Wall-clock instant. May jump (NTP correction, suspend/resume). */
  now(): Date;
  /**
   * Monotonic milliseconds since an arbitrary origin. Never goes backwards.
   * Use for durations; never for "what time is it".
   */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    // performance.now() is monotonic and unaffected by wall-clock corrections.
    return performance.now();
  }
}
