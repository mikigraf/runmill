import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASF_READINESS_OBSERVATION_SCHEMA,
  type AsfReadinessObservation,
} from "../../src/asf/production-readiness.js";
import { signAsfReadinessObservation } from "../../src/asf/readiness-attestation.js";

export const READINESS_EVALUATOR_KEY_ID = "asf-readiness-evaluator-test";

/** Credential-free, all-passing observation matching the packaged ASF config. */
export function readinessObservation(
  observedAt = new Date().toISOString(),
): AsfReadinessObservation {
  return {
    schema: ASF_READINESS_OBSERVATION_SCHEMA,
    observed_at: observedAt,
    platform: "linux",
    hosting: "single-tenant",
    backlog: { selection_enabled: false, mutations_enabled: false },
    trust: {
      work_order_signers: [
        {
          key_id: "replace-with-work-order-key",
          key_type: "Ed25519",
          trusted: true,
          currently_valid: true,
          revoked: false,
        },
      ],
      approval_signers: [
        {
          key_id: "replace-with-approval-key",
          key_type: "Ed25519",
          trusted: true,
          currently_valid: true,
          revoked: false,
        },
      ],
    },
    ctxlane: {
      endpoint: "unix:///run/ctxlane/automation.sock",
      reachable: true,
      mutually_authenticated: true,
      automation_lease_probe_passed: true,
    },
    harness: {
      backend: "host-credential-harness",
      ready: true,
      credential_held_host_side: true,
      repository_tool_environments_credential_free: true,
      repository_tools_delegated: true,
      deterministic_cancellation: true,
      timeout_and_usage_reporting: true,
      secure_implementer_resume: true,
      fresh_reviewers: true,
    },
    sandbox: {
      mechanism: "bubblewrap",
      installed: true,
      enforcement_self_test_passed: true,
      enforcement_downgraded: false,
      read_only_base: true,
      ephemeral_workspace: true,
      resource_limits_enforced: true,
      resource_limits: {
        cpu_millis: 2_000,
        memory_mib: 4_096,
        processes: 256,
        file_size_mib: 1_024,
        wall_time_ms: 7_200_000,
      },
      fresh_candidate_verification: true,
    },
    network: {
      tools_mode: "disabled",
      verification_network_disabled: true,
      broker: null,
    },
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
    mcp: {
      service_control_endpoint: "unix:///run/runmill/asf-control.sock",
      controller_id: "replace-with-controller-id",
      controller_authenticated: true,
      private_control_ready: true,
      exposed_to_workers: false,
    },
    worker: {
      worker_id: "replace-with-worker-id",
      heartbeat_scheduler_ready: true,
      fencing_store_ready: true,
      max_concurrency: 4,
    },
    retention: {
      policy_enforceable: true,
      cleanup_ready: true,
      run_state_days: 365,
      portable_artifact_days: 365,
      protected_artifact_days: 30,
    },
    github: {
      credential_in_controller: true,
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
  };
}

export function writeSignedReadinessArtifacts(
  directory: string,
  observedAt = new Date().toISOString(),
): { readonly observationPath: string; readonly keyPath: string; readonly keyId: string } {
  const keys = generateKeyPairSync("ed25519");
  const signed = signAsfReadinessObservation({
    observation: readinessObservation(observedAt),
    keyId: READINESS_EVALUATOR_KEY_ID,
    privateKey: keys.privateKey,
  });
  const observationPath = join(directory, "readiness-observation.json");
  const keyPath = join(directory, "readiness-evaluator-public.pem");
  writeFileSync(observationPath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    keyPath,
    keys.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  return { observationPath, keyPath, keyId: READINESS_EVALUATOR_KEY_ID };
}
