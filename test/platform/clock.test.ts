import { describe, expect, it } from "vitest";
import { SystemClock } from "../../src/platform/clock.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

describe("SystemClock", () => {
  it("returns a real instant", () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it("monotonic time never goes backwards", () => {
    const clock = new SystemClock();
    const a = clock.monotonicMs();
    const b = clock.monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("FakeClock", () => {
  it("starts at the instant it was given", () => {
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-08-06T10:00:00.000Z");
  });

  it("advances wall time and monotonic time together", () => {
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    const m0 = clock.monotonicMs();
    clock.advanceMs(90_000);
    expect(clock.now().toISOString()).toBe("2026-08-06T10:01:30.000Z");
    expect(clock.monotonicMs() - m0).toBe(90_000);
  });

  it("advances by minutes for lease-expiry style assertions", () => {
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    clock.advanceMinutes(21);
    expect(clock.now().toISOString()).toBe("2026-08-06T10:21:00.000Z");
  });

  it("simulates a laptop sleep: a large wall jump with monotonic continuity", () => {
    // A suspended laptop is the case that breaks naive lease renewal. Wall
    // time leaps; monotonic time must not be used to conclude no time passed.
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    clock.simulateSuspend(6 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2026-08-06T16:00:00.000Z");
    expect(clock.monotonicMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("supports clock skew for cross-host lease tests", () => {
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    const skewed = clock.withSkewMs(-5_000);
    expect(skewed.now().toISOString()).toBe("2026-08-06T09:59:55.000Z");
    clock.advanceMs(1_000);
    expect(skewed.now().toISOString()).toBe("2026-08-06T09:59:56.000Z");
  });

  it("rejects negative advancement", () => {
    const clock = new FakeClock("2026-08-06T10:00:00Z");
    expect(() => clock.advanceMs(-1)).toThrow(/cannot move backwards/i);
  });
});
