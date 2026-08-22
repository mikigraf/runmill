import { z } from "zod";
import type { Clock } from "../platform/clock.js";

export const ASF_HEALTH_SCHEMA = "asf.health/v1" as const;
export const ASF_HEALTH_OBSERVATION_SCHEMA = "asf.health-observation/v1" as const;

const timestampSchema = z.iso.datetime({ offset: true }).max(64);
const boundedCountSchema = z.number().int().min(0).max(100_000);
const schemaVersionSchema = z.number().int().min(1).max(1_000_000);
const publicAgeSchema = z.number().int().min(0).max(2_147_483_647);

export const ASF_HEALTH_REASON_CODES = [
  "observation.missing",
  "observation.invalid",
  "observation.stale",
  "observation.future",
  "probe.failed",
  "probe.timeout",
  "service.recovering",
  "service.stopping",
  "service.not_accepting",
  "service.contradictory",
  "database.unreachable",
  "database.schema_mismatch",
  "database.integrity_failed",
  "database.write_failed",
  "database.contradictory",
  "worker.heartbeat_stale",
  "worker.heartbeat_future",
  "worker.scheduler_stopped",
  "worker.fencing_unavailable",
  "worker.concurrency_mismatch",
  "worker.capacity_contradictory",
  "worker.capacity_full",
  "worker.queue_nonempty",
  "sandbox.mechanism_mismatch",
  "sandbox.unavailable",
  "sandbox.enforcement_failed",
  "sandbox.downgraded",
  "sandbox.verification_unavailable",
  "sandbox.network_unenforced",
  "sandbox.denial_proof_failed",
  "ctxlane.unreachable",
  "ctxlane.unauthenticated",
  "ctxlane.lease_unavailable",
  "ctxlane.contradictory",
  "github.credential_boundary_failed",
  "github.unreachable",
  "github.unauthenticated",
  "github.capability_unavailable",
  "github.excess_authority",
  "github.contradictory",
  "mcp.control_unavailable",
  "mcp.controller_unauthenticated",
  "mcp.exposed_to_worker",
  "mcp.contradictory",
  "backlog.selection_enabled",
  "backlog.mutations_enabled",
] as const;

const healthReasonSchema = z.enum(ASF_HEALTH_REASON_CODES);
const componentStatusSchema = z.enum(["ready", "degraded", "refusing"]);
const reasonListSchema = z
  .array(healthReasonSchema)
  .max(16)
  .refine((reasons) => new Set(reasons).size === reasons.length, "must not contain duplicates");

function observationSchema<const Kind extends string, Shape extends z.ZodRawShape>(
  kind: Kind,
  shape: Shape,
) {
  return z
    .object({
      schema: z.literal(ASF_HEALTH_OBSERVATION_SCHEMA),
      kind: z.literal(kind),
      observed_at: timestampSchema,
      data: z.object(shape).strict(),
    })
    .strict();
}

export const serviceHealthObservationSchema = observationSchema("service", {
  mode: z.literal("asf-worker"),
  state: z.enum(["running", "recovering", "stopping"]),
  accepting_submissions: z.boolean(),
  recovery_complete: z.boolean(),
});

export const databaseHealthObservationSchema = observationSchema("database", {
  reachable: z.boolean(),
  schema_version: schemaVersionSchema.nullable(),
  integrity_check_passed: z.boolean(),
  write_probe_passed: z.boolean(),
});

export const workerHealthObservationSchema = observationSchema("worker", {
  heartbeat_at: timestampSchema,
  scheduler_running: z.boolean(),
  fencing_store_ready: z.boolean(),
  max_concurrency: z.number().int().min(1).max(32),
  active_runs: z.number().int().min(0).max(32),
  queued_runs: boundedCountSchema,
});

const denialProofsShape = {
  provider_credentials: z.boolean(),
  ctxlane_socket: z.boolean(),
  github_credentials: z.boolean(),
  asf_credentials: z.boolean(),
  backlog_credentials: z.boolean(),
  host_ssh_agent: z.boolean(),
  cloud_metadata: z.boolean(),
  other_workspaces: z.boolean(),
  docker_socket: z.boolean(),
  mcp_control_endpoint: z.boolean(),
} satisfies z.ZodRawShape;

