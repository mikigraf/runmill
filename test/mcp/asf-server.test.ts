import { afterEach, describe, expect, it, vi } from "vitest";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { deserializeAsfControlError } from "../../src/asf/control.js";
import {
  AsfMcpServer,
  ASF_MCP_CONTROL_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  serveAsfMcpTransport,
  type AsfDaemonControlClient,
  type JsonRpcResponse,
  type McpNdjsonTransport,
} from "../../src/mcp/asf-server.js";
import type { AsfControlRequest } from "../../src/daemon/control.js";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import type { WorkOrderEnvelope } from "../../src/asf/work-order.js";
import { buildAsfTerminalEffectLedger } from "../../src/evidence/asf-terminal-effects.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const BASE_SHA = "d".repeat(40);
const CANDIDATE_SHA = "e".repeat(40);

afterEach(() => {
  vi.useRealTimers();
});

function envelope(): WorkOrderEnvelope {
  return {
    schema: "asf.work-order-envelope/v1",
    key_id: "asf-key-1",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:00:00Z",
    not_before: "2026-08-21T10:00:00Z",
    expires_at: "2026-08-21T10:15:00Z",
    payload: {
      schema: "asf.work-order/v1",
      work_order_id: "wo-1",
      tenant_id: "tenant-1",
      work_item_id: "ENG-1",
      attempt_id: "attempt-1",
      idempotency_key: "tenant-1/ENG-1/attempt-1",
      source: { system: "linear", external_id: "ENG-1", snapshot_digest: DIGEST_A },
      repository: {
        forge: "github",
        repository: "acme/widgets",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: "Fix widgets",
        description: "Apply the immutable specification.",
        acceptance_criteria: ["widgets are fixed"],
        non_goals: [],
      },
      scope: {
        allowed_paths: ["src/**", "test/**"],
        forbidden_paths: [".github/**"],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["unit"],
        required_remote_checks: ["ci/test"],
        policy_snapshot_digest: DIGEST_B,
      },
      identities: {
        implementer: "provider:implementer",
        local_reviewer: "provider:local-reviewer",
        pr_reviewer: "provider:pr-reviewer",
      },
      runtime: {
        sandbox_profile: "linux-v1",
        tool_policy: "repo-v1",
        network_policy: "provider-v1",
      },
      budgets: {
        wall_seconds: 3_600,
        max_cost_usd: 10,
        max_agent_invocations: 10,
        max_fix_iterations: 2,
      },
      delivery: { closure_target: "pr", draft_pr: false, merge_policy_ref: null },
      policy_digest: DIGEST_B,
      harness_digest: DIGEST_C,
    },
    signature: "base64url:AA",
  };
}

function envelopePayloadDigest(): string {
  return sha256Digest(envelope().payload);
}

function runRow(runId = "run-1") {
  return {
    runId,
    issueId: "ENG-1",
    repo: "acme/widgets",
    provider: "provider:implementer",
    state: "ADMITTED",
    stateVersion: 12,
    attempt: 1,
    baseCommit: BASE_SHA,
    candidateSha: null,
    branch: null,
    mode: "asf-worker",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    generation: 0,
    ownerId: null,
    heartbeatAt: null,
  } as const;
}

function admission() {
  return {
    idempotencyKey: "tenant-1/ENG-1/attempt-1",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    tenantId: "tenant-1",
    payloadDigest: DIGEST_A,
    envelopeDigest: DIGEST_B,
    effectivePolicyDigest: DIGEST_C,
    signatureKeyId: "asf-key-1",
    signatureAlgorithm: "EdDSA",
    acceptedAt: "2026-08-21T10:05:00Z",
  } as const;
}

function event() {
  return {
    schema: "asf.run-event/v1",
    event_id: "event-12",
    run_id: "run-1",
    work_order_id: "wo-1",
    attempt_id: "attempt-1",
    seq: 12,
    occurred_at: "2026-08-21T10:05:00Z",
    type: "work_order.admitted",
    phase: "ADMITTED",
    payload: {
      work_order_id: "wo-1",
      attempt_id: "attempt-1",
      tenant_id: "tenant-1",
      payload_digest: DIGEST_A,
      envelope_digest: DIGEST_B,
      signature: { verified: true, key_id: "asf-key-1", algorithm: "EdDSA" },
    },
    policy_digest: DIGEST_C,
  } as const;
}

function cancellationRequest() {
  return {
    schema: "asf.cancellation-request/v1",
    request_id: "cancel-1",
    run_id: "run-1",
    requester: { subject: "service:asf-controller", authority: "asf:cancel" },
    reason: "the work item was superseded",
    mode: "forced",
    grace_seconds: 0,
  } as const;
}

function approvalEnvelope() {
  return {
    schema: "asf.approval-envelope/v1",
    key_id: "approval-key-1",
    algorithm: "EdDSA",
    payload: {
      schema: "asf.approval/v1",
      approval_id: "approval-1",
      work_order_id: "wo-1",
      work_order_digest: DIGEST_A,
      run_id: "run-1",
      attempt_id: "attempt-1",
      candidate_sha: "e".repeat(40),
      decision: "approved",
      decision_type: "delivery",
      requested_effect: "pull-request-delivery",
      policy_digest: DIGEST_C,
      approver: { subject: "operator:alice", authority: "repository:approve" },
      issued_at: "2026-08-21T10:00:00Z",
      expires_at: "2026-08-21T11:00:00Z",
    },
    signature: "base64url:AA",
  } as const;
}

function reconciliationRequest() {
  return {
    schema: "asf.reconciliation-request/v1",
    operation_id: "reconcile-1",
    run_id: "run-1",
    requested_by: {
      subject: "service:asf-controller",
      authority: "asf:reconcile",
    },
    scope: "pending-effects",
  } as const;
}

function outcomeAcknowledgement() {
  return {
    schema: "asf.outcome-acknowledgement/v1",
    acknowledgement_id: "ack-1",
    run_id: "run-1",
    bundle_digest: DIGEST_B,
    acknowledged_by: {
      subject: "service:asf-controller",
      authority: "asf:acknowledge-outcome",
    },
  } as const;
}

function healthResult() {
  const missing = {
    status: "refusing",
    observed_at: null,
    age_ms: null,
    reasons: ["observation.missing"],
    details: null,
  } as const;
  return {
    schema: "asf.health/v1",
    mode: "asf-worker",
    checked_at: "2026-08-21T10:05:00Z",
    probe_duration_ms: 4,
    status: "refusing",
    ready: false,
    components: {
      service: missing,
      database: missing,
      worker: missing,
      sandbox: missing,
      ctxlane: missing,
      github: missing,
      mcp: missing,
      backlog: missing,
    },
  } as const;
}

function evidenceArtifact() {
  return {
    artifactId: "artifact-runtime",
    kind: "runtime-manifest",
    digest: DIGEST_A,
    sizeBytes: 128,
    mediaType: "application/json",
    retentionClass: "portable",
    locationRef: `cas://sha256/${"a".repeat(64)}`,
  } as const;
}

