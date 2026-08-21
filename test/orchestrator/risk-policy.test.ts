import { describe, expect, it } from "vitest";
import type { RunmillConfig } from "../../src/config/types.js";
import {
  evaluateAutomaticMergeRisk,
  matchesRiskPath,
} from "../../src/orchestrator/risk-policy.js";

const LOW_RISK: RunmillConfig["risk"] = {
  default: "low",
  manualApproval: { paths: [], labels: [], conditions: [] },
};

const EVIDENCE = {
  changedPaths: ["src/greeting.ts"],
  issueLabels: ["agent-ready"],
  acceptanceCriteria: ["returns a greeting"],
  checkManifestPath: ".runmill/checks.yaml",
};

function evaluate(overrides: Partial<RunmillConfig["risk"]> = {}, evidence = EVIDENCE) {
  return evaluateAutomaticMergeRisk(
    {
      ...LOW_RISK,
      ...overrides,
      manualApproval: {
        ...LOW_RISK.manualApproval,
        ...overrides.manualApproval,
      },
    },
    evidence,
  );
}

describe("risk path matching", () => {
  it("supports repository-relative prefixes and *, **, and ? globs", () => {
    expect(matchesRiskPath("src/auth/session.ts", "src/auth/")).toBe(true);
    expect(matchesRiskPath(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(matchesRiskPath("packages/api/package-lock.json", "**/package-lock.json")).toBe(true);
    expect(matchesRiskPath("src/api.ts", "src/*.ts")).toBe(true);
    expect(matchesRiskPath("src/api.ts", "src/??i.ts")).toBe(true);
    expect(matchesRiskPath("src/nested/api.ts", "src/*.ts")).toBe(false);
  });

  it("returns unknown for syntax Runmill does not implement", () => {
    expect(matchesRiskPath("src/auth.ts", "src/[ab]*.ts")).toBeUndefined();
    expect(matchesRiskPath("src/auth.ts", "../src/**")).toBeUndefined();
    expect(matchesRiskPath("src/auth.ts", "src/./auth.ts")).toBeUndefined();
    expect(matchesRiskPath("src/auth.ts", "/src/**")).toBeUndefined();
    expect(matchesRiskPath("src/auth.ts", "")).toBeUndefined();
  });
});

describe("automatic-merge risk policy", () => {
  it("allows a low-risk run only when no rule withholds permission", () => {
    expect(evaluate()).toEqual({ decision: "allow" });
  });

  it.each(["medium", "high", "critical"] as const)(
    "requires manual approval for a %s default risk tier",
    (tier) => {
      const decision = evaluate({ default: tier });
      expect(decision.decision).toBe("manual-approval");
      expect("reasons" in decision ? decision.reasons.join(" ") : "").toContain(tier);
    },
  );

  it("fails closed when an unvalidated caller supplies an unknown risk tier", () => {
    const decision = evaluate({ default: "future-tier" as never });
    expect(decision.decision).toBe("unknown");
  });

  it("requires approval when the final diff matches a configured path", () => {
    const decision = evaluate({
      manualApproval: { paths: ["src/**"], labels: [], conditions: [] },
    });
    expect(decision.decision).toBe("manual-approval");
    expect("reasons" in decision ? decision.reasons.join(" ") : "").toContain("src/greeting.ts");
  });

  it("requires approval when the issue carries a configured label", () => {
    const decision = evaluate({
      manualApproval: { paths: [], labels: ["Agent-Ready"], conditions: [] },
    });
    expect(decision.decision).toBe("manual-approval");
    expect("reasons" in decision ? decision.reasons.join(" ") : "").toContain("Agent-Ready");
  });

  it("evaluates conditions that have deterministic local evidence", () => {
    const cases = [
      {
        condition: "missing_acceptance_criteria",
        evidence: { ...EVIDENCE, acceptanceCriteria: ["  "] },
      },
      {
        condition: "check_config_changed",
        evidence: { ...EVIDENCE, changedPaths: [".runmill/checks.yaml"] },
      },
      {
        condition: "lockfile_changed",
        evidence: { ...EVIDENCE, changedPaths: ["packages/api/package-lock.json"] },
      },
    ];

    for (const { condition, evidence } of cases) {
      const decision = evaluate(
        { manualApproval: { paths: [], labels: [], conditions: [condition] } },
        evidence,
      );
      expect(decision.decision, condition).toBe("manual-approval");
      expect("reasons" in decision ? decision.reasons.join(" ") : "").toContain(condition);
    }
  });

  it("does not trigger supported conditions when the evidence disproves them", () => {
    const decision = evaluate({
      manualApproval: {
        paths: [],
        labels: [],
        conditions: ["missing_acceptance_criteria", "check_config_changed", "lockfile_changed"],
      },
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  it.each(["public_api_change", "permissions_change", "secret_related_change", "future_rule"])(
    "fails closed when %s cannot be evaluated",
    (condition) => {
      const decision = evaluate({
        manualApproval: { paths: [], labels: [], conditions: [condition] },
      });
      expect(decision.decision).toBe("unknown");
      expect("reasons" in decision ? decision.reasons.join(" ") : "").toContain(condition);
    },
  );

  it("fails closed instead of ignoring an unsupported path glob", () => {
    const decision = evaluate({
      manualApproval: { paths: ["src/[ab]*/**"], labels: [], conditions: [] },
    });
    expect(decision.decision).toBe("unknown");
  });

  it("fails closed instead of ignoring an empty manual-approval label", () => {
    const decision = evaluate({
      manualApproval: { paths: [], labels: [""], conditions: [] },
    });
    expect(decision.decision).toBe("unknown");
  });

  it("fails closed when check_config_changed cannot match the configured manifest", () => {
    const decision = evaluate(
      {
        manualApproval: {
          paths: [],
          labels: [],
          conditions: ["check_config_changed"],
        },
      },
      { ...EVIDENCE, checkManifestPath: "../outside/checks.yaml" },
    );
    expect(decision.decision).toBe("unknown");
  });
});
