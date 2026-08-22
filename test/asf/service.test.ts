import { describe, expect, it } from "vitest";
import {
  AsfPendingCiRetryError,
  AsfPendingTerminalEvidenceRetryError,
  AsfWorkerService,
  type AsfRunner,
  type AsfRunnerContext,
  type AsfWorkerScheduler,
  type AsfWorkerServiceOptions,
  type AsfWorkerStore,
  type AsfWorkOrderSubmitter,
} from "../../src/asf/service.js";
import type { AsfReconciliationCompletion } from "../../src/asf/reconciliation.js";
import {
  parseRunEvent,
  type RunEvent,
  type RunEventPhase,
} from "../../src/asf/run-event.js";
import type { SubmitWorkOrderResult } from "../../src/asf/work-order.js";
import {
  AsfCancellationService,
  type CancellationResult,
} from "../../src/asf/cancellation.js";
import type { AsfApprovalService } from "../../src/asf/approval.js";
import type {
  AsfAdmissionRecord,
  AsfEventRetentionCandidate,
  AsfEventPage,
  AsfRunRow,
} from "../../src/state/store.js";
import { MIN_ASF_DETAILED_EVENT_RETENTION_MS } from "../../src/state/store.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const NOW = "2026-08-21T10:05:00.000Z";
const RETENTION_ELIGIBLE_AT = new Date(
  Date.parse(NOW) - MIN_ASF_DETAILED_EVENT_RETENTION_MS,
).toISOString();

function runRow(overrides: Partial<AsfRunRow> = {}): AsfRunRow {
  return {
    runId: "run_01",
    issueId: "ENG-123",
    repo: "acme/payments",
    provider: "codex:asf-production",
    state: "ADMITTED",
    stateVersion: 1,
    attempt: 1,
    baseCommit: "a".repeat(40),
    candidateSha: null,
    branch: null,
    mode: "asf-worker",
    workOrderId: "wo_01",
    attemptId: "attempt_01",
    generation: 0,
    ownerId: null,
    heartbeatAt: null,
    ...overrides,
  };
}

function admissionRecord(
  overrides: Partial<AsfAdmissionRecord> = {},
): AsfAdmissionRecord {
  return {
    runId: "run_01",
    idempotencyKey: "tenant-acme/ENG-123/attempt_01",
    payloadDigest: DIGEST_A,
    envelopeDigest: DIGEST_B,
    workOrderId: "wo_01",
    attemptId: "attempt_01",
    tenantId: "tenant-acme",
    canonicalEnvelope: '{"secret":"full-envelope"}',
    effectivePolicy: '{"secret":"full-policy"}',
    effectivePolicyDigest: DIGEST_C,
    signatureKeyId: "asf-signing-key-2026-01",
    signatureAlgorithm: "EdDSA",
    acceptedAt: NOW,
    ...overrides,
  };
}

function retentionCandidate(
  overrides: Partial<AsfEventRetentionCandidate> = {},
): AsfEventRetentionCandidate {
  return {
    runId: "run_01",
    generation: 1,
    ownerId: null,
    terminalEventSeq: 3,
    terminalEventAt: RETENTION_ELIGIBLE_AT,
    bundleDigest: DIGEST_A,
    compactedThrough: 0,
    ...overrides,
  };
}

class FakeStore implements AsfWorkerStore {
  readonly runs = new Map<string, AsfRunRow>();
  readonly admissions = new Map<string, AsfAdmissionRecord>();
  readonly claims: Parameters<AsfWorkerStore["claimAsfRun"]>[0][] = [];
  readonly heartbeats: {
    runId: string;
    ownerId: string;
    generation: number;
  }[] = [];
  readonly releases: { runId: string; ownerId: string; generation: number }[] =
    [];
  readonly transitions: Parameters<AsfWorkerStore["transitionAsfRun"]>[0][] =
    [];
  readonly eventRequests: { runId: string; after: number; limit: number }[] =
    [];
  readonly claimFailuresRemaining = new Map<string, number>();
  readonly terminalPlans = new Set<string>();
  readonly retentionCandidates = new Map<string, AsfEventRetentionCandidate>();
  readonly compactions: Parameters<AsfWorkerStore["compactAsfRunEvents"]>[0][] =
    [];
  onTransition: (() => void) | undefined;
  onRelease: (() => void) | undefined;
  claimAllowed = true;
  transitionAllowed = true;
  claimGeneration: number | undefined;
  latestSequence = 1;
  recoverableLists = 0;
  retentionCandidateLists = 0;
  retentionNowMs = Date.parse(NOW);
  eventPage: AsfEventPage = {
    events: [],
    nextCursor: 0,
    hasMore: false,
    gap: false,
    compactedThrough: null,
    snapshot: { run: runRow(), latestSequence: 1 },
  };

  addRun(
    row = runRow(),
    admission = admissionRecord({ runId: row.runId }),
  ): void {
    this.runs.set(row.runId, row);
    this.admissions.set(row.runId, admission);
  }

  getAsfRun(runId: string): AsfRunRow | undefined {
    return this.runs.get(runId);
  }

  getAsfTerminalEvidencePlanRecord(runId: string) {
    if (!this.terminalPlans.has(runId)) return undefined;
    return { runId } as ReturnType<
      AsfWorkerStore["getAsfTerminalEvidencePlanRecord"]
    >;
  }

  getAsfEventRetentionCandidate(
    runId: string,
  ): AsfEventRetentionCandidate | undefined {
    return this.retentionCandidates.get(runId);
  }

  listAsfEventRetentionCandidates(
    limit = 10_000,
  ): readonly AsfEventRetentionCandidate[] {
    this.retentionCandidateLists += 1;
    return [...this.retentionCandidates.values()].slice(0, limit);
  }

  compactAsfRunEvents(
    input: Parameters<AsfWorkerStore["compactAsfRunEvents"]>[0],
  ): number {
    this.compactions.push(input);
    const candidate = this.retentionCandidates.get(input.runId);
    if (
      candidate === undefined ||
      candidate.ownerId !== null ||
      candidate.generation !== input.expectedGeneration ||
      candidate.bundleDigest !== input.expectedBundleDigest ||
      input.through !== candidate.terminalEventSeq - 1 ||
      input.minimumAgeMs < MIN_ASF_DETAILED_EVENT_RETENTION_MS ||
      this.retentionNowMs - Date.parse(candidate.terminalEventAt) <
        input.minimumAgeMs
    ) {
      throw new Error("fake ASF event retention refused unsafe compaction");
    }
    this.retentionCandidates.delete(input.runId);
    return input.through - candidate.compactedThrough;
  }

  getAsfAdmissionForRun(runId: string): AsfAdmissionRecord | undefined {
    return this.admissions.get(runId);
  }

  getAsfRunSnapshot(runId: string) {
    const run = this.runs.get(runId);
    if (run === undefined) return undefined;
    const admission = this.admissions.get(runId);
    if (admission === undefined) throw new Error("missing fake admission");
    return { run, admission, latestSequence: this.latestSequence };
  }

  listRecoverableAsfRuns(): AsfRunRow[] {
    this.recoverableLists += 1;
    return [...this.runs.values()].filter(
      (run) =>
        ![
          "COMPLETED",
          "CANCELLED",
          "FAILED",
          "REFUSED",
          "QUARANTINED",
          "BUDGET_EXHAUSTED",
        ].includes(run.state),
    );
  }

