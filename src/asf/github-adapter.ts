import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { GitHubGitCredential } from "../platform/github-git-credential.js";
import { git } from "../platform/git.js";
import { sha256Digest } from "./canonical-json.js";
import type {
  AsfGitHubEffectAdapter,
  BaseProtectionObservation,
  BranchObservation,
  PullRequestObservation,
} from "./github-effects.js";
import type {
  GitHubCommitFileObservation,
  GitHubCommitReachabilityObservation,
  GitHubRepositoryAdmissionAdapter,
} from "./repository-admission.js";

const MAX_PULL_REQUEST_OBSERVATIONS = 10_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
const MAX_REPOSITORY_POLICY_BYTES = 1_048_576;

function splitRepository(repository: string): { readonly owner: string; readonly repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`GitHub repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
  return { owner: match[1], repo: match[2] };
}

function branchName(ref: string): string {
  if (!ref.startsWith("refs/heads/")) {
    throw new Error(`GitHub branch ref must start with refs/heads/: ${JSON.stringify(ref)}`);
  }
  const name = ref.slice("refs/heads/".length);
  if (
    name === "" ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(name)
  ) {
    throw new Error(`invalid GitHub branch ref ${JSON.stringify(ref)}`);
  }
  return name;
}

function repositoryPath(path: string): string {
  if (
    path === "" ||
    path.length > 4_096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`GitHub repository path must be normalized and relative: ${JSON.stringify(path)}`);
  }
  return path;
}

function gitSha(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error(`${label} must be a 40-hex Git commit`);
  }
  return normalized;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function unknownDigest(kind: "branch" | "pull-request", status: number | undefined) {
  return sha256Digest({
    schema: `runmill.github-${kind}-observation/v1`,
    state: "unknown",
    status: status ?? null,
  });
}

function unknownBaseProtectionDigest(status: number | undefined) {
  return sha256Digest({
    schema: "runmill.github-base-protection-observation/v1",
    state: "unknown",
    status: status ?? null,
  });
}

function normalizedRequiredChecks(values: readonly unknown[]): string[] {
  const checks = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("GitHub protection contains an invalid required-check context");
    }
    checks.add(value);
  }
  if (checks.size > 10_000) {
    throw new Error("GitHub protection exceeds the bounded required-check set");
  }
  return [...checks].sort();
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("GitHub effect was cancelled");
  }
}

function normalizedMarker(body: string | null, expected: string): string {
  if (body?.includes(expected) === true) return expected;
  const discovered = /<!--\s*(runmill:v1:[^-\r\n]+)\s*-->/u.exec(body ?? "")?.[1];
  return discovered ?? "<missing>";
}

export interface ProductionGitHubEffectsAdapterOptions {
  readonly token: string;
  readonly baseUrl?: string | undefined;
}

/** Host-side GitHub adapter used only by the fenced effect controller. */
export class ProductionGitHubEffectsAdapter
  implements AsfGitHubEffectAdapter, GitHubRepositoryAdmissionAdapter
{
  readonly #octokit: Octokit;
  readonly #gitCredential: GitHubGitCredential;

  constructor(options: ProductionGitHubEffectsAdapterOptions) {
    if (options.token === "") throw new Error("GitHub controller token must not be empty");
    this.#gitCredential = new GitHubGitCredential(options);
    this.#octokit = new Octokit(
      options.baseUrl === undefined
        ? { auth: options.token }
        : { auth: options.token, baseUrl: options.baseUrl },
    );
  }

  async observeBranch(input: {
    readonly repository: string;
    readonly ref: string;
  }): Promise<BranchObservation> {
    const { owner, repo } = splitRepository(input.repository);
    const name = branchName(input.ref);
    try {
      const response = await this.#octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${name}`,
      });
      const sha = response.data.object.sha.toLowerCase();
      const evidence = {
        schema: "runmill.github-branch-observation/v1",
        repository: input.repository.toLowerCase(),
        ref: input.ref,
        state: "present" as const,
        sha,
      };
      return { state: "present", sha, evidence_digest: sha256Digest(evidence) };
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        const evidence = {
          schema: "runmill.github-branch-observation/v1",
          repository: input.repository.toLowerCase(),
          ref: input.ref,
          state: "absent" as const,
        };
        return { state: "absent", evidence_digest: sha256Digest(evidence) };
      }
      return {
        state: "unknown",
        reason: `GitHub branch observation failed${status === undefined ? "" : ` with status ${status}`}`,
        evidence_digest: unknownDigest("branch", status),
      };
    }
  }

  async pushBranch(input: {
    readonly repository: string;
    readonly ref: string;
    readonly candidateSha: string;
    readonly expectedRemoteSha: string | null;
    readonly workspacePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    splitRepository(input.repository);
    branchName(input.ref);
    assertNotAborted(input.signal);
    const localHead = (await git(input.workspacePath, ["rev-parse", "HEAD"])).toLowerCase();
    if (localHead !== input.candidateSha) {
      throw new Error(
        `workspace HEAD ${localHead} does not match authorized candidate ${input.candidateSha}`,
      );
    }
    const lease = `--force-with-lease=${input.ref}:${input.expectedRemoteSha ?? ""}`;
    const result = await this.#gitCredential.tryGit(
      input.workspacePath,
      [
        "push",
        "--no-verify",
        lease,
        this.#gitCredential.repositoryUrl(input.repository),
        `HEAD:${input.ref}`,
      ],
      { timeoutMs: GIT_PUSH_TIMEOUT_MS },
    );
    assertNotAborted(input.signal);
    if (!result.ok) {
      throw new Error(`GitHub branch push failed: ${result.stderr.trim() || "git exited non-zero"}`);
    }
  }

  async observePullRequests(input: {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly marker: string;
  }): Promise<PullRequestObservation> {
    const { owner, repo } = splitRepository(input.repository);
    branchName(input.headRef);
    branchName(input.baseRef);
    try {
      const pullRequests: Extract<PullRequestObservation, { state: "present" }>["pull_requests"] = [];
      for await (const response of this.#octokit.paginate.iterator(
        this.#octokit.pulls.list,
        { owner, repo, state: "all", per_page: 100 },
      )) {
        for (const pullRequest of response.data) {
          const marker = normalizedMarker(pullRequest.body ?? null, input.marker);
          const qualifiedHead = `refs/heads/${pullRequest.head.ref}`;
          // Keep every possible collision: either the deterministic head or a
          // Runmill marker. The controller refuses duplicate/contradictory sets.
          if (qualifiedHead !== input.headRef && marker === "<missing>") continue;
          pullRequests.push({
            repository: input.repository,
            number: pullRequest.number,
            url: pullRequest.html_url,
            head_ref: qualifiedHead,
            base_ref: `refs/heads/${pullRequest.base.ref}`,
            head_sha: pullRequest.head.sha.toLowerCase(),
            marker,
            state: pullRequest.state === "open" ? "open" : "closed",
            draft: pullRequest.draft ?? false,
          });
          if (pullRequests.length > MAX_PULL_REQUEST_OBSERVATIONS) {
            return {
              state: "unknown",
              reason: "GitHub PR observation exceeded its complete bounded result set",
              evidence_digest: unknownDigest("pull-request", undefined),
            };
          }
        }
      }
      const normalized = [...pullRequests].sort((left, right) => left.number - right.number);
      const evidence = {
        schema: "runmill.github-pr-observation/v1",
        repository: input.repository.toLowerCase(),
        head_ref: input.headRef,
        base_ref: input.baseRef,
        marker: input.marker,
        pull_requests: normalized,
      };
      return normalized.length === 0
        ? { state: "absent", evidence_digest: sha256Digest(evidence) }
        : {
            state: "present",
            evidence_digest: sha256Digest(evidence),
            pull_requests: normalized,
          };
    } catch (error) {
      const status = errorStatus(error);
      return {
        state: "unknown",
        reason: `GitHub PR observation failed${status === undefined ? "" : ` with status ${status}`}`,
        evidence_digest: unknownDigest("pull-request", status),
      };
    }
  }

  /**
   * Observe the current base commit and all readable protection mechanisms.
   * A protected branch whose classic rules cannot be read is unknown, never an
   * empty protection set. The final delivery controller rejects unknown.
   */
  async observeBaseProtection(input: {
    readonly repository: string;
    readonly baseRef: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<BaseProtectionObservation> {
    const { owner, repo } = splitRepository(input.repository);
    const base = branchName(input.baseRef);
    try {
      assertNotAborted(input.signal);
      const rulesResponse = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        {
          owner,
          repo,
          branch: base,
          ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
        },
      );
      assertNotAborted(input.signal);
      const rawRules = rulesResponse.data as unknown;
      if (!Array.isArray(rawRules) || rawRules.length > 10_000) {
        throw new Error("GitHub ruleset response is malformed or exceeds its bound");
      }

      const branchResponse = await this.#octokit.repos.getBranch({
        owner,
        repo,
        branch: base,
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      });
      assertNotAborted(input.signal);
      const branchData = branchResponse.data as unknown as {
        readonly name?: unknown;
        readonly protected?: unknown;
        readonly commit?: { readonly sha?: unknown } | null;
      };
      if (
        branchData.name !== base ||
        typeof branchData.protected !== "boolean" ||
        branchData.commit === null ||
        typeof branchData.commit !== "object" ||
        typeof branchData.commit.sha !== "string" ||
        !/^[a-fA-F0-9]{40}$/u.test(branchData.commit.sha)
      ) {
        throw new Error("GitHub base-branch response is malformed or contradictory");
      }

      const requiredChecks: unknown[] = [];
      let requiresApproval = false;
      let requiresConversationResolution = false;
      let usesMergeQueue = false;
      for (const rawRule of rawRules) {
        if (rawRule === null || typeof rawRule !== "object") {
          throw new Error("GitHub ruleset contains a malformed rule");
        }
        const rule = rawRule as {
          readonly type?: unknown;
          readonly parameters?: {
            readonly required_status_checks?: readonly { readonly context?: unknown }[];
            readonly required_approving_review_count?: unknown;
            readonly required_review_thread_resolution?: unknown;
          } | null;
        };
        if (typeof rule.type !== "string") {
          throw new Error("GitHub ruleset contains a rule without a type");
        }
        if (rule.type === "required_status_checks") {
          const contexts = rule.parameters?.required_status_checks;
          if (!Array.isArray(contexts)) {
            throw new Error("GitHub required-status-check rule is malformed");
          }
          for (const context of contexts) {
            const rawContext: unknown = context;
            requiredChecks.push(
              rawContext !== null && typeof rawContext === "object"
                ? (rawContext as Record<string, unknown>)["context"]
                : undefined,
            );
          }
        } else if (rule.type === "pull_request") {
          const count = rule.parameters?.required_approving_review_count;
          if (count !== undefined) {
            if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
              throw new Error("GitHub pull-request protection rule is malformed");
            }
            requiresApproval ||= count > 0;
          }
          const resolution = rule.parameters?.required_review_thread_resolution;
          if (resolution !== undefined && typeof resolution !== "boolean") {
            throw new Error("GitHub conversation-resolution rule is malformed");
          }
          requiresConversationResolution ||= resolution === true;
        } else if (rule.type === "merge_queue") {
          usesMergeQueue = true;
        }
      }

      if (branchData.protected) {
        const classicResponse = await this.#octokit.request(
          "GET /repos/{owner}/{repo}/branches/{branch}/protection",
          {
            owner,
            repo,
            branch: base,
            ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
          },
        );
        assertNotAborted(input.signal);
        const classic = classicResponse.data as unknown as {
          readonly required_status_checks?: {
            readonly contexts?: readonly unknown[];
            readonly checks?: readonly { readonly context?: unknown }[];
          } | null;
          readonly required_pull_request_reviews?: {
            readonly required_approving_review_count?: unknown;
          } | null;
          readonly required_conversation_resolution?: {
            readonly enabled?: unknown;
          } | null;
        };
        const statusChecks = classic.required_status_checks;
        if (statusChecks !== undefined && statusChecks !== null) {
          if (
            statusChecks.contexts !== undefined &&
            !Array.isArray(statusChecks.contexts)
          ) {
            throw new Error("GitHub classic status-check contexts are malformed");
          }
          if (statusChecks.checks !== undefined && !Array.isArray(statusChecks.checks)) {
            throw new Error("GitHub classic status-check records are malformed");
          }
          requiredChecks.push(...(statusChecks.contexts ?? []));
          for (const check of statusChecks.checks ?? []) {
            const rawCheck: unknown = check;
            requiredChecks.push(
              rawCheck !== null && typeof rawCheck === "object"
                ? (rawCheck as Record<string, unknown>)["context"]
                : undefined,
            );
          }
        }
        const approvalCount =
          classic.required_pull_request_reviews?.required_approving_review_count;
        if (approvalCount !== undefined) {
          if (
            typeof approvalCount !== "number" ||
            !Number.isSafeInteger(approvalCount) ||
            approvalCount < 0
          ) {
            throw new Error("GitHub classic approval rule is malformed");
          }
          requiresApproval ||= approvalCount > 0;
        }
        const resolution = classic.required_conversation_resolution?.enabled;
        if (resolution !== undefined && typeof resolution !== "boolean") {
          throw new Error("GitHub classic conversation-resolution rule is malformed");
        }
        requiresConversationResolution ||= resolution === true;
      }

      const protection = {
        required_checks: normalizedRequiredChecks(requiredChecks),
        requires_approval: requiresApproval,
        requires_conversation_resolution: requiresConversationResolution,
        uses_merge_queue: usesMergeQueue,
      } as const;
      const protectionEvidence = {
        schema: "runmill.github-base-protection/v1",
        repository: input.repository.toLowerCase(),
        base_ref: input.baseRef,
        protection,
      } as const;
      const unsigned = {
        state: "present" as const,
        repository: input.repository.toLowerCase(),
        base_ref: input.baseRef,
        base_sha: branchData.commit.sha.toLowerCase(),
        protection_digest: sha256Digest(protectionEvidence),
        protection,
      };
      return {
        ...unsigned,
        evidence_digest: sha256Digest({
          schema: "runmill.github-base-protection-observation/v1",
          ...unsigned,
        }),
      };
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      const status = errorStatus(error);
      return {
        state: "unknown",
        reason:
          `GitHub base/protection observation failed` +
          (status === undefined ? "" : ` with status ${status}`),
        evidence_digest: unknownBaseProtectionDigest(status),
      };
    }
  }

  /** Prove that requestedBaseSha is an ancestor of the current configured base. */
  async observeCommitReachability(input: {
    readonly repository: string;
    readonly baseRef: string;
    readonly requestedBaseSha: string;
    readonly observedBaseSha: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<GitHubCommitReachabilityObservation> {
    const { owner, repo } = splitRepository(input.repository);
    branchName(input.baseRef);
    const requestedBaseSha = gitSha(input.requestedBaseSha, "requested base SHA");
    const observedBaseSha = gitSha(input.observedBaseSha, "observed base SHA");
    try {
      assertNotAborted(input.signal);
      const response = await this.#octokit.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${requestedBaseSha}...${observedBaseSha}`,
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      });
      assertNotAborted(input.signal);
      const data = response.data as unknown as {
        readonly status?: unknown;
        readonly base_commit?: { readonly sha?: unknown } | null;
        readonly merge_base_commit?: { readonly sha?: unknown } | null;
      };
      const status = data.status;
      const baseCommitSha = data.base_commit?.sha;
      const mergeBaseSha = data.merge_base_commit?.sha;
      if (
        (status !== "ahead" && status !== "behind" && status !== "diverged" && status !== "identical") ||
        typeof baseCommitSha !== "string" ||
        typeof mergeBaseSha !== "string" ||
        !/^[a-fA-F0-9]{40}$/u.test(baseCommitSha) ||
        !/^[a-fA-F0-9]{40}$/u.test(mergeBaseSha) ||
        baseCommitSha.toLowerCase() !== requestedBaseSha
      ) {
        throw new Error("GitHub commit comparison is malformed or contradicts the requested base");
      }
      const mergeBase = mergeBaseSha.toLowerCase();
      const comparisonStatus: "ahead" | "behind" | "diverged" | "identical" = status;
      const reachable =
        (comparisonStatus === "ahead" || comparisonStatus === "identical") &&
        mergeBase === requestedBaseSha;
      const unsigned = {
        schema: "runmill.github-commit-reachability-observation/v1" as const,
        state: reachable ? ("reachable" as const) : ("unreachable" as const),
        repository: input.repository.toLowerCase(),
        base_ref: input.baseRef,
        requested_base_sha: requestedBaseSha,
        observed_base_sha: observedBaseSha,
        comparison_status: comparisonStatus,
        merge_base_sha: mergeBase,
      };
      return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      const status = errorStatus(error);
      const unsigned = {
        schema: "runmill.github-commit-reachability-observation/v1" as const,
        state: "unknown" as const,
        repository: input.repository.toLowerCase(),
        base_ref: input.baseRef,
        requested_base_sha: requestedBaseSha,
        observed_base_sha: observedBaseSha,
        comparison_status: null,
        merge_base_sha: null,
        reason:
          `GitHub commit-reachability observation failed` +
          (status === undefined ? "" : ` with status ${status}`),
      };
      return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
    }
  }

  /** Read exact bytes from an immutable commit; never follows a mutable ref. */
  async observeFileAtCommit(input: {
    readonly repository: string;
    readonly commitSha: string;
    readonly path: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<GitHubCommitFileObservation> {
    const { owner, repo } = splitRepository(input.repository);
    const commitSha = gitSha(input.commitSha, "repository-policy commit SHA");
    const path = repositoryPath(input.path);
    try {
      assertNotAborted(input.signal);
      const response = await this.#octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: commitSha,
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      });
      assertNotAborted(input.signal);
      const raw = response.data as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("GitHub repository-policy response does not describe one file");
      }
      const data = raw as Record<string, unknown>;
      if (
        data["type"] !== "file" ||
        data["path"] !== path ||
        data["encoding"] !== "base64" ||
        typeof data["content"] !== "string" ||
        typeof data["sha"] !== "string" ||
        !/^[a-fA-F0-9]{40}$/u.test(data["sha"]) ||
        typeof data["size"] !== "number" ||
        !Number.isSafeInteger(data["size"]) ||
        data["size"] < 0 ||
        data["size"] > MAX_REPOSITORY_POLICY_BYTES
      ) {
        throw new Error("GitHub repository-policy response is malformed or exceeds 1 MiB");
      }
      const encoded = data["content"].replaceAll(/\s/gu, "");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length !== data["size"]) {
        throw new Error("GitHub repository-policy base64 or size is contradictory");
      }
      const blobSha = createHash("sha1")
        .update(`blob ${String(bytes.length)}\0`, "utf8")
        .update(bytes)
        .digest("hex");
      if (blobSha !== data["sha"].toLowerCase()) {
        throw new Error("GitHub repository-policy bytes do not match the reported blob id");
      }
      const unsigned = {
        schema: "runmill.github-commit-file-observation/v1" as const,
        state: "present" as const,
        repository: input.repository.toLowerCase(),
        commit_sha: commitSha,
        path,
        blob_sha: blobSha,
        size: bytes.length,
        bytes_base64: encoded,
        content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
      };
      return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      const status = errorStatus(error);
      if (status === 404) {
        const unsigned = {
          schema: "runmill.github-commit-file-observation/v1" as const,
          state: "absent" as const,
          repository: input.repository.toLowerCase(),
          commit_sha: commitSha,
          path,
        };
        return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
      }
      const unsigned = {
        schema: "runmill.github-commit-file-observation/v1" as const,
        state: "unknown" as const,
        repository: input.repository.toLowerCase(),
        commit_sha: commitSha,
        path,
        reason:
          `GitHub repository-policy observation failed` +
          (status === undefined ? "" : ` with status ${status}`),
      };
      return { ...unsigned, evidence_digest: sha256Digest(unsigned) };
    }
  }

  async createPullRequest(input: {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly candidateSha: string;
    readonly marker: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { owner, repo } = splitRepository(input.repository);
    const head = branchName(input.headRef);
    const base = branchName(input.baseRef);
    assertNotAborted(input.signal);
    if (!input.body.includes(input.marker)) {
      throw new Error("pull-request body must contain the exact durable correlation marker");
    }
    await this.#octokit.pulls.create({
      owner,
      repo,
      head,
      base,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    assertNotAborted(input.signal);
  }
}
