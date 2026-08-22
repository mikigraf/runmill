import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsfReconciliationService,
  automaticReconciliationOperationId,
  type ReconciliationRequest,
} from "../../src/asf/reconciliation.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { StateStore } from "../../src/state/store.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:05:00.000Z";
const CANDIDATE = "c".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
const stores: StateStore[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function open(): { readonly store: StateStore; readonly database: Database.Database } {
  const directory = mkdtempSync(join(tmpdir(), "runmill-reconciliation-recovery-"));
  directories.push(directory);
  const path = join(directory, "runmill.db");
  const store = StateStore.open(path, { clock: new FakeClock(NOW) });
  stores.push(store);
  const database = new Database(path);
  databases.push(database);
  return { store, database };
}

function seedRun(
  database: Database.Database,
  runId: string,
  mode: "asf-worker" | "standalone" = "asf-worker",
): void {
  database
    .prepare(
      `INSERT INTO runs(
         run_id, issue_id, repo, provider, state, state_version, attempt,
         base_commit, candidate_sha, branch, created_at, updated_at, mode,
         work_order_id, attempt_id, generation, owner_id, heartbeat_at,
         resume_phase, requires_reconciliation
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      `issue-${runId}`,
      `acme/${runId}`,
      "codex:asf-production",
      "ADMITTED",
      1,
      1,
      "b".repeat(40),
      CANDIDATE,
      null,
      NOW,
      NOW,
      mode,
      mode === "asf-worker" ? `wo-${runId}` : null,
      mode === "asf-worker" ? `attempt-${runId}` : null,
      0,
      null,
      null,
      null,
      0,
    );
}

function seedGitHubEffect(
  database: Database.Database,
  runId: string,
  status: "intended" | "in_flight" | "ambiguous" = "in_flight",
): string {
  const effectKey = `effect_${runId}`;
  database
    .prepare(
      `INSERT INTO asf_effects(
         effect_key, run_id, generation, system, operation, target,
         correlation_marker, candidate_sha, expected_remote_sha, policy_digest,
         intent_digest, status, remote_id, observation_digest, retry_prohibited,
         intended_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      effectKey,
      runId,
      1,
      "github",
      "branch.push",
      `acme/${runId}#refs/heads/runmill/${runId}`,
      `runmill:v1:run=${runId}`,
      CANDIDATE,
      null,
      DIGEST,
      DIGEST,
      status,
      null,
      null,
      status === "ambiguous" ? 1 : 0,
      NOW,
      NOW,
    );
  return effectKey;
}

function seedDeliveryIntent(database: Database.Database, runId: string): string {
  const effectKey = `delivery_effect_${runId}`;
  database
    .prepare(
      `INSERT INTO asf_delivery_stage_intents(
         effect_key, intent_id, intent_digest, schema, stage, run_id,
         work_order_id, attempt_id, policy_digest, fencing_generation,
         candidate_sha, event_seq, operation_digest, canonical_intent, created_at,
         observation_digest, confirmed_generation, confirmed_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      effectKey,
      `delivery_${runId}`,
      `sha256:${sha256Digest({ run_id: runId }).slice("sha256:".length)}`,
      "asf.delivery-stage-intent/v1",
      "ci",
      runId,
      `wo-${runId}`,
      `attempt-${runId}`,
      DIGEST,
      1,
      CANDIDATE,
      1,
      DIGEST,
      "{}",
      NOW,
      null,
      null,
      null,
    );
  return effectKey;
}

describe("automatic durable reconciliation recovery", () => {
  it("discovers crash-left effects and generic intents while excluding standalone rows", async () => {
    const { store, database } = open();
    seedRun(database, "run_crash");
    seedRun(database, "run_generic");
    seedRun(database, "run_standalone", "standalone");
    const githubKey = seedGitHubEffect(database, "run_crash", "in_flight");
    const genericKey = seedDeliveryIntent(database, "run_generic");
    seedGitHubEffect(database, "run_standalone", "in_flight");

    const first = store.discoverPendingAsfReconciliationRuns({
      afterRunId: null,
      limit: 1,
      maxPendingItemsPerRun: 10,
    });
    const second = store.discoverPendingAsfReconciliationRuns({
      afterRunId: first.nextRunId,
      limit: 1,
      maxPendingItemsPerRun: 10,
    });
    const discovered = [...first.runs, ...second.runs];
    expect(discovered).toMatchObject([
      { runId: "run_crash", githubEffectCount: 1, deliveryIntentCount: 0 },
      { runId: "run_generic", githubEffectCount: 0, deliveryIntentCount: 1 },
    ]);
    expect(discovered.map((item) => item.runId)).not.toContain("run_standalone");

    const observed: string[] = [];
    const completions: unknown[] = [];
    const service = new AsfReconciliationService({
      store,
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      recoveryPageSize: 1,
      observer: {
        async reconcilePending(input) {
          observed.push(input.runId);
          return [
            {
              effectClass: input.runId === "run_crash" ? "github-effect" : "delivery-intent",
              effectKey: input.runId === "run_crash" ? githubKey : genericKey,
              status: "confirmed",
            },
          ];
        },
      },
      onReconciliationCompleted(completion) {
        completions.push(completion);
      },
    });

    expect(service.recover()).toBe(2);
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    for (const pending of discovered) {
      expect(
        store.getAsfReconciliation(
          automaticReconciliationOperationId({
            ...pending,
            retryBucket: Math.floor(Date.parse(NOW) / 1_000),
          }),
        ),
      ).toMatchObject({ status: "blocked" });
    }
    // Observer claims are not confirmation writes. Both durable rows remain
    // unresolved, so finish downgrades the claimed success and emits no wake.
    expect(completions).toEqual([]);
    expect(service.recover()).toBe(0);
  });

  it("finishes the original exact set after a crash following its last durable observation", async () => {
    const { store, database } = open();
    seedRun(database, "run_observed_before_crash");
    const effectKey = seedGitHubEffect(
      database,
      "run_observed_before_crash",
      "in_flight",
    );
    const pending = store.getPendingAsfReconciliationRun(
      "run_observed_before_crash",
      10,
    );
    if (pending === undefined) throw new Error("seeded pending set disappeared");
    const retryBucket = Math.floor(Date.parse(NOW) / 1_000);
    const operationId = automaticReconciliationOperationId({
      ...pending,
      retryBucket,
    });
    const request: ReconciliationRequest = {
      schema: "asf.reconciliation-request/v1",
      operation_id: operationId,
      run_id: pending.runId,
      requested_by: {
        subject: "service:asf-recovery",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    };
    expect(
      store.recordAsfReconciliationRequest({
        request,
        requestDigest: sha256Digest(request),
      }),
    ).toMatchObject({ disposition: "queued", status: "queued" });
    expect(
      store.claimAsfReconciliation({
        operationId,
        ownerId: "reconciler-before-crash",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ runId: pending.runId, generation: 1 });

    // This is the precise crash window: the remote observation and its
    // definitive ledger update commit, but finishAsfReconciliation never runs.
    store.recordAsfEffectObservation({
      effectKey,
      ownerId: "reconciler-before-crash",
      generation: 1,
      outcome: "confirmed",
      candidateSha: CANDIDATE,
      detailsDigest: DIGEST,
      observer: "github:branch",
    });
    expect(store.getPendingAsfReconciliationRun(pending.runId, 10)).toBeUndefined();
    expect(store.getAsfReconciliation(operationId)).toMatchObject({ status: "running" });

    const observer = vi.fn(async () => {
      throw new Error("restart must not repeat an already durable remote observation");
    });
    const completions: unknown[] = [];
    const restarted = new AsfReconciliationService({
      store,
      clock: new FakeClock("2026-08-21T10:07:00.000Z"),
      workerId: "reconciler-after-crash",
      staleOwnershipMs: 60_000,
      observer: { requiresPendingSetBinding: true, reconcilePending: observer },
      onReconciliationCompleted(completion) {
        completions.push(completion);
      },
    });

    expect(restarted.recover()).toBe(1);
    await vi.waitFor(() =>
      expect(store.getAsfReconciliation(operationId)?.status).toBe("completed"),
    );
    expect(observer).not.toHaveBeenCalled();
    expect(completions).toHaveLength(1);
    const durable = store.getAsfReconciliation(operationId);
    expect(durable?.canonicalResult).not.toBeNull();
    expect(JSON.parse(durable?.canonicalResult ?? "null")).toEqual({
      schema: "asf.reconciliation-result/v1",
      operation_id: operationId,
      run_id: pending.runId,
      pending_set_digest: pending.pendingSetDigest,
      observations: [
        {
          effect_class: "github-effect",
          effect_key: effectKey,
          outcome: "confirmed",
        },
      ],
    });
  });

  it("includes generic intents in request/finish counts and fences a stale finisher", () => {
    const { store, database } = open();
    seedRun(database, "run_generic");
    seedDeliveryIntent(database, "run_generic");
    const request: ReconciliationRequest = {
      schema: "asf.reconciliation-request/v1",
      operation_id: "reconcile_generic",
      run_id: "run_generic",
      requested_by: {
        subject: "service:asf-controller",
        authority: "asf:reconcile",
      },
      scope: "pending-effects",
    };
    expect(
      store.recordAsfReconciliationRequest({ request, requestDigest: sha256Digest(request) }),
    ).toMatchObject({ disposition: "queued", status: "queued" });
    expect(
      store.claimAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ runId: "run_generic", generation: 1 });
    expect(
      store.finishAsfReconciliation({
        operationId: request.operation_id,
        ownerId: "reconciler-a",
        generation: 1,
        status: "completed",
        resultDigest: DIGEST,
      }),
    ).toMatchObject({ status: "blocked" });
    store.releaseAsfRunOwnership("run_generic", "reconciler-a", 1);

    const staleRequest: ReconciliationRequest = {
      ...request,
      operation_id: "reconcile_stale",
    };
    expect(
      store.recordAsfReconciliationRequest({
        request: staleRequest,
        requestDigest: sha256Digest(staleRequest),
      }),
    ).toMatchObject({ status: "queued" });
    expect(
      store.claimAsfReconciliation({
        operationId: staleRequest.operation_id,
        ownerId: "reconciler-a",
        staleBefore: "2026-08-21T10:04:00.000Z",
      }),
    ).toEqual({ runId: "run_generic", generation: 2 });
    database
      .prepare(
        `UPDATE runs SET owner_id = 'reconciler-b', generation = 3,
                         heartbeat_at = '2026-08-21T10:06:00.000Z'
         WHERE run_id = 'run_generic'`,
      )
      .run();
    expect(() =>
      store.finishAsfReconciliation({
        operationId: staleRequest.operation_id,
        ownerId: "reconciler-a",
        generation: 2,
        status: "completed",
        resultDigest: DIGEST,
      }),
    ).toThrow(RunmillError);
  });
});
