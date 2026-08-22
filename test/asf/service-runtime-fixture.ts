import { join } from "node:path";
import type { AsfWorkerRuntimeFactoryContext } from "../../src/asf/runtime-entrypoint.js";
import type { AsfWorkerHostOptions } from "../../src/asf/worker-host.js";
import {
  ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
} from "../../src/asf/production-readiness.js";

/**
 * Process-level fixture for the explicit service-start contract. It deliberately
 * supplies no production controllers; it only gives the host schema-valid
 * observations and inert methods needed to test startup/control isolation.
 */
export function createAsfWorkerHostOptions(
  context: AsfWorkerRuntimeFactoryContext,
): AsfWorkerHostOptions {
  const ready = (details: Record<string, unknown>) => ({
    status: "ready" as const,
    observed_at: context.startedAt,
    age_ms: 0,
    reasons: [],
    details,
  });
  const health = {
    schema: "asf.health/v1",
    mode: "asf-worker",
    checked_at: context.startedAt,
    probe_duration_ms: 1,
    status: "ready",
    ready: true,
    components: {
      service: ready({
        mode: "asf-worker",
        state: "running",
        accepting_submissions: true,
        recovery_complete: true,
      }),
      database: ready({
        reachable: true,
        schema_version: 4,
        integrity_check_passed: true,
        write_probe_passed: true,
        expected_schema_version: 4,
      }),
      worker: ready({
        heartbeat_at: context.startedAt,
        scheduler_running: true,
        fencing_store_ready: true,
        max_concurrency: 1,
        active_runs: 0,
        queued_runs: 0,
        expected_max_concurrency: 1,
        heartbeat_age_ms: 0,
        available_capacity: 1,
      }),
      sandbox: ready({
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
      ctxlane: ready({
        reachable: true,
        mutually_authenticated: true,
        automation_lease_probe_passed: true,
      }),
      github: ready({
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
      mcp: ready({
        private_control_ready: true,
        controller_authenticated: true,
        exposed_to_workers: false,
      }),
      backlog: ready({ selection_enabled: false, mutations_enabled: false }),
    },
  };

  return {
    mode: "asf-worker",
    repoRoot: process.cwd(),
    configPath: join(process.cwd(), "test-asf-runtime.json"),
    startedAt: context.startedAt,
    controlAuthentication: {
      verify: async () => undefined,
    },
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
      submitWorkOrder: () => {
        throw new Error("fixture does not admit work");
      },
      getRun: () => {
        throw new Error("fixture has no runs");
      },
      listRunEvents: () => {
        throw new Error("fixture has no events");
      },
      getEvidence: () => {
        throw new Error("fixture has no evidence");
      },
      requestCancellation: () => {
        throw new Error("fixture has no runs");
      },
      recordApproval: () => {
        throw new Error("fixture has no runs");
      },
      requestReconciliation: () => {
        throw new Error("fixture has no runs");
      },
      acknowledgeOutcome: () => {
        throw new Error("fixture has no runs");
      },
      health: async () => health,
      recover: () => 0,
      requestStop: async () => undefined,
    } as unknown as AsfWorkerHostOptions["service"],
  };
}
