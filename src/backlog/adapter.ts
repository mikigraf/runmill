import type { BacklogIssue } from "../domain/types.js";

/**
 * The backlog boundary.
 *
 * Linear is implementation #1, not the product surface. Everything above this
 * interface is source-agnostic, so adding GitHub Issues is a new file rather
 * than a migration.
 *
 * Adapters are read-and-mutate only. They never decide *which* issue to work
 * on, never claim ownership (the git-ref lease does that), and never merge.
 */
export interface BacklogAdapter {
  readonly name: string;

  /** Bounded candidate fetch. Ordering and eligibility happen above this. */
  listCandidates(input: { team: string; states: readonly string[] }): Promise<BacklogIssue[]>;

  getIssue(identifier: string): Promise<BacklogIssue | undefined>;

  /** Move an issue to a workflow state. Idempotent by target state. */
  transitionState(input: { identifier: string; toState: string }): Promise<void>;

  assign(input: { identifier: string; assignee: string | null }): Promise<void>;

  /** Human-visible status only. Never authoritative for ownership. */
  comment(input: { identifier: string; body: string }): Promise<{ commentId: string }>;
}

/** Thrown when the remote applied a mutation but the response was lost. */
export class AmbiguousMutationError extends Error {
  readonly code = "RM-BACKLOG-001";
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "AmbiguousMutationError";
    this.operation = operation;
  }
}

/**
 * The adapter failed while resolving read-only inputs, before calling a
 * mutation API. The orchestrator may close that outbox intent as not applied;
 * ordinary errors remain ambiguous and must still block recovery.
 */
export class BacklogMutationNotStartedError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BacklogMutationNotStartedError";
    this.operation = operation;
  }
}

export class BacklogRateLimitError extends Error {
  readonly code = "RM-BACKLOG-002";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`backlog rate limited; retry after ${retryAfterMs}ms`);
    this.name = "BacklogRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
