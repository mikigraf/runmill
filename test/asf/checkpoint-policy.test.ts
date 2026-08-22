import { describe, expect, it } from "vitest";
import {
  ASF_CHECKPOINT_KINDS,
  ASF_CHECKPOINT_RECOVERY_POLICIES,
  ASF_DURABLE_CHECKPOINT_SCHEMA,
  ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA,
  ASF_RECOVERY_REQUEST_SCHEMA,
  AsfRecoveryRefusedError,
  CANDIDATE_CHANGE_INVALIDATES,
  MERGE_BASE_CHANGE_INVALIDATES,
  authorizeProtectedImplementerResume,
  createDurableAsfCheckpoint,
  getAsfCheckpointRecoveryPolicy,
  parseDurableAsfCheckpoint,
  planAsfCheckpointRecovery,
  publicAsfCheckpointSummary,
  type AsfCheckpointKind,
  type DurableAsfCheckpoint,
  type ImplementerResumeObservations,
  type NewDurableAsfCheckpoint,
} from "../../src/asf/checkpoint-policy.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";
const OBSERVED_AT = "2026-08-21T09:59:50.000Z";
const VALID_UNTIL = "2026-08-21T10:05:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-21T10:10:00.000Z";
const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;
const LINEAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const INPUTS_DIGEST = `sha256:${"c".repeat(64)}`;
const OUTPUTS_DIGEST = `sha256:${"d".repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${"e".repeat(64)}`;
const SESSION_IDENTITY_DIGEST = `sha256:${"f".repeat(64)}`;
const CANDIDATE_SHA = "1".repeat(40);
const PROTECTED_RESUME_REF = `sha256:${"1".repeat(64)}`;
const IDENTITY_LEASE_BINDING_DIGEST = `sha256:${"2".repeat(64)}`;
const PROVIDER_SESSION_ID = "provider-session-sensitive-01";
const IDENTITY_LEASE_ID = "identity-lease-sensitive-01";

const clock = () => new FakeClock(NOW);

function protectedResume(candidateSha: string | null) {
  return {
    schema: "asf.protected-implementer-resume/v1" as const,
    storage: "protected-runtime-state" as const,
    protected_resume_ref: PROTECTED_RESUME_REF,
    session_identity_digest: SESSION_IDENTITY_DIGEST,
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    policy_digest: POLICY_DIGEST,
    fencing_generation: 7,
    candidate_sha: candidateSha,
    candidate_lineage_digest: LINEAGE_DIGEST,
    identity_lease_binding_digest: IDENTITY_LEASE_BINDING_DIGEST,
    provider: "codex",
    principal: "asf-implementer",
    profile: "asf-production",
    recorded_at: "2026-08-21T09:58:00.000Z",
    identity_lease_expires_at: LEASE_EXPIRES_AT,
  };
}

function checkpoint(
  kind: AsfCheckpointKind,
  options: {
    readonly withResume?: boolean;
    readonly candidateSha?: string | null;
    readonly phase?: NewDurableAsfCheckpoint["phase"];
  } = {},
): DurableAsfCheckpoint {
  const policy = getAsfCheckpointRecoveryPolicy(kind);
  const candidateSha =
    options.candidateSha ??
    (policy.candidateBinding === "required" ? CANDIDATE_SHA : null);
  const phase = options.phase ?? policy.phases[0];
  if (phase === undefined) throw new Error("test policy has no phase");
  return createDurableAsfCheckpoint({
    schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
    checkpoint_id: `cp_${policy.number}`,
    checkpoint_kind: kind,
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    phase,
    event_seq: policy.number,
    fencing_generation: 7,
    policy_digest: POLICY_DIGEST,
    candidate_sha: candidateSha,
    candidate_lineage_digest: LINEAGE_DIGEST,
    durable_inputs_digest: INPUTS_DIGEST,
    durable_outputs_digest: OUTPUTS_DIGEST,
    replay_policy: policy.replayPolicy,
    reconciliation_markers: policy.reconciliationBeforeReplay.map(
      (observation) => ({
        observation,
        correlation_marker: `${observation}:run_01`,
      }),
    ),
    protected_implementer_resume:
      options.withResume === true ? protectedResume(candidateSha) : null,
    created_at: NOW,
  });
}