export const sandboxHealthObservationSchema = observationSchema("sandbox", {
  mechanism: z.enum(["bubblewrap", "microvm", "seatbelt", "none"]),
  installed: z.boolean(),
  enforcement_self_test_passed: z.boolean(),
  enforcement_downgraded: z.boolean(),
  fresh_candidate_verification: z.boolean(),
  tool_network_policy_enforced: z.boolean(),
  verification_network_disabled: z.boolean(),
  denial_proofs: z.object(denialProofsShape).strict(),
});

export const ctxlaneHealthObservationSchema = observationSchema("ctxlane", {
  reachable: z.boolean(),
  mutually_authenticated: z.boolean(),
  automation_lease_probe_passed: z.boolean(),
});

export const githubHealthObservationSchema = observationSchema("github", {
  credential_in_controller: z.boolean(),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  repository_reachable: z.boolean(),
  branch_push_allowed: z.boolean(),
  pull_request_create_allowed: z.boolean(),
  exact_head_observation_ready: z.boolean(),
  ci_context_read_ready: z.boolean(),
  reconciliation_ready: z.boolean(),
  merge_allowed: z.boolean(),
  administration_allowed: z.boolean(),
});

export const mcpHealthObservationSchema = observationSchema("mcp", {
  private_control_ready: z.boolean(),
  controller_authenticated: z.boolean(),
  exposed_to_workers: z.boolean(),
});

export const backlogHealthObservationSchema = observationSchema("backlog", {
  selection_enabled: z.boolean(),
  mutations_enabled: z.boolean(),
});

export const asfHealthObservationSchema = z.discriminatedUnion("kind", [
  serviceHealthObservationSchema,
  databaseHealthObservationSchema,
  workerHealthObservationSchema,
  sandboxHealthObservationSchema,
  ctxlaneHealthObservationSchema,
  githubHealthObservationSchema,
  mcpHealthObservationSchema,
  backlogHealthObservationSchema,
]);

export type ServiceHealthObservation = z.infer<typeof serviceHealthObservationSchema>;
export type DatabaseHealthObservation = z.infer<typeof databaseHealthObservationSchema>;
export type WorkerHealthObservation = z.infer<typeof workerHealthObservationSchema>;
export type SandboxHealthObservation = z.infer<typeof sandboxHealthObservationSchema>;
export type CtxlaneHealthObservation = z.infer<typeof ctxlaneHealthObservationSchema>;
export type GithubHealthObservation = z.infer<typeof githubHealthObservationSchema>;
export type McpHealthObservation = z.infer<typeof mcpHealthObservationSchema>;
export type BacklogHealthObservation = z.infer<typeof backlogHealthObservationSchema>;
export type AsfHealthObservation = z.infer<typeof asfHealthObservationSchema>;

const componentBaseShape = {
  status: componentStatusSchema,
  observed_at: timestampSchema.nullable(),
  age_ms: publicAgeSchema.nullable(),
  reasons: reasonListSchema,
} satisfies z.ZodRawShape;

const DEGRADED_REASON_CODES: ReadonlySet<AsfHealthReasonCode> = new Set([
  "service.recovering",
  "service.stopping",
  "service.not_accepting",
  "worker.capacity_full",
  "worker.queue_nonempty",
  "ctxlane.unreachable",
  "ctxlane.lease_unavailable",
  "github.unreachable",
  "github.unauthenticated",
  "github.capability_unavailable",
  "mcp.control_unavailable",
  "mcp.controller_unauthenticated",
]);

function componentSchema<Details extends z.ZodType>(details: Details) {
  return z
    .object({ ...componentBaseShape, details: details.nullable() })
    .strict()
    .superRefine((component, context) => {
      const expected =
        component.reasons.length === 0
          ? "ready"
          : component.reasons.every((reason) => DEGRADED_REASON_CODES.has(reason))
            ? "degraded"
            : "refusing";
      if (component.status !== expected) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "must agree with the component reason severity",
        });
      }
      if (Reflect.get(component, "details") === null && component.status !== "refusing") {
        context.addIssue({
          code: "custom",
          path: ["details"],
          message: "may be absent only for a refusing component",
        });
      }
    });
}

const serviceDetailsSchema = serviceHealthObservationSchema.shape.data;
const databaseDetailsSchema = databaseHealthObservationSchema.shape.data
  .extend({ expected_schema_version: schemaVersionSchema })
  .strict();
