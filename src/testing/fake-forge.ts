import { execFileSync } from "node:child_process";
import type {
  BranchProtection,
  ForgeAdapter,
  MergeabilitySignal,
  PullRequest,
  RemoteCheck,
} from "../pr/adapter.js";
import { ForgeError } from "../pr/adapter.js";

export interface FakeForgeOptions {
  readonly requiredChecks?: readonly string[] | undefined;
  readonly checks?: readonly RemoteCheck[] | undefined;
  readonly requiresApproval?: boolean | undefined;
  readonly usesMergeQueue?: boolean | undefined;
  readonly protectionUnreadable?: boolean | undefined;
  /** When true, the merge credential can rewrite protection: merge stays locked. */
  readonly credentialCanWriteProtection?: boolean | undefined;
  /** Operations that apply, then throw as if the response was lost. */
  readonly applyThenTimeout?: ReadonlySet<string> | undefined;
}

/**
 * In-memory forge.
 *
 * Exists because CI reconciliation, crash recovery, and merge governance are
 * untestable against a live remote: you cannot ask GitHub to lose a merge
 * response on demand.
 */
export class FakeForgeAdapter implements ForgeAdapter {
  readonly name = "fake";
  #prs = new Map<number, PullRequest>();
  #nextNumber = 1;
  #opts: FakeForgeOptions;
  #pushed = new Set<string>();
  readonly calls: { op: string; args: unknown }[] = [];

  constructor(options: FakeForgeOptions = {}) {
    this.#opts = options;
  }

  setOptions(options: FakeForgeOptions): void {
    this.#opts = { ...this.#opts, ...options };
  }

  #maybeLoseResponse(op: string): void {
    if (this.#opts.applyThenTimeout?.has(op) === true) {
      throw new ForgeError(`${op} applied remotely, then the response was lost`, true);
    }
  }

  async push(input: { repo: string; branch: string; workspacePath: string }): Promise<void> {
    this.calls.push({ op: "push", args: input });
    this.#pushed.add(`${input.repo}#${input.branch}`);

    // Actually push. Recording the call and doing nothing made the fake MORE
    // permissive than the real adapter: anything depending on the branch
    // existing afterwards passed here and failed against a real forge. A
    // stacked layer depends on exactly that, because it clones the branch the
    // layer below pushed.
    try {
      execFileSync("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${input.branch}`], {
        cwd: input.workspacePath,
        stdio: "ignore",
      });
    } catch {
      // The workspace may have no reachable origin in unit tests that never
      // built one. The recorded call is still the assertion surface there.
    }
    this.#maybeLoseResponse("push");
  }

  async openPullRequest(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequest> {
    this.calls.push({ op: "openPullRequest", args: input });

    // GitHub rejects a duplicate PR for the same head/base with 422. Modelled
    // so the orchestrator's idempotency path is exercised rather than assumed.
    const existing = [...this.#prs.values()].find((pr) => pr.url.endsWith(input.branch));
    if (existing !== undefined) {
      throw new ForgeError(`a pull request already exists for ${input.branch} (422)`, false);
    }

    const number = this.#nextNumber;
    this.#nextNumber += 1;
    const pr: PullRequest = {
      number,
      url: `https://fake/${input.repo}/pull/${number}/${input.branch}`,
      headSha: `head-${number}`,
      baseSha: `base-${number}`,
      draft: input.draft,
      state: "open",
    };
    this.#prs.set(number, pr);
    this.#maybeLoseResponse("openPullRequest");
    return pr;
  }

  async getPullRequest(input: { repo: string; number: number }): Promise<PullRequest | undefined> {
    return this.#prs.get(input.number);
  }

  async markReadyForReview(input: { repo: string; number: number }): Promise<void> {
    this.calls.push({ op: "markReadyForReview", args: input });
    const pr = this.#prs.get(input.number);
    if (pr !== undefined) this.#prs.set(input.number, { ...pr, draft: false });
  }

  async listChecks(input: { repo: string; ref: string }): Promise<RemoteCheck[]> {
    this.calls.push({ op: "listChecks", args: input });
    return [...(this.#opts.checks ?? [])];
  }

  async getBranchProtection(input: { repo: string; branch: string }): Promise<BranchProtection> {
    this.calls.push({ op: "getBranchProtection", args: input });
    return {
      requiredChecks: this.#opts.requiredChecks ?? [],
      requiresApproval: this.#opts.requiresApproval ?? false,
      requiresConversationResolution: false,
      usesMergeQueue: this.#opts.usesMergeQueue ?? false,
      unreadable: this.#opts.protectionUnreadable ?? false,
    };
  }

  async getMergeability(input: { repo: string; number: number }): Promise<MergeabilitySignal> {
    const pr = this.#prs.get(input.number);
    if (pr === undefined) return { state: "unknown", mergeable: false };
    if (pr.draft) return { state: "draft", mergeable: false };
    return { state: "clean", mergeable: true };
  }

  async merge(input: {
    repo: string;
    number: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<{ mergeSha: string }> {
    this.calls.push({ op: "merge", args: input });
    const pr = this.#prs.get(input.number);
    if (pr === undefined) throw new ForgeError(`no such pull request ${input.number}`);
    const mergeSha = `merge-${input.number}`;
    this.#prs.set(input.number, { ...pr, state: "merged", mergeSha });
    this.#maybeLoseResponse("merge");
    return { mergeSha };
  }

  async canWriteBranchProtection(): Promise<boolean> {
    // Mirrors the real adapter's unknown-default. GitHubForgeAdapter returns
    // true when it cannot determine the answer, so a fake that defaults to
    // false would exercise a branch the production default cannot reach.
    return this.#opts.credentialCanWriteProtection ?? true;
  }

  // -- test affordances ---------------------------------------------------

  wasPushed(repo: string, branch: string): boolean {
    return this.#pushed.has(`${repo}#${branch}`);
  }

  openPullRequests(): PullRequest[] {
    return [...this.#prs.values()];
  }
}
