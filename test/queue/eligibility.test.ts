import { describe, expect, it } from "vitest";
import { evaluateEligibility, RULE_IDS } from "../../src/queue/eligibility.js";
import type { EligibilityPolicy } from "../../src/queue/eligibility.js";
import type { RepositoryRule } from "../../src/queue/repository-mapping.js";
import type { BacklogIssue } from "../../src/domain/types.js";

const RULES: RepositoryRule[] = [
  { match: { team: "ENG" }, repo: "acme/platform", baseBranch: "main" },
];

function policy(over: Partial<EligibilityPolicy> = {}): EligibilityPolicy {
  return {
    eligibleStates: ["Todo", "Ready"],
    includeLabels: [],
    excludeLabels: [],
    repositoryRules: RULES,
    capacityAvailable: true,
    leasedIssueIds: new Set<string>(),
    ...over,
  };
}

function issue(over: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    identifier: "ENG-1",
    title: "Prevent duplicate webhook delivery",
    description:
      "When a delivery id repeats we process it twice.\n\n" +
      "Acceptance criteria:\n- repeated ids processed once\n- records expire",
    priority: 2,
    labels: [],
    state: "Todo",
    teamKey: "ENG",
    createdAt: "2026-01-01T00:00:00Z",
    canceled: false,
    completed: false,
    blockedBy: [],
    ...over,
  };
}

describe("evaluateEligibility", () => {
  it("accepts a well-formed issue", () => {
    const d = evaluateEligibility(issue(), policy());
    expect(d.eligible).toBe(true);
    expect(d.target?.repo).toBe("acme/platform");
  });

  it("evaluates EVERY rule even after one fails, for rule-by-rule explanation", () => {
    // FR-03: `next --dry-run` lists rejected candidates with per-rule reasons.
    // Short-circuiting would make the explanation useless.
    const d = evaluateEligibility(
      issue({ state: "Backlog", canceled: true, labels: ["no-agent"] }),
      policy({ excludeLabels: ["no-agent"] }),
    );
    expect(d.eligible).toBe(false);
    expect(d.rules.map((r) => r.rule).sort()).toEqual([...RULE_IDS].sort());
    expect(d.rules.filter((r) => !r.passed).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects an unmapped repository with RM-SELECT-002", () => {
    const d = evaluateEligibility(issue({ teamKey: "MARKETING" }), policy());
    expect(d.eligible).toBe(false);
    const rule = d.rules.find((r) => r.rule === "mapped-repository");
    expect(rule?.passed).toBe(false);
    expect(rule?.code).toBe("RM-SELECT-002");
  });

  it("rejects a disallowed workflow state", () => {
    const d = evaluateEligibility(issue({ state: "In Progress" }), policy());
    expect(d.rules.find((r) => r.rule === "workflow-state")?.passed).toBe(false);
  });

  it("rejects canceled and completed issues", () => {
    expect(
      evaluateEligibility(issue({ canceled: true }), policy()).rules.find(
        (r) => r.rule === "not-terminal",
      )?.passed,
    ).toBe(false);
    expect(
      evaluateEligibility(issue({ completed: true }), policy()).rules.find(
        (r) => r.rule === "not-terminal",
      )?.passed,
    ).toBe(false);
  });

  it("rejects an issue already leased by another run", () => {
    const d = evaluateEligibility(
      issue({ identifier: "ENG-7" }),
      policy({ leasedIssueIds: new Set(["ENG-7"]) }),
    );
    expect(d.rules.find((r) => r.rule === "not-leased")?.passed).toBe(false);
  });

  it("requires every include label to be present", () => {
    const p = policy({ includeLabels: ["agent-ready", "backend"] });
    expect(
      evaluateEligibility(issue({ labels: ["agent-ready"] }), p).rules.find(
        (r) => r.rule === "labels",
      )?.passed,
    ).toBe(false);
    expect(
      evaluateEligibility(issue({ labels: ["agent-ready", "backend"] }), p).rules.find(
        (r) => r.rule === "labels",
      )?.passed,
    ).toBe(true);
  });

  it("rejects when any exclude label is present", () => {
    const d = evaluateEligibility(
      issue({ labels: ["needs-design"] }),
      policy({ excludeLabels: ["needs-design", "no-agent"] }),
    );
    expect(d.rules.find((r) => r.rule === "labels")?.passed).toBe(false);
  });

  it("rejects an estimate above the configured maximum", () => {
    const p = policy({ maxEstimate: 5 });
    expect(
      evaluateEligibility(issue({ estimate: 8 }), p).rules.find((r) => r.rule === "estimate")
        ?.passed,
    ).toBe(false);
    expect(
      evaluateEligibility(issue({ estimate: 5 }), p).rules.find((r) => r.rule === "estimate")
        ?.passed,
    ).toBe(true);
  });

  it("passes the estimate rule when estimates are not configured", () => {
    const d = evaluateEligibility(issue({ estimate: 999 }), policy());
    expect(d.rules.find((r) => r.rule === "estimate")?.passed).toBe(true);
  });

  it("rejects an issue with unresolved blockers", () => {
    const d = evaluateEligibility(issue({ blockedBy: ["ENG-99"] }), policy());
    const rule = d.rules.find((r) => r.rule === "dependencies");
    expect(rule?.passed).toBe(false);
    expect(rule?.reason).toContain("ENG-99");
  });

  it("rejects an issue too thin to build a task packet from", () => {
    const d = evaluateEligibility(issue({ description: "fix it" }), policy());
    const rule = d.rules.find((r) => r.rule === "readiness");
    expect(rule?.passed).toBe(false);
    expect(rule?.code).toBe("RM-SELECT-003");
  });

  it("lets an explicit agent-ready label override the readiness heuristic", () => {
    // The PRD permits this override and simultaneously warns it is an escape
    // hatch: label-add authority becomes code-execution authority.
    const d = evaluateEligibility(
      issue({ description: "fix it", labels: ["agent-ready"] }),
      policy({ readinessOverrideLabel: "agent-ready" }),
    );
    expect(d.rules.find((r) => r.rule === "readiness")?.passed).toBe(true);
    expect(d.rules.find((r) => r.rule === "readiness")?.reason).toMatch(/override/i);
  });

  it("rejects when global capacity is exhausted", () => {
    const d = evaluateEligibility(issue(), policy({ capacityAvailable: false }));
    expect(d.rules.find((r) => r.rule === "capacity")?.passed).toBe(false);
  });

  it("is pure: the same inputs always yield the same decision", () => {
    const i = issue();
    const p = policy();
    expect(evaluateEligibility(i, p)).toEqual(evaluateEligibility(i, p));
  });
});
