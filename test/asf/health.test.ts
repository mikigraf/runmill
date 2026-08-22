import { describe, expect, it } from "vitest";
import {
  ASF_HEALTH_OBSERVATION_SCHEMA,
  ASF_HEALTH_SCHEMA,
  AsfHealthProbeTimeoutError,
  AsfHealthService,
  asfHealthReportSchema,
  type AsfHealthProbeExecutor,
  type AsfHealthProbes,
  type BacklogHealthObservation,
  type CtxlaneHealthObservation,
  type DatabaseHealthObservation,
  type GithubHealthObservation,
  type McpHealthObservation,
  type SandboxHealthObservation,
  type ServiceHealthObservation,
  type WorkerHealthObservation,
} from "../../src/asf/health.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:05:00.000Z";

interface ObservationSet {
  readonly service: ServiceHealthObservation;
  readonly database: DatabaseHealthObservation;
  readonly worker: WorkerHealthObservation;
  readonly sandbox: SandboxHealthObservation;
  readonly ctxlane: CtxlaneHealthObservation;
  readonly github: GithubHealthObservation;
  readonly mcp: McpHealthObservation;
  readonly backlog: BacklogHealthObservation;
}

function readyObservations(): ObservationSet {
  return {
    service: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "service",
      observed_at: NOW,
      data: {
        mode: "asf-worker",
        state: "running",
        accepting_submissions: true,
        recovery_complete: true,
      },
    },
    database: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "database",
      observed_at: NOW,
      data: {
        reachable: true,
        schema_version: 3,
        integrity_check_passed: true,
        write_probe_passed: true,
      },
    },
    worker: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "worker",
      observed_at: NOW,
      data: {
        heartbeat_at: NOW,
        scheduler_running: true,
        fencing_store_ready: true,
        max_concurrency: 2,
        active_runs: 0,
        queued_runs: 0,
      },
    },
    sandbox: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "sandbox",
      observed_at: NOW,
      data: {
        mechanism: "bubblewrap",
        installed: true,
        enforcement_self_test_passed: true,
        enforcement_downgraded: false,
        fresh_candidate_verification: true,
        tool_network_policy_enforced: true,
        verification_network_disabled: true,
        denial_proofs: {
          provider_credentials: true,
          ctxlane_socket: true,
          github_credentials: true,
          asf_credentials: true,
          backlog_credentials: true,
          host_ssh_agent: true,
          cloud_metadata: true,
          other_workspaces: true,
          docker_socket: true,
          mcp_control_endpoint: true,
        },
      },
    },
    ctxlane: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "ctxlane",
      observed_at: NOW,
      data: {
        reachable: true,
        mutually_authenticated: true,
        automation_lease_probe_passed: true,
      },
    },
    github: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "github",
      observed_at: NOW,
      data: {
        credential_in_controller: true,
        reachable: true,
        authenticated: true,
        repository_reachable: true,
        branch_push_allowed: true,
        pull_request_create_allowed: true,
        exact_head_observation_ready: true,
        ci_context_read_ready: true,
        reconciliation_ready: true,
        merge_allowed: false,
        administration_allowed: false,
      },
    },
    mcp: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "mcp",
      observed_at: NOW,
      data: {
        private_control_ready: true,
        controller_authenticated: true,
        exposed_to_workers: false,
      },
    },
    backlog: {
      schema: ASF_HEALTH_OBSERVATION_SCHEMA,
      kind: "backlog",
      observed_at: NOW,
      data: {
        selection_enabled: false,
        mutations_enabled: false,
      },
    },
  };
}

function probesFor(observations: ObservationSet): AsfHealthProbes {
  return {
    service: () => observations.service,
    database: () => observations.database,
    worker: () => observations.worker,
    sandbox: () => observations.sandbox,
    ctxlane: () => observations.ctxlane,
    github: () => observations.github,
    mcp: () => observations.mcp,
    backlog: () => observations.backlog,
  };
}

function healthService(
  probes: AsfHealthProbes = probesFor(readyObservations()),
  options: {
    readonly clock?: FakeClock;
    readonly probeExecutor?: AsfHealthProbeExecutor;
  } = {},
): AsfHealthService {
  return new AsfHealthService({
    mode: "asf-worker",
    clock: options.clock ?? new FakeClock(NOW),
    probes,
    expectedSchemaVersion: 3,
    expectedMaxConcurrency: 2,
    sandboxMechanism: "bubblewrap",
    maxObservationAgeMs: 60_000,
    workerHeartbeatMaxAgeMs: 30_000,
    probeTimeoutMs: 25,
    ...(options.probeExecutor === undefined
      ? {}
      : { probeExecutor: options.probeExecutor }),
  });
}

