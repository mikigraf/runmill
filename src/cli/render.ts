import type { CheckResult, CheckStatus } from "../doctor/checks.js";
import type { SelectionResult } from "../queue/selector.js";
import { PRIORITY_LABELS } from "../domain/types.js";

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };

export function renderDoctor(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const lines = results.map((r) => {
    const head = `  ${SYMBOL[r.status]} ${r.id.padEnd(width)}  ${r.observed}`;
    if (r.status === "pass") return head;
    const detail: string[] = [`      expected: ${r.expected}`];
    if (r.code !== undefined) detail.push(`      code:     ${r.code}`);
    if (r.remediation !== undefined) detail.push(`      fix:      ${r.remediation}`);
    return [head, ...detail].join("\n");
  });
  return lines.join("\n");
}

/**
 * The rule-by-rule selection explanation.
 *
 * This is the answer to "why is my backlog not moving", which is the question
 * a developer actually has. Rejected candidates show every rule, with the
 * failing ones marked, so the reason is never inferred.
 */
export function renderSelection(result: SelectionResult, team?: string): string {
  const out: string[] = [];

  if (result.selected === undefined) {
    // An empty backlog and a backlog that rejected everything are different
    // problems with different fixes, and "No eligible issue." named neither.
    if (result.runnersUp.length === 0 && result.rejected.length === 0) {
      out.push("No issues came back from the backlog.");
      out.push("");
      out.push("  Either the query matched nothing, or the credential reads a different team.");
      out.push(`  Configured team: ${team ?? "(unset)"}`);
      out.push("");
      out.push("  runmill config show          confirm the team and filters in effect");
      out.push("  runmill auth status          confirm which credential is resolving");
    } else {
      out.push("No eligible issue — every candidate was rejected. Reasons below.");
    }
  } else {
    const { issue, target } = result.selected;
    out.push(`Would select  ${issue.identifier}  ${issue.title}`);
    out.push(`  repository  ${target.repo} (base ${target.baseBranch})`);
    out.push(`  priority    ${PRIORITY_LABELS[issue.priority] ?? String(issue.priority)}`);
  }

  if (result.runnersUp.length > 0) {
    out.push("");
    out.push(`Next in queue (${result.runnersUp.length}):`);
    for (const c of result.runnersUp.slice(0, 5)) {
      out.push(`  ${c.issue.identifier}  ${c.issue.title}`);
    }
  }

  if (result.rejected.length > 0) {
    out.push("");
    out.push(`Rejected (${result.rejected.length}):`);
    for (const r of result.rejected) {
      const failed = r.decision.rules.filter((rule) => !rule.passed);
      out.push(`  ${r.issue.identifier}  ${r.issue.title}`);
      for (const rule of failed) {
        const code = rule.code === undefined ? "" : `  [${rule.code}]`;
        out.push(`      ✗ ${rule.rule}: ${rule.reason}${code}`);
      }
    }
  }

  return out.join("\n");
}