const workerDetailsSchema = workerHealthObservationSchema.shape.data
  .extend({
    expected_max_concurrency: z.number().int().min(1).max(32),
    heartbeat_age_ms: publicAgeSchema.nullable(),
    available_capacity: z.number().int().min(0).max(32),
  })
  .strict();

export const serviceHealthComponentSchema = componentSchema(serviceDetailsSchema);
export const databaseHealthComponentSchema = componentSchema(databaseDetailsSchema);
export const workerHealthComponentSchema = componentSchema(workerDetailsSchema);
export const sandboxHealthComponentSchema = componentSchema(
  sandboxHealthObservationSchema.shape.data,
);
export const ctxlaneHealthComponentSchema = componentSchema(
  ctxlaneHealthObservationSchema.shape.data,
);
export const githubHealthComponentSchema = componentSchema(
  githubHealthObservationSchema.shape.data,
);
export const mcpHealthComponentSchema = componentSchema(mcpHealthObservationSchema.shape.data);
export const backlogHealthComponentSchema = componentSchema(
  backlogHealthObservationSchema.shape.data,
);

export const asfHealthReportSchema = z
  .object({
    schema: z.literal(ASF_HEALTH_SCHEMA),
    mode: z.literal("asf-worker"),
    checked_at: timestampSchema,
    probe_duration_ms: publicAgeSchema,
    status: componentStatusSchema,
    ready: z.boolean(),
    components: z
      .object({
        service: serviceHealthComponentSchema,
        database: databaseHealthComponentSchema,
        worker: workerHealthComponentSchema,
        sandbox: sandboxHealthComponentSchema,
        ctxlane: ctxlaneHealthComponentSchema,
        github: githubHealthComponentSchema,
        mcp: mcpHealthComponentSchema,
        backlog: backlogHealthComponentSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const statuses = Object.values(report.components).map((component) => component.status);
    const expected = statuses.includes("refusing")
      ? "refusing"
      : statuses.includes("degraded")
        ? "degraded"
        : "ready";
    if (report.status !== expected) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "must equal the most severe component status",
      });
    }
    if (report.ready !== (report.status === "ready")) {
      context.addIssue({
        code: "custom",
        path: ["ready"],
        message: "must be true exactly when status is ready",
      });
    }
  });

export type AsfHealthReport = z.infer<typeof asfHealthReportSchema>;
export type AsfHealthStatus = AsfHealthReport["status"];
export type AsfHealthReasonCode = z.infer<typeof healthReasonSchema>;

export type AsfHealthProbe<T> = (signal: AbortSignal) => T | Promise<T>;

export interface AsfHealthProbes {
  readonly service: AsfHealthProbe<ServiceHealthObservation>;
  readonly database: AsfHealthProbe<DatabaseHealthObservation>;
  readonly worker: AsfHealthProbe<WorkerHealthObservation>;
  readonly sandbox: AsfHealthProbe<SandboxHealthObservation>;
  readonly ctxlane: AsfHealthProbe<CtxlaneHealthObservation>;
  readonly github: AsfHealthProbe<GithubHealthObservation>;
  readonly mcp: AsfHealthProbe<McpHealthObservation>;
  readonly backlog: AsfHealthProbe<BacklogHealthObservation>;
}

/** Injectable so tests and embedders can impose a deterministic probe deadline. */
export interface AsfHealthProbeExecutor {
  run<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export class AsfHealthProbeTimeoutError extends Error {
  constructor() {
    super("ASF health probe timed out");
    this.name = "AsfHealthProbeTimeoutError";
  }
}

const DEFAULT_PROBE_EXECUTOR: AsfHealthProbeExecutor = {
  run<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abortController = new AbortController();
      const timer = setTimeout(() => {
        const error = new AsfHealthProbeTimeoutError();
        abortController.abort(error);
        reject(error);
      }, timeoutMs);
      void Promise.resolve()
        .then(() => operation(abortController.signal))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("ASF health probe failed"));
          },
        );
    });
  },
};

