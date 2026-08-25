import type { Clock } from "../platform/clock.js";
import { StateStore } from "../state/store.js";
import {
  AsfPrDeliveryRunner,
  type AsfPrDeliveryRunnerOptions,
} from "./delivery-runner.js";
import { AsfWorkerService, type AsfWorkerServiceOptions } from "./service.js";
import type { AsfTelemetryRecorder } from "./telemetry.js";
import type {
  AsfWorkerHostOptions,
  AsfWorkerHostService,
} from "./worker-host.js";

export const ASF_REFERENCE_COMPOSITION_SCHEMA =
  "runmill.asf-reference-composition/v1" as const;
export const ASF_REFERENCE_COMPOSITION_CLASSIFICATION =
  "reference-integration-boundary" as const;
export const ASF_REFERENCE_COMPOSITION_PRODUCTION_QUALIFIED = false as const;

/**
 * Every external or deployment-owned port the shipped reference assembler
 * requires. Presence means structural completeness only; it is never live
 * qualification evidence.
 */
export const ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS = [
  "state-store",
  "clock",
  "telemetry",
  "control-authentication",
  "readiness",
  "work-order-admission",
  "cancellation",
  "approval",
  "evidence-read",
  "reconciliation",
  "outcome-acknowledgement",
  "health",
  "delivery-intents",
  "recovery",
  "recovery-dispatch",
  "repository-lease",
  "identity-lifecycle",
  "workspace",
  "task-packet",
  "implementation",
  "local-verification",
  "reviewer",
  "candidate-invalidation",
  "delivery-proposal",
  "github-effects",
  "github-ci",
  "evidence-finalization",
  "terminal-evidence-finalization",
  "cleanup",
  "provider-budget",
  "shutdown-reconciliation",
  "shutdown-identities",
  "shutdown-resources",
] as const;

export type AsfReferenceCompositionPortId =
  (typeof ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS)[number];

export type AsfReferenceDeliveryControllers = Omit<
  AsfPrDeliveryRunnerOptions,
  "store" | "clock" | "workerId"
>;

export type AsfReferenceWorkerTuning = Omit<
  AsfWorkerServiceOptions,
  | "store"
  | "admission"
  | "clock"
  | "workerId"
  | "runner"
  | "cancellation"
  | "approval"
  | "evidence"
  | "reconciliation"
  | "outcome"
  | "health"
  | "telemetry"
>;

export interface AsfReferenceServiceControls {
  readonly admission: AsfWorkerServiceOptions["admission"];
  readonly cancellation: NonNullable<AsfWorkerServiceOptions["cancellation"]>;
  readonly approval: NonNullable<AsfWorkerServiceOptions["approval"]>;
  readonly evidence: NonNullable<AsfWorkerServiceOptions["evidence"]>;
  readonly reconciliation: NonNullable<
    AsfWorkerServiceOptions["reconciliation"]
  > & {
    readonly bindDurableContinuationHandler: NonNullable<
      NonNullable<
        AsfWorkerServiceOptions["reconciliation"]
      >["bindDurableContinuationHandler"]
    >;
  };
  readonly outcome: NonNullable<AsfWorkerServiceOptions["outcome"]>;
  readonly health: NonNullable<AsfWorkerServiceOptions["health"]>;
}

export interface AsfReferenceShutdownController {
  /** Stop observation/reconciliation schedulers and wait for them to quiesce. */
  readonly stopReconciliation: () => void | Promise<void>;
  /** Revoke or close every remaining provider identity lease. */
  readonly retireIdentities: () => void | Promise<void>;
  /** Release repository/workspace/sandbox resources after identity retirement. */
  readonly cleanupResources: () => void | Promise<void>;
}

export interface AsfReferenceCompositionInput {
  readonly schema: typeof ASF_REFERENCE_COMPOSITION_SCHEMA;
  readonly classification: typeof ASF_REFERENCE_COMPOSITION_CLASSIFICATION;
  /** This assembler is structural evidence, never production qualification. */
  readonly productionQualified: false;
  readonly mode: "asf-worker";
  readonly store: StateStore;
  readonly clock: Clock;
  readonly telemetry: AsfTelemetryRecorder;
  readonly workerId: string;
  readonly delivery: AsfReferenceDeliveryControllers;
  readonly worker: AsfReferenceWorkerTuning;
  readonly controls: AsfReferenceServiceControls;
  readonly shutdown: AsfReferenceShutdownController;
  readonly host: Omit<
    AsfWorkerHostOptions,
    "mode" | "service" | "controlServerFactory"
  >;
}