function signedEvidenceBundle() {
  const artifact = evidenceArtifact();
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "github:acme/widgets", digest: { sha1: CANDIDATE_SHA } }],
    predicateType: "https://runmill.dev/attestations/asf-evidence/v1",
    predicate: {
      schema: "asf.evidence-bundle/v1",
      run: {
        run_id: "run-1",
        attempt_id: "attempt-1",
        work_order_id: "wo-1",
        completed_at: "2026-08-21T10:19:00Z",
      },
      work_order: {
        envelope_digest: DIGEST_A,
        payload_digest: DIGEST_B,
        envelope_artifact_digest: DIGEST_C,
        signature: { key_id: "asf-key-1", algorithm: "EdDSA", verified: true },
      },
      policy: {
        effective_policy_digest: DIGEST_C,
        effective_policy_artifact_digest: DIGEST_A,
        inputs: {
          operator_policy_digest: DIGEST_A,
          work_order_policy_digest: DIGEST_B,
          repository_policy_digest: DIGEST_C,
          forge_policy_digest: DIGEST_A,
        },
        required_local_checks: [],
        required_ci_contexts: [],
        require_local_review: false,
        require_pull_request_review: false,
      },
      source: {
        forge: "github",
        repository: "acme/widgets",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
        candidate_sha: CANDIDATE_SHA,
        remote_head_sha: CANDIDATE_SHA,
        merge_sha: null,
        tree_digest: DIGEST_A,
        normalized_diff_digest: DIGEST_B,
        normalized_diff_artifact_digest: DIGEST_C,
        changed_paths: [],
      },
      runtime: {
        harness_digest: DIGEST_A,
        tool_policy_digest: DIGEST_B,
        sandbox_profile_digest: DIGEST_C,
        dependency_digest: DIGEST_A,
        runtime_digest: DIGEST_B,
        runtime_manifest_digest: DIGEST_C,
        providers: [],
      },
      role_outcomes: [],
      verification: { local_checks: [], ci_contexts: [] },
      reviews: [],
      side_effects: [],
      approvals: [],
      cancellation: null,
      budget: {
        cost_usd: 1,
        agent_invocations: 1,
        fix_iterations: 0,
        elapsed_ms: 1_000,
        stop_reason: "pr-delivered",
      },
      delivery: {
        closure_target: "pr",
        satisfied: true,
        pull_request: {
          forge: "github",
          repository: "acme/widgets",
          number: 42,
          url: "https://github.com/acme/widgets/pull/42",
          head_ref: "refs/heads/runmill/run-1",
          base_ref: "refs/heads/main",
          head_sha: CANDIDATE_SHA,
          observed_at: "2026-08-21T10:18:00Z",
          evidence_digest: DIGEST_A,
        },
      },
      artifacts: [
        {
          artifact_id: artifact.artifactId,
          kind: artifact.kind,
          size_bytes: artifact.sizeBytes,
          media_type: artifact.mediaType,
          digest: artifact.digest,
          retention_class: artifact.retentionClass,
          location_ref: artifact.locationRef,
        },
      ],
    },
  } as const;
  return {
    schema: "asf.signed-evidence/v1",
    key_id: "worker-evidence-1",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:20:00Z",
    bundle_digest: sha256Digest(statement),
    statement,
    signature: "base64url:AA",
  } as const;
}

function finalEvidenceResult() {
  const signedBundle = signedEvidenceBundle();
  return {
    schema: "asf.evidence-view/v1",
    runId: "run-1",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    phase: "EVIDENCE_FINALIZED",
    candidateSha: CANDIDATE_SHA,
    policyDigest: DIGEST_C,
    latestSequence: 13,
    status: "finalizing",
    complete: false,
    bundleDigest: signedBundle.bundle_digest,
    terminalBundleDigest: null,
    artifacts: [evidenceArtifact()],
    latestEvent: null,
    signedBundle,
    signedTerminalBundle: null,
  } as const;
}

function currentEvidenceResult(runId = "run-1") {
  return {
    schema: "asf.evidence-view/v1",
    runId,
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    phase: "ADMITTED",
    candidateSha: null,
    policyDigest: DIGEST_C,
    latestSequence: 12,
    status: "current",
    complete: false,
    bundleDigest: null,
    terminalBundleDigest: null,
    artifacts: [],
    latestEvent: event(),
    signedBundle: null,
    signedTerminalBundle: null,
  } as const;
}

