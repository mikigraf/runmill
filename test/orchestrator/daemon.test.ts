import { describe, expect, it } from "vitest";
import { CircuitBreakers, Daemon, DEFAULT_BREAKERS } from "../../src/orchestrator/daemon.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import type { RunOutcome } from "../../src/orchestrator/orchestrator.js";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run_x",
    issueId: "ENG-1",
    finalState: "PR_DELIVERED",
    costUsd: 0.1,
    ...over,
  };
}

const clock = (): FakeClock => new FakeClock("2026-08-06T10:00:00Z");

describe("CircuitBreakers", () => {
  it("stays closed while runs succeed", () => {
    const b = new CircuitBreakers();
    for (let i = 0; i < 20; i += 1) b.record(outcome());
    expect(b.evaluate(clock())).toBeUndefined();
  });

  it("opens immediately on a quarantine", () => {
    // A quarantine means policy could not classify what happened. Continuing
    // past that is how one bad run becomes ten.
    const b = new CircuitBreakers();
    b.record(outcome({ finalState: "QUARANTINED" }));
    expect(b.evaluate(clock())?.name).toBe("quarantine");
  });

  it("opens after the configured consecutive failures", () => {
    const b = new CircuitBreakers({ ...DEFAULT_BREAKERS, maxQuarantines: 99 });
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    expect(b.evaluate(clock())).toBeUndefined();
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    expect(b.evaluate(clock())?.name).toBe("consecutive-failures");
  });

  it("resets the consecutive counter after a success", () => {
    const b = new CircuitBreakers({ ...DEFAULT_BREAKERS, maxQuarantines: 99 });
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    b.record(outcome({ finalState: "PR_DELIVERED" }));
    b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    expect(b.evaluate(clock())).toBeUndefined();
  });

  it("opens on the daily cost cap", () => {
    const b = new CircuitBreakers({ ...DEFAULT_BREAKERS, dailyCostUsd: 1 });
    b.record(outcome({ costUsd: 0.6 }));
    expect(b.evaluate(clock())).toBeUndefined();
    b.record(outcome({ costUsd: 0.6 }));
    const tripped = b.evaluate(clock());
    expect(tripped?.name).toBe("daily-cost");
    expect(tripped?.reason).toMatch(/1\.20/);
  });

  it("opens when most runs escalate, and says the backlog is the likely cause", () => {
    // The failure mode the product is most exposed to: a backlog too
    // underspecified to execute. That is not the worker being broken.
    const b = new CircuitBreakers({ ...DEFAULT_BREAKERS, maxQuarantines: 99, maxConsecutiveFailures: 99 });
    for (let i = 0; i < 5; i += 1) b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    const tripped = b.evaluate(clock());
    expect(tripped?.name).toBe("escalation-rate");
    expect(tripped?.reason).toMatch(/underspecified/i);
  });

  it("does not judge the escalation rate before enough runs", () => {
    const b = new CircuitBreakers({
      ...DEFAULT_BREAKERS,
      maxQuarantines: 99,
      maxConsecutiveFailures: 99,
      minRunsBeforeRateCheck: 10,
    });
    for (let i = 0; i < 5; i += 1) b.record(outcome({ finalState: "NEEDS_HUMAN" }));
    expect(b.evaluate(clock())).toBeUndefined();
  });

  it("stays open once tripped", () => {
    const b = new CircuitBreakers();
    b.record(outcome({ finalState: "QUARANTINED" }));
    const first = b.evaluate(clock());
    b.record(outcome({ finalState: "PR_DELIVERED" }));
    expect(b.evaluate(clock())).toEqual(first);
  });

  it("accumulates spend across runs", () => {
    const b = new CircuitBreakers();
    b.record(outcome({ costUsd: 0.25 }));
    b.record(outcome({ costUsd: 0.5 }));
    expect(b.spendUsd).toBeCloseTo(0.75);
  });
});

describe("Daemon", () => {
  it("processes issues serially until the work runs out", async () => {
    const queue = [outcome({ issueId: "ENG-1" }), outcome({ issueId: "ENG-2" })];
    const daemon = new Daemon({ clock: clock(), store: {} as never });
    const result = await daemon.loop(async () => queue.shift());
    expect(result.stoppedBecause).toBe("no-work");
    expect(result.outcomes.map((o) => o.issueId)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("never overlaps runs", async () => {
    let active = 0;
    let maxActive = 0;
    let remaining = 4;
    const daemon = new Daemon({ clock: clock(), store: {} as never });
    await daemon.loop(async () => {
      if (remaining === 0) return undefined;
      remaining -= 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return outcome();
    });
    expect(maxActive).toBe(1);
  });

  it("stops when a breaker opens and reports which one", async () => {
    const daemon = new Daemon({ clock: clock(), store: {} as never });
    const result = await daemon.loop(async () => outcome({ finalState: "QUARANTINED" }));
    expect(result.stoppedBecause).toBe("breaker");
    expect(result.breaker?.name).toBe("quarantine");
    expect(result.outcomes).toHaveLength(1);
  });

  it("honours a maximum run count", async () => {
    const daemon = new Daemon({ clock: clock(), store: {} as never, maxRuns: 2 });
    const result = await daemon.loop(async () => outcome());
    expect(result.stoppedBecause).toBe("max-runs");
    expect(result.outcomes).toHaveLength(2);
  });

  it("stops cleanly on request rather than mid-run", async () => {
    const daemon = new Daemon({ clock: clock(), store: {} as never });
    let count = 0;
    const result = await daemon.loop(async () => {
      count += 1;
      if (count === 2) daemon.requestStop();
      return outcome();
    });
    expect(result.stoppedBecause).toBe("signal");
    // The in-flight run completed; the stop took effect at the boundary.
    expect(result.outcomes).toHaveLength(2);
  });

  it("reports idle when there is nothing eligible at all", async () => {
    let idle = false;
    const daemon = new Daemon({
      clock: clock(),
      store: {} as never,
      onIdle: () => (idle = true),
    });
    const result = await daemon.loop(async () => undefined);
    expect(result.outcomes).toHaveLength(0);
    expect(idle).toBe(true);
  });

  it("waits for new work in service mode", async () => {
    const daemon = new Daemon({
      clock: clock(),
      store: {} as never,
      stopWhenIdle: false,
      pollIntervalMs: 1,
      maxRuns: 1,
    });
    let attempts = 0;
    const result = await daemon.loop(async () => {
      attempts += 1;
      return attempts === 1 ? undefined : outcome();
    });
    expect(result.stoppedBecause).toBe("max-runs");
    expect(result.outcomes).toHaveLength(1);
  });

  it("wakes immediately when stopped while idle", async () => {
    const daemon = new Daemon({
      clock: clock(),
      store: {} as never,
      stopWhenIdle: false,
      pollIntervalMs: 60_000,
    });
    const loop = daemon.loop(async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1));
    daemon.requestStop();
    await expect(loop).resolves.toMatchObject({ stoppedBecause: "signal" });
  });
});
