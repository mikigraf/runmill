import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import type { Clock } from "../platform/clock.js";
import { sha256Digest, type JsonValue } from "./canonical-json.js";

export const RECONCILIATION_REQUEST_SCHEMA =
  "asf.reconciliation-request/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const reconciliationRequestSchema = z
  .object({
    schema: z.literal(RECONCILIATION_REQUEST_SCHEMA),
    operation_id: identifierSchema,
    run_id: identifierSchema,
    requested_by: z
      .object({
        subject: identifierSchema,
        authority: z.literal("asf:reconcile"),
      })
      .strict(),
    scope: z.literal("pending-effects"),
  })
  .strict();

export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>;
export type ReconciliationStatus = "queued" | "running" | "completed" | "blocked";

export const ASF_RECONCILIATION_RESULT_SCHEMA =
  "asf.reconciliation-result/v1" as const;

export type AsfReconciliationOutcome = "confirmed" | "not_applied" | "ambiguous";

export interface AsfReconciliationResultItem {
  readonly effect_class: "github-effect" | "delivery-intent";
  readonly effect_key: string;
  readonly outcome: AsfReconciliationOutcome;
}

export interface AsfReconciliationResultEnvelope {
  readonly schema: typeof ASF_RECONCILIATION_RESULT_SCHEMA;
  readonly operation_id: string;
  readonly run_id: string;
  readonly pending_set_digest: string;
  readonly observations: readonly AsfReconciliationResultItem[];
}

export interface AsfDurableReconciliationContinuation {
  readonly disposition: "run-resumed";
  readonly runId: string;
  readonly operationId: string;
  readonly resumedEventSeq: number;
  readonly resumePhase: string;
  readonly resultDigest: string;
}

export interface AsfReconciliationRecord {
  readonly operationId: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly requestedBy: string;
  readonly requestedAuthority: "asf:reconcile";
  readonly scope: "pending-effects";
  readonly status: ReconciliationStatus;
  readonly generation: number | null;
  readonly ownerId: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly resultDigest: string | null;
  readonly pendingSetDigest?: string | null | undefined;
  readonly pendingGithubEffects?: number | null | undefined;
  readonly pendingDeliveryIntents?: number | null | undefined;
  readonly canonicalPendingSet?: string | null | undefined;
  readonly canonicalResult?: string | null | undefined;
  readonly resumedEventSeq?: number | null | undefined;
  /** Returned only by the atomic finish call; ordinary reads omit it. */
  readonly continuation?: AsfDurableReconciliationContinuation | null | undefined;
}

export interface ReconciliationRequestResult {
  readonly operationId: string;
  readonly runId: string;
  readonly disposition: "queued" | "existing" | "nothing-to-reconcile";
  readonly status: ReconciliationStatus;
  readonly requestDigest: string;
  readonly requestedAt: string;
}

export interface AsfPendingReconciliationRun {
  readonly runId: string;
  readonly pendingSetDigest: string;
  readonly githubEffectCount: number;
  readonly deliveryIntentCount: number;
}

export interface AsfPendingReconciliationPage {
  readonly runs: readonly AsfPendingReconciliationRun[];
  readonly nextRunId: string | null;
}

export interface AsfReconciliationPendingSetBinding {
  readonly pendingSetDigest: string;
  readonly githubEffectCount: number;
  readonly deliveryIntentCount: number;
  /** Deterministic UTC epoch bucket used as this automatic retry attempt. */
  readonly retryBucket: number;
}

export interface AsfReconciliationRecoveryCursor {
  readonly requestedAt: string;
  readonly operationId: string;
}

export interface AsfReconciliationCompletion {
  readonly operationId: string;
  readonly runId: string;
  readonly generation: number;
  readonly resultDigest: string;
  readonly completedAt: string;
  readonly pendingSetBinding: AsfReconciliationPendingSetBinding | null;
  /**
   * This callback grants no transition authority. The orchestrator must take a
   * fresh fence and revalidate the paused run before leaving BLOCKED_EXTERNAL.
   */
  readonly continuation:
    | {
        readonly disposition: "notification-only";
        readonly requiredActor: "orchestrator";
        readonly eligiblePausedPhase: "BLOCKED_EXTERNAL";
        readonly requiresFreshClaim: true;
      }
    | AsfDurableReconciliationContinuation;
}