export interface AsfHealthServiceOptions {
  /** Deliberate runtime guard: health is not constructible through standalone mode. */
  readonly mode: "asf-worker";
  readonly clock: Clock;
  readonly probes: AsfHealthProbes;
  readonly expectedSchemaVersion: number;
  readonly expectedMaxConcurrency: number;
  readonly sandboxMechanism: "bubblewrap" | "microvm";
  readonly maxObservationAgeMs: number;
  readonly workerHeartbeatMaxAgeMs: number;
  readonly probeTimeoutMs: number;
  readonly probeExecutor?: AsfHealthProbeExecutor | undefined;
}

type TimestampedObservation = {
  readonly observed_at: string;
};

type ProbeFailureReason =
  | "observation.missing"
  | "observation.invalid"
  | "probe.failed"
  | "probe.timeout";

type ProbeOutcome<T> =
  | { readonly ok: true; readonly observation: T }
  | { readonly ok: false; readonly reason: ProbeFailureReason };

interface Freshness<T> {
  readonly observation: T | null;
  readonly observedAt: string | null;
  readonly ageMs: number | null;
  readonly refusal: AsfHealthReasonCode | null;
}

function publicDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(2_147_483_647, Math.floor(value));
}

async function runProbe<T>(
  schema: z.ZodType<T>,
  probe: AsfHealthProbe<unknown> | undefined,
  timeoutMs: number,
  executor: AsfHealthProbeExecutor,
): Promise<ProbeOutcome<T>> {
  if (typeof probe !== "function") return { ok: false, reason: "observation.missing" };
  try {
    const raw = await executor.run(timeoutMs, async (signal) => probe(signal));
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, observation: parsed.data }
      : { ok: false, reason: "observation.invalid" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof AsfHealthProbeTimeoutError ? "probe.timeout" : "probe.failed",
    };
  }
}

function freshness<T extends TimestampedObservation>(
  outcome: ProbeOutcome<T>,
  nowMs: number,
  maxAgeMs: number,
): Freshness<T> {
  if (!outcome.ok) {
    return {
      observation: null,
      observedAt: null,
      ageMs: null,
      refusal: outcome.reason,
    };
  }
  const observedAtMs = Date.parse(outcome.observation.observed_at);
  const age = nowMs - observedAtMs;
  return {
    observation: outcome.observation,
    observedAt: outcome.observation.observed_at,
    ageMs: age < 0 ? null : publicDuration(age),
    refusal:
      age < 0 ? "observation.future" : age > maxAgeMs ? "observation.stale" : null,
  };
}

function baseComponent<T extends TimestampedObservation>(
  fresh: Freshness<T>,
  details: unknown,
): {
  readonly status: "refusing";
  readonly observed_at: string | null;
  readonly age_ms: number | null;
  readonly reasons: readonly AsfHealthReasonCode[];
  readonly details: unknown;
} | undefined {
  if (fresh.refusal === null) return undefined;
  return {
    status: "refusing",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons: [fresh.refusal],
    details,
  };
}

function evaluateService(
  outcome: ProbeOutcome<ServiceHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
): z.infer<typeof serviceHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return serviceHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh service observation is missing details");

  if (
    (!details.recovery_complete && details.state !== "recovering") ||
    (details.state !== "running" && details.accepting_submissions)
  ) {
    return serviceHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["service.contradictory"],
      details,
    });
  }
  const reasons: AsfHealthReasonCode[] = [];
  if (details.state === "recovering") reasons.push("service.recovering");
  if (details.state === "stopping") reasons.push("service.stopping");
  if (!details.accepting_submissions) reasons.push("service.not_accepting");
  return serviceHealthComponentSchema.parse({
    status: reasons.length === 0 ? "ready" : "degraded",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons,
    details,
  });
}

function evaluateDatabase(
  outcome: ProbeOutcome<DatabaseHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
  expectedSchemaVersion: number,
): z.infer<typeof databaseHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details =
    fresh.observation === null
      ? null
      : { ...fresh.observation.data, expected_schema_version: expectedSchemaVersion };
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return databaseHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh database observation is missing details");

  const unreachableContradiction =
    !details.reachable &&
    (details.schema_version !== null ||
      details.integrity_check_passed ||
      details.write_probe_passed);
  if (unreachableContradiction || (details.reachable && details.schema_version === null)) {
    return databaseHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["database.contradictory"],
      details,
    });
  }
  const reasons: AsfHealthReasonCode[] = [];
  if (!details.reachable) reasons.push("database.unreachable");
  if (details.schema_version !== expectedSchemaVersion) reasons.push("database.schema_mismatch");
  if (!details.integrity_check_passed) reasons.push("database.integrity_failed");
  if (!details.write_probe_passed) reasons.push("database.write_failed");
  return databaseHealthComponentSchema.parse({
    status: reasons.length === 0 ? "ready" : "refusing",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons,
    details,
  });
}

