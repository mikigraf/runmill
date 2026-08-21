import type { PullRequest } from "../pr/adapter.js";
import type { ReconcileVerdict } from "../pr/reconcile.js";

export const PR_EVIDENCE_PATH = ".runmill/run/pr-evidence.json";

export interface PullRequestEvidence {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly repository: string;
  readonly candidate: {
    readonly sha: string;
    readonly matches_pull_request_head: true;
  };
  readonly pull_request: {
    readonly number: number;
    readonly url: string;
    readonly head_sha: string;
    readonly base_sha: string;
    readonly state: PullRequest["state"];
    readonly draft: boolean;
  };
  readonly ci: {
    readonly required_contexts: readonly string[];
    readonly verdicts: readonly {
      readonly context: string;
      readonly state: ReconcileVerdict["state"];
      readonly detail: string;
    }[];
  };
  readonly unavailable: readonly string[];
}

/**
 * Build only evidence the orchestrator actually observed.
 *
 * A mismatch throws rather than being serialized as `false`: the evidence is
 * the input to a release-gating review, not a status dashboard where an unsafe
 * row may be displayed and ignored.
 */
export function buildPullRequestEvidence(input: {
  readonly generatedAt: string;
  readonly repository: string;
  readonly candidateSha: string;
  readonly pullRequest: PullRequest;
  readonly requiredContexts: readonly string[];
  readonly verdicts: ReadonlyMap<string, ReconcileVerdict>;
}): PullRequestEvidence {
  if (input.pullRequest.headSha !== input.candidateSha) {
    throw new Error(
      `pull request head ${input.pullRequest.headSha} does not match candidate ${input.candidateSha}`,
    );
  }

  return {
    schema_version: 1,
    generated_at: input.generatedAt,
    repository: input.repository,
    candidate: {
      sha: input.candidateSha,
      matches_pull_request_head: true,
    },
    pull_request: {
      number: input.pullRequest.number,
      url: input.pullRequest.url,
      head_sha: input.pullRequest.headSha,
      base_sha: input.pullRequest.baseSha,
      state: input.pullRequest.state,
      draft: input.pullRequest.draft,
    },
    ci: {
      required_contexts: input.requiredContexts,
      verdicts: [...input.verdicts]
        .map(([context, verdict]) => ({ context, ...verdict }))
        .sort((left, right) => left.context.localeCompare(right.context)),
    },
    unavailable: [
      "pull request comments were not collected",
      "no separately fetched remote checkout was supplied",
      "no speculative merge or rebase result was supplied",
    ],
  };
}

export function serializePullRequestEvidence(evidence: PullRequestEvidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}
