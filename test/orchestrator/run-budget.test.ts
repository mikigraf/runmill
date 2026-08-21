import { describe, expect, it } from "vitest";
import { RunBudget } from "../../src/orchestrator/run-budget.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

function usage(costUsd?: number): AgentEvent[] {
  return [
    {
      seq: 1,
      ts: "2026-01-01T00:00:00Z",
      runId: "run_1",
      sessionId: "session_1",
      role: "implementer",
      attempt: 1,
      type: "usage.updated",
      cumulative: true,
      inputTokens: 10,
      outputTokens: 5,
      model: "test",
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  ];
}

function budget(clock = new FakeClock(), overrides: Partial<ConstructorParameters<typeof RunBudget>[0]> = {}): RunBudget {
  return new RunBudget({
    clock,
    maxWallMs: 60_000,
    maxCostUsd: 1,
    maxInvocations: {
      total: 3,
      implementer: 1,
      localReview: 1,
      fixer: 1,
      prReview: 1,
      prFixer: 1,
    },
    clampInvocationTimeout: true,
    costEnforcement: "auto",
    ...overrides,
  });
}

describe("RunBudget", () => {
  const detailFrom = (fn: () => void): string => {
    try {
      fn();
      return "";
    } catch (error) {
      return error instanceof RunmillError ? error.whatHappened : String(error);
    }
  };

  it("enforces per-role and total invocation ceilings", () => {
    const value = budget();
    value.beginInvocation("implementer", 30_000);
    expect(() => value.beginInvocation("implementer", 30_000)).toThrow(/RM-PROVIDER-002/);
  });

  it("clamps a provider timeout to the remaining issue wall budget", () => {
    const clock = new FakeClock();
    const value = budget(clock);
    clock.advanceMs(45_000);
    expect(value.beginInvocation("implementer", 30_000)).toBe(15_000);
  });

  it("refuses after the issue wall-time cap", () => {
    const clock = new FakeClock();
    const value = budget(clock);
    clock.advanceMs(60_000);
    expect(() => value.assertActive("CI")).toThrow(/RM-PROVIDER-002/);
  });

  it("enforces reported dollar cost", () => {
    const value = budget();
    value.beginInvocation("implementer", 30_000);
    expect(detailFrom(() => value.finishInvocation(usage(1.01)))).toMatch(/cost cap exceeded/);
  });

  it("does not treat missing provider cost as zero when a cap was promised", () => {
    const value = budget();
    value.beginInvocation("implementer", 30_000);
    expect(detailFrom(() => value.finishInvocation(usage()))).toMatch(/reported no cost/);
  });

  it("allows an explicit wall-and-invocations-only policy to ignore absent dollar data", () => {
    const value = budget(new FakeClock(), {
      maxCostUsd: undefined,
      costEnforcement: "wall-and-invocations-only",
    });
    value.beginInvocation("implementer", 30_000);
    expect(() => value.finishInvocation(usage())).not.toThrow();
  });
});
