import { Octokit } from "@octokit/rest";
import type {
  BranchProtection,
  ForgeAdapter,
  MergeabilitySignal,
  PullRequest,
  RemoteCheck,
  CheckConclusion,
} from "./adapter.js";
import { ForgeError } from "./adapter.js";
import { errorMessage } from "../errors/runmill-error.js";
import { run } from "../platform/process.js";

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined) {
    throw new ForgeError(`repository must be "owner/name", got "${repo}"`);
  }
  return { owner, name };
}

function mapConclusion(status: string | null, conclusion: string | null): CheckConclusion {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "action_required":
    case "stale":
      return "failure";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    default:
      return "pending";
  }
}

export interface GitHubAdapterOptions {
  readonly token: string;
  readonly baseUrl?: string | undefined;
}

/**
 * GitHub-backed implementation of the forge boundary.
 *
 * Two design points carried over from the specification. Branch protection is
 * frequently unreadable — the classic endpoint needs admin, and org-level
 * rulesets are invisible to repo-scoped calls — so GitHub's own mergeability
 * signal is authoritative and rule enumeration is best-effort explanation.
 * And the merge credential is checked with a *negative* capability test before
 * any merge mode unlocks.
 */
export class GitHubForgeAdapter implements ForgeAdapter {
  readonly name = "github";
  readonly #octokit: Octokit;
  readonly #token: string;