  claimAsfRun(
    input: Parameters<AsfWorkerStore["claimAsfRun"]>[0],
  ): { readonly generation: number; readonly takeover: boolean } | undefined {
    this.claims.push(input);
    const row = this.runs.get(input.runId);
    if (!this.claimAllowed || row === undefined) return undefined;
    const failures = this.claimFailuresRemaining.get(input.runId) ?? 0;
    if (failures > 0) {
      this.claimFailuresRemaining.set(input.runId, failures - 1);
      return undefined;
    }
    if (
      row.ownerId !== null &&
      row.heartbeatAt !== null &&
      row.heartbeatAt >= input.staleBefore
    ) {
      return undefined;
    }
    const takeover = row.ownerId !== null;
    const generation = this.claimGeneration ?? row.generation + 1;
    row.ownerId = input.ownerId;
    row.generation = generation;
    row.heartbeatAt = NOW;
    return { generation, takeover };
  }

  heartbeatAsfRun(runId: string, ownerId: string, generation: number): void {
    const row = this.runs.get(runId);
    if (
      row === undefined ||
      row.ownerId !== ownerId ||
      row.generation !== generation
    ) {
      throw new Error("stale fake heartbeat");
    }
    this.heartbeats.push({ runId, ownerId, generation });
    row.heartbeatAt = NOW;
  }

  releaseAsfRunOwnership(
    runId: string,
    ownerId: string,
    generation: number,
  ): void {
    const row = this.runs.get(runId);
    if (
      row === undefined ||
      row.ownerId !== ownerId ||
      row.generation !== generation
    ) {
      throw new Error("stale fake release");
    }
    this.releases.push({ runId, ownerId, generation });
    row.ownerId = null;
    row.heartbeatAt = null;
    this.onRelease?.();
  }

  transitionAsfRun(
    input: Parameters<AsfWorkerStore["transitionAsfRun"]>[0],
  ): RunEvent {
    if (!this.transitionAllowed) throw new Error("fake transition refused");
    const row = this.runs.get(input.runId);
    if (
      row === undefined ||
      row.ownerId !== input.ownerId ||
      row.generation !== input.generation ||
      row.state !== input.from ||
      row.stateVersion !== input.expectedVersion
    ) {
      throw new Error("stale fake transition");
    }
    this.onTransition?.();
    this.transitions.push(input);
    row.state = input.to;
    row.stateVersion += 1;
    const admission = this.admissions.get(input.runId);
    if (admission === undefined) throw new Error("missing fake admission");
    return parseRunEvent({
      schema: "asf.run-event/v1",
      event_id: `evt_${input.runId}_${this.transitions.length}`,
      run_id: input.runId,
      work_order_id: admission.workOrderId,
      attempt_id: admission.attemptId,
      seq: this.transitions.length + 1,
      occurred_at: NOW,
      type: input.eventType,
      phase: input.to,
      payload: input.payload,
      policy_digest: admission.effectivePolicyDigest,
    });
  }

  listAsfRunEvents(runId: string, after = 0, limit = 100): AsfEventPage {
    this.eventRequests.push({ runId, after, limit });
    return this.eventPage;
  }

  latestAsfRunEventSequence(_runId: string): number {
    return this.latestSequence;
  }
}

interface ManualScheduledTask {
  readonly delayMs: number;
  readonly task: () => void;
  cancelled: boolean;
}

class ManualScheduler implements AsfWorkerScheduler {
  readonly tasks: ManualScheduledTask[] = [];

  schedule(delayMs: number, task: () => void) {
    const scheduled: ManualScheduledTask = { delayMs, task, cancelled: false };
    this.tasks.push(scheduled);
    return {
      cancel: () => {
        scheduled.cancelled = true;
      },
    };
  }

  pending(delayMs?: number): number {
    return this.tasks.filter(
      (task) =>
        !task.cancelled && (delayMs === undefined || task.delayMs === delayMs),
    ).length;
  }

  runNext(delayMs?: number): boolean {
    const scheduled = this.tasks.find(
      (task) =>
        !task.cancelled && (delayMs === undefined || task.delayMs === delayMs),
    );
    if (scheduled === undefined) return false;
    scheduled.cancelled = true;
    scheduled.task();
    return true;
  }
}

class FakeAdmissionService implements AsfWorkOrderSubmitter {
  readonly calls: unknown[] = [];

  constructor(
    readonly result: SubmitWorkOrderResult,
    readonly beforeReturn?: (() => void) | undefined,
  ) {}

  async submit(raw: unknown): Promise<SubmitWorkOrderResult> {
    this.calls.push(raw);
    this.beforeReturn?.();
    return this.result;
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined)
        throw new Error("deferred promise was not initialized");
      resolvePromise();
    },
  };
}

function pauseRun(
  context: AsfRunnerContext,
  from: RunEventPhase = "ADMITTED",
  expectedVersion = 1,
): void {
  context.transition({
    from,
    to: "WAITING_APPROVAL",
    expectedVersion,
    eventType: "run.waiting_approval",
    payload: {
      code: "APPROVAL_REQUIRED",
      summary: "durable test pause",
      checkpoint: from,
      retry_disposition: "safe",
      required_actor: "repository-owner",
      required_action: "approve continuation",
      evidence_refs: [],
    },
  });
}

function admissionResult(
  disposition: SubmitWorkOrderResult["disposition"] = "accepted",
): SubmitWorkOrderResult {
  return { runId: "run_01", disposition, payloadDigest: DIGEST_A };
}

function service(options: {
  readonly store: FakeStore;
  readonly admission?: AsfWorkOrderSubmitter | undefined;
  readonly runner: AsfRunner;
  readonly clock?: FakeClock | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly scheduler?: AsfWorkerScheduler | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly detailedEventRetentionMs?: number | undefined;
  readonly eventRetentionScanLimit?: number | undefined;
  readonly cancellation?: Pick<AsfCancellationService, "request"> | undefined;
  readonly approval?: Pick<AsfApprovalService, "record"> | undefined;
  readonly reconciliation?:
    | AsfWorkerServiceOptions["reconciliation"]
    | undefined;
  readonly outcome?: AsfWorkerServiceOptions["outcome"] | undefined;
  readonly onBackgroundError?:
    | ((error: unknown, runId: string) => void)
    | undefined;
}): AsfWorkerService {
  return new AsfWorkerService({
    store: options.store,
    admission: options.admission ?? new FakeAdmissionService(admissionResult()),
    clock: options.clock ?? new FakeClock(NOW),
    workerId: "worker-alpha",
    staleOwnershipMs: 60_000,
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    ...(options.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: options.retryDelayMs }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.detailedEventRetentionMs === undefined
      ? {}
      : { detailedEventRetentionMs: options.detailedEventRetentionMs }),
    ...(options.eventRetentionScanLimit === undefined
      ? {}
      : { eventRetentionScanLimit: options.eventRetentionScanLimit }),
    runner: options.runner,
    ...(options.cancellation === undefined
      ? {}
      : { cancellation: options.cancellation }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.reconciliation === undefined
      ? {}
      : { reconciliation: options.reconciliation }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.onBackgroundError === undefined
      ? {}
      : { onBackgroundError: options.onBackgroundError }),
  });
}

function outcomeThatAcknowledges(
  store: FakeStore,
  candidate: AsfEventRetentionCandidate,
): NonNullable<AsfWorkerServiceOptions["outcome"]> {
  let recorded = false;
  return {
    acknowledge() {
      store.retentionCandidates.set(candidate.runId, candidate);
      const disposition = recorded ? "existing" : "recorded";
      recorded = true;
      return {
        acknowledgementId: `ack_${candidate.runId}`,
        runId: candidate.runId,
        bundleDigest: candidate.bundleDigest,
        disposition,
        acknowledgedAt: NOW,
      };
    },
  };
}

