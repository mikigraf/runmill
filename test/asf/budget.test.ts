import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StateStoreAsfProviderBudgetController,
  asfProviderInvocationId,
} from "../../src/asf/budget.js";
import { canonicalJson, sha256Digest } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import type {
  AsfDeliveryBinding,
  AsfDeliveryStageIntent,
} from "../../src/asf/delivery-runner.js";
import {
  EFFECTIVE_POLICY_SCHEMA,
  WORK_ORDER_ENVELOPE_SCHEMA,
  WORK_ORDER_SCHEMA,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "../../src/asf/work-order.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { MIGRATIONS } from "../../src/state/migrations.js";
import { StateStore } from "../../src/state/store.js";

const NOW = "2026-08-21T10:00:00.000Z";
const BASE_SHA = "a".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const OWNER = "budget-worker-01";

let directory: string;
let clock: FakeClock;
const stores = new Set<StateStore>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-asf-budget-"));
  clock = new FakeClock(NOW);
});

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  rmSync(directory, { recursive: true, force: true });
});

function open(): StateStore {
  const store = StateStore.open(databasePath(), { clock });
  stores.add(store);
  return store;
}

function databasePath(): string {
  return join(directory, "runmill.db");
}

function close(store: StateStore): void {
  store.close();
  stores.delete(store);
}

