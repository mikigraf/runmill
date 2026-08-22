import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestDaemon,
  type ControlRequest,
  type ControlServerOptions,
  type RuntimePaths,
} from "../../src/daemon/control.js";
import {
  AsfWorkerHost,
  AsfWorkerHostReadinessError,
  type AsfWorkerHostControlServer,
  type AsfWorkerHostControlServerFactory,
  type AsfWorkerHostOptions,
  type AsfWorkerHostService,
} from "../../src/asf/worker-host.js";
import {
  ASF_HEALTH_SCHEMA,
  asfHealthReportSchema,
  type AsfHealthReport,
} from "../../src/asf/health.js";
import {
  ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
  type ProductionReadinessReport,
} from "../../src/asf/production-readiness.js";
import {
  AsfControlRequestAuthenticator,
  AsfControlRequestSigner,
} from "../../src/asf/control-auth.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:05:00.000Z";
const CONTROL_KEY = {
  controllerId: "asf-controller-prod",
  keyId: "asf-control-2026",
  secret: "a-dedicated-control-secret-with-at-least-32-bytes",
} as const;

function controlAuthenticator(): AsfControlRequestAuthenticator {
  return new AsfControlRequestAuthenticator({
    keys: [CONTROL_KEY],
    clock: new FakeClock(NOW),
  });
}

function controlSigner(): AsfControlRequestSigner {
  return new AsfControlRequestSigner({ key: CONTROL_KEY, clock: new FakeClock(NOW) });
}

function productionReady(): ProductionReadinessReport {
  return {
    schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
    mode: "asf-worker",
    decision: "ready",
    readyToStart: true,
    asfProductionReady: true,
    checks: ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED.map((id) => ({
      id,
      passed: true,
      expected: "ready",
      observed: "ready",
    })),
  };
}

function healthReport(queuedRuns = 0): AsfHealthReport {
  const workerReasons = queuedRuns === 0 ? [] : ["worker.queue_nonempty"];
  const status = queuedRuns === 0 ? "ready" : "degraded";
  return asfHealthReportSchema.parse({
    schema: ASF_HEALTH_SCHEMA,
    mode: "asf-worker",
    checked_at: NOW,
    probe_duration_ms: 1,
    status,
    ready: queuedRuns === 0,
    components: {
      service: {
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
          mode: "asf-worker",
          state: "running",
          accepting_submissions: true,
          recovery_complete: true,
        },
      },
      database: {
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
          reachable: true,
          schema_version: 3,
          integrity_check_passed: true,
          write_probe_passed: true,
          expected_schema_version: 3,
        },
      },
      worker: {
        status,
        observed_at: NOW,
        age_ms: 0,
        reasons: workerReasons,
        details: {
          heartbeat_at: NOW,
          scheduler_running: true,
          fencing_store_ready: true,
          max_concurrency: 2,
          active_runs: 0,
          queued_runs: queuedRuns,
          expected_max_concurrency: 2,
          heartbeat_age_ms: 0,
          available_capacity: 2,
        },
      },
      sandbox: {
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
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
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
          reachable: true,
          mutually_authenticated: true,
          automation_lease_probe_passed: true,
        },
      },
      github: {
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
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
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
          private_control_ready: true,
          controller_authenticated: true,
          exposed_to_workers: false,
        },
      },
      backlog: {
        status: "ready",
        observed_at: NOW,
        age_ms: 0,
        reasons: [],
        details: {
          selection_enabled: false,
          mutations_enabled: false,
        },
      },
    },
  });
}

function refusingHealthReport(): AsfHealthReport {
  const base = healthReport();
  return asfHealthReportSchema.parse({
    ...base,
    status: "refusing",
    ready: false,
    components: {
      ...base.components,
      ctxlane: {
        ...base.components.ctxlane,
        status: "refusing",
        reasons: ["ctxlane.contradictory"],
        details: {
          reachable: false,
          mutually_authenticated: true,
          automation_lease_probe_passed: false,
        },
      },
    },
  });
}

