import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";

export const severitySchema = z.enum(["critical", "high", "medium", "low"]);

export const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  category: z.enum([
    "correctness",
    "security",
    "scope",
    "maintainability",
    "testing",
    "documentation",
  ]),
  title: z.string().min(1),
  evidence: z.object({
    path: z.string().min(1),
    start_line: z.number().int().nonnegative(),
    end_line: z.number().int().nonnegative(),
  }),
  claim: z.string().min(1),
  required_resolution: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const reviewSchema = z.object({
  verdict: z.enum(["approved", "changes_required", "no_findings"]),
  scope_assessment: z.enum(["within_scope", "out_of_scope", "unclear"]),
  acceptance_criteria_met: z.array(z.object({ criterion: z.string(), met: z.boolean() })).default([]),
  findings: z.array(findingSchema).default([]),
});

export type Finding = z.infer<typeof findingSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Severity = z.infer<typeof severitySchema>;

/**
 * Parse reviewer output.
 *
 * A malformed review is never a passing review. Model output is not guaranteed
 * to conform to a schema, and the review verdict gates merge, so anything that
 * does not validate fails closed rather than being coerced or partially read.
 */
export function parseReview(raw: unknown): Review {
  const result = reviewSchema.safeParse(raw);
  if (!result.success) {
    throw RunmillError.fromCatalog("RM-REVIEW-001", {
      whatHappened: result.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n"),
    });
  }
  return result.data;
}

export function parseReviewJson(text: string): Review {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw RunmillError.fromCatalog("RM-REVIEW-001", {
      whatHappened: `reviewer output was not valid JSON: ${String(cause)}`,
      cause,
    });
  }
  return parseReview(raw);
}

export function blockingFindings(
  review: Review,
  blockingSeverities: readonly string[],
): Finding[] {
  return review.findings.filter((f) => blockingSeverities.includes(f.severity));
}

/**
 * Deterministic cross-check of a reviewer's verdict.
 *
 * The reviewer is a model, and its verdict releases code. A `no_findings`
 * verdict on a diff that touches risk-escalating paths is rejected outright
 * rather than trusted, because that is exactly the shape a prompt-injected or
 * simply over-agreeable review takes.
 *
 * Every rule here is one-directional: each can withhold delivery, none can
 * grant it. That is what makes it safe to let a model's judgment participate at
 * all. A model that can only ever subtract permission cannot be prompted into
 * releasing something.
 */
export function crossCheckVerdict(
  review: Review,
  changedPaths: readonly string[],
  riskPaths: readonly string[],
): { accepted: boolean; reason?: string } {
  const touchesRisk = changedPaths.some((p) =>
    riskPaths.some((r) => p.startsWith(r.replace(/\/?\*+$/, ""))),
  );
  if (review.verdict === "no_findings" && touchesRisk) {
    return {
      accepted: false,
      reason:
        "reviewer reported no findings on a diff touching risk-escalating paths; " +
        "escalating rather than trusting the verdict",
    };
  }
  if (review.verdict === "approved" && review.scope_assessment === "out_of_scope") {
    return { accepted: false, reason: "reviewer approved a change it also called out of scope" };
  }

  // The semantic gate, and the only one no amount of deterministic checking can
  // replace: a change can pass every check, stay in scope, and still not be the
  // thing the issue asked for. The acceptance criteria come from the issue and
  // are pinned in the task packet at claim time, so the run is judged against
  // what was asked when it was claimed.
  //
  // Note the asymmetry. This can only ever turn a pass into a failure. A
  // reviewer reporting every criterion met grants nothing on its own: the
  // deterministic gates still have to pass, and "the model says it's done"
  // remains the claim runmill exists not to accept.
  const unmet = review.acceptance_criteria_met.filter((c) => !c.met);
  if (unmet.length > 0 && (review.verdict === "approved" || review.verdict === "no_findings")) {
    return {
      accepted: false,
      reason:
        `reviewer approved a change that does not meet ${unmet.length} of its stated ` +
        `acceptance criteria: ${unmet.map((c) => `"${c.criterion}"`).join(", ")}`,
    };
  }

  return { accepted: true };
}
