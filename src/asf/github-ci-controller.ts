import { Octokit } from "@octokit/rest";
import type { AsfCiController, AsfDeliveryBinding, AsfEffectInput } from "./delivery-runner.js";
import { sha256Digest, type JsonValue } from "./canonical-json.js";
import type { Clock } from "../platform/clock.js";

export const ASF_CI_HEAD_OBSERVATION_SCHEMA = "asf.ci-head-observation/v1" as const;
export const ASF_GITHUB_CI_CONTEXT_EVIDENCE_SCHEMA =
  "asf.github-ci-context-evidence/v1" as const;

const PAGE_SIZE = 100;
const MAX_CHECK_RUNS = 10_000;
const MAX_COMMIT_STATUSES = 10_000;
const MAX_REQUIRED_CONTEXTS = 10_000;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CHECK_RUN_STATUSES = new Set([
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const CHECK_RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const COMMIT_STATUS_STATES = new Set(["error", "failure", "pending", "success"]);

type CiOutcome = "passed" | "failed" | "pending" | "not-scheduled";
type ObservedCiOutcome = Exclude<CiOutcome, "not-scheduled">;

interface BindingWire {
  readonly run_id: string;
  readonly work_order_id: string;
  readonly attempt_id: string;
  readonly policy_digest: string;
  readonly fencing_generation: number;
  readonly candidate_sha: string;
}

interface NormalizedCiObservation {
  readonly source: "check-run" | "commit-status";
  readonly observation_id: string;
  readonly context: string;
  readonly candidate_sha: string;
  readonly state: string;
  readonly conclusion: string | null;
  readonly observed_at: string | null;
  readonly provider_id: string | null;
  readonly outcome: ObservedCiOutcome;
  readonly coherent: boolean;
}

export interface AsfCiContextObservation {
  readonly context: string;
  readonly outcome: CiOutcome;
  readonly evidence_digest: `sha256:${string}`;
}

export interface AsfCiHeadObservation {
  readonly schema: typeof ASF_CI_HEAD_OBSERVATION_SCHEMA;
  readonly binding: BindingWire;
  readonly evidence_digest: `sha256:${string}`;
  readonly repository: string;
  readonly pull_request_number: number;
  readonly candidate_sha: string;
  readonly observed_head_sha: string;
  /** Durable orchestrator intent time; stable across reconcile-only reads. */
  readonly observed_at: string;
  readonly checks: readonly AsfCiContextObservation[];
}

export interface ProductionGitHubCiControllerOptions {
  /** Kept only inside the host-side Octokit client; never included in observations or errors. */
  readonly token: string;
  readonly baseUrl?: string | undefined;
  readonly clock: Clock;
}

/** An intentionally public-safe refusal whose message contains no provider response text. */
class GitHubCiObservationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubCiObservationRefusal";
  }
}

function refuse(message: string): never {
  throw new GitHubCiObservationRefusal(message);
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) refuse("GitHub CI observation was cancelled");
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseRepository(repository: string): {
  readonly owner: string;
  readonly repo: string;
  readonly normalized: string;
} {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (match?.[1] === undefined || match[2] === undefined) {
    return refuse("GitHub CI repository must be an exact owner/name coordinate");
  }
  return { owner: match[1], repo: match[2], normalized: repository.toLowerCase() };
}

function bindingWire(binding: AsfDeliveryBinding, candidateSha: string): BindingWire {
  if (
    !isIdentifier(binding.runId) ||
    !isIdentifier(binding.workOrderId) ||
    !isIdentifier(binding.attemptId) ||
    !DIGEST_PATTERN.test(binding.policyDigest) ||
    !Number.isSafeInteger(binding.fencingGeneration) ||
    binding.fencingGeneration <= 0 ||
    binding.candidateSha !== candidateSha
  ) {
    return refuse("GitHub CI binding is malformed or does not name the exact candidate");
  }
  return {
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: candidateSha,
  };
}