function stoppedTerminalEvidenceResult() {
  const terminalEnvelope = envelope();
  const terminalPolicy = {
    schema: "runmill.effective-policy/v1",
    digest: DIGEST_C,
    inputs: {
      operatorPolicy: DIGEST_A,
      workOrderPolicy: DIGEST_B,
      workOrderPayload: sha256Digest(terminalEnvelope.payload),
      harness: DIGEST_C,
      repositoryPolicy: DIGEST_A,
      repositoryPolicyBaseSha: BASE_SHA,
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: "e30=",
      observedBaseSha: BASE_SHA,
      forgeProtection: DIGEST_B,
      forgeProtectionBaseRef: "refs/heads/main",
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["unit"],
    requiredRemoteChecks: ["ci/test"],
    riskClass: "low",
    identities: {
      implementer: "provider:implementer",
      localReviewer: "provider:local-reviewer",
      prReviewer: "provider:pr-reviewer",
    },
    runtime: {
      sandboxProfile: "linux-v1",
      toolPolicy: "repo-v1",
      networkPolicy: "provider-v1",
    },
    budgets: {
      wallSeconds: 3_600,
      maxCostUsd: 10,
      maxAgentInvocations: 10,
      maxFixIterations: 2,
    },
    delivery: { closureTarget: "pr", draftPr: false },
  } as const;
  const events = Array.from({ length: 12 }, (_, index) => {
    const seq = index + 1;
    return {
      schema: "asf.run-event/v1" as const,
      event_id: `event-terminal-${seq}`,
      run_id: "run-1",
      work_order_id: "wo-1",
      attempt_id: "attempt-1",
      seq,
      occurred_at: "2026-08-21T10:05:00Z",
      type: index === 0 ? "work_order.admitted" : "lifecycle.observed",
      phase: index === 0 ? ("ADMITTED" as const) : ("IMPLEMENTING" as const),
      payload:
        index === 0
          ? {
              work_order_id: "wo-1",
              attempt_id: "attempt-1",
              tenant_id: "tenant-1",
              payload_digest: sha256Digest(terminalEnvelope.payload),
              envelope_digest: sha256Digest(terminalEnvelope),
              signature: {
                verified: true,
                key_id: terminalEnvelope.key_id,
                algorithm: "EdDSA",
              },
            }
          : { candidate_sha: null },
      policy_digest: DIGEST_C,
    };
  });
  const observations = events.map((event) => ({
    event_seq: event.seq,
    event_type: event.type,
    phase: event.phase,
    candidate_sha: null,
    event_digest: sha256Digest(event),
    evidence_refs: [],
  }));
  const providerUsage = {
    schema: "asf.provider-budget-evidence-summary/v1" as const,
    run_id: "run-1",
    work_order_id: "wo-1",
    attempt_id: "attempt-1",
    policy_digest: DIGEST_C,
    candidate_sha: null,
    usage: {
      max_cost_micros: 10_000_000,
      reported_actual_cost_micros: 0,
      settled_unknown_cost_micros: 0,
      outstanding_reserved_cost_micros: 0,
      conservative_cost_micros: 0,
      invocation_count: 0,
      completed_invocation_count: 0,
      settled_unknown_invocation_count: 0,
      outstanding_invocation_count: 0,
      denied_count: 0,
    },
    invocations: [],
    settlement_digests: [],
    ledger_digest: DIGEST_A,
  };
  const sideEffects = buildAsfTerminalEffectLedger({
    run_id: "run-1",
    work_order_id: "wo-1",
    attempt_id: "attempt-1",
    policy_digest: DIGEST_C,
    effects: [],
    reconciliations: [],
  });
  const statement = {
    _type: "https://in-toto.io/Statement/v1" as const,
    subject: [{ name: "asf-run:run-1", digest: { sha1: BASE_SHA } }],
    predicateType:
      "https://runmill.dev/attestations/asf-terminal-evidence/v1" as const,
    predicate: {
      schema: "asf.terminal-evidence/v1" as const,
      run: {
        run_id: "run-1",
        work_order_id: "wo-1",
        attempt_id: "attempt-1",
        terminal_phase: "REFUSED" as const,
        terminal_event_seq: 13,
      },
      admission: {
        work_order_envelope_digest: sha256Digest(terminalEnvelope),
        work_order_payload_digest: sha256Digest(terminalEnvelope.payload),
        effective_policy_digest: DIGEST_C,
        work_order_envelope: terminalEnvelope,
        signature_verification: {
          verified: true as const,
          key_id: terminalEnvelope.key_id,
          algorithm: "EdDSA" as const,
        },
        effective_policy: terminalPolicy,
      },
      source: {
        repository: "acme/widgets",
        base_sha: BASE_SHA,
        candidate_sha: null,
        subject_kind: "base" as const,
        subject_sha: BASE_SHA,
      },
      stop: {
        code: "CHANGE_SCOPE_REFUSED",
        summary: "candidate changes exceed the admitted path scope",
        interrupted_phase: "ADMITTED",
        retry_disposition: "new-attempt-required" as const,
        required_actor: "asf" as const,
        required_action: "submit a new signed Work Order",
        evidence_refs: [DIGEST_A],
      },
      cancellation: null,
      budget: {
        wall_seconds_limit: 3600,
        max_cost_usd: 10,
        max_agent_invocations: 8,
        max_fix_iterations: 2,
        observed_fix_iterations: 0,
        evidence_refs: [],
        provider_usage: providerUsage,
      },
      timing: {
        admitted_at: "2026-08-21T10:05:00Z",
        terminal_evidence_at: "2026-08-21T10:19:00Z",
        elapsed_ms: 840_000,
      },
      cleanup: {
        intent_id: "cleanup-1",
        intent_digest: DIGEST_A,
        observation_digest: DIGEST_B,
        identity_leases: "released" as const,
        repository_lease: "released" as const,
        workspace: "removed" as const,
        unresolved_effects: 0 as const,
      },
      side_effects: sideEffects,
      evidence: {
        preceding_event_count: 12,
        preceding_event_chain_digest: sha256Digest(events),
        observations,
        events,
        delivery_bundle_digest: null,
      },
    },
  };
  const terminalBundleDigest = sha256Digest(statement);
  return {
    schema: "asf.evidence-view/v1",
    runId: "run-1",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    phase: "REFUSED",
    candidateSha: null,
    policyDigest: DIGEST_C,
    latestSequence: 13,
    status: "stopped",
    complete: true,
    bundleDigest: null,
    terminalBundleDigest,
    artifacts: [],
    latestEvent: {
      schema: "asf.run-event/v1",
      event_id: "evt-terminal-13",
      run_id: "run-1",
      work_order_id: "wo-1",
      attempt_id: "attempt-1",
      seq: 13,
      occurred_at: "2026-08-21T10:20:00Z",
      type: "run.refused",
      phase: "REFUSED",
      payload: {
        code: "CHANGE_SCOPE_REFUSED",
        summary: "candidate changes exceed the admitted path scope",
        checkpoint: "ADMITTED",
        retry_disposition: "new-attempt-required",
        required_actor: "asf",
        required_action: "submit a new signed Work Order",
        evidence_refs: [DIGEST_A],
        terminal_evidence_bundle_digest: terminalBundleDigest,
      },
      policy_digest: DIGEST_C,
    },
    signedBundle: null,
    signedTerminalBundle: {
      schema: "asf.signed-terminal-evidence/v1",
      key_id: "worker-evidence-1",
      algorithm: "EdDSA",
      issued_at: "2026-08-21T10:19:00Z",
      bundle_digest: terminalBundleDigest,
      statement,
      signature: "base64url:AA",
    },
  } as const;
}

function daemon(calls: AsfControlRequest[]): AsfDaemonControlClient {
  return async (request) => {
    calls.push(request);
    switch (request.type) {
      case "asf.submit_work_order":
        return {
          runId: "run-1",
          disposition: "accepted",
          payloadDigest: envelopePayloadDigest(),
        };
      case "asf.get_run":
        return { run: runRow(request.runId), admission: admission(), latestSequence: 12 };
      case "asf.lookup_submission":
        return {
          disposition: "found",
          run: runRow(),
          admission: {
            ...admission(),
            idempotencyKey: request.idempotencyKey,
            payloadDigest: request.payloadDigest,
            envelopeDigest: request.envelopeDigest,
          },
          latestSequence: 12,
        };
      case "asf.list_run_events":
        {
          const after = request.after ?? 0;
          const gap = after < 11;
        return {
          events: after < 12 ? [event()] : [],
          nextCursor: 12,
          hasMore: false,
          gap,
          compactedThrough: gap ? 11 : null,
          snapshot: { run: runRow(request.runId), latestSequence: 12 },
        };
        }
      case "asf.get_evidence":
        return currentEvidenceResult(request.runId);
      case "asf.request_cancel":
        return {
          requestId: request.request.request_id,
          runId: request.request.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 1,
          requestDigest: sha256Digest(request.request),
          reconciliationRequired: true,
        };
      case "asf.record_approval":
        return {
          approvalId: request.envelope.payload.approval_id,
          runId: request.envelope.payload.run_id,
          decision: request.envelope.payload.decision,
          disposition: "recorded",
          envelopeDigest: sha256Digest(request.envelope),
        };
      case "asf.reconcile_run":
        return {
          operationId: request.request.operation_id,
          runId: request.request.run_id,
          disposition: "queued",
          status: "queued",
          requestDigest: sha256Digest(request.request),
          requestedAt: "2026-08-21T10:05:00Z",
        };
      case "asf.acknowledge_outcome":
        return {
          acknowledgementId: request.acknowledgement.acknowledgement_id,
          runId: request.acknowledgement.run_id,
          bundleDigest: request.acknowledgement.bundle_digest,
          disposition: "recorded",
          acknowledgedAt: "2026-08-21T10:05:00Z",
        };
      case "asf.health":
        return healthResult();
    }
  };
}

function request(id: number, method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

async function ready(server: AsfMcpServer): Promise<void> {
  const initialized = await server.handleMessage(
    request(1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "test-client",
        title: "Test Client",
        version: "1.0.0",
        description: "Exercises the MCP boundary.",
        websiteUrl: "https://example.test/client",
        icons: [{ src: "data:image/png;base64,AA", mimeType: "image/png", sizes: ["48x48"] }],
      },
    }),
  );
  expect(initialized).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });
  await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function rpcResult(response: JsonRpcResponse | undefined): any {
  expect(response).toBeDefined();
  expect(response).not.toHaveProperty("error");
  return (response as { result: unknown }).result;
}