export interface AsfReferenceCompositionReport {
  readonly schema: "runmill.asf-reference-composition-report/v1";
  readonly classification: typeof ASF_REFERENCE_COMPOSITION_CLASSIFICATION;
  readonly productionQualified: false;
  readonly configurationValid: boolean;
  readonly complete: boolean;
  readonly missingPorts: readonly AsfReferenceCompositionPortId[];
  readonly reasons: readonly string[];
}

export class AsfReferenceCompositionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`ASF reference composition refused: ${reason}`);
    this.name = "AsfReferenceCompositionError";
    this.reason = reason;
  }
}

export class AsfReferenceCompositionShutdownError extends Error {
  constructor() {
    super(
      "ASF reference composition shutdown did not retire every required resource",
    );
    this.name = "AsfReferenceCompositionShutdownError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  try {
    return methods.every((method) => typeof record[method] === "function");
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  try {
    return Reflect.ownKeys(record).every(
      (key) => typeof key === "string" && allowed.has(key),
    );
  } catch {
    return false;
  }
}

function safeValue(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  try {
    return record?.[key];
  } catch {
    return undefined;
  }
}

const DELIVERY_KEYS = new Set([
  "intents",
  "recovery",
  "recoveryDispatch",
  "repositoryLease",
  "identities",
  "workspace",
  "taskPacket",
  "implementation",
  "localVerification",
  "reviewer",
  "invalidation",
  "deliveryProposal",
  "github",
  "ci",
  "evidence",
  "terminalEvidence",
  "cleanup",
  "budget",
  "maxEventScan",
]);
const CONTROL_KEYS = new Set([
  "admission",
  "cancellation",
  "approval",
  "evidence",
  "reconciliation",
  "outcome",
  "health",
]);
const SHUTDOWN_KEYS = new Set([
  "stopReconciliation",
  "retireIdentities",
  "cleanupResources",
]);
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "classification",
  "productionQualified",
  "mode",
  "store",
  "clock",
  "telemetry",
  "workerId",
  "delivery",
  "worker",
  "controls",
  "shutdown",
  "host",
]);
const WORKER_KEYS = new Set([
  "staleOwnershipMs",
  "maxConcurrency",
  "retryDelayMs",
  "heartbeatIntervalMs",
  "detailedEventRetentionMs",
  "eventRetentionScanLimit",
  "scheduler",
  "onBackgroundError",
]);
const HOST_KEYS = new Set([
  "repoRoot",
  "configPath",
  "startedAt",
  "paths",
  "controlAuthentication",
  "readiness",
  "onBackgroundError",
]);

interface PortCheck {
  readonly id: AsfReferenceCompositionPortId;
  readonly value: unknown;
  readonly methods: readonly string[];
}