describe("AsfWorkerService submission", () => {
  it("acknowledges durable admission without waiting for the background runner", async () => {
    const store = new FakeStore();
    let persistedBeforeRunner = false;
    const runnerFinish = deferred();
    const admission = new FakeAdmissionService(admissionResult(), () => {
      store.addRun();
      persistedBeforeRunner = true;
    });
    let runnerStarted = false;
    const worker = service({
      store,
      admission,
      runner: async (context) => {
        runnerStarted = true;
        expect(persistedBeforeRunner).toBe(true);
        expect(store.getAsfRun("run_01")).toBeDefined();
        await runnerFinish.promise;
        pauseRun(context);
      },
    });

    const result = await worker.submitWorkOrder({ schema: "fixture" });

    expect(result).toEqual(admissionResult());
    expect(admission.calls).toHaveLength(1);
    expect(runnerStarted).toBe(true);
    runnerFinish.resolve();
  });

  it("deduplicates identical retries while one runner is active", async () => {
    const store = new FakeStore();
    store.addRun();
    const runnerFinish = deferred();
    let invocations = 0;
    const admission = new FakeAdmissionService(admissionResult("existing"));
    const worker = service({
      store,
      admission,
      runner: async (context) => {
        invocations += 1;
        await runnerFinish.promise;
        pauseRun(context);
      },
    });

    await Promise.all([
      worker.submitWorkOrder({ retry: 1 }),
      worker.submitWorkOrder({ retry: 2 }),
    ]);

    expect(admission.calls).toHaveLength(2);
    expect(store.claims).toHaveLength(1);
    expect(invocations).toBe(1);
    runnerFinish.resolve();
  });

  it("never invokes the runner when durable ownership cannot be claimed", async () => {
    const store = new FakeStore();
    store.addRun();
    store.claimAllowed = false;
    let invocations = 0;
    const worker = service({
      store,
      runner: async () => {
        invocations += 1;
      },
    });

    await worker.submitWorkOrder({});
    await Promise.resolve();

    expect(store.claims).toHaveLength(1);
    expect(invocations).toBe(0);
  });

  it("retries a fresh-owner denial after restart without a local runner trigger", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({
        generation: 4,
        ownerId: "worker-before-restart",
        heartbeatAt: NOW,
      }),
    );
    const clock = new FakeClock(NOW);
    const scheduler = new ManualScheduler();
    const started = deferred();
    let takeover: boolean | undefined;
    const worker = service({
      store,
      clock,
      scheduler,
      retryDelayMs: 250,
      heartbeatIntervalMs: 5_000,
      runner: async (context) => {
        takeover = context.takeover;
        started.resolve();
        pauseRun(context);
      },
    });

    expect(worker.recover()).toBe(1);
    await Promise.resolve();

    expect(store.claims).toHaveLength(1);
    expect(scheduler.pending(250)).toBe(1);
    expect(takeover).toBeUndefined();
    await Promise.resolve();
    expect(store.claims).toHaveLength(1);

    clock.advanceMs(60_001);
    expect(scheduler.runNext(250)).toBe(true);
    await started.promise;

    expect(store.claims).toHaveLength(2);
    expect(store.claims[1]?.staleBefore).toBe("2026-08-21T10:05:00.001Z");
    expect(takeover).toBe(true);
  });
});