function ownership(
  state: "current" | "stale" | "unknown" | "contradictory" = "current",
) {
  return {
    state,
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    worker_id: "worker-01",
    fencing_generation: 7,
    observed_at: OBSERVED_AT,
    valid_until: VALID_UNTIL,
    evidence_digest: EVIDENCE_DIGEST,
  };
}

function resumeObservations(
  candidateSha: string | null,
): ImplementerResumeObservations {
  const observationWindow = {
    observed_at: OBSERVED_AT,
    valid_until: VALID_UNTIL,
    evidence_digest: EVIDENCE_DIGEST,
  };
  return {
    schema: ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA,
    requesting_worker_id: "worker-01",
    ownership: ownership(),
    provider: {
      capability: "supported",
      session_state: "resumable",
      provider: "codex",
      principal: "asf-implementer",
      profile: "asf-production",
      protected_resume_ref: PROTECTED_RESUME_REF,
      session_identity_digest: SESSION_IDENTITY_DIGEST,
      ...observationWindow,
    },
    identity_lease: {
      state: "current",
      identity_lease_binding_digest: IDENTITY_LEASE_BINDING_DIGEST,
      run_id: "run_01",
      work_order_id: "wo_01",
      attempt_id: "attempt_01",
      role: "implementer",
      policy_digest: POLICY_DIGEST,
      fencing_generation: 7,
      provider: "codex",
      principal: "asf-implementer",
      profile: "asf-production",
      expires_at: LEASE_EXPIRES_AT,
      ...observationWindow,
    },
    candidate_lineage: {
      state: "exact",
      candidate_sha: candidateSha,
      candidate_lineage_digest: LINEAGE_DIGEST,
      ...observationWindow,
    },
    policy: {
      state: "permitted",
      policy_digest: POLICY_DIGEST,
      ...observationWindow,
    },
  };
}

function remoteObservations(
  cp: DurableAsfCheckpoint,
  state:
    | "confirmed"
    | "not-applied"
    | "ambiguous"
    | "unknown"
    | "contradictory" = "confirmed",
) {
  return getAsfCheckpointRecoveryPolicy(
    cp.checkpoint_kind,
  ).reconciliationBeforeReplay.map((observation) => ({
    observation,
    state,
    run_id: cp.run_id,
    work_order_id: cp.work_order_id,
    attempt_id: cp.attempt_id,
    policy_digest: cp.policy_digest,
    candidate_sha: cp.candidate_sha,
    correlation_marker: `${observation}:run_01`,
    observed_at: OBSERVED_AT,
    valid_until: VALID_UNTIL,
    evidence_digest: EVIDENCE_DIGEST,
  }));
}

function recoveryRequest(
  cp: DurableAsfCheckpoint,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    schema: ASF_RECOVERY_REQUEST_SCHEMA,
    requesting_worker_id: "worker-01",
    checkpoint: cp,
    checkpoint_observation: {
      state: "verified",
      checkpoint_digest: cp.checkpoint_digest,
      observed_at: OBSERVED_AT,
      valid_until: VALID_UNTIL,
      evidence_digest: EVIDENCE_DIGEST,
    },
    ownership: ownership(),
    remote_observations: remoteObservations(cp),
    replay_requested: false,
    actor: { role: "orchestrator", mode: "automatic" },
    ...overrides,
  };
}

function refusalCode(task: () => unknown): string | undefined {
  try {
    task();
    return undefined;
  } catch (error) {
    if (!(error instanceof AsfRecoveryRefusedError)) throw error;
    return error.code;
  }
}

