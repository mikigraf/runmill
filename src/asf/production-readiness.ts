import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { Clock } from "../platform/clock.js";

export const PRODUCTION_MODE_CONFIG_SCHEMA = "runmill.production-mode/v1" as const;
export const ASF_READINESS_OBSERVATION_SCHEMA =
  "asf.production-readiness-observation/v1" as const;
export const ASF_PRODUCTION_READINESS_REPORT_SCHEMA =
  "asf.production-readiness-report/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

function sortedUniqueIdentifiers(minimum = 0) {
  return z.array(identifierSchema).min(minimum).superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          message: "must contain unique identifiers in lexical order",
        });
        return;
      }
    }
  });
}

function isPrivateUnixEndpoint(value: string): boolean {
  return (
    value.startsWith("unix:///") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("@")
  );
}

function isCtxlaneUnixEndpoint(value: string): boolean {
  if (!isPrivateUnixEndpoint(value)) return false;
  let socketPath: string;
  try {
    socketPath = decodeURIComponent(value.slice("unix://".length));
  } catch {
    return false;
  }
  // Keep this boundary compatible with CtxlaneUnixAutomationClient: readiness
  // must not approve an endpoint that the production identity client refuses.
  return (
    isAbsolute(socketPath) &&
    socketPath.length <= 4_096 &&
    socketPath === normalize(socketPath) &&
    !/[\u0000-\u001f\u007f?#@]/u.test(socketPath)
  );
}

const privateUnixEndpointSchema = z
  .string()
  .refine(isPrivateUnixEndpoint, "must be an absolute private unix endpoint");
const ctxlaneUnixEndpointSchema = z
  .string()
  .refine(
    isCtxlaneUnixEndpoint,
    "must be a normalized absolute unix endpoint compatible with ctxlane",
  );

const resourceLimitsSchema = z
  .object({
    cpu_millis: z.number().int().min(100).max(64_000),
    memory_mib: z.number().int().min(128).max(262_144),
    processes: z.number().int().min(1).max(4_096),
    file_size_mib: z.number().int().min(1).max(1_048_576),
    wall_time_ms: z.number().int().min(1_000).max(86_400_000),
  })
  .strict();

const signerPolicySchema = z
  .object({
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
  })
  .strict();

const standaloneConfigSchema = z
  .object({
    schema: z.literal(PRODUCTION_MODE_CONFIG_SCHEMA),
    mode: z.literal("standalone"),
  })
  .strict();

const developmentConfigSchema = z
  .object({
    schema: z.literal(PRODUCTION_MODE_CONFIG_SCHEMA),
    mode: z.literal("development"),
    development: z
      .object({
        provider_backend: z.enum([
          "direct-cli",
          "copied-provider-home",
          "host-credential-harness",
          "fake",
        ]),
        remotes: z.enum(["local-only", "fake-only"]),
        sandbox: z.enum(["bubblewrap", "best-effort", "none"]),
      })
      .strict(),
  })
  .strict();

const asfWorkerConfigSchema = z
  .object({
    schema: z.literal(PRODUCTION_MODE_CONFIG_SCHEMA),
    mode: z.literal("asf-worker"),
    asf: z
      .object({
        hosting: z.literal("single-tenant"),
        backlog: z
          .object({
            selection_enabled: z.literal(false),
            mutations_enabled: z.literal(false),
          })
          .strict(),
        trust: z
          .object({
            work_order_signers: z.array(signerPolicySchema).min(1),
            approval_signers: z.array(signerPolicySchema).min(1),
          })
          .strict(),
        ctxlane: z
          .object({
            endpoint: ctxlaneUnixEndpointSchema,
            audience: identifierSchema,
            lease_renewal_ms: z.number().int().min(1_000).max(300_000),
          })
          .strict(),
        harness: z
          .object({
            backend: z.literal("host-credential-harness"),
            credential_boundary: z.literal("trusted-host-only"),
            repository_tools: z.literal("runmill-sandbox-gateway"),
            implementer_sessions: z.literal("secure-resumable"),
            reviewer_sessions: z.literal("fresh-non-resumable"),
          })
          .strict(),
        sandbox: z
          .object({
            mechanism: z.literal("bubblewrap"),
            base_image: z.literal("read-only"),
            workspace: z.literal("ephemeral"),
            resource_limits_required: z.literal(true),
            resource_limits: resourceLimitsSchema,
            verification_environment: z.literal("fresh-candidate"),
            tools_network: z.object({ mode: z.literal("disabled") }).strict(),
            verification_network: z.literal("disabled"),
          })
          .strict(),
        mcp: z
          .object({
            transport: z.literal("stdio-private-control"),
            service_control_endpoint: privateUnixEndpointSchema,
            trusted_controller_ids: sortedUniqueIdentifiers(1),
            expose_to_workers: z.literal(false),
          })
          .strict(),
        worker: z
          .object({
            worker_id: identifierSchema,
            heartbeat_interval_ms: z.number().int().min(1_000).max(60_000),
            stale_after_ms: z.number().int().min(3_000).max(900_000),
            max_concurrency: z.number().int().min(1).max(32),
            readiness_max_age_ms: z.number().int().min(1_000).max(300_000),
          })
          .strict(),
        retention: z
          .object({
            run_state_days: z.number().int().min(7).max(3_650),
            portable_artifact_days: z.number().int().min(7).max(3_650),
            protected_artifact_days: z.number().int().min(1).max(365),
          })
          .strict(),
        github: z
          .object({
            closure_target: z.literal("pr"),
            credential_boundary: z.literal("trusted-controller-only"),
            contents_permission: z.literal("write"),
            pull_requests_permission: z.literal("write"),
            checks_permission: z.literal("read"),
            merge_permission: z.literal("none"),
            administration_permission: z.literal("none"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.asf.worker.stale_after_ms < config.asf.worker.heartbeat_interval_ms * 3) {
      context.addIssue({
        code: "custom",
        path: ["asf", "worker", "stale_after_ms"],
        message: "must be at least three heartbeat intervals",
      });
    }
    for (const [label, signers] of [
      ["work_order_signers", config.asf.trust.work_order_signers],
      ["approval_signers", config.asf.trust.approval_signers],
    ] as const) {
      const ids = signers.map((signer) => signer.key_id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          path: ["asf", "trust", label],
          message: "must not contain duplicate key ids",
        });
      }
    }
  });

export const productionModeConfigSchema = z.union([
  standaloneConfigSchema,
  developmentConfigSchema,
  asfWorkerConfigSchema,
]);

export type ProductionModeConfig = z.infer<typeof productionModeConfigSchema>;
export type AsfWorkerProductionConfig = z.infer<typeof asfWorkerConfigSchema>;

const observedSignerSchema = z
  .object({
    key_id: identifierSchema,
    key_type: z.enum(["Ed25519", "unsupported"]),
    trusted: z.boolean(),
    currently_valid: z.boolean(),
    revoked: z.boolean(),
  })
  .strict();

export const asfReadinessObservationSchema = z
  .object({
    schema: z.literal(ASF_READINESS_OBSERVATION_SCHEMA),
    observed_at: z.iso.datetime({ offset: true }),
    platform: z.enum(["linux", "darwin", "win32", "other"]),
    hosting: z.enum(["single-tenant", "multi-tenant"]),
    backlog: z
      .object({
        selection_enabled: z.boolean(),
        mutations_enabled: z.boolean(),
      })
      .strict(),
    trust: z
      .object({
        work_order_signers: z.array(observedSignerSchema),
        approval_signers: z.array(observedSignerSchema),
      })
      .strict(),
    ctxlane: z
      .object({
        endpoint: ctxlaneUnixEndpointSchema,
        reachable: z.boolean(),
        mutually_authenticated: z.boolean(),
        automation_lease_probe_passed: z.boolean(),
      })
      .strict(),
    harness: z
      .object({
        backend: z.enum([
          "host-credential-harness",
          "direct-cli",
          "copied-provider-home",
        ]),
        ready: z.boolean(),
        credential_held_host_side: z.boolean(),
        repository_tool_environments_credential_free: z.boolean(),
        repository_tools_delegated: z.boolean(),
        deterministic_cancellation: z.boolean(),
        timeout_and_usage_reporting: z.boolean(),
        secure_implementer_resume: z.boolean(),
        fresh_reviewers: z.boolean(),
      })
      .strict(),
    sandbox: z
      .object({
        mechanism: z.enum(["bubblewrap", "microvm", "seatbelt", "none"]),
        installed: z.boolean(),
        enforcement_self_test_passed: z.boolean(),
        enforcement_downgraded: z.boolean(),
        read_only_base: z.boolean(),
        ephemeral_workspace: z.boolean(),
        resource_limits_enforced: z.boolean(),
        resource_limits: resourceLimitsSchema,
        fresh_candidate_verification: z.boolean(),
      })
      .strict(),
    network: z
      .object({
        tools_mode: z.enum(["disabled", "enforced-broker", "unrestricted-proxy"]),
        verification_network_disabled: z.boolean(),
        broker: z
          .object({
            hostname_enforced: z.boolean(),
            ip_enforced: z.boolean(),
            tls_enforced: z.boolean(),
            dns_rebinding_protected: z.boolean(),
            decisions_audited: z.boolean(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    denial_proofs: z
      .object({
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
      })
      .strict(),
    mcp: z
      .object({
        service_control_endpoint: privateUnixEndpointSchema,
        controller_id: identifierSchema,
        controller_authenticated: z.boolean(),
        private_control_ready: z.boolean(),
        exposed_to_workers: z.boolean(),
      })
      .strict(),
    worker: z
      .object({
        worker_id: identifierSchema,
        heartbeat_scheduler_ready: z.boolean(),
        fencing_store_ready: z.boolean(),
        max_concurrency: z.number().int().nonnegative(),
      })
      .strict(),
    retention: z
      .object({
        policy_enforceable: z.boolean(),
        cleanup_ready: z.boolean(),
        run_state_days: z.number().int().nonnegative(),
        portable_artifact_days: z.number().int().nonnegative(),
        protected_artifact_days: z.number().int().nonnegative(),
      })
      .strict(),
    github: z
      .object({
        credential_in_controller: z.boolean(),
        authenticated: z.boolean(),
        repository_reachable: z.boolean(),
        branch_push_allowed: z.boolean(),
        pull_request_create_allowed: z.boolean(),
        exact_head_observation_ready: z.boolean(),
        ci_context_read_ready: z.boolean(),
        reconciliation_ready: z.boolean(),
        merge_allowed: z.boolean(),
        administration_allowed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AsfReadinessObservation = z.infer<typeof asfReadinessObservationSchema>;

export interface ProductionReadinessCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly observed: string;
}

const ASF_PRODUCTION_READINESS_CHECK_PREFIX_V1 = [
  "observation.fresh",
  "platform.linux",
  "hosting.single-tenant",
  "backlog.selection-disabled",
  "backlog.mutations-disabled",
  "trust.work-orders",
  "trust.approvals",
  "ctxlane.endpoint",
  "ctxlane.reachable",
  "ctxlane.mutual-auth",
  "ctxlane.lease-probe",
  "harness.backend",
  "harness.ready",
  "harness.credential-host-only",
  "harness.tool-environment-credential-free",
  "harness.tools-delegated",
  "harness.cancellation",
  "harness.usage",
  "harness.resume",
  "harness.fresh-reviewers",
  "sandbox.limit.cpu_millis",
  "sandbox.limit.memory_mib",
  "sandbox.limit.processes",
  "sandbox.limit.file_size_mib",
  "sandbox.limit.wall_time_ms",
  "sandbox.mechanism",
  "sandbox.installed",
  "sandbox.self-test",
  "sandbox.read-only-base",
  "sandbox.ephemeral-workspace",
  "sandbox.resource-limits",
  "sandbox.fresh-verification",
  "sandbox.no-downgrade",
  "network.tools-mode",
  "network.verification-disabled",
] as const;

const ASF_PRODUCTION_READINESS_CHECK_SUFFIX_V1 = [
  "denial.provider_credentials",
  "denial.ctxlane_socket",
  "denial.github_credentials",
  "denial.asf_credentials",
  "denial.backlog_credentials",
  "denial.host_ssh_agent",
  "denial.cloud_metadata",
  "denial.other_workspaces",
  "denial.docker_socket",
  "denial.mcp_control_endpoint",
  "mcp.endpoint",
  "mcp.controller",
  "mcp.authenticated",
  "mcp.private-control",
  "mcp.not-exposed-to-workers",
  "worker.identity",
  "worker.heartbeat",
  "worker.fencing",
  "worker.concurrency",
  "retention.run-state",
  "retention.portable-artifacts",
  "retention.protected-artifacts",
  "retention.enforceable",
  "retention.cleanup",
  "github.credential-controller-only",
  "github.authenticated",
  "github.repository",
  "github.push",
  "github.pr-create",
  "github.head-observation",
  "github.ci-read",
  "github.reconciliation",
  "github.no-merge",
  "github.no-administration",
] as const;

/** Exact check order emitted by the v1 evaluator for network-disabled deployments. */
export const ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED: readonly string[] =
  Object.freeze([
    ...ASF_PRODUCTION_READINESS_CHECK_PREFIX_V1,
    "network.no-proxy",
    ...ASF_PRODUCTION_READINESS_CHECK_SUFFIX_V1,
  ]);

/**
 * A ready report is accepted only if it is the complete, ordered output of a
 * known evaluator version. This prevents an arbitrary passing check (or a
 * renamed/omitted proof) from becoming production authority at the host seam.
 */
export function hasCanonicalAsfProductionReadinessChecks(
  checks: readonly ProductionReadinessCheck[],
): boolean {
  const ids = checks.map((candidate) => candidate.id);
  return (
    ids.length === ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED.length &&
    ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED.every(
      (id, index) => ids[index] === id,
    )
  );
}

export interface ProductionReadinessReport {
  readonly schema: typeof ASF_PRODUCTION_READINESS_REPORT_SCHEMA;
  readonly mode: ProductionModeConfig["mode"];
  readonly decision: "ready" | "development-only" | "refuse";
  readonly readyToStart: boolean;
  readonly asfProductionReady: boolean;
  readonly checks: readonly ProductionReadinessCheck[];
}

export class ProductionModeConfigError extends Error {
  constructor(detail: string) {
    super(`Production mode configuration is invalid: ${detail}`);
    this.name = "ProductionModeConfigError";
  }
}

export class ProductionStartupRefusedError extends Error {
  readonly report: ProductionReadinessReport;

  constructor(report: ProductionReadinessReport) {
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.id);
    super(`Startup refused for ${report.mode}: ${failed.join(", ") || "mode is not startable"}`);
    this.name = "ProductionStartupRefusedError";
    this.report = report;
  }
}

/** Missing ASF-specific operator policy means standalone, never ASF. */
export function parseProductionModeConfig(raw?: unknown): ProductionModeConfig {
  if (raw === undefined) {
    return { schema: PRODUCTION_MODE_CONFIG_SCHEMA, mode: "standalone" };
  }
  const parsed = productionModeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ProductionModeConfigError(detail);
  }
  return parsed.data;
}

function check(
  checks: ProductionReadinessCheck[],
  id: string,
  passed: boolean,
  expected: string | number,
  observed: string | boolean | number,
): void {
  checks.push({ id, passed, expected: String(expected), observed: String(observed) });
}

function signerSetReady(
  configured: readonly { readonly key_id: string }[],
  observed: readonly z.infer<typeof observedSignerSchema>[],
): boolean {
  const configuredIds = new Set(configured.map((signer) => signer.key_id));
  const observedIds = new Set(observed.map((signer) => signer.key_id));
  return (
    configuredIds.size === observedIds.size &&
    observedIds.size === observed.length &&
    [...configuredIds].every((keyId) => observedIds.has(keyId)) &&
    observed.every(
      (signer) =>
        signer.key_type === "Ed25519" &&
        signer.trusted &&
        signer.currently_valid &&
        !signer.revoked,
    )
  );
}

function evaluateAsfWorker(
  config: AsfWorkerProductionConfig,
  rawObservation: unknown,
  clock: Clock | undefined,
): ProductionReadinessReport {
  const checks: ProductionReadinessCheck[] = [];
  const parsed = asfReadinessObservationSchema.safeParse(rawObservation);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => issue.path.join(".") || "<root>")
      .join(", ");
    check(checks, "observation.schema", false, ASF_READINESS_OBSERVATION_SCHEMA, paths);
    return {
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "asf-worker",
      decision: "refuse",
      readyToStart: false,
      asfProductionReady: false,
      checks,
    };
  }
  const observation = parsed.data;
  if (clock === undefined) {
    check(checks, "observation.clock", false, "an injected trusted clock", "missing");
  } else {
    const observedAt = Date.parse(observation.observed_at);
    const age = clock.now().getTime() - observedAt;
    check(
      checks,
      "observation.fresh",
      age >= 0 && age <= config.asf.worker.readiness_max_age_ms,
      `age from 0 through ${config.asf.worker.readiness_max_age_ms}ms`,
      `${age}ms`,
    );
  }

  check(checks, "platform.linux", observation.platform === "linux", "linux", observation.platform);
  check(
    checks,
    "hosting.single-tenant",
    observation.hosting === "single-tenant",
    "single-tenant",
    observation.hosting,
  );
  check(
    checks,
    "backlog.selection-disabled",
    !observation.backlog.selection_enabled,
    "false",
    observation.backlog.selection_enabled,
  );
  check(
    checks,
    "backlog.mutations-disabled",
    !observation.backlog.mutations_enabled,
    "false",
    observation.backlog.mutations_enabled,
  );

  check(
    checks,
    "trust.work-orders",
    signerSetReady(config.asf.trust.work_order_signers, observation.trust.work_order_signers),
    "exact configured trusted, valid, non-revoked Ed25519 signer set",
    observation.trust.work_order_signers.length,
  );
  check(
    checks,
    "trust.approvals",
    signerSetReady(config.asf.trust.approval_signers, observation.trust.approval_signers),
    "exact configured trusted, valid, non-revoked Ed25519 signer set",
    observation.trust.approval_signers.length,
  );

  check(
    checks,
    "ctxlane.endpoint",
    observation.ctxlane.endpoint === config.asf.ctxlane.endpoint,
    config.asf.ctxlane.endpoint,
    observation.ctxlane.endpoint,
  );
  check(checks, "ctxlane.reachable", observation.ctxlane.reachable, "true", observation.ctxlane.reachable);
  check(
    checks,
    "ctxlane.mutual-auth",
    observation.ctxlane.mutually_authenticated,
    "true",
    observation.ctxlane.mutually_authenticated,
  );
  check(
    checks,
    "ctxlane.lease-probe",
    observation.ctxlane.automation_lease_probe_passed,
    "true",
    observation.ctxlane.automation_lease_probe_passed,
  );

  check(
    checks,
    "harness.backend",
    observation.harness.backend === "host-credential-harness",
    "host-credential-harness",
    observation.harness.backend,
  );
  for (const [id, value] of [
    ["harness.ready", observation.harness.ready],
    ["harness.credential-host-only", observation.harness.credential_held_host_side],
    [
      "harness.tool-environment-credential-free",
      observation.harness.repository_tool_environments_credential_free,
    ],
    ["harness.tools-delegated", observation.harness.repository_tools_delegated],
    ["harness.cancellation", observation.harness.deterministic_cancellation],
    ["harness.usage", observation.harness.timeout_and_usage_reporting],
    ["harness.resume", observation.harness.secure_implementer_resume],
    ["harness.fresh-reviewers", observation.harness.fresh_reviewers],
  ] as const) {
    check(checks, id, value, "true", value);
  }
  for (const [field, expected] of Object.entries(config.asf.sandbox.resource_limits)) {
    const actual = observation.sandbox.resource_limits[
      field as keyof typeof observation.sandbox.resource_limits
    ];
    check(checks, `sandbox.limit.${field}`, actual === expected, expected, actual);
  }

  check(
    checks,
    "sandbox.mechanism",
    observation.sandbox.mechanism === "bubblewrap",
    "bubblewrap",
    observation.sandbox.mechanism,
  );
  for (const [id, value] of [
    ["sandbox.installed", observation.sandbox.installed],
    ["sandbox.self-test", observation.sandbox.enforcement_self_test_passed],
    ["sandbox.read-only-base", observation.sandbox.read_only_base],
    ["sandbox.ephemeral-workspace", observation.sandbox.ephemeral_workspace],
    ["sandbox.resource-limits", observation.sandbox.resource_limits_enforced],
    ["sandbox.fresh-verification", observation.sandbox.fresh_candidate_verification],
  ] as const) {
    check(checks, id, value, "true", value);
  }
  check(
    checks,
    "sandbox.no-downgrade",
    !observation.sandbox.enforcement_downgraded,
    "false",
    observation.sandbox.enforcement_downgraded,
  );

  check(
    checks,
    "network.tools-mode",
    observation.network.tools_mode === "disabled",
    "disabled",
    observation.network.tools_mode,
  );
  check(
    checks,
    "network.verification-disabled",
    observation.network.verification_network_disabled,
    "true",
    observation.network.verification_network_disabled,
  );
  check(
    checks,
    "network.no-proxy",
    observation.network.broker === null,
    "no tool-network proxy",
    observation.network.broker === null,
  );

  for (const [field, denied] of Object.entries(observation.denial_proofs)) {
    check(checks, `denial.${field}`, denied, "access denied", denied);
  }

  check(
    checks,
    "mcp.endpoint",
    observation.mcp.service_control_endpoint === config.asf.mcp.service_control_endpoint,
    config.asf.mcp.service_control_endpoint,
    observation.mcp.service_control_endpoint,
  );
  check(
    checks,
    "mcp.controller",
    config.asf.mcp.trusted_controller_ids.includes(observation.mcp.controller_id),
    "configured trusted controller",
    observation.mcp.controller_id,
  );
  check(
    checks,
    "mcp.authenticated",
    observation.mcp.controller_authenticated,
    "true",
    observation.mcp.controller_authenticated,
  );
  check(
    checks,
    "mcp.private-control",
    observation.mcp.private_control_ready,
    "true",
    observation.mcp.private_control_ready,
  );
  check(
    checks,
    "mcp.not-exposed-to-workers",
    !observation.mcp.exposed_to_workers,
    "false",
    observation.mcp.exposed_to_workers,
  );

  check(
    checks,
    "worker.identity",
    observation.worker.worker_id === config.asf.worker.worker_id,
    config.asf.worker.worker_id,
    observation.worker.worker_id,
  );
  check(
    checks,
    "worker.heartbeat",
    observation.worker.heartbeat_scheduler_ready,
    "true",
    observation.worker.heartbeat_scheduler_ready,
  );
  check(
    checks,
    "worker.fencing",
    observation.worker.fencing_store_ready,
    "true",
    observation.worker.fencing_store_ready,
  );
  check(
    checks,
    "worker.concurrency",
    observation.worker.max_concurrency === config.asf.worker.max_concurrency,
    config.asf.worker.max_concurrency,
    observation.worker.max_concurrency,
  );

  for (const [id, actual, expected] of [
    ["retention.run-state", observation.retention.run_state_days, config.asf.retention.run_state_days],
    [
      "retention.portable-artifacts",
      observation.retention.portable_artifact_days,
      config.asf.retention.portable_artifact_days,
    ],
    [
      "retention.protected-artifacts",
      observation.retention.protected_artifact_days,
      config.asf.retention.protected_artifact_days,
    ],
  ] as const) {
    check(checks, id, actual === expected, expected, actual);
  }
  check(
    checks,
    "retention.enforceable",
    observation.retention.policy_enforceable,
    "true",
    observation.retention.policy_enforceable,
  );
  check(
    checks,
    "retention.cleanup",
    observation.retention.cleanup_ready,
    "true",
    observation.retention.cleanup_ready,
  );

  for (const [id, value] of [
    ["github.credential-controller-only", observation.github.credential_in_controller],
    ["github.authenticated", observation.github.authenticated],
    ["github.repository", observation.github.repository_reachable],
    ["github.push", observation.github.branch_push_allowed],
    ["github.pr-create", observation.github.pull_request_create_allowed],
    ["github.head-observation", observation.github.exact_head_observation_ready],
    ["github.ci-read", observation.github.ci_context_read_ready],
    ["github.reconciliation", observation.github.reconciliation_ready],
  ] as const) {
    check(checks, id, value, "true", value);
  }
  check(
    checks,
    "github.no-merge",
    !observation.github.merge_allowed,
    "false",
    observation.github.merge_allowed,
  );
  check(
    checks,
    "github.no-administration",
    !observation.github.administration_allowed,
    "false",
    observation.github.administration_allowed,
  );

  const ready = checks.every((candidate) => candidate.passed);
  return {
    schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
    mode: "asf-worker",
    decision: ready ? "ready" : "refuse",
    readyToStart: ready,
    asfProductionReady: ready,
    checks,
  };
}

/** Fail-closed startup evaluation. No environmental inference can select ASF. */
export function evaluateProductionReadiness(
  inputConfig: ProductionModeConfig,
  observation?: unknown,
  clock?: Clock,
): ProductionReadinessReport {
  const config = parseProductionModeConfig(inputConfig);
  if (config.mode === "standalone") {
    return {
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "standalone",
      decision: "ready",
      readyToStart: true,
      asfProductionReady: false,
      checks: [],
    };
  }
  if (config.mode === "development") {
    return {
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "development",
      decision: "development-only",
      readyToStart: true,
      asfProductionReady: false,
      checks: [
        {
          id: "mode.non-production",
          passed: true,
          expected: "development-only execution with fakes or local remotes",
          observed: config.development.provider_backend,
        },
      ],
    };
  }
  return evaluateAsfWorker(config, observation, clock);
}

/** Startup integration seam: call after live probes and before binding service/MCP listeners. */
export function requireProductionReadiness(
  config: ProductionModeConfig,
  observation?: unknown,
  clock?: Clock,
): ProductionReadinessReport {
  const report = evaluateProductionReadiness(config, observation, clock);
  if (!report.readyToStart) throw new ProductionStartupRefusedError(report);
  return report;
}