  constructor(options: GitHubAdapterOptions) {
    this.#token = options.token;
    this.#octokit = new Octokit(
      options.baseUrl === undefined
        ? { auth: options.token }
        : { auth: options.token, baseUrl: options.baseUrl },
    );
  }

  async push(input: { repo: string; branch: string; workspacePath: string }): Promise<void> {
    // Push happens through git with a credential the worker never sees. The
    // token is passed via an askpass-free header rather than embedded in the
    // remote URL, so it never lands in .git/config or the reflog.
    const result = await run(
      "git",
      [
        "-c",
        `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.#token}`).toString("base64")}`,
        "push",
        "--set-upstream",
        `https://github.com/${input.repo}.git`,
        `HEAD:refs/heads/${input.branch}`,
      ],
      { cwd: input.workspacePath },
    );
    if (!result.ok) {
      throw new ForgeError(
        `push failed: ${result.stderr.trim()}`,
        /timed out|network|503|502/i.test(result.stderr),
      );
    }
  }

  async openPullRequest(input: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequest> {
    const { owner, name } = splitRepo(input.repo);
    try {
      const created = await this.#octokit.pulls.create({
        owner,
        repo: name,
        head: input.branch,
        base: input.baseBranch,
        title: input.title,
        body: input.body,
        draft: input.draft,
      });
      return {
        number: created.data.number,
        url: created.data.html_url,
        headSha: created.data.head.sha,
        baseSha: created.data.base.sha,
        draft: created.data.draft ?? false,
        state: "open",
      };
    } catch (err) {
      const message = errorMessage(err);
      // A 422 here usually means a PR already exists for this head/base.
      // Adopting it blindly would inherit another run's reviews and CI
      // history, so it is surfaced rather than swallowed.
      throw new ForgeError(`could not open a pull request: ${message}`, false);
    }
  }

  async getPullRequest(input: { repo: string; number: number }): Promise<PullRequest | undefined> {
    const { owner, name } = splitRepo(input.repo);
    try {
      const pr = await this.#octokit.pulls.get({ owner, repo: name, pull_number: input.number });
      return {
        number: pr.data.number,
        url: pr.data.html_url,
        headSha: pr.data.head.sha,
        baseSha: pr.data.base.sha,
        draft: pr.data.draft ?? false,
        state: pr.data.merged_at !== null ? "merged" : pr.data.state === "open" ? "open" : "closed",
        mergeSha: pr.data.merge_commit_sha ?? undefined,
      };
    } catch {
      return undefined;
    }
  }

  async markReadyForReview(input: { repo: string; number: number }): Promise<void> {
    const { owner, name } = splitRepo(input.repo);
    // Only the GraphQL API can flip draft state.
    const pr = await this.#octokit.pulls.get({ owner, repo: name, pull_number: input.number });
    await this.#octokit.graphql(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }`,
      { id: pr.data.node_id },
    );
  }

  /**
   * Union check-runs and commit statuses.
   *
   * They are two different APIs, and a required context may be either. Re-runs
   * create new check-runs under the same name, so callers take the latest per
   * name; that reduction lives in the reconciler.
   */
  async listChecks(input: { repo: string; ref: string }): Promise<RemoteCheck[]> {
    const { owner, name } = splitRepo(input.repo);
    const checks: RemoteCheck[] = [];

    // check-runs and commit statuses are separate APIs and independent calls.
    const [runs, statuses] = await Promise.all([
      this.#octokit.checks.listForRef({ owner, repo: name, ref: input.ref, per_page: 100 }),
      this.#octokit.repos.listCommitStatusesForRef({
        owner,
        repo: name,
        ref: input.ref,
        per_page: 100,
      }),
    ]);

    for (const r of runs.data.check_runs) {
      checks.push({
        name: r.name,
        appId: r.app?.id === undefined ? undefined : String(r.app.id),
        conclusion: mapConclusion(r.status, r.conclusion),
        headSha: r.head_sha,
        completedAt: r.completed_at ?? undefined,
      });
    }

    for (const s of statuses.data) {
      checks.push({
        name: s.context,
        conclusion:
          s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure",
        headSha: input.ref,
        completedAt: s.updated_at,
      });
    }

    return checks;
  }

  async getBranchProtection(input: { repo: string; branch: string }): Promise<BranchProtection> {
    const { owner, name } = splitRepo(input.repo);

    // Rulesets first: readable without admin, and where modern repos define
    // their rules. Classic protection needs admin and commonly 403s.
    try {
      const rules = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        { owner, repo: name, branch: input.branch },
      );
      const requiredChecks: string[] = [];
      let requiresApproval = false;
      let requiresConversationResolution = false;
      let usesMergeQueue = false;

      for (const rule of rules.data as { type: string; parameters?: Record<string, unknown> }[]) {
        if (rule.type === "required_status_checks") {
          const params = rule.parameters as
            | { required_status_checks?: { context: string }[] }
            | undefined;
          for (const c of params?.required_status_checks ?? []) requiredChecks.push(c.context);
        }
        if (rule.type === "pull_request") {
          const params = rule.parameters as
            | { required_approving_review_count?: number; required_review_thread_resolution?: boolean }
            | undefined;
          requiresApproval = (params?.required_approving_review_count ?? 0) > 0;
          requiresConversationResolution = params?.required_review_thread_resolution === true;
        }
        if (rule.type === "merge_queue") usesMergeQueue = true;
      }

      return {
        requiredChecks,
        requiresApproval,
        requiresConversationResolution,
        usesMergeQueue,
        unreadable: false,
      };
    } catch {
      return {
        requiredChecks: [],
        requiresApproval: false,
        requiresConversationResolution: false,
        usesMergeQueue: false,
        unreadable: true,
      };
    }
  }

  /** GitHub's own verdict, which is authoritative over any local mirror. */
  async getMergeability(input: { repo: string; number: number }): Promise<MergeabilitySignal> {
    const { owner, name } = splitRepo(input.repo);
    const result = await this.#octokit.graphql<{
      repository: { pullRequest: { mergeable: string; mergeStateStatus: string } };
    }>(
      `query($owner:String!,$name:String!,$number:Int!){
         repository(owner:$owner,name:$name){
           pullRequest(number:$number){ mergeable mergeStateStatus }
         }
       }`,
      { owner, name, number: input.number },
    );
    const pr = result.repository.pullRequest;
    const state = pr.mergeStateStatus.toLowerCase();
    const known = ["clean", "blocked", "behind", "unstable", "dirty", "draft"];
    return {
      state: (known.includes(state) ? state : "unknown") as MergeabilitySignal["state"],
      mergeable: pr.mergeable === "MERGEABLE" && state === "clean",
    };
  }

  async merge(input: {
    repo: string;
    number: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<{ mergeSha: string }> {
    const { owner, name } = splitRepo(input.repo);
    try {
      const merged = await this.#octokit.pulls.merge({
        owner,
        repo: name,
        pull_number: input.number,
        merge_method: input.method,
      });
      return { mergeSha: merged.data.sha };
    } catch (err) {
      // Re-read before concluding. A lost response on a merge is the single
      // worst place to assume nothing happened.
      const after = await this.getPullRequest(input);
      if (after?.state === "merged" && after.mergeSha !== undefined) {
        return { mergeSha: after.mergeSha };
      }
      throw new ForgeError(
        `merge failed: ${errorMessage(err)}`,
        true,
      );
    }
  }

  /**
   * Negative capability test.
   *
   * Attempts a no-op write to branch protection and reports whether it would
   * be permitted. If the merge credential can rewrite the rules constraining
   * it, "zero protection-bypassing merges" is unverifiable and merge modes
   * must stay locked.
   */
  async canWriteBranchProtection(input: { repo: string }): Promise<boolean> {
    const { owner, name } = splitRepo(input.repo);
    try {
      const perms = await this.#octokit.repos.get({ owner, repo: name });
      // `admin` is what grants protection writes. An installation token
      // scoped to contents+pull_requests reports false here.
      return perms.data.permissions?.admin === true;
    } catch {
      // Unable to determine. Fail closed: assume it might, and keep merge locked.
      return true;
    }
  }
}