function evaluateWorker(
  outcome: ProbeOutcome<WorkerHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
  heartbeatMaxAgeMs: number,
  expectedMaxConcurrency: number,
): z.infer<typeof workerHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const observed = fresh.observation?.data ?? null;
  const heartbeatAge =
    observed === null ? null : nowMs - Date.parse(observed.heartbeat_at);
  const details =
    observed === null
      ? null
      : {
          ...observed,
          expected_max_concurrency: expectedMaxConcurrency,
          heartbeat_age_ms: heartbeatAge === null || heartbeatAge < 0 ? null : publicDuration(heartbeatAge),
          available_capacity: Math.max(0, observed.max_concurrency - observed.active_runs),
        };
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return workerHealthComponentSchema.parse(refused);
  if (observed === null || details === null || heartbeatAge === null) {
    throw new Error("fresh worker observation is missing details");
  }

  const refusing: AsfHealthReasonCode[] = [];
  if (heartbeatAge < 0) refusing.push("worker.heartbeat_future");
  else if (heartbeatAge > heartbeatMaxAgeMs) refusing.push("worker.heartbeat_stale");
  if (!observed.scheduler_running) refusing.push("worker.scheduler_stopped");
  if (!observed.fencing_store_ready) refusing.push("worker.fencing_unavailable");
  if (observed.max_concurrency !== expectedMaxConcurrency) {
    refusing.push("worker.concurrency_mismatch");
  }
  if (observed.active_runs > observed.max_concurrency) {
    refusing.push("worker.capacity_contradictory");
  }
  if (refusing.length > 0) {
    return workerHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: refusing,
      details,
    });
  }
  const degraded: AsfHealthReasonCode[] = [];
  if (observed.active_runs === observed.max_concurrency) {
    degraded.push("worker.capacity_full");
  }
  if (observed.queued_runs > 0) degraded.push("worker.queue_nonempty");
  return workerHealthComponentSchema.parse({
    status: degraded.length === 0 ? "ready" : "degraded",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons: degraded,
    details,
  });
}

function evaluateSandbox(
  outcome: ProbeOutcome<SandboxHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
  expectedMechanism: "bubblewrap" | "microvm",
): z.infer<typeof sandboxHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return sandboxHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh sandbox observation is missing details");

  const reasons: AsfHealthReasonCode[] = [];
  if (details.mechanism !== expectedMechanism) reasons.push("sandbox.mechanism_mismatch");
  if (!details.installed) reasons.push("sandbox.unavailable");
  if (!details.enforcement_self_test_passed) reasons.push("sandbox.enforcement_failed");
  if (details.enforcement_downgraded) reasons.push("sandbox.downgraded");
  if (!details.fresh_candidate_verification) reasons.push("sandbox.verification_unavailable");
  if (!details.tool_network_policy_enforced || !details.verification_network_disabled) {
    reasons.push("sandbox.network_unenforced");
  }
  if (Object.values(details.denial_proofs).some((denied) => !denied)) {
    reasons.push("sandbox.denial_proof_failed");
  }
  return sandboxHealthComponentSchema.parse({
    status: reasons.length === 0 ? "ready" : "refusing",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons,
    details,
  });
}

function evaluateCtxlane(
  outcome: ProbeOutcome<CtxlaneHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
): z.infer<typeof ctxlaneHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return ctxlaneHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh ctxlane observation is missing details");

  if (
    (!details.reachable &&
      (details.mutually_authenticated || details.automation_lease_probe_passed)) ||
    (details.automation_lease_probe_passed && !details.mutually_authenticated)
  ) {
    return ctxlaneHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["ctxlane.contradictory"],
      details,
    });
  }
  if (details.reachable && !details.mutually_authenticated) {
    return ctxlaneHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["ctxlane.unauthenticated"],
      details,
    });
  }
  const reasons: AsfHealthReasonCode[] = [];
  if (!details.reachable) reasons.push("ctxlane.unreachable");
  if (details.mutually_authenticated && !details.automation_lease_probe_passed) {
    reasons.push("ctxlane.lease_unavailable");
  }
  return ctxlaneHealthComponentSchema.parse({
    status: reasons.length === 0 ? "ready" : "degraded",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons,
    details,
  });
}