interface FakeService extends AsfWorkerHostService {
  readonly recover: ReturnType<typeof vi.fn>;
  readonly requestStop: ReturnType<typeof vi.fn>;
  readonly health: ReturnType<typeof vi.fn>;
  readonly submitWorkOrder: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly requestCancellation: ReturnType<typeof vi.fn>;
}

function fakeService(getHealth: () => unknown = () => healthReport()): FakeService {
  return {
    recover: vi.fn(() => 2),
    requestStop: vi.fn(async () => undefined),
    health: vi.fn(async () => getHealth()),
    submitWorkOrder: vi.fn(async () => ({ runId: "run_01", accepted: true })),
    getRun: vi.fn((runId: string) => ({ run: { runId } })),
    listRunEvents: vi.fn(() => ({ events: [] })),
    getEvidence: vi.fn(() => ({ schema: "test-evidence" })),
    requestCancellation: vi.fn(() => ({ disposition: "recorded" })),
    recordApproval: vi.fn(() => ({ disposition: "recorded" })),
    requestReconciliation: vi.fn(() => ({ disposition: "queued" })),
    acknowledgeOutcome: vi.fn(() => ({ disposition: "recorded" })),
  } as unknown as FakeService;
}

class FakeControlServer implements AsfWorkerHostControlServer {
  readonly close = vi.fn(async () => undefined);
}

class FakeControlServerFactory implements AsfWorkerHostControlServerFactory {
  readonly server = new FakeControlServer();
  readonly start = vi.fn(async (options: ControlServerOptions) => {
    this.options = options;
    return this.server;
  });
  options: ControlServerOptions | undefined;

  handle(request: ControlRequest): Promise<unknown> {
    const options = this.options;
    if (options === undefined) throw new Error("fake control server was not started");
    return Promise.resolve(options.handle(request));
  }
}

function hostOptions(
  service: FakeService,
  factory: FakeControlServerFactory,
  overrides: Partial<AsfWorkerHostOptions> = {},
): AsfWorkerHostOptions {
  return {
    mode: "asf-worker",
    service,
    repoRoot: "/controller/runmill",
    configPath: "/controller/runmill/asf-worker.json",
    startedAt: NOW,
    controlAuthentication: controlAuthenticator(),
    readiness: () => productionReady(),
    controlServerFactory: factory,
    ...overrides,
  };
}

