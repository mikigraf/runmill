/**
 * The review contract.
 *
 * This is the one place a model's judgment about MEANING participates in the
 * decision to release code. Deterministic checks prove the code runs; they
 * cannot prove it did what was asked. So the direction the model can move the
 * decision matters more than how good the model is.
 */
import { describe, expect, it } from "vitest";
import {
  parseReviewJson,
  blockingFindings,
  crossCheckVerdict,
  reviewSchema,
} from "../../src/review/schema.js";
import { SKILL_FILES } from "../../src/review/default-skills.js";

function review(over: Record<string, unknown> = {}): never {
  return {
    verdict: "approved",
    scope_assessment: "within_scope",
    findings: [],
    acceptance_criteria_met: [],
    ...over,
  } as never;
}

const FINDING = {
  id: "REV-1",
  severity: "critical",
  category: "correctness",
  title: "off-by-one",
  evidence: { path: "src/a.ts", start_line: 1, end_line: 1 },
  claim: "reads past the end",
  required_resolution: "bound the index",
  confidence: 0.9,
};

describe("parseReviewJson", () => {
  it("parses a well-formed review", () => {
    const parsed = parseReviewJson(
      JSON.stringify({
        verdict: "approved",
        scope_assessment: "within_scope",
        acceptance_criteria_met: [],
        findings: [],
      }),
    );
    expect(parsed.verdict).toBe("approved");
  });

  it("rejects a review missing a required field", () => {
    // An unparseable review is not an absent review: its conclusion is unknown,
    // and unknown is not permission to merge.
    expect(() => parseReviewJson(JSON.stringify({ verdict: "approved" }))).toThrow();
  });

  it("rejects a review that omits acceptance-criteria evidence", () => {
    expect(() =>
      parseReviewJson(
        JSON.stringify({
          verdict: "approved",
          scope_assessment: "within_scope",
          findings: [],
        }),
      ),
    ).toThrow();
  });

  it("rejects output that is not JSON at all", () => {
    expect(() => parseReviewJson("the code looks fine to me!")).toThrow();
  });
});

describe("blockingFindings", () => {
  it("blocks on the configured severities and ignores the rest", () => {
    const r = review({
      findings: [FINDING, { ...FINDING, id: "REV-2", severity: "low" }],
    });
    expect(blockingFindings(r, ["critical", "high"]).map((f) => f.id)).toEqual(["REV-1"]);
  });

  it("treats every finding as blocking when the reviewer requires changes", () => {
    const r = review({
      verdict: "changes_required",
      findings: [{ ...FINDING, severity: "low" }],
    });
    expect(blockingFindings(r, ["critical", "high"]).map((f) => f.id)).toEqual(["REV-1"]);
  });

  it("returns nothing when no finding reaches the threshold", () => {
    const r = review({ findings: [{ ...FINDING, severity: "low" }] });
    expect(blockingFindings(r, ["critical", "high"])).toEqual([]);
  });

  it("treats every finding as unresolved when policy requires all findings resolved", () => {
    const r = review({ findings: [{ ...FINDING, severity: "low" }] });
    expect(blockingFindings(r, ["critical", "high"], true).map((f) => f.id)).toEqual([
      "REV-1",
    ]);
  });
});

describe("crossCheckVerdict", () => {
  it("rejects a clean verdict on a diff touching risk-escalating paths", () => {
    // The signature of a prompt-injected or simply over-agreeable review.
    const result = crossCheckVerdict(
      review({ verdict: "no_findings" }),
      ["src/auth/token.ts"],
      ["src/auth/"],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/risk-escalating/);
  });

  it("allows a clean verdict on a diff that touches nothing risky", () => {
    expect(
      crossCheckVerdict(review({ verdict: "no_findings" }), ["docs/a.md"], ["src/auth/"], []).accepted,
    ).toBe(true);
  });

  it("uses the same glob semantics as the automatic-merge risk gate", () => {
    const result = crossCheckVerdict(
      review({ verdict: "no_findings" }),
      ["src/auth/token.ts"],
      ["src/**/*.ts"],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/risk-escalating/);
  });

  it("fails closed when a risk path rule uses unsupported syntax", () => {
    const result = crossCheckVerdict(
      review({ verdict: "approved" }),
      ["src/auth/token.ts"],
      ["src/[ab]*/**"],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/unsupported or invalid syntax/);
  });

  it("rejects an approval of a change the reviewer called out of scope", () => {
    const result = crossCheckVerdict(
      review({ scope_assessment: "out_of_scope" }),
      ["src/a.ts"],
      [],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/out of scope/);
  });

  it("rejects an approval when scope is unclear", () => {
    const result = crossCheckVerdict(
      review({ scope_assessment: "unclear" }),
      ["src/a.ts"],
      [],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/could not establish/i);
  });

  it("rejects a no-findings verdict that also contains findings", () => {
    const result = crossCheckVerdict(
      review({ verdict: "no_findings", findings: [FINDING] }),
      ["src/a.ts"],
      [],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/also returning findings/i);
  });

  it("rejects changes-required without an actionable finding", () => {
    const result = crossCheckVerdict(
      review({ verdict: "changes_required", findings: [] }),
      ["src/a.ts"],
      [],
      [],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/no actionable finding/i);
  });
});

