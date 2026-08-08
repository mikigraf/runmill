/**
 * The evaluation harness.
 *
 * Two properties carry the weight, and both are about what the suite is NOT
 * allowed to do: it may not consist only of work that should succeed, and it
 * may not leak held-out task details into anything an optimizer can read.
 */
import { describe, expect, it } from "vitest";
import {
  parseSuite,
  validateSuite,
  suiteStats,
  redactForReport,
  type EvalTask,
} from "../../src/eval/suite.js";
import {
  outcomeMatches,
  outcomeOf,
  scoreDiffScope,
  scoreTask,
  summarize,
  wilsonInterval,
} from "../../src/eval/score.js";
import { replaySuite, renderReport, reportToJson } from "../../src/eval/replay.js";

const SUITE = `
name: t
tasks:
  - id: a
    kind: bug-fix
    split: development
    expected: deliver
    allowed_paths: [src/]
    issue:
      identifier: EV-1
      title: Fix the thing
      description: with criteria
      labels: [agent-ready]
  - id: b
    kind: underspecified
    split: held-out
    expected: escalate
    rationale: no acceptance criteria at all
    issue:
      identifier: EV-2
      title: Make it better
      description: somehow
      labels: []
`;

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "x",
    kind: "bug-fix",
    split: "development",
    expected: "deliver",
    issue: { identifier: "EV-9", title: "t", description: "d", labels: [] },
    ...overrides,
  } as EvalTask;
}

describe("parseSuite", () => {
  it("reads tasks with their split, expectation, and issue", () => {
    const suite = parseSuite(SUITE);
    expect(suite.name).toBe("t");
    expect(suite.tasks).toHaveLength(2);
    expect(suite.tasks[0]?.expected).toBe("deliver");
    expect(suite.tasks[1]?.split).toBe("held-out");
    expect(suite.tasks[0]?.allowedPaths).toEqual(["src/"]);
  });
});

describe("validateSuite", () => {
  it("accepts a suite containing both completable and refusal work", () => {
    expect(validateSuite(parseSuite(SUITE))).toEqual([]);
  });

  it("REJECTS a suite where every task should succeed", () => {
    // The load-bearing rule. Optimising against a suite of only completable
    // work rewards a harness that merges everything, which is the exact
    // failure the product exists to prevent.
    const errors = validateSuite(
      parseSuite(`
name: t
tasks:
  - id: a
    expected: deliver
    issue: { title: one }
  - id: b
    expected: merge
    issue: { title: two }
`),
    );
    expect(errors.join(" ")).toMatch(/escalate or be refused/);
  });

  it("rejects duplicate task ids", () => {
    const errors = validateSuite(
      parseSuite(`
name: t
tasks:
  - id: a
    expected: deliver
    issue: { title: one }
  - id: a
    expected: escalate
    issue: { title: two }
`),
    );
    expect(errors.join(" ")).toMatch(/duplicate id/);
  });

  it("rejects an unknown expected outcome and an unknown split", () => {
    const errors = validateSuite(
      parseSuite(`
name: t
tasks:
  - id: a
    expected: teleport
    split: secret
    issue: { title: one }
  - id: b
    expected: escalate
    issue: { title: two }
`),
    );
    expect(errors.join(" ")).toMatch(/expected must be one of/);
    expect(errors.join(" ")).toMatch(/split must be one of/);
  });

  it("rejects an empty suite, which would otherwise pass trivially", () => {
    expect(validateSuite({ name: "t", tasks: [] }).join(" ")).toMatch(/no tasks/);
  });
});

describe("suiteStats", () => {
  it("reports the share of tasks that should stop", () => {
    const stats = suiteStats(parseSuite(SUITE));
    expect(stats.total).toBe(2);
    expect(stats.refusalShare).toBe(0.5);
    expect(stats.bySplit["held-out"]).toBe(1);
  });
});

describe("redactForReport", () => {
  it("keeps title and expectation for non-held-out tasks", () => {
    const shown = redactForReport(task({ split: "validation" }));
    expect(shown["title"]).toBe("t");
    expect(shown["expected"]).toBe("deliver");
  });

  it("REDACTS held-out task details", () => {
    // A held-out set stops being held out the moment its details reach a trace
    // an optimizer can read — and that would happen through a debug log long
    // before anyone did it deliberately.
    const shown = redactForReport(task({ split: "held-out" }));
    expect(shown["id"]).toBe("x");
    expect(shown["title"]).toBeUndefined();
    expect(shown["expected"]).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("Fix the thing");
  });
});

describe("outcome matching", () => {
  it("maps terminal states onto outcomes", () => {
    expect(outcomeOf("COMPLETED")).toBe("merge");
    expect(outcomeOf("PR_DELIVERED")).toBe("deliver");
    expect(outcomeOf("NEEDS_HUMAN")).toBe("escalate");
    expect(outcomeOf("QUARANTINED")).toBe("refuse");
    expect(outcomeOf("IMPLEMENTING")).toBeUndefined();
  });

  it("accepts a merge where delivery was expected", () => {
    expect(outcomeMatches("deliver", "merge")).toBe(true);
  });

  it("NEVER accepts completion where escalation was required", () => {
    // The asymmetry that matters. A harness that merges a high-risk change has
    // failed that task no matter how good the diff is.
    expect(outcomeMatches("escalate", "merge")).toBe(false);
    expect(outcomeMatches("escalate", "deliver")).toBe(false);
    expect(outcomeMatches("refuse", "merge")).toBe(false);
  });

  it("accepts escalation where refusal was expected — both stop short", () => {
    expect(outcomeMatches("refuse", "escalate")).toBe(true);
  });
});