function fixture(input: {
  readonly wallSeconds?: number;
  readonly maxCostUsd?: number;
  readonly maxAgentInvocations?: number;
} = {}): { readonly envelope: WorkOrderEnvelope; readonly policy: EffectiveAsfPolicy } {
  const wallSeconds = input.wallSeconds ?? 3_600;
  const maxCostUsd = input.maxCostUsd ?? 1;
  const maxAgentInvocations = input.maxAgentInvocations ?? 3;
  const envelope: WorkOrderEnvelope = {
    schema: WORK_ORDER_ENVELOPE_SCHEMA,
    key_id: "asf-signing-key-01",
    algorithm: "EdDSA",
    issued_at: NOW,
    not_before: NOW,
    expires_at: "2026-08-22T10:00:00.000Z",
    payload: {
      schema: WORK_ORDER_SCHEMA,
      work_order_id: "wo_budget_01",
      tenant_id: "tenant-acme",
      work_item_id: "ENG-BUDGET",
      attempt_id: "attempt_01",
      idempotency_key: "tenant-acme/ENG-BUDGET/attempt_01",
      source: { system: "linear", external_id: "ENG-BUDGET", snapshot_digest: DIGEST_A },
      repository: {
        forge: "github",
        repository: "acme/payments",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: "Enforce the provider budget",
        description: "Keep aggregate provider usage durable.",
        acceptance_criteria: ["Unknown usage remains reserved."],
        non_goals: ["Deploying."],
      },
      scope: {
        allowed_paths: ["src/**"],
        forbidden_paths: [".runmill/**"],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["unit"],
        required_remote_checks: ["ci/unit"],
        policy_snapshot_digest: DIGEST_B,
      },
      identities: {
        implementer: "codex:production",
        local_reviewer: "claude:review",
        pr_reviewer: "claude:review",
      },
      runtime: {
        sandbox_profile: "linux-production-v1",
        tool_policy: "repo-change-v1",
        network_policy: "provider-only-v1",
      },
      budgets: {
        wall_seconds: wallSeconds,
        max_cost_usd: maxCostUsd,
        max_agent_invocations: maxAgentInvocations,
        max_fix_iterations: 2,
      },
      delivery: { closure_target: "pr", draft_pr: false, merge_policy_ref: null },
      policy_digest: DIGEST_C,
      harness_digest: DIGEST_D,
    },
    signature: "base64url:c2lnbmF0dXJl",
  };
  const policy: EffectiveAsfPolicy = {
    schema: EFFECTIVE_POLICY_SCHEMA,
    digest: DIGEST_D,
    inputs: {
      operatorPolicy: DIGEST_A,
      workOrderPolicy: DIGEST_B,
      workOrderPayload: DIGEST_C,
      harness: DIGEST_D,
      repositoryPolicy: DIGEST_C,
      repositoryPolicyBaseSha: BASE_SHA,
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: "Y2hlY2tzOiBbXQo=",
      observedBaseSha: BASE_SHA,
      forgeProtection: DIGEST_D,
      forgeProtectionBaseRef: "refs/heads/main",
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [
      { source: "operator", allowedPaths: ["src/**"], forbiddenPaths: [".runmill/**"] },
      { source: "work-order", allowedPaths: ["src/**"], forbiddenPaths: [".runmill/**"] },
      { source: "repository", allowedPaths: ["src/**"], forbiddenPaths: [".runmill/**"] },
    ],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["unit"],
    requiredRemoteChecks: ["ci/unit"],
    riskClass: "low",
    identities: {
      implementer: "codex:production",
      localReviewer: "claude:review",
      prReviewer: "claude:review",
    },
    runtime: {
      sandboxProfile: "linux-production-v1",
      toolPolicy: "repo-change-v1",
      networkPolicy: "provider-only-v1",
    },
    budgets: { wallSeconds, maxCostUsd, maxAgentInvocations, maxFixIterations: 2 },
    delivery: { closureTarget: "pr", draftPr: false },
  };
  return { envelope, policy };
}

function setup(
  limits: Parameters<typeof fixture>[0] = {},
): {
  readonly store: StateStore;
  readonly budget: StateStoreAsfProviderBudgetController;
  readonly binding: AsfDeliveryBinding;
  readonly intent: AsfDeliveryStageIntent;
  readonly policy: EffectiveAsfPolicy;
} {
  const store = open();
  const { envelope, policy } = fixture(limits);
  store.admitAsfWorkOrder({
    runId: "run_budget_01",
    envelope,
    canonicalEnvelope: canonicalJson(envelope),
    envelopeDigest: sha256Digest(envelope),
    payloadDigest: sha256Digest(envelope.payload),
    effectivePolicy: policy,
  });
  expect(store.claimAsfRun({
    runId: "run_budget_01",
    ownerId: OWNER,
    staleBefore: "2026-08-21T09:59:00.000Z",
  })).toEqual({ generation: 1, takeover: false });
  const snapshot = store.getAsfRunSnapshot("run_budget_01");
  if (snapshot === undefined) throw new Error("test ASF run disappeared");
  const binding: AsfDeliveryBinding = {
    runId: snapshot.run.runId,
    workOrderId: snapshot.admission.workOrderId,
    attemptId: snapshot.admission.attemptId,
    policyDigest: snapshot.admission.effectivePolicyDigest,
    fencingGeneration: snapshot.run.generation,
    candidateSha: null,
  };
  const operationDigest = sha256Digest({ mode: "implement", starting_sha: BASE_SHA });
  const effectKey = `delivery_effect_${sha256Digest({
    stage: "candidate",
    run_id: binding.runId,
    candidate_sha: null,
    event_seq: snapshot.latestSequence,
    operation_digest: operationDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const identityDigest = sha256Digest({ effect_key: effectKey, generation: 1 });
  const unsigned = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: `delivery_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    effect_key: effectKey,
    stage: "candidate" as const,
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: 1,
    candidate_sha: null,
    event_seq: snapshot.latestSequence,
    operation_digest: operationDigest,
    created_at: snapshot.admission.acceptedAt,
  };
  const intent: AsfDeliveryStageIntent = {
    ...unsigned,
    intent_digest: sha256Digest(unsigned),
  };
  store.recordAsfDeliveryIntent({ ownerId: OWNER, intent });
  return {
    store,
    budget: new StateStoreAsfProviderBudgetController(store, OWNER),
    binding,
    intent,
    policy,
  };
}

function reservationInput(test: ReturnType<typeof setup>) {
  const invocationId = asfProviderInvocationId(test.intent.effect_key, "implementer");
  return {
    binding: test.binding,
    effectKey: test.intent.effect_key,
    intentId: test.intent.intent_id,
    intentDigest: test.intent.intent_digest,
    intentGeneration: test.intent.fencing_generation,
    intentMode: "observe-before-apply" as const,
    role: "implementer" as const,
    invocationId,
    providerCandidateSha: BASE_SHA,
    limits: {
      wallSeconds: test.policy.budgets.wallSeconds,
      maxCostUsd: test.policy.budgets.maxCostUsd,
      maxAgentInvocations: test.policy.budgets.maxAgentInvocations,
    },
  };
}

