import { describe, expect, it } from "vitest";
import { buildPullRequestEvidence } from "../../src/orchestrator/pr-evidence.js";

const CANDIDATE_SHA = "c".repeat(40);
const BASE_SHA = "b".repeat(40);

const pullRequest = {
  number: 7,
  url: "https://github.test/acme/app/pull/7",
  headSha: CANDIDATE_SHA,
  baseSha: BASE_SHA,
  draft: false,
  state: "open" as const,
};

describe("pull request evidence", () => {
  it("records the exact candidate relationship and CI verdicts", () => {
    const evidence = buildPullRequestEvidence({
      generatedAt: "2026-08-21T12:34:56.000Z",
      repository: "acme/app",
        candidateSha: CANDIDATE_SHA,
      pullRequest,
      requiredContexts: ["build"],
      verdicts: new Map([
        ["build", { state: "satisfied" as const, detail: '"build" passed' }],
      ]),
    });

    expect(evidence.candidate).toEqual({
      sha: CANDIDATE_SHA,
      matches_pull_request_head: true,
    });
    expect(evidence.pull_request.head_sha).toBe(CANDIDATE_SHA);
    expect(evidence.ci.verdicts).toEqual([
      { context: "build", state: "satisfied", detail: '"build" passed' },
    ]);
    expect(evidence.unavailable.join(" ")).toMatch(/comments were not collected/i);
  });

  it("refuses to materialize contradictory head evidence", () => {
    expect(() =>
      buildPullRequestEvidence({
        generatedAt: "2026-08-21T12:34:56.000Z",
        repository: "acme/app",
        candidateSha: "d".repeat(40),
        pullRequest,
        requiredContexts: [],
        verdicts: new Map(),
      }),
    ).toThrow(/does not match candidate/);
  });

  it("refuses synthetic commit identities", () => {
    expect(() =>
      buildPullRequestEvidence({
        generatedAt: "2026-08-21T12:34:56.000Z",
        repository: "acme/app",
        candidateSha: "candidate-123",
        pullRequest,
        requiredContexts: [],
        verdicts: new Map(),
      }),
    ).toThrow(/Git object id/iu);
  });
});