describe("AsfWorkerService fencing and recovery", () => {
  it("retries a frozen terminal plan when its timer fires before runner cleanup", async () => {
    const store = new FakeStore();
    store.addRun();
    store.terminalPlans.add("run_01");
    const deferredScheduler = new ManualScheduler();
    const scheduler: AsfWorkerScheduler = {
      schedule(delayMs, task) {
        if (delayMs === 250) {
          task();
          return { cancel: () => undefined };
        }
        return deferredScheduler.schedule(delayMs, task);
      },
    };
    const secondAttempt = deferred();
    let invocations = 0;
    const worker = service({
      store,
      scheduler,
      retryDelayMs: 250,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          throw new AsfPendingTerminalEvidenceRetryError(
            context.runId,
            new Error("transient terminal signer failure"),
          );
        }
        const row = store.runs.get(context.runId);
        if (row === undefined) throw new Error("missing pending terminal run");
        row.state = "FAILED";
        row.stateVersion = 2;
        secondAttempt.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await secondAttempt.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(invocations).toBe(2);
    expect(store.claims).toHaveLength(2);
    expect(store.transitions).toHaveLength(0);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "FAILED",
      ownerId: null,
      generation: 2,
    });
  });

  it("releases pending CI ownership and performs only one bounded delayed retry", async () => {
    const candidateSha = "c".repeat(40);
    const store = new FakeStore();
    store.addRun(
      runRow({
        state: "CI_WAIT",
        stateVersion: 7,
        candidateSha,
      }),
    );
    store.eventPage = {
      events: [
        parseRunEvent({
          schema: "asf.run-event/v1",
          event_id: "evt_ci_pending",
          run_id: "run_01",
          work_order_id: "wo_01",
          attempt_id: "attempt_01",
          seq: 7,
          occurred_at: NOW,
          type: "ci.recheck_completed",
          phase: "CI_WAIT",
          payload: {
            candidate_sha: candidateSha,
            outcome: "pending",
            observation_intent_digest: DIGEST_A,
            observation_digest: DIGEST_B,
            observation_fencing_generation: 1,
            checks_digest: DIGEST_C,
            checks: [
              {
                context: "ci/test",
                outcome: "pending",
                evidence_digest: DIGEST_A,
              },
            ],
            observed_at: NOW,
          },
          policy_digest: DIGEST_C,
        }),
      ],
      nextCursor: 7,
      hasMore: false,
      gap: false,
      compactedThrough: null,
      snapshot: {
        run: runRow({ state: "CI_WAIT", stateVersion: 7, candidateSha }),
        latestSequence: 7,
      },
    };
    const scheduler = new ManualScheduler();
    const firstRelease = deferred();
    const completed = deferred();
    store.onRelease = firstRelease.resolve;
    let invocations = 0;
    const worker = service({
      store,
      scheduler,
      retryDelayMs: 250,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          throw new AsfPendingCiRetryError({
            runId: context.runId,
            phase: "CI_WAIT",
            candidateSha,
            intentDigest: DIGEST_A,
            observationDigest: DIGEST_B,
            checksDigest: DIGEST_C,
          });
        }
        const row = store.runs.get(context.runId);
        if (row === undefined) throw new Error("missing pending CI run");
        row.state = "COMPLETED";
        row.stateVersion = 8;
        completed.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await firstRelease.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(invocations).toBe(1);
    expect(store.transitions).toHaveLength(0);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "CI_WAIT",
      ownerId: null,
    });
    expect(scheduler.pending(250)).toBe(1);
    await Promise.resolve();
    expect(invocations).toBe(1);

    expect(scheduler.runNext(250)).toBe(true);
    await completed.promise;
    expect(invocations).toBe(2);
    expect(store.claims).toHaveLength(2);
  });

  it("cancels a pending CI delayed wake before scheduling fenced cancellation", async () => {
    const candidateSha = "c".repeat(40);
    const store = new FakeStore();
    store.addRun(
      runRow({ state: "CI_WAIT", stateVersion: 7, candidateSha }),
    );
    store.eventPage = {
      events: [
        parseRunEvent({
          schema: "asf.run-event/v1",
          event_id: "evt_ci_pending_cancel",
          run_id: "run_01",
          work_order_id: "wo_01",
          attempt_id: "attempt_01",
          seq: 7,
          occurred_at: NOW,
          type: "ci.recheck_completed",
          phase: "CI_WAIT",
          payload: {
            candidate_sha: candidateSha,
            outcome: "pending",
            observation_intent_digest: DIGEST_A,
            observation_digest: DIGEST_B,
            observation_fencing_generation: 1,
            checks_digest: DIGEST_C,
            checks: [
              {
                context: "ci/test",
                outcome: "pending",
                evidence_digest: DIGEST_A,
              },
            ],
            observed_at: NOW,
          },
          policy_digest: DIGEST_C,
        }),
      ],
      nextCursor: 7,
      hasMore: false,
      gap: false,
      compactedThrough: null,
      snapshot: {
        run: runRow({ state: "CI_WAIT", stateVersion: 7, candidateSha }),
        latestSequence: 7,
      },
    };
    const scheduler = new ManualScheduler();
    const released = deferred();
    const cancelled = deferred();
    store.onRelease = released.resolve;
    let invocations = 0;
    const cancellation: Pick<AsfCancellationService, "request"> = {
      request(): CancellationResult {
        const row = store.runs.get("run_01");
        if (row === undefined) throw new Error("missing pending CI run");
        row.state = "CANCEL_REQUESTED";
        row.stateVersion = 8;
        row.generation += 1;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          requestId: "cancel_ci_pending",
          runId: "run_01",
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: row.generation,
          requestDigest: DIGEST_A,
          reconciliationRequired: false,
        };
      },
    };
    const worker = service({
      store,
      scheduler,
      retryDelayMs: 250,
      cancellation,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          throw new AsfPendingCiRetryError({
            runId: context.runId,
            phase: "CI_WAIT",
            candidateSha,
            intentDigest: DIGEST_A,
            observationDigest: DIGEST_B,
            checksDigest: DIGEST_C,
          });
        }
        const row = store.runs.get(context.runId);
        if (row === undefined || row.state !== "CANCEL_REQUESTED") {
          throw new Error("cancellation did not win the pending CI wake");
        }
        row.state = "CANCELLED";
        row.stateVersion = 9;
        cancelled.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await released.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.pending(250)).toBe(1);

    worker.requestCancellation({ schema: "fixture-cancel" });
    await cancelled.promise;

    expect(scheduler.pending(250)).toBe(0);
    expect(invocations).toBe(2);
    expect(store.getAsfRun("run_01")?.state).toBe("CANCELLED");
  });

  it("claims and continues only after approval durably resumes the stored phase", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({
        state: "WAITING_APPROVAL",
        stateVersion: 7,
        candidateSha: "c".repeat(40),
        generation: 4,
      }),
    );
    const continued = deferred();
    const released = deferred();
    store.onRelease = released.resolve;
    const approval: Pick<AsfApprovalService, "record"> = {
      record(raw) {
        expect(raw).toEqual({ schema: "signed-approval" });
        const row = store.runs.get("run_01");
        if (row === undefined) throw new Error("missing paused fake run");
        // Model the store's atomic approval + run.resumed transaction. It
        // deliberately leaves ownership empty for the worker's next claim.
        row.state = "CANDIDATE_READY";
        row.stateVersion = 8;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          approvalId: "approval_01",
          runId: "run_01",
          decision: "approved",
          disposition: "recorded",
          envelopeDigest: DIGEST_A,
          resumed: true,
          resumePhase: "CANDIDATE_READY",
        };
      },
    };
    const worker = service({
      store,
      approval,
      runner: async (context) => {
        expect(context.generation).toBe(5);
        expect(store.getAsfRun(context.runId)).toMatchObject({
          state: "CANDIDATE_READY",
          ownerId: "worker-alpha",
          generation: 5,
        });
        continued.resolve();
        pauseRun(context, "CANDIDATE_READY", 8);
      },
    });

    expect(worker.recordApproval({ schema: "signed-approval" })).toMatchObject({
      approvalId: "approval_01",
      resumed: true,
      resumePhase: "CANDIDATE_READY",
    });
    await continued.promise;
    await released.promise;

    expect(store.claims).toHaveLength(1);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "WAITING_APPROVAL",
      generation: 5,
      ownerId: null,
    });
  });

  it("does not schedule denied or otherwise non-resuming approval outcomes", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({ state: "WAITING_APPROVAL", stateVersion: 7, generation: 4 }),
    );
    const approval: Pick<AsfApprovalService, "record"> = {
      record() {
        return {
          approvalId: "approval_denied",
          runId: "run_01",
          decision: "denied",
          disposition: "recorded",
          envelopeDigest: DIGEST_A,
          resumed: false,
          resumePhase: null,
        };
      },
    };
    let invoked = false;
    const worker = service({
      store,
      approval,
      runner: async () => {
        invoked = true;
      },
    });

    expect(worker.recordApproval({ schema: "denied-approval" })).toMatchObject({
      decision: "denied",
      resumed: false,
    });
    await Promise.resolve();

    expect(invoked).toBe(false);
    expect(store.claims).toHaveLength(0);
    expect(worker.runtimeSnapshot()).toMatchObject({
      queuedRuns: 0,
      activeRuns: 0,
    });
  });

  it("binds the injected clock, worker, generation, and takeover into runner operations", async () => {
    const store = new FakeStore();
    store.addRun();
    store.claimGeneration = 7;
    const completed = deferred();
    const released = deferred();
    store.onRelease = released.resolve;
    const worker = service({
      store,
      clock: new FakeClock(NOW),
      runner: async (context) => {
        expect(context.runId).toBe("run_01");
        expect(context.generation).toBe(7);
        expect(context.takeover).toBe(false);
        expect(context.signal.aborted).toBe(false);
        context.transition({
          from: "ADMITTED",
          to: "REPOSITORY_LEASED",
          expectedVersion: 1,
          eventType: "repository.lease_acquired",
          payload: { repository: "acme/payments", generation: 7 },
        });
        pauseRun(context, "REPOSITORY_LEASED", 2);
        completed.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await completed.promise;
    await released.promise;

    expect(store.claims).toEqual([
      {
        runId: "run_01",
        ownerId: "worker-alpha",
        staleBefore: "2026-08-21T10:04:00.000Z",
        maxHostConcurrency: 1,
      },
    ]);
    expect(store.transitions[0]).toMatchObject({
      runId: "run_01",
      ownerId: "worker-alpha",
      generation: 7,
      from: "ADMITTED",
      to: "REPOSITORY_LEASED",
    });
    expect(store.releases).toEqual([
      { runId: "run_01", ownerId: "worker-alpha", generation: 7 },
    ]);
  });

  it("owns heartbeats for a long runner and stops them when the durable pause releases", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const started = deferred();
    const finish = deferred();
    const released = deferred();
    store.onRelease = released.resolve;
    const worker = service({
      store,
      scheduler,
      heartbeatIntervalMs: 500,
      runner: async (context) => {
        started.resolve();
        await finish.promise;
        pauseRun(context);
      },
    });

    await worker.submitWorkOrder({});
    await started.promise;
    expect(scheduler.pending(500)).toBe(1);

    expect(scheduler.runNext(500)).toBe(true);
    expect(scheduler.runNext(500)).toBe(true);
    expect(store.heartbeats).toEqual([
      { runId: "run_01", ownerId: "worker-alpha", generation: 1 },
      { runId: "run_01", ownerId: "worker-alpha", generation: 1 },
    ]);

    finish.resolve();
    await released.promise;
    expect(scheduler.pending(500)).toBe(0);
  });

  it("aborts and fences a runner when its service-owned heartbeat loses ownership", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const started = deferred();
    const stopped = deferred();
    const reported: { error: unknown; runId: string }[] = [];
    let signal: AbortSignal | undefined;
    let transitionError: unknown;
    const worker = service({
      store,
      scheduler,
      heartbeatIntervalMs: 500,
      runner: async (context) => {
        signal = context.signal;
        started.resolve();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        try {
          pauseRun(context);
        } catch (error) {
          transitionError = error;
        }
        stopped.resolve();
      },
      onBackgroundError: (error, runId) => reported.push({ error, runId }),
    });

    await worker.submitWorkOrder({});
    await started.promise;
    expect(signal?.aborted).toBe(false);

    const row = store.runs.get("run_01");
    if (row === undefined) throw new Error("missing fake run");
    row.ownerId = "worker-new-owner";
    row.generation = 2;
    row.heartbeatAt = NOW;
    expect(scheduler.runNext(500)).toBe(true);
    await stopped.promise;

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toEqual(new Error("stale fake heartbeat"));
    expect(scheduler.pending(500)).toBe(0);
    expect(transitionError).toEqual(
      new Error("ASF runner for run_01 generation 1 lost fenced ownership"),
    );
    expect(reported).toEqual([
      { error: new Error("stale fake heartbeat"), runId: "run_01" },
    ]);
    expect(store.transitions).toHaveLength(0);
    expect(store.releases).toHaveLength(0);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "ADMITTED",
      ownerId: "worker-new-owner",
      generation: 2,
    });
  });

  it("acknowledges durable cancellation, aborts the fenced runner, and resumes cleanup", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const firstStarted = deferred();
    const cancelled = deferred();
    const released = deferred();
    store.onRelease = released.resolve;
    let firstSignal: AbortSignal | undefined;
    let invocations = 0;
    const cancellation: Pick<AsfCancellationService, "request"> = {
      request(raw): CancellationResult {
        expect(raw).toEqual({ schema: "fixture-cancel" });
        const row = store.runs.get("run_01");
        if (row === undefined) throw new Error("missing fake cancellation run");
        // Model the store's atomic durable transition and generation fence.
        row.state = "CANCEL_REQUESTED";
        row.stateVersion = 2;
        row.generation = 2;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          requestId: "cancel_01",
          runId: "run_01",
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 2,
          requestDigest: DIGEST_A,
          reconciliationRequired: false,
        };
      },
    };
    const worker = service({
      store,
      scheduler,
      heartbeatIntervalMs: 500,
      cancellation,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          firstSignal = context.signal;
          firstStarted.resolve();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return;
        }
        const payload = {
          code: "CANCELLED",
          summary: "authorized cancellation is being applied",
          checkpoint: "CANCEL_REQUESTED",
          retry_disposition: "safe",
          required_actor: "asf",
          required_action: "start a new attempt only if work remains required",
          evidence_refs: ["cancellation:cancel_01"],
          request_id: "cancel_01",
          requester: "service:asf-controller",
          reason: `protected:${DIGEST_A}`,
          mode: "graceful",
          grace_seconds: 15,
        } as const;
        context.transition({
          from: "CANCEL_REQUESTED",
          to: "CANCELLING",
          expectedVersion: 2,
          eventType: "cancellation.started",
          payload,
        });
        context.transition({
          from: "CANCELLING",
          to: "CANCELLED",
          expectedVersion: 3,
          eventType: "run.cancelled",
          payload: { ...payload, checkpoint: "CANCELLING" },
        });
        cancelled.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await firstStarted.promise;
    const result = worker.requestCancellation({ schema: "fixture-cancel" });
    expect(result).toMatchObject({ disposition: "requested", generation: 2 });
    expect(firstSignal?.aborted).toBe(true);
    await cancelled.promise;
    await released.promise;

    expect(invocations).toBe(2);
    expect(store.claims).toHaveLength(2);
    expect(store.claims.map((claim) => claim.runId)).toEqual([
      "run_01",
      "run_01",
    ]);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "CANCELLED",
      generation: 3,
    });
    expect(store.releases).toEqual([
      { runId: "run_01", ownerId: "worker-alpha", generation: 3 },
    ]);
  });

  it("fences immediately but lets a graceful cancellation finish its atomic operation until the exact deadline", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const firstStarted = deferred();
    const firstFinished = deferred();
    const cancelled = deferred();
    let firstSignal: AbortSignal | undefined;
    let invocations = 0;
    const cancellation = new AsfCancellationService({
      requestAsfCancellation(input): CancellationResult {
        const row = store.runs.get(input.request.run_id);
        if (row === undefined) throw new Error("missing fake cancellation run");
        row.state = "CANCEL_REQUESTED";
        row.stateVersion = 2;
        row.generation = 2;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          requestId: input.request.request_id,
          runId: input.request.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 2,
          requestDigest: input.requestDigest,
          reconciliationRequired: false,
        };
      },
    });
    const worker = service({
      store,
      scheduler,
      heartbeatIntervalMs: 500,
      cancellation,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          firstSignal = context.signal;
          firstStarted.resolve();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          firstFinished.resolve();
          return;
        }
        const row = store.runs.get(context.runId);
        if (row === undefined) throw new Error("missing fake cancellation run");
        row.state = "CANCELLED";
        cancelled.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await firstStarted.promise;
    worker.requestCancellation({
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_graceful",
      run_id: "run_01",
      requester: { subject: "service:asf-controller", authority: "asf:cancel" },
      reason: "finish the current atomic operation, then stop",
      mode: "graceful",
      grace_seconds: 15,
    });

    expect(firstSignal?.aborted).toBe(false);
    expect(scheduler.pending(500)).toBe(0);
    expect(scheduler.pending(15_000)).toBe(1);
    expect(scheduler.runNext(15_000)).toBe(true);
    await firstFinished.promise;
    await cancelled.promise;
    expect(firstSignal?.aborted).toBe(true);
    expect(invocations).toBe(2);
  });

  it("aborts protected lifecycles as soon as a graceful operation reaches its boundary", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const started = deferred();
    const finishAtomicOperation = deferred();
    const boundaryAborted = deferred();
    const cancelled = deferred();
    let firstSignal: AbortSignal | undefined;
    let invocations = 0;
    const cancellation = new AsfCancellationService({
      requestAsfCancellation(input): CancellationResult {
        const row = store.runs.get(input.request.run_id);
        if (row === undefined) throw new Error("missing fake cancellation run");
        row.state = "CANCEL_REQUESTED";
        row.stateVersion = 2;
        row.generation = 2;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          requestId: input.request.request_id,
          runId: input.request.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 2,
          requestDigest: input.requestDigest,
          reconciliationRequired: false,
        };
      },
    });
    const worker = service({
      store,
      scheduler,
      cancellation,
      runner: async (context) => {
        invocations += 1;
        if (invocations === 1) {
          firstSignal = context.signal;
          context.signal.addEventListener("abort", boundaryAborted.resolve, {
            once: true,
          });
          started.resolve();
          await finishAtomicOperation.promise;
          return;
        }
        const row = store.runs.get(context.runId);
        if (row !== undefined) row.state = "CANCELLED";
        cancelled.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await started.promise;
    worker.requestCancellation({
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_boundary",
      run_id: "run_01",
      requester: { subject: "service:asf-controller", authority: "asf:cancel" },
      reason: "finish the current atomic operation, then revoke authority",
      mode: "graceful",
      grace_seconds: 30,
    });

    expect(firstSignal?.aborted).toBe(false);
    finishAtomicOperation.resolve();
    await boundaryAborted.promise;
    await cancelled.promise;

    expect(firstSignal?.aborted).toBe(true);
    expect(scheduler.pending(30_000)).toBe(0);
    expect(invocations).toBe(2);
  });

  it("forces cancellation immediately even when a graceful deadline was already pending", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const started = deferred();
    const stopped = deferred();
    let signal: AbortSignal | undefined;
    let generation = 1;
    let invocations = 0;
    const cancellation = new AsfCancellationService({
      requestAsfCancellation(input): CancellationResult {
        generation += 1;
        const row = store.runs.get(input.request.run_id);
        if (row === undefined) throw new Error("missing fake cancellation run");
        row.state = "CANCEL_REQUESTED";
        row.stateVersion += 1;
        row.generation = generation;
        row.ownerId = null;
        row.heartbeatAt = null;
        return {
          requestId: input.request.request_id,
          runId: input.request.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation,
          requestDigest: input.requestDigest,
          reconciliationRequired: input.request.mode === "forced",
        };
      },
    });
    const worker = service({
      store,
      scheduler,
      cancellation,
      runner: async (context) => {
        invocations += 1;
        if (invocations > 1) {
          const row = store.runs.get(context.runId);
          if (row !== undefined) row.state = "CANCELLED";
          return;
        }
        signal = context.signal;
        started.resolve();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        stopped.resolve();
      },
    });

    await worker.submitWorkOrder({});
    await started.promise;
    worker.requestCancellation({
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_graceful",
      run_id: "run_01",
      requester: { subject: "service:asf-controller", authority: "asf:cancel" },
      reason: "start graceful shutdown",
      mode: "graceful",
      grace_seconds: 30,
    });
    expect(signal?.aborted).toBe(false);
    expect(scheduler.pending(30_000)).toBe(1);

    worker.requestCancellation({
      schema: "asf.cancellation-request/v1",
      request_id: "cancel_forced",
      run_id: "run_01",
      requester: { subject: "service:asf-controller", authority: "asf:cancel" },
      reason: "grace period was revoked",
      mode: "forced",
      grace_seconds: 0,
    });
    await stopped.promise;
    expect(signal?.aborted).toBe(true);
    expect(scheduler.pending(30_000)).toBe(0);
  });

  it("does not give a runner an early ownership release capability", async () => {
    const store = new FakeStore();
    store.addRun();
    const scheduler = new ManualScheduler();
    const started = deferred();
    const finish = deferred();
    const released = deferred();
    store.onRelease = released.resolve;
    const worker = service({
      store,
      scheduler,
      runner: async (context) => {
        expect(context).not.toHaveProperty("release");
        expect(context).not.toHaveProperty("heartbeat");
        started.resolve();
        await finish.promise;
        pauseRun(context);
      },
    });

    await worker.submitWorkOrder({});
    await started.promise;
    expect(store.releases).toHaveLength(0);
    expect(store.getAsfRun("run_01")?.ownerId).toBe("worker-alpha");

    finish.resolve();
    await released.promise;
    expect(store.releases).toHaveLength(1);
  });

  it("serializes runs from the same repository even when host concurrency is higher", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({ runId: "run_repo_1", repo: "Acme/Payments" }),
      admissionRecord({ runId: "run_repo_1", workOrderId: "wo_repo_1" }),
    );
    store.addRun(
      runRow({ runId: "run_repo_2", repo: "acme/payments" }),
      admissionRecord({ runId: "run_repo_2", workOrderId: "wo_repo_2" }),
    );
    const firstStarted = deferred();
    const finishFirst = deferred();
    const secondStarted = deferred();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const worker = service({
      store,
      maxConcurrency: 2,
      runner: async (context) => {
        const { runId } = context;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        starts.push(runId);
        if (runId === "run_repo_1") {
          firstStarted.resolve();
          await finishFirst.promise;
        } else {
          secondStarted.resolve();
        }
        pauseRun(context);
        active -= 1;
      },
    });

    expect(worker.recover()).toBe(2);
    await firstStarted.promise;
    await Promise.resolve();
    expect(starts).toEqual(["run_repo_1"]);
    expect(store.claims.map((claim) => claim.runId)).toEqual(["run_repo_1"]);

    finishFirst.resolve();
    await secondStarted.promise;

    expect(starts).toEqual(["run_repo_1", "run_repo_2"]);
    expect(maximumActive).toBe(1);
    expect(store.claims.map((claim) => claim.maxHostConcurrency)).toEqual([
      2, 2,
    ]);
  });

  it("keeps a capacity-refused run queued and retries it after the active run completes", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({ runId: "run_1", repo: "acme/one" }),
      admissionRecord({ runId: "run_1", workOrderId: "wo_1" }),
    );
    store.addRun(
      runRow({ runId: "run_2", repo: "acme/two" }),
      admissionRecord({ runId: "run_2", workOrderId: "wo_2" }),
    );
    store.claimFailuresRemaining.set("run_2", 1);
    const firstStarted = deferred();
    const finishFirst = deferred();
    const secondStarted = deferred();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const worker = service({
      store,
      maxConcurrency: 2,
      runner: async (context) => {
        const { runId } = context;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        starts.push(runId);
        if (runId === "run_1") {
          firstStarted.resolve();
          await finishFirst.promise;
        } else {
          secondStarted.resolve();
        }
        pauseRun(context);
        active -= 1;
      },
    });

    expect(worker.recover()).toBe(2);
    await firstStarted.promise;
    await Promise.resolve();
    expect(starts).toEqual(["run_1"]);
    expect(
      store.claims.filter((claim) => claim.runId === "run_2"),
    ).toHaveLength(1);

    finishFirst.resolve();
    await secondStarted.promise;

    expect(starts).toEqual(["run_1", "run_2"]);
    expect(maximumActive).toBe(1);
    expect(
      store.claims.filter((claim) => claim.runId === "run_2"),
    ).toHaveLength(2);
  });

  it("recovers every nonterminal run and skips terminal history", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({ runId: "run_admitted" }),
      admissionRecord({ runId: "run_admitted" }),
    );
    store.addRun(
      runRow({ runId: "run_waiting", state: "WAITING_APPROVAL" }),
      admissionRecord({ runId: "run_waiting" }),
    );
    store.addRun(
      runRow({ runId: "run_completed", state: "COMPLETED" }),
      admissionRecord({ runId: "run_completed" }),
    );
    const bothStarted = deferred();
    const invoked: string[] = [];
    const worker = service({
      store,
      runner: async (context) => {
        const { runId } = context;
        invoked.push(runId);
        if (invoked.length === 2) bothStarted.resolve();
        if (store.getAsfRun(runId)?.state === "ADMITTED") pauseRun(context);
      },
    });

    expect(worker.recover()).toBe(2);
    await bothStarted.promise;

    expect(invoked).toEqual(["run_admitted", "run_waiting"]);
    expect(store.claims.map((claim) => claim.runId)).toEqual([
      "run_admitted",
      "run_waiting",
    ]);
    expect(store.recoverableLists).toBe(1);
  });

  it("wakes only an exact durable reconciliation continuation committed by the store", async () => {
    const store = new FakeStore();
    const candidateSha = "d".repeat(40);
    store.addRun(
      runRow({
        state: "CANDIDATE_READY",
        stateVersion: 9,
        generation: 2,
        candidateSha,
      }),
    );
    const operationId = "reconcile_exact_01";
    const resumed = parseRunEvent({
      schema: "asf.run-event/v1",
      event_id: "evt_reconciliation_resume_01",
      run_id: "run_01",
      work_order_id: "wo_01",
      attempt_id: "attempt_01",
      seq: 9,
      occurred_at: NOW,
      type: "run.resumed",
      phase: "CANDIDATE_READY",
      payload: {
        interrupted_phase: "BLOCKED_EXTERNAL",
        resume_phase: "CANDIDATE_READY",
        evidence_digest: DIGEST_A,
        candidate_sha: candidateSha,
        reconciliation: {
          schema: "asf.reconciliation-continuation-result/v1",
          operation_id: operationId,
          result_digest: DIGEST_B,
          pending_set_digest: DIGEST_C,
          checkpoint_digest: DIGEST_A,
          blocked_event_id: "evt_blocked_01",
          interrupted_event_seq: 7,
          action: "continue-confirmed",
        },
      },
      policy_digest: DIGEST_C,
    });
    store.eventPage = {
      events: [resumed],
      nextCursor: 9,
      hasMore: false,
      gap: false,
      compactedThrough: null,
      snapshot: {
        run: store.getAsfRun("run_01") as AsfRunRow,
        latestSequence: 9,
      },
    };
    let continuationHandler:
      | ((completion: AsfReconciliationCompletion) => void | Promise<void>)
      | undefined;
    const reconciliation = {
      request(): never {
        throw new Error("not used in this test");
      },
      recover(): number {
        return 0;
      },
      bindDurableContinuationHandler(
        handler: (
          completion: AsfReconciliationCompletion,
        ) => void | Promise<void>,
      ): void {
        continuationHandler = handler;
      },
    };
    const started = deferred();
    const worker = service({
      store,
      reconciliation,
      runner: async (context) => {
        expect(context).toMatchObject({
          runId: "run_01",
          generation: 3,
          takeover: false,
        });
        started.resolve();
        pauseRun(context, "CANDIDATE_READY", 9);
      },
    });
    expect(continuationHandler).toBeTypeOf("function");
    const durableContinuation = {
      disposition: "run-resumed" as const,
      runId: "run_01",
      operationId,
      resumedEventSeq: 9,
      resumePhase: "CANDIDATE_READY",
      resultDigest: DIGEST_B,
    };
    const completion: AsfReconciliationCompletion = {
      operationId,
      runId: "run_01",
      generation: 2,
      resultDigest: DIGEST_B,
      completedAt: NOW,
      pendingSetBinding: {
        pendingSetDigest: DIGEST_C,
        githubEffectCount: 1,
        deliveryIntentCount: 0,
        retryBucket: 1,
      },
      continuation: durableContinuation,
    };
    await continuationHandler?.(completion);
    await started.promise;
    expect(store.eventRequests).toContainEqual({
      runId: "run_01",
      after: 8,
      limit: 1,
    });

    expect(() =>
      worker.notifyReconciliationContinuation({
        ...completion,
        resultDigest: DIGEST_A,
        continuation: { ...durableContinuation, resultDigest: DIGEST_A },
      }),
    ).toThrow(/not current|contradictory/u);
  });
});

