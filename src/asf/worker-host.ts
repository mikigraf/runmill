import { z } from "zod";
import {
  asfDaemonRuntimePaths,
  DaemonControlServer,
  type AsfControlRequest,
  type ControlRequest,
  type ControlServerOptions,
  type RuntimePaths,
} from "../daemon/control.js";
import { handleAsfControlRequest, type AsfControlService } from "./control.js";
import type { AsfControlAuthenticationVerifier } from "./control-auth.js";
import { asfHealthReportSchema, type AsfHealthReport } from "./health.js";
import {
  ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
  hasCanonicalAsfProductionReadinessChecks,
  type ProductionReadinessReport,
} from "./production-readiness.js";

const readyProductionReportSchema = z
  .object({
    schema: z.literal(ASF_PRODUCTION_READINESS_REPORT_SCHEMA),
    mode: z.literal("asf-worker"),
    decision: z.literal("ready"),
    readyToStart: z.literal(true),
    asfProductionReady: z.literal(true),
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            passed: z.literal(true),
            expected: z.string().max(4_096),
            observed: z.string().max(4_096),
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict();

const PRODUCTION_GATED_REQUESTS: ReadonlySet<AsfControlRequest["type"]> = new Set([
  "asf.submit_work_order",
  "asf.record_approval",
  "asf.reconcile_run",
]);
const STRICT_ADMISSION_HEALTH_REQUESTS: ReadonlySet<AsfControlRequest["type"]> = new Set([
  "asf.submit_work_order",
]);
const PUBLIC_READINESS_CHECK_IDS: ReadonlySet<string> = new Set([
  ...ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  "observation.schema",
  "observation.clock",
]);

export interface AsfWorkerHostService extends AsfControlService {
  /** Discover durable work after all production safety gates have passed. */
  recover(): number;
  /** Stop scheduling queued work and wait only for invocations already in flight. */
  requestStop(): Promise<void>;
}

export interface AsfWorkerHostControlServer {
  close(): Promise<void>;
}

/** Injectable boundary around the user-private daemon control socket. */
export interface AsfWorkerHostControlServerFactory {
  start(options: ControlServerOptions): Promise<AsfWorkerHostControlServer>;
}

export interface AsfWorkerHostOptions {
  /** Deliberate runtime guard: this host cannot be selected implicitly. */
  readonly mode: "asf-worker";
  readonly service: AsfWorkerHostService;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly startedAt: string;
  readonly paths?: RuntimePaths | undefined;
  /** Cryptographic controller authentication for every production control request. */
  readonly controlAuthentication: AsfControlAuthenticationVerifier;
  /**
   * Re-run the production capability/configuration preflight. Its result is
   * treated as untrusted input and must be an internally consistent ASF-ready
   * report. A standalone/development result can never authorize this host.
   */
  readonly readiness: () => ProductionReadinessReport | Promise<ProductionReadinessReport>;
  readonly controlServerFactory?: AsfWorkerHostControlServerFactory | undefined;
  readonly onBackgroundError?: ((error: unknown) => void) | undefined;
}

interface HostLifecycle {
  host: AsfWorkerHost | undefined;
  stopping: boolean;
  stopRequested: boolean;
}

const DEFAULT_CONTROL_SERVER_FACTORY: AsfWorkerHostControlServerFactory = {
  start: (options) =>
    DaemonControlServer.start({
      ...options,
      paths: options.paths ?? asfDaemonRuntimePaths(),
    }),
};

export type AsfWorkerReadinessDomain = "production" | "health";

/** Public-safe refusal raised before unsafe ASF work can be admitted or resumed. */
export class AsfWorkerHostReadinessError extends Error {
  readonly domain: AsfWorkerReadinessDomain;
  readonly reasons: readonly string[];

  constructor(domain: AsfWorkerReadinessDomain, reasons: readonly string[]) {
    const safeReasons = reasons.length === 0 ? ["invalid-or-missing-evidence"] : [...reasons];
    super(`ASF worker ${domain} readiness refused: ${safeReasons.join(", ")}`);
    this.name = "AsfWorkerHostReadinessError";
    this.domain = domain;
    this.reasons = safeReasons;
  }
}

/**
 * Long-lived, ASF-only process host.
 *
 * This class is intentionally not wired into the standalone `runmill start`
 * path. Construction requires the literal ASF mode plus explicit production
 * readiness, runtime health, durable service, and private control dependencies.
 */
export class AsfWorkerHost {
  readonly #service: AsfWorkerHostService;
  readonly #server: AsfWorkerHostControlServer;
  readonly #lifecycle: HostLifecycle;
  readonly #stopped: Promise<void>;
  readonly #resolveStopped: () => void;
  readonly #rejectStopped: (error: unknown) => void;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    service: AsfWorkerHostService,
    server: AsfWorkerHostControlServer,
    lifecycle: HostLifecycle,
  ) {
    this.#service = service;
    this.#server = server;
    this.#lifecycle = lifecycle;
    let resolveStopped: (() => void) | undefined;
    let rejectStopped: ((error: unknown) => void) | undefined;
    this.#stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    this.#resolveStopped = resolveStopped as () => void;
    this.#rejectStopped = rejectStopped as (error: unknown) => void;
    // A host may be embedded without awaiting its lifetime. Keep a failed
    // background stop observable through waitUntilStopped() without creating
    // an unhandled rejection in such embedders.
    void this.#stopped.catch(() => undefined);
  }

  static async start(options: AsfWorkerHostOptions): Promise<AsfWorkerHost> {
    if ((options as { readonly mode?: unknown }).mode !== "asf-worker") {
      throw new AsfWorkerHostReadinessError("production", ["explicit-asf-worker-mode-required"]);
    }
    if (
      typeof (options as { readonly controlAuthentication?: unknown }).controlAuthentication !==
        "object" ||
      typeof options.controlAuthentication.verify !== "function"
    ) {
      throw new AsfWorkerHostReadinessError("production", [
        "authenticated-control-required",
      ]);
    }

    await requireProductionReady(options.readiness);
    await requireHealthy(options.service);

    const lifecycle: HostLifecycle = {
      host: undefined,
      stopping: false,
      stopRequested: false,
    };
    let recoveryAttempted = false;
    try {
      // Recovery occurs once, before the socket can acknowledge new authority.
      recoveryAttempted = true;
      options.service.recover();

      const factory = options.controlServerFactory ?? DEFAULT_CONTROL_SERVER_FACTORY;
      const server = await factory.start({
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        startedAt: options.startedAt,
        ...(options.paths === undefined ? {} : { paths: options.paths }),
        controlAuthentication: options.controlAuthentication,
        handle: (request) => dispatchControlRequest(options, lifecycle, request),
      });
      const host = new AsfWorkerHost(options.service, server, lifecycle);
      lifecycle.host = host;
      if (lifecycle.stopRequested) scheduleControlStop(lifecycle, options.onBackgroundError);
      return host;
    } catch (error) {
      lifecycle.stopping = true;
      // A partial recovery may already have claimed work. Use the service's
      // fenced graceful boundary so queued work remains durable for restart.
      if (recoveryAttempted) {
        try {
          await options.service.requestStop();
        } catch (stopError) {
          reportBackgroundError(options.onBackgroundError, stopError);
        }
      }
      throw error;
    }
  }

  get stopping(): boolean {
    return this.#lifecycle.stopping;
  }

  /**
   * Stop new control intake and scheduling concurrently, then wait only for
   * requests and worker invocations that were already in flight.
   */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#lifecycle.stopping = true;
    this.#stopPromise = Promise.all([
      this.#server.close(),
      this.#service.requestStop(),
    ]).then(
      () => {
        this.#resolveStopped();
      },
      (error: unknown) => {
        this.#rejectStopped(error);
        throw error;
      },
    );
    return this.#stopPromise;
  }

  /** Wait for either a local signal or authenticated control stop to finish. */
  waitUntilStopped(): Promise<void> {
    return this.#stopped;
  }
}

