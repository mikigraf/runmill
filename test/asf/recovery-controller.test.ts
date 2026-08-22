import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/platform/clock.js";
import {
  ASF_DURABLE_CHECKPOINT_SCHEMA,
  ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA,
  createDurableAsfCheckpoint,
  getAsfCheckpointRecoveryPolicy,
  planAsfCheckpointRecovery,
  type AsfCheckpointKind,
  type DurableAsfCheckpoint,
} from "../../src/asf/checkpoint-policy.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import type { AsfDeliveryBinding } from "../../src/asf/delivery-runner.js";
import {
  ASF_RECOVERY_AUTHORIZATION_RECORD_SCHEMA,
  ASF_RECOVERY_INVALIDATION_RECEIPT_SCHEMA,
  ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA,
  ASF_TAKEOVER_FENCING_OPERATIONS,
  AsfRecoveryControllerRefusedError,
  ProductionAsfRecoveryController,
  createAsfRecoveryDirective,
  createAsfRecoveryInvalidationReceipt,
  createAsfRecoveryOperationReceipt,
  type AsfRecoveryDirective,
  type AsfRecoveryDurableStore,
  type AsfRecoveryEvidenceInvalidator,
  type AsfRecoveryProtectedObservationSource,
  type AsfRecoveryRequestAuthority,
  type AsfRecoveryTakeoverFencer,
  type DurableAsfRecoveryAcknowledgement,
  type DurableAsfRecoveryAuthorization,
} from "../../src/asf/recovery-controller.js";

const NOW = "2026-08-22T10:00:00.000Z";
const FUTURE = "2026-08-22T10:10:00.000Z";
const PAST = "2026-08-22T09:59:00.000Z";
const POLICY = sha256Digest({ policy: "test" });
const LINEAGE = sha256Digest({ lineage: "test" });
const CANDIDATE = "a".repeat(40);

const clock: Clock = { now: () => new Date(NOW), monotonicMs: () => 0 };

function wire(binding: AsfDeliveryBinding) {
  return {
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: binding.candidateSha,
  };
}

function checkpoint(
  kind: AsfCheckpointKind,
  options: { readonly generation?: number; readonly withResume?: boolean } = {},
): DurableAsfCheckpoint {
  const policy = getAsfCheckpointRecoveryPolicy(kind);
  const candidate = policy.candidateBinding === "none" ? null : CANDIDATE;
  const generation = options.generation ?? 1;
  return createDurableAsfCheckpoint({
    schema: ASF_DURABLE_CHECKPOINT_SCHEMA,
    checkpoint_id: `cp-${kind}`,
    checkpoint_kind: kind,
    run_id: "run-recovery",
    work_order_id: "wo-recovery",
    attempt_id: "attempt-recovery",
    phase: policy.phases[0],
    event_seq: 7,
    fencing_generation: generation,
    policy_digest: POLICY,
    candidate_sha: candidate,
    candidate_lineage_digest: LINEAGE,
    durable_inputs_digest: sha256Digest({ inputs: kind }),
    durable_outputs_digest: sha256Digest({ outputs: kind }),
    replay_policy: policy.replayPolicy,
    reconciliation_markers: policy.reconciliationBeforeReplay.map(
      (observation) => ({
        observation,
        correlation_marker: `marker-${observation}`,
      }),
    ),
    protected_implementer_resume: options.withResume
      ? {
          schema: "asf.protected-implementer-resume/v1",
          storage: "protected-runtime-state",
          protected_resume_ref: sha256Digest({ protected: "session" }),
          session_identity_digest: sha256Digest({ session: "identity" }),
          run_id: "run-recovery",
          work_order_id: "wo-recovery",
          attempt_id: "attempt-recovery",
          policy_digest: POLICY,
          fencing_generation: generation,
          candidate_sha: candidate,
          candidate_lineage_digest: LINEAGE,
          identity_lease_binding_digest: sha256Digest({ identity: "lease" }),
          provider: "provider-a",
          principal: "principal-a",
          profile: "implementer-profile",
          recorded_at: PAST,
          identity_lease_expires_at: FUTURE,
        }
      : null,
    created_at: NOW,
  });
}

