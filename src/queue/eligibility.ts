import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import { resolveRepository, type RepositoryRule } from "./repository-mapping.js";

/**
 * Every eligibility rule, always evaluated.
 *
 * Order here is presentation order for `next --dry-run`. Evaluation never
 * short-circuits: FR-03 requires a rule-by-rule explanation for rejected
 * candidates, and a short-circuited evaluation cannot produce one.
 */
export const RULE_IDS = [
  "mapped-repository",
  "workflow-state",
  "not-terminal",
  "not-leased",
  "labels",
  "estimate",
  "dependencies",
  "readiness",
  "capacity",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface RuleResult {
  readonly rule: RuleId;
  readonly passed: boolean;
  readonly reason: string;
  readonly code?: string | undefined;
}

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly rules: readonly RuleResult[];
  readonly target?: RepositoryTarget | undefined;
}

export interface EligibilityPolicy {
  readonly eligibleStates: readonly string[];
  readonly includeLabels: readonly string[];
  readonly excludeLabels: readonly string[];
  readonly repositoryRules: readonly RepositoryRule[];
  readonly capacityAvailable: boolean;
  readonly leasedIssueIds: ReadonlySet<string>;
  readonly maxEstimate?: number | undefined;
  /** Label that bypasses the readiness heuristic, e.g. "agent-ready". */
  readonly readinessOverrideLabel?: string | undefined;
  /** Minimum description length treated as enough to build a task packet. */
  readonly minDescriptionChars?: number | undefined;
}

const DEFAULT_MIN_DESCRIPTION_CHARS = 80;

function pass(rule: RuleId, reason: string): RuleResult {
  return { rule, passed: true, reason };
}

function fail(rule: RuleId, reason: string, code?: string): RuleResult {
  return code === undefined
    ? { rule, passed: false, reason }
    : { rule, passed: false, reason, code };
}

/**
 * Deterministically decide whether an issue may be claimed.
 *
 * Pure: no clock, no network, no model judgement. Given the same issue and
 * policy this always returns the same decision, which is what makes selection
 * explainable and reproducible.
 */
export function evaluateEligibility(
  issue: BacklogIssue,
  policy: EligibilityPolicy,
): EligibilityDecision {
  const rules: RuleResult[] = [];

  // 1. Repository mapping. Also produces the claim target, because the lease
  //    ref lives in the mapped repository.
  const resolution = resolveRepository(issue, policy.repositoryRules);
  rules.push(
    resolution.resolved
      ? pass("mapped-repository", `resolved to ${resolution.target?.repo} by rule ${resolution.matchedRuleIndex}`)
      : fail("mapped-repository", resolution.reason ?? "unresolved", resolution.code),
  );

  // 2. Workflow state.
  const stateOk = policy.eligibleStates.includes(issue.state);
  rules.push(
    stateOk
      ? pass("workflow-state", `state "${issue.state}" is eligible`)
      : fail(
          "workflow-state",
          `state "${issue.state}" is not in [${policy.eligibleStates.join(", ")}]`,
        ),
  );

  // 3. Not canceled or completed.
  const terminal = issue.canceled || issue.completed;
  rules.push(
    terminal
      ? fail("not-terminal", issue.canceled ? "issue is canceled" : "issue is already completed")
      : pass("not-terminal", "issue is open"),
  );

  // 4. Not already leased.
  const leased = policy.leasedIssueIds.has(issue.identifier);
  rules.push(
    leased
      ? fail("not-leased", `issue is actively leased by another run`)
      : pass("not-leased", "no active lease"),
  );

  // 5. Labels.
  const missingIncludes = policy.includeLabels.filter((l) => !issue.labels.includes(l));
  const presentExcludes = policy.excludeLabels.filter((l) => issue.labels.includes(l));
  if (missingIncludes.length > 0) {
    rules.push(fail("labels", `missing required label(s): ${missingIncludes.join(", ")}`));
  } else if (presentExcludes.length > 0) {
    rules.push(fail("labels", `carries excluded label(s): ${presentExcludes.join(", ")}`));
  } else {
    rules.push(pass("labels", "label rules satisfied"));
  }

  // 6. Estimate.
  if (policy.maxEstimate === undefined) {
    rules.push(pass("estimate", "no estimate ceiling configured"));
  } else if (issue.estimate === undefined) {
    rules.push(pass("estimate", "issue has no estimate"));
  } else if (issue.estimate > policy.maxEstimate) {
    rules.push(fail("estimate", `estimate ${issue.estimate} exceeds maximum ${policy.maxEstimate}`));
  } else {
    rules.push(pass("estimate", `estimate ${issue.estimate} within maximum ${policy.maxEstimate}`));
  }

  // 7. Dependencies.
  rules.push(
    issue.blockedBy.length > 0
      ? fail("dependencies", `blocked by ${issue.blockedBy.join(", ")}`)
      : pass("dependencies", "no known blockers"),
  );

  // 8. Readiness. An explicit override label bypasses the heuristic; note that
  //    this makes label-add authority into code-execution authority, which is
  //    surfaced at setup rather than hidden here.
  const minChars = policy.minDescriptionChars ?? DEFAULT_MIN_DESCRIPTION_CHARS;
  const overrideLabel = policy.readinessOverrideLabel;
  const hasOverride = overrideLabel !== undefined && issue.labels.includes(overrideLabel);
  if (hasOverride) {
    rules.push(pass("readiness", `readiness override: "${overrideLabel}" label present`));
  } else if (issue.description.trim().length < minChars) {
    rules.push(
      fail(
        "readiness",
        `description is ${issue.description.trim().length} chars, below the ${minChars} needed to build a task packet`,
        "RM-SELECT-003",
      ),
    );
  } else {
    rules.push(pass("readiness", "description is substantial enough for a task packet"));
  }

  // 9. Global capacity.
  rules.push(
    policy.capacityAvailable
      ? pass("capacity", "worker, repository, and cost limits allow another run")
      : fail("capacity", "global worker, repository, or cost limit reached"),
  );

  const eligible = rules.every((r) => r.passed);
  return eligible
    ? { eligible, rules, target: resolution.target }
    : { eligible, rules };
}