describe("ASF checkpoint recovery policy catalog", () => {
  it("models all seventeen PRD checkpoints exactly once with closed policy data", () => {
    expect(ASF_CHECKPOINT_RECOVERY_POLICIES).toHaveLength(17);
    expect(
      ASF_CHECKPOINT_RECOVERY_POLICIES.map((policy) => policy.number),
    ).toEqual(Array.from({ length: 17 }, (_unused, index) => index + 1));
    expect(
      ASF_CHECKPOINT_RECOVERY_POLICIES.map((policy) => policy.kind),
    ).toEqual(ASF_CHECKPOINT_KINDS);
    for (const policy of ASF_CHECKPOINT_RECOVERY_POLICIES) {
      expect(policy.phases.length).toBeGreaterThan(0);
      expect(policy.durableInputs.length).toBeGreaterThan(0);
      expect(policy.durableOutputs.length).toBeGreaterThan(0);
      expect(policy.cleanupAndFencing.length).toBeGreaterThan(0);
      expect(policy.reviewerSessionResume).toBe("fresh-only");
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.durableInputs)).toBe(true);
      expect(Object.isFrozen(policy.invalidatesOnReplay)).toBe(true);
      if (policy.reconciliationBeforeReplay.length > 0) {
        expect(policy.replayPolicy).toBe("reconcile-first");
      }
    }
  });

  it("encodes mandatory candidate and merge-base invalidation as monotonic supersets", () => {
    const requiredCandidateInvalidation = [
      "local-verification",
      "local-review",
      "push-equivalence",
      "ci",
      "pr-review",
      "approval",
      "merge-readiness",
    ];
    for (const evidence of requiredCandidateInvalidation) {
      expect(CANDIDATE_CHANGE_INVALIDATES).toContain(evidence);
      expect(MERGE_BASE_CHANGE_INVALIDATES).toContain(evidence);
    }
    expect(CANDIDATE_CHANGE_INVALIDATES).toContain("evidence-bundle");
    expect(CANDIDATE_CHANGE_INVALIDATES).toContain("asf-acknowledgement");
  });

  it("refuses an unknown checkpoint instead of selecting a fallback", () => {
    expect(
      refusalCode(() => getAsfCheckpointRecoveryPolicy("future-checkpoint")),
    ).toBe("UNKNOWN_CHECKPOINT");
  });
});

describe("durable ASF checkpoint records", () => {
  it("content-addresses a strict checkpoint and detects any persisted tampering", () => {
    const cp = checkpoint("candidate-commit-creation");
    expect(parseDurableAsfCheckpoint(cp)).toEqual(cp);

    expect(
      refusalCode(() =>
        parseDurableAsfCheckpoint({
          ...cp,
          durable_outputs_digest: EVIDENCE_DIGEST,
        }),
      ),
    ).toBe("CHECKPOINT_INTEGRITY_UNPROVEN");
    expect(
      refusalCode(() =>
        parseDurableAsfCheckpoint({ ...cp, untrusted_extension: true }),
      ),
    ).toBe("INVALID_REQUEST");
  });

  it("refuses phase, replay-policy, candidate, and unknown-kind authority mismatches", () => {
    const candidate = checkpoint("candidate-commit-creation");
    const { checkpoint_digest: _digest, ...input } = candidate;

    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({ ...input, phase: "CI_WAIT" }),
      ),
    ).toBe("CHECKPOINT_BINDING_MISMATCH");
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...input,
          replay_policy: "not-replayable",
        }),
      ),
    ).toBe("CHECKPOINT_POLICY_MISMATCH");
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({ ...input, candidate_sha: null }),
      ),
    ).toBe("CHECKPOINT_BINDING_MISMATCH");
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...input,
          checkpoint_kind: "future-checkpoint",
        }),
      ),
    ).toBe("UNKNOWN_CHECKPOINT");
  });

  it("binds protected resume metadata and excludes every sensitive handle from public output", () => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const summary = publicAsfCheckpointSummary(cp);
    expect(summary.protected_implementer_resume).toMatchObject({
      present: true,
    });

    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain(PROVIDER_SESSION_ID);
    expect(rendered).not.toContain(IDENTITY_LEASE_ID);
    expect(rendered).not.toContain("asf-implementer");
    expect(rendered).not.toContain("asf-production");
    expect(JSON.stringify(cp)).not.toContain(PROVIDER_SESSION_ID);
    expect(JSON.stringify(cp)).not.toContain(IDENTITY_LEASE_ID);

    const { checkpoint_digest: _rawDigest, ...rawInput } = cp;
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...rawInput,
          protected_implementer_resume: {
            ...rawInput.protected_implementer_resume,
            provider_session_id: PROVIDER_SESSION_ID,
            identity_lease_id: IDENTITY_LEASE_ID,
          },
        }),
      ),
    ).toBe("INVALID_REQUEST");

    const { checkpoint_digest: _digest, ...input } = cp;
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...input,
          protected_implementer_resume: {
            ...input.protected_implementer_resume,
            fencing_generation: 8,
          },
        }),
      ),
    ).toBe("CHECKPOINT_BINDING_MISMATCH");
  });

  it("refuses protected session state at a checkpoint where resume is impossible", () => {
    const terminal = checkpoint("lease-release-workspace-cleanup", {
      candidateSha: CANDIDATE_SHA,
    });
    const { checkpoint_digest: _digest, ...input } = terminal;
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...input,
          protected_implementer_resume: protectedResume(CANDIDATE_SHA),
        }),
      ),
    ).toBe("CHECKPOINT_POLICY_MISMATCH");
  });

  it("refuses protected metadata whose identity lease expired before checkpointing", () => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const { checkpoint_digest: _digest, ...input } = cp;
    expect(
      refusalCode(() =>
        createDurableAsfCheckpoint({
          ...input,
          protected_implementer_resume: {
            ...input.protected_implementer_resume,
            identity_lease_expires_at: "2026-08-21T09:59:59.000Z",
          },
        }),
      ),
    ).toBe("CHECKPOINT_BINDING_MISMATCH");
  });
});