describe("ASF health contract", () => {
  it("reports each independently observed readiness domain", async () => {
    const report = await healthService().getHealth();

    expect(report).toMatchObject({
      schema: ASF_HEALTH_SCHEMA,
      mode: "asf-worker",
      checked_at: NOW,
      status: "ready",
      ready: true,
      components: {
        service: { status: "ready", reasons: [] },
        database: {
          status: "ready",
          reasons: [],
          details: { schema_version: 3, expected_schema_version: 3 },
        },
        worker: {
          status: "ready",
          reasons: [],
          details: { active_runs: 0, available_capacity: 2 },
        },
        sandbox: { status: "ready", reasons: [] },
        ctxlane: { status: "ready", reasons: [] },
        github: { status: "ready", reasons: [] },
        mcp: { status: "ready", reasons: [] },
        backlog: {
          status: "ready",
          reasons: [],
          details: { selection_enabled: false, mutations_enabled: false },
        },
      },
    });
    expect(Object.keys(report.components)).toEqual([
      "service",
      "database",
      "worker",
      "sandbox",
      "ctxlane",
      "github",
      "mcp",
      "backlog",
    ]);
    expect(asfHealthReportSchema.parse(report)).toEqual(report);
  });

  it("distinguishes known dependency and capacity degradation from refusal", async () => {
    const observations = readyObservations();
    observations.worker.data.active_runs = 2;
    observations.worker.data.queued_runs = 3;
    observations.ctxlane.data.reachable = false;
    observations.ctxlane.data.mutually_authenticated = false;
    observations.ctxlane.data.automation_lease_probe_passed = false;
    observations.github.data.reachable = false;
    observations.github.data.authenticated = false;
    observations.github.data.repository_reachable = false;
    observations.github.data.branch_push_allowed = false;
    observations.github.data.pull_request_create_allowed = false;
    observations.github.data.exact_head_observation_ready = false;
    observations.github.data.ci_context_read_ready = false;
    observations.github.data.reconciliation_ready = false;
    observations.mcp.data.private_control_ready = false;
    observations.mcp.data.controller_authenticated = false;

    const report = await healthService(probesFor(observations)).getHealth();

    expect(report.status).toBe("degraded");
    expect(report.ready).toBe(false);
    expect(report.components.worker).toMatchObject({
      status: "degraded",
      reasons: ["worker.capacity_full", "worker.queue_nonempty"],
    });
    expect(report.components.ctxlane).toMatchObject({
      status: "degraded",
      reasons: ["ctxlane.unreachable"],
    });
    expect(report.components.github).toMatchObject({
      status: "degraded",
      reasons: ["github.unreachable"],
    });
    expect(report.components.mcp).toMatchObject({
      status: "degraded",
      reasons: ["mcp.control_unavailable", "mcp.controller_unauthenticated"],
    });
  });

  it("refuses sandbox downgrade, failed denials, MCP exposure, and backlog authority", async () => {
    const observations = readyObservations();
    observations.sandbox.data.enforcement_downgraded = true;
    observations.sandbox.data.denial_proofs.ctxlane_socket = false;
    observations.mcp.data.exposed_to_workers = true;
    observations.backlog.data.selection_enabled = true;
    observations.backlog.data.mutations_enabled = true;

    const report = await healthService(probesFor(observations)).getHealth();

    expect(report.status).toBe("refusing");
    expect(report.ready).toBe(false);
    expect(report.components.sandbox).toMatchObject({
      status: "refusing",
      reasons: ["sandbox.downgraded", "sandbox.denial_proof_failed"],
    });
    expect(report.components.mcp).toMatchObject({
      status: "refusing",
      reasons: ["mcp.exposed_to_worker"],
    });
    expect(report.components.backlog).toMatchObject({
      status: "refusing",
      reasons: ["backlog.selection_enabled", "backlog.mutations_enabled"],
    });
  });

  it("fails closed on independently stale and future observations", async () => {
    const observations = readyObservations();
    observations.service.observed_at = "2026-08-21T10:03:59.999Z";
    observations.database.observed_at = "2026-08-21T10:05:00.001Z";

    const report = await healthService(probesFor(observations)).getHealth();

    expect(report.status).toBe("refusing");
    expect(report.components.service).toMatchObject({
      status: "refusing",
      reasons: ["observation.stale"],
    });
    expect(report.components.database).toMatchObject({
      status: "refusing",
      reasons: ["observation.future"],
    });
  });

  it("fails closed on a missing probe and a strict-schema violation without echoing input", async () => {
    const observations = readyObservations();
    const { worker: _worker, ...withoutWorker } = probesFor(observations);
    const probes = {
      ...withoutWorker,
      sandbox: () => ({
        ...observations.sandbox,
        execution_handle: "provider-token-secret",
      }),
    } as unknown as AsfHealthProbes;

    const report = await healthService(probes).getHealth();

    expect(report.components.worker).toMatchObject({
      status: "refusing",
      reasons: ["observation.missing"],
      details: null,
    });
    expect(report.components.sandbox).toMatchObject({
      status: "refusing",
      reasons: ["observation.invalid"],
      details: null,
    });
    expect(JSON.stringify(report)).not.toContain("provider-token-secret");
  });

  it("fails closed on contradictory database, worker, ctxlane, GitHub, and MCP evidence", async () => {
    const observations = readyObservations();
    observations.database.data.reachable = false;
    observations.worker.data.active_runs = 3;
    observations.ctxlane.data.reachable = false;
    observations.github.data.reachable = false;
    observations.mcp.data.controller_authenticated = false;

    const report = await healthService(probesFor(observations)).getHealth();

    expect(report.status).toBe("refusing");
    expect(report.components.database.reasons).toEqual(["database.contradictory"]);
    expect(report.components.worker.reasons).toContain("worker.capacity_contradictory");
    expect(report.components.ctxlane.reasons).toEqual(["ctxlane.contradictory"]);
    expect(report.components.github.reasons).toEqual(["github.contradictory"]);
    expect(report.components.mcp.reasons).toEqual(["mcp.contradictory"]);
  });

  it("refuses stale or future worker heartbeats independently of probe freshness", async () => {
    const stale = readyObservations();
    stale.worker.data.heartbeat_at = "2026-08-21T10:04:29.999Z";
    const staleReport = await healthService(probesFor(stale)).getHealth();
    expect(staleReport.components.worker).toMatchObject({
      status: "refusing",
      reasons: ["worker.heartbeat_stale"],
    });

    const future = readyObservations();
    future.worker.data.heartbeat_at = "2026-08-21T10:05:00.001Z";
    const futureReport = await healthService(probesFor(future)).getHealth();
    expect(futureReport.components.worker).toMatchObject({
      status: "refusing",
      reasons: ["worker.heartbeat_future"],
    });
  });

  it("bounds every probe through the injected executor and maps timeouts safely", async () => {
    const timeouts: number[] = [];
    let invocation = 0;
    const executor: AsfHealthProbeExecutor = {
      async run<T>(
        timeoutMs: number,
        operation: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        timeouts.push(timeoutMs);
        invocation += 1;
        if (invocation === 5) throw new AsfHealthProbeTimeoutError();
        return operation(new AbortController().signal);
      },
    };

    const report = await healthService(probesFor(readyObservations()), {
      probeExecutor: executor,
    }).getHealth();

    expect(timeouts).toEqual(Array.from({ length: 8 }, () => 25));
    expect(report.status).toBe("refusing");
    expect(report.components.ctxlane).toMatchObject({
      status: "refusing",
      reasons: ["probe.timeout"],
      details: null,
    });
  });

  it("aborts an overlong probe at the default executor deadline", async () => {
    let aborted = false;
    const probes: AsfHealthProbes = {
      ...probesFor(readyObservations()),
      ctxlane: (signal) =>
        new Promise<CtxlaneHealthObservation>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("health probe aborted"),
              );
            },
            { once: true },
          );
        }),
    };

    const report = await healthService(probes).getHealth();

    expect(aborted).toBe(true);
    expect(report.components.ctxlane).toMatchObject({
      status: "refusing",
      reasons: ["probe.timeout"],
      details: null,
    });
  });

  it("does not expose probe exceptions in the public report", async () => {
    const probes: AsfHealthProbes = {
      ...probesFor(readyObservations()),
      github: () => {
        throw new Error("GitHub token provider-token-secret failed at a private endpoint");
      },
    };

    const report = await healthService(probes).getHealth();

    expect(report.components.github).toMatchObject({
      status: "refusing",
      reasons: ["probe.failed"],
      details: null,
    });
    expect(JSON.stringify(report)).not.toContain("provider-token-secret");
  });

  it("is constructible only for explicit ASF mode and does not probe on construction", () => {
    let calls = 0;
    const observations = readyObservations();
    const probes: AsfHealthProbes = {
      ...probesFor(observations),
      service: () => {
        calls += 1;
        return observations.service;
      },
    };
    healthService(probes);
    expect(calls).toBe(0);

    expect(
      () =>
        new AsfHealthService({
          mode: "standalone" as "asf-worker",
          clock: new FakeClock(NOW),
          probes,
          expectedSchemaVersion: 3,
          expectedMaxConcurrency: 2,
          sandboxMechanism: "bubblewrap",
          maxObservationAgeMs: 60_000,
          workerHeartbeatMaxAgeMs: 30_000,
          probeTimeoutMs: 25,
        }),
    ).toThrow("explicit asf-worker mode");
  });

  it("rejects contradictory top-level readiness and unknown output fields", async () => {
    const report = await healthService().getHealth();
    expect(
      asfHealthReportSchema.safeParse({ ...report, status: "degraded" }).success,
    ).toBe(false);
    expect(
      asfHealthReportSchema.safeParse({ ...report, ready: false }).success,
    ).toBe(false);
    expect(
      asfHealthReportSchema.safeParse({ ...report, credential: "provider-token-secret" }).success,
    ).toBe(false);
    expect(
      asfHealthReportSchema.safeParse({
        ...report,
        components: {
          ...report.components,
          worker: {
            ...report.components.worker,
            reasons: ["worker.capacity_full"],
          },
        },
      }).success,
    ).toBe(false);
  });
});
