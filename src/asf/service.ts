import type { Clock } from "../platform/clock.js";
import {
  MIN_ASF_DETAILED_EVENT_RETENTION_MS,
  type AsfEventRetentionCandidate,
  type AsfAdmissionRecord,
  type AsfEventPage,
  type AsfRunRow,
  type StateStore,
} from "../state/store.js";
import {
  RUN_EVENT_PHASES,
  isTerminalRunEventPhase,
  type RunEvent,
} from "./run-event.js";
import type {
  SubmitWorkOrderResult,
  WorkOrderAdmissionService,
} from "./work-order.js";
import type {
  AsfCancellationService,
  CancellationResult,
} from "./cancellation.js";
import { appliedCancellationPolicy } from "./cancellation.js";
import type { AsfApprovalService, RecordApprovalResult } from "./approval.js";
import type {
  AsfEvidenceReadService,
  AsfEvidenceView,
} from "./evidence-service.js";
import type {
  AsfReconciliationCompletion,
  AsfReconciliationService,
  ReconciliationRequestResult,
} from "./reconciliation.js";
import type {
  AcknowledgeOutcomeResult,
  AsfOutcomeAcknowledgementService,
} from "./outcome.js";
import type { AsfHealthReport, AsfHealthService } from "./health.js";
import type {
  AsfTelemetryAttributeInput,
  AsfTelemetryCounterName,
  AsfTelemetryHistogramName,
  AsfTelemetryRecorder,
  AsfTelemetrySpanName,
  AsfTelemetryUnit,
} from "./telemetry.js";

export type AsfWorkerStore = Pick<
  StateStore,
  | "getAsfRun"
  | "getAsfRunSnapshot"
  | "listRecoverableAsfRuns"
  | "claimAsfRun"
  | "heartbeatAsfRun"
  | "releaseAsfRunOwnership"
  | "transitionAsfRun"
  | "listAsfRunEvents"
  | "getAsfTerminalEvidencePlanRecord"
  | "getAsfEventRetentionCandidate"
  | "listAsfEventRetentionCandidates"
  | "compactAsfRunEvents"
>;

export type AsfWorkOrderSubmitter = Pick<WorkOrderAdmissionService, "submit">;

export type AsfRunnerTransition = Omit<
  Parameters<AsfWorkerStore["transitionAsfRun"]>[0],
  "runId" | "ownerId" | "generation"
>;

export interface AsfRunnerContext {
  readonly runId: string;
  readonly generation: number;
  /** True when this claim fenced a previous, stale owner. */
  readonly takeover: boolean;
  /** Aborted when this service can no longer renew fenced ownership. */
  readonly signal: AbortSignal;
  readonly transition: (input: AsfRunnerTransition) => RunEvent;
}

export type AsfRunner = (context: AsfRunnerContext) => Promise<void>;

/** Narrow retry signal for a run frozen by an exact durable terminal plan. */
export class AsfPendingTerminalEvidenceRetryError extends Error {
  readonly runId: string;

  constructor(runId: string, cause: unknown) {
    super(`pending terminal evidence for ${runId} requires a protected retry`, {
      cause,
    });
    this.name = "AsfPendingTerminalEvidenceRetryError";
    this.runId = runId;
  }
}

/**
 * Narrow yield signal for an exact-head CI observation that is durably
 * incomplete. The worker service, not the runner or provider adapter, owns
 * the delayed retry policy and fenced ownership release.
 */
export class AsfPendingCiRetryError extends Error {
  readonly runId: string;
  readonly phase: "CI_WAIT" | "PR_REVIEW";
  readonly candidateSha: string;
  readonly intentDigest: string;
  readonly observationDigest: string;
  readonly checksDigest: string;

  constructor(input: {
    readonly runId: string;
    readonly phase: "CI_WAIT" | "PR_REVIEW";
    readonly candidateSha: string;
    readonly intentDigest: string;
    readonly observationDigest: string;
    readonly checksDigest: string;
  }) {
    super(`pending exact-head CI for ${input.runId} requires a delayed retry`);
    this.name = "AsfPendingCiRetryError";
    this.runId = input.runId;
    this.phase = input.phase;
    this.candidateSha = input.candidateSha;
    this.intentDigest = input.intentDigest;
    this.observationDigest = input.observationDigest;
    this.checksDigest = input.checksDigest;
  }
}

export interface AsfScheduledTask {
  cancel(): void;
}

/** Injectable delayed work primitive used for claim retries and lease heartbeats. */
export interface AsfWorkerScheduler {
  schedule(delayMs: number, task: () => void): AsfScheduledTask;
}

export interface SafeAsfAdmissionSnapshot {
  readonly idempotencyKey: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly payloadDigest: string;
  readonly envelopeDigest: string;
  readonly effectivePolicyDigest: string;
  readonly signatureKeyId: string;
  readonly signatureAlgorithm: string;
  readonly acceptedAt: string;
}

export interface AsfRunSnapshot {
  readonly run: AsfRunRow;
  readonly admission: SafeAsfAdmissionSnapshot;
  readonly latestSequence: number;
}

export interface AsfWorkerRuntimeSnapshot {
  readonly workerId: string;
  readonly acceptingSubmissions: boolean;
  readonly stopping: boolean;
  readonly maxConcurrency: number;
  readonly activeRuns: number;
  readonly queuedRuns: number;
}

export interface AsfWorkerServiceOptions {
  readonly store: AsfWorkerStore;
  readonly admission: AsfWorkOrderSubmitter;
  readonly clock: Clock;
  readonly workerId: string;
  readonly staleOwnershipMs: number;
  readonly maxConcurrency?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly detailedEventRetentionMs?: number | undefined;
  readonly eventRetentionScanLimit?: number | undefined;
  readonly scheduler?: AsfWorkerScheduler | undefined;
  readonly runner: AsfRunner;
  readonly cancellation?: Pick<AsfCancellationService, "request"> | undefined;
  readonly approval?: Pick<AsfApprovalService, "record"> | undefined;
  readonly evidence?: Pick<AsfEvidenceReadService, "getEvidence"> | undefined;
  readonly reconciliation?:
    | (Pick<AsfReconciliationService, "request" | "recover"> &
        Partial<
          Pick<AsfReconciliationService, "bindDurableContinuationHandler">
        >)
    | undefined;
  readonly outcome?:
    | Pick<AsfOutcomeAcknowledgementService, "acknowledge">
    | undefined;
  readonly health?: Pick<AsfHealthService, "getHealth"> | undefined;
  readonly telemetry?: AsfTelemetryRecorder | undefined;
  readonly onBackgroundError?:
    | ((error: unknown, runId: string) => void)
    | undefined;
}

