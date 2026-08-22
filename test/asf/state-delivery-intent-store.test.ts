import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AsfDeliveryBinding,
  AsfDeliveryStageIntent,
} from "../../src/asf/delivery-runner.js";
import { StateStoreAsfDeliveryIntentStore } from "../../src/asf/state-delivery-intent-store.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../../src/asf/canonical-json.js";
import {
  EFFECTIVE_POLICY_SCHEMA,
  WORK_ORDER_ENVELOPE_SCHEMA,
  WORK_ORDER_SCHEMA,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "../../src/asf/work-order.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import { MIGRATIONS } from "../../src/state/migrations.js";
import {
  CURRENT_SCHEMA_VERSION,
  MIN_ASF_DETAILED_EVENT_RETENTION_MS,
  StateStore,
} from "../../src/state/store.js";
import {
  ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
  ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
  ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
  asfTerminalEvidencePlanSchema,
  asfTerminalEvidenceStatementSchema,
  portableAsfTerminalProviderBudgetEvidence,
  signAsfTerminalEvidenceBundle,
} from "../../src/evidence/asf-terminal.js";
import {
  ASF_EVIDENCE_PREDICATE_SCHEMA,
  ASF_EVIDENCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_V1,
  signAsfEvidenceBundle,
} from "../../src/evidence/asf-bundle.js";

const NOW = "2026-08-21T10:05:00.000Z";
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "c".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const OBSERVATION_A = sha256Digest({ observation: "applied" });
const OBSERVATION_B = sha256Digest({ observation: "different" });

let directory: string;
let clock: FakeClock;
const stores = new Set<StateStore>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-delivery-intents-"));
  clock = new FakeClock(NOW);
});

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  return join(directory, "runmill.db");
}

function open(): StateStore {
  const store = StateStore.open(databasePath(), { clock });
  stores.add(store);
  return store;
}

function close(store: StateStore): void {
  store.close();
  stores.delete(store);
}

function envelope(): WorkOrderEnvelope {
  return {
    schema: WORK_ORDER_ENVELOPE_SCHEMA,
    key_id: "asf-signing-key-2026-01",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:00:00Z",
    not_before: "2026-08-21T10:00:00Z",
    expires_at: "2026-08-21T10:15:00Z",
    payload: {
      schema: WORK_ORDER_SCHEMA,
      work_order_id: "wo_intent_01",
      tenant_id: "tenant-acme",
      work_item_id: "ENG-INTENT",
      attempt_id: "attempt_01",
      idempotency_key: "tenant-acme/ENG-INTENT/attempt_01",
      source: {
        system: "linear",
        external_id: "ENG-INTENT",
        snapshot_digest: DIGEST_A,
      },
      repository: {
        forge: "github",
        repository: "acme/payments",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: "Persist lifecycle intent",
        description: "Commit the exact effect authorization before invocation.",
        acceptance_criteria: ["A takeover reconciles instead of reapplying."],
        non_goals: ["Merging the pull request."],
      },
      scope: {
        allowed_paths: ["src/**", "test/**"],
        forbidden_paths: [".github/**", ".runmill/**"],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["lint", "unit"],
        required_remote_checks: ["ci/test"],
        policy_snapshot_digest: DIGEST_B,
      },
      identities: {
        implementer: "codex:asf-production",
        local_reviewer: "claude:asf-review",
        pr_reviewer: "claude:asf-review",
      },
      runtime: {
        sandbox_profile: "linux-production-v1",
        tool_policy: "repo-change-v1",
        network_policy: "provider-only-v1",
      },
      budgets: {
        wall_seconds: 7_200,
        max_cost_usd: 10,
        max_agent_invocations: 12,
        max_fix_iterations: 3,
      },
      delivery: {
        closure_target: "pr",
        draft_pr: false,
        merge_policy_ref: null,
      },
      policy_digest: DIGEST_C,
      harness_digest: DIGEST_D,
    },
    signature: "base64url:c2lnbmF0dXJl",
  };
}