describe("protected implementer resume authorization", () => {
  it("authorizes only an exact, current protected session and serializes a safe binding", () => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const authorization = authorizeProtectedImplementerResume(
      cp,
      resumeObservations(CANDIDATE_SHA),
      { clock: clock() },
    );

    expect(authorization.binding).toMatchObject({
      runId: "run_01",
      checkpointKind: "candidate-commit-creation",
      candidateSha: CANDIDATE_SHA,
      fencingGeneration: 7,
      authorizationFencingGeneration: 7,
      authorizationIdentityLeaseBindingDigest: IDENTITY_LEASE_BINDING_DIGEST,
    });
    expect(authorization.protectedResumeRefForTrustedHarness()).toBe(
      PROTECTED_RESUME_REF,
    );
    expect(JSON.stringify(authorization)).not.toContain(PROTECTED_RESUME_REF);
    expect(Object.keys(authorization)).toEqual(["binding"]);
  });

  it("authorizes a protected session only through a fresh takeover identity fence", () => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const facts = structuredClone(resumeObservations(CANDIDATE_SHA));
    facts.ownership.fencing_generation = 8;
    facts.identity_lease.fencing_generation = 8;
    facts.identity_lease.identity_lease_binding_digest = INPUTS_DIGEST;

    const authorization = authorizeProtectedImplementerResume(cp, facts, {
      clock: clock(),
    });

    expect(authorization.binding).toMatchObject({
      fencingGeneration: 7,
      authorizationFencingGeneration: 8,
      authorizationIdentityLeaseBindingDigest: INPUTS_DIGEST,
    });

    facts.identity_lease.fencing_generation = 7;
    expect(
      refusalCode(() =>
        authorizeProtectedImplementerResume(cp, facts, { clock: clock() }),
      ),
    ).toBe("IMPLEMENTER_RESUME_UNPROVEN");
  });

  it.each([
    [
      "provider capability unknown",
      (facts: any) => {
        facts.provider.capability = "unknown";
      },
    ],
    [
      "session state contradictory",
      (facts: any) => {
        facts.provider.session_state = "contradictory";
      },
    ],
    [
      "session identity changed",
      (facts: any) => {
        facts.provider.session_identity_digest = INPUTS_DIGEST;
      },
    ],
    [
      "identity lease expired",
      (facts: any) => {
        facts.identity_lease.state = "expired";
      },
    ],
    [
      "identity lease changed",
      (facts: any) => {
        facts.identity_lease.identity_lease_binding_digest = INPUTS_DIGEST;
      },
    ],
    [
      "candidate lineage changed",
      (facts: any) => {
        facts.candidate_lineage.state = "changed";
      },
    ],
    [
      "candidate lineage digest changed",
      (facts: any) => {
        facts.candidate_lineage.candidate_lineage_digest = INPUTS_DIGEST;
      },
    ],
    [
      "policy prohibited",
      (facts: any) => {
        facts.policy.state = "prohibited";
      },
    ],
    [
      "policy digest changed",
      (facts: any) => {
        facts.policy.policy_digest = INPUTS_DIGEST;
      },
    ],
    [
      "ownership stale",
      (facts: any) => {
        facts.ownership.state = "stale";
      },
    ],
    [
      "generation changed",
      (facts: any) => {
        facts.ownership.fencing_generation = 8;
      },
    ],
  ])("fails closed when %s", (_label, mutate) => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const facts = structuredClone(resumeObservations(CANDIDATE_SHA));
    mutate(facts);
    expect(() =>
      authorizeProtectedImplementerResume(cp, facts, { clock: clock() }),
    ).toThrow(AsfRecoveryRefusedError);
  });

  it("refuses stale observations, an actually expired lease, and absent protected state", () => {
    const cp = checkpoint("candidate-commit-creation", { withResume: true });
    const stale = structuredClone(resumeObservations(CANDIDATE_SHA));
    stale.provider.valid_until = NOW;
    expect(
      refusalCode(() =>
        authorizeProtectedImplementerResume(cp, stale, { clock: clock() }),
      ),
    ).toBe("STALE_OBSERVATION");

    const expired = structuredClone(resumeObservations(CANDIDATE_SHA));
    expired.identity_lease.expires_at = "2026-08-21T09:59:59.000Z";
    expect(
      refusalCode(() =>
        authorizeProtectedImplementerResume(cp, expired, { clock: clock() }),
      ),
    ).toBe("IMPLEMENTER_RESUME_UNPROVEN");

    const noProtectedState = checkpoint("candidate-commit-creation");
    expect(
      refusalCode(() =>
        authorizeProtectedImplementerResume(
          noProtectedState,
          resumeObservations(CANDIDATE_SHA),
          { clock: clock() },
        ),
      ),
    ).toBe("IMPLEMENTER_RESUME_UNPROVEN");
  });
});

