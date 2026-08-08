import type { BacklogIssue } from "../domain/types.js";

/**
 * Dependency chains, submitted as stacked pull requests.
 *
 * Today a blocked issue is rejected: `ENG-104 blocked by ENG-99` never runs,
 * and a human does ENG-99 by hand before runmill will touch ENG-104. A stack is
 * the mechanism that turns that rejection into work, by building ENG-104 on top
 * of ENG-99's branch instead of on top of a base that does not contain it.
 *
 * The ordering here is DERIVED from declared dependencies and never imposed.
 * Batching ten unrelated issues into a stack would invent dependencies that do
 * not exist: layer 7 could not merge until layer 1 did, for no reason, and one
 * refused layer would strand every layer above it. A chain is only a chain when
 * the backlog says the work is actually sequential.
 */

export interface Chain {
  /** Bottom first: each issue's blockers appear before it. */
  readonly issues: readonly BacklogIssue[];
}

export interface StackPlan {
  readonly chains: readonly Chain[];
  readonly rejected: readonly { readonly issue: BacklogIssue; readonly reason: string }[];
}

export interface PlanStackInput {
  readonly candidates: readonly BacklogIssue[];
  /**
   * How deep a stack may get.
   *
   * Every layer multiplies the cost of a refusal, because layers above a
   * blocked one cannot merge, and multiplies rebase churn as lower layers land.
   * Beyond a handful the stack stops being reviewable and starts being a queue
   * with extra steps.
   */
  readonly maxDepth?: number | undefined;
}

const DEFAULT_MAX_DEPTH = 4;

/**
 * Group eligible issues into dependency chains.
 *
 * An issue joins a chain only when every one of its blockers is also a
 * candidate. A blocker that is not in the set is not being worked on, so
 * building on it would mean building on something that may never exist, and the
 * issue stays rejected exactly as it is today.
 */
export function planStack(input: PlanStackInput): StackPlan {
  const maxDepth = Math.max(1, input.maxDepth ?? DEFAULT_MAX_DEPTH);
  const byId = new Map(input.candidates.map((i) => [i.identifier, i]));
  const rejected: { issue: BacklogIssue; reason: string }[] = [];

  /**
   * Blockers of `issue` that are in the candidate set, transitively.
   * Returns undefined when the chain cannot be built.
   */
  const resolve = (
    issue: BacklogIssue,
    seen: Set<string>,
  ): BacklogIssue[] | { error: string } => {
    if (seen.has(issue.identifier)) {
      // A depends on B depends on A. There is no order that satisfies both, and
      // guessing one would produce a stack that can never merge.
      return { error: `dependency cycle through ${issue.identifier}` };
    }
    seen.add(issue.identifier);

    const chain: BacklogIssue[] = [];
    for (const blockerId of issue.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker === undefined) {
        return {
          error: `blocked by ${blockerId}, which is not eligible work`,
        };
      }
      const upstream = resolve(blocker, new Set(seen));
      if (!Array.isArray(upstream)) return upstream;
      for (const u of upstream) {
        if (!chain.some((c) => c.identifier === u.identifier)) chain.push(u);
      }
      if (!chain.some((c) => c.identifier === blocker.identifier)) chain.push(blocker);
    }
    return chain;
  };

  // Only issues nothing else depends on start a chain; anything else would
  // produce a stack that is a prefix of a longer one.
  const isBlockerOf = new Set<string>();
  for (const issue of input.candidates) {
    for (const b of issue.blockedBy) if (byId.has(b)) isBlockerOf.add(b);
  }

  const chains: Chain[] = [];
  for (const issue of input.candidates) {
    if (isBlockerOf.has(issue.identifier)) continue;

    const upstream = resolve(issue, new Set());
    if (!Array.isArray(upstream)) {
      rejected.push({ issue, reason: upstream.error });
      continue;
    }

    const issues = [...upstream, issue];
    if (issues.length > maxDepth) {
      rejected.push({
        issue,
        reason:
          `chain is ${issues.length} deep, over the limit of ${maxDepth}. ` +
          `Land the lower layers first`,
      });
      continue;
    }
    chains.push({ issues });
  }

  // Nothing may vanish. An issue skipped as a chain-starter because something
  // depends on it, whose dependant then failed to plan, would otherwise
  // disappear with no chain and no reason. A mutual block does exactly that:
  // both sides are a blocker of the other, so neither starts a chain and
  // neither is reported. Silent disappearance is the failure mode this project
  // exists to prevent, so every candidate is reconciled here.
  const planned = new Set(chains.flatMap((c) => c.issues.map((i) => i.identifier)));
  const explained = new Set(rejected.map((r) => r.issue.identifier));
  for (const issue of input.candidates) {
    if (planned.has(issue.identifier) || explained.has(issue.identifier)) continue;
    const outcome = resolve(issue, new Set());
    rejected.push({
      issue,
      reason: Array.isArray(outcome)
        ? "no chain could be planned for this issue"
        : outcome.error,
    });
  }

  return { chains, rejected };
}

export interface RebaseEvidence {
  /** Tree hash the checks actually ran against. */
  readonly verifiedTreeHash: string;
  /** Tree hash after the rebase. */
  readonly currentTreeHash: string;
}

export interface EvidenceVerdict {
  readonly stillValid: boolean;
  readonly reason: string;
}

/**
 * Does a layer's verification survive a rebase?
 *
 * When a lower layer merges, every layer above it rebases and its commit SHA
 * changes. runmill's freshness rule says a result describes one commit, so the
 * naive readings are "re-verify everything" (correct, expensive) or "record
 * that the evidence predates the rebase" (cheap, weaker).
 *
 * Neither is necessary, because the coverage contract already hashes the TREE
 * rather than only the commit. A rebase that replays the same changes onto an
 * equivalent base produces a different commit and an identical tree, and the
 * checks ran against the tree. So identical tree hash means the evidence still
 * describes exactly what is now on the branch, and nothing needs re-running.
 *
 * A differing hash means the content genuinely changed, usually because the
 * rebase resolved something, and the prior result describes a tree that no
 * longer exists. Then it re-verifies, which is the same rule that rejects a
 * check whose tree moved underneath it.
 */
export function evidenceSurvivesRebase(input: RebaseEvidence): EvidenceVerdict {
  if (input.verifiedTreeHash === "" || input.currentTreeHash === "") {
    return {
      stillValid: false,
      reason: "no tree hash recorded for comparison, so equivalence cannot be shown",
    };
  }
  if (input.verifiedTreeHash === input.currentTreeHash) {
    return {
      stillValid: true,
      reason: "rebase changed the commit but not the tree; the checks ran against this content",
    };
  }
  return {
    stillValid: false,
    reason: "rebase changed the tree, so the prior result describes content that is no longer here",
  };
}

/**
 * What a layer's verification actually proves, stated rather than implied.
 *
 * A green check on the bottom layer means "verified against the base branch". A
 * green check on layer three means "verified against a tree containing two
 * changes that have not merged". Those are different claims, and a stack that
 * reports them identically is overstating the ones above the bottom.
 */
export function describeLayerEvidence(depth: number, baseRef: string): string {
  return depth === 0
    ? `verified against ${baseRef}`
    : `verified against ${baseRef}, which contains ${depth} change(s) that have not merged`;
}
