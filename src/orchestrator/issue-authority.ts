import {
  createIssueAuthoritySnapshot,
  type IssueAuthoritySnapshot,
} from "../domain/snapshot.js";
import type { BacklogIssue, RepositoryTarget } from "../domain/types.js";
import {
  evaluateEligibility,
  type EligibilityDecision,
  type EligibilityPolicy,
} from "../queue/eligibility.js";

export interface IssueAuthorityAssessment {
  readonly accepted: boolean;
  readonly reason: string;
  readonly initialFingerprint: string;
  readonly observedFingerprint: string;
  readonly normalizedFingerprint: string;
  readonly decision: EligibilityDecision;
}

export function assessIssueAuthority(input: {
  readonly initial: BacklogIssue;
  readonly observed: BacklogIssue;
  readonly target: RepositoryTarget;
  readonly policy: EligibilityPolicy;
  readonly claim: {
    readonly state: string;
    readonly stateEffectConfirmed: boolean;
    readonly assignee?: string | undefined;
    readonly assignmentEffectConfirmed: boolean;
  };
}): IssueAuthorityAssessment {
  const initial = createIssueAuthoritySnapshot(input.initial);
  const observed = createIssueAuthoritySnapshot(input.observed);
  const initialDecision = evaluateEligibility(input.initial, input.policy);
  const refuse = (
    reason: string,
    normalized: IssueAuthoritySnapshot = observed,
    decision: EligibilityDecision = initialDecision,
  ): IssueAuthorityAssessment => ({
    accepted: false,
    reason,
    initialFingerprint: initial.fingerprint,
    observedFingerprint: observed.fingerprint,
    normalizedFingerprint: normalized.fingerprint,
    decision,
  });

  if (input.observed.identifier !== input.initial.identifier) {
    return refuse("the observed issue identifier changed");
  }
  if (!input.claim.stateEffectConfirmed) {
    return refuse("the Runmill-owned claim-state mutation is not durably confirmed");
  }
  if (input.observed.state !== input.claim.state) {
    return refuse(
      `issue state changed to ${JSON.stringify(input.observed.state)}; expected the exact ` +
        `Runmill claim state ${JSON.stringify(input.claim.state)}`,
    );
  }

  const assignmentChanged =
    input.claim.assignee !== undefined &&
    input.initial.assigneeId !== input.claim.assignee;
  if (assignmentChanged && !input.claim.assignmentEffectConfirmed) {
    return refuse("the Runmill-owned claim-assignment mutation is not durably confirmed");
  }
  const expectedAssignee = assignmentChanged
    ? input.claim.assignee
    : input.initial.assigneeId;
  if (input.observed.assigneeId !== expectedAssignee) {
    return refuse(
      `issue assignee changed to ${JSON.stringify(input.observed.assigneeId ?? null)}; ` +
        `expected ${JSON.stringify(expectedAssignee ?? null)}`,
    );
  }

  // Remove only the two exact, confirmed mutations owned by Runmill. Every
  // other field remains byte-for-byte authority input and must still match.
  const normalizedIssue: BacklogIssue = {
    ...input.observed,
    state: input.initial.state,
    ...(assignmentChanged
      ? {
          assigneeId: input.initial.assigneeId,
          assigneeIsHuman: input.initial.assigneeIsHuman,
        }
      : {}),
  };
  const normalized = createIssueAuthoritySnapshot(normalizedIssue);
  if (normalized.fingerprint !== initial.fingerprint) {
    return refuse(
      "issue authority changed outside the exact confirmed claim state/assignee delta",
      normalized,
    );
  }

  const decision = evaluateEligibility(normalizedIssue, input.policy);
  if (!decision.eligible || decision.target === undefined) {
    return refuse(
      `the issue is no longer eligible: ${decision.rules
        .filter((rule) => !rule.passed)
        .map((rule) => `${rule.rule}: ${rule.reason}`)
        .join("; ")}`,
      normalized,
      decision,
    );
  }
  if (
    decision.target.repo !== input.target.repo ||
    decision.target.baseBranch !== input.target.baseBranch
  ) {
    return refuse(
      `repository resolution changed from ${input.target.repo}#${input.target.baseBranch} ` +
        `to ${decision.target.repo}#${decision.target.baseBranch}`,
      normalized,
      decision,
    );
  }

  return {
    accepted: true,
    reason: "issue authority and repository resolution remain exact",
    initialFingerprint: initial.fingerprint,
    observedFingerprint: observed.fingerprint,
    normalizedFingerprint: normalized.fingerprint,
    decision,
  };
}
