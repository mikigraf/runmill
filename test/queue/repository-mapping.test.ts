import { describe, expect, it } from "vitest";
import { resolveRepository, findConflictingRules } from "../../src/queue/repository-mapping.js";
import type { RepositoryRule } from "../../src/queue/repository-mapping.js";
import type { BacklogIssue } from "../../src/domain/types.js";

function issue(over: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    identifier: "ENG-1",
    title: "t",
    description: "d",
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

const RULES: RepositoryRule[] = [
  { match: { team: "ENG", label: "mobile" }, repo: "acme/ios", baseBranch: "main" },
  { match: { project: "Payments" }, repo: "acme/billing", baseBranch: "main" },
  { match: { team: "ENG" }, repo: "acme/platform", baseBranch: "main" },
];

describe("resolveRepository", () => {
  it("returns the first matching rule", () => {
    const r = resolveRepository(issue({ teamKey: "ENG" }), RULES);
    expect(r.resolved).toBe(true);
    expect(r.target?.repo).toBe("acme/platform");
  });

  it("requires every key in a match block to hold (AND, not OR)", () => {
    // team matches but label does not, so the ios rule must not win.
    const r = resolveRepository(issue({ teamKey: "ENG", labels: ["backend"] }), RULES);
    expect(r.target?.repo).toBe("acme/platform");
  });

  it("prefers an earlier, more specific rule when all its keys hold", () => {
    const r = resolveRepository(issue({ teamKey: "ENG", labels: ["mobile"] }), RULES);
    expect(r.target?.repo).toBe("acme/ios");
  });

  it("matches on project independently of team", () => {
    const r = resolveRepository(issue({ teamKey: "OPS", projectName: "Payments" }), RULES);
    expect(r.target?.repo).toBe("acme/billing");
  });

  it("is unresolved when no rule matches, and says so with a code", () => {
    const r = resolveRepository(issue({ teamKey: "MARKETING" }), RULES);
    expect(r.resolved).toBe(false);
    expect(r.target).toBeUndefined();
    expect(r.code).toBe("RM-SELECT-002");
    expect(r.reason).toMatch(/no repository rule/i);
  });

  it("never guesses: an empty rule list is unresolved, not a default", () => {
    const r = resolveRepository(issue(), []);
    expect(r.resolved).toBe(false);
    expect(r.code).toBe("RM-SELECT-002");
  });

  it("carries the per-rule base branch through", () => {
    const rules: RepositoryRule[] = [
      { match: { team: "ENG" }, repo: "acme/platform", baseBranch: "develop" },
    ];
    expect(resolveRepository(issue(), rules).target?.baseBranch).toBe("develop");
  });

  it("reports which rule index matched, for `next --dry-run` explanations", () => {
    const r = resolveRepository(issue({ teamKey: "ENG", labels: ["mobile"] }), RULES);
    expect(r.matchedRuleIndex).toBe(0);
  });
});

describe("findConflictingRules", () => {
  it("finds no conflict in a well-ordered rule set", () => {
    expect(findConflictingRules(RULES)).toEqual([]);
  });

  it("flags two rules with identical match specs pointing at different repos", () => {
    const conflicting: RepositoryRule[] = [
      { match: { team: "ENG" }, repo: "acme/a", baseBranch: "main" },
      { match: { team: "ENG" }, repo: "acme/b", baseBranch: "main" },
    ];
    const conflicts = findConflictingRules(conflicting);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ indices: [0, 1] });
  });

  it("does not flag identical match specs pointing at the same repo", () => {
    const dup: RepositoryRule[] = [
      { match: { team: "ENG" }, repo: "acme/a", baseBranch: "main" },
      { match: { team: "ENG" }, repo: "acme/a", baseBranch: "main" },
    ];
    expect(findConflictingRules(dup)).toEqual([]);
  });

  it("flags a rule fully shadowed by an earlier broader rule", () => {
    // {team: ENG} matches everything {team: ENG, label: x} would match, so the
    // second rule can never fire. That is a config bug worth surfacing.
    const shadowed: RepositoryRule[] = [
      { match: { team: "ENG" }, repo: "acme/platform", baseBranch: "main" },
      { match: { team: "ENG", label: "mobile" }, repo: "acme/ios", baseBranch: "main" },
    ];
    const conflicts = findConflictingRules(shadowed);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("shadowed");
  });
});