function binding(
  cp: DurableAsfCheckpoint,
  generation = cp.fencing_generation,
): AsfDeliveryBinding {
  return {
    runId: cp.run_id,
    workOrderId: cp.work_order_id,
    attemptId: cp.attempt_id,
    policyDigest: cp.policy_digest,
    fencingGeneration: generation,
    candidateSha: cp.candidate_sha,
  };
}

type Actor = AsfRecoveryDirective["actor"];

class MemoryStore implements AsfRecoveryDurableStore {
  authorization: DurableAsfRecoveryAuthorization | undefined;
  acknowledgement: DurableAsfRecoveryAcknowledgement | undefined;
  acknowledgementWrites = 0;

  async recordAuthorization(record: DurableAsfRecoveryAuthorization) {
    this.authorization = record;
    return record;
  }

  async loadAuthorization() {
    return this.authorization;
  }

  async loadAcknowledgement() {
    return this.acknowledgement;
  }

  async recordAcknowledgement(record: DurableAsfRecoveryAcknowledgement) {
    this.acknowledgementWrites += 1;
    this.acknowledgement = record;
    return record;
  }
}

interface FixtureOptions {
  readonly actor?: Actor;
  readonly replayRequested?: boolean;
  readonly remoteState?: "confirmed" | "not-applied" | "ambiguous";
  readonly ownershipState?: "current" | "stale";
  readonly ownershipValidUntil?: string;
  readonly checkpointState?: "verified" | "missing";
  readonly fencerOverride?: AsfRecoveryTakeoverFencer["complete"];
  readonly invalidatorOverride?: AsfRecoveryEvidenceInvalidator["invalidate"];
}

