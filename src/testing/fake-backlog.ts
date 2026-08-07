import type { BacklogAdapter } from "../backlog/adapter.js";
import { AmbiguousMutationError, BacklogRateLimitError } from "../backlog/adapter.js";
import type { BacklogIssue } from "../domain/types.js";

export interface FaultInjection {
  /**
   * Apply the mutation, then throw as if the response was lost.
   *
   * This is the most important fault mode in the system: "never assume failure
   * means no side effect". Recovery must reconcile against the remote rather
   * than retrying blindly.
   */
  readonly applyThenTimeout?: ReadonlySet<string> | undefined;
  /** Operations that fail before applying anything. */
  readonly failBeforeApply?: ReadonlySet<string> | undefined;
  readonly rateLimitOps?: ReadonlySet<string> | undefined;
  readonly rateLimitRetryAfterMs?: number | undefined;
}

/**
 * Deterministic in-memory backlog.
 *
 * Ships in the package because six functional requirements are untestable
 * without programmable failure injection against the backlog: exclusive claim,
 * snapshot consistency, event survival, CI reconciliation, crash recovery, and
 * the continuous queue.
 */
export class FakeBacklogAdapter implements BacklogAdapter {
  readonly name = "fake";
  #issues = new Map<string, BacklogIssue>();
  #comments: { identifier: string; body: string; commentId: string }[] = [];
  #faults: FaultInjection;
  #commentSeq = 0;
  readonly calls: { op: string; args: unknown }[] = [];

  constructor(issues: readonly BacklogIssue[] = [], faults: FaultInjection = {}) {
    for (const issue of issues) this.#issues.set(issue.identifier, issue);
    this.#faults = faults;
  }

  setFaults(faults: FaultInjection): void {
    this.#faults = faults;
  }

  #checkPreFault(op: string): void {
    if (this.#faults.rateLimitOps?.has(op) === true) {
      throw new BacklogRateLimitError(this.#faults.rateLimitRetryAfterMs ?? 1_000);
    }
    if (this.#faults.failBeforeApply?.has(op) === true) {
      throw new Error(`fake backlog: ${op} failed before applying`);
    }
  }

  #checkPostFault(op: string): void {
    if (this.#faults.applyThenTimeout?.has(op) === true) {
      throw new AmbiguousMutationError(
        op,
        `fake backlog: ${op} applied remotely, then the response was lost`,
      );
    }
  }

  async listCandidates(input: { team: string; states: readonly string[] }): Promise<BacklogIssue[]> {
    this.calls.push({ op: "listCandidates", args: input });
    this.#checkPreFault("listCandidates");
    return [...this.#issues.values()].filter(
      (i) => i.teamKey === input.team && input.states.includes(i.state),
    );
  }

  async getIssue(identifier: string): Promise<BacklogIssue | undefined> {
    this.calls.push({ op: "getIssue", args: identifier });
    this.#checkPreFault("getIssue");
    return this.#issues.get(identifier);
  }

  async transitionState(input: { identifier: string; toState: string }): Promise<void> {
    this.calls.push({ op: "transitionState", args: input });
    this.#checkPreFault("transitionState");
    const issue = this.#issues.get(input.identifier);
    if (issue === undefined) throw new Error(`fake backlog: unknown issue ${input.identifier}`);
    this.#issues.set(input.identifier, { ...issue, state: input.toState });
    this.#checkPostFault("transitionState");
  }

  async assign(input: { identifier: string; assignee: string | null }): Promise<void> {
    this.calls.push({ op: "assign", args: input });
    this.#checkPreFault("assign");
    const issue = this.#issues.get(input.identifier);
    if (issue === undefined) throw new Error(`fake backlog: unknown issue ${input.identifier}`);
    this.#issues.set(input.identifier, {
      ...issue,
      assigneeId: input.assignee ?? undefined,
      assigneeIsHuman: false,
    });
    this.#checkPostFault("assign");
  }

  async comment(input: { identifier: string; body: string }): Promise<{ commentId: string }> {
    this.calls.push({ op: "comment", args: input });
    this.#checkPreFault("comment");
    this.#commentSeq += 1;
    const commentId = `c${this.#commentSeq}`;
    this.#comments.push({ ...input, commentId });
    this.#checkPostFault("comment");
    return { commentId };
  }


  // -- test affordances ---------------------------------------------------

  /** Simulate a human editing the issue mid-run. */
  editIssue(identifier: string, patch: Partial<BacklogIssue>): void {
    const issue = this.#issues.get(identifier);
    if (issue === undefined) throw new Error(`fake backlog: unknown issue ${identifier}`);
    this.#issues.set(identifier, { ...issue, ...patch });
  }

  peek(identifier: string): BacklogIssue | undefined {
    return this.#issues.get(identifier);
  }

  comments(identifier: string): { body: string; commentId: string }[] {
    return this.#comments.filter((c) => c.identifier === identifier);
  }
}