function evaluateGithub(
  outcome: ProbeOutcome<GithubHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
): z.infer<typeof githubHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return githubHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh GitHub observation is missing details");

  const operational = [
    details.authenticated,
    details.repository_reachable,
    details.branch_push_allowed,
    details.pull_request_create_allowed,
    details.exact_head_observation_ready,
    details.ci_context_read_ready,
    details.reconciliation_ready,
  ];
  const capabilityWithoutRepository =
    !details.repository_reachable && operational.slice(2).some(Boolean);
  if (
    (!details.reachable && operational.some(Boolean)) ||
    (!details.authenticated && operational.slice(1).some(Boolean)) ||
    capabilityWithoutRepository
  ) {
    return githubHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["github.contradictory"],
      details,
    });
  }
  const refusing: AsfHealthReasonCode[] = [];
  if (!details.credential_in_controller) refusing.push("github.credential_boundary_failed");
  if (details.merge_allowed || details.administration_allowed) {
    refusing.push("github.excess_authority");
  }
  if (refusing.length > 0) {
    return githubHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: refusing,
      details,
    });
  }
  const degraded: AsfHealthReasonCode[] = [];
  if (!details.reachable) degraded.push("github.unreachable");
  else if (!details.authenticated) degraded.push("github.unauthenticated");
  else if (
    !details.repository_reachable ||
    !details.branch_push_allowed ||
    !details.pull_request_create_allowed ||
    !details.exact_head_observation_ready ||
    !details.ci_context_read_ready ||
    !details.reconciliation_ready
  ) {
    degraded.push("github.capability_unavailable");
  }
  return githubHealthComponentSchema.parse({
    status: degraded.length === 0 ? "ready" : "degraded",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons: degraded,
    details,
  });
}

function evaluateMcp(
  outcome: ProbeOutcome<McpHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
): z.infer<typeof mcpHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return mcpHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh MCP observation is missing details");

  if (details.private_control_ready && !details.controller_authenticated) {
    return mcpHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["mcp.contradictory"],
      details,
    });
  }
  if (details.exposed_to_workers) {
    return mcpHealthComponentSchema.parse({
      status: "refusing",
      observed_at: fresh.observedAt,
      age_ms: fresh.ageMs,
      reasons: ["mcp.exposed_to_worker"],
      details,
    });
  }
  const degraded: AsfHealthReasonCode[] = [];
  if (!details.private_control_ready) degraded.push("mcp.control_unavailable");
  if (!details.controller_authenticated) degraded.push("mcp.controller_unauthenticated");
  return mcpHealthComponentSchema.parse({
    status: degraded.length === 0 ? "ready" : "degraded",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons: degraded,
    details,
  });
}

function evaluateBacklog(
  outcome: ProbeOutcome<BacklogHealthObservation>,
  nowMs: number,
  maxAgeMs: number,
): z.infer<typeof backlogHealthComponentSchema> {
  const fresh = freshness(outcome, nowMs, maxAgeMs);
  const details = fresh.observation?.data ?? null;
  const refused = baseComponent(fresh, details);
  if (refused !== undefined) return backlogHealthComponentSchema.parse(refused);
  if (details === null) throw new Error("fresh backlog observation is missing details");

  const reasons: AsfHealthReasonCode[] = [];
  if (details.selection_enabled) reasons.push("backlog.selection_enabled");
  if (details.mutations_enabled) reasons.push("backlog.mutations_enabled");
  return backlogHealthComponentSchema.parse({
    status: reasons.length === 0 ? "ready" : "refusing",
    observed_at: fresh.observedAt,
    age_ms: fresh.ageMs,
    reasons,
    details,
  });
}

/**
 * ASF-only health aggregator. Construction does not execute a probe, and this
 * module is intentionally not imported by standalone startup paths.
 */
