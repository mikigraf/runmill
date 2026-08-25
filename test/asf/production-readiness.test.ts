import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  ASF_READINESS_OBSERVATION_SCHEMA,
  ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
  ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
  PRODUCTION_MODE_CONFIG_SCHEMA,
  ProductionModeConfigError,
  ProductionStartupRefusedError,
  evaluateProductionReadiness,
  hasCanonicalAsfProductionReadinessChecks,
  parseProductionModeConfig,
  requireProductionReadiness,
  type AsfReadinessObservation,
  type AsfWorkerProductionConfig,
} from "../../src/asf/production-readiness.js";
import {
  AsfReadinessObservationVerificationError,
  signAsfReadinessObservation,
  verifySignedAsfReadinessObservation,
} from "../../src/asf/readiness-attestation.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:10Z";

function asfConfig(): AsfWorkerProductionConfig {
  return {
    schema: PRODUCTION_MODE_CONFIG_SCHEMA,
    mode: "asf-worker",
    asf: {
      hosting: "single-tenant",
      backlog: {
        selection_enabled: false,
        mutations_enabled: false,
      },
      trust: {
        work_order_signers: [{ key_id: "asf-work-orders-2026", algorithm: "EdDSA" }],
        approval_signers: [{ key_id: "asf-approvals-2026", algorithm: "EdDSA" }],
      },
      ctxlane: {
        endpoint: "unix:///run/ctxlane/automation.sock",
        audience: "runmill-asf",
        lease_renewal_ms: 30_000,
      },
      harness: {
        backend: "host-credential-harness",
        credential_boundary: "trusted-host-only",
        repository_tools: "runmill-sandbox-gateway",
        implementer_sessions: "secure-resumable",
        reviewer_sessions: "fresh-non-resumable",
      },
      sandbox: {
        mechanism: "bubblewrap",
        base_image: "read-only",
        workspace: "ephemeral",
        resource_limits_required: true,
        resource_limits: {
          cpu_millis: 2_000,
          memory_mib: 4_096,
          processes: 256,
          file_size_mib: 1_024,
          wall_time_ms: 7_200_000,
        },
        verification_environment: "fresh-candidate",
        tools_network: { mode: "disabled" },
        verification_network: "disabled",
      },
      mcp: {
        transport: "stdio-private-control",
        service_control_endpoint: "unix:///run/runmill/asf-control.sock",
        trusted_controller_ids: ["asf-controller-prod"],
        expose_to_workers: false,
      },
      worker: {
        worker_id: "asf-worker-eu-01",
        heartbeat_interval_ms: 5_000,
        stale_after_ms: 20_000,
        max_concurrency: 4,
        readiness_max_age_ms: 60_000,
      },
      retention: {
        run_state_days: 365,
        portable_artifact_days: 365,
        protected_artifact_days: 30,
      },
      github: {
        closure_target: "pr",
        credential_boundary: "trusted-controller-only",
        contents_permission: "write",
        pull_requests_permission: "write",
        checks_permission: "read",
        merge_permission: "none",
        administration_permission: "none",
      },
    },
  };
}

