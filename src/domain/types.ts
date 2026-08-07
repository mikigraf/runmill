/**
 * Core domain types shared across the control plane.
 *
 * These are backlog-provider agnostic on purpose: `BacklogIssue` is what a
 * `BacklogAdapter` produces, whether the source is Linear or GitHub Issues.
 */

/**
 * Backlog priority, using Linear's encoding.
 *
 *   0 = no priority   <-- NOT "most urgent". This is the trap.
 *   1 = urgent
 *   2 = high
 *   3 = medium
 *   4 = low
 *
 * A naive ascending sort puts unprioritized issues FIRST. See
 * {@link prioritySortKey}.
 */
export type BacklogPriority = 0 | 1 | 2 | 3 | 4;

/** Human labels for the priority encoding above. One table, three readers. */
export const PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

export interface BacklogIssue {
  /** Human-facing stable identifier, e.g. "ENG-123". Final tie-breaker. */
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly priority: BacklogPriority;
  readonly labels: readonly string[];
  readonly state: string;
  readonly teamKey: string;
  readonly projectName?: string | undefined;
  readonly estimate?: number | undefined;
  readonly assigneeId?: string | undefined;
  readonly assigneeIsHuman?: boolean | undefined;
  readonly dueDate?: string | undefined;
  /** Manual within-priority rank, when the provider exposes one. */
  readonly manualRank?: number | undefined;
  readonly createdAt: string;
  readonly canceled: boolean;
  readonly completed: boolean;
  /** Identifiers this issue is blocked by. */
  readonly blockedBy: readonly string[];
}

export interface RepositoryTarget {
  readonly repo: string;
  readonly baseBranch: string;
}

export type AgentRole =
  | "implementer"
  | "local-reviewer"
  | "fixer"
  | "pr-reviewer"
  | "retrospective";

export type RiskTier = "low" | "medium" | "high" | "critical";

export type AutonomyMode = "observe" | "pr-only" | "guarded-merge" | "continuous";