export class AsfHealthService {
  readonly #clock: Clock;
  readonly #probes: AsfHealthProbes;
  readonly #expectedSchemaVersion: number;
  readonly #expectedMaxConcurrency: number;
  readonly #sandboxMechanism: "bubblewrap" | "microvm";
  readonly #maxObservationAgeMs: number;
  readonly #workerHeartbeatMaxAgeMs: number;
  readonly #probeTimeoutMs: number;
  readonly #probeExecutor: AsfHealthProbeExecutor;

  constructor(options: AsfHealthServiceOptions) {
    if (options.mode !== "asf-worker") {
      throw new Error("ASF health can only be constructed in explicit asf-worker mode");
    }
    for (const [label, value, minimum, maximum] of [
      ["expected schema version", options.expectedSchemaVersion, 1, 1_000_000],
      ["expected worker concurrency", options.expectedMaxConcurrency, 1, 32],
      ["maximum observation age", options.maxObservationAgeMs, 1_000, 300_000],
      ["worker heartbeat maximum age", options.workerHeartbeatMaxAgeMs, 3_000, 900_000],
      ["probe timeout", options.probeTimeoutMs, 1, 30_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
      }
    }
    this.#clock = options.clock;
    this.#probes = options.probes;
    this.#expectedSchemaVersion = options.expectedSchemaVersion;
    this.#expectedMaxConcurrency = options.expectedMaxConcurrency;
    this.#sandboxMechanism = options.sandboxMechanism;
    this.#maxObservationAgeMs = options.maxObservationAgeMs;
    this.#workerHeartbeatMaxAgeMs = options.workerHeartbeatMaxAgeMs;
    this.#probeTimeoutMs = options.probeTimeoutMs;
    this.#probeExecutor = options.probeExecutor ?? DEFAULT_PROBE_EXECUTOR;
  }

  async getHealth(): Promise<AsfHealthReport> {
    const startedAt = this.#clock.monotonicMs();
    const runtimeProbes = this.#probes as Partial<AsfHealthProbes>;
    const [service, database, worker, sandbox, ctxlane, github, mcp, backlog] =
      await Promise.all([
        runProbe(
          serviceHealthObservationSchema,
          runtimeProbes.service,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          databaseHealthObservationSchema,
          runtimeProbes.database,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          workerHealthObservationSchema,
          runtimeProbes.worker,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          sandboxHealthObservationSchema,
          runtimeProbes.sandbox,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          ctxlaneHealthObservationSchema,
          runtimeProbes.ctxlane,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          githubHealthObservationSchema,
          runtimeProbes.github,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          mcpHealthObservationSchema,
          runtimeProbes.mcp,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
        runProbe(
          backlogHealthObservationSchema,
          runtimeProbes.backlog,
          this.#probeTimeoutMs,
          this.#probeExecutor,
        ),
      ]);
    const checkedAt = this.#clock.now();
    const nowMs = checkedAt.getTime();
    const components = {
      service: evaluateService(service, nowMs, this.#maxObservationAgeMs),
      database: evaluateDatabase(
        database,
        nowMs,
        this.#maxObservationAgeMs,
        this.#expectedSchemaVersion,
      ),
      worker: evaluateWorker(
        worker,
        nowMs,
        this.#maxObservationAgeMs,
        this.#workerHeartbeatMaxAgeMs,
        this.#expectedMaxConcurrency,
      ),
      sandbox: evaluateSandbox(
        sandbox,
        nowMs,
        this.#maxObservationAgeMs,
        this.#sandboxMechanism,
      ),
      ctxlane: evaluateCtxlane(ctxlane, nowMs, this.#maxObservationAgeMs),
      github: evaluateGithub(github, nowMs, this.#maxObservationAgeMs),
      mcp: evaluateMcp(mcp, nowMs, this.#maxObservationAgeMs),
      backlog: evaluateBacklog(backlog, nowMs, this.#maxObservationAgeMs),
    };
    const statuses = Object.values(components).map((component) => component.status);
    const status: AsfHealthStatus = statuses.includes("refusing")
      ? "refusing"
      : statuses.includes("degraded")
        ? "degraded"
        : "ready";
    return asfHealthReportSchema.parse({
      schema: ASF_HEALTH_SCHEMA,
      mode: "asf-worker",
      checked_at: checkedAt.toISOString(),
      probe_duration_ms: publicDuration(this.#clock.monotonicMs() - startedAt),
      status,
      ready: status === "ready",
      components,
    });
  }
}