/** Inspect structure only. A complete report is not live qualification. */
export function inspectAsfReferenceComposition(
  raw: unknown,
): AsfReferenceCompositionReport {
  const input = asRecord(raw);
  const delivery = asRecord(safeValue(input, "delivery"));
  const controls = asRecord(safeValue(input, "controls"));
  const shutdown = asRecord(safeValue(input, "shutdown"));
  const worker = asRecord(safeValue(input, "worker"));
  const host = asRecord(safeValue(input, "host"));
  const reasons: string[] = [];

  if (!hasOnlyKeys(input, TOP_LEVEL_KEYS)) {
    reasons.push("composition-container-invalid");
  }
  if (
    input === undefined ||
    safeValue(input, "schema") !== ASF_REFERENCE_COMPOSITION_SCHEMA ||
    safeValue(input, "classification") !==
      ASF_REFERENCE_COMPOSITION_CLASSIFICATION ||
    safeValue(input, "productionQualified") !== false ||
    safeValue(input, "mode") !== "asf-worker"
  ) {
    reasons.push("composition-metadata-invalid");
  }
  if (!hasOnlyKeys(delivery, DELIVERY_KEYS))
    reasons.push("delivery-container-invalid");
  if (!hasOnlyKeys(controls, CONTROL_KEYS))
    reasons.push("control-container-invalid");
  if (!hasOnlyKeys(shutdown, SHUTDOWN_KEYS))
    reasons.push("shutdown-container-invalid");
  if (!hasOnlyKeys(worker, WORKER_KEYS)) {
    reasons.push("worker-tuning-invalid");
  }
  if (!hasOnlyKeys(host, HOST_KEYS)) {
    reasons.push("host-options-invalid");
  }
  if (
    typeof safeValue(input, "workerId") !== "string" ||
    (safeValue(input, "workerId") as string).trim() === ""
  ) {
    reasons.push("worker-id-invalid");
  }

  const checks: readonly PortCheck[] = [
    {
      id: "state-store",
      value: safeValue(input, "store"),
      methods: ["getAsfRunSnapshot"],
    },
    {
      id: "clock",
      value: safeValue(input, "clock"),
      methods: ["now", "monotonicMs"],
    },
    {
      id: "telemetry",
      value: safeValue(input, "telemetry"),
      methods: ["span", "counter", "histogram"],
    },
    {
      id: "control-authentication",
      value: safeValue(host, "controlAuthentication"),
      methods: ["verify"],
    },
    { id: "readiness", value: host, methods: ["readiness"] },
    {
      id: "work-order-admission",
      value: safeValue(controls, "admission"),
      methods: ["submit", "lookupSubmission"],
    },
    {
      id: "cancellation",
      value: safeValue(controls, "cancellation"),
      methods: ["request"],
    },
    {
      id: "approval",
      value: safeValue(controls, "approval"),
      methods: ["record"],
    },
    {
      id: "evidence-read",
      value: safeValue(controls, "evidence"),
      methods: ["getEvidence"],
    },
    {
      id: "reconciliation",
      value: safeValue(controls, "reconciliation"),
      methods: ["request", "recover", "bindDurableContinuationHandler"],
    },
    {
      id: "outcome-acknowledgement",
      value: safeValue(controls, "outcome"),
      methods: ["acknowledge"],
    },
    {
      id: "health",
      value: safeValue(controls, "health"),
      methods: ["getHealth"],
    },
    {
      id: "delivery-intents",
      value: safeValue(delivery, "intents"),
      methods: ["record", "confirm", "prepareTerminal", "sealTerminal"],
    },
    {
      id: "recovery",
      value: safeValue(delivery, "recovery"),
      methods: ["observe", "apply"],
    },
    {
      id: "recovery-dispatch",
      value: safeValue(delivery, "recoveryDispatch"),
      methods: ["dispatch"],
    },
    {
      id: "repository-lease",
      value: safeValue(delivery, "repositoryLease"),
      methods: ["acquire"],
    },
    {
      id: "identity-lifecycle",
      value: safeValue(delivery, "identities"),
      methods: ["acquireRequiredRoles"],
    },
    {
      id: "workspace",
      value: safeValue(delivery, "workspace"),
      methods: ["prepare", "observeCurrent"],
    },
    {
      id: "task-packet",
      value: safeValue(delivery, "taskPacket"),
      methods: ["create"],
    },
    {
      id: "implementation",
      value: safeValue(delivery, "implementation"),
      methods: ["markSession", "createCandidate", "captureProtectedResume"],
    },
    {
      id: "local-verification",
      value: safeValue(delivery, "localVerification"),
      methods: ["verify"],
    },
    {
      id: "reviewer",
      value: safeValue(delivery, "reviewer"),
      methods: ["review"],
    },
    {
      id: "candidate-invalidation",
      value: safeValue(delivery, "invalidation"),
      methods: ["invalidate"],
    },
    {
      id: "delivery-proposal",
      value: safeValue(delivery, "deliveryProposal"),
      methods: ["propose"],
    },
    {
      id: "github-effects",
      value: safeValue(delivery, "github"),
      methods: ["ensureBranch", "ensurePullRequest", "observeFinalDelivery"],
    },
    {
      id: "github-ci",
      value: safeValue(delivery, "ci"),
      methods: ["observeExactHead"],
    },
    {
      id: "evidence-finalization",
      value: safeValue(delivery, "evidence"),
      methods: ["finalize"],
    },
    {
      id: "terminal-evidence-finalization",
      value: safeValue(delivery, "terminalEvidence"),
      methods: ["finalizeTerminal"],
    },
    {
      id: "cleanup",
      value: safeValue(delivery, "cleanup"),
      methods: ["cleanup"],
    },
    {
      id: "provider-budget",
      value: safeValue(delivery, "budget"),
      methods: ["checkRun", "reserve", "complete"],
    },
    {
      id: "shutdown-reconciliation",
      value: shutdown,
      methods: ["stopReconciliation"],
    },
    {
      id: "shutdown-identities",
      value: shutdown,
      methods: ["retireIdentities"],
    },
    {
      id: "shutdown-resources",
      value: shutdown,
      methods: ["cleanupResources"],
    },
  ];
  const missingPorts = checks
    .filter((check) => !hasMethods(check.value, check.methods))
    .map((check) => check.id);
  if (!(safeValue(input, "store") instanceof StateStore)) {
    if (!missingPorts.includes("state-store")) missingPorts.push("state-store");
    reasons.push("first-party-state-store-required");
  }

  const configurationValid = reasons.length === 0;
  return Object.freeze({
    schema: "runmill.asf-reference-composition-report/v1",
    classification: ASF_REFERENCE_COMPOSITION_CLASSIFICATION,
    productionQualified: false,
    configurationValid,
    complete: configurationValid && missingPorts.length === 0,
    missingPorts: Object.freeze([...missingPorts]),
    reasons: Object.freeze([...reasons]),
  });
}