function effectivePolicy(): EffectiveAsfPolicy {
  return {
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
      observedBaseSha: "b".repeat(40),
      forgeProtection: DIGEST_D,
      forgeProtectionBaseRef: "refs/heads/main",
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [
      {
        source: "operator",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      {
        source: "work-order",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      {
        source: "repository",
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
    ],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["lint", "unit"],
    requiredRemoteChecks: ["ci/test"],
    riskClass: "low",
    identities: {
      implementer: "codex:asf-production",
      localReviewer: "claude:asf-review",
      prReviewer: "claude:asf-review",
    },
    runtime: {
      sandboxProfile: "linux-production-v1",
      toolPolicy: "repo-change-v1",
      networkPolicy: "provider-only-v1",
    },
    budgets: {
      wallSeconds: 7_200,
      maxCostUsd: 10,
      maxAgentInvocations: 12,
      maxFixIterations: 3,
    },
    delivery: { closureTarget: "pr", draftPr: false },
  };
}

function admitAndClaim(store: StateStore, ownerId = "worker-a"): void {
  const workOrder = envelope();
  store.admitAsfWorkOrder({
    runId: "run_intent_01",
    envelope: workOrder,
    canonicalEnvelope: canonicalJson(workOrder),
    envelopeDigest: sha256Digest(workOrder),
    payloadDigest: sha256Digest(workOrder.payload),
    effectivePolicy: effectivePolicy(),
  });
  expect(
    store.claimAsfRun({
      runId: "run_intent_01",
      ownerId,
      staleBefore: "2026-08-21T10:04:00.000Z",
    }),
  ).toEqual({ generation: 1, takeover: false });
}

function intent(
  generation: number,
  overrides: Partial<AsfDeliveryStageIntent> = {},
): AsfDeliveryStageIntent {
  const operationDigest =
    overrides.operation_digest ??
    sha256Digest({ repository: "acme/payments", base_sha: BASE_SHA });
  const eventSeq = overrides.event_seq ?? 1;
  const candidateSha =
    overrides.candidate_sha === undefined ? null : overrides.candidate_sha;
  const stage = overrides.stage ?? "repository-lease";
  const effectKey = `delivery_effect_${sha256Digest({
    stage,
    run_id: "run_intent_01",
    candidate_sha: candidateSha,
    event_seq: eventSeq,
    operation_digest: operationDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const identityDigest = sha256Digest({ effect_key: effectKey, generation });
  const unsigned = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: `delivery_${identityDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    effect_key: effectKey,
    stage,
    run_id: "run_intent_01",
    work_order_id: "wo_intent_01",
    attempt_id: "attempt_01",
    policy_digest: DIGEST_D,
    fencing_generation: generation,
    candidate_sha: candidateSha,
    event_seq: eventSeq,
    operation_digest: operationDigest,
    created_at: NOW,
    ...overrides,
  };
  const { intent_digest: suppliedDigest, ...withoutSuppliedDigest } =
    unsigned as typeof unsigned & { readonly intent_digest?: string };
  return {
    ...withoutSuppliedDigest,
    intent_digest: suppliedDigest ?? sha256Digest(withoutSuppliedDigest),
  };
}

function binding(generation = 1): AsfDeliveryBinding {
  return {
    runId: "run_intent_01",
    workOrderId: "wo_intent_01",
    attemptId: "attempt_01",
    policyDigest: DIGEST_D,
    fencingGeneration: generation,
    candidateSha: null,
  };
}

function expectRunmillCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe(code);
  }
}

describe("StateStoreAsfDeliveryIntentStore", () => {
  it("commits the exact intent durably before returning and is exactly idempotent", () => {
    const first = open();
    admitAndClaim(first);
    const adapter = new StateStoreAsfDeliveryIntentStore(first, "worker-a");
    const prepared = intent(1);

    expect(adapter.record(prepared)).toEqual({
      intent: prepared,
      disposition: "created",
    });
    close(first);

    const reopened = open();
    expect(reopened.getAsfDeliveryIntent(prepared.effect_key)).toMatchObject({
      ...prepared,
      observationDigest: null,
      confirmedGeneration: null,
    });
    expect(
      new StateStoreAsfDeliveryIntentStore(reopened, "worker-a").record(
        prepared,
      ),
    ).toEqual({
      intent: prepared,
      disposition: "existing-current",
    });
  });

  it("rejects self-inconsistent identities, digests, extra fields, and current bindings", () => {
    const store = open();
    admitAndClaim(store);
    const adapter = new StateStoreAsfDeliveryIntentStore(store, "worker-a");
    const prepared = intent(1);

    expectRunmillCode(
      () => adapter.record({ ...prepared, intent_digest: DIGEST_A }),
      "RM-STATE-002",
    );
    expectRunmillCode(
      () =>
        adapter.record({ ...prepared, effect_key: `${prepared.effect_key}x` }),
      "RM-STATE-002",
    );
    expectRunmillCode(
      () => adapter.record(intent(1, { candidate_sha: CANDIDATE_SHA })),
      "RM-STATE-002",
    );
    expectRunmillCode(
      () => adapter.record(intent(1, { policy_digest: DIGEST_C })),
      "RM-STATE-002",
    );
    expect(() =>
      adapter.record({
        ...prepared,
        unexpected: true,
      } as unknown as AsfDeliveryStageIntent),
    ).toThrow();
    expect(store.getAsfDeliveryIntent(prepared.effect_key)).toBeUndefined();
  });

  it("returns the immutable prior intent as reconcile-only after a takeover", () => {
    const store = open();
    admitAndClaim(store);
    const prior = intent(1);
    expect(
      new StateStoreAsfDeliveryIntentStore(store, "worker-a").record(prior),
    ).toMatchObject({
      disposition: "created",
    });

    clock.advanceMinutes(2);
    expect(
      store.claimAsfRun({
        runId: "run_intent_01",
        ownerId: "worker-b",
        staleBefore: "2026-08-21T10:06:00.000Z",
      }),
    ).toEqual({ generation: 2, takeover: true });
    const currentAttempt = intent(2);
    expect(
      new StateStoreAsfDeliveryIntentStore(store, "worker-b").record(
        currentAttempt,
      ),
    ).toEqual({
      intent: prior,
      disposition: "existing-prior-generation",
    });
    expect(store.getAsfDeliveryIntent(prior.effect_key)).toMatchObject({
      intent_id: prior.intent_id,
      fencing_generation: 1,
    });
    expectRunmillCode(
      () =>
        new StateStoreAsfDeliveryIntentStore(store, "worker-a").record(prior),
      "RM-LEASE-001",
    );
  });

  it("confirms only the same exact observation under current ownership", () => {
    const store = open();
    admitAndClaim(store);
    const adapter = new StateStoreAsfDeliveryIntentStore(store, "worker-a");
    const prepared = intent(1);
    adapter.record(prepared);
    const confirmation = {
      intentId: prepared.intent_id,
      intentDigest: prepared.intent_digest,
      observationDigest: OBSERVATION_A,
      binding: binding(),
    };

    adapter.confirm(confirmation);
    expect(() => adapter.confirm(confirmation)).not.toThrow();
    expect(store.getAsfDeliveryIntent(prepared.effect_key)).toMatchObject({
      observationDigest: OBSERVATION_A,
      confirmedGeneration: 1,
      confirmedAt: NOW,
    });
    expect(
      store.listAsfDeliveryIntentObservations(prepared.effect_key),
    ).toEqual([
      {
        effectKey: prepared.effect_key,
        seq: 1,
        outcome: "confirmed",
        observationDigest: OBSERVATION_A,
        generation: 1,
        source: "confirmation",
        observedAt: NOW,
      },
    ]);
    expectRunmillCode(
      () =>
        adapter.confirm({ ...confirmation, observationDigest: OBSERVATION_B }),
      "RM-STATE-002",
    );
    expectRunmillCode(
      () => adapter.confirm({ ...confirmation, intentDigest: DIGEST_A }),
      "RM-STATE-002",
    );
    expectRunmillCode(
      () =>
        adapter.confirm({
          ...confirmation,
          binding: { ...binding(), policyDigest: DIGEST_C },
        }),
      "RM-STATE-002",
    );
  });

  it.each([
    {
      corruption: "future confirmation timestamp",
      mutate(database: Database.Database) {
        database
          .prepare(
            `UPDATE asf_delivery_stage_intents
             SET confirmed_at = '2026-08-21T10:06:00.000Z'`,
          )
          .run();
      },
    },
    {
      corruption: "confirmation beyond the current run fence",
      mutate(database: Database.Database) {
        database
          .prepare(
            `UPDATE asf_delivery_stage_intents
             SET confirmed_generation = 2`,
          )
          .run();
      },
    },
    {
      corruption: "malformed consumed replay authority",
      mutate(database: Database.Database) {
        database.pragma("foreign_keys = OFF");
        database
          .prepare(
            `UPDATE asf_delivery_stage_intents
             SET observation_digest = NULL, observation_outcome = NULL,
                 confirmed_generation = NULL, confirmed_at = NULL,
                 replay_authorized_operation_id = ?, replay_started_generation = 1`,
          )
          .run("bad\noperation");
      },
    },
  ])("rejects $corruption in a durable intent row", ({ mutate }) => {
    const store = open();
    admitAndClaim(store);
    const adapter = new StateStoreAsfDeliveryIntentStore(store, "worker-a");
    const prepared = intent(1);
    adapter.record(prepared);
    adapter.confirm({
      intentId: prepared.intent_id,
      intentDigest: prepared.intent_digest,
      observationDigest: OBSERVATION_A,
      binding: binding(),
    });
    close(store);

    const database = new Database(databasePath());
    mutate(database);
    database.close();

    const reopened = open();
    expectRunmillCode(
      () => reopened.getAsfDeliveryIntent(prepared.effect_key),
      "RM-STATE-002",
    );
  });

  it("allows a current owner to confirm a reconciled prior intent but fences the stale owner", () => {
    const store = open();
    admitAndClaim(store);
    const prior = intent(1);
    const stale = new StateStoreAsfDeliveryIntentStore(store, "worker-a");
    stale.record(prior);
    clock.advanceMinutes(2);
    store.claimAsfRun({
      runId: "run_intent_01",
      ownerId: "worker-b",
      staleBefore: "2026-08-21T10:06:00.000Z",
    });
    const confirmation = {
      intentId: prior.intent_id,
      intentDigest: prior.intent_digest,
      observationDigest: OBSERVATION_A,
      binding: binding(2),
    };

    expectRunmillCode(
      () => stale.confirm({ ...confirmation, binding: binding(1) }),
      "RM-LEASE-001",
    );
    const current = new StateStoreAsfDeliveryIntentStore(store, "worker-b");
    expect(current.record(intent(2))).toMatchObject({
      intent: prior,
      disposition: "existing-prior-generation",
    });
    current.confirm(confirmation);
    expect(store.getAsfDeliveryIntent(prior.effect_key)).toMatchObject({
      observationDigest: OBSERVATION_A,
      confirmedGeneration: 2,
    });
  });
});

describe("delivery-intent migration compatibility", () => {
  it("adds the ASF-only table without changing existing standalone rows", () => {
    const legacy = new Database(databasePath());
    for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) {
      legacy.exec(migration.up);
      legacy
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)",
        )
        .run(migration.version, migration.name, NOW);
      legacy.pragma(`user_version = ${migration.version}`);
    }
    legacy
      .prepare(
        `INSERT INTO runs(run_id, issue_id, repo, provider, state, state_version, attempt,
                          created_at, updated_at, mode)
         VALUES ('run_standalone','ENG-1','acme/payments','codex','DISCOVERED',1,1,?,?,'standalone')`,
      )
      .run(NOW, NOW);
    legacy.close();

    const migrated = open();
    expect(migrated.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.getRun("run_standalone")).toMatchObject({
      runId: "run_standalone",
      state: "DISCOVERED",
    });
    expect(migrated.appliedMigrations()).toContainEqual({
      version: 7,
      name: "asf_delivery_intent_replay_authority",
    });
  });
});

