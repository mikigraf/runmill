import { describe, expect, it, vi } from "vitest";
import {
  AsfReconciliationService,
  CompositeReconciliationObserver,
  automaticReconciliationOperationId,
  parseReconciliationRequest,
  type AsfReconciliationRecord,
  type AsfReconciliationScheduler,
  type ReconciliationRequest,
  type ReconciliationStore,
} from "../../src/asf/reconciliation.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:05:00.000Z";

class ManualScheduler implements AsfReconciliationScheduler {
  readonly tasks: { readonly delayMs: number; readonly run: () => void; cancelled: boolean }[] = [];

  schedule(delayMs: number, task: () => void): { cancel(): void } {
    const scheduled = { delayMs, run: task, cancelled: false };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  runNext(): void {
    const next = this.tasks.shift();
    if (next === undefined) throw new Error("no scheduled reconciliation task");
    if (!next.cancelled) next.run();
  }
}

function request(): ReconciliationRequest {
  return {
    schema: "asf.reconciliation-request/v1",
    operation_id: "reconcile_01",
    run_id: "run_01",
    requested_by: {
      subject: "service:asf-controller",
      authority: "asf:reconcile",
    },
    scope: "pending-effects",
  };
}

function record(status: AsfReconciliationRecord["status"]): AsfReconciliationRecord {
  return {
    operationId: "reconcile_01",
    runId: "run_01",
    requestDigest: sha256Digest(request()),
    requestedBy: "service:asf-controller",
    requestedAuthority: "asf:reconcile",
    scope: "pending-effects",
    status,
    generation: status === "queued" ? null : 7,
    ownerId: status === "queued" ? null : "reconciler-a",
    requestedAt: NOW,
    startedAt: status === "queued" ? null : NOW,
    completedAt: status === "completed" || status === "blocked" ? NOW : null,
    resultDigest:
      status === "completed" || status === "blocked"
        ? `sha256:${"a".repeat(64)}`
        : null,
  };
}

function recordFor(
  value: ReconciliationRequest,
  status: AsfReconciliationRecord["status"],
): AsfReconciliationRecord {
  return {
    ...record(status),
    operationId: value.operation_id,
    runId: value.run_id,
    requestDigest: sha256Digest(value),
    requestedBy: value.requested_by.subject,
  };
}

function fakeStore(overrides: Partial<ReconciliationStore> = {}): ReconciliationStore {
  return {
    recordAsfReconciliationRequest(input) {
      expect(input.requestDigest).toBe(sha256Digest(input.request));
      return {
        operationId: input.request.operation_id,
        runId: input.request.run_id,
        disposition: "queued",
        status: "queued",
        requestDigest: input.requestDigest,
        requestedAt: NOW,
      };
    },
    discoverPendingAsfReconciliationRuns: () => ({ runs: [], nextRunId: null }),
    listRecoverableAsfReconciliations: () => [],
    claimAsfReconciliation: () => ({ runId: "run_01", generation: 7 }),
    finishAsfReconciliation: (input) => record(input.status),
    releaseAsfRunOwnership: () => undefined,
    ...overrides,
  };
}

describe("ASF reconciliation", () => {
  it("queues and completes deterministic observation independently of the caller", async () => {
    const observed: unknown[] = [];
    const finished: unknown[] = [];
    const released: unknown[] = [];
    const completionOrder: string[] = [];
    const completions: unknown[] = [];
    const store = fakeStore({
      finishAsfReconciliation(input) {
        completionOrder.push("durable-finish");
        finished.push(input);
        return record(input.status);
      },
      releaseAsfRunOwnership(...args) {
        completionOrder.push("release-fence");
        released.push(args);
      },
    });
    const service = new AsfReconciliationService({
      store,
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        async reconcilePending(input) {
          observed.push(input);
          return [
            {
              effectKey: `sha256:${"b".repeat(64)}`,
              status: "confirmed",
            },
          ];
        },
      },
      onReconciliationCompleted(completion) {
        completionOrder.push("wake-lifecycle");
        completions.push(completion);
      },
    });

    expect(service.request(request())).toMatchObject({
      operationId: "reconcile_01",
      disposition: "queued",
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(observed).toEqual([
      { runId: "run_01", ownerId: "reconciler-a", generation: 7 },
    ]);
    expect(finished[0]).toMatchObject({ status: "completed" });
    expect(released).toEqual([["run_01", "reconciler-a", 7]]);
    expect(completions).toEqual([
      {
        operationId: "reconcile_01",
        runId: "run_01",
        generation: 7,
        resultDigest: `sha256:${"a".repeat(64)}`,
        completedAt: NOW,
        pendingSetBinding: null,
        continuation: {
          disposition: "notification-only",
          requiredActor: "orchestrator",
          eligiblePausedPhase: "BLOCKED_EXTERNAL",
          requiresFreshClaim: true,
        },
      },
    ]);
    expect(completionOrder).toEqual(["durable-finish", "release-fence", "wake-lifecycle"]);
  });

  it("turns observer uncertainty into a durable blocked result and never retries blindly", async () => {
    const finished: unknown[] = [];
    const errors: unknown[] = [];
    const completions: unknown[] = [];
    const service = new AsfReconciliationService({
      store: fakeStore({
        finishAsfReconciliation(input) {
          finished.push(input);
          return record(input.status);
        },
      }),
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        async reconcilePending() {
          throw new Error("secret-bearing provider failure");
        },
      },
      onBackgroundError: (error) => errors.push(error),
      onReconciliationCompleted(completion) {
        completions.push(completion);
      },
    });

    service.request(request());
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({
      status: "blocked",
      resultDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(finished)).not.toContain("secret-bearing");
    expect(errors).toHaveLength(1);
    expect(completions).toEqual([]);
  });

  it("discovers crash-left GitHub and generic intents, paginates, and deduplicates recovery", async () => {
    const pending = [
      {
        runId: "run_crash",
        pendingSetDigest: `sha256:${"b".repeat(64)}`,
        githubEffectCount: 1,
        deliveryIntentCount: 0,
      },
      {
        runId: "run_intent",
        pendingSetDigest: `sha256:${"c".repeat(64)}`,
        githubEffectCount: 0,
        deliveryIntentCount: 1,
      },
    ] as const;
    const requests = new Map<string, AsfReconciliationRecord>();
    const recordedIdentities: string[] = [];
    const observed: string[] = [];
    const finished: string[] = [];
    const store = fakeStore({
      discoverPendingAsfReconciliationRuns(input) {
        const rows = pending.filter(
          (item) => input.afterRunId === null || item.runId > input.afterRunId,
        );
        const page = rows.slice(0, input.limit);
        return {
          runs: page,
          nextRunId: rows.length >= input.limit ? (page.at(-1)?.runId ?? null) : null,
        };
      },
      recordAsfReconciliationRequest(input) {
        recordedIdentities.push(`${input.request.operation_id}:${input.requestDigest}`);
        const existing = requests.get(input.request.operation_id);
        if (existing !== undefined) {
          expect(existing.requestDigest).toBe(input.requestDigest);
          return {
            operationId: existing.operationId,
            runId: existing.runId,
            disposition: "existing",
            status: existing.status,
            requestDigest: existing.requestDigest,
            requestedAt: existing.requestedAt,
          };
        }
        expect(input.request.requested_by).toEqual({
          subject: "service:asf-recovery",
          authority: "asf:reconcile",
        });
        const created = recordFor(input.request, "queued");
        requests.set(created.operationId, created);
        return {
          operationId: created.operationId,
          runId: created.runId,
          disposition: "queued",
          status: "queued",
          requestDigest: created.requestDigest,
          requestedAt: created.requestedAt,
        };
      },
      listRecoverableAsfReconciliations(input) {
        const rows = [...requests.values()]
          .filter((item) => item.status === "queued" || item.status === "running")
          .sort((left, right) =>
            left.requestedAt.localeCompare(right.requestedAt) ||
            left.operationId.localeCompare(right.operationId),
          );
        const after = input?.after;
        return rows
          .filter(
            (item) =>
              after === undefined ||
              after === null ||
              item.requestedAt > after.requestedAt ||
              (item.requestedAt === after.requestedAt && item.operationId > after.operationId),
          )
          .slice(0, input?.limit);
      },
      claimAsfReconciliation({ operationId }) {
        const durable = requests.get(operationId);
        return durable === undefined ? null : { runId: durable.runId, generation: 7 };
      },
      finishAsfReconciliation(input) {
        const current = requests.get(input.operationId);
        if (current === undefined) throw new Error("missing durable request");
        const completed = { ...current, ...recordFor({
          schema: "asf.reconciliation-request/v1",
          operation_id: current.operationId,
          run_id: current.runId,
          requested_by: {
            subject: current.requestedBy,
            authority: "asf:reconcile",
          },
          scope: "pending-effects",
        }, input.status), requestDigest: current.requestDigest };
        requests.set(input.operationId, completed);
        finished.push(current.runId);
        return completed;
      },
    });
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
              effectKey: `${input.runId}-effect`,
              status: "confirmed",
            },
          ];
        },
      },
    });

    expect(service.recover()).toBe(2);
    expect(service.recover()).toBe(0);
    expect(new Set(recordedIdentities).size).toBe(2);
    expect(recordedIdentities).toHaveLength(4);
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(observed.sort()).toEqual(["run_crash", "run_intent"]);
  });

  it("retries unchanged blocked pending sets once per deterministic clock bucket and after restart", async () => {
    const clock = new FakeClock(NOW);
    const scheduler = new ManualScheduler();
    const requests = new Map<string, AsfReconciliationRecord>();
    const finished: string[] = [];
    const pending = {
      runId: "run_retry",
      pendingSetDigest: `sha256:${"d".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 0,
    } as const;
    const store = fakeStore({
      discoverPendingAsfReconciliationRuns: () => ({ runs: [pending], nextRunId: null }),
      recordAsfReconciliationRequest(input) {
        const existing = requests.get(input.request.operation_id);
        if (existing !== undefined) {
          return {
            operationId: existing.operationId,
            runId: existing.runId,
            disposition: "existing",
            status: existing.status,
            requestDigest: existing.requestDigest,
            requestedAt: existing.requestedAt,
          };
        }
        const created = recordFor(input.request, "queued");
        requests.set(created.operationId, created);
        return {
          operationId: created.operationId,
          runId: created.runId,
          disposition: "queued",
          status: "queued",
          requestDigest: created.requestDigest,
          requestedAt: created.requestedAt,
        };
      },
      listRecoverableAsfReconciliations: () =>
        [...requests.values()].filter(
          (item) => item.status === "queued" || item.status === "running",
        ),
      claimAsfReconciliation({ operationId }) {
        return requests.has(operationId) ? { runId: pending.runId, generation: 7 } : null;
      },
      finishAsfReconciliation(input) {
        const current = requests.get(input.operationId);
        if (current === undefined) throw new Error("missing automatic retry request");
        const blocked = {
          ...current,
          status: "blocked" as const,
          generation: input.generation,
          ownerId: input.ownerId,
          completedAt: NOW,
          resultDigest: input.resultDigest,
        };
        requests.set(input.operationId, blocked);
        finished.push(input.operationId);
        return blocked;
      },
    });
    const service = new AsfReconciliationService({
      store,
      clock,
      scheduler,
      retryDelayMs: 1_000,
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        reconcilePending: async () => [{ effectKey: "effect_retry", status: "pending" }],
      },
    });

    expect(service.recover()).toBe(1);
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toBe(
      automaticReconciliationOperationId({
        ...pending,
        retryBucket: Math.floor(Date.parse(NOW) / 1_000),
      }),
    );
    expect(service.recover()).toBe(0);
    expect(requests.size).toBe(1);
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0]?.delayMs).toBe(1_000);

    clock.advanceMs(1_000);
    scheduler.runNext();
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(new Set(finished).size).toBe(2);

    const restartClock = new FakeClock(clock.now());
    restartClock.advanceMs(1_000);
    const restarted = new AsfReconciliationService({
      store,
      clock: restartClock,
      scheduler: new ManualScheduler(),
      retryDelayMs: 1_000,
      workerId: "reconciler-b",
      staleOwnershipMs: 60_000,
      observer: {
        reconcilePending: async () => [{ effectKey: "effect_retry", status: "pending" }],
      },
    });
    expect(restarted.recover()).toBe(1);
    await vi.waitFor(() => expect(finished).toHaveLength(3));
    expect(new Set(finished).size).toBe(3);
  });

  it("refuses observation when the exact automatic pending set changes after discovery", async () => {
    const clock = new FakeClock(NOW);
    const initial = {
      runId: "run_changed",
      pendingSetDigest: `sha256:${"b".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 0,
    } as const;
    const changed = { ...initial, pendingSetDigest: `sha256:${"c".repeat(64)}` };
    let discoveries = 0;
    let durable: AsfReconciliationRecord | undefined;
    const finishes: unknown[] = [];
    const observer = vi.fn(async () => [{ effectKey: "effect_changed", status: "confirmed" }]);
    const store = fakeStore({
      discoverPendingAsfReconciliationRuns: () => ({
        runs: [discoveries++ === 0 ? initial : changed],
        nextRunId: null,
      }),
      recordAsfReconciliationRequest(input) {
        durable = recordFor(input.request, "queued");
        return {
          operationId: durable.operationId,
          runId: durable.runId,
          disposition: "queued",
          status: "queued",
          requestDigest: durable.requestDigest,
          requestedAt: durable.requestedAt,
        };
      },
      listRecoverableAsfReconciliations: () => (durable === undefined ? [] : [durable]),
      claimAsfReconciliation: () => ({ runId: initial.runId, generation: 7 }),
      finishAsfReconciliation(input) {
        finishes.push(input);
        return { ...recordFor(request(), "blocked"), operationId: input.operationId };
      },
    });
    const service = new AsfReconciliationService({
      store,
      clock,
      scheduler: new ManualScheduler(),
      retryDelayMs: 1_000,
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: { reconcilePending: observer },
    });

    expect(service.recover()).toBe(1);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    expect(finishes[0]).toMatchObject({ status: "blocked" });
    expect(observer).not.toHaveBeenCalled();
  });

  it("fails closed when an automatic attempt identity is tampered", async () => {
    const validOperationId = automaticReconciliationOperationId({
      runId: "run_01",
      pendingSetDigest: `sha256:${"b".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 0,
      retryBucket: Math.floor(Date.parse(NOW) / 1_000),
    });
    const tamperedOperationId = `${validOperationId.slice(0, -1)}${
      validOperationId.endsWith("0") ? "1" : "0"
    }`;
    const observer = vi.fn(async () => [{ effectKey: "effect_01", status: "confirmed" }]);
    const finished: unknown[] = [];
    const service = new AsfReconciliationService({
      store: fakeStore({
        finishAsfReconciliation(input) {
          finished.push(input);
          return record(input.status);
        },
      }),
      clock: new FakeClock(NOW),
      scheduler: new ManualScheduler(),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: { reconcilePending: observer },
    });

    service.request({ ...request(), operation_id: tamperedOperationId });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: "blocked" });
    expect(observer).not.toHaveBeenCalled();
  });

  it("emits the bound notification-only continuation contract after durable finish and release", async () => {
    const clock = new FakeClock(NOW);
    const pending = {
      runId: "run_completed",
      pendingSetDigest: `sha256:${"f".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 0,
    } as const;
    let hasPending = true;
    let durable: AsfReconciliationRecord | undefined;
    const order: string[] = [];
    const completions: unknown[] = [];
    const store = fakeStore({
      discoverPendingAsfReconciliationRuns: () => ({
        runs: hasPending ? [pending] : [],
        nextRunId: null,
      }),
      recordAsfReconciliationRequest(input) {
        durable = recordFor(input.request, "queued");
        return {
          operationId: durable.operationId,
          runId: durable.runId,
          disposition: "queued",
          status: "queued",
          requestDigest: durable.requestDigest,
          requestedAt: durable.requestedAt,
        };
      },
      listRecoverableAsfReconciliations: () => (durable === undefined ? [] : [durable]),
      claimAsfReconciliation: () => ({ runId: pending.runId, generation: 7 }),
      finishAsfReconciliation(input) {
        order.push("durable-finish");
        return {
          ...recordFor(request(), "completed"),
          operationId: input.operationId,
          runId: pending.runId,
          resultDigest: input.resultDigest,
        };
      },
      releaseAsfRunOwnership() {
        order.push("release-fence");
      },
    });
    const service = new AsfReconciliationService({
      store,
      clock,
      scheduler: new ManualScheduler(),
      retryDelayMs: 1_000,
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        reconcilePending: async () => {
          hasPending = false;
          return [{ effectKey: "effect_completed", status: "confirmed" }];
        },
      },
      onReconciliationCompleted(completion) {
        order.push("notify-orchestrator");
        completions.push(completion);
      },
    });

    expect(service.recover()).toBe(1);
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(order).toEqual(["durable-finish", "release-fence", "notify-orchestrator"]);
    expect(completions[0]).toMatchObject({
      pendingSetBinding: {
        pendingSetDigest: pending.pendingSetDigest,
        githubEffectCount: pending.githubEffectCount,
        deliveryIntentCount: pending.deliveryIntentCount,
        retryBucket: Math.floor(Date.parse(NOW) / 1_000),
      },
      continuation: {
        disposition: "notification-only",
        requiredActor: "orchestrator",
        eligiblePausedPhase: "BLOCKED_EXTERNAL",
        requiresFreshClaim: true,
      },
    });
  });

  it("routes an exact pending set through both configured observer classes", async () => {
    const binding = {
      pendingSetDigest: `sha256:${"e".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 1,
      retryBucket: 123,
    } as const;
    const github = vi.fn(async () => [{ effectKey: "github_01", status: "confirmed" }]);
    const delivery = vi.fn(async () => [
      { effectKey: "delivery_01", status: "not_applied" },
    ]);
    const observer = new CompositeReconciliationObserver({
      githubEffects: { reconcilePending: github },
      deliveryIntents: { reconcilePending: delivery },
      maxResults: 2,
    });

    await expect(
      observer.reconcilePending({
        runId: "run_01",
        ownerId: "reconciler-a",
        generation: 7,
        pendingSetBinding: binding,
      }),
    ).resolves.toEqual([
      { effectClass: "github-effect", effectKey: "github_01", status: "confirmed" },
      { effectClass: "delivery-intent", effectKey: "delivery_01", status: "not_applied" },
    ]);
    expect(github).toHaveBeenCalledWith(expect.objectContaining({
      effectClass: "github-effect",
      expectedCount: 1,
      pendingSetBinding: binding,
    }));
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({
      effectClass: "delivery-intent",
      expectedCount: 1,
      pendingSetBinding: binding,
    }));
  });

  it("snapshots and revalidates the exact pending set for manual composite requests", async () => {
    const clock = new FakeClock(NOW);
    const pending = {
      runId: "run_01",
      pendingSetDigest: `sha256:${"9".repeat(64)}`,
      githubEffectCount: 1,
      deliveryIntentCount: 0,
    } as const;
    const github = vi.fn(async () => [{ effectKey: "github_manual", status: "confirmed" }]);
    const finished: unknown[] = [];
    const service = new AsfReconciliationService({
      store: fakeStore({
        discoverPendingAsfReconciliationRuns: () => ({ runs: [pending], nextRunId: null }),
        finishAsfReconciliation(input) {
          finished.push(input);
          return record(input.status);
        },
      }),
      clock,
      scheduler: new ManualScheduler(),
      retryDelayMs: 1_000,
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: new CompositeReconciliationObserver({
        githubEffects: { reconcilePending: github },
      }),
    });

    expect(service.request(request())).toMatchObject({ disposition: "queued" });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: "completed" });
    expect(github).toHaveBeenCalledWith({
      runId: "run_01",
      ownerId: "reconciler-a",
      generation: 7,
      effectClass: "github-effect",
      expectedCount: 1,
      pendingSetBinding: {
        pendingSetDigest: pending.pendingSetDigest,
        githubEffectCount: 1,
        deliveryIntentCount: 0,
        retryBucket: Math.floor(Date.parse(NOW) / 1_000),
      },
    });
  });

  it("fails closed before observation when a pending class is unconfigured", async () => {
    const github = vi.fn(async () => [{ effectKey: "github_01", status: "confirmed" }]);
    const observer = new CompositeReconciliationObserver({
      githubEffects: { reconcilePending: github },
    });
    await expect(
      observer.reconcilePending({
        runId: "run_01",
        ownerId: "reconciler-a",
        generation: 7,
        pendingSetBinding: {
          pendingSetDigest: `sha256:${"e".repeat(64)}`,
          githubEffectCount: 1,
          deliveryIntentCount: 1,
          retryBucket: 123,
        },
      }),
    ).rejects.toBeInstanceOf(RunmillError);
    expect(github).not.toHaveBeenCalled();
  });

  it("rejects class count mismatches and duplicate composite results", async () => {
    const base = {
      runId: "run_01",
      ownerId: "reconciler-a",
      generation: 7,
      pendingSetBinding: {
        pendingSetDigest: `sha256:${"e".repeat(64)}`,
        githubEffectCount: 1,
        deliveryIntentCount: 1,
        retryBucket: 123,
      },
    } as const;
    const missing = new CompositeReconciliationObserver({
      githubEffects: { reconcilePending: async () => [] },
      deliveryIntents: {
        reconcilePending: async () => [{ effectKey: "delivery_01", status: "confirmed" }],
      },
    });
    await expect(missing.reconcilePending(base)).rejects.toBeInstanceOf(RunmillError);

    const duplicate = new CompositeReconciliationObserver({
      githubEffects: {
        reconcilePending: async () => [{ effectKey: "same_effect", status: "confirmed" }],
      },
      deliveryIntents: {
        reconcilePending: async () => [{ effectKey: "same_effect", status: "confirmed" }],
      },
    });
    await expect(duplicate.reconcilePending(base)).rejects.toBeInstanceOf(RunmillError);
  });

  it("recovers existing queued and running requests without needing discovery", async () => {
    const queued = record("queued");
    const runningRequest = {
      ...record("running"),
      operationId: "reconcile_02",
      requestDigest: `sha256:${"b".repeat(64)}`,
    };
    const finished: string[] = [];
    const service = new AsfReconciliationService({
      store: fakeStore({
        listRecoverableAsfReconciliations: () => [queued, runningRequest],
        claimAsfReconciliation({ operationId }) {
          return { runId: operationId === queued.operationId ? queued.runId : "run_02", generation: 8 };
        },
        finishAsfReconciliation(input) {
          finished.push(input.operationId);
          return {
            ...(input.operationId === queued.operationId ? queued : runningRequest),
            status: "completed",
            generation: input.generation,
            ownerId: input.ownerId,
            completedAt: NOW,
            resultDigest: input.resultDigest,
          };
        },
      }),
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: { reconcilePending: async () => [] },
    });

    expect(service.recover()).toBe(2);
    await vi.waitFor(() => expect(finished).toHaveLength(2));
  });

  it("does not wake lifecycle for ambiguous results or after losing the finish fence", async () => {
    const completions: unknown[] = [];
    const blocked: unknown[] = [];
    const ambiguous = new AsfReconciliationService({
      store: fakeStore({
        finishAsfReconciliation(input) {
          blocked.push(input);
          return record(input.status);
        },
      }),
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        reconcilePending: async () => [
          { effectKey: "effect_01", status: "confirmed" },
          { effectKey: "effect_01", status: "not_applied" },
        ],
      },
      onReconciliationCompleted(completion) {
        completions.push(completion);
      },
    });
    ambiguous.request(request());
    await vi.waitFor(() => expect(blocked).toHaveLength(1));
    expect(blocked[0]).toMatchObject({ status: "blocked" });
    expect(completions).toEqual([]);

    let finishes = 0;
    const errors: unknown[] = [];
    const stale = new AsfReconciliationService({
      store: fakeStore({
        finishAsfReconciliation() {
          finishes += 1;
          throw RunmillError.fromCatalog("RM-LEASE-001", {
            whatHappened: "stale reconciliation owner",
          });
        },
      }),
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: {
        reconcilePending: async () => [{ effectKey: "effect_01", status: "confirmed" }],
      },
      onBackgroundError: (error) => errors.push(error),
      onReconciliationCompleted(completion) {
        completions.push(completion);
      },
    });
    stale.request(request());
    await vi.waitFor(() => expect(finishes).toBe(2));
    expect(errors).toHaveLength(2);
    expect(completions).toEqual([]);
  });

  it.each([
    [{ ...request(), schema: "asf.reconciliation-request/v2" }],
    [{ ...request(), scope: "retry-effects" }],
    [
      {
        ...request(),
        requested_by: {
          subject: "service:asf-controller",
          authority: "asf:mutate-github",
        },
      },
    ],
    [{ ...request(), arbitrary_command: "gh pr create" }],
  ])("rejects malformed or widened requests before durable work", (raw) => {
    let storeCalls = 0;
    const service = new AsfReconciliationService({
      store: fakeStore({
        recordAsfReconciliationRequest() {
          storeCalls += 1;
          throw new Error("must not be called");
        },
      }),
      clock: new FakeClock(NOW),
      workerId: "reconciler-a",
      staleOwnershipMs: 60_000,
      observer: { reconcilePending: async () => [] },
    });
    expect(() => service.request(raw)).toThrow(RunmillError);
    expect(storeCalls).toBe(0);
  });

  it("parses only the exact controller authority", () => {
    expect(parseReconciliationRequest(request())).toEqual(request());
  });
});