async function stopReferenceComposition(
  worker: AsfWorkerService,
  shutdown: AsfReferenceShutdownController,
): Promise<void> {
  const attempt = async (
    operation: () => void | Promise<void>,
  ): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch {
      return false;
    }
  };
  const workerStopped = await attempt(() => worker.requestStop());
  const reconciliationStopped = await attempt(() =>
    shutdown.stopReconciliation(),
  );
  const identitiesRetired = await attempt(() => shutdown.retireIdentities());
  // A failed retirement must preserve the resources a later revocation needs.
  const resourcesCleaned = identitiesRetired
    ? await attempt(() => shutdown.cleanupResources())
    : false;
  if (
    !workerStopped ||
    !reconciliationStopped ||
    !identitiesRetired ||
    !resourcesCleaned
  ) {
    throw new AsfReferenceCompositionShutdownError();
  }
}

function referenceService(
  worker: AsfWorkerService,
  shutdown: AsfReferenceShutdownController,
): AsfWorkerHostService {
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    submitWorkOrder: (raw: unknown) => worker.submitWorkOrder(raw),
    getRun: (runId: string) => worker.getRun(runId),
    lookupSubmission: (
      input: Parameters<AsfWorkerService["lookupSubmission"]>[0],
    ) => worker.lookupSubmission(input),
    listRunEvents: (runId: string, after?: number, limit?: number) =>
      worker.listRunEvents(runId, after, limit),
    getEvidence: (runId: string) => worker.getEvidence(runId),
    requestCancellation: (raw: unknown) => worker.requestCancellation(raw),
    recordApproval: (raw: unknown) => worker.recordApproval(raw),
    requestReconciliation: (raw: unknown) => worker.requestReconciliation(raw),
    acknowledgeOutcome: (raw: unknown) => worker.acknowledgeOutcome(raw),
    health: () => worker.health(),
    recover: () => worker.recover(),
    requestStop: () => {
      if (stopPromise === undefined) {
        const currentAttempt = stopReferenceComposition(worker, shutdown);
        stopPromise = currentAttempt;
        // A failed attempt must stay retryable; a completed one stays cached.
        currentAttempt.catch(() => {
          if (stopPromise === currentAttempt) stopPromise = undefined;
        });
      }
      return stopPromise;
    },
  });
}

/**
 * Assemble the real Runmill delivery runner and worker service around every
 * explicitly supplied production port. This is a reference integration
 * boundary, not a production-readiness or live-qualification assertion.
 */
export function createAsfReferenceWorkerHostOptions(
  input: AsfReferenceCompositionInput,
): AsfWorkerHostOptions {
  const report = inspectAsfReferenceComposition(input);
  if (!report.configurationValid) {
    throw new AsfReferenceCompositionError(
      report.reasons[0] ?? "configuration-invalid",
    );
  }
  if (!report.complete) {
    throw new AsfReferenceCompositionError(
      `required-ports-missing:${report.missingPorts.join(",")}`,
    );
  }

  let runner: AsfPrDeliveryRunner;
  let worker: AsfWorkerService;
  try {
    runner = new AsfPrDeliveryRunner({
      ...input.delivery,
      store: input.store,
      clock: input.clock,
      workerId: input.workerId,
    });
    worker = new AsfWorkerService({
      ...input.worker,
      store: input.store,
      admission: input.controls.admission,
      clock: input.clock,
      workerId: input.workerId,
      runner: runner.asRunner(),
      cancellation: input.controls.cancellation,
      approval: input.controls.approval,
      evidence: input.controls.evidence,
      reconciliation: input.controls.reconciliation,
      outcome: input.controls.outcome,
      health: input.controls.health,
      telemetry: input.telemetry,
    });
  } catch {
    throw new AsfReferenceCompositionError("component-construction-failed");
  }
  return Object.freeze({
    ...input.host,
    mode: "asf-worker",
    service: referenceService(worker, input.shutdown),
  });
}