function normalizeContexts(contexts: readonly string[]): readonly string[] {
  if (contexts.length > MAX_REQUIRED_CONTEXTS) {
    return refuse("GitHub CI required-context set exceeds the protected observation bound");
  }
  const seen = new Set<string>();
  for (const context of contexts) {
    if (!isIdentifier(context) || context.trim() !== context) {
      return refuse("GitHub CI required-context set contains an invalid context");
    }
    if (seen.has(context)) {
      return refuse("GitHub CI required-context set contains a duplicate context");
    }
    seen.add(context);
  }
  return [...seen].sort();
}

function positiveSafeId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return refuse("GitHub CI response contains an invalid observation identifier");
  }
  return String(value);
}

function optionalProviderId(value: unknown): { readonly value: string | null; readonly valid: boolean } {
  // A deleted/anonymous app or status creator cannot establish which trusted
  // CI producer supplied the result. Keep it in the protected evidence, but
  // never let it satisfy a required context.
  if (value === null || value === undefined) return { value: null, valid: false };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { value: null, valid: false };
  }
  return { value: String(value), valid: true };
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function checkRunOutcome(status: string, conclusion: string | null): ObservedCiOutcome {
  if (!CHECK_RUN_STATUSES.has(status)) return "failed";
  if (status !== "completed") return conclusion === null ? "pending" : "failed";
  if (conclusion === "success") return "passed";
  // Missing and unknown conclusions, along with GitHub's neutral, skipped,
  // cancelled, stale, and other terminal states, never establish coverage.
  return "failed";
}

function commitStatusOutcome(state: string): ObservedCiOutcome {
  if (state === "success") return "passed";
  if (state === "pending") return "pending";
  return "failed";
}

function compareObservation(left: NormalizedCiObservation, right: NormalizedCiObservation): number {
  const byTime = (left.observed_at ?? "").localeCompare(right.observed_at ?? "");
  if (byTime !== 0) return byTime;
  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) return bySource;
  return Number(left.observation_id) - Number(right.observation_id);
}

function normalizedOutcome(observations: readonly NormalizedCiObservation[]): CiOutcome {
  if (observations.length === 0) return "not-scheduled";
  if (observations.some((observation) => !observation.coherent)) return "failed";

  // Required contexts are configured by name, without a GitHub App id. Two
  // producer channels claiming the same name are therefore ambiguous: a later
  // legacy status must not override a failing check run (or vice versa).
  // Reruns from one exact producer remain resolvable by timestamp below.
  const producers = new Set(
    observations.map(
      (observation) => `${observation.source}:${observation.provider_id ?? "<unknown>"}`,
    ),
  );
  if (producers.size !== 1) return "failed";

  const latestTime = [...observations].sort(compareObservation).at(-1)?.observed_at;
  if (latestTime === undefined || latestTime === null) return "failed";
  const latest = observations.filter((observation) => observation.observed_at === latestTime);
  const outcomes = new Set(latest.map((observation) => observation.outcome));
  // Equal-recency evidence that disagrees has no safe winner across the two
  // GitHub status namespaces. It is a contradiction, not a successful rerun.
  if (outcomes.size !== 1) return "failed";
  return latest[0]?.outcome ?? "failed";
}

function observationSort(left: NormalizedCiObservation, right: NormalizedCiObservation): number {
  const byContext = left.context.localeCompare(right.context);
  return byContext !== 0 ? byContext : compareObservation(left, right);
}

/**
 * Read-only, host-side CI controller. It never hands provider credentials to an
 * agent and exposes no mutation methods. Every result is tied to a PR whose
 * head is checked both before and after the completely paginated CI reads.
 */
export class ProductionGitHubCiController implements AsfCiController {
  readonly #octokit: Octokit;
  readonly #clock: Clock;

