import type { BacklogAdapter } from "../backlog/adapter.js";
import type { RunmillConfig } from "../config/types.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import { evaluateEligibility, type EligibilityDecision } from "./eligibility.js";
import { orderIssues } from "./ordering.js";

export interface SelectedCandidate {
  readonly issue: BacklogIssue;
  readonly target: RepositoryTarget;
  readonly decision: EligibilityDecision;
}

export interface RejectedCandidate {
  readonly issue: BacklogIssue;
  readonly decision: EligibilityDecision;
}

export interface SelectionResult {
  readonly selected?: SelectedCandidate | undefined;
  readonly rejected: readonly RejectedCandidate[];
  /** Eligible issues after the selected one, in order. */
  readonly runnersUp: readonly SelectedCandidate[];
}

export interface SelectNextInput {
  readonly backlog: BacklogAdapter;
  readonly config: RunmillConfig;
  readonly leasedIssueIds: ReadonlySet<string>;
  readonly capacityAvailable?: boolean | undefined;
}

/**
 * Deterministically choose the next issue to work on.
 *
 * Two properties matter more than the choice itself: it is reproducible (no
 * model judgement anywhere on this path), and it is explainable — every
 * rejected candidate carries a rule-by-rule record, because `next --dry-run`
 * is how a developer learns why their backlog is not moving.
 */
export async function selectNext(input: SelectNextInput): Promise<SelectionResult> {
  const { backlog, config } = input;

  const candidates = await backlog.listCandidates({
    team: config.backlog.team,
    states: config.backlog.eligibleStates,
  });

  const policy = {
    eligibleStates: config.backlog.eligibleStates,
    includeLabels: config.backlog.includeLabels,
    excludeLabels: config.backlog.excludeLabels,
    repositoryRules: config.github.repositories,
    capacityAvailable: input.capacityAvailable ?? true,
    leasedIssueIds: input.leasedIssueIds,
    maxEstimate: config.backlog.maxEstimate,
    readinessOverrideLabel: config.backlog.includeLabels.includes("agent-ready")
      ? "agent-ready"
      : undefined,
  };

  const eligible: SelectedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  // Order first, then evaluate, so the eligible list is already in priority
  // order and the first entry is the selection.
  for (const issue of orderIssues(candidates)) {
    const decision = evaluateEligibility(issue, policy);
    if (decision.eligible && decision.target !== undefined) {
      eligible.push({ issue, target: decision.target, decision });
    } else {
      rejected.push({ issue, decision });
    }
  }

  const [selected, ...runnersUp] = eligible;
  return selected === undefined
    ? { rejected, runnersUp: [] }
    : { selected, rejected, runnersUp };
}