interface ActiveRun {
  readonly repository: string;
  readonly generation: number;
  readonly abortController: AbortController;
  heartbeatTask: AsfScheduledTask | undefined;
  cancellationTask: AsfScheduledTask | undefined;
  leaseLost: boolean;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_EVENT_RETENTION_SCAN_LIMIT = 10_000;
const MAX_SCHEDULER_DELAY_MS = 2_147_483_647;
const DURABLE_PAUSE_PHASES: ReadonlySet<string> = new Set([
  "WAITING_APPROVAL",
  "NEEDS_SPEC",
  "BLOCKED_EXTERNAL",
]);

const DEFAULT_SCHEDULER: AsfWorkerScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * Durable ASF submission and recovery coordinator.
 *
 * Admission is awaited because its transaction is the acknowledgement
 * boundary. Execution is deliberately detached from the caller and always
 * begins by acquiring fenced ownership from the durable store.
 */
export class AsfWorkerService {
  readonly #store: AsfWorkerStore;
  readonly #admission: AsfWorkOrderSubmitter;
  readonly #clock: Clock;
  readonly #workerId: string;
  readonly #staleOwnershipMs: number;
  readonly #maxConcurrency: number;
  readonly #retryDelayMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #detailedEventRetentionMs: number;
  readonly #eventRetentionScanLimit: number;
  readonly #scheduler: AsfWorkerScheduler;
  readonly #runner: AsfRunner;
  readonly #cancellation: Pick<AsfCancellationService, "request"> | undefined;
  readonly #approval: Pick<AsfApprovalService, "record"> | undefined;
  readonly #evidence: Pick<AsfEvidenceReadService, "getEvidence"> | undefined;
  readonly #reconciliation:
    | (Pick<AsfReconciliationService, "request" | "recover"> &
        Partial<
          Pick<AsfReconciliationService, "bindDurableContinuationHandler">
        >)
    | undefined;
  readonly #outcome:
    | Pick<AsfOutcomeAcknowledgementService, "acknowledge">
    | undefined;
  readonly #health: Pick<AsfHealthService, "getHealth"> | undefined;
  readonly #telemetry: AsfTelemetryRecorder | undefined;
  readonly #serviceTelemetryStartedAt: number | undefined;
  readonly #onBackgroundError:
    | ((error: unknown, runId: string) => void)
    | undefined;
  readonly #scheduled = new Set<string>();
  readonly #queue: string[] = [];
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #rescheduleAfterActive = new Set<string>();
  readonly #delayedWakeTasks = new Map<string, AsfScheduledTask>();
  readonly #eventRetentionTasks = new Map<string, AsfScheduledTask>();
  readonly #idleWaiters = new Set<() => void>();
  #pumpRequested = false;
  #retryTask: AsfScheduledTask | undefined;
  #stopping = false;
  #stopTelemetryEmitted = false;