describe("AsfWorkerHost", () => {
  it("recovers exactly once before opening the ASF-only control service", async () => {
    const service = fakeService();
    const factory = new FakeControlServerFactory();
    const ordering: string[] = [];
    service.recover.mockImplementation(() => {
      ordering.push("recover");
      return 2;
    });
    factory.start.mockImplementation(async (options: ControlServerOptions) => {
      ordering.push("control");
      factory.options = options;
      return factory.server;
    });

    const host = await AsfWorkerHost.start(hostOptions(service, factory));

    expect(ordering).toEqual(["recover", "control"]);
    expect(service.recover).toHaveBeenCalledTimes(1);
    expect(service.health).toHaveBeenCalledTimes(1);
    await expect(factory.handle({ type: "asf.get_run", runId: "run_01" })).resolves.toEqual({
      run: { runId: "run_01" },
    });
    expect(service.getRun).toHaveBeenCalledWith("run_01");

    await host.stop();
    expect(factory.server.close).toHaveBeenCalledTimes(1);
    expect(service.requestStop).toHaveBeenCalledTimes(1);
  });

  it("refuses startup on non-ASF, failed, or contradictory readiness evidence", async () => {
    const service = fakeService();
    const factory = new FakeControlServerFactory();
    const failed: ProductionReadinessReport = {
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "asf-worker",
      decision: "refuse",
      readyToStart: false,
      asfProductionReady: false,
      checks: [
        {
          id: "sandbox.self-test",
          passed: false,
          expected: "true",
          observed: "false",
        },
      ],
    };

    await expect(
      AsfWorkerHost.start(hostOptions(service, factory, { readiness: () => failed })),
    ).rejects.toMatchObject({
      name: "AsfWorkerHostReadinessError",
      domain: "production",
      reasons: ["sandbox.self-test"],
    });
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          mode: "standalone" as never,
        }),
      ),
    ).rejects.toThrow(/explicit-asf-worker-mode-required/u);
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          controlAuthentication: undefined as never,
        }),
      ),
    ).rejects.toThrow(/authenticated-control-required/u);
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          readiness: () => ({
            ...productionReady(),
            checks: [{ ...productionReady().checks[0], passed: false }],
          }) as ProductionReadinessReport,
        }),
      ),
    ).rejects.toBeInstanceOf(AsfWorkerHostReadinessError);
    const omitted = productionReady();
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          readiness: () => ({ ...omitted, checks: omitted.checks.slice(1) }),
        }),
      ),
    ).rejects.toMatchObject({
      reasons: ["readiness-check-set-incomplete-or-unknown"],
    });
    const renamed = productionReady();
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          readiness: () => ({
            ...renamed,
            checks: renamed.checks.map((check, index) =>
              index === 3 ? { ...check, id: "backlog.disabled" } : check,
            ),
          }),
        }),
      ),
    ).rejects.toMatchObject({
      reasons: ["readiness-check-set-incomplete-or-unknown"],
    });
    await expect(
      AsfWorkerHost.start(
        hostOptions(service, factory, {
          readiness: () => ({
            ...productionReady(),
            schema: "asf.production-readiness-report/v2",
          }) as never,
        }),
      ),
    ).rejects.toMatchObject({ reasons: ["invalid-or-not-ready-report"] });

    expect(service.health).not.toHaveBeenCalled();
    expect(service.recover).not.toHaveBeenCalled();
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("refuses startup when runtime health is degraded or malformed", async () => {
    const degradedService = fakeService(() => healthReport(1));
    const degradedFactory = new FakeControlServerFactory();

    await expect(
      AsfWorkerHost.start(hostOptions(degradedService, degradedFactory)),
    ).rejects.toMatchObject({
      name: "AsfWorkerHostReadinessError",
      domain: "health",
      reasons: ["worker.queue_nonempty"],
    });
    expect(degradedService.recover).not.toHaveBeenCalled();
    expect(degradedFactory.start).not.toHaveBeenCalled();

    const malformedService = fakeService(() => ({ ready: true }));
    await expect(
      AsfWorkerHost.start(hostOptions(malformedService, new FakeControlServerFactory())),
    ).rejects.toMatchObject({ domain: "health", reasons: ["invalid-report"] });
  });

  it("rechecks safety gates for new authority while preserving safe controls", async () => {
    let ready = true;
    const service = fakeService(() => healthReport(ready ? 0 : 1));
    const factory = new FakeControlServerFactory();
    const host = await AsfWorkerHost.start(hostOptions(service, factory));
    ready = false;

    await expect(
      factory.handle({ type: "asf.submit_work_order", envelope: { signed: true } }),
    ).rejects.toMatchObject({
      name: "AsfWorkerHostReadinessError",
      domain: "health",
      reasons: ["worker.queue_nonempty"],
    });
    expect(service.submitWorkOrder).not.toHaveBeenCalled();

    await expect(
      factory.handle({
        type: "asf.record_approval",
        envelope: {} as never,
      }),
    ).resolves.toEqual({ disposition: "recorded" });
    await expect(
      factory.handle({
        type: "asf.reconcile_run",
        request: {} as never,
      }),
    ).resolves.toEqual({ disposition: "queued" });

    await expect(
      factory.handle({
        type: "asf.request_cancel",
        request: {} as never,
      }),
    ).resolves.toEqual({ disposition: "recorded" });
    await expect(factory.handle({ type: "asf.health" })).resolves.toMatchObject({
      ready: false,
      status: "degraded",
    });
    await expect(factory.handle({ type: "snapshot" })).rejects.toThrow(
      /does not expose standalone backlog controls/u,
    );
    await expect(
      factory.handle({ type: "inspect", runId: "standalone-run" }),
    ).rejects.toThrow(/does not expose standalone backlog controls/u);

    await host.stop();
  });

  it("fails approval and reconciliation closed on a refusing dependency", async () => {
    let refusing = false;
    const service = fakeService(() => (refusing ? refusingHealthReport() : healthReport()));
    const factory = new FakeControlServerFactory();
    const host = await AsfWorkerHost.start(hostOptions(service, factory));
    refusing = true;

    await expect(
      factory.handle({ type: "asf.record_approval", envelope: {} as never }),
    ).rejects.toMatchObject({ domain: "health", reasons: ["ctxlane.contradictory"] });
    await expect(
      factory.handle({ type: "asf.reconcile_run", request: {} as never }),
    ).rejects.toMatchObject({ domain: "health", reasons: ["ctxlane.contradictory"] });
    await expect(
      factory.handle({ type: "asf.request_cancel", request: {} as never }),
    ).resolves.toEqual({ disposition: "recorded" });

    await host.stop();
  });

  it("closes intake and waits for the service's in-flight boundary on graceful stop", async () => {
    let finishStop: (() => void) | undefined;
    const service = fakeService();
    service.requestStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const factory = new FakeControlServerFactory();
    const host = await AsfWorkerHost.start(hostOptions(service, factory));

    let settled = false;
    let lifetimeSettled = false;
    const lifetime = host.waitUntilStopped().then(() => {
      lifetimeSettled = true;
    });
    const stopping = host.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(host.stopping).toBe(true);
    expect(factory.server.close).toHaveBeenCalledTimes(1);
    expect(service.requestStop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(lifetimeSettled).toBe(false);

    finishStop?.();
    await stopping;
    await lifetime;
    expect(lifetimeSettled).toBe(true);
    await host.stop();
    expect(factory.server.close).toHaveBeenCalledTimes(1);
    expect(service.requestStop).toHaveBeenCalledTimes(1);
  });

  it("acknowledges control stop without deadlocking on its own socket", async () => {
    const service = fakeService();
    const factory = new FakeControlServerFactory();
    const host = await AsfWorkerHost.start(hostOptions(service, factory));

    await expect(factory.handle({ type: "stop" })).resolves.toEqual({
      accepted: true,
      mode: "asf-worker",
      stopping: true,
    });
    expect(host.stopping).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(factory.server.close).toHaveBeenCalledTimes(1);
    expect(service.requestStop).toHaveBeenCalledTimes(1);
  });

  it("responds to stop before closing the real private Unix control channel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-asf-host-"));
    const paths: RuntimePaths = {
      directory,
      registry: join(directory, "daemon.json"),
      socket: join(directory, "daemon.sock"),
    };
    const service = fakeService();
    const host = await AsfWorkerHost.start({
      ...hostOptions(service, new FakeControlServerFactory()),
      paths,
      controlServerFactory: undefined,
    });

    await expect(
      requestDaemon({ type: "stop" }, paths.registry, 2_000, {
        controlAuthentication: controlSigner(),
      }),
    ).resolves.toEqual({
      accepted: true,
      mode: "asf-worker",
      stopping: true,
    });
    await host.stop();
    await expect(
      requestDaemon({ type: "asf.health" }, paths.registry, 2_000, {
        controlAuthentication: controlSigner(),
      }),
    ).rejects.toThrow(/No Runmill daemon is registered/u);
  });

  it("gracefully fences partial recovery when the control socket cannot start", async () => {
    const service = fakeService();
    const factory = new FakeControlServerFactory();
    factory.start.mockRejectedValueOnce(new Error("socket unavailable"));

    await expect(AsfWorkerHost.start(hostOptions(service, factory))).rejects.toThrow(
      "socket unavailable",
    );
    expect(service.recover).toHaveBeenCalledTimes(1);
    expect(service.requestStop).toHaveBeenCalledTimes(1);
  });

  it("requests a fenced stop when recovery itself fails after beginning", async () => {
    const service = fakeService();
    service.recover.mockImplementation(() => {
      throw new Error("recovery observation failed");
    });

    await expect(
      AsfWorkerHost.start(hostOptions(service, new FakeControlServerFactory())),
    ).rejects.toThrow("recovery observation failed");
    expect(service.requestStop).toHaveBeenCalledTimes(1);
  });
});