async function dispatchControlRequest(
  options: AsfWorkerHostOptions,
  lifecycle: HostLifecycle,
  request: ControlRequest,
): Promise<unknown> {
  if (request.type === "stop") {
    lifecycle.stopping = true;
    lifecycle.stopRequested = true;
    scheduleControlStop(lifecycle, options.onBackgroundError);
    return { accepted: true, mode: "asf-worker", stopping: true };
  }
  if (!isAsfControlRequest(request)) {
    throw new Error("ASF worker control does not expose standalone backlog controls");
  }
  if (lifecycle.stopping && isAuthorityBearing(request)) {
    throw new Error("ASF worker service is stopping and is not accepting authority-bearing requests");
  }
  if (PRODUCTION_GATED_REQUESTS.has(request.type)) {
    await requireProductionReady(options.readiness);
    if (STRICT_ADMISSION_HEALTH_REQUESTS.has(request.type)) {
      await requireHealthy(options.service);
    } else {
      // Approval and reconciliation are recovery controls. Ordinary capacity
      // pressure may degrade admission health, but must not deadlock the exact
      // controls that let already-durable runs make progress.
      await requireNonRefusingHealth(options.service);
    }
    // Close the check/use window against a concurrent stop request. The
    // durable service independently rejects submission after its own stop.
    if (lifecycle.stopping) {
      throw new Error("ASF worker service is stopping and is not accepting authority-bearing requests");
    }
  }
  return handleAsfControlRequest(options.service, request);
}