function completionReady(
  options: { readonly malformedDelivery?: boolean } = {},
): StateStore {
  const initial = open();
  admitAndClaim(initial);
  close(initial);

  // Isolate the completion gate from the many preceding lifecycle gates. The
  // rows below represent the exact durable precondition that completion reads:
  // an EVIDENCE_FINALIZED candidate and its immutable bundle record.
  const fixture = new Database(databasePath());
  fixture
    .prepare(
      `UPDATE runs SET state = 'EVIDENCE_FINALIZED', candidate_sha = ?, state_version = 2
       WHERE run_id = 'run_intent_01'`,
    )
    .run(CANDIDATE_SHA);
  fixture
    .prepare(
      `INSERT INTO events(
         run_id, seq, type, payload, artifact_ref, redaction_ruleset_version,
         at, event_id, schema, phase, policy_digest
       ) VALUES ('run_intent_01', 2, 'candidate.created', ?, NULL, 'asf-public-v1', ?,
                 'evt_candidate_fixture', 'asf.run-event/v1', 'CANDIDATE_READY', ?)`,
    )
    .run(
      JSON.stringify({
        candidate_sha: CANDIDATE_SHA,
        parent_sha: BASE_SHA,
        tree_digest: DIGEST_C,
      }),
      NOW,
      DIGEST_D,
    );
  fixture
    .prepare(
      `INSERT INTO asf_evidence_bundles(
         run_id, candidate_sha, policy_digest, bundle_digest,
         canonical_envelope_digest, canonical_envelope, finalized_at
       ) VALUES ('run_intent_01',?,?,?,?,?,?)`,
    )
    .run(CANDIDATE_SHA, DIGEST_D, DIGEST_B, sha256Digest({}), "{}", NOW);
  if (options.malformedDelivery === true) {
    const { delivery: _delivery, ...withoutDelivery } = effectivePolicy();
    const malformed = { ...withoutDelivery, closureTarget: "pr" };
    fixture
      .prepare(
        "UPDATE asf_work_order_admissions SET effective_policy = ? WHERE run_id = ?",
      )
      .run(canonicalJson(malformed as unknown as JsonValue), "run_intent_01");
  }
  fixture.close();
  const store = open();
  const admission = store.getAsfAdmissionForRun("run_intent_01");
  if (admission === undefined)
    throw new Error("completion admission disappeared");
  const providerBudget = portableAsfTerminalProviderBudgetEvidence(
    store.prepareAsfTerminalProviderBudgetEvidence({
      runId: "run_intent_01",
      ownerId: "worker-a",
      generation: 1,
    }),
  );
  const sideEffects = store.prepareAsfTerminalEffectLedger({
    runId: "run_intent_01",
  });
  const unsignedPlan = {
    schema: ASF_TERMINAL_EVIDENCE_PLAN_SCHEMA,
    run: {
      run_id: "run_intent_01",
      work_order_id: "wo_intent_01",
      attempt_id: "attempt_01",
      terminal_phase: "COMPLETED" as const,
      terminal_event_seq: 3,
    },
    admission: {
      work_order_envelope_digest: admission.envelopeDigest,
      work_order_payload_digest: admission.payloadDigest,
      effective_policy_digest: admission.effectivePolicyDigest,
    },
    source: {
      repository: "acme/payments",
      base_sha: BASE_SHA,
      candidate_sha: CANDIDATE_SHA,
    },
    stop: {
      code: "PR_DELIVERED",
      summary: "the exact candidate was delivered as a pull request",
      interrupted_phase: "EVIDENCE_FINALIZED",
      retry_disposition: "safe" as const,
      required_actor: "asf" as const,
      required_action: "acknowledge the immutable terminal evidence",
      evidence_refs: [DIGEST_B],
    },
    provider_budget: providerBudget,
    side_effects: sideEffects,
    cleanup: {
      identity_leases: "released" as const,
      repository_lease: "released" as const,
      workspace: "removed" as const,
      unresolved_effects: 0 as const,
    },
    delivery_bundle_digest: DIGEST_B,
    created_at: NOW,
  } as const;
  const plan = asfTerminalEvidencePlanSchema.parse({
    ...unsignedPlan,
    plan_digest: sha256Digest(unsignedPlan),
  });
  const cleanupIntent = intent(1, {
    stage: "cleanup",
    candidate_sha: CANDIDATE_SHA,
    event_seq: 2,
    operation_digest: plan.plan_digest,
  });
  store.recordAsfTerminalCleanupPlan({
    ownerId: "worker-a",
    cleanupIntent,
    plan,
  });
  const sealed = store.sealAsfTerminalEvidenceIntent({
    runId: "run_intent_01",
    planDigest: plan.plan_digest,
    cleanupObservation: {
      schema: "asf.cleanup-observation/v1",
      binding: {
        run_id: "run_intent_01",
        work_order_id: "wo_intent_01",
        attempt_id: "attempt_01",
        policy_digest: DIGEST_D,
        fencing_generation: 1,
        candidate_sha: CANDIDATE_SHA,
      },
      evidence_digest: DIGEST_C,
      identity_leases: "released",
      repository_lease: "released",
      workspace: "removed",
      unresolved_effects: 0,
    },
    ownerId: "worker-a",
    generation: 1,
  });
  const events = store.listAsfRunEvents("run_intent_01", 0, 100).events;
  const statement = asfTerminalEvidenceStatementSchema.parse({
    _type: IN_TOTO_STATEMENT_V1,
    subject: [
      { name: "asf-run:run_intent_01", digest: { sha1: CANDIDATE_SHA } },
    ],
    predicateType: ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
      run: {
        run_id: "run_intent_01",
        work_order_id: "wo_intent_01",
        attempt_id: "attempt_01",
        terminal_phase: "COMPLETED",
        terminal_event_seq: 3,
      },
      admission: {
        work_order_envelope_digest: admission.envelopeDigest,
        work_order_payload_digest: admission.payloadDigest,
        effective_policy_digest: admission.effectivePolicyDigest,
        work_order_envelope: JSON.parse(admission.canonicalEnvelope),
        signature_verification: {
          verified: true,
          key_id: admission.signatureKeyId,
          algorithm: "EdDSA",
        },
        effective_policy: JSON.parse(admission.effectivePolicy),
      },
      source: {
        repository: "acme/payments",
        base_sha: BASE_SHA,
        candidate_sha: CANDIDATE_SHA,
        subject_kind: "candidate",
        subject_sha: CANDIDATE_SHA,
      },
      stop: {
        code: "PR_DELIVERED",
        summary: "the exact candidate was delivered as a pull request",
        interrupted_phase: "EVIDENCE_FINALIZED",
        retry_disposition: "safe",
        required_actor: "asf",
        required_action: "acknowledge the immutable terminal evidence",
        evidence_refs: [DIGEST_B],
      },
      cancellation: null,
      budget: {
        wall_seconds_limit: 7_200,
        max_cost_usd: 10,
        max_agent_invocations: 12,
        max_fix_iterations: 3,
        observed_fix_iterations: 0,
        evidence_refs: [],
        provider_usage: providerBudget,
      },
      side_effects: sideEffects,
      timing: sealed.intent.timing,
      cleanup: {
        intent_id: cleanupIntent.intent_id,
        intent_digest: cleanupIntent.intent_digest,
        observation_digest: DIGEST_C,
        identity_leases: "released",
        repository_lease: "released",
        workspace: "removed",
        unresolved_effects: 0,
      },
      evidence: {
        preceding_event_count: events.length,
        preceding_event_chain_digest: sha256Digest(events),
        observations: events.map((event) => ({
          event_seq: event.seq,
          event_type: event.type,
          phase: event.phase,
          candidate_sha:
            typeof event.payload["candidate_sha"] === "string"
              ? event.payload["candidate_sha"]
              : null,
          event_digest: sha256Digest(event),
          evidence_refs: [],
        })),
        events,
        delivery_bundle_digest: DIGEST_B,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const bundle = signAsfTerminalEvidenceBundle({
    statement,
    keyId: "terminal-completion-fixture",
    privateKey,
    issuedAt: sealed.intent.created_at,
  });
  store.recordAsfTerminalEvidenceBundle({
    validated: {
      bundle,
      bundleDigest: bundle.bundle_digest,
      candidateSha: CANDIDATE_SHA,
      terminalPhase: "COMPLETED",
      terminalEventSeq: 3,
      signer: {
        keyId: "terminal-completion-fixture",
        algorithm: "EdDSA",
        verified: true,
      },
    },
    ownerId: "worker-a",
    generation: 1,
  });
  return store;
}

function complete(store: StateStore, closureTarget: "pr" | "merge"): void {
  const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
  if (terminal === undefined)
    throw new Error("terminal completion fixture disappeared");
  store.transitionAsfRun({
    runId: "run_intent_01",
    ownerId: "worker-a",
    generation: 1,
    from: "EVIDENCE_FINALIZED",
    to: "COMPLETED",
    expectedVersion: 2,
    eventType: "run.completed",
    payload: {
      candidate_sha: CANDIDATE_SHA,
      closure_target: closureTarget,
      satisfied: true,
      evidence_bundle_digest: DIGEST_B,
      terminal_evidence_bundle_digest: terminal.bundleDigest,
    },
    checkpoint: {
      kind: "lease-release-workspace-cleanup",
      durableInputs: { terminal_outcome: "completed" },
      durableOutputs: {
        cleanup_evidence_digest: DIGEST_C,
        terminal_evidence_bundle_digest: terminal.bundleDigest,
      },
      correlationMarker: terminal.cleanupIntentId,
    },
  });
}

function acknowledge(
  store: StateStore,
  acknowledgementId: string,
  bundleDigest: string,
) {
  const acknowledgement = {
    schema: "asf.outcome-acknowledgement/v1" as const,
    acknowledgement_id: acknowledgementId,
    run_id: "run_intent_01",
    bundle_digest: bundleDigest,
    acknowledged_by: {
      subject: "service:asf-controller",
      authority: "asf:acknowledge-outcome" as const,
    },
  };
  return store.acknowledgeAsfOutcome({
    acknowledgement,
    requestDigest: sha256Digest(acknowledgement),
  });
}

function legacyDeliveryBundle() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return signAsfEvidenceBundle({
    keyId: "legacy-delivery-fixture",
    privateKey,
    issuedAt: NOW,
    statement: {
      _type: IN_TOTO_STATEMENT_V1,
      subject: [
        { name: "github:acme/payments", digest: { sha1: CANDIDATE_SHA } },
      ],
      predicateType: ASF_EVIDENCE_PREDICATE_TYPE,
      predicate: {
        schema: ASF_EVIDENCE_PREDICATE_SCHEMA,
        run: {
          run_id: "run_intent_01",
          attempt_id: "attempt_01",
          work_order_id: "wo_intent_01",
          completed_at: NOW,
        },
        work_order: {
          envelope_digest: DIGEST_A,
          payload_digest: DIGEST_B,
          envelope_artifact_digest: DIGEST_C,
          signature: {
            key_id: "legacy-work-order-fixture",
            algorithm: "EdDSA",
            verified: true,
          },
        },
        policy: {
          effective_policy_digest: DIGEST_D,
          effective_policy_artifact_digest: DIGEST_A,
          inputs: {
            operator_policy_digest: DIGEST_A,
            work_order_policy_digest: DIGEST_B,
            repository_policy_digest: DIGEST_C,
            forge_policy_digest: DIGEST_D,
          },
          required_local_checks: [],
          required_ci_contexts: [],
          require_local_review: false,
          require_pull_request_review: false,
        },
        source: {
          forge: "github",
          repository: "acme/payments",
          base_ref: "refs/heads/main",
          base_sha: BASE_SHA,
          candidate_sha: CANDIDATE_SHA,
          remote_head_sha: CANDIDATE_SHA,
          merge_sha: null,
          tree_digest: DIGEST_A,
          normalized_diff_digest: DIGEST_B,
          normalized_diff_artifact_digest: DIGEST_C,
          changed_paths: [],
        },
        runtime: {
          harness_digest: DIGEST_A,
          tool_policy_digest: DIGEST_B,
          sandbox_profile_digest: DIGEST_C,
          dependency_digest: DIGEST_D,
          runtime_digest: DIGEST_A,
          runtime_manifest_digest: DIGEST_B,
          providers: [],
        },
        role_outcomes: [],
        verification: { local_checks: [], ci_contexts: [] },
        reviews: [],
        side_effects: [],
        approvals: [],
        cancellation: null,
        budget: {
          cost_usd: 0,
          agent_invocations: 0,
          fix_iterations: 0,
          elapsed_ms: 0,
          stop_reason: "pr-delivered",
        },
        delivery: {
          closure_target: "pr",
          satisfied: true,
          pull_request: {
            forge: "github",
            repository: "acme/payments",
            number: 1,
            url: "https://github.com/acme/payments/pull/1",
            head_ref: "refs/heads/runmill/run_intent_01",
            base_ref: "refs/heads/main",
            head_sha: CANDIDATE_SHA,
            observed_at: NOW,
            evidence_digest: DIGEST_C,
          },
        },
        artifacts: [],
      },
    },
  });
}

function canonicalEnvelopeWithDifferentSignature(
  canonicalEnvelope: string,
): string {
  const raw = JSON.parse(canonicalEnvelope) as Record<string, unknown>;
  if (typeof raw["signature"] !== "string") {
    throw new Error("signed evidence fixture has no signature");
  }
  raw["signature"] =
    raw["signature"] === "base64url:AQ" ? "base64url:Ag" : "base64url:AQ";
  return canonicalJson(raw as JsonValue);
}

describe("ASF completion delivery-policy binding", () => {
  it("accepts completion bound to effective policy delivery.closureTarget", () => {
    const store = completionReady();

    expect(() => complete(store, "pr")).not.toThrow();
    expect(store.getAsfRun("run_intent_01")).toMatchObject({
      state: "COMPLETED",
      stateVersion: 3,
      candidateSha: CANDIDATE_SHA,
    });
  });

  it("acknowledges only the canonical terminal bundle when delivery evidence also exists", () => {
    const store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");

    expect(() => acknowledge(store, "ack_legacy_digest", DIGEST_B)).toThrow(
      RunmillError,
    );
    expect(
      acknowledge(store, "ack_terminal_digest", terminal.bundleDigest),
    ).toMatchObject({
      disposition: "recorded",
      bundleDigest: terminal.bundleDigest,
    });
  });

  it("refuses acknowledgement when canonical terminal evidence is corrupted", () => {
    let store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    close(store);

    const fixture = new Database(databasePath());
    fixture
      .prepare(
        `UPDATE asf_terminal_evidence_bundles
         SET canonical_envelope = '{}' WHERE run_id = 'run_intent_01'`,
      )
      .run();
    fixture.close();
    store = open();

    expect(() =>
      acknowledge(store, "ack_corrupt_terminal", terminal.bundleDigest),
    ).toThrow();
    const verification = new Database(databasePath(), { readonly: true });
    const row = verification
      .prepare(
        `SELECT COUNT(*) AS count FROM asf_outcome_acknowledgements
         WHERE run_id = 'run_intent_01'`,
      )
      .get() as { count: number };
    verification.close();
    expect(row.count).toBe(0);
  });

  it("refuses a signature-only terminal mutation before first acknowledgement", () => {
    let store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    const mutated = canonicalEnvelopeWithDifferentSignature(
      terminal.canonicalEnvelope,
    );
    close(store);

    const fixture = new Database(databasePath());
    fixture
      .prepare(
        `UPDATE asf_terminal_evidence_bundles
         SET canonical_envelope = ? WHERE run_id = 'run_intent_01'`,
      )
      .run(mutated);
    fixture.close();
    store = open();

    expect(() => store.getAsfTerminalEvidenceBundle("run_intent_01")).toThrow(
      /contradictory/u,
    );
    expect(() =>
      acknowledge(store, "ack_signature_mutation", terminal.bundleDigest),
    ).toThrow();
    const verification = new Database(databasePath(), { readonly: true });
    const row = verification
      .prepare(
        `SELECT COUNT(*) AS count FROM asf_outcome_acknowledgements
         WHERE run_id = 'run_intent_01'`,
      )
      .get() as { count: number };
    verification.close();
    expect(row.count).toBe(0);
  });

  it("refuses an idempotent acknowledgement retry after a signature-only terminal mutation", () => {
    let store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    expect(
      acknowledge(store, "ack_before_corruption", terminal.bundleDigest),
    ).toMatchObject({ disposition: "recorded" });
    const mutated = canonicalEnvelopeWithDifferentSignature(
      terminal.canonicalEnvelope,
    );
    close(store);

    const fixture = new Database(databasePath());
    fixture
      .prepare(
        `UPDATE asf_terminal_evidence_bundles
         SET canonical_envelope = ? WHERE run_id = 'run_intent_01'`,
      )
      .run(mutated);
    fixture.close();
    store = open();

    expect(() =>
      acknowledge(store, "ack_before_corruption", terminal.bundleDigest),
    ).toThrow();
  });

  it("preserves canonical delivery-bundle acknowledgement for legacy completed runs without terminal evidence", () => {
    let store = completionReady();
    complete(store, "pr");
    const delivery = legacyDeliveryBundle();
    close(store);

    const fixture = new Database(databasePath());
    fixture.pragma("foreign_keys = ON");
    fixture
      .prepare("DELETE FROM asf_terminal_evidence_bundles WHERE run_id = ?")
      .run("run_intent_01");
    fixture
      .prepare("DELETE FROM asf_terminal_evidence_intents WHERE run_id = ?")
      .run("run_intent_01");
    fixture
      .prepare(
        `UPDATE asf_evidence_bundles
         SET bundle_digest = ?, canonical_envelope_digest = ?,
             canonical_envelope = ?, finalized_at = ?
         WHERE run_id = ?`,
      )
      .run(
        delivery.bundle_digest,
        sha256Digest(delivery),
        canonicalJson(delivery),
        delivery.issued_at,
        "run_intent_01",
      );
    fixture.close();
    store = open();

    expect(
      acknowledge(store, "ack_legacy_completed", delivery.bundle_digest),
    ).toMatchObject({
      disposition: "recorded",
      bundleDigest: delivery.bundle_digest,
    });
  });

  it("refuses signature-only corruption of legacy delivery evidence", () => {
    let store = completionReady();
    complete(store, "pr");
    const delivery = legacyDeliveryBundle();
    const mutated = canonicalEnvelopeWithDifferentSignature(
      canonicalJson(delivery),
    );
    close(store);

    const fixture = new Database(databasePath());
    fixture.pragma("foreign_keys = ON");
    fixture
      .prepare("DELETE FROM asf_terminal_evidence_bundles WHERE run_id = ?")
      .run("run_intent_01");
    fixture
      .prepare("DELETE FROM asf_terminal_evidence_intents WHERE run_id = ?")
      .run("run_intent_01");
    fixture
      .prepare(
        `UPDATE asf_evidence_bundles
         SET bundle_digest = ?, canonical_envelope_digest = ?,
             canonical_envelope = ?, finalized_at = ?
         WHERE run_id = ?`,
      )
      .run(
        delivery.bundle_digest,
        sha256Digest(delivery),
        mutated,
        delivery.issued_at,
        "run_intent_01",
      );
    fixture.close();
    store = open();

    expect(() => store.getAsfEvidenceBundle("run_intent_01")).toThrow(
      /contradictory/u,
    );
    expect(() =>
      acknowledge(
        store,
        "ack_legacy_signature_mutation",
        delivery.bundle_digest,
      ),
    ).toThrow();
    const verification = new Database(databasePath(), { readonly: true });
    const row = verification
      .prepare(
        `SELECT COUNT(*) AS count FROM asf_outcome_acknowledgements
         WHERE run_id = 'run_intent_01'`,
      )
      .get() as { count: number };
    verification.close();
    expect(row.count).toBe(0);
  });

  it("backfills complete signed-envelope digests when opening a v9 evidence database", () => {
    let store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    const terminalBundle = store.getAsfTerminalEvidenceBundle("run_intent_01");
    if (terminalBundle === undefined) {
      throw new Error("terminal evidence bundle disappeared");
    }
    const delivery = legacyDeliveryBundle();
    close(store);

    const legacy = new Database(databasePath());
    legacy
      .prepare(
        `UPDATE asf_evidence_bundles
         SET bundle_digest = ?, canonical_envelope = ?, finalized_at = ?
         WHERE run_id = ?`,
      )
      .run(
        delivery.bundle_digest,
        canonicalJson(delivery),
        delivery.issued_at,
        "run_intent_01",
      );
    legacy.exec(
      `ALTER TABLE asf_evidence_bundles DROP COLUMN canonical_envelope_digest;
       ALTER TABLE asf_terminal_evidence_bundles DROP COLUMN canonical_envelope_digest;
       DELETE FROM schema_migrations WHERE version = 10;
       PRAGMA user_version = 9;`,
    );
    legacy.close();

    store = open();
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.appliedMigrations()).toContainEqual({
      version: 10,
      name: "asf_signed_envelope_integrity",
    });
    expect(store.getAsfEvidenceBundle("run_intent_01")).toEqual(delivery);
    expect(store.getAsfTerminalEvidenceBundle("run_intent_01")).toEqual(
      terminalBundle,
    );
    const raw = new Database(databasePath(), { readonly: true });
    const digests = raw
      .prepare(
        `SELECT
           (SELECT canonical_envelope_digest FROM asf_evidence_bundles
            WHERE run_id = 'run_intent_01') AS deliveryDigest,
           (SELECT canonical_envelope_digest FROM asf_terminal_evidence_bundles
            WHERE run_id = 'run_intent_01') AS terminalDigest`,
      )
      .get() as { deliveryDigest: string; terminalDigest: string };
    raw.close();
    expect(digests).toEqual({
      deliveryDigest: sha256Digest(delivery),
      terminalDigest: sha256Digest(terminalBundle),
    });
    expect(
      acknowledge(store, "ack_after_v9_backfill", terminal.bundleDigest),
    ).toMatchObject({ disposition: "recorded" });
  });

  it("rolls v10 back when a legacy signed envelope is malformed", () => {
    const store = completionReady();
    complete(store, "pr");
    close(store);

    const legacy = new Database(databasePath());
    legacy
      .prepare(
        `UPDATE asf_terminal_evidence_bundles
         SET canonical_envelope = '{}' WHERE run_id = 'run_intent_01'`,
      )
      .run();
    legacy.exec(
      `ALTER TABLE asf_evidence_bundles DROP COLUMN canonical_envelope_digest;
       ALTER TABLE asf_terminal_evidence_bundles DROP COLUMN canonical_envelope_digest;
       DELETE FROM schema_migrations WHERE version = 10;
       PRAGMA user_version = 9;`,
    );
    legacy.close();

    expect(() => open()).toThrow(/cannot migrate malformed/u);
    const verification = new Database(databasePath(), { readonly: true });
    expect(Number(verification.pragma("user_version", { simple: true }))).toBe(
      9,
    );
    const columns = verification
      .prepare("PRAGMA table_info(asf_terminal_evidence_bundles)")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain(
      "canonical_envelope_digest",
    );
    const migrationCount = verification
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10",
      )
      .get() as { count: number };
    verification.close();
    expect(migrationCount.count).toBe(0);
  });

  it("rejects a schema-valid completion target that contradicts effective delivery policy", () => {
    const store = completionReady();

    expect(() => complete(store, "merge")).toThrow(
      /closure target does not match/u,
    );
    expect(store.getAsfRun("run_intent_01")).toMatchObject({
      state: "EVIDENCE_FINALIZED",
      stateVersion: 2,
    });
  });

  it("refuses new durable effects after immutable terminal evidence owns the next event", () => {
    const store = completionReady();
    const adapter = new StateStoreAsfDeliveryIntentStore(store, "worker-a");
    const pending = intent(1, {
      stage: "cleanup",
      candidate_sha: CANDIDATE_SHA,
      event_seq: 2,
      operation_digest: sha256Digest({ workspace_id: "workspace-01" }),
    });
    expect(() => adapter.record(pending)).toThrow(RunmillError);
    expect(store.getAsfDeliveryIntent(pending.effect_key)).toBeUndefined();
    expect(store.getAsfRun("run_intent_01")).toMatchObject({
      state: "EVIDENCE_FINALIZED",
      stateVersion: 2,
    });
    expect(() => complete(store, "pr")).not.toThrow();
  });

  it("fails closed when delivery policy is absent even if a top-level lookalike exists", () => {
    const store = completionReady({ malformedDelivery: true });

    expect(() => complete(store, "pr")).toThrow(/incomplete delivery policy/u);
    expect(store.getAsfRun("run_intent_01")).toMatchObject({
      state: "EVIDENCE_FINALIZED",
      stateVersion: 2,
    });
  });
});