async function callTool(
  server: AsfMcpServer,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<any> {
  return rpcResult(
    await server.handleMessage(
      request(20, "tools/call", { name, arguments: args }),
    ),
  );
}

async function expectInvalidServiceResponse(input: {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: unknown;
}): Promise<void> {
  const server = new AsfMcpServer({ controlClient: async () => input.result });
  await ready(server);
  expect(await callTool(server, input.name, input.arguments)).toMatchObject({
    isError: true,
    structuredContent: { code: "invalid_service_response" },
  });
}

describe("AsfMcpServer protocol", () => {
  it("negotiates the pinned MCP revision and advertises only the ten bounded tools", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    const result = rpcResult(await server.handleMessage(request(2, "tools/list", {})));
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "runmill_submit_work_order",
      "runmill_get_run",
      "runmill_lookup_submission",
      "runmill_list_run_events",
      "runmill_get_evidence",
      "runmill_request_cancel",
      "runmill_record_approval",
      "runmill_reconcile_run",
      "runmill_acknowledge_outcome",
      "runmill_health",
    ]);
    expect(result.tools.every((tool: any) => tool.inputSchema.additionalProperties === false)).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /merge_now|host_shell|github\.request|provider_token|arbitrary_command/i,
    );
    expect(calls).toEqual([]);
  });

  it("requires the completed initialization handshake", async () => {
    const server = new AsfMcpServer({ controlClient: daemon([]) });

    const before = await server.handleMessage(request(1, "tools/list", {}));
    expect(before).toMatchObject({ error: { code: -32002 } });
    await server.handleMessage(
      request(2, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      }),
    );
    const during = await server.handleMessage(request(3, "tools/list", {}));
    expect(during).toMatchObject({ error: { code: -32002 } });
    await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(await server.handleMessage(request(4, "tools/list", {}))).toHaveProperty("result");
  });

  it("maps all tool calls to the private daemon protocol and returns strict public results", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    const submitted = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_submit_work_order",
          arguments: { envelope: envelope() },
        }),
      ),
    );
    expect(submitted).toMatchObject({
      isError: false,
      structuredContent: {
        run_id: "run-1",
        disposition: "accepted",
        payload_digest: envelopePayloadDigest(),
      },
    });

    const snapshot = rpcResult(
      await server.handleMessage(
        request(3, "tools/call", {
          name: "runmill_get_run",
          arguments: { run_id: "run-1" },
        }),
      ),
    );
    expect(snapshot.structuredContent).toMatchObject({
      run_id: "run-1",
      work_order_id: "wo-1",
      state: "ADMITTED",
      outcome: null,
      latest_sequence: 12,
      admission: { tenant_id: "tenant-1" },
    });
    expect(snapshot.structuredContent).not.toHaveProperty("ownerId");

    const recovered = rpcResult(
      await server.handleMessage(
        request(4, "tools/call", {
          name: "runmill_lookup_submission",
          arguments: {
            idempotency_key: "tenant-1/ENG-1/attempt-1",
            payload_digest: DIGEST_A,
            envelope_digest: DIGEST_B,
          },
        }),
      ),
    );
    expect(recovered.structuredContent).toMatchObject({
      disposition: "found",
      run: { run_id: "run-1", admission: { idempotency_key: "tenant-1/ENG-1/attempt-1" } },
    });

    expect(calls).toEqual([
      { type: "asf.submit_work_order", envelope: envelope() },
      { type: "asf.get_run", runId: "run-1" },
      {
        type: "asf.lookup_submission",
        idempotencyKey: "tenant-1/ENG-1/attempt-1",
        payloadDigest: DIGEST_A,
        envelopeDigest: DIGEST_B,
      },
    ]);
  });

  it("maps evidence and every bounded control-plane tool without widening authority", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    const toolCalls = [
      {
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        expected: { run_id: "run-1", status: "current", complete: false },
      },
      {
        name: "runmill_request_cancel",
        arguments: { request: cancellationRequest() },
        expected: { request_id: "cancel-1", state: "CANCEL_REQUESTED" },
      },
      {
        name: "runmill_record_approval",
        arguments: { envelope: approvalEnvelope() },
        expected: { approval_id: "approval-1", decision: "approved" },
      },
      {
        name: "runmill_reconcile_run",
        arguments: { request: reconciliationRequest() },
        expected: { operation_id: "reconcile-1", status: "queued" },
      },
      {
        name: "runmill_acknowledge_outcome",
        arguments: { acknowledgement: outcomeAcknowledgement() },
        expected: { acknowledgement_id: "ack-1", bundle_digest: DIGEST_B },
      },
      {
        name: "runmill_health",
        arguments: {},
        expected: { schema: "asf.health/v1", mode: "asf-worker", ready: false },
      },
    ] as const;

    for (const [index, toolCall] of toolCalls.entries()) {
      const result = rpcResult(
        await server.handleMessage(
          request(10 + index, "tools/call", {
            name: toolCall.name,
            arguments: toolCall.arguments,
          }),
        ),
      );
      expect(result).toMatchObject({ isError: false });
      expect(result.structuredContent).toMatchObject(toolCall.expected);
    }

    expect(calls).toEqual([
      { type: "asf.get_evidence", runId: "run-1" },
      { type: "asf.request_cancel", request: cancellationRequest() },
      { type: "asf.record_approval", envelope: approvalEnvelope() },
      { type: "asf.reconcile_run", request: reconciliationRequest() },
      {
        type: "asf.acknowledge_outcome",
        acknowledgement: outcomeAcknowledgement(),
      },
      { type: "asf.health" },
    ]);
    expect(JSON.stringify(toolCalls)).not.toMatch(/merge_now|arbitrary_command|token/iu);
  });

  it("keeps an idempotency or digest mismatch indistinguishable from an unknown submission", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({
      controlClient: async (request) => {
        calls.push(request);
        return { disposition: "not-found" };
      },
    });
    await ready(server);

    const result = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_lookup_submission",
          arguments: {
            idempotency_key: "tenant-1/ENG-1/attempt-1",
            payload_digest: DIGEST_A,
            envelope_digest: DIGEST_B,
          },
        }),
      ),
    );
    expect(result.structuredContent).toEqual({ disposition: "not-found" });
    expect(JSON.stringify(result)).not.toContain("run-1");
    expect(calls).toEqual([
      {
        type: "asf.lookup_submission",
        idempotencyKey: "tenant-1/ENG-1/attempt-1",
        payloadDigest: DIGEST_A,
        envelopeDigest: DIGEST_B,
      },
    ]);
  });

  it("keeps numeric control cursors behind opaque, run-bound MCP cursors", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    const first = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_list_run_events",
          arguments: { run_id: "run-1", limit: 25 },
        }),
      ),
    ).structuredContent;
    expect(first).toMatchObject({
      events: [{ run_id: "run-1", seq: 12 }],
      has_more: false,
      gap: true,
      snapshot: { latest_sequence: 12 },
    });
    expect(first.next_cursor).toMatch(/^runmill-event-v1\.[A-Za-z0-9_-]+$/);
    expect(first.compacted_through_cursor).toMatch(/^runmill-event-v1\./);
    expect(first).not.toHaveProperty("nextCursor");
    expect(first).not.toHaveProperty("compactedThrough");

    await server.handleMessage(
      request(3, "tools/call", {
        name: "runmill_list_run_events",
        arguments: { run_id: "run-1", cursor: first.next_cursor },
      }),
    );
    expect(calls).toEqual([
      { type: "asf.list_run_events", runId: "run-1", limit: 25 },
      { type: "asf.list_run_events", runId: "run-1", after: 12 },
    ]);
  });

  it("refuses unknown tools and strict argument violations without daemon authority", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    const unknown = await server.handleMessage(
      request(2, "tools/call", { name: "shell", arguments: {} }),
    );
    expect(unknown).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });

    const extra = rpcResult(
      await server.handleMessage(
        request(3, "tools/call", {
          name: "runmill_get_run",
          arguments: { run_id: "run-1", arbitrary: "value" },
        }),
      ),
    );
    expect(extra).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_tool_arguments" },
    });
    const numericCursor = rpcResult(
      await server.handleMessage(
        request(4, "tools/call", {
          name: "runmill_list_run_events",
          arguments: { run_id: "run-1", cursor: 12 },
        }),
      ),
    );
    expect(numericCursor).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it("rejects every unadvertised authority and extra fields on all ten tools", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);

    for (const name of [
      "merge_now",
      "runmill_merge_now",
      "shell",
      "runmill_shell",
      "github.request",
      "runmill_github_request",
      "runmill_provider_credentials",
      "runmill_select_backlog",
    ]) {
      expect(
        await server.handleMessage(
          request(4, "tools/call", { name, arguments: { command: "rm -rf repo" } }),
        ),
      ).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });
    }

    const strictCalls = [
      ["runmill_submit_work_order", { envelope: envelope() }],
      ["runmill_get_run", { run_id: "run-1" }],
      [
        "runmill_lookup_submission",
        {
          idempotency_key: "tenant-acme/ENG-123/attempt_01",
          payload_digest: DIGEST_A,
          envelope_digest: DIGEST_B,
        },
      ],
      ["runmill_list_run_events", { run_id: "run-1" }],
      ["runmill_get_evidence", { run_id: "run-1" }],
      ["runmill_request_cancel", { request: cancellationRequest() }],
      ["runmill_record_approval", { envelope: approvalEnvelope() }],
      ["runmill_reconcile_run", { request: reconciliationRequest() }],
      ["runmill_acknowledge_outcome", { acknowledgement: outcomeAcknowledgement() }],
      ["runmill_health", {}],
    ] as const;
    for (const [name, validArguments] of strictCalls) {
      const result = await callTool(server, name, {
        ...validArguments,
        provider_credentials: { token: "must-not-be-forwarded" },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "invalid_tool_arguments" },
      });
      expect(JSON.stringify(result)).not.toContain("must-not-be-forwarded");
    }
    expect(calls).toEqual([]);
  });

  it("rejects malformed and cross-run cursors before touching the daemon", async () => {
    const calls: AsfControlRequest[] = [];
    const server = new AsfMcpServer({ controlClient: daemon(calls) });
    await ready(server);
    const listed = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_list_run_events",
          arguments: { run_id: "run-1" },
        }),
      ),
    ).structuredContent;
    calls.length = 0;

    for (const cursor of ["0", "runmill-event-v2.invalid", listed.next_cursor]) {
      const runId = cursor === listed.next_cursor ? "run-2" : "run-1";
      const result = rpcResult(
        await server.handleMessage(
          request(3, "tools/call", {
            name: "runmill_list_run_events",
            arguments: { run_id: runId, cursor },
          }),
        ),
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "invalid_tool_arguments" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("binds submission and run snapshots to the exact request and durable admission", async () => {
    await expectInvalidServiceResponse({
      name: "runmill_submit_work_order",
      arguments: { envelope: envelope() },
      result: { runId: "run-1", disposition: "accepted", payloadDigest: DIGEST_A },
    });

    const base = { run: runRow(), admission: admission(), latestSequence: 12 };
    for (const result of [
      { ...base, run: runRow("run-other") },
      { ...base, admission: { ...admission(), workOrderId: "wo-other" } },
      { ...base, admission: { ...admission(), attemptId: "attempt-other" } },
      { ...base, latestSequence: 11 },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_get_run",
        arguments: { run_id: "run-1" },
        result,
      });
    }
  });

  it("binds cancellation, approval, and acknowledgement results to exact inputs", async () => {
    const cancel = cancellationRequest();
    const cancellationBase = {
      requestId: cancel.request_id,
      runId: cancel.run_id,
      disposition: "requested",
      state: "CANCEL_REQUESTED",
      generation: 1,
      requestDigest: sha256Digest(cancel),
      reconciliationRequired: true,
    } as const;
    for (const result of [
      { ...cancellationBase, requestId: "cancel-other" },
      { ...cancellationBase, runId: "run-other" },
      { ...cancellationBase, requestDigest: DIGEST_A },
      { ...cancellationBase, state: "ADMITTED" },
      { ...cancellationBase, disposition: "already-terminal", state: "ADMITTED" },
      { ...cancellationBase, disposition: "existing", state: "COMPLETED" },
      { ...cancellationBase, reconciliationRequired: false },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_request_cancel",
        arguments: { request: cancel },
        result,
      });
    }

    const terminalCancellation = new AsfMcpServer({
      controlClient: async () => ({
        ...cancellationBase,
        disposition: "already-terminal",
        state: "COMPLETED",
        reconciliationRequired: false,
      }),
    });
    await ready(terminalCancellation);
    expect(
      await callTool(terminalCancellation, "runmill_request_cancel", { request: cancel }),
    ).toMatchObject({
      isError: false,
      structuredContent: {
        disposition: "already-terminal",
        state: "COMPLETED",
        reconciliation_required: false,
      },
    });

    const reconciledCancellation = new AsfMcpServer({
      controlClient: async () => ({
        ...cancellationBase,
        disposition: "existing",
        state: "CANCELLING",
        reconciliationRequired: false,
      }),
    });
    await ready(reconciledCancellation);
    expect(
      await callTool(reconciledCancellation, "runmill_request_cancel", {
        request: cancel,
      }),
    ).toMatchObject({
      isError: false,
      structuredContent: {
        disposition: "existing",
        state: "CANCELLING",
        reconciliation_required: false,
      },
    });

    const approval = approvalEnvelope();
    const approvalBase = {
      approvalId: approval.payload.approval_id,
      runId: approval.payload.run_id,
      decision: approval.payload.decision,
      disposition: "recorded",
      envelopeDigest: sha256Digest(approval),
    } as const;
    for (const result of [
      { ...approvalBase, approvalId: "approval-other" },
      { ...approvalBase, runId: "run-other" },
      { ...approvalBase, decision: "denied" },
      { ...approvalBase, envelopeDigest: DIGEST_A },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_record_approval",
        arguments: { envelope: approval },
        result,
      });
    }

    const acknowledgement = outcomeAcknowledgement();
    const acknowledgementBase = {
      acknowledgementId: acknowledgement.acknowledgement_id,
      runId: acknowledgement.run_id,
      bundleDigest: acknowledgement.bundle_digest,
      disposition: "recorded",
      acknowledgedAt: "2026-08-21T10:05:00Z",
    } as const;
    for (const result of [
      { ...acknowledgementBase, acknowledgementId: "ack-other" },
      { ...acknowledgementBase, runId: "run-other" },
      { ...acknowledgementBase, bundleDigest: DIGEST_C },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_acknowledge_outcome",
        arguments: { acknowledgement },
        result,
      });
    }
  });

  it("preserves canonical existing reconciliation while rejecting impossible result semantics", async () => {
    const reconciliation = reconciliationRequest();
    const priorDigest = sha256Digest({ prior: "reconciliation" });
    const server = new AsfMcpServer({
      controlClient: async () => ({
        operationId: "reconcile-active",
        runId: reconciliation.run_id,
        disposition: "existing",
        status: "running",
        requestDigest: priorDigest,
        requestedAt: "2026-08-21T10:04:00Z",
      }),
    });
    await ready(server);
    expect(
      await callTool(server, "runmill_reconcile_run", { request: reconciliation }),
    ).toMatchObject({
      isError: false,
      structuredContent: {
        operation_id: "reconcile-active",
        disposition: "existing",
        status: "running",
        request_digest: priorDigest,
      },
    });

    const exactDigest = sha256Digest(reconciliation);
    const base = {
      operationId: reconciliation.operation_id,
      runId: reconciliation.run_id,
      disposition: "queued",
      status: "queued",
      requestDigest: exactDigest,
      requestedAt: "2026-08-21T10:05:00Z",
    } as const;
    for (const result of [
      { ...base, runId: "run-other" },
      { ...base, requestDigest: DIGEST_A },
      { ...base, operationId: "reconcile-other" },
      { ...base, status: "completed" },
      { ...base, disposition: "nothing-to-reconcile", status: "queued" },
      {
        ...base,
        operationId: "reconcile-active",
        disposition: "existing",
        status: "completed",
        requestDigest: priorDigest,
      },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_reconcile_run",
        arguments: { request: reconciliation },
        result,
      });
    }

    const replay = new AsfMcpServer({
      controlClient: async () => ({ ...base, disposition: "existing", status: "completed" }),
    });
    await ready(replay);
    expect(
      await callTool(replay, "runmill_reconcile_run", { request: reconciliation }),
    ).toMatchObject({ isError: false, structuredContent: { disposition: "existing" } });

    const nothing = new AsfMcpServer({
      controlClient: async () => ({
        ...base,
        disposition: "nothing-to-reconcile",
        status: "completed",
      }),
    });
    await ready(nothing);
    expect(
      await callTool(nothing, "runmill_reconcile_run", { request: reconciliation }),
    ).toMatchObject({
      isError: false,
      structuredContent: { disposition: "nothing-to-reconcile", status: "completed" },
    });
  });

  it("accepts a bound final bundle and refuses current/final evidence contradictions", async () => {
    const finalServer = new AsfMcpServer({ controlClient: async () => finalEvidenceResult() });
    await ready(finalServer);
    expect(
      await callTool(finalServer, "runmill_get_evidence", { run_id: "run-1" }),
    ).toMatchObject({
      isError: false,
      structuredContent: {
        phase: "EVIDENCE_FINALIZED",
        status: "finalizing",
        complete: false,
        candidate_sha: CANDIDATE_SHA,
      },
    });

    const final = finalEvidenceResult();
    for (const result of [
      { ...currentEvidenceResult(), runId: "run-other" },
      {
        ...currentEvidenceResult(),
        phase: "REFUSED",
        status: "current",
        latestEvent: null,
      },
      {
        ...currentEvidenceResult(),
        phase: "ADMITTED",
        status: "stopped",
        latestEvent: null,
      },
      { ...final, status: "current", complete: false },
      { ...final, signedBundle: null, bundleDigest: null, artifacts: [] },
      {
        ...currentEvidenceResult(),
        phase: "IMPLEMENTING",
      },
      {
        ...currentEvidenceResult(),
        latestEvent: { ...event(), policy_digest: DIGEST_B },
      },
      {
        ...currentEvidenceResult(),
        latestEvent: { ...event(), work_order_id: "wo-other" },
      },
      {
        ...currentEvidenceResult(),
        latestEvent: { ...event(), run_id: "run-other" },
      },
      {
        ...currentEvidenceResult(),
        latestEvent: { ...event(), attempt_id: "attempt-other" },
      },
      {
        ...currentEvidenceResult(),
        latestEvent: { ...event(), event_id: "event-11", seq: 11 },
      },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result,
      });
    }
  });

  it("refuses signed evidence whose candidate, policy, run, digest, or artifacts drift", async () => {
    const statementMutations: readonly ((result: any) => void)[] = [
      (result) => {
        result.signedBundle.statement.subject[0].digest.sha1 = "f".repeat(40);
      },
      (result) => {
        result.signedBundle.statement.predicate.run.run_id = "run-other";
      },
      (result) => {
        result.signedBundle.statement.predicate.run.work_order_id = "wo-other";
      },
      (result) => {
        result.signedBundle.statement.predicate.run.attempt_id = "attempt-other";
      },
      (result) => {
        result.signedBundle.statement.predicate.source.remote_head_sha = "f".repeat(40);
      },
      (result) => {
        result.signedBundle.statement.predicate.delivery.pull_request.head_sha = "f".repeat(40);
      },
      (result) => {
        result.signedBundle.statement.predicate.policy.effective_policy_digest = DIGEST_B;
      },
    ];
    for (const mutate of statementMutations) {
      const result: any = structuredClone(finalEvidenceResult());
      mutate(result);
      result.signedBundle.bundle_digest = sha256Digest(result.signedBundle.statement);
      result.bundleDigest = result.signedBundle.bundle_digest;
      await expectInvalidServiceResponse({
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result,
      });
    }

    const artifactMutations: readonly ((result: any) => void)[] = [
      (result) => {
        result.artifacts[0].artifactId = "artifact-other";
      },
      (result) => {
        result.artifacts[0].kind = "verification";
      },
      (result) => {
        result.artifacts[0].digest = DIGEST_B;
      },
      (result) => {
        result.artifacts[0].sizeBytes = 129;
      },
      (result) => {
        result.artifacts[0].mediaType = "text/plain";
      },
      (result) => {
        result.artifacts[0].retentionClass = "restricted";
      },
      (result) => {
        result.artifacts[0].locationRef = `cas://sha256/${"b".repeat(64)}`;
      },
    ];
    for (const mutate of artifactMutations) {
      const result: any = structuredClone(finalEvidenceResult());
      mutate(result);
      await expectInvalidServiceResponse({
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result,
      });
    }

    const badLocation: any = structuredClone(finalEvidenceResult());
    const wrongLocation = `cas://sha256/${"b".repeat(64)}`;
    badLocation.artifacts[0].locationRef = wrongLocation;
    badLocation.signedBundle.statement.predicate.artifacts[0].location_ref = wrongLocation;
    badLocation.signedBundle.bundle_digest = sha256Digest(badLocation.signedBundle.statement);
    badLocation.bundleDigest = badLocation.signedBundle.bundle_digest;
    await expectInvalidServiceResponse({
      name: "runmill_get_evidence",
      arguments: { run_id: "run-1" },
      result: badLocation,
    });

    for (const result of [
      { ...finalEvidenceResult(), bundleDigest: DIGEST_B },
      {
        ...finalEvidenceResult(),
        signedBundle: { ...signedEvidenceBundle(), bundle_digest: DIGEST_B },
        bundleDigest: DIGEST_B,
      },
    ]) {
      await expectInvalidServiceResponse({
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result,
      });
    }
  });

  it("accepts complete pre-candidate terminal evidence and rejects event or bundle drift", async () => {
    const accepted = stoppedTerminalEvidenceResult();
    const server = new AsfMcpServer({ controlClient: async () => accepted });
    await ready(server);
    expect(
      await callTool(server, "runmill_get_evidence", { run_id: "run-1" }),
    ).toMatchObject({
      isError: false,
      structuredContent: {
        phase: "REFUSED",
        status: "stopped",
        complete: true,
        candidate_sha: null,
        terminal_bundle_digest: accepted.terminalBundleDigest,
      },
    });

    const mismatches: unknown[] = [];
    const wrongEventDigest: any = structuredClone(accepted);
    wrongEventDigest.latestEvent.payload.terminal_evidence_bundle_digest = DIGEST_A;
    mismatches.push(wrongEventDigest);
    const wrongRecordDigest: any = structuredClone(accepted);
    wrongRecordDigest.terminalBundleDigest = DIGEST_A;
    mismatches.push(wrongRecordDigest);
    const wrongCandidate: any = structuredClone(accepted);
    wrongCandidate.candidateSha = CANDIDATE_SHA;
    mismatches.push(wrongCandidate);
    const incomplete: any = structuredClone(accepted);
    incomplete.complete = false;
    mismatches.push(incomplete);
    const missingObservation: any = structuredClone(accepted);
    missingObservation.signedTerminalBundle.statement.predicate.evidence.observations.pop();
    missingObservation.signedTerminalBundle.bundle_digest = sha256Digest(
      missingObservation.signedTerminalBundle.statement,
    );
    missingObservation.terminalBundleDigest =
      missingObservation.signedTerminalBundle.bundle_digest;
    missingObservation.latestEvent.payload.terminal_evidence_bundle_digest =
      missingObservation.terminalBundleDigest;
    mismatches.push(missingObservation);
    for (const result of mismatches) {
      await expectInvalidServiceResponse({
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result,
      });
    }
  });

  it("fails closed on malformed or contradictory health results without exposing details", async () => {
    const contradictory = structuredClone(healthResult()) as any;
    contradictory.status = "ready";
    contradictory.ready = true;
    const leaked = structuredClone(healthResult()) as any;
    leaked.components.github.provider_token = "health-secret";
    const componentContradiction = structuredClone(healthResult()) as any;
    componentContradiction.components.worker.status = "degraded";

    for (const result of [contradictory, leaked, componentContradiction, { status: "ready" }]) {
      const server = new AsfMcpServer({ controlClient: async () => result });
      await ready(server);
      const response = await callTool(server, "runmill_health", {});
      expect(response).toMatchObject({
        isError: true,
        structuredContent: { code: "invalid_service_response" },
      });
      expect(JSON.stringify(response)).not.toContain("health-secret");
    }
  });

  it("rejects secret-bearing unknown fields in every daemon result", async () => {
    const cancel = cancellationRequest();
    const approval = approvalEnvelope();
    const reconciliation = reconciliationRequest();
    const acknowledgement = outcomeAcknowledgement();
    const cases = [
      {
        name: "runmill_submit_work_order",
        arguments: { envelope: envelope() },
        result: {
          runId: "run-1",
          disposition: "accepted",
          payloadDigest: envelopePayloadDigest(),
        },
      },
      {
        name: "runmill_get_run",
        arguments: { run_id: "run-1" },
        result: { run: runRow(), admission: admission(), latestSequence: 12 },
      },
      {
        name: "runmill_list_run_events",
        arguments: { run_id: "run-1" },
        result: {
          events: [event()],
          nextCursor: 12,
          hasMore: false,
          gap: true,
          compactedThrough: 11,
          snapshot: { run: runRow(), latestSequence: 12 },
        },
      },
      {
        name: "runmill_get_evidence",
        arguments: { run_id: "run-1" },
        result: currentEvidenceResult(),
      },
      {
        name: "runmill_request_cancel",
        arguments: { request: cancel },
        result: {
          requestId: cancel.request_id,
          runId: cancel.run_id,
          disposition: "requested",
          state: "CANCEL_REQUESTED",
          generation: 1,
          requestDigest: sha256Digest(cancel),
          reconciliationRequired: true,
        },
      },
      {
        name: "runmill_record_approval",
        arguments: { envelope: approval },
        result: {
          approvalId: approval.payload.approval_id,
          runId: approval.payload.run_id,
          decision: approval.payload.decision,
          disposition: "recorded",
          envelopeDigest: sha256Digest(approval),
        },
      },
      {
        name: "runmill_reconcile_run",
        arguments: { request: reconciliation },
        result: {
          operationId: reconciliation.operation_id,
          runId: reconciliation.run_id,
          disposition: "queued",
          status: "queued",
          requestDigest: sha256Digest(reconciliation),
          requestedAt: "2026-08-21T10:05:00Z",
        },
      },
      {
        name: "runmill_acknowledge_outcome",
        arguments: { acknowledgement },
        result: {
          acknowledgementId: acknowledgement.acknowledgement_id,
          runId: acknowledgement.run_id,
          bundleDigest: acknowledgement.bundle_digest,
          disposition: "recorded",
          acknowledgedAt: "2026-08-21T10:05:00Z",
        },
      },
      {
        name: "runmill_health",
        arguments: {},
        result: healthResult(),
      },
    ] as const;

    for (const item of cases) {
      const response = await (async () => {
        const server = new AsfMcpServer({
          controlClient: async () => ({
            ...item.result,
            providerToken: "daemon-super-secret",
          }),
        });
        await ready(server);
        return callTool(server, item.name, item.arguments);
      })();
      expect(response).toMatchObject({
        isError: true,
        structuredContent: { code: "invalid_service_response" },
      });
      expect(JSON.stringify(response)).not.toContain("daemon-super-secret");
    }
  });

  it("maps catalogued failures to safe structured tool errors", async () => {
    const server = new AsfMcpServer({
      controlClient: async () => {
        throw RunmillError.fromCatalog("RM-CI-002", {
          whatHappened: "required CI evidence includes provider-token-secret",
          runId: "run-1",
          resumeFrom: "CI_WAIT",
          cause: {
            required_action: "rotate provider-token-secret",
            evidence_refs: ["provider-token-secret"],
          },
        });
      },
    });
    await ready(server);

    const result = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_get_run",
          arguments: { run_id: "run-1" },
        }),
      ),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        schema: "runmill.mcp-tool-error/v1",
        code: "RM-CI-002",
        message: "Runmill service rejected the request.",
        run_id: "run-1",
        checkpoint: "CI_WAIT",
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider-token-secret");
  });

  it("does not expose an unrecognized checkpoint from a catalogued failure", async () => {
    const server = new AsfMcpServer({
      controlClient: async () => {
        throw RunmillError.fromCatalog("RM-CI-002", {
          whatHappened: "Required CI evidence is unavailable.",
          runId: "run-1",
          resumeFrom: "provider-token-secret",
        });
      },
    });
    await ready(server);

    const result = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_get_run",
          arguments: { run_id: "run-1" },
        }),
      ),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        schema: "runmill.mcp-tool-error/v1",
        code: "RM-CI-002",
        checkpoint: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider-token-secret");
  });

  it("does not trust daemon-supplied error codes or cross-run identifiers as public text", async () => {
    for (const code of ["provider-token-secret", "RM-SECRET-999", "RM-CI-002"]) {
      const server = new AsfMcpServer({
        controlClient: async () => {
          throw deserializeAsfControlError({
            schema: "asf.control-error/v1",
            code,
            title: "provider-token-secret",
            what_happened: "provider-token-secret",
            why: "provider-token-secret",
            fixes: [{ description: "provider-token-secret", command: "provider-token-secret" }],
            docs_url: "provider-token-secret",
            recoverable: false,
            run_id: "run-provider-token-secret",
            checkpoint: "provider-token-secret",
            retry_disposition: null,
            required_actor: null,
            required_action: "provider-token-secret",
            evidence_refs: ["provider-token-secret"],
          });
        },
      });
      await ready(server);

      const result = await callTool(server, "runmill_get_run", { run_id: "run-1" });
      expect(result).toMatchObject({ isError: true });
      if (code === "RM-CI-002") {
        expect(result.structuredContent).toMatchObject({
          code: "RM-CI-002",
          run_id: null,
          checkpoint: null,
        });
      } else {
        expect(result.structuredContent).toMatchObject({ code: "service_request_failed" });
      }
      expect(JSON.stringify(result)).not.toContain("provider-token-secret");
    }
  });

  it.each([
    {
      label: "state/version contradiction",
      result: {
        events: [],
        nextCursor: 12,
        hasMore: false,
        gap: false,
        compactedThrough: null,
        snapshot: { run: { ...runRow(), stateVersion: 11 }, latestSequence: 12 },
      },
    },
    {
      label: "cursor jump past the returned event",
      result: {
        events: [{ ...event(), seq: 1, event_id: "event-1" }],
        nextCursor: 12,
        hasMore: false,
        gap: false,
        compactedThrough: null,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "stalled has-more page",
      result: {
        events: [],
        nextCursor: 0,
        hasMore: true,
        gap: false,
        compactedThrough: null,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "contradictory gap metadata",
      result: {
        events: [event()],
        nextCursor: 12,
        hasMore: false,
        gap: true,
        compactedThrough: null,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "event belongs to another run",
      result: {
        events: [{ ...event(), run_id: "run-other" }],
        nextCursor: 12,
        hasMore: false,
        gap: true,
        compactedThrough: 11,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "event belongs to another Work Order",
      result: {
        events: [{ ...event(), work_order_id: "wo-other" }],
        nextCursor: 12,
        hasMore: false,
        gap: true,
        compactedThrough: 11,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "event belongs to another attempt",
      result: {
        events: [{ ...event(), attempt_id: "attempt-other" }],
        nextCursor: 12,
        hasMore: false,
        gap: true,
        compactedThrough: 11,
        snapshot: { run: runRow(), latestSequence: 12 },
      },
    },
    {
      label: "snapshot belongs to another run",
      result: {
        events: [event()],
        nextCursor: 12,
        hasMore: false,
        gap: true,
        compactedThrough: 11,
        snapshot: { run: runRow("run-other"), latestSequence: 12 },
      },
    },
    {
      label: "policy changes within one immutable event lineage",
      result: {
        events: [
          { ...event(), event_id: "event-1", seq: 1 },
          { ...event(), event_id: "event-2", seq: 2, policy_digest: DIGEST_B },
        ],
        nextCursor: 2,
        hasMore: false,
        gap: false,
        compactedThrough: null,
        snapshot: {
          run: { ...runRow(), stateVersion: 2 },
          latestSequence: 2,
        },
      },
    },
    {
      label: "latest event phase contradicts the current snapshot",
      result: {
        events: [{ ...event(), event_id: "event-1", seq: 1 }],
        nextCursor: 1,
        hasMore: false,
        gap: false,
        compactedThrough: null,
        snapshot: {
          run: { ...runRow(), state: "IMPLEMENTING", stateVersion: 1 },
          latestSequence: 1,
        },
      },
    },
  ])("refuses malformed daemon event pages: $label", async ({ result }) => {
    const server = new AsfMcpServer({ controlClient: async () => result });
    await ready(server);

    const response = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_list_run_events",
          arguments: { run_id: "run-1" },
        }),
      ),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_service_response" },
    });
  });

  it("does not echo unclassified daemon errors or malformed result secrets", async () => {
    for (const controlClient of [
      async () => {
        throw new Error("provider token super-secret-value");
      },
      async () => ({
        runId: "run-1",
        disposition: "accepted",
        payloadDigest: DIGEST_A,
        token: "super-secret-value",
      }),
    ]) {
      const server = new AsfMcpServer({ controlClient });
      await ready(server);
      const result = rpcResult(
        await server.handleMessage(
          request(2, "tools/call", {
            name: "runmill_submit_work_order",
            arguments: { envelope: envelope() },
          }),
        ),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/provider token|super-secret-value/i);
    }

    const eventServer = new AsfMcpServer({
      controlClient: async () => ({
        ...currentEvidenceResult(),
        latestEvent: {
          ...event(),
          type: "provider.super-secret-value",
          payload: {},
        },
      }),
    });
    await ready(eventServer);
    const eventResult = await callTool(eventServer, "runmill_get_evidence", {
      run_id: "run-1",
    });
    expect(eventResult).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_service_response" },
    });
    expect(JSON.stringify(eventResult)).not.toContain("super-secret-value");
  });

  it("refuses a get_run snapshot whose durable sequence contradicts state", async () => {
    const server = new AsfMcpServer({
      controlClient: async () => ({
        run: { ...runRow(), stateVersion: 11 },
        admission: admission(),
        latestSequence: 12,
      }),
    });
    await ready(server);

    const result = rpcResult(
      await server.handleMessage(
        request(2, "tools/call", {
          name: "runmill_get_run",
          arguments: { run_id: "run-1" },
        }),
      ),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_service_response" },
    });
  });

  it("bounds daemon calls at five seconds without issuing cancellation authority", async () => {
    expect(ASF_MCP_CONTROL_TIMEOUT_MS).toBe(5_000);
    vi.useFakeTimers();
    const calls: AsfControlRequest[] = [];
    let finish: ((value: unknown) => void) | undefined;
    const server = new AsfMcpServer({
      controlClient: (controlRequest) => {
        calls.push(controlRequest);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await ready(server);

    let settled = false;
    const pending = callTool(server, "runmill_get_run", { run_id: "run-1" }).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(ASF_MCP_CONTROL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      isError: true,
      structuredContent: { code: "service_request_failed" },
    });
    expect(calls).toEqual([{ type: "asf.get_run", runId: "run-1" }]);

    finish?.({ run: runRow(), admission: admission(), latestSequence: 12 });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.type === "asf.request_cancel")).toBe(false);
  });

  it("returns JSON-RPC parse, request, and method errors with the required ids", async () => {
    const sent: string[] = [];
    const transport: McpNdjsonTransport = {
      incoming: (async function* () {
        yield "not-json\n";
        yield `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unknown" })}\n`;
      })(),
      send(line) {
        sent.push(line);
      },
    };
    await serveAsfMcpTransport(new AsfMcpServer({ controlClient: daemon([]) }), transport);

    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } },
    ]);
  });

  it("rejects duplicate JSON-RPC keys before dispatching to the daemon", async () => {
    const calls: AsfControlRequest[] = [];
    const sent: string[] = [];
    const transport: McpNdjsonTransport = {
      incoming: (async function* () {
        yield '{"jsonrpc":"2.0","id":1,"id":2,"method":"initialize","params":{}}\n';
      })(),
      send(line) {
        sent.push(line);
      },
    };
    const controlClient: AsfDaemonControlClient = async (request) => {
      calls.push(request);
      return {};
    };

    await serveAsfMcpTransport(new AsfMcpServer({ controlClient }), transport);

    expect(calls).toEqual([]);
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    ]);
  });
});

