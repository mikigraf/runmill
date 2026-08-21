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
import { GitHubGitCredential } from "../platform/github-git-credential.js";

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
  readonly #gitCredential: GitHubGitCredential;

  constructor(options: GitHubAdapterOptions) {
    this.#gitCredential = new GitHubGitCredential(options);
    this.#octokit = new Octokit(
      options.baseUrl === undefined
        ? { auth: options.token }
        : { auth: options.token, baseUrl: options.baseUrl },
    );
  }

  async push(input: { repo: string; branch: string; workspacePath: string }): Promise<void> {
    // The token is present only in the environment of this short-lived Git
    // process and its private askpass child. It is never written to the helper,
    // command arguments, remote URL, repository config, or reflog.
    try {
      const result = await this.#gitCredential.tryGit(
        input.workspacePath,
        [
          "push",
          "--no-verify",
          this.#gitCredential.repositoryUrl(input.repo),
          `HEAD:refs/heads/${input.branch}`,
        ],
      );
      if (!result.ok) {
        const detail = result.stderr.trim();
        throw new ForgeError(
          `push failed: ${detail}`,
          /timed out|network|503|502/i.test(detail),
        );
      }
    } catch (err) {
      if (err instanceof ForgeError) throw err;
      const detail = this.#gitCredential.redact(errorMessage(err));
      throw new ForgeError(`push failed: ${detail}`, /timed out|network|503|502/i.test(detail));
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

    const requiredChecks: string[] = [];
    let requiresApproval = false;
    let requiresConversationResolution = false;
    let usesMergeQueue = false;

    // Rulesets: readable without admin, and where modern repositories define
    // their rules. An empty array here is a real answer -- "no rulesets" -- and
    // NOT an answer about classic branch protection, which is read separately
    // below. Treating it as the whole story reported every classically
    // protected branch as unprotected, which is the single answer that
    // silently unlocks the merge gate.
    try {
      const rules = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        { owner, repo: name, branch: input.branch },
      );

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
    } catch {
      // Rules could not be enumerated at all. Nothing below can make that safe.
      return {
        requiredChecks: [],
        requiresApproval: false,
        requiresConversationResolution: false,
        usesMergeQueue: false,
        unreadable: true,
      };
    }

    // Whether classic protection exists is readable WITHOUT admin, even though
    // its contents are not. That distinction is what keeps this honest: a
    // repository can be known to be protected while its rules stay opaque, and
    // "unknown" must never collapse into "none".
    let classicallyProtected: boolean;
    try {
      const branch = await this.#octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        owner,
        repo: name,
        branch: input.branch,
      });
      classicallyProtected = (branch.data as { protected?: boolean }).protected === true;
    } catch {
      return {
        requiredChecks: [],
        requiresApproval: false,
        requiresConversationResolution: false,
        usesMergeQueue: false,
        unreadable: true,
      };
    }

    if (!classicallyProtected) {
      return {
        requiredChecks,
        requiresApproval,
        requiresConversationResolution,
        usesMergeQueue,
        unreadable: false,
      };
    }

    try {
      const classic = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection",
        { owner, repo: name, branch: input.branch },
      );
      const data = classic.data as {
        required_status_checks?: { contexts?: string[]; checks?: { context: string }[] };
        required_pull_request_reviews?: { required_approving_review_count?: number } | null;
        required_conversation_resolution?: { enabled?: boolean };
      };

      // `contexts` is the legacy shape and `checks` the current one. GitHub
      // still returns both on most repositories, and either may be the only
      // one present, so both are read and the union taken.
      for (const context of data.required_status_checks?.contexts ?? []) {
        requiredChecks.push(context);
      }
      for (const check of data.required_status_checks?.checks ?? []) {
        requiredChecks.push(check.context);
      }
      if ((data.required_pull_request_reviews?.required_approving_review_count ?? 0) > 0) {
        requiresApproval = true;
      }
      if (data.required_conversation_resolution?.enabled === true) {
        requiresConversationResolution = true;
      }

      return {
        requiredChecks: [...new Set(requiredChecks)],
        requiresApproval,
        requiresConversationResolution,
        usesMergeQueue,
        unreadable: false,
      };
    } catch {
      // The branch says it is protected and the rules cannot be read: usually a
      // 403 from a token without admin. Fail closed rather than merging past a
      // gate whose contents are unknown.
      return {
        requiredChecks: [...new Set(requiredChecks)],
        requiresApproval,
        requiresConversationResolution,
        usesMergeQueue,
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
    expectedHeadSha: string;
  }): Promise<{ mergeSha: string }> {
    const { owner, name } = splitRepo(input.repo);
    try {
      const merged = await this.#octokit.pulls.merge({
        owner,
        repo: name,
        pull_number: input.number,
        merge_method: input.method,
        sha: input.expectedHeadSha,
      });
      return { mergeSha: merged.data.sha };
    } catch (err) {
      // Re-read before concluding. A lost response on a merge is the single
      // worst place to assume nothing happened.
      const after = await this.getPullRequest(input);
      if (
        after?.state === "merged" &&
        after.mergeSha !== undefined &&
        after.headSha === input.expectedHeadSha
      ) {
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
  async canWriteBranchProtection(input: { repo: string; branch: string }): Promise<boolean> {
    const { owner, name } = splitRepo(input.repo);

    // Ask the capability, not the role.
    //
    // `permissions.admin` describes the CALLER's role on the repository, not
    // what this token may do. On a repository you own it is true no matter how
    // the token is scoped, so a fine-grained PAT with Administration=No access
    // -- the documented way to satisfy this gate -- reported "can bypass" and
    // guarded-merge could never unlock. Confirmed against real GitHub: that
    // token receives 403 writing protection while admin reads true.
    //
    // Adding an empty set of required contexts is a write that changes
    // nothing: the response is the unchanged context list. It is the only
    // honest way to learn whether this credential could remove the rules it is
    // supposed to be unable to remove.
    try {
      await this.#octokit.request(
        "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
        { owner, repo: name, branch: input.branch, contexts: [] },
      );
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 403) return false;
      // Anything else is inconclusive: no protection configured, a moved
      // repository, an outage. Fall back to the role, which fails closed.
    }

    try {
      const perms = await this.#octokit.repos.get({ owner, repo: name });
      return perms.data.permissions?.admin === true;
    } catch {
      // Unable to determine at all. Assume it might, and keep merge locked.
      return true;
    }
  }
}
