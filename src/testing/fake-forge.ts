import type {
  BranchProtection,
  ForgeAdapter,
  MergeabilitySignal,
  PullRequest,
  RemoteCheck,
} from "../pr/adapter.js";
import { ForgeError } from "../pr/adapter.js";
import { git, tryGit } from "../platform/git.js";

export interface FakeForgeOptions {
  readonly requiredChecks?: readonly string[] | undefined;
  readonly checks?: readonly RemoteCheck[] | undefined;
  readonly requiresApproval?: boolean | undefined;
  readonly usesMergeQueue?: boolean | undefined;
  readonly protectionUnreadable?: boolean | undefined;
  readonly requiresConversationResolution?: boolean | undefined;
  readonly mergeability?: MergeabilitySignal | undefined;
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
  #pushedHeads = new Map<string, string>();
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
    const branchKey = `${input.repo}#${input.branch}`;

    // The production forge reports the actual pushed commit as the PR head.
    // Preserve that identity in the fake too, so tests cannot pass with a
    // synthetic SHA that would fail the production exact-candidate gate.
    let head: string;
    try {
      head = await git(input.workspacePath, ["rev-parse", "HEAD"], { timeoutMs: 30_000 });
      if (head === "") {
        throw new Error("git rev-parse returned an empty commit id");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ForgeError(`fake forge could not resolve the pushed HEAD: ${detail}`, false);
    }

    // Actually push. Recording the call and doing nothing made the fake MORE
    // permissive than the real adapter: anything depending on the branch
    // existing afterwards passed here and failed against a real forge. A
    // stacked layer depends on exactly that, because it clones the branch the
    // layer below pushed.
    const pushed = await tryGit(
      input.workspacePath,
      [
        "push",
        "--quiet",
        "--no-verify",
        "origin",
        `HEAD:refs/heads/${input.branch}`,
      ],
      { timeoutMs: 30_000 },
    );
    if (!pushed.ok) {
      const detail = pushed.stderr.trim() || `git exited ${String(pushed.code)}`;
      throw new ForgeError(
        `fake forge push failed: ${detail}`,
        /timed out|network|503|502/iu.test(detail),
      );
    }

    // Publish success only after Git confirmed the mutation. A failed or
    // ambiguous subprocess result must not leave evidence that the branch or
    // its exact head exists remotely.
    this.#pushed.add(branchKey);
    this.#pushedHeads.set(branchKey, head);
    for (const [number, pr] of this.#prs) {
      if (pr.url.endsWith(input.branch)) {
        this.#prs.set(number, { ...pr, headSha: head });
      }
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
    const branchKey = `${input.repo}#${input.branch}`;
    const pushedHead = this.#pushedHeads.get(branchKey);
    if (!this.#pushed.has(branchKey) || pushedHead === undefined) {
      throw new ForgeError(
        `cannot open a pull request before ${input.branch} is confirmed on the remote`,
        false,
      );
    }

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
      headSha: pushedHead,
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
    return (this.#opts.checks ?? []).map((check) =>
      check.headSha === "$ref" ? { ...check, headSha: input.ref } : check,
    );
  }

  async getBranchProtection(input: { repo: string; branch: string }): Promise<BranchProtection> {
    this.calls.push({ op: "getBranchProtection", args: input });
    return {
      requiredChecks: this.#opts.requiredChecks ?? [],
      requiresApproval: this.#opts.requiresApproval ?? false,
      requiresConversationResolution: this.#opts.requiresConversationResolution ?? false,
      usesMergeQueue: this.#opts.usesMergeQueue ?? false,
      unreadable: this.#opts.protectionUnreadable ?? false,
    };
  }

  async getMergeability(input: { repo: string; number: number }): Promise<MergeabilitySignal> {
    if (this.#opts.mergeability !== undefined) return this.#opts.mergeability;
    const pr = this.#prs.get(input.number);
    if (pr === undefined) return { state: "unknown", mergeable: false };
    if (pr.draft) return { state: "draft", mergeable: false };
    return { state: "clean", mergeable: true };
  }

  async merge(input: {
    repo: string;
    number: number;
    method: "squash" | "merge" | "rebase";
    expectedHeadSha: string;
  }): Promise<{ mergeSha: string }> {
    this.calls.push({ op: "merge", args: input });
    const pr = this.#prs.get(input.number);
    if (pr === undefined) throw new ForgeError(`no such pull request ${input.number}`);
    if (pr.headSha !== input.expectedHeadSha) {
      throw new ForgeError(
        `pull request head changed from ${input.expectedHeadSha} to ${pr.headSha}`,
      );
    }
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
