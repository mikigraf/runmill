/**
 * Terminal rendering.
 *
 * This is the entire product surface for `doctor` and `next` — a developer's
 * whole impression of what runmill knows is whatever these functions print. A
 * rendering bug is indistinguishable from a logic bug from the outside.
 */
import { describe, expect, it } from "vitest";
import { renderDoctor, renderSelection } from "../../src/cli/render.js";
import type { CheckResult } from "../../src/doctor/checks.js";
import type { SelectionResult } from "../../src/queue/selector.js";
import type { BacklogIssue } from "../../src/domain/types.js";

function issue(overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: "iss_1",
    identifier: "ENG-101",
    title: "Prevent duplicate webhook delivery",
    description: "",
    state: "Todo",
    labels: [],
    priority: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: "https://example.invalid/ENG-101",
    blockedBy: [],
    ...overrides,
  } as BacklogIssue;
}

const TARGET = { repo: "acme/platform", baseBranch: "main" };
const ELIGIBLE = { eligible: true, rules: [{ rule: "state", passed: true, reason: "in Todo" }] };

/** A selected candidate, with the eligibility decision the selector attaches. */
function selected(overrides: Partial<BacklogIssue> = {}) {
  return { issue: issue(overrides), target: TARGET, decision: ELIGIBLE } as never;
}

describe("renderDoctor", () => {
  it("shows only the observation for a passing check", () => {
    const out = renderDoctor([
      { id: "git", status: "pass", observed: "git version 2.50.1", expected: "git >= 2.30" },
    ]);
    expect(out).toContain("✓");
    expect(out).toContain("git version 2.50.1");
    // A passing check that also prints what was expected is noise: the reader
    // already knows it matched.
    expect(out).not.toContain("expected:");
  });

  it("shows expectation, code, and fix for a failure", () => {
    const out = renderDoctor([
      {
        id: "sandbox:mechanism",
        status: "fail",
        code: "RM-SANDBOX-001",
        observed: "bwrap not found",
        expected: "bubblewrap installed",
        remediation: "apt install bubblewrap",
      },
    ]);
    expect(out).toContain("✗");
    expect(out).toContain("expected: bubblewrap installed");
    expect(out).toContain("code:     RM-SANDBOX-001");
    expect(out).toContain("fix:      apt install bubblewrap");
  });

  it("distinguishes a warning from a failure", () => {
    const out = renderDoctor([
      {
        id: "sandbox:network",
        status: "warn",
        observed: "Seatbelt cannot scope network by host",
        expected: "egress via the proxy",
      },
    ]);
    expect(out).toContain("!");
    expect(out).not.toContain("✗");
  });

  it("aligns observations in a column so the report scans vertically", () => {
    const checks: CheckResult[] = [
      { id: "git", status: "pass", observed: "ok", expected: "" },
      { id: "sandbox:deny-credential-read", status: "pass", observed: "denied", expected: "" },
    ];
    const lines = renderDoctor(checks).split("\n");
    expect(lines[0]?.indexOf("ok")).toBe(lines[1]?.indexOf("denied"));
  });

  it("omits a fix line when there is no remediation to offer", () => {
    const out = renderDoctor([
      { id: "x", status: "fail", observed: "bad", expected: "good" },
    ]);
    expect(out).not.toContain("fix:");
  });
});

describe("renderSelection", () => {
  const empty: SelectionResult = { rejected: [], runnersUp: [] };

  it("names the selected issue, its repository, and its priority", () => {
    const out = renderSelection({
      ...empty,
      selected: selected({ priority: 1 }),
    });
    expect(out).toContain("ENG-101");
    expect(out).toContain("acme/platform (base main)");
    expect(out).toContain("urgent");
  });

  it("renders an unrecognised priority as its raw value rather than crashing", () => {
    const out = renderSelection({
      ...empty,
      selected: selected({ priority: 99 as never }),
    });
    expect(out).toContain("99");
  });

  it("distinguishes an empty backlog from one that rejected everything", () => {
    // These are different problems with different fixes, and a single
    // "No eligible issue." named neither.
    const emptyOut = renderSelection(empty, "ENG");
    expect(emptyOut).toContain("No issues came back from the backlog");
    expect(emptyOut).toContain("ENG");

    const rejectedOut = renderSelection({
      ...empty,
      rejected: [
        {
          issue: issue(),
          decision: {
            eligible: false,
            rules: [{ rule: "labels", passed: false, reason: "carries excluded label(s)" }],
          },
        } as never,
      ],
    });
    expect(rejectedOut).toContain("every candidate was rejected");
  });

  it("says the team is unset when it is", () => {
    expect(renderSelection(empty)).toContain("(unset)");
  });

  it("lists runners-up, capped at five so the output stays readable", () => {
    const runnersUp = Array.from({ length: 9 }, (_, i) =>
      selected({ identifier: `ENG-${200 + i}` }),
    );
    const out = renderSelection({
      ...empty,
      selected: selected(),
      runnersUp,
    });

    expect(out).toContain("Next in queue (9)");
    expect(out).toContain("ENG-204");
    expect(out).not.toContain("ENG-205");
  });

  it("shows every failing rule for a rejected issue, with its code", () => {
    // "Why is my backlog not moving" is the actual question, so every failing
    // rule is listed rather than just the first.
    const out = renderSelection({
      ...empty,
      rejected: [
        {
          issue: issue({ identifier: "ENG-104" }),
          decision: {
            eligible: false,
            rules: [
              { rule: "state", passed: true, reason: "in Todo" },
              { rule: "dependencies", passed: false, reason: "blocked by ENG-99", code: "RM-SELECT-001" },
              { rule: "labels", passed: false, reason: "carries excluded label(s): needs-design" },
            ],
          },
        } as never,
      ],
    });

    expect(out).toContain("Rejected (1)");
    expect(out).toContain("blocked by ENG-99");
    expect(out).toContain("[RM-SELECT-001]");
    expect(out).toContain("needs-design");
    // Passing rules are not the answer to "why was this rejected".
    expect(out).not.toContain("in Todo");
  });

  it("does not list rejections that have no failing rule", () => {
    const out = renderSelection({
      ...empty,
      rejected: [
        {
          issue: issue(),
          decision: { eligible: false, rules: [{ rule: "state", passed: true, reason: "fine" }] },
        } as never,
      ],
    });
    expect(out).toContain("Rejected (1)");
    expect(out).not.toContain("✗ state");
  });
});
