/**
 * Dependency chains.
 *
 * The rule the whole feature rests on: ordering is derived from declared
 * dependencies, never imposed. A stack of unrelated work invents dependencies,
 * and the cost of an invented dependency is that a refused layer strands every
 * layer above it for no reason.
 */
import { describe, expect, it } from "vitest";
import {
  planStack,
  evidenceSurvivesRebase,
  describeLayerEvidence,
} from "../../src/queue/stack.js";
import type { BacklogIssue } from "../../src/domain/types.js";

function issue(identifier: string, blockedBy: string[] = []): BacklogIssue {
  return {
    identifier,
    title: identifier,
    description: "",
    priority: 2,
    labels: [],
    state: "Todo",
    teamKey: "ENG",
    blockedBy,
    createdAt: "2026-01-01T00:00:00.000Z",
    assigneeIsHuman: false,
    canceled: false,
    completed: false,
  } as BacklogIssue;
}

const ids = (c: { issues: readonly BacklogIssue[] }): string[] =>
  c.issues.map((i) => i.identifier);

describe("planStack", () => {
  it("leaves independent issues as chains of one", () => {
    // Unrelated work must not be batched. Stacking it would mean the third PR
    // cannot merge until the first does, which is a dependency nobody declared.
    const plan = planStack({ candidates: [issue("A"), issue("B"), issue("C")] });
    expect(plan.chains.map(ids)).toEqual([["A"], ["B"], ["C"]]);
    expect(plan.rejected).toEqual([]);
  });

  it("chains a blocked issue on top of its blocker", () => {
    // The case that is rejected outright today.
    const plan = planStack({ candidates: [issue("ENG-99"), issue("ENG-104", ["ENG-99"])] });
    expect(plan.chains.map(ids)).toEqual([["ENG-99", "ENG-104"]]);
  });

  it("orders a longer chain bottom first", () => {
    const plan = planStack({
      candidates: [issue("C", ["B"]), issue("A"), issue("B", ["A"])],
    });
    expect(plan.chains.map(ids)).toEqual([["A", "B", "C"]]);
  });

  it("still rejects an issue whose blocker is not eligible work", () => {
    // Building on something nobody is working on means building on a branch
    // that may never exist.
    const plan = planStack({ candidates: [issue("ENG-104", ["ENG-99"])] });
    expect(plan.chains).toEqual([]);
    expect(plan.rejected[0]?.reason).toMatch(/not eligible work/);
  });

  it("rejects a dependency cycle rather than guessing an order", () => {
    // No order satisfies both, and a guessed one produces a stack that can
    // never merge.
    const plan = planStack({ candidates: [issue("A", ["B"]), issue("B", ["A"])] });
    expect(plan.chains).toEqual([]);
    expect(plan.rejected.map((r) => r.reason).join(" ")).toMatch(/cycle/);
  });

  it("does not start a chain from an issue something else depends on", () => {
    // Otherwise A would be planned both alone and as the bottom of A→B.
    const plan = planStack({ candidates: [issue("A"), issue("B", ["A"])] });
    expect(plan.chains).toHaveLength(1);
    expect(ids(plan.chains[0] as never)).toEqual(["A", "B"]);
  });

  it("linearizes two blockers of the same issue", () => {
    // Both have to land before C regardless, so an order is not an invention.
    const plan = planStack({ candidates: [issue("A"), issue("B"), issue("C", ["A", "B"])] });
    expect(plan.chains).toHaveLength(1);
    const chain = ids(plan.chains[0] as never);
    expect(chain).toHaveLength(3);
    expect(chain.indexOf("A")).toBeLessThan(chain.indexOf("C"));
    expect(chain.indexOf("B")).toBeLessThan(chain.indexOf("C"));
  });

  it("does not duplicate a shared blocker", () => {
    const plan = planStack({
      candidates: [issue("A"), issue("B", ["A"]), issue("C", ["A", "B"])],
    });
    expect(ids(plan.chains[0] as never)).toEqual(["A", "B", "C"]);
  });

  it("refuses a chain deeper than the limit", () => {
    // Every layer multiplies what a refusal strands and how much rebase churn
    // lands when the bottom merges.
    const deep = [
      issue("A"),
      issue("B", ["A"]),
      issue("C", ["B"]),
      issue("D", ["C"]),
      issue("E", ["D"]),
    ];
    const plan = planStack({ candidates: deep, maxDepth: 3 });
    expect(plan.chains).toEqual([]);
    expect(plan.rejected[0]?.reason).toMatch(/over the limit/);
  });

  it("accepts a chain exactly at the limit", () => {
    const plan = planStack({
      candidates: [issue("A"), issue("B", ["A"]), issue("C", ["B"])],
      maxDepth: 3,
    });
    expect(ids(plan.chains[0] as never)).toEqual(["A", "B", "C"]);
  });
});

describe("evidenceSurvivesRebase", () => {
  it("keeps the result when the rebase changed the commit but not the tree", () => {
    // The whole point. Checks ran against a tree, and the tree is what a rebase
    // usually preserves, so re-running them would prove the same thing again.
    const v = evidenceSurvivesRebase({ verifiedTreeHash: "abc123", currentTreeHash: "abc123" });
    expect(v.stillValid).toBe(true);
    expect(v.reason).toMatch(/not the tree/);
  });

  it("invalidates the result when the tree actually changed", () => {
    const v = evidenceSurvivesRebase({ verifiedTreeHash: "abc123", currentTreeHash: "def456" });
    expect(v.stillValid).toBe(false);
    expect(v.reason).toMatch(/no longer here/);
  });

  it("refuses to conclude anything without a recorded hash", () => {
    // Absence of evidence is not equivalence, and defaulting to valid here
    // would let a layer inherit a claim nothing supports.
    expect(evidenceSurvivesRebase({ verifiedTreeHash: "", currentTreeHash: "x" }).stillValid).toBe(
      false,
    );
    expect(evidenceSurvivesRebase({ verifiedTreeHash: "x", currentTreeHash: "" }).stillValid).toBe(
      false,
    );
  });
});

describe("describeLayerEvidence", () => {
  it("says plainly that an upper layer was verified against unmerged work", () => {
    // A green check on layer three is a weaker claim than one on the bottom,
    // and reporting them identically overstates the upper layers.
    expect(describeLayerEvidence(0, "main")).toBe("verified against main");
    expect(describeLayerEvidence(2, "runmill/ENG-99")).toMatch(/2 change\(s\) that have not merged/);
  });
});
