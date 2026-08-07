import type { BacklogIssue, BacklogPriority } from "../domain/types.js";

/**
 * Map a backlog priority onto a sort key that orders ascending.
 *
 * Linear encodes "no priority" as 0 and "urgent" as 1, so sorting on the raw
 * value places unprioritized issues at the very front of the queue — pointing
 * the agent at the least-specified work first. Mapping 0 to +Infinity puts
 * them last, which is what the eligibility and ordering rules require.
 */
export function prioritySortKey(priority: BacklogPriority): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

/** Nearest due date first; issues with no due date sort after those with one. */
function dueDateSortKey(issue: BacklogIssue): number {
  if (issue.dueDate === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(issue.dueDate);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Explicit manual rank first; unranked issues sort after ranked ones. */
function manualRankSortKey(issue: BacklogIssue): number {
  return issue.manualRank ?? Number.POSITIVE_INFINITY;
}

function createdAtSortKey(issue: BacklogIssue): number {
  const parsed = Date.parse(issue.createdAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Total order over eligible issues. Deliberately deterministic and free of any
 * model judgement: selection must be reproducible and explainable.
 *
 * Precedence, highest first:
 *   1. explicit priority (urgent > high > medium > low > none)
 *   2. nearest due date
 *   3. manual within-priority rank
 *   4. oldest creation timestamp
 *   5. stable identifier
 */
/**
 * Comparison by ordering, not subtraction.
 *
 * Subtraction is what forced the Infinity special-casing this replaces:
 * `Infinity - Infinity` is NaN, so every key that uses Infinity as its
 * "absent" sentinel needed a guard. Comparing directly handles it by
 * construction, and adding a tiebreaker becomes one line.
 */
function cmp(x: number | string, y: number | string): number {
  return x === y ? 0 : x < y ? -1 : 1;
}

export function compareIssues(a: BacklogIssue, b: BacklogIssue): number {
  return (
    cmp(prioritySortKey(a.priority), prioritySortKey(b.priority)) ||
    cmp(dueDateSortKey(a), dueDateSortKey(b)) ||
    cmp(manualRankSortKey(a), manualRankSortKey(b)) ||
    cmp(createdAtSortKey(a), createdAtSortKey(b)) ||
    cmp(a.identifier, b.identifier)
  );
}

/** Returns a new ordered array. Never mutates the input. */
export function orderIssues(issues: readonly BacklogIssue[]): BacklogIssue[] {
  return [...issues].sort(compareIssues);
}