  constructor(options: AsfWorkerServiceOptions) {
    if (options.workerId.trim() === "")
      throw new Error("ASF worker id must not be empty");
    if (
      !Number.isSafeInteger(options.staleOwnershipMs) ||
      options.staleOwnershipMs < 0
    ) {
      throw new Error(
        "ASF stale ownership duration must be a non-negative safe integer",
      );
    }
    const maxConcurrency = options.maxConcurrency ?? 1;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("ASF worker concurrency must be a positive safe integer");
    }
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
      throw new Error("ASF claim retry delay must be a positive safe integer");
    }
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1, Math.floor(options.staleOwnershipMs / 3));
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
      throw new Error("ASF heartbeat interval must be a positive safe integer");
    }
    const detailedEventRetentionMs =
      options.detailedEventRetentionMs ?? MIN_ASF_DETAILED_EVENT_RETENTION_MS;
    if (
      !Number.isSafeInteger(detailedEventRetentionMs) ||
      detailedEventRetentionMs < MIN_ASF_DETAILED_EVENT_RETENTION_MS
    ) {
      throw new Error(
        `ASF detailed event retention must be at least ${MIN_ASF_DETAILED_EVENT_RETENTION_MS}ms`,
      );
    }
    const eventRetentionScanLimit =
      options.eventRetentionScanLimit ?? DEFAULT_EVENT_RETENTION_SCAN_LIMIT;
    if (
      !Number.isSafeInteger(eventRetentionScanLimit) ||
      eventRetentionScanLimit < 1 ||
      eventRetentionScanLimit > DEFAULT_EVENT_RETENTION_SCAN_LIMIT
    ) {
      throw new Error(
        "ASF event-retention scan limit must be an integer from 1 through 10000",
      );
    }
    this.#store = options.store;
    this.#admission = options.admission;
    this.#clock = options.clock;
    this.#workerId = options.workerId;
    this.#staleOwnershipMs = options.staleOwnershipMs;
    this.#maxConcurrency = maxConcurrency;
    this.#retryDelayMs = retryDelayMs;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#detailedEventRetentionMs = detailedEventRetentionMs;
    this.#eventRetentionScanLimit = eventRetentionScanLimit;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#runner = options.runner;
    this.#cancellation = options.cancellation;
    this.#approval = options.approval;
    this.#evidence = options.evidence;
    this.#reconciliation = options.reconciliation;
    this.#outcome = options.outcome;
    this.#health = options.health;
    this.#telemetry = options.telemetry;
    this.#serviceTelemetryStartedAt = this.#telemetryMonotonicMs();
    this.#onBackgroundError = options.onBackgroundError;
    options.reconciliation?.bindDurableContinuationHandler?.((completion) => {
      this.notifyReconciliationContinuation(completion);
    });
  }

  async submitWorkOrder(raw: unknown): Promise<SubmitWorkOrderResult> {
    if (this.#stopping) {
      throw new Error(
        "ASF worker service is stopping and is not accepting submissions",
      );
    }
    const startedAt = this.#telemetryMonotonicMs();
    let admitted: SubmitWorkOrderResult;
    try {
      admitted = await this.#admission.submit(raw);
    } catch (error) {
      // An arbitrary submit rejection may be a store failure or an ambiguous
      // post-commit result, not a proven refusal of invalid input. Record only
      // a failed admission operation; the refusal counter needs typed proof.
      this.#telemetryOperation(
        "runmill.asf.work_order.admission",
        startedAt,
        "admission",
        "work-order-admit",
        "failed",
        { reason_code: "unknown" },
      );
      throw error;
    }
    this.#schedule(admitted.runId);
    this.#telemetryOperation(
      "runmill.asf.work_order.admission",
      startedAt,
      "admission",
      "work-order-admit",
      "succeeded",
    );
    if (admitted.disposition === "accepted") {
      this.#telemetryCounter("runmill.asf.work_orders.accepted", 1, {
        component: "admission",
        operation: "work-order-admit",
        outcome: "succeeded",
      });
    }
    return admitted;
  }

  /** Queue every durable, nonterminal ASF run not already active here. */
  recover(): number {
    if (this.#stopping) throw new Error("ASF worker service is stopping");
    const startedAt = this.#telemetryMonotonicMs();
    try {
      this.#scheduleDurableEventRetentionCandidates();
      let queued = 0;
      for (const run of this.#store.listRecoverableAsfRuns()) {
        if (isTerminalRunEventPhase(run.state)) continue;
        if (this.#schedule(run.runId)) queued += 1;
      }
      const recovered = queued + (this.#reconciliation?.recover() ?? 0);
      this.#telemetryOperation(
        "runmill.asf.reconciliation",
        startedAt,
        "reconciliation",
        "reconcile",
        "recovered",
        { recovery_mode: "startup" },
      );
      if (recovered > 0) {
        this.#telemetryCounter("runmill.asf.recovery.actions", recovered, {
          component: "reconciliation",
          operation: "reconcile",
          outcome: "recovered",
          recovery_mode: "startup",
        });
      }
      return recovered;
    } catch (error) {
      this.#telemetryOperation(
        "runmill.asf.reconciliation",
        startedAt,
        "reconciliation",
        "reconcile",
        "failed",
        {
          reason_code: "unknown",
          recovery_mode: "startup",
        },
      );
      throw error;
    }
  }

  getRun(runId: string): AsfRunSnapshot {
    const snapshot = this.#store.getAsfRunSnapshot(runId);
    if (snapshot === undefined)
      throw new Error(`ASF run ${runId} does not exist`);
    return {
      run: { ...snapshot.run },
      admission: safeAdmission(snapshot.admission),
      latestSequence: snapshot.latestSequence,
    };
  }

  listRunEvents(runId: string, after = 0, limit = 100): AsfEventPage {
    return this.#store.listAsfRunEvents(runId, after, limit);
  }

  /**
   * Persist and fence cancellation before returning. The active invocation is
   * signalled locally, while a new fenced claim performs revocation, cleanup,
   * and reconciliation from CANCEL_REQUESTED independently of this caller.
   */
  requestCancellation(raw: unknown): CancellationResult {
    if (this.#cancellation === undefined) {
      throw new Error(
        "ASF cancellation is not configured for this worker service",
      );
    }
    const startedAt = this.#telemetryMonotonicMs();
    let result: CancellationResult;
    try {
      result = this.#cancellation.request(raw);
    } catch (error) {
      this.#telemetryOperation(
        "runmill.asf.cancellation",
        startedAt,
        "cancellation",
        "cancel",
        "failed",
        { reason_code: "unknown" },
      );
      throw error;
    }
    this.#telemetryOperation(
      "runmill.asf.cancellation",
      startedAt,
      "cancellation",
      "cancel",
      result.disposition === "already-terminal" ? "degraded" : "succeeded",
      result.disposition === "already-terminal"
        ? { reason_code: "terminal-state" }
        : {},
    );
    if (result.disposition === "already-terminal") return result;

    this.#cancelDelayedWake(result.runId);

    const active = this.#activeRuns.get(result.runId);
    if (active !== undefined) {
      this.#rescheduleAfterActive.add(result.runId);
      active.leaseLost = true;
      active.heartbeatTask?.cancel();
      active.heartbeatTask = undefined;
      active.cancellationTask?.cancel();
      active.cancellationTask = undefined;
      const policy = appliedCancellationPolicy(result);
      const reason = new Error(
        `ASF cancellation ${result.requestId} fenced the run`,
      );
      if (policy?.mode === "graceful") {
        try {
          active.cancellationTask = this.#scheduler.schedule(
            policy.graceSeconds * 1_000,
            () => {
              active.cancellationTask = undefined;
              if (
                this.#activeRuns.get(result.runId) === active &&
                !active.abortController.signal.aborted
              ) {
                active.abortController.abort(reason);
              }
            },
          );
        } catch (error) {
          // The request is already durable and its old generation is fenced.
          // If the grace timer cannot be guaranteed, force local revocation.
          active.abortController.abort(reason);
          this.#reportBackgroundError(error, result.runId);
        }
      } else {
        // Missing in-process policy metadata is treated as forced. This keeps
        // restrictive fakes and alternate adapters from silently granting a
        // grace window that the durable request did not prove.
        active.abortController.abort(reason);
      }
    } else {
      this.#schedule(result.runId);
    }
    return result;
  }

  recordApproval(raw: unknown): RecordApprovalResult {
    if (this.#approval === undefined) {
      throw new Error(
        "ASF approval control is not configured for this worker service",
      );
    }
    const result = this.#approval.record(raw);
    if (result.resumed) {
      const active = this.#activeRuns.get(result.runId);
      if (active !== undefined && !active.abortController.signal.aborted) {
        active.abortController.abort(
          new Error(
            "signed approval resumed the run under a new durable ownership fence",
          ),
        );
      }
      this.#wakeRun(result.runId);
    }
    return result;
  }

  getEvidence(runId: string): AsfEvidenceView {
    if (this.#evidence === undefined) {
      throw new Error(
        "ASF evidence reads are not configured for this worker service",
      );
    }
    return this.#evidence.getEvidence(runId);
  }

  requestReconciliation(raw: unknown): ReconciliationRequestResult {
    if (this.#reconciliation === undefined) {
      throw new Error(
        "ASF reconciliation is not configured for this worker service",
      );
    }
    const startedAt = this.#telemetryMonotonicMs();
    try {
      const result = this.#reconciliation.request(raw);
      this.#telemetryOperation(
        "runmill.asf.reconciliation",
        startedAt,
        "reconciliation",
        "reconcile",
        "succeeded",
        { recovery_mode: "reconcile-only" },
      );
      return result;
    } catch (error) {
      this.#telemetryOperation(
        "runmill.asf.reconciliation",
        startedAt,
        "reconciliation",
        "reconcile",
        "failed",
        { reason_code: "unknown", recovery_mode: "reconcile-only" },
      );
      throw error;
    }
  }

  /**
   * Schedule only a continuation already committed by StateStore. This method
   * re-reads the exact resumed event and grants no transition authority of its
   * own, so callback retries and startup recovery are idempotent.
   */
  notifyReconciliationContinuation(
    completion: AsfReconciliationCompletion,
  ): void {
    const continuation = completion.continuation;
    if (continuation.disposition !== "run-resumed") return;
    const run = this.#store.getAsfRun(completion.runId);
    if (
      run === undefined ||
      run.state !== continuation.resumePhase ||
      run.stateVersion !== continuation.resumedEventSeq ||
      run.ownerId !== null
    ) {
      throw new Error(
        `durable reconciliation continuation ${completion.operationId} is not current`,
      );
    }
    const page = this.#store.listAsfRunEvents(
      completion.runId,
      continuation.resumedEventSeq - 1,
      1,
    );
    const event = page.events[0];
    const reconciliation = event?.payload["reconciliation"];
    if (
      event?.type !== "run.resumed" ||
      event.seq !== continuation.resumedEventSeq ||
      typeof reconciliation !== "object" ||
      reconciliation === null ||
      Array.isArray(reconciliation) ||
      (reconciliation as Record<string, unknown>)["operation_id"] !==
        continuation.operationId ||
      (reconciliation as Record<string, unknown>)["result_digest"] !==
        continuation.resultDigest
    ) {
      throw new Error(
        `durable reconciliation continuation ${completion.operationId} event is contradictory`,
      );
    }
    this.#wakeRun(completion.runId);
  }

  acknowledgeOutcome(raw: unknown): AcknowledgeOutcomeResult {
    if (this.#outcome === undefined) {
      throw new Error(
        "ASF outcome acknowledgement is not configured for this worker service",
      );
    }
    const result = this.#outcome.acknowledge(raw);
    this.#scheduleAcknowledgedEventRetention(result);
    return result;
  }

  async health(): Promise<AsfHealthReport> {
    if (this.#health === undefined) {
      throw new Error(
        "ASF health reporting is not configured for this worker service",
      );
    }
    return this.#health.getHealth();
  }

  runtimeSnapshot(): AsfWorkerRuntimeSnapshot {
    return {
      workerId: this.#workerId,
      acceptingSubmissions: !this.#stopping,
      stopping: this.#stopping,
      maxConcurrency: this.#maxConcurrency,
      activeRuns: this.#activeRuns.size,
      queuedRuns: this.#queue.length,
    };
  }

  /** Stop taking work, leave queued work durable, and finish active safe boundaries. */
  async requestStop(): Promise<void> {
    if (!this.#stopping) {
      this.#stopping = true;
      this.#retryTask?.cancel();
      this.#retryTask = undefined;
      for (const task of this.#delayedWakeTasks.values()) task.cancel();
      this.#delayedWakeTasks.clear();
      for (const task of this.#eventRetentionTasks.values()) task.cancel();
      this.#eventRetentionTasks.clear();
      const activeIds = new Set(this.#activeRuns.keys());
      this.#queue.splice(0);
      for (const runId of [...this.#scheduled]) {
        if (!activeIds.has(runId)) this.#scheduled.delete(runId);
      }
      this.#rescheduleAfterActive.clear();
    }
    if (this.#activeRuns.size > 0) {
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    }
    this.#emitStopTelemetry();
  }

  #wakeRun(runId: string): void {
    if (this.#activeRuns.has(runId)) {
      this.#rescheduleAfterActive.add(runId);
      return;
    }
    this.#schedule(runId);
  }

  #schedule(runId: string): boolean {
    if (this.#stopping) return false;
    if (this.#scheduled.has(runId)) {
      this.#requestPump();
      return false;
    }
    this.#scheduled.add(runId);
    this.#queue.push(runId);
    this.#requestPump();
    return true;
  }

  #requestPump(): void {
    if (this.#stopping) return;
    if (this.#pumpRequested) return;
    this.#pumpRequested = true;
    queueMicrotask(() => {
      this.#pumpRequested = false;
      this.#pump();
    });
  }

  /** One bounded pass: failed claims remain FIFO-queued for a delayed retry. */
  #pump(): void {
    if (this.#stopping) return;
    let needsDelayedRetry = false;
    const pending = this.#queue.splice(0);
    for (let index = 0; index < pending.length; index += 1) {
      const runId = pending[index];
      if (runId === undefined) continue;
      if (this.#activeRuns.size >= this.#maxConcurrency) {
        this.#queue.push(...pending.slice(index));
        break;
      }

      let run: AsfRunRow | undefined;
      try {
        run = this.#store.getAsfRun(runId);
      } catch (error) {
        this.#queue.push(runId);
        needsDelayedRetry = true;
        this.#reportBackgroundError(error, runId);
        continue;
      }
      if (run === undefined || isTerminalRunEventPhase(run.state)) {
        this.#scheduled.delete(runId);
        continue;
      }

      const repository = run.repo.toLowerCase();
      if (
        [...this.#activeRuns.values()].some(
          (active) => active.repository === repository,
        )
      ) {
        this.#queue.push(runId);
        continue;
      }

      let ownership: ReturnType<AsfWorkerStore["claimAsfRun"]>;
      try {
        const staleBefore = new Date(
          this.#clock.now().getTime() - this.#staleOwnershipMs,
        ).toISOString();
        ownership = this.#store.claimAsfRun({
          runId,
          ownerId: this.#workerId,
          staleBefore,
          maxHostConcurrency: this.#maxConcurrency,
        });
      } catch (error) {
        this.#queue.push(runId);
        needsDelayedRetry = true;
        this.#reportBackgroundError(error, runId);
        continue;
      }
      if (ownership === undefined) {
        try {
          const current = this.#store.getAsfRun(runId);
          if (current === undefined || isTerminalRunEventPhase(current.state)) {
            this.#scheduled.delete(runId);
          } else {
            this.#queue.push(runId);
            needsDelayedRetry = true;
          }
        } catch (error) {
          this.#queue.push(runId);
          needsDelayedRetry = true;
          this.#reportBackgroundError(error, runId);
        }
        continue;
      }

      const active: ActiveRun = {
        repository,
        generation: ownership.generation,
        abortController: new AbortController(),
        heartbeatTask: undefined,
        cancellationTask: undefined,
        leaseLost: false,
      };
      this.#activeRuns.set(runId, active);
      this.#scheduleHeartbeat(runId, active);
      void this.#execute(runId, active, ownership.takeover)
        .catch((error: unknown) => this.#reportBackgroundError(error, runId))
        .finally(() => {
          // A graceful cancellation may reach its safe boundary before the
          // grace deadline. Abort at that boundary so trusted identity/tool
          // lifecycles revoke immediately instead of waiting for their next
          // periodic ownership check. The completed atomic operation is not
          // interrupted, and the newer durable generation remains fenced.
          if (active.leaseLost && !active.abortController.signal.aborted) {
            active.abortController.abort(
              new Error(
                `ASF run ${runId} reached its graceful cancellation boundary`,
              ),
            );
          }
          this.#releaseLocalSlot(runId, active);
          this.#scheduled.delete(runId);
          if (this.#rescheduleAfterActive.delete(runId)) this.#schedule(runId);
          if (this.#activeRuns.size === 0) this.#resolveIdleWaiters();
          this.#requestPump();
        });
    }

    if (needsDelayedRetry) {
      this.#ensureRetryScheduled();
    } else if (this.#retryTask !== undefined) {
      this.#retryTask.cancel();
      this.#retryTask = undefined;
    }
  }

  async #execute(
    runId: string,
    active: ActiveRun,
    takeover: boolean,
  ): Promise<void> {
    const generation = active.generation;
    const startedAt = this.#telemetryMonotonicMs();
    let telemetryFinished = false;
    const finishTelemetry = (
      outcome: NonNullable<AsfTelemetryAttributeInput["outcome"]>,
      disposition: NonNullable<AsfTelemetryAttributeInput["disposition"]>,
      reason_code?: NonNullable<AsfTelemetryAttributeInput["reason_code"]>,
    ): void => {
      if (telemetryFinished) return;
      telemetryFinished = true;
      const attributes: AsfTelemetryAttributeInput = {
        component: "runner",
        operation: "run-dispatch",
        outcome,
        disposition,
        ...(reason_code === undefined ? {} : { reason_code }),
        ...(takeover ? { recovery_mode: "takeover" as const } : {}),
      };
      this.#telemetryCounter("runmill.asf.run.invocations", 1, attributes);
      this.#telemetryOperation(
        "runmill.asf.run.dispatch",
        startedAt,
        "runner",
        "run-dispatch",
        outcome,
        {
          disposition,
          ...(reason_code === undefined ? {} : { reason_code }),
          ...(takeover ? { recovery_mode: "takeover" as const } : {}),
        },
      );
    };
    try {
      if (active.leaseLost) {
        finishTelemetry("degraded", "lease-lost", "stale-fence");
        return;
      }
      if (takeover) {
        this.#telemetryCounter("runmill.asf.recovery.actions", 1, {
          component: "runner",
          operation: "run-dispatch",
          outcome: "recovered",
          recovery_mode: "takeover",
        });
      }
      try {
        await this.#runner({
          runId,
          generation,
          takeover,
          signal: active.abortController.signal,
          transition: (input) => {
            if (active.leaseLost || this.#activeRuns.get(runId) !== active) {
              throw new Error(
                `ASF runner for ${runId} generation ${generation} lost fenced ownership`,
              );
            }
            return this.#store.transitionAsfRun({
              ...input,
              runId,
              ownerId: this.#workerId,
              generation,
            });
          },
        });
      } catch (error) {
        if (active.leaseLost) {
          finishTelemetry("degraded", "lease-lost", "stale-fence");
          return;
        }
        if (
          error instanceof AsfPendingTerminalEvidenceRetryError &&
          error.runId === runId &&
          this.#store.getAsfTerminalEvidencePlanRecord(runId) !== undefined
        ) {
          this.#releaseIfOwned(runId, generation);
          this.#scheduleDelayedWake(runId);
          this.#reportBackgroundError(error, runId);
          finishTelemetry("degraded", "retry", "terminal-state");
          return;
        }
        if (
          error instanceof AsfPendingCiRetryError &&
          error.runId === runId &&
          this.#isCurrentPendingCiYield(error, generation)
        ) {
          this.#releaseIfOwned(runId, generation);
          this.#scheduleDelayedWake(runId);
          finishTelemetry("degraded", "retry", "dependency-unavailable");
          return;
        }
        this.#recordRunnerFailure(
          runId,
          generation,
          "background runner rejected",
        );
        this.#releaseFinishedOwnership(runId, generation);
        this.#reportBackgroundError(error, runId);
        finishTelemetry("failed", "unexpected-error", "unknown");
        return;
      }

      if (active.leaseLost) {
        finishTelemetry("degraded", "lease-lost", "stale-fence");
        return;
      }

      let current: AsfRunRow | undefined;
      try {
        current = this.#store.getAsfRun(runId);
      } catch (error) {
        this.#reportBackgroundError(error, runId);
        finishTelemetry("failed", "unexpected-error", "dependency-unavailable");
        return;
      }
      if (
        current === undefined ||
        current.ownerId !== this.#workerId ||
        current.generation !== generation
      ) {
        finishTelemetry("degraded", "lease-lost", "stale-fence");
        return;
      }
      if (
        isTerminalRunEventPhase(current.state) ||
        DURABLE_PAUSE_PHASES.has(current.state)
      ) {
        this.#releaseIfOwned(runId, generation);
        if (current.state === "COMPLETED") {
          finishTelemetry("succeeded", "terminal");
        } else if (isTerminalRunEventPhase(current.state)) {
          finishTelemetry(
            current.state === "CANCELLED"
              ? "cancelled"
              : current.state === "REFUSED"
                ? "refused"
                : "failed",
            "terminal",
            "terminal-state",
          );
        } else {
          finishTelemetry("succeeded", "durable-pause");
        }
        return;
      }

      const error = new Error(
        `ASF runner for ${runId} resolved while durable phase ${current.state} remained active`,
      );
      this.#recordRunnerFailure(
        runId,
        generation,
        "background runner resolved in a nonterminal active phase",
      );
      this.#releaseFinishedOwnership(runId, generation);
      this.#reportBackgroundError(error, runId);
      finishTelemetry("failed", "unexpected-error", "contradictory-state");
    } finally {
      finishTelemetry("failed", "unexpected-error", "unknown");
    }
  }

  #recordRunnerFailure(
    runId: string,
    generation: number,
    reason: string,
  ): void {
    try {
      const current = this.#store.getAsfRun(runId);
      if (
        current === undefined ||
        isTerminalRunEventPhase(current.state) ||
        current.ownerId !== this.#workerId ||
        current.generation !== generation
      ) {
        return;
      }
      const from = RUN_EVENT_PHASES.find((phase) => phase === current.state);
      if (from === undefined) return;
      this.#store.transitionAsfRun({
        runId,
        ownerId: this.#workerId,
        generation,
        from,
        to: "BLOCKED_EXTERNAL",
        expectedVersion: current.stateVersion,
        eventType: "run.blocked_external",
        payload: {
          code: "INTERNAL_WORKER_RECONCILIATION_REQUIRED",
          summary: "worker execution stopped before cleanup could be proven",
          checkpoint: current.state,
          retry_disposition: "reconcile-first",
          required_actor: "platform-operator",
          required_action:
            "inspect protected diagnostics, reconcile unfinished effects, and prove cleanup before terminalizing",
          evidence_refs: [],
        },
        reason,
        actor: "worker-service",
      });
    } catch {
      // The state or ownership may have changed between observation and the
      // fenced transition. Never retry against the newer owner or terminal.
    }
  }

  #releaseFinishedOwnership(runId: string, generation: number): void {
    try {
      const current = this.#store.getAsfRun(runId);
      if (
        current?.ownerId !== this.#workerId ||
        current.generation !== generation ||
        (!isTerminalRunEventPhase(current.state) &&
          !DURABLE_PAUSE_PHASES.has(current.state))
      ) {
        return;
      }
      this.#releaseIfOwned(runId, generation);
    } catch {
      // A failed observation cannot authorize releasing an active checkpoint.
    }
  }

  #releaseIfOwned(runId: string, generation: number): void {
    const active = this.#activeRuns.get(runId);
    if (active?.generation === generation) {
      active.heartbeatTask?.cancel();
      active.heartbeatTask = undefined;
    }
    try {
      const current = this.#store.getAsfRun(runId);
      if (
        current?.ownerId === this.#workerId &&
        current.generation === generation
      ) {
        this.#store.releaseAsfRunOwnership(runId, this.#workerId, generation);
      }
    } catch {
      // The state or ownership may have changed between the fenced read and
      // release. Recovery must observe the newer durable state instead.
    }
  }

  #isCurrentPendingCiYield(
    error: AsfPendingCiRetryError,
    generation: number,
  ): boolean {
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(error.intentDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(error.observationDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(error.checksDigest) ||
      !/^[a-f0-9]{40}$/u.test(error.candidateSha)
    ) {
      return false;
    }
    try {
      const current = this.#store.getAsfRun(error.runId);
      if (
        current?.ownerId !== this.#workerId ||
        current.generation !== generation ||
        current.state !== error.phase ||
        current.candidateSha !== error.candidateSha
      ) {
        return false;
      }
      const page = this.#store.listAsfRunEvents(
        error.runId,
        Math.max(0, current.stateVersion - 1),
        1,
      );
      const latest = page.events[0];
      if (
        latest?.seq !== current.stateVersion ||
        latest.phase !== error.phase
      ) {
        return false;
      }
      if (error.phase === "CI_WAIT") {
        const common =
          (latest.type === "ci.completed" ||
            latest.type === "ci.recheck_completed") &&
          latest.payload["candidate_sha"] === error.candidateSha &&
          (latest.payload["outcome"] === "pending" ||
            latest.payload["outcome"] === "not-scheduled") &&
          latest.payload["checks_digest"] === error.checksDigest;
        if (!common) return false;
        return (
          latest.type === "ci.completed" ||
          (latest.payload["observation_intent_digest"] === error.intentDigest &&
            latest.payload["observation_digest"] === error.observationDigest)
        );
      }
      return (
        latest.type === "pr_review.completed" &&
        latest.payload["candidate_sha"] === error.candidateSha &&
        latest.payload["outcome"] === "approved"
      );
    } catch {
      return false;
    }
  }

  /** Schedule acknowledged terminal detail found during startup recovery. */
  #scheduleDurableEventRetentionCandidates(): void {
    for (const candidate of this.#store.listAsfEventRetentionCandidates(
      this.#eventRetentionScanLimit,
    )) {
      this.#scheduleEventRetentionCandidate(candidate);
    }
  }

  /** Acknowledgement is already durable; scheduling failures are telemetry. */
  #scheduleAcknowledgedEventRetention(
    acknowledgement: AcknowledgeOutcomeResult,
  ): void {
    try {
      const candidate = this.#store.getAsfEventRetentionCandidate(
        acknowledgement.runId,
      );
      if (candidate === undefined) return;
      if (candidate.bundleDigest !== acknowledgement.bundleDigest) {
        throw new Error(
          `ASF event-retention candidate for ${acknowledgement.runId} contradicts ` +
            "the durable acknowledgement bundle digest",
        );
      }
      this.#scheduleEventRetentionCandidate(candidate);
    } catch (error) {
      this.#reportBackgroundError(error, acknowledgement.runId);
    }
  }

  #eventRetentionDelayMs(candidate: AsfEventRetentionCandidate): number {
    const terminalAt = Date.parse(candidate.terminalEventAt);
    if (
      candidate.runId === "" ||
      !Number.isSafeInteger(candidate.generation) ||
      candidate.generation < 1 ||
      (candidate.ownerId !== null && candidate.ownerId === "") ||
      !Number.isSafeInteger(candidate.terminalEventSeq) ||
      candidate.terminalEventSeq < 2 ||
      !Number.isFinite(terminalAt) ||
      !/^sha256:[a-f0-9]{64}$/u.test(candidate.bundleDigest) ||
      !Number.isSafeInteger(candidate.compactedThrough) ||
      candidate.compactedThrough < 0 ||
      candidate.compactedThrough >= candidate.terminalEventSeq - 1
    ) {
      throw new Error(
        `ASF event-retention candidate for ${candidate.runId || "<unknown>"} is malformed`,
      );
    }
    const remaining =
      terminalAt + this.#detailedEventRetentionMs - this.#clock.now().getTime();
    if (!Number.isSafeInteger(remaining)) {
      throw new Error(
        `ASF event-retention deadline for ${candidate.runId} is outside the safe clock range`,
      );
    }
    if (remaining > 0) return Math.min(remaining, MAX_SCHEDULER_DELAY_MS);
    return candidate.ownerId === null ? 0 : this.#retryDelayMs;
  }

  #scheduleEventRetentionCandidate(
    candidate: AsfEventRetentionCandidate,
  ): boolean {
    if (this.#stopping || this.#eventRetentionTasks.has(candidate.runId)) {
      return false;
    }
    let delayMs: number;
    try {
      delayMs = this.#eventRetentionDelayMs(candidate);
    } catch (error) {
      this.#reportBackgroundError(error, candidate.runId);
      return false;
    }
    try {
      let firedBeforeRegistration = false;
      let registered = false;
      const task = this.#scheduler.schedule(delayMs, () => {
        if (!registered) {
          firedBeforeRegistration = true;
          return;
        }
        if (this.#eventRetentionTasks.get(candidate.runId) !== task) return;
        this.#eventRetentionTasks.delete(candidate.runId);
        this.#runEventRetentionMaintenance(candidate.runId);
      });
      this.#eventRetentionTasks.set(candidate.runId, task);
      registered = true;
      if (firedBeforeRegistration) {
        this.#eventRetentionTasks.delete(candidate.runId);
        if (delayMs === 0) {
          queueMicrotask(() =>
            this.#runEventRetentionMaintenance(candidate.runId),
          );
        } else {
          this.#reportBackgroundError(
            new Error(
              `ASF event-retention scheduler fired ${candidate.runId} before its delay elapsed`,
            ),
            candidate.runId,
          );
        }
      }
      return true;
    } catch (error) {
      this.#reportBackgroundError(error, candidate.runId);
      return false;
    }
  }

  #runEventRetentionMaintenance(runId: string): void {
    if (this.#stopping) return;
    let candidate: AsfEventRetentionCandidate | undefined;
    try {
      candidate = this.#store.getAsfEventRetentionCandidate(runId);
      if (candidate === undefined) {
        this.#rescanEventRetentionCandidates(runId);
        return;
      }
      const delayMs = this.#eventRetentionDelayMs(candidate);
      if (delayMs > 0) {
        this.#scheduleEventRetentionCandidate(candidate);
        return;
      }
      this.#store.compactAsfRunEvents({
        runId: candidate.runId,
        expectedGeneration: candidate.generation,
        expectedBundleDigest: candidate.bundleDigest,
        through: candidate.terminalEventSeq - 1,
        minimumAgeMs: this.#detailedEventRetentionMs,
      });
    } catch (error) {
      this.#reportBackgroundError(error, runId);
      return;
    }
    this.#rescanEventRetentionCandidates(runId);
  }

  /**
   * Each successful maintenance pass refills the bounded startup window, so
   * candidates beyond the first scan cannot remain permanently stranded.
   */
  #rescanEventRetentionCandidates(originRunId: string): void {
    if (this.#stopping) return;
    try {
      this.#scheduleDurableEventRetentionCandidates();
    } catch (error) {
      this.#reportBackgroundError(error, originRunId);
    }
  }

  #cancelDelayedWake(runId: string): void {
    const task = this.#delayedWakeTasks.get(runId);
    if (task === undefined) return;
    task.cancel();
    this.#delayedWakeTasks.delete(runId);
  }

  #scheduleDelayedWake(runId: string): void {
    this.#cancelDelayedWake(runId);
    try {
      let firedBeforeRegistration = false;
      let registered = false;
      const task = this.#scheduler.schedule(this.#retryDelayMs, () => {
        if (!registered) {
          firedBeforeRegistration = true;
          return;
        }
        if (this.#delayedWakeTasks.get(runId) !== task) return;
        this.#delayedWakeTasks.delete(runId);
        // The retry can fire before this runner's finally block removes the
        // scheduled marker. Waking preserves that race as an explicit
        // reschedule-after-active request instead of dropping the retry.
        this.#wakeRun(runId);
      });
      this.#delayedWakeTasks.set(runId, task);
      registered = true;
      if (firedBeforeRegistration) {
        this.#delayedWakeTasks.delete(runId);
        this.#wakeRun(runId);
      }
    } catch (scheduleError) {
      this.#reportBackgroundError(scheduleError, runId);
    }
  }

  #ensureRetryScheduled(): void {
    if (this.#retryTask !== undefined || this.#queue.length === 0) return;
    const runId = this.#queue[0];
    try {
      this.#retryTask = this.#scheduler.schedule(this.#retryDelayMs, () => {
        this.#retryTask = undefined;
        this.#requestPump();
      });
    } catch (error) {
      if (runId !== undefined) this.#reportBackgroundError(error, runId);
    }
  }

  #scheduleHeartbeat(runId: string, active: ActiveRun): void {
    if (this.#activeRuns.get(runId) !== active || active.leaseLost) return;
    try {
      active.heartbeatTask = this.#scheduler.schedule(
        this.#heartbeatIntervalMs,
        () => {
          active.heartbeatTask = undefined;
          if (this.#activeRuns.get(runId) !== active || active.leaseLost)
            return;
          try {
            this.#store.heartbeatAsfRun(
              runId,
              this.#workerId,
              active.generation,
            );
          } catch (error) {
            this.#loseLease(runId, active, error);
            return;
          }
          this.#scheduleHeartbeat(runId, active);
        },
      );
    } catch (error) {
      this.#loseLease(runId, active, error);
    }
  }

  #loseLease(runId: string, active: ActiveRun, error: unknown): void {
    if (this.#activeRuns.get(runId) !== active || active.leaseLost) return;
    active.leaseLost = true;
    active.heartbeatTask?.cancel();
    active.heartbeatTask = undefined;
    active.cancellationTask?.cancel();
    active.cancellationTask = undefined;
    active.abortController.abort(error);
    this.#reportBackgroundError(error, runId);
  }

  #releaseLocalSlot(runId: string, active: ActiveRun): void {
    if (this.#activeRuns.get(runId) !== active) return;
    active.heartbeatTask?.cancel();
    active.heartbeatTask = undefined;
    active.cancellationTask?.cancel();
    active.cancellationTask = undefined;
    this.#activeRuns.delete(runId);
  }

  #resolveIdleWaiters(): void {
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #telemetryMonotonicMs(): number | undefined {
    if (this.#telemetry === undefined) return undefined;
    try {
      const value = this.#clock.monotonicMs();
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  #telemetryElapsedMs(startedAt: number | undefined): number | undefined {
    if (startedAt === undefined) return undefined;
    const finishedAt = this.#telemetryMonotonicMs();
    return finishedAt === undefined || finishedAt < startedAt
      ? undefined
      : finishedAt - startedAt;
  }

  #telemetryOperation(
    name: AsfTelemetrySpanName,
    startedAt: number | undefined,
    component: NonNullable<AsfTelemetryAttributeInput["component"]>,
    operation: NonNullable<AsfTelemetryAttributeInput["operation"]>,
    outcome: NonNullable<AsfTelemetryAttributeInput["outcome"]>,
    attributes: Omit<
      AsfTelemetryAttributeInput,
      "component" | "operation" | "outcome"
    > = {},
  ): void {
    const durationMs = this.#telemetryElapsedMs(startedAt);
    if (durationMs === undefined) return;
    const completeAttributes = {
      ...attributes,
      component,
      operation,
      outcome,
    };
    this.#telemetrySpan(name, durationMs, completeAttributes);
    this.#telemetryHistogram(
      "runmill.asf.operation.duration",
      durationMs,
      "ms",
      completeAttributes,
    );
  }

  #discardTelemetryResult(result: unknown): void {
    if (result === undefined) return;
    try {
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A hostile thenable is still non-authoritative telemetry input.
    }
  }

  #telemetrySpan(
    name: AsfTelemetrySpanName,
    durationMs: number,
    attributes: AsfTelemetryAttributeInput,
  ): void {
    try {
      this.#discardTelemetryResult(
        this.#telemetry?.span(name, durationMs, attributes),
      );
    } catch {
      // Even a nonconforming telemetry adapter cannot affect worker authority.
    }
  }

  #telemetryCounter(
    name: AsfTelemetryCounterName,
    value: number,
    attributes: AsfTelemetryAttributeInput,
  ): void {
    try {
      this.#discardTelemetryResult(
        this.#telemetry?.counter(name, value, attributes),
      );
    } catch {
      // Even a nonconforming telemetry adapter cannot affect worker authority.
    }
  }

  #telemetryHistogram(
    name: AsfTelemetryHistogramName,
    value: number,
    unit: AsfTelemetryUnit,
    attributes: AsfTelemetryAttributeInput,
  ): void {
    try {
      this.#discardTelemetryResult(
        this.#telemetry?.histogram(name, value, unit, attributes),
      );
    } catch {
      // Even a nonconforming telemetry adapter cannot affect worker authority.
    }
  }

  #emitStopTelemetry(): void {
    if (this.#stopTelemetryEmitted) return;
    this.#stopTelemetryEmitted = true;
    this.#telemetryOperation(
      "runmill.asf.service.lifecycle",
      this.#serviceTelemetryStartedAt,
      "service",
      "service-lifecycle",
      "succeeded",
    );
  }

  #reportBackgroundError(error: unknown, runId: string): void {
    try {
      this.#onBackgroundError?.(error, runId);
    } catch {
      // A diagnostic callback cannot be allowed to create an unhandled
      // rejection in the detached execution path.
    }
  }
}

function safeAdmission(
  admission: AsfAdmissionRecord,
): SafeAsfAdmissionSnapshot {
  return {
    idempotencyKey: admission.idempotencyKey,
    workOrderId: admission.workOrderId,
    attemptId: admission.attemptId,
    tenantId: admission.tenantId,
    payloadDigest: admission.payloadDigest,
    envelopeDigest: admission.envelopeDigest,
    effectivePolicyDigest: admission.effectivePolicyDigest,
    signatureKeyId: admission.signatureKeyId,
    signatureAlgorithm: admission.signatureAlgorithm,
    acceptedAt: admission.acceptedAt,
  };
}