function fixture(
  cp: DurableAsfCheckpoint,
  currentBinding: AsfDeliveryBinding,
  options: FixtureOptions = {},
) {
  const operations: string[] = [];
  const store = new MemoryStore();
  const observationWindow = {
    observed_at: NOW,
    valid_until: FUTURE,
    evidence_digest: sha256Digest({ observation: "window" }),
  };
  const observations: AsfRecoveryProtectedObservationSource = {
    async observeCheckpoint() {
      return {
        state: options.checkpointState ?? "verified",
        checkpoint_digest: cp.checkpoint_digest,
        ...observationWindow,
      };
    },
    async observeOwnership() {
      return {
        state: options.ownershipState ?? "current",
        run_id: cp.run_id,
        work_order_id: cp.work_order_id,
        attempt_id: cp.attempt_id,
        worker_id: "worker-recovery",
        fencing_generation: currentBinding.fencingGeneration,
        ...observationWindow,
        valid_until: options.ownershipValidUntil ?? FUTURE,
      };
    },
    async observeRemote(input) {
      return {
        observation: input.observation,
        state: options.remoteState ?? "not-applied",
        run_id: cp.run_id,
        work_order_id: cp.work_order_id,
        attempt_id: cp.attempt_id,
        policy_digest: cp.policy_digest,
        candidate_sha: cp.candidate_sha,
        correlation_marker: input.correlationMarker,
        ...observationWindow,
      };
    },
    async observeImplementerResume() {
      const resume = cp.protected_implementer_resume;
      if (resume === null)
        throw new Error("test checkpoint has no protected resume state");
      return {
        schema: ASF_IMPLEMENTER_RESUME_OBSERVATION_SCHEMA,
        requesting_worker_id: "worker-recovery",
        ownership: {
          state: "current",
          run_id: cp.run_id,
          work_order_id: cp.work_order_id,
          attempt_id: cp.attempt_id,
          worker_id: "worker-recovery",
          fencing_generation: currentBinding.fencingGeneration,
          ...observationWindow,
        },
        provider: {
          capability: "supported",
          session_state: "resumable",
          provider: resume.provider,
          principal: resume.principal,
          profile: resume.profile,
          protected_resume_ref: resume.protected_resume_ref,
          session_identity_digest: resume.session_identity_digest,
          ...observationWindow,
        },
        identity_lease: {
          state: "current",
          identity_lease_binding_digest:
            currentBinding.fencingGeneration === cp.fencing_generation
              ? resume.identity_lease_binding_digest
              : sha256Digest({
                  identity: "lease",
                  generation: currentBinding.fencingGeneration,
                }),
          run_id: cp.run_id,
          work_order_id: cp.work_order_id,
          attempt_id: cp.attempt_id,
          role: "implementer",
          policy_digest: cp.policy_digest,
          fencing_generation: currentBinding.fencingGeneration,
          provider: resume.provider,
          principal: resume.principal,
          profile: resume.profile,
          expires_at: FUTURE,
          ...observationWindow,
        },
        candidate_lineage: {
          state: "exact",
          candidate_sha: cp.candidate_sha,
          candidate_lineage_digest: cp.candidate_lineage_digest,
          ...observationWindow,
        },
        policy: {
          state: "permitted",
          policy_digest: cp.policy_digest,
          ...observationWindow,
        },
      };
    },
  };
  const authority: AsfRecoveryRequestAuthority = {
    async authorize() {
      return createAsfRecoveryDirective({
        schema: "asf.recovery-directive/v1",
        checkpoint_digest: cp.checkpoint_digest,
        binding: wire(currentBinding),
        worker_id: "worker-recovery",
        takeover: currentBinding.fencingGeneration > cp.fencing_generation,
        replay_requested: options.replayRequested ?? true,
        actor: options.actor ?? { role: "orchestrator", mode: "automatic" },
        issued_at: NOW,
        valid_until: FUTURE,
      });
    },
  };
  const takeoverFencer: AsfRecoveryTakeoverFencer = {
    complete:
      options.fencerOverride ??
      (async (input) => {
        operations.push(input.operation);
        return createAsfRecoveryOperationReceipt({
          schema: ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA,
          operation: input.operation,
          ordinal: input.ordinal,
          checkpoint_digest: cp.checkpoint_digest,
          binding: wire(currentBinding),
          authorization_record_digest:
            input.authorization.authorization_record_digest,
          previous_receipt_digest: input.previousReceiptDigest,
          completed_at: NOW,
          evidence_digest: sha256Digest({ operation: input.operation }),
        });
      }),
  };
  const invalidator: AsfRecoveryEvidenceInvalidator = {
    invalidate:
      options.invalidatorOverride ??
      (async (input) => {
        operations.push("invalidate-evidence");
        return createAsfRecoveryInvalidationReceipt({
          schema: ASF_RECOVERY_INVALIDATION_RECEIPT_SCHEMA,
          checkpoint_digest: cp.checkpoint_digest,
          binding: wire(currentBinding),
          authorization_record_digest:
            input.authorization.authorization_record_digest,
          previous_receipt_digest: input.previousReceiptDigest,
          invalidated_evidence: [...input.evidenceClasses],
          completed_at: NOW,
          evidence_digest: sha256Digest({ invalidated: input.evidenceClasses }),
        });
      }),
  };
  return {
    controller: new ProductionAsfRecoveryController({
      workerId: "worker-recovery",
      observations,
      authority,
      takeoverFencer,
      invalidator,
      store,
      clock,
    }),
    store,
    operations,
  };
}

async function observeAndPlan(
  controller: ProductionAsfRecoveryController,
  cp: DurableAsfCheckpoint,
  currentBinding: AsfDeliveryBinding,
) {
  const request = await controller.observe({
    checkpoint: cp,
    binding: currentBinding,
    workerId: "worker-recovery",
    takeover: currentBinding.fencingGeneration > cp.fencing_generation,
    signal: new AbortController().signal,
  });
  return planAsfCheckpointRecovery(request, { clock });
}