  constructor(options: ProductionGitHubCiControllerOptions) {
    if (
      options.token.length === 0 ||
      options.token.length > 4_096 ||
      /[\u0000-\u0020\u007f]/u.test(options.token)
    ) {
      throw new Error("GitHub CI controller token is invalid");
    }
    this.#octokit = new Octokit(
      options.baseUrl === undefined
        ? { auth: options.token }
        : { auth: options.token, baseUrl: options.baseUrl },
    );
    this.#clock = options.clock;
  }

  async observeExactHead(
    input: AsfEffectInput & {
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly candidateSha: string;
      readonly requiredContexts: readonly string[];
    },
  ): Promise<AsfCiHeadObservation> {
    try {
      return await this.#observeExactHead(input);
    } catch (error) {
      if (input.signal.aborted) {
        throw new Error("GitHub CI observation was cancelled");
      }
      if (error instanceof GitHubCiObservationRefusal) throw error;
      const status = errorStatus(error);
      throw new Error(
        `GitHub CI observation failed${status === undefined ? "" : ` with status ${status}`}`,
      );
    }
  }

  async #observeExactHead(
    input: AsfEffectInput & {
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly candidateSha: string;
      readonly requiredContexts: readonly string[];
    },
  ): Promise<AsfCiHeadObservation> {
    assertNotAborted(input.signal);
    if (!GIT_SHA_PATTERN.test(input.candidateSha)) {
      return refuse("GitHub CI candidate must be an exact lower-case commit SHA");
    }
    if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
      return refuse("GitHub CI pull-request number is invalid");
    }
    const repository = parseRepository(input.repository);
    const binding = bindingWire(input.binding, input.candidateSha);
    const requiredContexts = normalizeContexts(input.requiredContexts);
    const intentCreatedAt = normalizedTimestamp(input.intent.created_at);
    if (intentCreatedAt === null || intentCreatedAt !== input.intent.created_at) {
      return refuse("GitHub CI observation intent time is malformed or non-canonical");
    }

    await this.#assertPullRequestHead({
      ...repository,
      pullRequestNumber: input.pullRequestNumber,
      candidateSha: input.candidateSha,
      signal: input.signal,
    });
    const checkRuns = await this.#listCheckRuns({
      ...repository,
      candidateSha: input.candidateSha,
      signal: input.signal,
    });
    const statuses = await this.#listCommitStatuses({
      ...repository,
      candidateSha: input.candidateSha,
      signal: input.signal,
    });
    await this.#assertPullRequestHead({
      ...repository,
      pullRequestNumber: input.pullRequestNumber,
      candidateSha: input.candidateSha,
      signal: input.signal,
    });
    assertNotAborted(input.signal);
    const observedAt = this.#clock.now().toISOString();
    if (Date.parse(observedAt) < Date.parse(intentCreatedAt)) {
      return refuse("GitHub CI observation time predates its durable intent");
    }

    const observations = [...checkRuns, ...statuses].sort(observationSort);
    const checks = requiredContexts.map((context): AsfCiContextObservation => {
      const matching = observations.filter((observation) => observation.context === context);
      const outcome = normalizedOutcome(matching);
      const contextEvidence = {
        schema: ASF_GITHUB_CI_CONTEXT_EVIDENCE_SCHEMA,
        binding,
        repository: repository.normalized,
        pull_request_number: input.pullRequestNumber,
        candidate_sha: input.candidateSha,
        observed_head_sha: input.candidateSha,
        context,
        outcome,
        observations: matching,
      };
      return {
        context,
        outcome,
        evidence_digest: sha256Digest(json(contextEvidence)),
      };
    });
    const unsigned = {
      schema: ASF_CI_HEAD_OBSERVATION_SCHEMA,
      binding,
      repository: repository.normalized,
      pull_request_number: input.pullRequestNumber,
      candidate_sha: input.candidateSha,
      observed_head_sha: input.candidateSha,
      observed_at: observedAt,
      checks,
    };
    return { ...unsigned, evidence_digest: sha256Digest(json(unsigned)) };
  }

  async #assertPullRequestHead(input: {
    readonly owner: string;
    readonly repo: string;
    readonly normalized: string;
    readonly pullRequestNumber: number;
    readonly candidateSha: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    assertNotAborted(input.signal);
    const response = await this.#octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullRequestNumber,
      request: { signal: input.signal },
    });
    assertNotAborted(input.signal);
    const data = response.data as unknown as {
      readonly number?: unknown;
      readonly state?: unknown;
      readonly head?: { readonly sha?: unknown } | null;
      readonly base?: { readonly repo?: { readonly full_name?: unknown } | null } | null;
    };
    if (
      data.number !== input.pullRequestNumber ||
      data.state !== "open" ||
      data.head === null ||
      typeof data.head !== "object" ||
      data.head.sha !== input.candidateSha ||
      data.base === null ||
      typeof data.base !== "object" ||
      data.base.repo === null ||
      typeof data.base.repo !== "object" ||
      typeof data.base.repo.full_name !== "string" ||
      data.base.repo.full_name.toLowerCase() !== input.normalized
    ) {
      return refuse(
        "GitHub CI pull-request observation is stale or does not prove the exact repository and candidate head",
      );
    }
  }

  async #listCheckRuns(input: {
    readonly owner: string;
    readonly repo: string;
    readonly candidateSha: string;
    readonly signal: AbortSignal;
  }): Promise<readonly NormalizedCiObservation[]> {
    const observations: NormalizedCiObservation[] = [];
    const seenIds = new Set<string>();
    let expectedTotal: number | undefined;
    let page = 1;
    while (true) {
      assertNotAborted(input.signal);
      const response = await this.#octokit.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.candidateSha,
        filter: "all",
        per_page: PAGE_SIZE,
        page,
        request: { signal: input.signal },
      });
      assertNotAborted(input.signal);
      const data = response.data as unknown as {
        readonly total_count?: unknown;
        readonly check_runs?: readonly unknown[];
      };
      if (
        typeof data.total_count !== "number" ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.check_runs) ||
        data.check_runs.length > PAGE_SIZE
      ) {
        return refuse("GitHub check-run response is malformed or contradictory");
      }
      if (data.total_count > MAX_CHECK_RUNS) {
        return refuse("GitHub check-run result set exceeds the protected observation bound");
      }
      if (expectedTotal === undefined) expectedTotal = data.total_count;
      if (expectedTotal !== data.total_count) {
        return refuse("GitHub check-run result set changed while it was being paginated");
      }
      if (data.check_runs.length === 0 && observations.length < expectedTotal) {
        return refuse("GitHub check-run pagination ended before the complete result set");
      }
      for (const raw of data.check_runs) {
        const normalized = this.#normalizeCheckRun(raw, input.candidateSha);
        const key = `${normalized.source}:${normalized.observation_id}`;
        if (seenIds.has(key)) {
          return refuse("GitHub check-run pagination returned a duplicate observation");
        }
        seenIds.add(key);
        observations.push(normalized);
      }
      if (observations.length > expectedTotal) {
        return refuse("GitHub check-run result count contradicts its declared total");
      }
      if (observations.length === expectedTotal) break;
      page += 1;
      if (page > Math.ceil(MAX_CHECK_RUNS / PAGE_SIZE) + 1) {
        return refuse("GitHub check-run pagination exceeded its protected page bound");
      }
    }
    return observations;
  }

  #normalizeCheckRun(raw: unknown, candidateSha: string): NormalizedCiObservation {
    if (raw === null || typeof raw !== "object") {
      return refuse("GitHub check-run response contains a malformed observation");
    }
    const value = raw as {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly head_sha?: unknown;
      readonly status?: unknown;
      readonly conclusion?: unknown;
      readonly started_at?: unknown;
      readonly completed_at?: unknown;
      readonly app?: { readonly id?: unknown } | null;
    };
    if (!isIdentifier(value.name)) {
      return refuse("GitHub check-run response contains an invalid context");
    }
    if (value.head_sha !== candidateSha) {
      return refuse("GitHub check-run response contains stale candidate evidence");
    }
    const status =
      typeof value.status === "string" && CHECK_RUN_STATUSES.has(value.status)
        ? value.status
        : "unknown";
    const conclusion =
      value.conclusion === null
        ? null
        : typeof value.conclusion === "string" && CHECK_RUN_CONCLUSIONS.has(value.conclusion)
          ? value.conclusion
          : "unknown";
    const observedAt = normalizedTimestamp(
      status === "completed" ? value.completed_at : value.started_at,
    );
    const provider = optionalProviderId(value.app?.id);
    const outcome = checkRunOutcome(status, conclusion);
    return {
      source: "check-run",
      observation_id: positiveSafeId(value.id),
      context: value.name,
      candidate_sha: candidateSha,
      state: status,
      conclusion,
      observed_at: observedAt,
      provider_id: provider.value,
      outcome,
      coherent:
        observedAt !== null &&
        provider.valid &&
        status !== "unknown" &&
        conclusion !== "unknown" &&
        ((status === "completed" && conclusion !== null) ||
          (status !== "completed" && conclusion === null)),
    };
  }

  async #listCommitStatuses(input: {
    readonly owner: string;
    readonly repo: string;
    readonly candidateSha: string;
    readonly signal: AbortSignal;
  }): Promise<readonly NormalizedCiObservation[]> {
    const observations: NormalizedCiObservation[] = [];
    const seenIds = new Set<string>();
    let page = 1;
    while (true) {
      assertNotAborted(input.signal);
      const response = await this.#octokit.repos.listCommitStatusesForRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.candidateSha,
        per_page: PAGE_SIZE,
        page,
        request: { signal: input.signal },
      });
      assertNotAborted(input.signal);
      const rows = response.data as unknown;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
        return refuse("GitHub commit-status response is malformed or contradictory");
      }
      if (observations.length + rows.length > MAX_COMMIT_STATUSES) {
        return refuse("GitHub commit-status result set exceeds the protected observation bound");
      }
      for (const raw of rows) {
        const normalized = this.#normalizeCommitStatus(raw, input.candidateSha);
        const key = `${normalized.source}:${normalized.observation_id}`;
        if (seenIds.has(key)) {
          return refuse("GitHub commit-status pagination returned a duplicate observation");
        }
        seenIds.add(key);
        observations.push(normalized);
      }
      if (rows.length < PAGE_SIZE) break;
      page += 1;
      if (page > Math.ceil(MAX_COMMIT_STATUSES / PAGE_SIZE) + 1) {
        return refuse("GitHub commit-status pagination exceeded its protected page bound");
      }
    }
    return observations;
  }

  #normalizeCommitStatus(raw: unknown, candidateSha: string): NormalizedCiObservation {
    if (raw === null || typeof raw !== "object") {
      return refuse("GitHub commit-status response contains a malformed observation");
    }
    const value = raw as {
      readonly id?: unknown;
      readonly context?: unknown;
      readonly sha?: unknown;
      readonly state?: unknown;
      readonly updated_at?: unknown;
      readonly creator?: { readonly id?: unknown } | null;
    };
    if (!isIdentifier(value.context)) {
      return refuse("GitHub commit-status response contains an invalid context");
    }
    if (value.sha !== candidateSha) {
      return refuse("GitHub commit-status response contains stale candidate evidence");
    }
    const state =
      typeof value.state === "string" && COMMIT_STATUS_STATES.has(value.state)
        ? value.state
        : "unknown";
    const observedAt = normalizedTimestamp(value.updated_at);
    const provider = optionalProviderId(value.creator?.id);
    return {
      source: "commit-status",
      observation_id: positiveSafeId(value.id),
      context: value.context,
      candidate_sha: candidateSha,
      state,
      conclusion: state,
      observed_at: observedAt,
      provider_id: provider.value,
      outcome: commitStatusOutcome(state),
      coherent: observedAt !== null && provider.valid && state !== "unknown",
    };
  }
}
