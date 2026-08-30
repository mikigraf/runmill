import { describe, expect, it } from "vitest";
import type { BacklogIssue } from "../../src/domain/types.js";
import {
  createIssueAuthoritySnapshot,
  snapshotHash,
} from "../../src/domain/snapshot.js";
import { assessIssueAuthority } from "../../src/orchestrator/issue-authority.js";
import type { EligibilityPolicy } from "../../src/queue/eligibility.js";

const ISSUE: BacklogIssue = {
  identifier: "ENG-101",
  title: "Implement the existing workflow",
  description: "A complete description that is deliberately long enough for readiness checks.",
  priority: 2,
  labels: ["agent-ready", "backend"],
  state: "Todo",
  teamKey: "ENG",
  projectName: "Core",
  estimate: 3,
  dueDate: "2026-09-30",
  manualRank: 12,
  createdAt: "2026-08-01T00:00:00.000Z",
  canceled: false,
  completed: false,
  blockedBy: [],
};

const POLICY: EligibilityPolicy = {
  eligibleStates: ["Todo"],
  includeLabels: ["agent-ready"],
  excludeLabels: ["blocked"],
  repositoryRules: [
    { match: { team: "ENG" }, repo: "acme/platform", baseBranch: "main" },
  ],
  capacityAvailable: true,
  leasedIssueIds: new Set(),
  allowUnassigned: true,
  claimAssignee: "runmill-bot",
  readinessOverrideLabel: "agent-ready",
};

describe("full issue authority snapshots", () => {
  it("uses canonical full SHA-256 evidence and treats set ordering as immaterial", () => {
    const first = createIssueAuthoritySnapshot(ISSUE);
    const reordered = createIssueAuthoritySnapshot({
      ...ISSUE,
      labels: [...ISSUE.labels].reverse(),
      blockedBy: [...ISSUE.blockedBy].reverse(),
    });

    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.body).toContain('"due_date":"2026-09-30"');
    expect(first.body).toContain('"manual_rank":12');
    expect(reordered).toEqual(first);
    expect(snapshotHash(ISSUE)).toBe(first.fingerprint);
  });

  it.each([
    ["description", { description: `${ISSUE.description} changed` }],
    ["priority", { priority: 1 as const }],
    ["project", { projectName: "Other" }],
    ["estimate", { estimate: 5 }],
    ["due date", { dueDate: "2026-10-01" }],
    ["rank", { manualRank: 13 }],
    ["cancellation", { canceled: true }],
    ["completion", { completed: true }],
    ["dependency", { blockedBy: ["ENG-9"] }],
  ] as const)("changes the fingerprint when %s changes", (_label, patch) => {
    expect(snapshotHash({ ...ISSUE, ...patch })).not.toBe(snapshotHash(ISSUE));
  });
});

describe("issue authority revalidation", () => {
  it("accepts only the exact confirmed Runmill-owned state and assignee delta", () => {
    const assessment = assessIssueAuthority({
      initial: ISSUE,
      observed: {
        ...ISSUE,
        state: "In Progress",
        assigneeId: "runmill-bot",
        assigneeIsHuman: false,
      },
      target: { repo: "acme/platform", baseBranch: "main" },
      policy: POLICY,
      claim: {
        state: "In Progress",
        stateEffectConfirmed: true,
        assignee: "runmill-bot",
        assignmentEffectConfirmed: true,
      },
    });

    expect(assessment.accepted).toBe(true);
    expect(assessment.normalizedFingerprint).toBe(snapshotHash(ISSUE));
    expect(assessment.decision.eligible).toBe(true);
  });

  it.each([
    ["material content", { title: "Human changed the title" }],
    ["unexpected state", { state: "Done" }],
    ["unexpected assignee", { assigneeId: "human-1", assigneeIsHuman: true }],
    ["cancellation", { canceled: true }],
    ["retargeting label", { labels: ["agent-ready", "other-repo"] }],
  ] as const)("refuses %s changes", (_label, patch) => {
    const assessment = assessIssueAuthority({
      initial: ISSUE,
      observed: { ...ISSUE, state: "In Progress", assigneeId: "runmill-bot", ...patch },
      target: { repo: "acme/platform", baseBranch: "main" },
      policy: POLICY,
      claim: {
        state: "In Progress",
        stateEffectConfirmed: true,
        assignee: "runmill-bot",
        assignmentEffectConfirmed: true,
      },
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).not.toBe("");
  });

  it("refuses an unconfirmed claim delta and a changed repository resolution", () => {
    const observed = { ...ISSUE, state: "In Progress", assigneeId: "runmill-bot" };
    expect(
      assessIssueAuthority({
        initial: ISSUE,
        observed,
        target: { repo: "acme/platform", baseBranch: "main" },
        policy: POLICY,
        claim: {
          state: "In Progress",
          stateEffectConfirmed: false,
          assignee: "runmill-bot",
          assignmentEffectConfirmed: true,
        },
      }).accepted,
    ).toBe(false);

    const retargetedPolicy: EligibilityPolicy = {
      ...POLICY,
      repositoryRules: [
        { match: { team: "ENG" }, repo: "acme/other", baseBranch: "main" },
      ],
    };
    expect(
      assessIssueAuthority({
        initial: ISSUE,
        observed,
        target: { repo: "acme/platform", baseBranch: "main" },
        policy: retargetedPolicy,
        claim: {
          state: "In Progress",
          stateEffectConfirmed: true,
          assignee: "runmill-bot",
          assignmentEffectConfirmed: true,
        },
      }).reason,
    ).toMatch(/repository/iu);
  });

  it("does not hide an assignee classification change Runmill did not make", () => {
    const alreadyAssigned = {
      ...ISSUE,
      assigneeId: "runmill-bot",
      assigneeIsHuman: false,
    };
    const assessment = assessIssueAuthority({
      initial: alreadyAssigned,
      observed: {
        ...alreadyAssigned,
        state: "In Progress",
        assigneeIsHuman: true,
      },
      target: { repo: "acme/platform", baseBranch: "main" },
      policy: POLICY,
      claim: {
        state: "In Progress",
        stateEffectConfirmed: true,
        assignee: "runmill-bot",
        assignmentEffectConfirmed: true,
      },
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toMatch(/authority changed/iu);
  });
});