describe("AsfWorkerService terminal event retention", () => {
  it("compacts an eligible acknowledgement after the terminal owner releases", () => {
    const store = new FakeStore();
    const scheduler = new ManualScheduler();
    const owned = retentionCandidate({ ownerId: "worker-alpha" });
    const worker = service({
      store,
      scheduler,
      retryDelayMs: 250,
      outcome: outcomeThatAcknowledges(store, owned),
      runner: async () => undefined,
    });

    expect(worker.acknowledgeOutcome({ schema: "ack-fixture" })).toMatchObject({
      runId: "run_01",
      bundleDigest: DIGEST_A,
      disposition: "recorded",
    });
    expect(scheduler.pending(250)).toBe(1);
    expect(store.compactions).toEqual([]);

    store.retentionCandidates.set("run_01", { ...owned, ownerId: null });
    expect(scheduler.runNext(250)).toBe(true);
    expect(store.compactions).toEqual([
      {
        runId: "run_01",
        expectedGeneration: 1,
        expectedBundleDigest: DIGEST_A,
        through: 2,
        minimumAgeMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS,
      },
    ]);
    expect(store.retentionCandidates.size).toBe(0);
  });

  it("waits for the full retention age and coalesces acknowledgement retries", () => {
    const store = new FakeStore();
    const scheduler = new ManualScheduler();
    const clock = new FakeClock(NOW);
    const candidate = retentionCandidate({ terminalEventAt: NOW });
    const worker = service({
      store,
      scheduler,
      clock,
      outcome: outcomeThatAcknowledges(store, candidate),
      runner: async () => undefined,
    });

    expect(worker.acknowledgeOutcome({ retry: 1 }).disposition).toBe(
      "recorded",
    );
    expect(worker.acknowledgeOutcome({ retry: 2 }).disposition).toBe(
      "existing",
    );
    expect(scheduler.pending(MIN_ASF_DETAILED_EVENT_RETENTION_MS)).toBe(1);
    expect(store.compactions).toEqual([]);

    clock.advanceMs(MIN_ASF_DETAILED_EVENT_RETENTION_MS);
    store.retentionNowMs = clock.now().getTime();
    expect(scheduler.runNext(MIN_ASF_DETAILED_EVENT_RETENTION_MS)).toBe(true);
    expect(store.compactions).toHaveLength(1);
  });

  it("refills a bounded recovery scan until every candidate is scheduled", () => {
    const store = new FakeStore();
    const scheduler = new ManualScheduler();
    store.retentionCandidates.set(
      "run_retention_1",
      retentionCandidate({ runId: "run_retention_1" }),
    );
    store.retentionCandidates.set(
      "run_retention_2",
      retentionCandidate({ runId: "run_retention_2" }),
    );
    const worker = service({
      store,
      scheduler,
      eventRetentionScanLimit: 1,
      runner: async () => undefined,
    });

    expect(worker.recover()).toBe(0);
    expect(scheduler.pending(0)).toBe(1);
    expect(scheduler.runNext(0)).toBe(true);
    expect(store.compactions.map((input) => input.runId)).toEqual([
      "run_retention_1",
    ]);
    expect(scheduler.pending(0)).toBe(1);
    expect(scheduler.runNext(0)).toBe(true);
    expect(store.compactions.map((input) => input.runId)).toEqual([
      "run_retention_1",
      "run_retention_2",
    ]);
    expect(store.retentionCandidateLists).toBeGreaterThanOrEqual(3);
  });

  it("cancels recovered retention timers during service shutdown", async () => {
    const store = new FakeStore();
    const scheduler = new ManualScheduler();
    store.retentionCandidates.set(
      "run_future_retention",
      retentionCandidate({
        runId: "run_future_retention",
        terminalEventAt: NOW,
      }),
    );
    const worker = service({
      store,
      scheduler,
      runner: async () => undefined,
    });

    expect(worker.recover()).toBe(0);
    expect(scheduler.pending(MIN_ASF_DETAILED_EVENT_RETENTION_MS)).toBe(1);
    await worker.requestStop();
    expect(scheduler.pending()).toBe(0);
    expect(scheduler.runNext(MIN_ASF_DETAILED_EVENT_RETENTION_MS)).toBe(false);
    expect(store.compactions).toEqual([]);
  });

  it("refuses a configured retention period below the hard floor", () => {
    expect(() =>
      service({
        store: new FakeStore(),
        detailedEventRetentionMs: MIN_ASF_DETAILED_EVENT_RETENTION_MS - 1,
        runner: async () => undefined,
      }),
    ).toThrow(/at least/u);
  });
});