export interface ReconciliationStore {
  recordAsfReconciliationRequest(input: {
    readonly request: ReconciliationRequest;
    readonly requestDigest: string;
  }): ReconciliationRequestResult;
  /** Bounded, stable run-id scan of durable effects that lack a definitive observation. */
  discoverPendingAsfReconciliationRuns(input: {
    readonly afterRunId: string | null;
    readonly limit: number;
    readonly maxPendingItemsPerRun: number;
  }): AsfPendingReconciliationPage;
  listRecoverableAsfReconciliations(input?: {
    readonly after: AsfReconciliationRecoveryCursor | null;
    readonly limit: number;
  }): readonly AsfReconciliationRecord[];
  claimAsfReconciliation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly staleBefore: string;
  }): { readonly runId: string; readonly generation: number } | null | undefined;
  /**
   * Rebuild the exact result for a previously snapshotted pending set after
   * its durable effect rows have all reached definitive outcomes. This closes
   * the crash window between the last observation write and reconciliation
   * completion; implementations must derive the result from the immutable
   * request snapshot plus the durable ledgers under the current fence.
   */
  recoverResolvedAsfReconciliationResult?(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly generation: number;
  }): AsfReconciliationResultEnvelope | undefined;
  finishAsfReconciliation(input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly status: "completed" | "blocked";
    readonly resultDigest: string;
    readonly result?: AsfReconciliationResultEnvelope | undefined;
    readonly pendingSetBinding?: AsfReconciliationPendingSetBinding | null | undefined;
  }): AsfReconciliationRecord;
  releaseAsfRunOwnership(runId: string, ownerId: string, generation: number): void;
}

export interface ReconciliationObserver {
  /** Ask the service to snapshot the current durable set for manual requests too. */
  readonly requiresPendingSetBinding?: boolean | undefined;
  reconcilePending(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    /** Present for automatically discovered work and bound into its operation id. */
    readonly pendingSetBinding?: AsfReconciliationPendingSetBinding | undefined;
  }): Promise<
    readonly {
      readonly status: string;
      readonly effectKey: string;
      readonly effectClass?: "github-effect" | "delivery-intent" | undefined;
    }[]
  >;
}

export interface ReconciliationClassObserver {
  reconcilePending(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly effectClass: "github-effect" | "delivery-intent";
    readonly expectedCount: number;
    readonly pendingSetBinding: AsfReconciliationPendingSetBinding;
  }): Promise<
    readonly {
      readonly status: string;
      readonly effectKey: string;
      readonly effectClass?: "github-effect" | "delivery-intent" | undefined;
    }[]
  >;
}

export interface AsfReconciliationTask {
  cancel(): void;
}

export interface AsfReconciliationScheduler {
  schedule(delayMs: number, task: () => void): AsfReconciliationTask;
}

const DEFAULT_SCHEDULER: AsfReconciliationScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

const DEFAULT_RECOVERY_PAGE_SIZE = 100;
const DEFAULT_MAX_RECOVERY_RECORDS = 10_000;
const DEFAULT_MAX_PENDING_ITEMS_PER_RUN = 20_000;
const DEFAULT_MAX_OBSERVER_RESULTS = 20_000;
const INTERNAL_RECOVERY_SUBJECT = "service:asf-recovery";
const AUTOMATIC_OPERATION_PATTERN =
  /^reconcile_auto_v2_(?<bucket>[0-9a-z]+)_(?<github>[0-9a-z]+)_(?<delivery>[0-9a-z]+)_(?<pending>[a-f0-9]{64})_(?<attempt>[a-f0-9]{16})$/u;
const CONTINUATION_CONTRACT = Object.freeze({
  disposition: "notification-only",
  requiredActor: "orchestrator",
  eligiblePausedPhase: "BLOCKED_EXTERNAL",
  requiresFreshClaim: true,
} as const);

function reconciliationError(whatHappened: string, runId?: string): RunmillError {
  return RunmillError.fromCatalog("RM-RECON-001", {
    whatHappened,
    ...(runId === undefined ? {} : { runId }),
  });
}

