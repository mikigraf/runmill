import { describe, expect, it } from "vitest";
import { buildPullRequestEvidence } from "../../src/orchestrator/pr-evidence.js";

const pullRequest = {
  number: 7,
  url: "https://github.test/acme/app/pull/7",
  headSha: "candidate-123",
  baseSha: "base-456",
  draft: false,
  state: "open" as const,
};

describe("pull request evidence", () => {
  it("records the exact candidate relationship and CI verdicts", () => {
    const evidence = buildPullRequestEvidence({
      generatedAt: "2026-08-21T12:34:56.000Z",
      repository: "acme/app",
      candidateSha: "candidate-123",
      pullRequest,
      requiredContexts: ["build"],
      verdicts: new Map([
        ["build", { state: "satisfied" as const, detail: '"build" passed' }],
      ]),
    });

    expect(evidence.candidate).toEqual({
      sha: "candidate-123",
      matches_pull_request_head: true,
    });
    expect(evidence.pull_request.head_sha).toBe("candidate-123");
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
        candidateSha: "different-candidate",
        pullRequest,
        requiredContexts: [],
        verdicts: new Map(),
      }),
    ).toThrow(/does not match candidate/);
  });
});