describe("AsfWorkerService reads", () => {
  it("returns a safe snapshot without the canonical envelope or effective policy", () => {
    const store = new FakeStore();
    store.addRun();
    store.latestSequence = 42;
    const worker = service({ store, runner: async () => undefined });

    const snapshot = worker.getRun("run_01");

    expect(snapshot.run).toEqual(runRow());
    expect(snapshot.latestSequence).toBe(42);
    expect(snapshot.admission).toEqual({
      idempotencyKey: "tenant-acme/ENG-123/attempt_01",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      tenantId: "tenant-acme",
      payloadDigest: DIGEST_A,
      envelopeDigest: DIGEST_B,
      effectivePolicyDigest: DIGEST_C,
      signatureKeyId: "asf-signing-key-2026-01",
      signatureAlgorithm: "EdDSA",
      acceptedAt: NOW,
    });
    expect(snapshot.admission).not.toHaveProperty("canonicalEnvelope");
    expect(snapshot.admission).not.toHaveProperty("effectivePolicy");
  });

  it("fails clearly for an unknown run", () => {
    const worker = service({
      store: new FakeStore(),
      runner: async () => undefined,
    });
    expect(() => worker.getRun("run_missing")).toThrow(
      /ASF run run_missing does not exist/,
    );
  });

  it("delegates cursor pages without reshaping or dropping gap metadata", () => {
    const store = new FakeStore();
    const page: AsfEventPage = {
      events: [],
      nextCursor: 17,
      hasMore: true,
      gap: true,
      compactedThrough: 9,
      snapshot: { run: runRow(), latestSequence: 42 },
    };
    store.eventPage = page;
    const worker = service({ store, runner: async () => undefined });

    expect(worker.listRunEvents("run_01", 10, 7)).toBe(page);
    expect(store.eventRequests).toEqual([
      { runId: "run_01", after: 10, limit: 7 },
    ]);
  });
});