describe("ProductionAsfRecoveryController", () => {
  it("refuses a newer checkpoint fence mislabeled as a fresh acquisition", async () => {
    const cp = checkpoint("branch-push-intent-observation");
    const currentBinding = binding(cp, 2);
    const test = fixture(cp, currentBinding);

    await expect(
      test.controller.observe({
        checkpoint: cp,
        binding: currentBinding,
        workerId: "worker-recovery",
        takeover: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(test.operations).toEqual([]);
    expect(test.store.authorization).toBeUndefined();
  });

  it("applies takeover fencing in exact order, invalidates exact evidence, and durably acknowledges once", async () => {
    const cp = checkpoint("branch-push-intent-observation");
    const currentBinding = binding(cp, 2);
    const test = fixture(cp, currentBinding);
    const plan = await observeAndPlan(test.controller, cp, currentBinding);

    const acknowledgement = await test.controller.apply({
      plan,
      checkpoint: cp,
      binding: currentBinding,
      signal: new AbortController().signal,
    });

    expect(test.operations).toEqual([
      ...ASF_TAKEOVER_FENCING_OPERATIONS,
      "invalidate-evidence",
    ]);
    expect(acknowledgement).toMatchObject({
      action: "replay-stage",
      completed_takeover_fencing: [...ASF_TAKEOVER_FENCING_OPERATIONS],
      invalidated_evidence: [...plan.invalidatedEvidence],
    });
    expect(test.store.authorization?.schema).toBe(
      ASF_RECOVERY_AUTHORIZATION_RECORD_SCHEMA,
    );
    expect(test.store.acknowledgementWrites).toBe(1);

    await test.controller.apply({
      plan,
      checkpoint: cp,
      binding: currentBinding,
      signal: new AbortController().signal,
    });
    expect(test.operations).toHaveLength(5);
    expect(test.store.acknowledgementWrites).toBe(1);
  });

  it.each([
    ["missing checkpoint", { checkpointState: "missing" }],
    ["stale ownership", { ownershipValidUntil: PAST }],
    ["ambiguous remote", { remoteState: "ambiguous" }],
  ] as const)(
    "refuses %s evidence before durable authorization",
    async (_label, options) => {
      const cp = checkpoint("branch-push-intent-observation");
      const currentBinding = binding(cp, 2);
      const test = fixture(cp, currentBinding, options);
      await expect(
        observeAndPlan(test.controller, cp, currentBinding),
      ).rejects.toThrow();
      expect(test.store.authorization).toBeUndefined();
    },
  );

  it("does not acknowledge partial takeover fencing", async () => {
    const cp = checkpoint("branch-push-intent-observation");
    const currentBinding = binding(cp, 2);
    let calls = 0;
    const test = fixture(cp, currentBinding, {
      fencerOverride: async (input) => {
        calls += 1;
        if (calls === 3) throw new Error("simulated partial fence");
        return createAsfRecoveryOperationReceipt({
          schema: ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA,
          operation: input.operation,
          ordinal: input.ordinal,
          checkpoint_digest: cp.checkpoint_digest,
          binding: wire(currentBinding),
          authorization_record_digest:
            input.authorization.authorization_record_digest,
          previous_receipt_digest: input.previousReceiptDigest,
          completed_at: NOW,
          evidence_digest: sha256Digest({ call: calls }),
        });
      },
    });
    const plan = await observeAndPlan(test.controller, cp, currentBinding);
    await expect(
      test.controller.apply({
        plan,
        checkpoint: cp,
        binding: currentBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("simulated partial fence");
    expect(calls).toBe(3);
    expect(test.store.acknowledgement).toBeUndefined();
  });

  it("refuses an out-of-order or wrong-digest takeover receipt", async () => {
    const cp = checkpoint("branch-push-intent-observation");
    const currentBinding = binding(cp, 2);
    const test = fixture(cp, currentBinding, {
      fencerOverride: async (input) =>
        createAsfRecoveryOperationReceipt({
          schema: ASF_RECOVERY_OPERATION_RECEIPT_SCHEMA,
          operation: "abort-prior-provider-and-tool-work",
          ordinal: input.ordinal,
          checkpoint_digest: cp.checkpoint_digest,
          binding: wire(currentBinding),
          authorization_record_digest:
            input.authorization.authorization_record_digest,
          previous_receipt_digest: input.previousReceiptDigest,
          completed_at: NOW,
          evidence_digest: sha256Digest({ wrong: true }),
        }),
    });
    const plan = await observeAndPlan(test.controller, cp, currentBinding);
    await expect(
      test.controller.apply({
        plan,
        checkpoint: cp,
        binding: currentBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "FENCING_INCOMPLETE" });
    expect(test.store.acknowledgement).toBeUndefined();
  });

  it("refuses partial evidence invalidation", async () => {
    const cp = checkpoint("branch-push-intent-observation");
    const currentBinding = binding(cp);
    const test = fixture(cp, currentBinding, {
      invalidatorOverride: async (input) =>
        createAsfRecoveryInvalidationReceipt({
          schema: ASF_RECOVERY_INVALIDATION_RECEIPT_SCHEMA,
          checkpoint_digest: cp.checkpoint_digest,
          binding: wire(currentBinding),
          authorization_record_digest:
            input.authorization.authorization_record_digest,
          previous_receipt_digest: input.previousReceiptDigest,
          invalidated_evidence: input.evidenceClasses.slice(1),
          completed_at: NOW,
          evidence_digest: sha256Digest({ partial: true }),
        }),
    });
    const plan = await observeAndPlan(test.controller, cp, currentBinding);
    await expect(
      test.controller.apply({
        plan,
        checkpoint: cp,
        binding: currentBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "INVALIDATION_INCOMPLETE" });
    expect(test.store.acknowledgement).toBeUndefined();
  });

  it("forces reviewer recovery to use fresh context and refuses resume directives", async () => {
    const cp = checkpoint("local-review-fixer-iteration");
    const currentBinding = binding(cp);
    const fresh = fixture(cp, currentBinding, {
      actor: { role: "local-reviewer", mode: "fresh" },
    });
    const plan = await observeAndPlan(fresh.controller, cp, currentBinding);
    expect(plan.action).toBe("restart-reviewer-fresh");
    expect(plan.implementerResume).toBeNull();

    const resume = fixture(cp, currentBinding, {
      actor: { role: "local-reviewer", mode: "resume" },
    });
    await expect(
      observeAndPlan(resume.controller, cp, currentBinding),
    ).rejects.toMatchObject({
      code: "REVIEWER_RESUME_FORBIDDEN",
    });
    expect(resume.store.authorization).toBeUndefined();
  });

  it("preserves an exact protected implementer resume authorization", async () => {
    const cp = checkpoint("implementer-session-marker", { withResume: true });
    const currentBinding = binding(cp);
    const test = fixture(cp, currentBinding, {
      actor: { role: "implementer", mode: "resume" },
      remoteState: "confirmed",
    });
    const plan = await observeAndPlan(test.controller, cp, currentBinding);
    expect(plan.action).toBe("resume-implementer");
    expect(plan.implementerResume?.binding).toMatchObject({
      runId: cp.run_id,
      checkpointKind: cp.checkpoint_kind,
      fencingGeneration: cp.fencing_generation,
    });
    expect(plan.implementerResume?.toJSON()).not.toHaveProperty(
      "protected_resume_ref",
    );
    expect(plan.implementerResume?.protectedResumeRefForTrustedHarness()).toBe(
      cp.protected_implementer_resume?.protected_resume_ref,
    );

    await expect(
      test.controller.apply({
        plan: { ...plan, implementerResume: null },
        checkpoint: cp,
        binding: currentBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AsfRecoveryControllerRefusedError);
  });

  it("binds protected session generation 1 to fresh identity authority at generation 2", async () => {
    const cp = checkpoint("implementer-session-marker", { withResume: true });
    const currentBinding = binding(cp, 2);
    const test = fixture(cp, currentBinding, {
      actor: { role: "implementer", mode: "resume" },
      remoteState: "confirmed",
    });

    const plan = await observeAndPlan(test.controller, cp, currentBinding);

    expect(plan.action).toBe("resume-implementer");
    expect(plan.implementerResume?.binding).toMatchObject({
      fencingGeneration: 1,
      authorizationFencingGeneration: 2,
      authorizationIdentityLeaseBindingDigest: sha256Digest({
        identity: "lease",
        generation: 2,
      }),
    });
    expect(plan.requiredTakeoverFencing).toEqual([
      ...ASF_TAKEOVER_FENCING_OPERATIONS,
    ]);
  });
});