function observation(): AsfReadinessObservation {
  return {
    schema: ASF_READINESS_OBSERVATION_SCHEMA,
    observed_at: "2026-08-21T10:00:00Z",
    platform: "linux",
    hosting: "single-tenant",
    backlog: {
      selection_enabled: false,
      mutations_enabled: false,
    },
    trust: {
      work_order_signers: [
        {
          key_id: "asf-work-orders-2026",
          key_type: "Ed25519",
          trusted: true,
          currently_valid: true,
          revoked: false,
        },
      ],
      approval_signers: [
        {
          key_id: "asf-approvals-2026",
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
      controller_id: "asf-controller-prod",
      controller_authenticated: true,
      private_control_ready: true,
      exposed_to_workers: false,
    },
    worker: {
      worker_id: "asf-worker-eu-01",
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

function clock(): FakeClock {
  return new FakeClock(NOW);
}

function failedIds(report: ReturnType<typeof evaluateProductionReadiness>): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.id);
}

describe("production mode selection", () => {
  it("defaults to usable standalone mode without any ASF dependency or probe", () => {
    const config = parseProductionModeConfig();

    expect(config).toEqual({
      schema: PRODUCTION_MODE_CONFIG_SCHEMA,
      mode: "standalone",
    });
    expect(evaluateProductionReadiness(config)).toEqual({
      schema: ASF_PRODUCTION_READINESS_REPORT_SCHEMA,
      mode: "standalone",
      decision: "ready",
      readyToStart: true,
      asfProductionReady: false,
      checks: [],
    });
    expect(requireProductionReadiness(config).readyToStart).toBe(true);
  });

  it("cannot infer ASF from observations or an incomplete mode object", () => {
    const defaulted = parseProductionModeConfig();
    expect(evaluateProductionReadiness(defaulted, observation(), clock()).mode).toBe(
      "standalone",
    );
    expect(() => parseProductionModeConfig({})).toThrow(ProductionModeConfigError);
    expect(() =>
      parseProductionModeConfig({
        schema: PRODUCTION_MODE_CONFIG_SCHEMA,
        mode: "asf-worker",
      }),
    ).toThrow(ProductionModeConfigError);
  });

  it("keeps standalone strict and rejects hidden ASF authority", () => {
    expect(() =>
      parseProductionModeConfig({
        schema: PRODUCTION_MODE_CONFIG_SCHEMA,
        mode: "standalone",
        asf: { ctxlane: { endpoint: "unix:///run/ctxlane.sock" } },
      }),
    ).toThrow(ProductionModeConfigError);
  });

  it("allows direct CLI and copied homes only in explicitly non-production development", () => {
    for (const providerBackend of ["direct-cli", "copied-provider-home"] as const) {
      const config = parseProductionModeConfig({
        schema: PRODUCTION_MODE_CONFIG_SCHEMA,
        mode: "development",
        development: {
          provider_backend: providerBackend,
          remotes: "fake-only",
          sandbox: "best-effort",
        },
      });
      expect(evaluateProductionReadiness(config)).toMatchObject({
        decision: "development-only",
        readyToStart: true,
        asfProductionReady: false,
      });
    }
  });
});

describe("ASF worker readiness", () => {
  it("binds live-readiness evidence to an explicit Ed25519 evaluator key", () => {
    const keys = generateKeyPairSync("ed25519");
    const signed = signAsfReadinessObservation({
      observation: observation(),
      keyId: "readiness-evaluator-2026",
      privateKey: keys.privateKey,
    });

    expect(
      verifySignedAsfReadinessObservation(signed, {
        keyId: "readiness-evaluator-2026",
        publicKey: keys.publicKey,
      }),
    ).toEqual(signed);

    const tampered = structuredClone(signed);
    tampered.observation.github.repository_reachable = false;
    expect(() =>
      verifySignedAsfReadinessObservation(tampered, {
        keyId: "readiness-evaluator-2026",
        publicKey: keys.publicKey,
      }),
    ).toThrow(AsfReadinessObservationVerificationError);

    expect(() =>
      verifySignedAsfReadinessObservation(signed, {
        keyId: "different-evaluator",
        publicKey: keys.publicKey,
      }),
    ).toThrow(/not the configured evaluator key/u);
  });

  it("accepts an explicit Linux PR-only deployment only after every proof passes", () => {
    const config = parseProductionModeConfig(asfConfig());
    const report = evaluateProductionReadiness(config, observation(), clock());

    expect(report).toMatchObject({
      mode: "asf-worker",
      decision: "ready",
      readyToStart: true,
      asfProductionReady: true,
    });
    expect(failedIds(report)).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(50);
    expect(report.schema).toBe(ASF_PRODUCTION_READINESS_REPORT_SCHEMA);
    expect(report.checks.map((check) => check.id)).toEqual(
      ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
    );
    expect(requireProductionReadiness(config, observation(), clock())).toEqual(report);
  });

  it("recognizes only the versioned disabled-network production check set", () => {
    const report = evaluateProductionReadiness(asfConfig(), observation(), clock());
    const brokerClaim = report.checks.map((check) =>
      check.id === "network.no-proxy"
        ? { ...check, id: "network.broker-present" }
        : check,
    );

    expect(hasCanonicalAsfProductionReadinessChecks(report.checks)).toBe(true);
    expect(hasCanonicalAsfProductionReadinessChecks(brokerClaim)).toBe(false);
    expect(report.checks.map((check) => check.id)).not.toContain(
      "network.broker-present",
    );
  });

  it("refuses missing, malformed, or stale live observations", () => {
    const config = asfConfig();
    expect(failedIds(evaluateProductionReadiness(config))).toEqual([
      "observation.schema",
    ]);

    const withCredential = structuredClone(observation()) as unknown as Record<
      string,
      unknown
    >;
    withCredential["github_token"] = "not-an-observation-field";
    expect(failedIds(evaluateProductionReadiness(config, withCredential, clock()))).toEqual([
      "observation.schema",
    ]);

    const stale = observation();
    stale.observed_at = "2026-08-21T09:58:00Z";
    expect(failedIds(evaluateProductionReadiness(config, stale, clock()))).toContain(
      "observation.fresh",
    );
  });

  const refusalCases: readonly [
    string,
    (value: AsfReadinessObservation) => void,
    string,
  ][] = [
    ["non-Linux host", (value) => { value.platform = "darwin"; }, "platform.linux"],
    [
      "backlog selection",
      (value) => { value.backlog.selection_enabled = true; },
      "backlog.selection-disabled",
    ],
    [
      "backlog mutation",
      (value) => { value.backlog.mutations_enabled = true; },
      "backlog.mutations-disabled",
    ],
    [
      "revoked Work Order signer",
      (value) => {
        const signer = value.trust.work_order_signers[0];
        if (signer !== undefined) signer.revoked = true;
      },
      "trust.work-orders",
    ],
    [
      "missing approval signer",
      (value) => { value.trust.approval_signers = []; },
      "trust.approvals",
    ],
    [
      "unreachable ctxlane",
      (value) => { value.ctxlane.reachable = false; },
      "ctxlane.reachable",
    ],
    [
      "direct CLI harness",
      (value) => { value.harness.backend = "direct-cli"; },
      "harness.backend",
    ],
    [
      "provider credential in tool environment",
      (value) => { value.harness.repository_tool_environments_credential_free = false; },
      "harness.tool-environment-credential-free",
    ],
    [
      "sandbox downgrade",
      (value) => { value.sandbox.enforcement_downgraded = true; },
      "sandbox.no-downgrade",
    ],
    [
      "sandbox resource-limit mismatch",
      (value) => { value.sandbox.resource_limits.memory_mib = 8_192; },
      "sandbox.limit.memory_mib",
    ],
    [
      "unsupported microVM sandbox",
      (value) => { value.sandbox.mechanism = "microvm"; },
      "sandbox.mechanism",
    ],
    [
      "unrestricted proxy",
      (value) => { value.network.tools_mode = "unrestricted-proxy"; },
      "network.tools-mode",
    ],
    [
      "verification network access",
      (value) => { value.network.verification_network_disabled = false; },
      "network.verification-disabled",
    ],
    [
      "HTTPS ctxlane observation",
      (value) => { value.ctxlane.endpoint = "https://ctxlane.example"; },
      "observation.schema",
    ],
    [
      "provider credential readable",
      (value) => { value.denial_proofs.provider_credentials = false; },
      "denial.provider_credentials",
    ],
    [
      "ctxlane control socket readable",
      (value) => { value.denial_proofs.ctxlane_socket = false; },
      "denial.ctxlane_socket",
    ],
    [
      "MCP control endpoint readable",
      (value) => { value.denial_proofs.mcp_control_endpoint = false; },
      "denial.mcp_control_endpoint",
    ],
    [
      "MCP exposed to worker",
      (value) => { value.mcp.exposed_to_workers = true; },
      "mcp.not-exposed-to-workers",
    ],
    [
      "heartbeat scheduler unavailable",
      (value) => { value.worker.heartbeat_scheduler_ready = false; },
      "worker.heartbeat",
    ],
    [
      "worker capacity mismatch",
      (value) => { value.worker.max_concurrency = 5; },
      "worker.concurrency",
    ],
    [
      "retention cleanup unavailable",
      (value) => { value.retention.cleanup_ready = false; },
      "retention.cleanup",
    ],
    [
      "GitHub merge authority",
      (value) => { value.github.merge_allowed = true; },
      "github.no-merge",
    ],
    [
      "GitHub PR creation unavailable",
      (value) => { value.github.pull_request_create_allowed = false; },
      "github.pr-create",
    ],
    [
      "GitHub credential outside controller",
      (value) => { value.github.credential_in_controller = false; },
      "github.credential-controller-only",
    ],
  ];

  it.each(refusalCases)("fails closed for %s", (_name, mutate, expectedFailure) => {
    const observed = observation();
    mutate(observed);

    const report = evaluateProductionReadiness(asfConfig(), observed, clock());

    expect(report.decision).toBe("refuse");
    expect(report.readyToStart).toBe(false);
    expect(failedIds(report)).toContain(expectedFailure);
    expect(() => requireProductionReadiness(asfConfig(), observed, clock())).toThrow(
      ProductionStartupRefusedError,
    );
  });

  it("refuses broker claims even when every claimed broker control passes", () => {
    const config = asfConfig();
    const observed = observation();
    observed.network.tools_mode = "enforced-broker";
    observed.network.broker = {
      hostname_enforced: true,
      ip_enforced: true,
      tls_enforced: true,
      dns_rebinding_protected: true,
      decisions_audited: true,
    };
    const report = evaluateProductionReadiness(config, observed, clock());

    expect(report.decision).toBe("refuse");
    expect(failedIds(report)).toEqual(
      expect.arrayContaining(["network.tools-mode", "network.no-proxy"]),
    );
    expect(report.checks.map((check) => check.id)).toEqual(
      ASF_PRODUCTION_READINESS_CHECK_IDS_V1_DISABLED,
    );
  });
});

describe("operator-owned ASF configuration governance", () => {
  it("rejects production capabilities that have no in-tree implementation", () => {
    for (const backend of ["direct-cli", "copied-provider-home"] as const) {
      const raw = structuredClone(asfConfig()) as unknown as {
        asf: { harness: { backend: string } };
      };
      raw.asf.harness.backend = backend;
      expect(() => parseProductionModeConfig(raw)).toThrow(ProductionModeConfigError);
    }

    const backlog = structuredClone(asfConfig()) as unknown as {
      asf: { backlog: { selection_enabled: boolean } };
    };
    backlog.asf.backlog.selection_enabled = true;
    expect(() => parseProductionModeConfig(backlog)).toThrow(ProductionModeConfigError);

    const microvm = structuredClone(asfConfig()) as unknown as {
      asf: { sandbox: { mechanism: string } };
    };
    microvm.asf.sandbox.mechanism = "microvm";
    expect(() => parseProductionModeConfig(microvm)).toThrow(ProductionModeConfigError);

    const broker = structuredClone(asfConfig()) as unknown as {
      asf: { sandbox: { tools_network: Record<string, unknown> } };
    };
    broker.asf.sandbox.tools_network = {
      mode: "enforced-broker",
      policy_digest: `sha256:${"a".repeat(64)}`,
    };
    expect(() => parseProductionModeConfig(broker)).toThrow(ProductionModeConfigError);

    const proxy = structuredClone(asfConfig()) as unknown as {
      asf: { sandbox: { tools_network: { mode: string } } };
    };
    proxy.asf.sandbox.tools_network = { mode: "unrestricted-proxy" };
    expect(() => parseProductionModeConfig(proxy)).toThrow(ProductionModeConfigError);

    const verificationNetwork = structuredClone(asfConfig()) as unknown as {
      asf: { sandbox: { verification_network: string } };
    };
    verificationNetwork.asf.sandbox.verification_network = "enabled";
    expect(() => parseProductionModeConfig(verificationNetwork)).toThrow(
      ProductionModeConfigError,
    );

    for (const endpoint of [
      "https://ctxlane.example",
      "unix://relative.sock",
      "unix:////run/ctxlane/../automation.sock",
    ]) {
      const ctxlane = structuredClone(asfConfig()) as unknown as {
        asf: { ctxlane: { endpoint: string } };
      };
      ctxlane.asf.ctxlane.endpoint = endpoint;
      expect(() => parseProductionModeConfig(ctxlane)).toThrow(ProductionModeConfigError);
    }

    const credential = structuredClone(asfConfig()) as unknown as {
      asf: { github: Record<string, unknown> };
    };
    credential.asf.github["token"] = "must-not-live-in-policy";
    expect(() => parseProductionModeConfig(credential)).toThrow(ProductionModeConfigError);
  });

  it("enforces heartbeat, concurrency, and retention bounds", () => {
    const stale = structuredClone(asfConfig());
    stale.asf.worker.stale_after_ms = 10_000;
    expect(() => parseProductionModeConfig(stale)).toThrow(/three heartbeat intervals/u);

    const concurrency = structuredClone(asfConfig());
    concurrency.asf.worker.max_concurrency = 33;
    expect(() => parseProductionModeConfig(concurrency)).toThrow(ProductionModeConfigError);

    const retention = structuredClone(asfConfig());
    retention.asf.retention.protected_artifact_days = 0;
    expect(() => parseProductionModeConfig(retention)).toThrow(ProductionModeConfigError);
  });
});
