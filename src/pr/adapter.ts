/**
 * The forge boundary: pull requests, checks, and merge.
 *
 * Everything here is a side effect the orchestrator owns. The worker never
 * holds a credential that can reach any of it.
 */

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "skipped"
  | "cancelled"
  | "timed_out"
  | "pending"
  | "not_scheduled";

export interface RemoteCheck {
  readonly name: string;
  readonly appId?: string | undefined;
  readonly conclusion: CheckConclusion;
  readonly headSha: string;
  readonly completedAt?: string | undefined;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly draft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly mergeSha?: string | undefined;
}

export interface BranchProtection {
  readonly requiredChecks: readonly string[];
  readonly requiresApproval: boolean;
  readonly requiresConversationResolution: boolean;
  readonly usesMergeQueue: boolean;
  /** True when the rules could not be read (commonly: no admin permission). */
  readonly unreadable: boolean;
}

export interface MergeabilitySignal {
  /** GitHub's own verdict; authoritative over any local mirror of the rules. */
  readonly state: "clean" | "blocked" | "behind" | "unstable" | "dirty" | "draft" | "unknown";
  readonly mergeable: boolean;
}

export interface ForgeAdapter {
  readonly name: string;

  push(input: { repo: string; branch: string; workspacePath: string }): Promise<void>;

  openPullRequest(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequest>;

  getPullRequest(input: { repo: string; number: number }): Promise<PullRequest | undefined>;

  markReadyForReview(input: { repo: string; number: number }): Promise<void>;

  listChecks(input: { repo: string; ref: string }): Promise<RemoteCheck[]>;

  getBranchProtection(input: { repo: string; branch: string }): Promise<BranchProtection>;

  getMergeability(input: { repo: string; number: number }): Promise<MergeabilitySignal>;

  merge(input: {
    repo: string;
    number: number;
    method: "squash" | "merge" | "rebase";
    /** GitHub rejects the merge atomically if the PR head changed. */
    expectedHeadSha: string;
  }): Promise<{ mergeSha: string }>;

  /**
   * Can this credential edit branch protection?
   *
   * A negative capability test. If the merge credential can rewrite the rules
   * that constrain it, "zero protection-bypassing merges" is unverifiable, so
   * merge modes stay locked until this returns false.
   */
  canWriteBranchProtection(input: { repo: string; branch: string }): Promise<boolean>;
}

export class ForgeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ForgeError";
    this.retryable = retryable;
  }
}