describe("durable ASF provider budgets", () => {
  it("reserves before invocation, rounds observed cost up, and exposes non-secret attribution", () => {
    const test = setup({ maxCostUsd: 1.000001, maxAgentInvocations: 3 });
    const input = reservationInput(test);
    const reserved = test.budget.reserve(input);
    expect(reserved).toMatchObject({
      status: "reserved",
      allowance: {
        authorization: "invoke",
        maxCostUsd: 1.000001,
        invocationOrdinal: 1,
      },
    });
    if (reserved.status !== "reserved") throw new Error("test reservation was denied");

    const completion = test.budget.complete({
      binding: input.binding,
      reservationId: reserved.allowance.reservationId,
      reservationDigest: reserved.allowance.reservationDigest,
      effectKey: input.effectKey,
      intentId: input.intentId,
      intentDigest: input.intentDigest,
      role: input.role,
      invocationId: input.invocationId,
      providerCandidateSha: BASE_SHA,
      providerResultDigest: sha256Digest({ result: 1 }),
      provider: "codex",
      model: "gpt-production",
      principal: "principal-implementer",
      profile: "profile-implementer",
      actualCostUsd: 0.1000001,
      limits: input.limits,
    });

    expect(completion).toMatchObject({
      actualCostMicros: 100_001,
      conservativeCostMicros: 100_001,
      invocationCount: 1,
      completedAfterDeadline: false,
      exceededReservedCost: false,
    });
    expect(test.store.getAsfProviderBudgetUsage(test.binding.runId)).toMatchObject({
      maxCostMicros: 1_000_001,
      completedCostMicros: 100_001,
      outstandingReservedCostMicros: 0,
      conservativeCostMicros: 100_001,
      invocationCount: 1,
    });
    const [record] = test.store.listAsfProviderBudgetReservations(test.binding.runId);
    expect(record).toMatchObject({
      status: "completed",
      actualCostMicros: 100_001,
      role: "implementer",
      provider: "codex",
      model: "gpt-production",
      principal: "principal-implementer",
      profile: "profile-implementer",
    });
    expect(Object.keys(record ?? {})).not.toEqual(
      expect.arrayContaining(["credential", "token", "lease", "session"]),
    );

    close(test.store);
    const reopened = open();
    expect(reopened.getAsfProviderBudgetUsage(test.binding.runId).conservativeCostMicros)
      .toBe(100_001);
  });

  it("permits only reconciliation of an existing provider reservation while durably paused", () => {
    const test = setup({ maxCostUsd: 1, maxAgentInvocations: 2 });
    const input = reservationInput(test);
    const reserved = test.budget.reserve(input);
    if (reserved.status !== "reserved") throw new Error("test reservation was denied");

    test.store.transitionAsfRun({
      runId: input.binding.runId,
      ownerId: OWNER,
      generation: 1,
      from: "ADMITTED",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 1,
      eventType: "run.blocked_external",
      payload: {
        code: "PROVIDER_RESULT_RECONCILIATION_REQUIRED",
        summary: "the provider result must be reconciled before execution can continue",
        checkpoint: "ADMITTED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action: "reconcile the exact provider reservation",
        evidence_refs: [reserved.allowance.reservationDigest],
      },
    });

    expect(
      test.budget.reserve({ ...input, intentMode: "reconcile-only" }),
    ).toMatchObject({
      status: "reserved",
      allowance: { authorization: "reconcile-only", maxCostUsd: 0 },
    });
    expect(() =>
      test.budget.complete({
        binding: input.binding,
        reservationId: reserved.allowance.reservationId,
        reservationDigest: reserved.allowance.reservationDigest,
        effectKey: input.effectKey,
        intentId: input.intentId,
        intentDigest: input.intentDigest,
        role: input.role,
        invocationId: input.invocationId,
        providerCandidateSha: BASE_SHA,
        providerResultDigest: sha256Digest({ result: "forbidden-while-paused" }),
        provider: "codex",
        model: "gpt-production",
        principal: "principal-implementer",
        profile: "profile-implementer",
        actualCostUsd: 0.1,
        limits: input.limits,
      }),
    ).toThrow(RunmillError);
    expect(test.store.listAsfProviderBudgetReservations(input.binding.runId)[0]).toMatchObject({
      status: "reserved",
      actualCostMicros: null,
    });
  });

  it("denies a zero signed cost cap and refuses unsigned terminalization", () => {
    const test = setup({ maxCostUsd: 0 });
    const input = reservationInput(test);
    const denied = test.budget.reserve(input);
    expect(denied).toMatchObject({ status: "exhausted", reason: "cost-limit" });
    if (denied.status !== "exhausted") throw new Error("zero cost cap widened authority");
    expect(test.store.getAsfProviderBudgetUsage(test.binding.runId)).toMatchObject({
      invocationCount: 0,
      deniedCount: 1,
    });

    test.store.confirmAsfDeliveryIntent({
      ownerId: OWNER,
      intentId: input.intentId,
      intentDigest: input.intentDigest,
      observationDigest: denied.observationDigest,
      binding: input.binding,
    });
    expect(() =>
      test.store.transitionAsfRun({
        runId: input.binding.runId,
        ownerId: OWNER,
        generation: 1,
        from: "ADMITTED",
        to: "BUDGET_EXHAUSTED",
        expectedVersion: 1,
        eventType: "budget.exhausted",
        payload: {
          code: "AGENT_COST_BUDGET_EXHAUSTED",
          summary: "the aggregate ASF provider cost budget is exhausted",
          checkpoint: "ADMITTED",
          retry_disposition: "new-attempt-required",
          required_actor: "asf",
          required_action: "submit a new signed Work Order attempt",
          evidence_refs: [denied.observationDigest],
        },
        checkpoint: {
          kind: "lease-release-workspace-cleanup",
          durableInputs: { terminal_outcome: "BUDGET_EXHAUSTED" },
          durableOutputs: { cleanup_evidence_digest: DIGEST_A },
          correlationMarker: null,
        },
      }),
    ).toThrow();
    expect(test.store.getAsfRun(input.binding.runId)).toMatchObject({
      state: "ADMITTED",
      stateVersion: 1,
    });
  });

  it("keeps unknown crash-window usage fully reserved across a fenced takeover", () => {
    const test = setup({ maxCostUsd: 2, maxAgentInvocations: 2 });
    const input = reservationInput(test);
    const first = test.budget.reserve(input);
    expect(first).toMatchObject({
      status: "reserved",
      allowance: { authorization: "invoke", maxCostUsd: 2 },
    });
    expect(test.store.getAsfProviderBudgetUsage(test.binding.runId)).toMatchObject({
      outstandingReservedCostMicros: 2_000_000,
      conservativeCostMicros: 2_000_000,
      invocationCount: 1,
    });

    clock.advanceMinutes(2);
    expect(test.store.claimAsfRun({
      runId: test.binding.runId,
      ownerId: "budget-worker-02",
      staleBefore: "2026-08-21T10:01:00.000Z",
    })).toEqual({ generation: 2, takeover: true });
    const takeover = new StateStoreAsfProviderBudgetController(test.store, "budget-worker-02");
    const currentBinding = { ...input.binding, fencingGeneration: 2 };
    const reconciled = takeover.reserve({
      ...input,
      binding: currentBinding,
      intentMode: "reconcile-only",
    });
    expect(reconciled).toMatchObject({
      status: "reserved",
      allowance: { authorization: "reconcile-only", maxCostUsd: 0 },
    });
    expect(() => test.budget.reserve(input)).toThrow(/fencing generation stale/u);
    expect(test.store.getAsfProviderBudgetUsage(test.binding.runId)).toMatchObject({
      outstandingReservedCostMicros: 2_000_000,
      invocationCount: 1,
    });
  });

  it("conservatively settles reconciled unknown usage and denies provider replay", () => {
    const test = setup({ maxCostUsd: 2, maxAgentInvocations: 2 });
    const input = reservationInput(test);
    const reserved = test.budget.reserve(input);
    if (reserved.status !== "reserved") throw new Error("test reservation was denied");
    const observationDigest = sha256Digest({
      intent_digest: input.intentDigest,
      outcome: "not_applied",
    });

    test.store.resolveAsfDeliveryIntentReconciliation({
      effectKey: input.effectKey,
      ownerId: OWNER,
      generation: 1,
      outcome: "not_applied",
      observationDigest,
    });
    const [settled] = test.store.listAsfProviderBudgetReservations(
      input.binding.runId,
    );
    expect(settled).toMatchObject({
      status: "settled_unknown",
      reservedCostMicros: 2_000_000,
      actualCostMicros: 2_000_000,
      completedGeneration: 1,
      settlementOutcome: "not_applied",
      settlementObservationDigest: observationDigest,
      settlementGeneration: 1,
      settlementAt: NOW,
      completedAt: NOW,
      providerResultDigest: null,
      provider: null,
      model: null,
      principal: null,
      profile: null,
    });
    expect(settled?.settlementDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(test.store.getAsfProviderBudgetUsage(input.binding.runId)).toMatchObject({
      completedCostMicros: 0,
      settledUnknownCostMicros: 2_000_000,
      outstandingReservedCostMicros: 0,
      conservativeCostMicros: 2_000_000,
      invocationCount: 1,
      settlementCount: 1,
    });
    const evidence = test.store.getAsfProviderBudgetEvidenceSummary(
      input.binding.runId,
    );
    expect(evidence).toMatchObject({
      usage: {
        reportedActualCostMicros: 0,
        settledUnknownCostMicros: 2_000_000,
        outstandingReservedCostMicros: 0,
        conservativeCostMicros: 2_000_000,
        invocationCount: 1,
        completedInvocationCount: 0,
        settledUnknownInvocationCount: 1,
        outstandingInvocationCount: 0,
      },
      settlementDigests: [settled?.settlementDigest],
    });
    expect(evidence.ledgerDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    // Exact reconciliation retries validate and preserve the same settlement.
    test.store.resolveAsfDeliveryIntentReconciliation({
      effectKey: input.effectKey,
      ownerId: OWNER,
      generation: 1,
      outcome: "not_applied",
      observationDigest,
    });
    expect(
      test.budget.reserve({ ...input, intentMode: "reconcile-only" }),
    ).toEqual({
      status: "exhausted",
      reason: "cost-limit",
      observationDigest: settled?.settlementDigest,
    });

    close(test.store);
    const reopened = open();
    expect(reopened.getAsfProviderBudgetEvidenceSummary(input.binding.runId)).toEqual(
      evidence,
    );
  });

  it("refuses stale and cross-effect settlement without changing the reservation", () => {
    const test = setup({ maxCostUsd: 1 });
    const input = reservationInput(test);
    expect(test.budget.reserve(input)).toMatchObject({ status: "reserved" });
    clock.advanceMinutes(2);
    expect(
      test.store.claimAsfRun({
        runId: input.binding.runId,
        ownerId: "budget-worker-02",
        staleBefore: "2026-08-21T10:01:00.000Z",
      }),
    ).toEqual({ generation: 2, takeover: true });
    const observationDigest = sha256Digest({ outcome: "confirmed" });

    expect(() =>
      test.store.resolveAsfDeliveryIntentReconciliation({
        effectKey: input.effectKey,
        ownerId: OWNER,
        generation: 1,
        outcome: "confirmed",
        observationDigest,
      }),
    ).toThrow(RunmillError);
    expect(() =>
      test.store.resolveAsfDeliveryIntentReconciliation({
        effectKey: "delivery_effect_cross_bound",
        ownerId: "budget-worker-02",
        generation: 2,
        outcome: "confirmed",
        observationDigest,
      }),
    ).toThrow(RunmillError);
    expect(test.store.listAsfProviderBudgetReservations(input.binding.runId)[0]).toMatchObject({
      status: "reserved",
      actualCostMicros: null,
      settlementDigest: null,
    });

    test.store.resolveAsfDeliveryIntentReconciliation({
      effectKey: input.effectKey,
      ownerId: "budget-worker-02",
      generation: 2,
      outcome: "confirmed",
      observationDigest,
    });
    expect(test.store.listAsfProviderBudgetReservations(input.binding.runId)[0]).toMatchObject({
      status: "settled_unknown",
      completedGeneration: 2,
      settlementGeneration: 2,
      settlementOutcome: "confirmed",
    });
  });

  it("detects a tampered conservative settlement after reopen", () => {
    const test = setup({ maxCostUsd: 1 });
    const input = reservationInput(test);
    test.budget.reserve(input);
    test.store.resolveAsfDeliveryIntentReconciliation({
      effectKey: input.effectKey,
      ownerId: OWNER,
      generation: 1,
      outcome: "confirmed",
      observationDigest: sha256Digest({ exact: "provider-unknown" }),
    });
    close(test.store);

    const corrupt = new Database(databasePath());
    corrupt
      .prepare(
        `UPDATE asf_provider_budget_reservations SET settlement_digest = ?
         WHERE effect_key = ?`,
      )
      .run(sha256Digest({ tampered: true }), input.effectKey);
    corrupt.close();

    const reopened = open();
    expect(() =>
      reopened.listAsfProviderBudgetReservations(input.binding.runId),
    ).toThrow(RunmillError);
    expect(() =>
      reopened.getAsfProviderBudgetEvidenceSummary(input.binding.runId),
    ).toThrow(RunmillError);
  });

  it.each(["completed", "denied"] as const)(
    "rejects a tampered %s provider ledger row even when SQLite checks are bypassed",
    (status) => {
      const test = setup({ maxCostUsd: status === "denied" ? 0 : 1 });
      const input = reservationInput(test);
      const decision = test.budget.reserve(input);
      if (status === "completed") {
        if (decision.status !== "reserved") {
          throw new Error("completed tamper fixture was unexpectedly denied");
        }
        test.budget.complete({
          binding: input.binding,
          reservationId: decision.allowance.reservationId,
          reservationDigest: decision.allowance.reservationDigest,
          effectKey: input.effectKey,
          intentId: input.intentId,
          intentDigest: input.intentDigest,
          role: input.role,
          invocationId: input.invocationId,
          providerCandidateSha: BASE_SHA,
          providerResultDigest: sha256Digest({ result: "complete" }),
          provider: "codex",
          model: "gpt-production",
          principal: "principal-implementer",
          profile: "profile-implementer",
          actualCostUsd: 0.25,
          limits: input.limits,
        });
      } else {
        expect(decision).toMatchObject({
          status: "exhausted",
          reason: "cost-limit",
        });
      }
      close(test.store);

      const corrupt = new Database(databasePath());
      corrupt.pragma("ignore_check_constraints = ON");
      if (status === "completed") {
        corrupt
          .prepare(
            `UPDATE asf_provider_budget_reservations SET provider = NULL
             WHERE run_id = ?`,
          )
          .run(input.binding.runId);
      } else {
        corrupt
          .prepare(
            `UPDATE asf_provider_budget_reservations SET actual_cost_micros = 1
             WHERE run_id = ?`,
          )
          .run(input.binding.runId);
      }
      corrupt.close();

      const reopened = open();
      expect(() =>
        reopened.getAsfProviderBudgetEvidenceSummary(input.binding.runId),
      ).toThrow(RunmillError);
    },
  );

  it("upgrades and heals a v8 resolved-intent reservation crash window before terminal evidence", () => {
    const test = setup({ maxCostUsd: 2 });
    const input = reservationInput(test);
    expect(test.budget.reserve(input)).toMatchObject({ status: "reserved" });
    const observationDigest = sha256Digest({
      legacy_v8_reconciliation: "not-applied",
    });
    test.store.resolveAsfDeliveryIntentReconciliation({
      effectKey: input.effectKey,
      ownerId: OWNER,
      generation: 1,
      outcome: "not_applied",
      observationDigest,
    });
    close(test.store);

    // Recreate the exact pre-v9 crash window: reconciliation was durably
    // resolved, but the old provider ledger could only retain `reserved`.
    const legacy = new Database(databasePath());
    const providerV5 = MIGRATIONS.find((migration) => migration.version === 5);
    if (providerV5 === undefined) throw new Error("provider v5 migration missing");
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      DROP TABLE asf_terminal_evidence_bundles;
      DROP TABLE asf_terminal_evidence_intents;
      ALTER TABLE asf_evidence_bundles
        DROP COLUMN canonical_envelope_digest;
      ALTER TABLE asf_provider_budget_reservations
        RENAME TO asf_provider_budget_reservations_v9_seed;
      DROP INDEX idx_asf_provider_budget_run;
    `);
    legacy.exec(providerV5.up);
    legacy.exec(`
      INSERT INTO asf_provider_budget_reservations(
        reservation_id, reservation_digest, effect_key, intent_id, intent_digest,
        run_id, work_order_id, attempt_id, policy_digest, initial_generation,
        completed_generation, lifecycle_candidate_sha, provider_candidate_sha,
        role, invocation_id, reserved_cost_micros, actual_cost_micros,
        max_cost_micros, max_agent_invocations, accepted_at, deadline_at,
        status, denial_reason, denial_observation_digest, provider_result_digest,
        provider, model, principal, profile, created_at, completed_at
      )
      SELECT reservation_id, reservation_digest, effect_key, intent_id, intent_digest,
             run_id, work_order_id, attempt_id, policy_digest, initial_generation,
             NULL, lifecycle_candidate_sha, provider_candidate_sha,
             role, invocation_id, reserved_cost_micros, NULL,
             max_cost_micros, max_agent_invocations, accepted_at, deadline_at,
             'reserved', NULL, NULL, NULL, NULL, NULL, NULL, NULL, created_at, NULL
      FROM asf_provider_budget_reservations_v9_seed;
      DROP TABLE asf_provider_budget_reservations_v9_seed;
      DELETE FROM schema_migrations WHERE version >= 9;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const upgraded = open();
    expect(
      upgraded.getAsfProviderBudgetEvidenceSummary(input.binding.runId).usage,
    ).toMatchObject({
      outstandingReservedCostMicros: 2_000_000,
      settledUnknownCostMicros: 0,
    });
    const healed = upgraded.prepareAsfTerminalProviderBudgetEvidence({
      runId: input.binding.runId,
      ownerId: OWNER,
      generation: 1,
    });
    expect(healed.usage).toMatchObject({
      outstandingReservedCostMicros: 0,
      settledUnknownCostMicros: 2_000_000,
      conservativeCostMicros: 2_000_000,
    });
    expect(healed.settlementDigests).toHaveLength(1);
    expect(
      upgraded.listAsfProviderBudgetReservations(input.binding.runId)[0],
    ).toMatchObject({
      status: "settled_unknown",
      settlementOutcome: "not_applied",
      settlementObservationDigest: observationDigest,
      actualCostMicros: 2_000_000,
    });
    close(upgraded);

    const migrated = new Database(databasePath(), { readonly: true });
    const indexes = migrated
      .prepare("PRAGMA index_list(asf_provider_budget_reservations)")
      .all() as { readonly name: string }[];
    const foreignKeys = migrated
      .prepare("PRAGMA foreign_key_list(asf_provider_budget_reservations)")
      .all() as { readonly table: string }[];
    expect(indexes.map((index) => index.name)).toContain(
      "idx_asf_provider_budget_run",
    );
    expect(foreignKeys.map((foreignKey) => foreignKey.table)).toEqual(
      expect.arrayContaining(["runs", "asf_delivery_stage_intents"]),
    );
    migrated.close();
  });

  it("uses the immutable accepted-at deadline and refuses a late completion", () => {
    const test = setup({ wallSeconds: 1, maxCostUsd: 1 });
    const input = reservationInput(test);
    const reserved = test.budget.reserve(input);
    if (reserved.status !== "reserved") throw new Error("test reservation was denied");
    clock.advanceMs(1_000);
    expect(test.budget.checkRun({ binding: input.binding, limits: input.limits })).toMatchObject({
      status: "exhausted",
      reason: "wall-deadline",
    });
    expect(test.budget.complete({
      binding: input.binding,
      reservationId: reserved.allowance.reservationId,
      reservationDigest: reserved.allowance.reservationDigest,
      effectKey: input.effectKey,
      intentId: input.intentId,
      intentDigest: input.intentDigest,
      role: input.role,
      invocationId: input.invocationId,
      providerCandidateSha: BASE_SHA,
      providerResultDigest: sha256Digest({ late: true }),
      provider: "codex",
      model: "gpt-production",
      principal: "principal-implementer",
      profile: "profile-implementer",
      actualCostUsd: 0.25,
      limits: input.limits,
    })).toMatchObject({ completedAfterDeadline: true });
  });
});