describe("ASF terminal event retention", () => {
  it("does not discover or mutate standalone runs", () => {
    const store = open();
    store.createRun({
      runId: "run_standalone_retention",
      issueId: "ENG-STANDALONE",
      repo: "acme/payments",
      provider: "codex",
    });

    expect(
      store.getAsfEventRetentionCandidate("run_standalone_retention"),
    ).toBeUndefined();
    expect(store.listAsfEventRetentionCandidates()).toEqual([]);
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_standalone_retention",
        expectedGeneration: 1,
        expectedBundleDigest: DIGEST_A,
        through: 1,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
    expect(store.getRun("run_standalone_retention")).toMatchObject({
      state: "DISCOVERED",
      stateVersion: 1,
    });
  });

  it("keeps unacknowledged terminal detail even after the retention floor", () => {
    const store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    store.releaseAsfRunOwnership("run_intent_01", "worker-a", 1);
    clock.advanceMs(MIN_ASF_DETAILED_EVENT_RETENTION_MS);

    expect(
      store.getAsfEventRetentionCandidate("run_intent_01"),
    ).toBeUndefined();
    expect(store.listAsfEventRetentionCandidates()).toEqual([]);
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
    expect(store.listAsfRunEvents("run_intent_01", 0, 10).events).toHaveLength(
      3,
    );
  });

  it("refuses wrong bundle, stale generation, unsafe policy, and pre-floor age", () => {
    const store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    acknowledge(store, "ack_retention_negatives", terminal.bundleDigest);
    store.releaseAsfRunOwnership("run_intent_01", "worker-a", 1);
    const candidate = store.getAsfEventRetentionCandidate("run_intent_01");
    expect(candidate).toMatchObject({
      runId: "run_intent_01",
      generation: 1,
      ownerId: null,
      terminalEventSeq: 3,
      terminalEventAt: NOW,
      bundleDigest: terminal.bundleDigest,
      compactedThrough: 0,
    });

    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: DIGEST_A,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 2,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS - 1,
      }),
    ).toThrow(/at least/u);

    clock.advanceMs(MIN_ASF_DETAILED_EVENT_RETENTION_MS - 1);
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(/retention age/u);
    expect(store.listAsfRunEvents("run_intent_01", 0, 10).events).toHaveLength(
      3,
    );
  });

  it("defers an acknowledged eligible run until its terminal owner releases", () => {
    const store = completionReady();
    complete(store, "pr");
    const terminal = store.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    acknowledge(store, "ack_owned_retention", terminal.bundleDigest);
    clock.advanceMs(MIN_ASF_DETAILED_EVENT_RETENTION_MS);

    expect(store.getAsfEventRetentionCandidate("run_intent_01")).toMatchObject({
      ownerId: "worker-a",
      generation: 1,
      bundleDigest: terminal.bundleDigest,
    });
    expect(() =>
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toThrow(RunmillError);

    store.releaseAsfRunOwnership("run_intent_01", "worker-a", 1);
    expect(
      store.compactAsfRunEvents({
        runId: "run_intent_01",
        expectedGeneration: 1,
        expectedBundleDigest: terminal.bundleDigest,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      }),
    ).toBe(2);
    expect(
      store.getAsfEventRetentionCandidate("run_intent_01"),
    ).toBeUndefined();
    expect(store.listAsfRunEvents("run_intent_01", 0, 10)).toMatchObject({
      events: [expect.objectContaining({ seq: 3, type: "run.completed" })],
      nextCursor: 3,
      gap: true,
      compactedThrough: 2,
      snapshot: { latestSequence: 3 },
    });
  });

  it("serializes duplicate maintainers and permits only the exact watermark", () => {
    const first = completionReady();
    complete(first, "pr");
    const terminal = first.getAsfTerminalEvidenceBundleRecord("run_intent_01");
    if (terminal === undefined)
      throw new Error("terminal evidence disappeared");
    acknowledge(first, "ack_concurrent_retention", terminal.bundleDigest);
    first.releaseAsfRunOwnership("run_intent_01", "worker-a", 1);
    clock.advanceMs(MIN_ASF_DETAILED_EVENT_RETENTION_MS);
    const second = open();
    const exact = {
      runId: "run_intent_01",
      expectedGeneration: 1,
      expectedBundleDigest: terminal.bundleDigest,
      through: 2,
      minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
    } as const;

    expect(first.compactAsfRunEvents(exact)).toBe(2);
    expect(second.compactAsfRunEvents(exact)).toBe(0);
    expect(() => second.compactAsfRunEvents({ ...exact, through: 1 })).toThrow(
      /exact terminal predecessor/u,
    );
    expect(second.listAsfRunEvents("run_intent_01", 0, 10)).toMatchObject({
      events: [expect.objectContaining({ seq: 3 })],
      gap: true,
      compactedThrough: 2,
      snapshot: { latestSequence: 3 },
    });
  });
});