describe("bounded checkpoint recovery decisions", () => {
  it("continues a confirmed remote effect without blindly replaying it", () => {
    const cp = checkpoint("branch-push-intent-observation");
    const plan = planAsfCheckpointRecovery(recoveryRequest(cp), {
      clock: clock(),
    });
    expect(plan).toMatchObject({
      action: "continue-after-reconciliation",
      confirmedReconciliations: ["github-branch-state"],
      replayReconciliations: [],
      skipConfirmedEffects: [],
      invalidatedEvidence: [],
    });
  });

  it("replays only after exact not-applied evidence and reports every invalidation", () => {
    const cp = checkpoint("branch-push-intent-observation");
    const request = recoveryRequest(cp, {
      replay_requested: true,
      remote_observations: remoteObservations(cp, "not-applied"),
    });
    const plan = planAsfCheckpointRecovery(request, { clock: clock() });
    expect(plan.action).toBe("replay-stage");
    expect(plan.replayReconciliations).toEqual(["github-branch-state"]);
    expect(plan.invalidatedEvidence).toEqual(
      getAsfCheckpointRecoveryPolicy(cp.checkpoint_kind).invalidatesOnReplay,
    );
  });

  it.each(["ambiguous", "unknown", "contradictory"] as const)(
    "prohibits a %s remote outcome",
    (state) => {
      const cp = checkpoint("branch-push-intent-observation");
      expect(
        refusalCode(() =>
          planAsfCheckpointRecovery(
            recoveryRequest(cp, {
              remote_observations: remoteObservations(cp, state),
            }),
            { clock: clock() },
          ),
        ),
      ).toBe("REMOTE_OUTCOME_UNRESOLVED");
    },
  );

  it("refuses missing, duplicate, extra, stale, or differently bound reconciliation", () => {
    const cp = checkpoint("branch-push-intent-observation");
    const exact = remoteObservations(cp);
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(cp, { remote_observations: [] }),
          {
            clock: clock(),
          },
        ),
      ),
    ).toBe("REMOTE_RECONCILIATION_REQUIRED");
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(cp, { remote_observations: [...exact, ...exact] }),
          { clock: clock() },
        ),
      ),
    ).toBe("REMOTE_RECONCILIATION_REQUIRED");

    const stale = structuredClone(exact);
    if (stale[0] === undefined) throw new Error("missing fixture observation");
    stale[0].valid_until = NOW;
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(cp, { remote_observations: stale }),
          {
            clock: clock(),
          },
        ),
      ),
    ).toBe("STALE_OBSERVATION");

    const changed = structuredClone(exact);
    if (changed[0] === undefined)
      throw new Error("missing fixture observation");
    changed[0].candidate_sha = "2".repeat(40);
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(cp, { remote_observations: changed }),
          {
            clock: clock(),
          },
        ),
      ),
    ).toBe("REMOTE_BINDING_MISMATCH");

    const wrongMarker = structuredClone(exact);
    if (wrongMarker[0] === undefined)
      throw new Error("missing fixture observation");
    wrongMarker[0].correlation_marker = "github-branch-state:some-other-run";
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(cp, { remote_observations: wrongMarker }),
          { clock: clock() },
        ),
      ),
    ).toBe("REMOTE_BINDING_MISMATCH");
  });

  it("restarts every reviewer with fresh context and refuses reviewer session reuse", () => {
    const local = checkpoint("local-review-fixer-iteration", {
      withResume: true,
    });
    const freshPlan = planAsfCheckpointRecovery(
      recoveryRequest(local, {
        replay_requested: true,
        actor: { role: "local-reviewer", mode: "fresh" },
      }),
      { clock: clock() },
    );
    expect(freshPlan.action).toBe("restart-reviewer-fresh");
    expect(freshPlan.invalidatedEvidence).toEqual(CANDIDATE_CHANGE_INVALIDATES);

    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(local, {
            replay_requested: true,
            actor: { role: "local-reviewer", mode: "resume" },
          }),
          { clock: clock() },
        ),
      ),
    ).toBe("REVIEWER_RESUME_FORBIDDEN");
  });

  it("requires PR and CI reconciliation before a fresh PR reviewer", () => {
    const prReview = checkpoint("pr-review-fixer-iteration", {
      withResume: true,
    });
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(prReview, {
            replay_requested: true,
            actor: { role: "pr-reviewer", mode: "fresh" },
            remote_observations: remoteObservations(prReview).slice(0, 1),
          }),
          { clock: clock() },
        ),
      ),
    ).toBe("REMOTE_RECONCILIATION_REQUIRED");

    expect(
      planAsfCheckpointRecovery(
        recoveryRequest(prReview, {
          replay_requested: true,
          actor: { role: "pr-reviewer", mode: "fresh" },
        }),
        { clock: clock() },
      ).action,
    ).toBe("restart-reviewer-fresh");
  });

  it("carries protected implementer authorization only after exact reconciliation", () => {
    const implementing = checkpoint("implementer-session-marker", {
      withResume: true,
    });
    const plan = planAsfCheckpointRecovery(
      recoveryRequest(implementing, {
        replay_requested: true,
        actor: {
          role: "implementer",
          mode: "resume",
          resume_observations: resumeObservations(null),
        },
      }),
      { clock: clock() },
    );
    expect(plan.action).toBe("resume-implementer");
    expect(plan.implementerResume?.protectedResumeRefForTrustedHarness()).toBe(
      PROTECTED_RESUME_REF,
    );

    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(implementing, {
            replay_requested: true,
            remote_observations: remoteObservations(
              implementing,
              "not-applied",
            ),
            actor: {
              role: "implementer",
              mode: "resume",
              resume_observations: resumeObservations(null),
            },
          }),
          { clock: clock() },
        ),
      ),
    ).toBe("IMPLEMENTER_RESUME_UNPROVEN");
  });

  it("falls back to a fresh implementer on takeover without predicting a future identity lease", () => {
    const candidate = checkpoint("candidate-commit-creation", {
      withResume: true,
    });
    const currentOwnership = ownership();
    currentOwnership.fencing_generation = 8;
    const plan = planAsfCheckpointRecovery(
      recoveryRequest(candidate, {
        requesting_worker_id: "worker-takeover",
        ownership: {
          ...currentOwnership,
          worker_id: "worker-takeover",
        },
        replay_requested: true,
        actor: {
          role: "implementer",
          mode: "fresh",
          resume_observations: null,
        },
      }),
      { clock: clock() },
    );
    expect(plan.action).toBe("restart-implementer-fresh");
    expect(plan.implementerResume).toBeNull();
    expect(plan.ownershipTakeover).toBe(true);
    expect(plan.invalidatedEvidence).toEqual(CANDIDATE_CHANGE_INVALIDATES);
  });

  it("preserves confirmed cleanup effects while replaying only a not-applied release", () => {
    const terminal = checkpoint("lease-release-workspace-cleanup", {
      candidateSha: CANDIDATE_SHA,
    });
    const observations = remoteObservations(terminal);
    if (observations[1] === undefined)
      throw new Error("cleanup fixture lacks two observations");
    observations[1] = { ...observations[1], state: "not-applied" };
    const plan = planAsfCheckpointRecovery(
      recoveryRequest(terminal, {
        replay_requested: true,
        remote_observations: observations,
      }),
      { clock: clock() },
    );
    expect(plan.action).toBe("replay-stage");
    expect(plan.skipConfirmedEffects).toEqual(["identity-lease-state"]);
    expect(plan.replayReconciliations).toEqual(["repository-lease-state"]);
    expect(plan.invalidatedEvidence).toEqual(["cleanup"]);
  });

  it.each(["missing", "unknown", "contradictory"] as const)(
    "refuses %s durable checkpoint evidence",
    (state) => {
      const cp = checkpoint("candidate-commit-creation");
      const request = recoveryRequest(cp);
      request.checkpoint_observation.state = state;
      expect(
        refusalCode(() =>
          planAsfCheckpointRecovery(request, { clock: clock() }),
        ),
      ).toBe("CHECKPOINT_INTEGRITY_UNPROVEN");
    },
  );

  it.each(["stale", "unknown", "contradictory"] as const)(
    "refuses %s ownership without authorizing any replay",
    (state) => {
      const cp = checkpoint("candidate-commit-creation");
      expect(
        refusalCode(() =>
          planAsfCheckpointRecovery(
            recoveryRequest(cp, {
              ownership: ownership(state),
              replay_requested: true,
            }),
            { clock: clock() },
          ),
        ),
      ).toBe("OWNERSHIP_UNPROVEN");
    },
  );

  it("does not let a provider role advance a completed checkpoint", () => {
    const candidate = checkpoint("candidate-commit-creation", {
      withResume: true,
    });
    expect(
      refusalCode(() =>
        planAsfCheckpointRecovery(
          recoveryRequest(candidate, {
            actor: {
              role: "implementer",
              mode: "fresh",
              resume_observations: null,
            },
          }),
          { clock: clock() },
        ),
      ),
    ).toBe("RECOVERY_ROLE_FORBIDDEN");
  });

  it("permits a newer recovery fence but refuses resume through a prior-generation identity", () => {
    const candidate = checkpoint("candidate-commit-creation", {
      withResume: true,
    });
    const currentOwnership = ownership();
    currentOwnership.fencing_generation = 8;
    const plan = planAsfCheckpointRecovery(
      recoveryRequest(candidate, {
        requesting_worker_id: "worker-takeover",
        ownership: { ...currentOwnership, worker_id: "worker-takeover" },
      }),
      { clock: clock() },
    );
    expect(plan.ownershipTakeover).toBe(true);
    expect(plan.requiredTakeoverFencing).toEqual([
      "fence-prior-worker-generation",
      "abort-prior-provider-and-tool-work",
      "revoke-prior-identity-leases",
      "reconcile-in-flight-external-effects",
    ]);

    const resume = structuredClone(resumeObservations(CANDIDATE_SHA));
    resume.requesting_worker_id = "worker-takeover";
    resume.ownership = { ...currentOwnership, worker_id: "worker-takeover" };
    expect(
      refusalCode(() =>
        authorizeProtectedImplementerResume(candidate, resume, {
          clock: clock(),
        }),
      ),
    ).toBe("IMPLEMENTER_RESUME_UNPROVEN");
  });
});
