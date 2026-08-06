import type { BacklogIssue } from "../domain/types.js";
import type { Review } from "../review/schema.js";

export interface PullRequestBodyInput {
  readonly issue: BacklogIssue;
  readonly review: Review | undefined;
  readonly runId: string;
  readonly provider: string;
  readonly checks: readonly { readonly id: string; readonly status: string }[];
  readonly riskTier?: string | undefined;
  readonly harnessVersion?: string | undefined;
}

/**
 * Render the pull request body from structured artifacts.
 *
 * Deliberately not free prose from the agent: the body is evidence a human
 * uses to decide, so every line traces to something the control plane
 * recorded. An agent-authored summary can be confidently wrong; a rendered
 * artifact cannot be wrong about what the checks did.
 */
export function renderPullRequestBody(input: PullRequestBodyInput): string {
  const lines: string[] = [];

  lines.push("## Issue");
  lines.push(`${input.issue.identifier} — ${input.issue.title}`);
  lines.push("");

  lines.push("## Scope");
  lines.push(
    input.review?.scope_assessment === "within_scope"
      ? "Within the issue's stated scope, per independent review."
      : `Scope assessment: ${input.review?.scope_assessment ?? "not assessed"}`,
  );
  lines.push("");

  const criteria = input.review?.acceptance_criteria_met ?? [];
  if (criteria.length > 0) {
    lines.push("## Acceptance criteria");
    for (const c of criteria) {
      lines.push(`- [${c.met ? "x" : " "}] ${c.criterion}`);
    }
    lines.push("");
  }

  lines.push("## Verification");
  if (input.checks.length === 0) {
    lines.push("- no local checks configured");
  } else {
    for (const check of input.checks) {
      lines.push(`- ${check.id}: ${check.status}`);
    }
  }
  lines.push(
    `- independent review: ${input.review?.verdict ?? "not run"}` +
      (input.review === undefined ? "" : ` (${input.review.findings.length} finding(s))`),
  );
  lines.push("");

  if (input.review !== undefined && input.review.findings.length > 0) {
    lines.push("## Review findings");
    for (const f of input.review.findings) {
      lines.push(
        `- **${f.severity}** ${f.title} — \`${f.evidence.path}:${f.evidence.start_line}\``,
      );
    }
    lines.push("");
  }

  lines.push("## Risk");
  lines.push(input.riskTier ?? "not classified");
  lines.push("");

  lines.push("## runmill");
  lines.push(`Run: ${input.runId}`);
  lines.push(`Provider: ${input.provider}`);
  if (input.harnessVersion !== undefined) lines.push(`Harness: ${input.harnessVersion}`);

  return lines.join("\n");
}