describe("AsfWorkerService shutdown", () => {
  it("stops admission, leaves queued work durable, and waits for the active safe boundary", async () => {
    const store = new FakeStore();
    store.addRun(
      runRow({ runId: "run_active", repo: "acme/one" }),
      admissionRecord({ runId: "run_active", workOrderId: "wo_active" }),
    );
    store.addRun(
      runRow({ runId: "run_queued", repo: "acme/two" }),
      admissionRecord({ runId: "run_queued", workOrderId: "wo_queued" }),
    );
    const activeStarted = deferred();
    const finishActive = deferred();
    const admission = new FakeAdmissionService(admissionResult());
    const worker = service({
      store,
      admission,
      maxConcurrency: 1,
      runner: async (context) => {
        expect(context.runId).toBe("run_active");
        activeStarted.resolve();
        await finishActive.promise;
        pauseRun(context);
      },
    });

    expect(worker.recover()).toBe(2);
    await activeStarted.promise;
    expect(worker.runtimeSnapshot()).toMatchObject({
      acceptingSubmissions: true,
      stopping: false,
      activeRuns: 1,
      queuedRuns: 1,
    });

    let stopped = false;
    const stop = worker.requestStop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(worker.runtimeSnapshot()).toMatchObject({
      acceptingSubmissions: false,
      stopping: true,
      activeRuns: 1,
      queuedRuns: 0,
    });
    await expect(worker.submitWorkOrder({ after: "stop" })).rejects.toThrow(
      /not accepting submissions/u,
    );
    expect(admission.calls).toHaveLength(0);
    expect(() => worker.recover()).toThrow(/stopping/u);

    finishActive.resolve();
    await stop;

    expect(store.getAsfRun("run_active")).toMatchObject({
      state: "WAITING_APPROVAL",
      ownerId: null,
    });
    expect(store.getAsfRun("run_queued")).toMatchObject({
      state: "ADMITTED",
      ownerId: null,
      generation: 0,
    });
    expect(store.claims.map((claim) => claim.runId)).toEqual(["run_active"]);
    expect(worker.runtimeSnapshot()).toMatchObject({
      activeRuns: 0,
      queuedRuns: 0,
    });
  });

  it("is idempotent when stopped while idle", async () => {
    const worker = service({
      store: new FakeStore(),
      runner: async () => undefined,
    });

    await worker.requestStop();
    await worker.requestStop();

    expect(worker.runtimeSnapshot()).toEqual({
      workerId: "worker-alpha",
      acceptingSubmissions: false,
      stopping: true,
      maxConcurrency: 1,
      activeRuns: 0,
      queuedRuns: 0,
    });
  });
});