export function parseReconciliationRequest(raw: unknown): ReconciliationRequest {
  const parsed = reconciliationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw reconciliationError(
      "the reconciliation request is malformed:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

function automaticAttemptDigest(input: {
  readonly runId: string;
  readonly pendingSetDigest: string;
  readonly githubEffectCount: number;
  readonly deliveryIntentCount: number;
  readonly retryBucket: number;
}): string {
  return sha256Digest({
    schema: "asf.automatic-reconciliation-identity/v2",
    run_id: input.runId,
    pending_set_digest: input.pendingSetDigest,
    pending_github_effects: input.githubEffectCount,
    pending_delivery_intents: input.deliveryIntentCount,
    retry_bucket: input.retryBucket,
  });
}

export function automaticReconciliationOperationId(input: {
  readonly runId: string;
  readonly pendingSetDigest: string;
  readonly githubEffectCount: number;
  readonly deliveryIntentCount: number;
  readonly retryBucket: number;
}): string {
  if (
    !identifierSchema.safeParse(input.runId).success ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.pendingSetDigest) ||
    !Number.isSafeInteger(input.githubEffectCount) ||
    input.githubEffectCount < 0 ||
    !Number.isSafeInteger(input.deliveryIntentCount) ||
    input.deliveryIntentCount < 0 ||
    input.githubEffectCount + input.deliveryIntentCount < 1 ||
    !Number.isSafeInteger(input.retryBucket) ||
    input.retryBucket < 0
  ) {
    throw reconciliationError("automatic reconciliation identity input is malformed", input.runId);
  }
  const attemptDigest = automaticAttemptDigest(input).slice("sha256:".length);
  return [
    "reconcile_auto_v2",
    input.retryBucket.toString(36),
    input.githubEffectCount.toString(36),
    input.deliveryIntentCount.toString(36),
    input.pendingSetDigest.slice("sha256:".length),
    attemptDigest.slice(0, 16),
  ].join("_");
}

function parseAutomaticPendingSetBinding(
  operationId: string,
  runId: string,
): AsfReconciliationPendingSetBinding | undefined {
  const match = AUTOMATIC_OPERATION_PATTERN.exec(operationId);
  if (match?.groups === undefined) {
    if (operationId.startsWith("reconcile_auto_")) {
      throw reconciliationError(
        "automatic reconciliation operation identity is malformed",
        runId,
      );
    }
    return undefined;
  }
  const retryBucket = Number.parseInt(match.groups["bucket"] ?? "", 36);
  const githubEffectCount = Number.parseInt(match.groups["github"] ?? "", 36);
  const deliveryIntentCount = Number.parseInt(match.groups["delivery"] ?? "", 36);
  const pendingSetDigest = `sha256:${match.groups["pending"] ?? ""}`;
  if (
    !Number.isSafeInteger(retryBucket) ||
    retryBucket < 0 ||
    !Number.isSafeInteger(githubEffectCount) ||
    githubEffectCount < 0 ||
    !Number.isSafeInteger(deliveryIntentCount) ||
    deliveryIntentCount < 0 ||
    githubEffectCount + deliveryIntentCount < 1
  ) {
    throw reconciliationError(
      "automatic reconciliation operation identity has invalid retry counts",
      runId,
    );
  }
  const expectedAttempt = automaticAttemptDigest({
    runId,
    pendingSetDigest,
    githubEffectCount,
    deliveryIntentCount,
    retryBucket,
  })
    .slice("sha256:".length)
    .slice(0, 16);
  if (match.groups["attempt"] !== expectedAttempt) {
    throw reconciliationError(
      "automatic reconciliation operation identity does not bind its run and pending set",
      runId,
    );
  }
  return Object.freeze({
    pendingSetDigest,
    githubEffectCount,
    deliveryIntentCount,
    retryBucket,
  });
}

function validObservationField(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Routes an exact automatic pending set to its observation-only class
 * reconcilers. Configuration and result shape are checked before the service
 * may treat an observation as definitive.
 */
export class CompositeReconciliationObserver implements ReconciliationObserver {
  readonly requiresPendingSetBinding = true;
  readonly #githubEffects: ReconciliationClassObserver | undefined;
  readonly #deliveryIntents: ReconciliationClassObserver | undefined;
  readonly #maxResults: number;

  constructor(options: {
    readonly githubEffects?: ReconciliationClassObserver | undefined;
    readonly deliveryIntents?: ReconciliationClassObserver | undefined;
    readonly maxResults?: number | undefined;
  }) {
    const maxResults = options.maxResults ?? DEFAULT_MAX_OBSERVER_RESULTS;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100_000) {
      throw new Error("composite reconciliation result bound must be between 1 and 100000");
    }
    this.#githubEffects = options.githubEffects;
    this.#deliveryIntents = options.deliveryIntents;
    this.#maxResults = maxResults;
  }

  async reconcilePending(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly generation: number;
    readonly pendingSetBinding?: AsfReconciliationPendingSetBinding | undefined;
  }): Promise<
    readonly {
      readonly status: string;
      readonly effectKey: string;
      readonly effectClass: "github-effect" | "delivery-intent";
    }[]
  > {
    if (input.pendingSetBinding === undefined) {
      throw reconciliationError(
        "composite reconciliation requires an exact automatic pending-set binding",
        input.runId,
      );
    }
    const binding = Object.freeze({ ...input.pendingSetBinding });
    const total = binding.githubEffectCount + binding.deliveryIntentCount;
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(binding.pendingSetDigest) ||
      !Number.isSafeInteger(binding.retryBucket) ||
      binding.retryBucket < 0 ||
      !Number.isSafeInteger(binding.githubEffectCount) ||
      binding.githubEffectCount < 0 ||
      !Number.isSafeInteger(binding.deliveryIntentCount) ||
      binding.deliveryIntentCount < 0 ||
      total < 1 ||
      total > this.#maxResults
    ) {
      throw reconciliationError(
        "composite reconciliation received malformed or unbounded pending-set evidence",
        input.runId,
      );
    }
    if (binding.githubEffectCount > 0 && this.#githubEffects === undefined) {
      throw reconciliationError(
        "pending GitHub effects have no configured observation-only reconciler",
        input.runId,
      );
    }
    if (binding.deliveryIntentCount > 0 && this.#deliveryIntents === undefined) {
      throw reconciliationError(
        "pending delivery intents have no configured observation-only reconciler",
        input.runId,
      );
    }

    const output: {
      status: string;
      effectKey: string;
      effectClass: "github-effect" | "delivery-intent";
    }[] = [];
    const seen = new Set<string>();
    const invoke = async (
      effectClass: "github-effect" | "delivery-intent",
      expectedCount: number,
      observer: ReconciliationClassObserver | undefined,
    ): Promise<void> => {
      if (expectedCount === 0) return;
      if (observer === undefined) throw new Error("validated reconciliation observer disappeared");
      const raw: unknown = await observer.reconcilePending({
        runId: input.runId,
        ownerId: input.ownerId,
        generation: input.generation,
        effectClass,
        expectedCount,
        pendingSetBinding: binding,
      });
      if (!Array.isArray(raw) || raw.length !== expectedCount || raw.length > this.#maxResults) {
        throw reconciliationError(
          `${effectClass} reconciler did not return the exact bounded pending count`,
          input.runId,
        );
      }
      for (const observation of raw as readonly unknown[]) {
        if (
          typeof observation !== "object" ||
          observation === null ||
          !("effectKey" in observation) ||
          !("status" in observation)
        ) {
          throw reconciliationError(
            `${effectClass} reconciler returned malformed observation evidence`,
            input.runId,
          );
        }
        const item = observation as {
          readonly effectKey?: unknown;
          readonly status?: unknown;
          readonly effectClass?: unknown;
        };
        if (
          !validObservationField(item.effectKey, 512) ||
          !validObservationField(item.status, 64) ||
          (item.effectClass !== undefined && item.effectClass !== effectClass) ||
          seen.has(item.effectKey)
        ) {
          throw reconciliationError(
            `${effectClass} reconciler returned duplicate, contradictory, or malformed evidence`,
            input.runId,
          );
        }
        seen.add(item.effectKey);
        output.push(
          Object.freeze({
            effectClass,
            effectKey: item.effectKey,
            status: item.status,
          }),
        );
      }
    };

    await invoke("github-effect", binding.githubEffectCount, this.#githubEffects);
    await invoke("delivery-intent", binding.deliveryIntentCount, this.#deliveryIntents);
    return Object.freeze(output);
  }
}

/**
 * Durable asynchronous reconciliation coordinator.
 *
 * The public request only queues exact observation work. The observer owns no
 * generic mutation API, and an ambiguous observation finishes as blocked.
 */
export class AsfReconciliationService {
  readonly #store: ReconciliationStore;
  readonly #observer: ReconciliationObserver;
  readonly #clock: Clock;
  readonly #workerId: string;
  readonly #staleOwnershipMs: number;
  readonly #retryDelayMs: number;
  readonly #scheduler: AsfReconciliationScheduler;
  readonly #onBackgroundError: ((error: unknown, operationId: string) => void) | undefined;
  readonly #onReconciliationCompleted:
    | ((completion: AsfReconciliationCompletion) => void | Promise<void>)
    | undefined;
  #onDurableContinuation:
    | ((completion: AsfReconciliationCompletion) => void | Promise<void>)
    | undefined;
  readonly #continuationRetryTasks = new Map<string, AsfReconciliationTask>();
  readonly #recoveryPageSize: number;
  readonly #maxRecoveryRecords: number;
  readonly #maxPendingItemsPerRun: number;
  readonly #maxObserverResults: number;
  readonly #queued = new Set<string>();
  readonly #queue: string[] = [];
  #running = false;
  #claimRetryTask: AsfReconciliationTask | undefined;
  #periodicRecoveryTask: AsfReconciliationTask | undefined;

  constructor(options: {
    readonly store: ReconciliationStore;
    readonly observer: ReconciliationObserver;
    readonly clock: Clock;
    readonly workerId: string;
    readonly staleOwnershipMs: number;
    readonly retryDelayMs?: number | undefined;
    readonly scheduler?: AsfReconciliationScheduler | undefined;
    readonly onBackgroundError?: ((error: unknown, operationId: string) => void) | undefined;
    /**
     * Best-effort post-commit notification, delivered only after the durable
     * completion and ownership release. It is not a durable outbox and cannot
     * itself resume a paused run; `completion.continuation` names the required
     * orchestrator revalidation contract.
     */
    readonly onReconciliationCompleted?:
      | ((completion: AsfReconciliationCompletion) => void | Promise<void>)
      | undefined;
    readonly recoveryPageSize?: number | undefined;
    readonly maxRecoveryRecords?: number | undefined;
    readonly maxPendingItemsPerRun?: number | undefined;
    readonly maxObserverResults?: number | undefined;
  }) {
    if (options.workerId.trim() === "") throw new Error("reconciliation worker id is required");
    if (!Number.isSafeInteger(options.staleOwnershipMs) || options.staleOwnershipMs < 0) {
      throw new Error("reconciliation stale ownership duration must be non-negative");
    }
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
      throw new Error("reconciliation retry delay must be a positive safe integer");
    }
    const recoveryPageSize = options.recoveryPageSize ?? DEFAULT_RECOVERY_PAGE_SIZE;
    const maxRecoveryRecords = options.maxRecoveryRecords ?? DEFAULT_MAX_RECOVERY_RECORDS;
    const maxPendingItemsPerRun =
      options.maxPendingItemsPerRun ?? DEFAULT_MAX_PENDING_ITEMS_PER_RUN;
    const maxObserverResults = options.maxObserverResults ?? DEFAULT_MAX_OBSERVER_RESULTS;
    if (!Number.isSafeInteger(recoveryPageSize) || recoveryPageSize < 1 || recoveryPageSize > 1_000) {
      throw new Error("reconciliation recovery page size must be between 1 and 1000");
    }
    for (const [label, value] of [
      ["recovery record", maxRecoveryRecords],
      ["pending-item", maxPendingItemsPerRun],
      ["observer result", maxObserverResults],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
        throw new Error(`reconciliation ${label} bound must be between 1 and 100000`);
      }
    }
    this.#store = options.store;
    this.#observer = options.observer;
    this.#clock = options.clock;
    this.#workerId = options.workerId;
    this.#staleOwnershipMs = options.staleOwnershipMs;
    this.#retryDelayMs = retryDelayMs;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#onBackgroundError = options.onBackgroundError;
    this.#onReconciliationCompleted = options.onReconciliationCompleted;
    this.#recoveryPageSize = recoveryPageSize;
    this.#maxRecoveryRecords = maxRecoveryRecords;
    this.#maxPendingItemsPerRun = maxPendingItemsPerRun;
    this.#maxObserverResults = maxObserverResults;
  }

  /**
   * Bind the durable worker wake-up exactly once. The state transaction, not
   * this callback, authorizes continuation; callback loss is retried and a
   * process restart still discovers the now-active durable run.
   */
  bindDurableContinuationHandler(
    handler: (completion: AsfReconciliationCompletion) => void | Promise<void>,
  ): void {
    if (this.#onDurableContinuation !== undefined) {
      throw new Error("ASF reconciliation continuation handler is already bound");
    }
    this.#onDurableContinuation = handler;
  }

  async #deliverDurableContinuation(completion: AsfReconciliationCompletion): Promise<void> {
    if (completion.continuation.disposition !== "run-resumed") return;
    try {
      await this.#onDurableContinuation?.(completion);
      this.#continuationRetryTasks.get(completion.operationId)?.cancel();
      this.#continuationRetryTasks.delete(completion.operationId);
    } catch (error) {
      this.#report(error, completion.operationId);
      if (this.#continuationRetryTasks.has(completion.operationId)) return;
      try {
        const task = this.#scheduler.schedule(this.#retryDelayMs, () => {
          this.#continuationRetryTasks.delete(completion.operationId);
          void this.#deliverDurableContinuation(completion);
        });
        this.#continuationRetryTasks.set(completion.operationId, task);
      } catch (scheduleError) {
        this.#report(scheduleError, completion.operationId);
      }
    }
  }

  request(raw: unknown): ReconciliationRequestResult {
    const request = parseReconciliationRequest(raw);
    const result = this.#store.recordAsfReconciliationRequest({
      request,
      requestDigest: sha256Digest(request),
    });
    if (result.status === "queued") this.#enqueue(result.operationId);
    return result;
  }

  recover(): number {
    const pendingRunCount = this.#discoverRequests();
    let queued = 0;
    let after: AsfReconciliationRecoveryCursor | null = null;
    let scanned = 0;
    const seen = new Set<string>();
    while (true) {
      const operations = this.#store.listRecoverableAsfReconciliations({
        after,
        limit: this.#recoveryPageSize,
      });
      if (operations.length > this.#recoveryPageSize) {
        throw reconciliationError("recoverable reconciliation page exceeded its requested bound");
      }
      if (operations.length === 0) break;
      let prior = after;
      for (const operation of operations) {
        scanned += 1;
        if (scanned > this.#maxRecoveryRecords) {
          throw reconciliationError("recoverable reconciliation scan exceeded its protected bound");
        }
        if (
          !identifierSchema.safeParse(operation.operationId).success ||
          !identifierSchema.safeParse(operation.runId).success ||
          !/^sha256:[a-f0-9]{64}$/u.test(operation.requestDigest) ||
          operation.requestedAuthority !== "asf:reconcile" ||
          operation.scope !== "pending-effects" ||
          (operation.status !== "queued" && operation.status !== "running") ||
          !Number.isFinite(Date.parse(operation.requestedAt)) ||
          seen.has(operation.operationId) ||
          (prior !== null &&
            (operation.requestedAt < prior.requestedAt ||
              (operation.requestedAt === prior.requestedAt &&
                operation.operationId <= prior.operationId)))
        ) {
          throw reconciliationError("recoverable reconciliation page is malformed or unordered");
        }
        seen.add(operation.operationId);
        prior = { requestedAt: operation.requestedAt, operationId: operation.operationId };
        if (this.#enqueue(operation.operationId)) queued += 1;
      }
      if (operations.length < this.#recoveryPageSize) break;
      const last = operations.at(-1);
      if (last === undefined) break;
      const next = { requestedAt: last.requestedAt, operationId: last.operationId };
      if (
        after !== null &&
        next.requestedAt === after.requestedAt &&
        next.operationId === after.operationId
      ) {
        throw reconciliationError("recoverable reconciliation cursor did not advance");
      }
      after = next;
    }
    if (pendingRunCount > 0) this.#schedulePeriodicRecovery();
    return queued;
  }

  #discoverRequests(): number {
    const pendingRuns = this.#listPendingRuns();
    const retryBucket = this.#currentRetryBucket();
    for (const pending of pendingRuns) {
      const operationId = automaticReconciliationOperationId({
        runId: pending.runId,
        pendingSetDigest: pending.pendingSetDigest,
        githubEffectCount: pending.githubEffectCount,
        deliveryIntentCount: pending.deliveryIntentCount,
        retryBucket,
      });
      const request: ReconciliationRequest = {
        schema: RECONCILIATION_REQUEST_SCHEMA,
        operation_id: operationId,
        run_id: pending.runId,
        requested_by: {
          subject: INTERNAL_RECOVERY_SUBJECT,
          authority: "asf:reconcile",
        },
        scope: "pending-effects",
      };
      this.#store.recordAsfReconciliationRequest({
        request,
        requestDigest: sha256Digest(request),
      });
    }
    return pendingRuns.length;
  }

  #currentRetryBucket(): number {
    const now = this.#clock.now().getTime();
    if (!Number.isFinite(now)) {
      throw reconciliationError("automatic reconciliation clock returned an invalid instant");
    }
    return Math.floor(now / this.#retryDelayMs);
  }

  #listPendingRuns(): readonly AsfPendingReconciliationRun[] {
    let afterRunId: string | null = null;
    let scanned = 0;
    const seen = new Set<string>();
    const pendingRuns: AsfPendingReconciliationRun[] = [];
    while (true) {
      const page = this.#store.discoverPendingAsfReconciliationRuns({
        afterRunId,
        limit: this.#recoveryPageSize,
        maxPendingItemsPerRun: this.#maxPendingItemsPerRun,
      });
      if (page.runs.length > this.#recoveryPageSize) {
        throw reconciliationError("pending-effect discovery page exceeded its requested bound");
      }
      let priorRunId = afterRunId;
      for (const pending of page.runs) {
        scanned += 1;
        if (scanned > this.#maxRecoveryRecords) {
          throw reconciliationError("pending-effect discovery exceeded its protected run bound");
        }
        if (
          !identifierSchema.safeParse(pending.runId).success ||
          !/^sha256:[a-f0-9]{64}$/u.test(pending.pendingSetDigest) ||
          !Number.isSafeInteger(pending.githubEffectCount) ||
          pending.githubEffectCount < 0 ||
          !Number.isSafeInteger(pending.deliveryIntentCount) ||
          pending.deliveryIntentCount < 0 ||
          pending.githubEffectCount + pending.deliveryIntentCount < 1 ||
          pending.githubEffectCount + pending.deliveryIntentCount > this.#maxPendingItemsPerRun ||
          (priorRunId !== null && pending.runId <= priorRunId)
        ) {
          throw reconciliationError("pending-effect discovery returned malformed bounded evidence");
        }
        if (seen.has(pending.runId)) {
          throw reconciliationError("pending-effect discovery returned a duplicate run");
        }
        seen.add(pending.runId);
        priorRunId = pending.runId;
        pendingRuns.push(Object.freeze({ ...pending }));
      }
      if (page.nextRunId === null) break;
      if (
        !identifierSchema.safeParse(page.nextRunId).success ||
        page.nextRunId === afterRunId ||
        page.runs.length === 0 ||
        page.runs.at(-1)?.runId !== page.nextRunId
      ) {
        throw reconciliationError("pending-effect discovery cursor is malformed or did not advance");
      }
      afterRunId = page.nextRunId;
    }
    return Object.freeze(pendingRuns);
  }

  #enqueue(operationId: string): boolean {
    if (this.#queued.has(operationId)) return false;
    this.#queued.add(operationId);
    this.#queue.push(operationId);
    queueMicrotask(() => void this.#pump());
    return true;
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    let needsRetry = false;
    try {
      const operationId = this.#queue.shift();
      if (operationId === undefined) return;
      const staleBefore = new Date(
        this.#clock.now().getTime() - this.#staleOwnershipMs,
      ).toISOString();
      let claim:
        | { readonly runId: string; readonly generation: number }
        | null
        | undefined;
      try {
        claim = this.#store.claimAsfReconciliation({
          operationId,
          ownerId: this.#workerId,
          staleBefore,
        });
      } catch (error) {
        this.#report(error, operationId);
      }
      if (claim === null) {
        this.#queued.delete(operationId);
        return;
      }
      if (claim === undefined) {
        this.#queue.push(operationId);
        needsRetry = true;
        return;
      }
      let completion: AsfReconciliationCompletion | undefined;
      let released = false;
      let retryPendingObservation = false;
      try {
        let pendingSetBinding = parseAutomaticPendingSetBinding(operationId, claim.runId);
        let effects: Awaited<ReturnType<ReconciliationObserver["reconcilePending"]>>;
        if (
          pendingSetBinding !== undefined ||
          this.#observer.requiresPendingSetBinding === true
        ) {
          const currentPending = this.#listPendingRuns().find(
            (pending) => pending.runId === claim.runId,
          );
          if (currentPending === undefined) {
            // A prior process may have crashed after committing the final
            // observation but before finishing this request. The original
            // non-empty pending set remains authoritative; an empty current
            // scan must never be substituted for it. Reconstruct every exact
            // outcome from the immutable request snapshot and durable ledgers.
            const recovered =
              this.#store.recoverResolvedAsfReconciliationResult?.({
                operationId,
                ownerId: this.#workerId,
                generation: claim.generation,
              });
            if (recovered === undefined) {
              throw reconciliationError(
                "resolved reconciliation set cannot be reconstructed from durable evidence",
                claim.runId,
              );
            }
            if (
              recovered.operation_id !== operationId ||
              recovered.run_id !== claim.runId ||
              recovered.observations.length < 1
            ) {
              throw reconciliationError(
                "recovered reconciliation result contradicts its claimed operation",
                claim.runId,
              );
            }
            const githubEffectCount = recovered.observations.filter(
              (observation) => observation.effect_class === "github-effect",
            ).length;
            const deliveryIntentCount = recovered.observations.length - githubEffectCount;
            if (pendingSetBinding === undefined) {
              pendingSetBinding = Object.freeze({
                pendingSetDigest: recovered.pending_set_digest,
                githubEffectCount,
                deliveryIntentCount,
                retryBucket: this.#currentRetryBucket(),
              });
            } else if (
              recovered.pending_set_digest !== pendingSetBinding.pendingSetDigest ||
              githubEffectCount !== pendingSetBinding.githubEffectCount ||
              deliveryIntentCount !== pendingSetBinding.deliveryIntentCount
            ) {
              throw reconciliationError(
                "recovered reconciliation result contradicts its pending-set identity",
                claim.runId,
              );
            }
            effects = recovered.observations.map((observation) => ({
              effectClass: observation.effect_class,
              effectKey: observation.effect_key,
              status: observation.outcome,
            }));
          } else {
            if (pendingSetBinding === undefined) {
              pendingSetBinding = Object.freeze({
                pendingSetDigest: currentPending.pendingSetDigest,
                githubEffectCount: currentPending.githubEffectCount,
                deliveryIntentCount: currentPending.deliveryIntentCount,
                retryBucket: this.#currentRetryBucket(),
              });
            } else if (
              currentPending.pendingSetDigest !== pendingSetBinding.pendingSetDigest ||
              currentPending.githubEffectCount !== pendingSetBinding.githubEffectCount ||
              currentPending.deliveryIntentCount !== pendingSetBinding.deliveryIntentCount
            ) {
              throw reconciliationError(
                "automatic reconciliation pending set changed before observation",
                claim.runId,
              );
            }
            effects = await this.#observer.reconcilePending({
              runId: claim.runId,
              ownerId: this.#workerId,
              generation: claim.generation,
              pendingSetBinding,
            });
          }
        } else {
          effects = await this.#observer.reconcilePending({
            runId: claim.runId,
            ownerId: this.#workerId,
            generation: claim.generation,
          });
        }
        if (effects.length > this.#maxObserverResults) {
          throw reconciliationError(
            "reconciliation observer result exceeded its protected bound",
            claim.runId,
          );
        }
        const seenEffects = new Set<string>();
        let contradictory = false;
        const normalized = effects
          .map((effect, index) => {
            const validKey =
              typeof effect.effectKey === "string" &&
              effect.effectKey.length > 0 &&
              effect.effectKey.length <= 512 &&
              !/[\u0000-\u001f\u007f]/u.test(effect.effectKey);
            const effectKey = validKey ? effect.effectKey : `invalid-effect-${index}`;
            if (!validKey || seenEffects.has(effectKey)) contradictory = true;
            seenEffects.add(effectKey);
            const validStatus =
              typeof effect.status === "string" &&
              effect.status.length > 0 &&
              effect.status.length <= 64 &&
              !/[\u0000-\u001f\u007f]/u.test(effect.status);
            if (!validStatus) contradictory = true;
            return {
              effect_class: effect.effectClass ?? "unspecified",
              effect_key: effectKey,
              status: validStatus ? effect.status : "invalid",
            };
          })
          .sort((left, right) =>
            left.effect_class.localeCompare(right.effect_class) ||
            left.effect_key.localeCompare(right.effect_key) ||
            left.status.localeCompare(right.status),
          );
        const unresolved = normalized.filter(
          (effect) => effect.status !== "confirmed" && effect.status !== "not_applied",
        );
        const exactResult: AsfReconciliationResultEnvelope | undefined =
          pendingSetBinding !== undefined &&
          !contradictory &&
          normalized.length ===
            pendingSetBinding.githubEffectCount + pendingSetBinding.deliveryIntentCount &&
          normalized.every(
            (effect) =>
              (effect.effect_class === "github-effect" ||
                effect.effect_class === "delivery-intent") &&
              (effect.status === "confirmed" ||
                effect.status === "not_applied" ||
                effect.status === "ambiguous"),
          )
            ? {
                schema: ASF_RECONCILIATION_RESULT_SCHEMA,
                operation_id: operationId,
                run_id: claim.runId,
                pending_set_digest: pendingSetBinding.pendingSetDigest,
                observations: normalized.map((effect) => ({
                  effect_class: effect.effect_class as
                    | "github-effect"
                    | "delivery-intent",
                  effect_key: effect.effect_key,
                  outcome: effect.status as AsfReconciliationOutcome,
                })),
              }
            : undefined;
        const resultDigest = exactResult === undefined
          ? sha256Digest({
              operation_id: operationId,
              pending_set_binding:
                pendingSetBinding === undefined
                  ? null
                  : {
                      pending_set_digest: pendingSetBinding.pendingSetDigest,
                      pending_github_effects: pendingSetBinding.githubEffectCount,
                      pending_delivery_intents: pendingSetBinding.deliveryIntentCount,
                      retry_bucket: pendingSetBinding.retryBucket,
                    },
              effects: normalized,
            })
          : sha256Digest(exactResult as unknown as JsonValue);
        const finished = this.#store.finishAsfReconciliation({
          operationId,
          ownerId: this.#workerId,
          generation: claim.generation,
          status: !contradictory && unresolved.length === 0 ? "completed" : "blocked",
          resultDigest,
          ...(exactResult === undefined ? {} : { result: exactResult }),
          pendingSetBinding: pendingSetBinding ?? null,
        });
        retryPendingObservation = finished.status === "blocked";
        if (
          finished.status === "completed" &&
          finished.completedAt !== null &&
          finished.resultDigest !== null
        ) {
          completion = {
            operationId: finished.operationId,
            runId: finished.runId,
            generation: claim.generation,
            resultDigest: finished.resultDigest,
            completedAt: finished.completedAt,
            pendingSetBinding: pendingSetBinding ?? null,
            continuation: finished.continuation ?? CONTINUATION_CONTRACT,
          };
        }
      } catch (error) {
        retryPendingObservation = true;
        try {
          this.#store.finishAsfReconciliation({
            operationId,
            ownerId: this.#workerId,
            generation: claim.generation,
            status: "blocked",
            resultDigest: sha256Digest({
              operation_id: operationId,
              outcome: "blocked",
            }),
          });
        } catch (finishError) {
          this.#report(finishError, operationId);
        }
        this.#report(error, operationId);
      } finally {
        try {
          this.#store.releaseAsfRunOwnership(
            claim.runId,
            this.#workerId,
            claim.generation,
          );
          released = true;
        } catch {
          // A newer fence owns the run; never release it from stale context.
        }
        this.#queued.delete(operationId);
      }
      if (completion !== undefined && released) {
        try {
          await this.#onReconciliationCompleted?.(completion);
        } catch (error) {
          this.#report(error, operationId);
        }
        await this.#deliverDurableContinuation(completion);
      }
      if (retryPendingObservation) this.#schedulePeriodicRecovery();
    } finally {
      this.#running = false;
      if (needsRetry) this.#scheduleClaimRetry();
      else if (this.#queue.length > 0) queueMicrotask(() => void this.#pump());
    }
  }

  #scheduleClaimRetry(): void {
    if (this.#claimRetryTask !== undefined) return;
    this.#claimRetryTask = this.#scheduler.schedule(this.#retryDelayMs, () => {
      this.#claimRetryTask = undefined;
      void this.#pump();
    });
  }

  #schedulePeriodicRecovery(): void {
    if (this.#periodicRecoveryTask !== undefined) return;
    this.#periodicRecoveryTask = this.#scheduler.schedule(this.#retryDelayMs, () => {
      this.#periodicRecoveryTask = undefined;
      try {
        this.recover();
      } catch (error) {
        this.#report(error, "reconcile_automatic_recovery");
        this.#schedulePeriodicRecovery();
      }
      void this.#pump();
    });
  }

  #report(error: unknown, operationId: string): void {
    try {
      this.#onBackgroundError?.(error, operationId);
    } catch {
      // Telemetry cannot change reconciliation authority or create rejection.
    }
  }
}