function isAsfControlRequest(request: ControlRequest): request is AsfControlRequest {
  return request.type.startsWith("asf.");
}

function isAuthorityBearing(request: AsfControlRequest): boolean {
  return PRODUCTION_GATED_REQUESTS.has(request.type);
}

async function requireProductionReady(
  readiness: AsfWorkerHostOptions["readiness"],
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readiness();
  } catch {
    throw new AsfWorkerHostReadinessError("production", ["probe-failed"]);
  }
  const parsed = readyProductionReportSchema.safeParse(raw);
  if (parsed.success) {
    if (hasCanonicalAsfProductionReadinessChecks(parsed.data.checks)) return;
    throw new AsfWorkerHostReadinessError("production", [
      "readiness-check-set-incomplete-or-unknown",
    ]);
  }

  const report = asRecord(raw);
  const checks = Array.isArray(report?.["checks"])
    ? report["checks"]
        .map(asRecord)
        .filter(
          (check) =>
            check?.["passed"] === false &&
            typeof check["id"] === "string" &&
            PUBLIC_READINESS_CHECK_IDS.has(check["id"]),
        )
        .map((check) => String(check?.["id"]))
    : [];
  throw new AsfWorkerHostReadinessError(
    "production",
    checks.length === 0 ? ["invalid-or-not-ready-report"] : checks,
  );
}

async function requireHealthy(service: AsfWorkerHostService): Promise<AsfHealthReport> {
  const report = await readHealth(service);
  if (!report.ready) {
    throw new AsfWorkerHostReadinessError("health", healthReasons(report));
  }
  return report;
}

async function requireNonRefusingHealth(
  service: AsfWorkerHostService,
): Promise<AsfHealthReport> {
  const report = await readHealth(service);
  const refusing = Object.values(report.components).filter(
    (component) => component.status === "refusing",
  );
  if (refusing.length > 0 || report.status === "refusing") {
    throw new AsfWorkerHostReadinessError(
      "health",
      refusing.flatMap((component) => component.reasons.map(String)),
    );
  }
  return report;
}

async function readHealth(service: AsfWorkerHostService): Promise<AsfHealthReport> {
  let raw: unknown;
  try {
    raw = await service.health();
  } catch {
    throw new AsfWorkerHostReadinessError("health", ["probe-failed"]);
  }
  const parsed = asfHealthReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AsfWorkerHostReadinessError("health", ["invalid-report"]);
  }
  return parsed.data;
}

function healthReasons(report: AsfHealthReport): string[] {
  const reasons = Object.values(report.components).flatMap((component) =>
    component.reasons.map(String),
  );
  return reasons.length === 0 ? [`status.${report.status}`] : reasons;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function scheduleControlStop(
  lifecycle: HostLifecycle,
  onBackgroundError: AsfWorkerHostOptions["onBackgroundError"],
): void {
  const host = lifecycle.host;
  if (host === undefined) return;
  queueMicrotask(() => {
    void host.stop().catch((error: unknown) => reportBackgroundError(onBackgroundError, error));
  });
}

function reportBackgroundError(
  reporter: AsfWorkerHostOptions["onBackgroundError"],
  error: unknown,
): void {
  try {
    reporter?.(error);
  } catch {
    // Diagnostics cannot gain authority or create an unhandled rejection.
  }
}