describe("AsfWorkerService background failures", () => {
  it("pauses durably when a runner resolves before cleanup is proven", async () => {
    const store = new FakeStore();
    store.addRun();
    const reported = new Promise<{ error: unknown; runId: string }>(
      (resolve) => {
        const worker = service({
          store,
          runner: async () => undefined,
          onBackgroundError: (error, runId) => resolve({ error, runId }),
        });
        void worker.submitWorkOrder({});
      },
    );

    const failure = await reported;

    expect(failure).toMatchObject({
      runId: "run_01",
      error: expect.any(Error),
    });
    expect((failure.error as Error).message).toContain(
      "resolved while durable phase ADMITTED remained active",
    );
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      from: "ADMITTED",
      to: "BLOCKED_EXTERNAL",
      eventType: "run.blocked_external",
      reason: "background runner resolved in a nonterminal active phase",
      payload: {
        code: "INTERNAL_WORKER_RECONCILIATION_REQUIRED",
        summary: "worker execution stopped before cleanup could be proven",
        checkpoint: "ADMITTED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action:
          "inspect protected diagnostics, reconcile unfinished effects, and prove cleanup before terminalizing",
        evidence_refs: [],
      },
    });
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "BLOCKED_EXTERNAL",
      ownerId: null,
    });
  });

  it("does not release an active phase when its durable failure transition is refused", async () => {
    const store = new FakeStore();
    store.addRun();
    store.transitionAllowed = false;
    const reported = deferred();
    const worker = service({
      store,
      runner: async () => undefined,
      onBackgroundError: () => reported.resolve(),
    });

    await worker.submitWorkOrder({});
    await reported.promise;

    expect(store.transitions).toHaveLength(0);
    expect(store.releases).toHaveLength(0);
    expect(store.getAsfRun("run_01")).toMatchObject({
      state: "ADMITTED",
      ownerId: "worker-alpha",
      generation: 1,
    });
  });

  it("persists a redacted reconciliation pause before reporting the runner error", async () => {
    const store = new FakeStore();
    store.addRun();
    const ordering: string[] = [];
    store.onTransition = () => ordering.push("transition");
    const reported = new Promise<{ error: unknown; runId: string }>(
      (resolve) => {
        const worker = service({
          store,
          runner: async () => {
            throw new Error("runner failed with secret-token-value");
          },
          onBackgroundError: (error, runId) => {
            ordering.push("telemetry");
            resolve({ error, runId });
          },
        });
        void worker.submitWorkOrder({});
      },
    );

    const failure = await reported;
    expect(failure.runId).toBe("run_01");
    expect(failure.error).toBeInstanceOf(Error);
    expect((failure.error as Error).message).toContain("secret-token-value");
    expect(ordering).toEqual(["transition", "telemetry"]);
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]).toMatchObject({
      runId: "run_01",
      ownerId: "worker-alpha",
      generation: 1,
      from: "ADMITTED",
      to: "BLOCKED_EXTERNAL",
      expectedVersion: 1,
      eventType: "run.blocked_external",
      reason: "background runner rejected",
      actor: "worker-service",
      payload: {
        code: "INTERNAL_WORKER_RECONCILIATION_REQUIRED",
        summary: "worker execution stopped before cleanup could be proven",
        checkpoint: "ADMITTED",
        retry_disposition: "reconcile-first",
        required_actor: "platform-operator",
        required_action:
          "inspect protected diagnostics, reconcile unfinished effects, and prove cleanup before terminalizing",
        evidence_refs: [],
      },
    });
    expect(JSON.stringify(store.transitions[0]?.payload)).not.toContain(
      "secret-token-value",
    );
    expect(store.getAsfRun("run_01")?.state).toBe("BLOCKED_EXTERNAL");
  });

  it.each(["stale-owner", "terminal"] as const)(
    "does not overwrite a %s run after the runner rejects",
    async (scenario) => {
      const store = new FakeStore();
      store.addRun();
      const reported = deferred();
      const worker = service({
        store,
        runner: async () => {
          const current = store.runs.get("run_01");
          if (current === undefined) throw new Error("missing fake run");
          if (scenario === "stale-owner") {
            current.ownerId = "worker-new-owner";
            current.generation = 99;
          } else {
            current.state = "COMPLETED";
            current.stateVersion = 9;
          }
          throw new Error(`runner failed after ${scenario}`);
        },
        onBackgroundError: () => reported.resolve(),
      });

      await worker.submitWorkOrder({});
      await reported.promise;

      expect(store.transitions).toHaveLength(0);
      expect(store.getAsfRun("run_01")?.state).toBe(
        scenario === "terminal" ? "COMPLETED" : "ADMITTED",
      );
      if (scenario === "stale-owner") {
        expect(store.getAsfRun("run_01")).toMatchObject({
          ownerId: "worker-new-owner",
          generation: 99,
        });
      }
    },
  );
});