describe("ASF MCP NDJSON transport", () => {
  it("reassembles split chunks, handles multiple messages, and emits no notification response", async () => {
    const initialize = JSON.stringify(
      request(1, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      }),
    );
    const initialized = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const list = JSON.stringify(request(2, "tools/list", {}));
    const bytes = `${initialize}\n${initialized}\n${list}\n`;
    const sent: string[] = [];
    const transport: McpNdjsonTransport = {
      incoming: (async function* () {
        yield bytes.slice(0, 17);
        yield Buffer.from(bytes.slice(17), "utf8");
      })(),
      send(line) {
        sent.push(line);
      },
    };

    await serveAsfMcpTransport(new AsfMcpServer({ controlClient: daemon([]) }), transport);
    expect(sent).toHaveLength(2);
    expect(sent.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
  });

  it("does not couple a durably accepted job to a disconnect while replying", async () => {
    const acceptedRuns = new Set<string>();
    const calls: AsfControlRequest[] = [];
    const controlClient: AsfDaemonControlClient = async (controlRequest) => {
      calls.push(controlRequest);
      if (controlRequest.type !== "asf.submit_work_order") throw new Error("unexpected request");
      acceptedRuns.add("run-durable");
      return {
        runId: "run-durable",
        disposition: "accepted",
        payloadDigest: envelopePayloadDigest(),
      };
    };
    const messages = [
      request(1, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request(2, "tools/call", {
        name: "runmill_submit_work_order",
        arguments: { envelope: envelope() },
      }),
    ];
    let writes = 0;
    const transport: McpNdjsonTransport = {
      incoming: (async function* () {
        yield `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
      })(),
      send() {
        writes += 1;
        if (writes === 2) throw new Error("client disconnected");
      },
    };

    await expect(
      serveAsfMcpTransport(new AsfMcpServer({ controlClient }), transport),
    ).rejects.toThrow(/client disconnected/);
    expect(acceptedRuns).toEqual(new Set(["run-durable"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("asf.submit_work_order");
  });

  it("rejects malformed UTF-8 instead of repairing it into a request", async () => {
    const sent: string[] = [];
    const transport: McpNdjsonTransport = {
      incoming: (async function* () {
        yield Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d, 0x0a]);
      })(),
      send(line) {
        sent.push(line);
      },
    };

    await serveAsfMcpTransport(new AsfMcpServer({ controlClient: daemon([]) }), transport);
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    ]);
  });
});
