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
export function compareIssues(a: BacklogIssue, b: BacklogIssue): number {
  const byPriority = prioritySortKey(a.priority) - prioritySortKey(b.priority);
  if (byPriority !== 0) return byPriority;

  const byDueDate = dueDateSortKey(a) - dueDateSortKey(b);
  if (byDueDate !== 0 && Number.isFinite(byDueDate)) return byDueDate;
  if (dueDateSortKey(a) !== dueDateSortKey(b)) {
    return dueDateSortKey(a) === Number.POSITIVE_INFINITY ? 1 : -1;
  }

  const byRank = manualRankSortKey(a) - manualRankSortKey(b);
  if (byRank !== 0 && Number.isFinite(byRank)) return byRank;
  if (manualRankSortKey(a) !== manualRankSortKey(b)) {
    return manualRankSortKey(a) === Number.POSITIVE_INFINITY ? 1 : -1;
  }

  const byCreatedAt = createdAtSortKey(a) - createdAtSortKey(b);
  if (byCreatedAt !== 0 && Number.isFinite(byCreatedAt)) return byCreatedAt;

  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

/** Returns a new ordered array. Never mutates the input. */
export function orderIssues(issues: readonly BacklogIssue[]): BacklogIssue[] {
  return [...issues].sort(compareIssues);
}
