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
  acceptance_criteria_met: z.array(z.object({ criterion: z.string(), met: z.boolean() })),
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
  requireAllFindingsResolved = false,
): Finding[] {
  // A reviewer that explicitly requires changes cannot have that decision
  // weakened by a severity threshold. Thresholds apply only to an otherwise
  // approving verdict; `changes_required` is itself a withholding decision.
  if (requireAllFindingsResolved || review.verdict === "changes_required") {
    return [...review.findings];
  }
  return review.findings.filter((f) => blockingSeverities.includes(f.severity));
}

function normalizeRiskPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function validRiskPathRule(rule: string): boolean {
  const trimmed = rule.trim().replaceAll("\\", "/");
  const normalized = normalizeRiskPath(trimmed);
  if (
    normalized === "" ||
    normalized.includes("\0") ||
    /[\r\n]/.test(normalized) ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:\//.test(trimmed)
  ) {
    return false;
  }
  const segments = normalized.split("/");
  if (segments.includes(".") || segments.includes("..")) return false;
  if (segments.slice(0, -1).includes("")) return false;
  // Runmill supports literals, *, ** and ?. Unknown glob dialects must not be
  // interpreted as literal characters and accidentally miss a sensitive diff.
  return !/[\[\]{}!]/.test(normalized);
}

function riskPathExpression(rule: string): RegExp {
  const normalized = normalizeRiskPath(rule.trim());
  let expression = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`${expression}$`);
}

/** Match a repository-relative changed path against the documented glob subset. */
export function matchesRiskPath(path: string, rule: string): boolean | undefined {
  if (!validRiskPathRule(rule)) return undefined;
  const normalizedPath = normalizeRiskPath(path);
  const normalizedRule = normalizeRiskPath(rule.trim());

  if (!/[?*]/.test(normalizedRule)) {
    const prefix = normalizedRule.replace(/\/+$/, "");
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  return riskPathExpression(normalizedRule).test(normalizedPath);
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
  acceptanceCriteria: readonly string[],
): { accepted: boolean; reason?: string } {
  if (review.verdict === "no_findings" && review.findings.length > 0) {
    return {
      accepted: false,
      reason: "reviewer reported no findings while also returning findings",
    };
  }
  if (review.verdict === "changes_required" && review.findings.length === 0) {
    return {
      accepted: false,
      reason: "reviewer required changes but supplied no actionable finding",
    };
  }
  if (
    review.verdict !== "changes_required" &&
    review.scope_assessment !== "within_scope"
  ) {
    return {
      accepted: false,
      reason:
        review.scope_assessment === "out_of_scope"
          ? "reviewer approved a change it also called out of scope"
          : "reviewer could not establish that the approved change stayed within scope",
    };
  }

  const unknownRiskPathRule = riskPaths.find(
    (rule) => matchesRiskPath("", rule) === undefined,
  );
  if (unknownRiskPathRule !== undefined) {
    return {
      accepted: false,
      reason:
        `risk.manual_approval.paths rule ${JSON.stringify(unknownRiskPathRule)} uses ` +
        "unsupported or invalid syntax",
    };
  }
  const touchesRisk = changedPaths.some((path) =>
    riskPaths.some((rule) => matchesRiskPath(path, rule) === true),
  );
  if (review.verdict === "no_findings" && touchesRisk) {
    return {
      accepted: false,
      reason:
        "reviewer reported no findings on a diff touching risk-escalating paths; " +
        "escalating rather than trusting the verdict",
    };
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
  const evidenceByCriterion = new Map<string, boolean[]>();
  for (const entry of review.acceptance_criteria_met) {
    const evidence = evidenceByCriterion.get(entry.criterion) ?? [];
    evidence.push(entry.met);
    evidenceByCriterion.set(entry.criterion, evidence);
  }
  const incomplete = acceptanceCriteria.filter((criterion) => {
    const evidence = evidenceByCriterion.get(criterion);
    return evidence === undefined || evidence.length !== 1 || evidence[0] !== true;
  });
  if (
    incomplete.length > 0 &&
    (review.verdict === "approved" || review.verdict === "no_findings")
  ) {
    return {
      accepted: false,
      reason:
        `reviewer approved a change without positive evidence for ${incomplete.length} of the ` +
        `task packet's acceptance criteria: ${incomplete.map((c) => `"${c}"`).join(", ")}`,
    };
  }

  return { accepted: true };
}