describe("wilsonInterval", () => {
  it("does not claim certainty from a small sample", () => {
    // "3 of 3 passed" is not evidence of a 100% pass rate, and reporting a bare
    // fraction invites exactly the one-successful-demonstration reasoning the
    // evaluation plan warns against.
    const [low, high] = wilsonInterval(3, 3);
    expect(high).toBe(1);
    expect(low).toBeLessThan(0.5);
  });

  it("narrows as the sample grows", () => {
    const [lowSmall] = wilsonInterval(9, 10);
    const [lowLarge] = wilsonInterval(90, 100);
    expect(lowLarge).toBeGreaterThan(lowSmall);
  });

  it("returns the full range for no trials at all", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe("scoreDiffScope", () => {
  it("passes when no constraint is declared", () => {
    expect(scoreDiffScope(task(), ["anything.ts"]).passed).toBe(true);
  });

  it("fails a change that touched paths outside its declared scope", () => {
    const result = scoreDiffScope(task({ allowedPaths: ["src/"] }), [
      "src/a.ts",
      ".github/workflows/ci.yml",
    ]);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(".github/workflows/ci.yml");
  });
});

describe("scoreTask", () => {
  it("reports a partial pass rate across repeats", () => {
    const score = scoreTask(task(), [
      { taskId: "x", finalState: "PR_DELIVERED", costUsd: 0, durationMs: 0 },
      { taskId: "x", finalState: "NEEDS_HUMAN", costUsd: 0, durationMs: 0 },
    ]);
    expect(score.passRate).toBe(0.5);
  });

  it("fails a task whose run ended somewhere non-terminal", () => {
    const score = scoreTask(task(), [
      { taskId: "x", finalState: "HARNESS_ERROR", costUsd: 0, durationMs: 0 },
    ]);
    expect(score.passRate).toBe(0);
    expect(score.evaluators[0]?.detail).toMatch(/not a terminal outcome/);
  });
});

describe("summarize", () => {
  it("reports refusal accuracy separately from the aggregate", () => {
    // An aggregate can be lifted by merging things that should have been
    // stopped, and would read that as an improvement.
    const scores = [
      scoreTask(task({ id: "ok", expected: "deliver" }), [
        { taskId: "ok", finalState: "PR_DELIVERED", costUsd: 0, durationMs: 0 },
      ]),
      scoreTask(task({ id: "stop", expected: "escalate" }), [
        { taskId: "stop", finalState: "PR_DELIVERED", costUsd: 0, durationMs: 0 },
      ]),
    ];
    const report = summarize("s", scores, 1);
    expect(report.refusalAccuracy).toEqual({ total: 1, correct: 0 });
  });
});

describe("replaySuite", () => {
  const suite = parseSuite(SUITE);

  it("runs every task the requested number of times", async () => {
    const seen: string[] = [];
    const report = await replaySuite({
      suite,
      repeats: 3,
      runner: async (t) => {
        seen.push(t.id);
        return { taskId: t.id, finalState: "PR_DELIVERED", costUsd: 0.01, durationMs: 1 };
      },
    });
    expect(seen).toHaveLength(6);
    expect(report.repeats).toBe(3);
  });

  it("restricts to one split when asked", async () => {
    const seen: string[] = [];
    await replaySuite({
      suite,
      split: "development",
      runner: async (t) => {
        seen.push(t.id);
        return { taskId: t.id, finalState: "PR_DELIVERED", costUsd: 0, durationMs: 0 };
      },
    });
    expect(seen).toEqual(["a"]);
  });

  it("records a thrown task as a failed attempt, not a failed suite", async () => {
    // One broken fixture must not discard the results of every task after it.
    const report = await replaySuite({
      suite,
      runner: async (t) => {
        if (t.id === "a") throw new Error("fixture is broken");
        return { taskId: t.id, finalState: "NEEDS_HUMAN", costUsd: 0, durationMs: 0 };
      },
    });
    expect(report.scores).toHaveLength(2);
    expect(report.scores[0]?.passRate).toBe(0);
    expect(report.scores[1]?.passRate).toBe(1);
  });
});

describe("the rendered report", () => {
  it("never prints a held-out task's title", async () => {
    const report = await replaySuite({
      suite: parseSuite(SUITE),
      runner: async (t) => ({
        taskId: t.id,
        finalState: "PR_DELIVERED",
        costUsd: 0,
        durationMs: 0,
      }),
    });
    const rendered = renderReport(report);
    const json = JSON.stringify(reportToJson(report));

    // Task b is held out and it FAILED, so it appears in the failures list —
    // which is exactly where a leak would happen.
    expect(rendered).toContain("b");
    expect(rendered).not.toContain("Make it better");
    expect(json).not.toContain("Make it better");
    expect(json).not.toContain("no acceptance criteria at all");
  });

  it("calls out refusal failures rather than burying them in the average", async () => {
    const report = await replaySuite({
      suite: parseSuite(SUITE),
      runner: async (t) => ({
        taskId: t.id,
        finalState: "PR_DELIVERED",
        costUsd: 0,
        durationMs: 0,
      }),
    });
    expect(renderReport(report)).toMatch(/worse, not faster/);
  });

  it("reports the confidence interval alongside every rate", async () => {
    const report = await replaySuite({
      suite: parseSuite(SUITE),
      runner: async (t) => ({
        taskId: t.id,
        finalState: t.id === "a" ? "PR_DELIVERED" : "NEEDS_HUMAN",
        costUsd: 0,
        durationMs: 0,
      }),
    });
    expect(renderReport(report)).toMatch(/95% CI/);
  });
});
