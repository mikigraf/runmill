/**
 * Issue readiness scoring.
 *
 * `runmill prepare` is the command that answers "would this issue survive an
 * unattended run", and it is the cheapest place to catch an under-specified
 * backlog: the alternative is discovering the gap after paying an agent to
 * flounder. The scoring weights are a product decision, so they are asserted
 * here rather than left to drift.
 */
import { describe, expect, it } from "vitest";
import { assessReadiness, renderReadiness } from "../../src/queue/readiness.js";
import type { BacklogIssue } from "../../src/domain/types.js";

function issue(over: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    identifier: "ENG-1",
    title: "Prevent duplicate webhook delivery",
    description:
      "Webhook deliveries with a repeated delivery id are processed twice, " +
      "which double-charges the customer account.\n\n" +
      "Acceptance criteria:\n- repeated ids are processed once\n- the dedupe record expires",
    priority: 2,
    labels: [],
    state: "Todo",
    teamKey: "ENG",
    createdAt: "2026-01-01T00:00:00.000Z",
    canceled: false,
    completed: false,
    blockedBy: [],
    ...over,
  };
}

describe("assessReadiness", () => {
  it("scores a fully specified issue as dispatchable", () => {
    const report = assessReadiness(issue());

    expect(report.score).toBe(10);
    expect(report.dispatchable).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.acceptanceCriteria).toEqual([
      "repeated ids are processed once",
      "the dedupe record expires",
    ]);
  });

  it("keeps the identifier so a report can be attributed to its issue", () => {
    expect(assessReadiness(issue({ identifier: "ENG-42" })).identifier).toBe("ENG-42");
  });

  it("makes missing acceptance criteria the single heaviest deduction", () => {
    // Weight 4 of 10. Review verifies each criterion individually, so an issue
    // without them gives the reviewer nothing to check against.
    const report = assessReadiness(
      issue({
        description:
          "Webhook deliveries with a repeated delivery id are processed twice, " +
          "which double-charges the customer account.",
      }),
    );

    expect(report.score).toBe(6);
    expect(report.dispatchable).toBe(false);
    expect(report.signals.find((s) => s.id === "acceptance-criteria")?.met).toBe(false);
  });

  it("refuses a description too short to act on", () => {
    const report = assessReadiness(issue({ description: "fix the webhook" }));

    const signal = report.signals.find((s) => s.id === "description");
    expect(signal?.met).toBe(false);
    expect(signal?.detail).toContain("below the 80");
    expect(report.dispatchable).toBe(false);
  });

  it("flags vague phrasing that reads as a request but specifies nothing", () => {
    for (const phrase of ["fix it", "make it better", "tidy up", "clean up", "polish"]) {
      const report = assessReadiness(
        issue({
          description:
            `Please ${phrase} in the webhook delivery path, it has been bothering ` +
            "the on-call rotation for a while now.\n\n" +
            "Acceptance criteria:\n- repeated ids are processed once",
        }),
      );
      expect(report.signals.find((s) => s.id === "specificity")?.met).toBe(false);
    }
  });

  it("does not flag specific prose as vague", () => {
    expect(assessReadiness(issue()).signals.find((s) => s.id === "specificity")?.met).toBe(true);
  });

  it("deducts for known blockers and names them", () => {
    const report = assessReadiness(issue({ blockedBy: ["ENG-9", "ENG-10"] }));

    const signal = report.signals.find((s) => s.id === "unblocked");
    expect(signal?.met).toBe(false);
    expect(signal?.detail).toContain("ENG-9");
    expect(signal?.detail).toContain("ENG-10");
  });

  it("deducts for an unset priority, because it sorts last", () => {
    const report = assessReadiness(issue({ priority: 0 }));

    expect(report.signals.find((s) => s.id === "prioritized")?.met).toBe(false);
    // One point of ten: it still dispatches if everything else is present.
    expect(report.score).toBe(9);
    expect(report.dispatchable).toBe(true);
  });

  it("gives every unmet signal a remedy a human can act on", () => {
    const report = assessReadiness(
      issue({ description: "fix it", priority: 0, blockedBy: ["ENG-9"] }),
    );

    expect(report.score).toBe(0);
    expect(report.dispatchable).toBe(false);
    for (const signal of report.signals.filter((s) => !s.met)) {
      expect(signal.remedy, `${signal.id} has no remedy`).toBeDefined();
    }
    expect(report.missing).toHaveLength(report.signals.filter((s) => !s.met).length);
  });

  it("treats 7 as the dispatchable boundary", () => {
    // Description (2) + criteria (4) + specificity (2) = 8 of 10, blocked and
    // unprioritized. The boundary is a policy number; pin it.
    const report = assessReadiness(issue({ priority: 0, blockedBy: ["ENG-9"] }));

    expect(report.score).toBe(8);
    expect(report.dispatchable).toBe(true);
  });
});

describe("renderReadiness", () => {
  it("renders a score bar of exactly ten cells", () => {
    const rendered = renderReadiness(assessReadiness(issue()));
    const bar = rendered.split("readiness ")[1]?.split(" ")[0] ?? "";

    expect([...bar]).toHaveLength(10);
    expect(rendered).toContain("10/10");
  });

  it("says it is ready when it is", () => {
    expect(renderReadiness(assessReadiness(issue()))).toContain("Ready to dispatch.");
  });

  it("tells the human what to add when it is not ready", () => {
    const rendered = renderReadiness(assessReadiness(issue({ description: "fix it" })));

    expect(rendered).toContain("Not ready");
    expect(rendered).toContain("To make this dispatchable:");
    expect(rendered).toContain("Acceptance criteria:");
  });

  it("lists the criteria a review would verify against", () => {
    const rendered = renderReadiness(assessReadiness(issue()));

    expect(rendered).toContain("Acceptance criteria runmill would verify against:");
    expect(rendered).toContain("- repeated ids are processed once");
  });

  it("marks each signal as met or unmet", () => {
    const rendered = renderReadiness(assessReadiness(issue({ blockedBy: ["ENG-9"] })));

    expect(rendered).toContain("✓ description");
    expect(rendered).toContain("✗ unblocked");
  });
});
