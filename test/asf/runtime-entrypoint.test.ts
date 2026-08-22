import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AsfWorkerRuntimeConfigurationError,
  startAsfWorkerFromRuntime,
  type AsfWorkerRuntimeFactoryContext,
} from "../../src/asf/runtime-entrypoint.js";
import type { AsfWorkerHostOptions } from "../../src/asf/worker-host.js";
import {
  ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
} from "../../src/asf/production-readiness.js";

const NOW = "2026-08-21T10:05:00.000Z";
const GLOBAL_FACTORY = "__runmillAsfRuntimeTestFactory";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-asf-runtime-"));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_FACTORY];
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

function moduleFile(source?: string): string {
  const path = join(directory, `runtime-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(
    path,
    source ??
      `export function createAsfWorkerHostOptions(context) { return globalThis[${JSON.stringify(GLOBAL_FACTORY)}](context); }\n`,
    { mode: 0o600 },
  );
  return path;
}

function healthReport() {
  const component = (details: Record<string, unknown>) => ({
    status: "ready",
    observed_at: NOW,
    age_ms: 0,
    reasons: [],
    details,
  });
  return {
    schema: "asf.health/v1",
    mode: "asf-worker",
    checked_at: NOW,
    probe_duration_ms: 1,
    status: "ready",
    ready: true,
    components: {
      service: component({
        mode: "asf-worker",
        state: "running",
        accepting_submissions: true,
        recovery_complete: true,
      }),
      database: component({
        reachable: true,
        schema_version: 4,
        integrity_check_passed: true,
        write_probe_passed: true,
        expected_schema_version: 4,
      }),
      worker: component({
        heartbeat_at: NOW,
        scheduler_running: true,
        fencing_store_ready: true,
        max_concurrency: 1,
        active_runs: 0,
        queued_runs: 0,
        expected_max_concurrency: 1,
        heartbeat_age_ms: 0,
        available_capacity: 1,
      }),
      sandbox: component({
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
      }),
      ctxlane: component({
        reachable: true,
        mutually_authenticated: true,
        automation_lease_probe_passed: true,
      }),
      github: component({
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
      }),
      mcp: component({
        private_control_ready: true,
        controller_authenticated: true,
        exposed_to_workers: false,
      }),
      backlog: component({ selection_enabled: false, mutations_enabled: false }),
    },
  };
}

function validOptions(
  context: AsfWorkerRuntimeFactoryContext,
  overrides: Partial<AsfWorkerHostOptions> = {},
): AsfWorkerHostOptions {
  return {
    mode: "asf-worker",
    repoRoot: directory,
    configPath: join(directory, "operator-asf.json"),
    startedAt: context.startedAt,
    controlAuthentication: { verify: vi.fn(async () => undefined) },
    readiness: () => ({
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "asf-worker",
      decision: "ready",
      readyToStart: true,
      asfProductionReady: true,
      checks: ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED.map((id) => ({
        id,
        passed: true as const,
        expected: "ready",
        observed: "ready",
      })),
    }),
    service: {
      submitWorkOrder: vi.fn(),
      getRun: vi.fn(),
      listRunEvents: vi.fn(),
      getEvidence: vi.fn(),
      requestCancellation: vi.fn(),
      recordApproval: vi.fn(),
      requestReconciliation: vi.fn(),
      acknowledgeOutcome: vi.fn(),
      health: vi.fn(async () => healthReport()),
      recover: vi.fn(() => 0),
      requestStop: vi.fn(async () => undefined),
    },
    ...overrides,
  } as AsfWorkerHostOptions;
}

function env(): NodeJS.ProcessEnv {
  return {
    RUNMILL_ASF_DAEMON_REGISTRY: join(directory, "control", "asf-worker.json"),
  };
}

describe("trusted ASF runtime composition", () => {
  it("requires an explicit module and the literal ASF mode", async () => {
    await expect(
      startAsfWorkerFromRuntime({ mode: "asf-worker", env: {}, startedAt: NOW }),
    ).rejects.toMatchObject({ reason: "runtime-module-required" });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "standalone" as never,
        runtimeModulePath: moduleFile(),
        env: {},
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "explicit-asf-worker-mode-required" });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: moduleFile(),
        env: env(),
      } as never),
    ).rejects.toMatchObject({ reason: "started-at-invalid" });
  });

  it("rejects symlinked, writable, and unsafe-parent modules before import", async () => {
    const target = moduleFile();
    const symlink = join(directory, "runtime-link.mjs");
    symlinkSync(target, symlink);
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: symlink,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-file-unsafe" });

    chmodSync(target, 0o666);
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: target,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-file-unsafe" });

    const unsafeParent = join(directory, "unsafe");
    mkdirSync(unsafeParent, { mode: 0o777 });
    chmodSync(unsafeParent, 0o777);
    const child = join(unsafeParent, "runtime.mjs");
    writeFileSync(child, "export function createAsfWorkerHostOptions() { return {}; }\n", {
      mode: 0o600,
    });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: child,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-directory-unsafe" });
  });

  it("requires the named factory and exact host option shape", async () => {
    const missingFactory = moduleFile("export default function nope() { return {}; }\n");
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: missingFactory,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-factory-required" });

    const wrongShape = moduleFile();
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = () => ({
      mode: "standalone",
    });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: wrongShape,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-options-invalid" });

    const injectedTransport = moduleFile();
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = (
      context: AsfWorkerRuntimeFactoryContext,
    ) => ({
      ...validOptions(context),
      controlServerFactory: {
        start: async () => ({ close: async () => undefined }),
      },
    });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: injectedTransport,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-options-invalid" });

    const conflictingControlPath = moduleFile();
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = (
      context: AsfWorkerRuntimeFactoryContext,
    ) =>
      validOptions(context, {
        paths: {
          directory,
          registry: join(directory, "standalone", "daemon.json"),
          socket: join(directory, "standalone", "daemon.sock"),
        },
      });
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: conflictingControlPath,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-control-path-conflict" });
  });

  it("does not expose errors thrown while importing or invoking the module", async () => {
    const importFailure = moduleFile("throw new Error('deployment-secret');\n");
    const imported = startAsfWorkerFromRuntime({
      mode: "asf-worker",
      runtimeModulePath: importFailure,
      env: env(),
      startedAt: NOW,
    });
    await expect(imported).rejects.toMatchObject({ reason: "runtime-module-load-failed" });
    await expect(imported).rejects.not.toThrow(/deployment-secret/u);

    const factoryFailure = moduleFile();
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = () => {
      throw new Error("factory-secret");
    };
    const invoked = startAsfWorkerFromRuntime({
      mode: "asf-worker",
      runtimeModulePath: factoryFailure,
      env: env(),
      startedAt: NOW,
    });
    await expect(invoked).rejects.toMatchObject({ reason: "runtime-module-factory-failed" });
    await expect(invoked).rejects.not.toThrow(/factory-secret/u);
  });

  it("refuses a module whose identity or permissions change during its factory", async () => {
    const runtime = moduleFile(`
      import { chmodSync } from "node:fs";
      export function createAsfWorkerHostOptions(context) {
        const self = new URL(import.meta.url);
        self.search = "";
        chmodSync(self, 0o400);
        return globalThis[${JSON.stringify(GLOBAL_FACTORY)}](context);
      }
    `);
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = (
      context: AsfWorkerRuntimeFactoryContext,
    ) => validOptions(context);

    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: runtime,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-changed-during-load" });
  });

  it("passes an immutable process context and forces the isolated ASF paths", async () => {
    const runtime = moduleFile();
    let observed: AsfWorkerRuntimeFactoryContext | undefined;
    let returned: AsfWorkerHostOptions | undefined;
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = (
      context: AsfWorkerRuntimeFactoryContext,
    ) => {
      observed = context;
      returned = validOptions(context);
      return returned;
    };

    const host = await startAsfWorkerFromRuntime({
      mode: "asf-worker",
      runtimeModulePath: runtime,
      env: env(),
      startedAt: NOW,
    });

    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.runtimePaths)).toBe(true);
    expect(observed).toMatchObject({
      mode: "asf-worker",
      startedAt: NOW,
      runtimePaths: {
        registry: join(directory, "control", "asf-worker.json"),
        socket: join(directory, "control", "asf-worker.sock"),
      },
    });
    expect(returned?.controlServerFactory).toBeUndefined();
    expect(existsSync(observed?.runtimePaths.registry as string)).toBe(true);

    const lifetime = host.waitUntilStopped();
    await host.stop();
    await expect(lifetime).resolves.toBeUndefined();
    expect(existsSync(observed?.runtimePaths.registry as string)).toBe(false);
  });

  it("preserves the host's production-readiness refusal without recovering", async () => {
    const runtime = moduleFile();
    const recover = vi.fn(() => 0);
    (globalThis as Record<string, unknown>)[GLOBAL_FACTORY] = (
      context: AsfWorkerRuntimeFactoryContext,
    ) =>
      validOptions(context, {
        service: {
          ...validOptions(context).service,
          recover,
        },
        readiness: () => ({
          schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
          mode: "asf-worker",
          decision: "refuse",
          readyToStart: false,
          asfProductionReady: false,
          checks: [
            {
              id: "sandbox.self-test",
              passed: false,
              expected: "proven",
              observed: "missing",
            },
          ],
        }),
      });

    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: runtime,
        env: env(),
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({
      name: "AsfWorkerHostReadinessError",
      domain: "production",
      reasons: ["sandbox.self-test"],
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses contradictory option and environment module paths", async () => {
    const first = moduleFile();
    const second = moduleFile();
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: first,
        env: { ...env(), RUNMILL_ASF_RUNTIME_MODULE: second },
        startedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(AsfWorkerRuntimeConfigurationError);
    await expect(
      startAsfWorkerFromRuntime({
        mode: "asf-worker",
        runtimeModulePath: first,
        env: { ...env(), RUNMILL_ASF_RUNTIME_MODULE: second },
        startedAt: NOW,
      }),
    ).rejects.toMatchObject({ reason: "runtime-module-path-conflict" });
  });
});