describe("acceptance criteria as a delivery gate", () => {
  it("rejects an approval that leaves a stated criterion unmet", () => {
    // The reviewer contradicted itself: it approved work it also reported as
    // not doing what the issue asked for. This was recorded and rendered into
    // the PR body, and enforced nowhere.
    const result = crossCheckVerdict(
      review({
        acceptance_criteria_met: [
          { criterion: "greet returns a greeting", met: true },
          { criterion: "it is covered by a test", met: false },
        ],
      }),
      ["src/greeting.ts"],
      [],
      ["greet returns a greeting", "it is covered by a test"],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/acceptance criteria/);
    expect(result.reason).toContain("covered by a test");
  });

  it("applies to a no_findings verdict as well as an approval", () => {
    const result = crossCheckVerdict(
      review({
        verdict: "no_findings",
        acceptance_criteria_met: [{ criterion: "handles the empty case", met: false }],
      }),
      ["src/a.ts"],
      [],
      ["handles the empty case"],
    );
    expect(result.accepted).toBe(false);
  });

  it("accepts when every stated criterion is met", () => {
    const result = crossCheckVerdict(
      review({
        acceptance_criteria_met: [
          { criterion: "greet returns a greeting", met: true },
          { criterion: "it is covered by a test", met: true },
        ],
      }),
      ["src/greeting.ts"],
      [],
      ["greet returns a greeting", "it is covered by a test"],
    );
    expect(result.accepted).toBe(true);
  });

  it("does not treat an empty criteria list as a failure", () => {
    // An issue with no extractable criteria is a readiness problem, caught by
    // selection before a run starts. It must not become a permanent block here.
    expect(crossCheckVerdict(review(), ["src/a.ts"], [], []).accepted).toBe(true);
  });

  it("is one-directional: reporting every criterion met grants nothing", () => {
    // The rule can withhold delivery; it cannot confer it. A reviewer claiming
    // everything passed still loses to a verdict that already failed another
    // rule, which is what stops a model being prompted into releasing code.
    const result = crossCheckVerdict(
      review({
        scope_assessment: "out_of_scope",
        acceptance_criteria_met: [{ criterion: "everything", met: true }],
      }),
      ["src/a.ts"],
      [],
      ["everything"],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/out of scope/);
  });

  it("rejects approval when the reviewer omits criteria from the task packet", () => {
    const result = crossCheckVerdict(
      review({
        acceptance_criteria_met: [{ criterion: "first criterion", met: true }],
      }),
      ["src/a.ts"],
      [],
      ["first criterion", "second criterion"],
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("second criterion");
  });

  it("rejects an empty evidence list when the task packet has criteria", () => {
    const result = crossCheckVerdict(review(), ["src/a.ts"], [], ["must be tested"]);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("must be tested");
  });
});

describe("the shipped review skills describe the schema they demand", () => {
  /**
   * The reviewer is told to emit "the review-findings@1 schema" and was never
   * shown it. A real run proved the cost: the model returned a well-formed,
   * sensible verdict that omitted two required fields, runmill refused it as
   * malformed -- correctly, since a review that does not parse must never read
   * as an approval -- and the run quarantined and tripped the circuit breaker.
   *
   * Every required key has to appear in the prompt, and this fails if the
   * schema grows a field the prompt does not mention.
   */
  const required = Object.keys(reviewSchema.shape);

  for (const skill of SKILL_FILES) {
    for (const key of required) {
      it(`${skill.path} names "${key}"`, () => {
        expect(skill.content).toContain(key);
      });
    }

    it(`${skill.path} lists every verdict the schema accepts`, () => {
      for (const verdict of ["approved", "changes_required", "no_findings"]) {
        expect(skill.content).toContain(verdict);
      }
    });

    it(`${skill.path} says the optional-looking fields are required`, () => {
      expect(skill.content).toMatch(/required/i);
    });
  }
});
