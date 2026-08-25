import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import {
  ASF_MODEL_REQUEST_SCHEMA,
  ASF_PROVIDER_REQUEST_SCHEMA,
  ASF_PROTECTED_SESSION_SCHEMA,
  ProviderHarnessRefusalError,
  TrustedProviderHarness,
  classifyProviderBackend,
  parseAsfProviderResult,
  type AsfProviderRequest,
  type ProviderRepositoryAuthority,
  type ProviderHarnessScheduledTask,
  type ProviderHarnessScheduler,
  type TrustedProviderTransport,
  type TrustedProviderTransportInput,
  type TrustedProviderTransportResult,
  type ProtectedImplementerSessionVault,
} from "../../src/agent/trusted-harness.js";
import { AuthorizedImplementerResume } from "../../src/asf/checkpoint-policy.js";
import {
  ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
  identityLeaseAttributionDigest,
} from "../../src/asf/identity-attribution.js";
import {
  ASF_TOOL_REQUEST_SCHEMA,
  RepositoryToolGateway,
  type CredentialFreeProductionSandbox,
  type CredentialFreeSandboxExecution,
  type RegisteredRepositoryTool,
} from "../../src/agent/tool-gateway.js";
import type {
  IdentityExecutionHandle,
  IdentityLease,
  IdentityLeaseId,
} from "../../src/identity/broker.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import type { SandboxResult } from "../../src/workspace/sandbox.js";

const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;
const TASK_PACKET_DIGEST = `sha256:${"b".repeat(64)}`;
const INSTRUCTION_DIGEST = `sha256:${"c".repeat(64)}`;
const CONTEXT_DIGEST = `sha256:${"d".repeat(64)}`;
const OUTPUT_DIGEST = `sha256:${"e".repeat(64)}`;
const SESSION_REF = `sha256:${"f".repeat(64)}`;
const CANDIDATE = "1".repeat(40);
const WORKSPACE = "/srv/runmill/workspaces/run-1";
const PROVIDER_CREDENTIAL = "provider-credential-super-secret";
const SESSION_PROTECTION_KEY = "session-protection-key-with-more-than-32-bytes";
const EXECUTION_HANDLE =
  "ctxlane-execution-handle-secret" as IdentityExecutionHandle;
const LEASE_ID = "identity-lease-secret" as IdentityLeaseId;

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  tool_calls: 0,
} as const;

class RestrictiveHarnessSandbox implements CredentialFreeProductionSandbox {
  readonly mechanism = "bubblewrap" as const;
  readonly enforcement = "production-credential-free" as const;
  readonly calls: CredentialFreeSandboxExecution[] = [];
  result: SandboxResult = {
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
  };
  handler:
    | ((input: CredentialFreeSandboxExecution) => Promise<SandboxResult>)
    | undefined;

  async execute(input: CredentialFreeSandboxExecution): Promise<SandboxResult> {
    if (
      input.sandbox.policy.allowNetwork ||
      input.isolation.network !== "disabled" ||
      input.isolation.inheritEnvironment !== false ||
      input.isolation.providerCredentials !== "denied" ||
      input.isolation.hostCredentialPaths !== "denied" ||
      input.isolation.hostSockets !== "denied" ||
      input.isolation.otherWorkspaces !== "denied"
    ) {
      throw new Error(
        "restrictive fake refused an incomplete isolation contract",
      );
    }
    if (
      Object.keys(input.sandbox.env ?? {}).some(
        (key) => !["LANG", "LC_ALL", "PATH", "TZ"].includes(key),
      )
    ) {
      throw new Error(
        "restrictive fake refused an ambient environment variable",
      );
    }
    if (
      input.sandbox.cwd !== WORKSPACE ||
      input.sandbox.policy.readablePaths?.some((path) => path !== WORKSPACE) ===
        true ||
      input.sandbox.policy.writablePaths.some((path) => path !== WORKSPACE)
    ) {
      throw new Error(
        "restrictive fake refused access outside the exact workspace",
      );
    }
    if (input.signal.aborted)
      throw new Error("restrictive fake refused an aborted process");
    this.calls.push(input);
    if (this.handler !== undefined) return this.handler(input);
    return this.result;
  }
}

class FakeHostTransport implements TrustedProviderTransport {
  readonly calls: TrustedProviderTransportInput[] = [];
  handler: (input: TrustedProviderTransportInput) => Promise<unknown>;

  constructor(
    handler?: (input: TrustedProviderTransportInput) => Promise<unknown>,
  ) {
    this.handler = handler ?? (async (input) => successfulTransport(input));
  }

  async execute(input: TrustedProviderTransportInput): Promise<unknown> {
    this.calls.push(input);
    return this.handler(input);
  }
}

class ManualScheduler implements ProviderHarnessScheduler {
  readonly tasks: Array<{
    readonly delayMs: number;
    readonly task: () => void;
    cancelled: boolean;
  }> = [];

  schedule(delayMs: number, task: () => void): ProviderHarnessScheduledTask {
    const scheduled = { delayMs, task, cancelled: false };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  async runNext(delayMs: number): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const scheduled = this.tasks.find(
        (task) => !task.cancelled && task.delayMs === delayMs,
      );
      if (scheduled !== undefined) {
        scheduled.cancelled = true;
        scheduled.task();
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`no live scheduled task at ${String(delayMs)}ms`);
  }
}

function identityLease(
  role: IdentityLease["role"] = "implementer",
  overrides: Partial<IdentityLease> = {},
): IdentityLease {
  const reviewer = role === "local-reviewer" || role === "pr-reviewer";
  return {
    leaseId: LEASE_ID,
    executionHandle: EXECUTION_HANDLE,
    runId: "run-1",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    role,
    policyDigest: POLICY_DIGEST,
    provider: reviewer ? "independent-provider" : "trusted-provider",
    principal: reviewer ? "review-principal" : "implementation-principal",
    profile: reviewer ? "review" : "implementation",
    issuedAt: "2026-08-21T09:59:00.000Z",
    expiresAt: "2026-08-21T11:00:00.000Z",
    fencingGeneration: 7,
    ...overrides,
  };
}

function identityAttributionDigestFor(lease: IdentityLease): string {
  return identityLeaseAttributionDigest(
    {
      run_id: lease.runId,
      work_order_id: lease.workOrderId,
      attempt_id: lease.attemptId,
      policy_digest: lease.policyDigest,
      fencing_generation: lease.fencingGeneration,
      candidate_sha: null,
    },
    {
      schema: ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
      role: "implementer",
      provider: lease.provider,
      principal_id: lease.principal,
      profile: lease.profile,
      fencing_generation: lease.fencingGeneration,
      issued_at: lease.issuedAt,
      expires_at: lease.expiresAt,
    },
  );
}

function providerRequest(
  lease: IdentityLease = identityLease(),
  overrides: Partial<AsfProviderRequest["model_request"]> = {},
): AsfProviderRequest {
  return {
    schema: ASF_PROVIDER_REQUEST_SCHEMA,
    model_request: {
      schema: ASF_MODEL_REQUEST_SCHEMA,
      request_id: "provider-request-1",
      binding: {
        run_id: lease.runId,
        work_order_id: lease.workOrderId,
        attempt_id: lease.attemptId,
        role: lease.role,
        invocation_id: "invocation-1",
        policy_digest: lease.policyDigest,
        candidate_sha: CANDIDATE,
        fencing_generation: lease.fencingGeneration,
      },
      provider: lease.provider,
      model: "trusted-model-1",
      principal: lease.principal,
      profile: lease.profile,
      task_packet_digest: TASK_PACKET_DIGEST,
      instruction_digest: INSTRUCTION_DIGEST,
      context_digests: [CONTEXT_DIGEST],
      allowed_tools: [],
      allowed_check_ids: [],
      limits: {
        timeout_ms: 30_000,
        max_turns: 10,
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        max_output_bytes: 65_536,
        max_cost_usd: 10,
        max_events: 100,
        max_tool_calls: 5,
      },
      ...overrides,
    },
    session: { mode: "fresh" },
  };
}

function repositoryAuthority(
  overrides: Partial<ProviderRepositoryAuthority> = {},
): ProviderRepositoryAuthority {
  return {
    invocationId: "invocation-1",
    candidateSha: CANDIDATE,
    taskPacketDigest: TASK_PACKET_DIGEST,
    instructionDigest: INSTRUCTION_DIGEST,
    contextDigests: [CONTEXT_DIGEST],
    model: "trusted-model-1",
    workspaceRoot: WORKSPACE,
    pathScope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
    allowedTools: [
      "repository.read",
      "repository.check",
      "repository.apply_patch",
    ],
    allowedCheckIds: ["unit"],
    toolResourceLimits: {
      cpuMillis: 1_000,
      memoryMib: 1_024,
      processes: 64,
      fileSizeBytes: 8_388_608,
      wallTimeMs: 30_000,
      maxOutputBytes: 4_096,
    },
    freshCandidate: true,
    ...overrides,
  };
}

function successfulTransport(
  _input: TrustedProviderTransportInput,
  overrides: Partial<TrustedProviderTransportResult> = {},
): TrustedProviderTransportResult {
  const status = overrides.status ?? "success";
  const usage = overrides.usage ?? ZERO_USAGE;
  return {
    status,
    output_digest: status === "success" ? OUTPUT_DIGEST : null,
    output_bytes: 64,
    turns: 1,
    usage,
    events: [
      {
        sequence: 1,
        observed_at: "2026-08-21T10:00:00.000Z",
        event: { type: "session.started" },
      },
      {
        sequence: 2,
        observed_at: "2026-08-21T10:00:00.000Z",
        event: { type: "usage.updated", cumulative: true, usage },
      },
      {
        sequence: 3,
        observed_at: "2026-08-21T10:00:00.000Z",
        event: { type: "session.completed", status },
      },
    ],
    protected_session_ref: SESSION_REF,
    failure:
      status === "failure"
        ? { class: "provider-internal", retryable: true }
        : null,
    ...overrides,
  };
}

const readTool: RegisteredRepositoryTool = {
  name: "repository.read",
  access: "read",
  allowedRoles: ["implementer", "fixer", "local-reviewer", "pr-reviewer"],
  buildInvocation(tool) {
    if (tool.name !== "repository.read") throw new Error("wrong dispatch");
    return {
      command: "/usr/bin/sed",
      args: ["-n", "1,100p", tool.arguments.path],
      repositoryPaths: [tool.arguments.path],
    };
  },
};

function setup(
  options: {
    readonly transport?: FakeHostTransport;
    readonly sandbox?: RestrictiveHarnessSandbox;
    readonly clock?: FakeClock;
    readonly current?: () => boolean;
    readonly backend?:
      | "host-credential-harness"
      | "direct-cli"
      | "copied-provider-home"
      | "fake";
    readonly sensitiveValues?: readonly string[];
    readonly sessionProtectionKey?: string;
    readonly scheduler?: ProviderHarnessScheduler;
    readonly fenceCheckIntervalMs?: number;
  } = {},
) {
  const clock = options.clock ?? new FakeClock("2026-08-21T10:00:00Z");
  const sandbox = options.sandbox ?? new RestrictiveHarnessSandbox();
  const transport = options.transport ?? new FakeHostTransport();
  const current = options.current ?? (() => true);
  const gateway = new RepositoryToolGateway({
    clock,
    fenceValidator: { isCurrent: current },
    sandbox,
    tools: [readTool],
    environment: {},
    sensitiveValues: options.sensitiveValues,
  });
  const harness = new TrustedProviderHarness({
    backend: options.backend ?? "host-credential-harness",
    providerCredential: PROVIDER_CREDENTIAL,
    sessionProtectionKey:
      options.sessionProtectionKey ?? SESSION_PROTECTION_KEY,
    clock,
    fenceValidator: { isCurrent: current },
    transport,
    toolGateway: gateway,
    scheduler: options.scheduler,
    fenceCheckIntervalMs: options.fenceCheckIntervalMs,
    protectedHostValues: options.sensitiveValues,
    maximums: {
      timeoutMs: 60_000,
      turns: 20,
      inputTokens: 20_000,
      outputTokens: 10_000,
      outputBytes: 131_072,
      costUsd: 20,
      events: 200,
      toolCalls: 10,
    },
  });
  return { harness, transport, sandbox, clock };
}

describe("TrustedProviderHarness", () => {
  it("uses a current lease while keeping credentials and the ctxlane handle in a branded host boundary", async () => {
    let observedCredential = "";
    let observedHandle = "";
    const transport = new FakeHostTransport(async (input) => {
      input.authority.useProviderCredential((value) => {
        observedCredential = value;
      });
      input.authority.useExecutionHandle((value) => {
        observedHandle = value;
      });
      return successfulTransport(input);
    });
    const { harness } = setup({ transport });

    const execution = await harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    const result = execution.result;
    const protectedMetadata = execution.protectedResume?.useMetadata(
      (metadata) => metadata,
    );

    expect(observedCredential).toBe(PROVIDER_CREDENTIAL);
    expect(observedHandle).toBe(EXECUTION_HANDLE);
    expect(result).toMatchObject({
      schema: "asf.provider-result/v1",
      model_result: { status: "success", output_digest: OUTPUT_DIGEST },
      resume_metadata_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(protectedMetadata).toMatchObject({
      schema: ASF_PROTECTED_SESSION_SCHEMA,
      protected_session_ref: SESSION_REF,
      candidate_sha: CANDIDATE,
      policy_digest: POLICY_DIGEST,
      fencing_generation: 7,
      binding_mac: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
    });
    expect(result.resume_metadata_digest).toBe(
      sha256Digest(protectedMetadata!),
    );
    expect(() => parseAsfProviderResult(result)).not.toThrow();
    expect(() =>
      parseAsfProviderResult({
        ...result,
        model_result: { ...result.model_result, output_bytes: 65 },
      }),
    ).toThrow(/does not match its digest/);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const serializedCall = JSON.stringify(transport.calls[0]);
    const serializedResult = JSON.stringify(execution);
    for (const protectedValue of [
      PROVIDER_CREDENTIAL,
      SESSION_PROTECTION_KEY,
      EXECUTION_HANDLE,
      LEASE_ID,
      SESSION_REF,
    ]) {
      expect(serializedCall).not.toContain(protectedValue);
      expect(serializedResult).not.toContain(protectedValue);
    }
    expect(serializedCall).not.toContain(WORKSPACE);
    expect(serializedResult).not.toMatch(
      /credential|execution_handle|lease_id/i,
    );
    expect(serializedResult).not.toMatch(
      /protected_session_ref|lease_digest|binding_mac/i,
    );
  });

  it("delegates repository reads to the sandbox without leaking provider, ctxlane, GitHub, SSH, or cloud secrets", async () => {
    const protectedValues = [
      PROVIDER_CREDENTIAL,
      EXECUTION_HANDLE,
      "unix:///run/ctxlane/private.sock",
      "ghp_github-secret",
      "/tmp/ssh-agent.sock",
      "aws-cloud-secret",
    ];
    const sandbox = new RestrictiveHarnessSandbox();
    sandbox.result = {
      ...sandbox.result,
      stdout:
        `${protectedValues[0]} ${protectedValues[1]} ${protectedValues[2]} ` +
        `GITHUB_TOKEN=${protectedValues[3]} SSH_AUTH_SOCK=${protectedValues[4]} ` +
        `AWS_SECRET_ACCESS_KEY=${protectedValues[5]}`,
    };
    let protectedToolResult = "";
    const transport = new FakeHostTransport(async (input) => {
      const toolArguments = { path: "src/index.ts", max_bytes: 4096 };
      const toolResult = await input.invokeTool({
        schema: ASF_TOOL_REQUEST_SCHEMA,
        request_id: "tool-call-1",
        binding: input.request.model_request.binding,
        tool: { name: "repository.read", arguments: toolArguments },
        limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
      });
      protectedToolResult = JSON.stringify(toolResult);
      const usage = { ...ZERO_USAGE, tool_calls: 1 };
      return successfulTransport(input, {
        usage,
        events: [
          {
            sequence: 1,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: { type: "session.started" },
          },
          {
            sequence: 2,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: {
              type: "tool.requested",
              tool_request_id: "tool-call-1",
              tool_name: "repository.read",
              request_digest: toolResult.request_digest,
              arguments_digest: sha256Digest(toolArguments),
            },
          },
          {
            sequence: 3,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: {
              type: "tool.completed",
              tool_request_id: "tool-call-1",
              tool_name: "repository.read",
              status: toolResult.status,
              result_digest: toolResult.result_digest,
            },
          },
          {
            sequence: 4,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: { type: "usage.updated", cumulative: true, usage },
          },
          {
            sequence: 5,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: { type: "session.completed", status: "success" },
          },
        ],
      });
    });
    const { harness } = setup({
      transport,
      sandbox,
      sensitiveValues: protectedValues,
    });
    const raw = providerRequest(identityLease(), {
      allowed_tools: ["repository.read"],
    });

    const execution = await harness.execute(
      raw,
      identityLease(),
      repositoryAuthority(),
    );
    const result = execution.result;

    expect(sandbox.calls).toHaveLength(1);
    const sandboxInvocation = sandbox.calls[0]!;
    expect(sandboxInvocation.sandbox.env).toEqual({});
    expect(sandboxInvocation.sandbox.policy.allowNetwork).toBe(false);
    expect(sandboxInvocation.isolation).toEqual({
      network: "disabled",
      inheritEnvironment: false,
      providerCredentials: "denied",
      hostCredentialPaths: "denied",
      hostSockets: "denied",
      otherWorkspaces: "denied",
      candidate: CANDIDATE,
      freshCandidate: true,
    });
    const serializedSandboxInvocation = JSON.stringify(sandboxInvocation);
    expect(serializedSandboxInvocation).not.toContain(PROVIDER_CREDENTIAL);
    expect(serializedSandboxInvocation).not.toContain(EXECUTION_HANDLE);
    expect(serializedSandboxInvocation).not.toContain("ctxlane/private.sock");
    const publicData = `${JSON.stringify(result)}${protectedToolResult}${JSON.stringify(
      sandboxInvocation.sandbox.env,
    )}`;
    for (const protectedValue of protectedValues)
      expect(publicData).not.toContain(protectedValue);
    expect(publicData).not.toMatch(
      /GITHUB_TOKEN|SSH_AUTH_SOCK|AWS_SECRET_ACCESS_KEY/,
    );
    expect(result.events.map((event) => event.event.type)).toContain(
      "tool.completed",
    );
  });

  it("strictly rejects secret-bearing request/result fields and unknown provider events", async () => {
    const transport = new FakeHostTransport();
    const { harness } = setup({ transport });
    await expect(
      harness.execute(
        { ...providerRequest(), github_token: "ghp_secret" },
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "malformed-request" });
    await expect(
      harness.execute(
        {
          ...providerRequest(),
          model_request: {
            ...providerRequest().model_request,
            prompt: PROVIDER_CREDENTIAL,
          },
        },
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "malformed-request" });
    expect(transport.calls).toHaveLength(0);

    transport.handler = async (input) => ({
      ...successfulTransport(input),
      provider_credential: PROVIDER_CREDENTIAL,
    });
    await expect(
      harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "malformed-provider-result" });

    transport.handler = async (input) => ({
      ...successfulTransport(input),
      events: [
        {
          sequence: 1,
          observed_at: "2026-08-21T10:00:00.000Z",
          event: { type: "assistant.message", text: PROVIDER_CREDENTIAL },
        },
      ],
    });
    await expect(
      harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "malformed-provider-result" });

    const digestSecret = setup({ sensitiveValues: [OUTPUT_DIGEST] });
    await expect(
      digestSecret.harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "malformed-provider-result" });
  });

  it("fails closed for every substituted lease, invocation, policy, candidate, and model binding", async () => {
    const { harness, transport } = setup();
    const mutations: readonly ((raw: any) => void)[] = [
      (raw) => (raw.model_request.binding.run_id = "run-2"),
      (raw) => (raw.model_request.binding.work_order_id = "wo-2"),
      (raw) => (raw.model_request.binding.attempt_id = "attempt-2"),
      (raw) => (raw.model_request.binding.role = "fixer"),
      (raw) =>
        (raw.model_request.binding.policy_digest = `sha256:${"9".repeat(64)}`),
      (raw) => (raw.model_request.binding.fencing_generation = 8),
      (raw) => (raw.model_request.binding.invocation_id = "invocation-2"),
      (raw) => (raw.model_request.binding.candidate_sha = "2".repeat(40)),
      (raw) =>
        (raw.model_request.task_packet_digest = `sha256:${"3".repeat(64)}`),
      (raw) =>
        (raw.model_request.instruction_digest = `sha256:${"4".repeat(64)}`),
      (raw) => (raw.model_request.model = "unapproved-model"),
      (raw) => (raw.model_request.provider = "different-provider"),
      (raw) => (raw.model_request.principal = "different-principal"),
      (raw) => (raw.model_request.profile = "different-profile"),
    ];
    for (const mutate of mutations) {
      const raw = structuredClone(providerRequest()) as any;
      mutate(raw);
      await expect(
        harness.execute(raw, identityLease(), repositoryAuthority()),
      ).rejects.toBeInstanceOf(ProviderHarnessRefusalError);
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("requires an active current lease and rechecks its fence before publishing", async () => {
    const expired = setup();
    await expect(
      expired.harness.execute(
        providerRequest(),
        identityLease("implementer", { expiresAt: "2026-08-21T10:00:00.000Z" }),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "lease-inactive" });
    expect(expired.transport.calls).toHaveLength(0);

    const tooShort = setup();
    await expect(
      tooShort.harness.execute(
        providerRequest(),
        identityLease("implementer", { expiresAt: "2026-08-21T10:00:10.000Z" }),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "lease-inactive" });
    expect(tooShort.transport.calls).toHaveLength(0);

    const stale = setup({ current: () => false });
    await expect(
      stale.harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "stale-generation" });
    expect(stale.transport.calls).toHaveLength(0);

    let checks = 0;
    const takeover = setup({ current: () => ++checks === 1 });
    await expect(
      takeover.harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "stale-generation" });
    expect(takeover.transport.calls).toHaveLength(1);

    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const expiresDuringRun = new FakeHostTransport(async (input) => {
      clock.advanceMs(1_100);
      return successfulTransport(input, {
        events: [
          {
            sequence: 1,
            observed_at: "2026-08-21T10:00:00.000Z",
            event: { type: "session.started" },
          },
          {
            sequence: 2,
            observed_at: "2026-08-21T10:00:01.000Z",
            event: { type: "session.completed", status: "success" },
          },
        ],
      });
    });
    const shortLease = identityLease("implementer", {
      expiresAt: "2026-08-21T10:00:01.000Z",
    });
    const shortRequest = providerRequest(shortLease, {
      limits: {
        ...providerRequest(shortLease).model_request.limits,
        timeout_ms: 500,
      },
    });
    await expect(
      setup({ clock, transport: expiresDuringRun }).harness.execute(
        shortRequest,
        shortLease,
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "lease-inactive" });
  });

  it("creates exact-bound implementer resume metadata and refuses every stale substitution", async () => {
    const { harness } = setup();
    const first = await harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    expect(first.protectedResume).not.toBeNull();
    const stored = first.protectedResume!.useMetadata((metadata) =>
      structuredClone(metadata),
    );
    const restored = harness.restoreProtectedResume(stored);
    expect(() =>
      setup({
        sessionProtectionKey: "different-session-protection-key-with-32-bytes",
      }).harness.restoreProtectedResume(stored),
    ).toThrow(/unauthenticated/);
    const resumed: AsfProviderRequest = {
      ...providerRequest(),
      session: {
        mode: "resume",
        metadata_digest: first.result.resume_metadata_digest!,
      },
    };
    await expect(
      harness.execute(
        resumed,
        identityLease(),
        repositoryAuthority(),
        undefined,
        restored,
      ),
    ).resolves.toMatchObject({
      result: { model_result: { status: "success" } },
    });

    const mutations: readonly ((metadata: any) => void)[] = [
      (metadata) =>
        (metadata.protected_session_ref = `sha256:${"5".repeat(64)}`),
      (metadata) => (metadata.lease_digest = `sha256:${"0".repeat(64)}`),
      (metadata) => (metadata.run_id = "run-2"),
      (metadata) => (metadata.work_order_id = "wo-2"),
      (metadata) => (metadata.attempt_id = "attempt-2"),
      (metadata) => (metadata.invocation_id = "invocation-2"),
      (metadata) => (metadata.policy_digest = `sha256:${"9".repeat(64)}`),
      (metadata) => (metadata.task_packet_digest = `sha256:${"8".repeat(64)}`),
      (metadata) => (metadata.instruction_digest = `sha256:${"7".repeat(64)}`),
      (metadata) => (metadata.context_set_digest = `sha256:${"6".repeat(64)}`),
      (metadata) => (metadata.candidate_sha = "2".repeat(40)),
      (metadata) => (metadata.fencing_generation = 8),
      (metadata) => (metadata.provider = "different-provider"),
      (metadata) => (metadata.model = "different-model"),
      (metadata) => (metadata.principal = "different-principal"),
      (metadata) => (metadata.profile = "different-profile"),
      (metadata) => (metadata.issued_at = "2026-08-21T10:00:01.000Z"),
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(stored) as any;
      mutate(tampered);
      expect(() => harness.restoreProtectedResume(tampered)).toThrow(
        /unauthenticated/,
      );
    }
    await expect(
      harness.execute(
        {
          ...resumed,
          session: {
            mode: "resume",
            metadata_digest: `sha256:${"4".repeat(64)}`,
          },
        },
        identityLease(),
        repositoryAuthority(),
        undefined,
        restored,
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });
  });

  it("resolves and executes only an authorized sealed resume without leaking its reference", async () => {
    const { harness } = setup();
    const first = await harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    const stored = first.protectedResume!.useMetadata((metadata) =>
      structuredClone(metadata),
    );
    const authorization = new AuthorizedImplementerResume(
      {
        runId: "run-1",
        workOrderId: "wo-1",
        attemptId: "attempt-1",
        checkpointKind: "candidate-commit-creation",
        candidateSha: CANDIDATE,
        policyDigest: POLICY_DIGEST,
        fencingGeneration: 7,
        authorizationFencingGeneration: 7,
        authorizationIdentityLeaseBindingDigest:
          identityAttributionDigestFor(identityLease()),
        sessionIdentityDigest: sha256Digest(stored),
      },
      SESSION_REF,
    );
    const loads: unknown[] = [];
    const vault: ProtectedImplementerSessionVault = {
      async load(input) {
        loads.push(input);
        return stored;
      },
    };

    const descriptor = await harness.describeAuthorizedImplementerResume(
      authorization,
      vault,
    );
    expect(descriptor).toMatchObject({
      invocation_id: "invocation-1",
      provider_candidate_sha: CANDIDATE,
      task_packet_digest: TASK_PACKET_DIGEST,
      session_identity_digest: sha256Digest(stored),
    });
    expect(JSON.stringify(descriptor)).not.toContain(SESSION_REF);
    expect(JSON.stringify(descriptor)).not.toContain(LEASE_ID);
    expect(JSON.stringify(authorization)).not.toContain(SESSION_REF);

    const resumedRequest = {
      ...providerRequest(),
      session: {
        mode: "resume" as const,
        metadata_digest: sha256Digest(stored),
      },
    };
    await expect(
      harness.executeAuthorizedImplementerResume(
        resumedRequest,
        identityLease(),
        repositoryAuthority(),
        authorization,
        vault,
      ),
    ).resolves.toMatchObject({
      result: { model_result: { status: "success" } },
    });
    expect(loads).toHaveLength(2);

    await expect(
      harness.describeAuthorizedImplementerResume(
        { binding: authorization.binding } as AuthorizedImplementerResume,
        vault,
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });
    await expect(
      harness.executeAuthorizedImplementerResume(
        {
          ...resumedRequest,
          model_request: {
            ...resumedRequest.model_request,
            binding: {
              ...resumedRequest.model_request.binding,
              invocation_id: "different-invocation",
            },
          },
        },
        identityLease(),
        repositoryAuthority(),
        authorization,
        vault,
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });
  });

  it("rebinds an authenticated generation-7 session only to authorized generation-8 identity", async () => {
    const { harness } = setup();
    const first = await harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    const stored = first.protectedResume!.useMetadata((metadata) =>
      structuredClone(metadata),
    );
    const currentLease = identityLease("implementer", {
      leaseId: "lease-generation-8" as IdentityLease["leaseId"],
      executionHandle:
        "execution-generation-8" as IdentityLease["executionHandle"],
      fencingGeneration: 8,
    });
    const authorization = new AuthorizedImplementerResume(
      {
        runId: "run-1",
        workOrderId: "wo-1",
        attemptId: "attempt-1",
        checkpointKind: "implementer-session-marker",
        candidateSha: CANDIDATE,
        policyDigest: POLICY_DIGEST,
        fencingGeneration: 7,
        authorizationFencingGeneration: 8,
        authorizationIdentityLeaseBindingDigest:
          identityAttributionDigestFor(currentLease),
        sessionIdentityDigest: sha256Digest(stored),
      },
      SESSION_REF,
    );
    const vault: ProtectedImplementerSessionVault = {
      async load() {
        return stored;
      },
    };
    const resumedRequest = {
      ...providerRequest(currentLease),
      session: {
        mode: "resume" as const,
        metadata_digest: sha256Digest(stored),
      },
    };

    await expect(
      harness.executeAuthorizedImplementerResume(
        resumedRequest,
        currentLease,
        repositoryAuthority(),
        authorization,
        vault,
      ),
    ).resolves.toMatchObject({
      result: {
        model_result: {
          status: "success",
          binding: { fencing_generation: 8 },
        },
      },
    });

    await expect(
      harness.execute(
        resumedRequest,
        currentLease,
        repositoryAuthority(),
        undefined,
        harness.restoreProtectedResume(stored),
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });
  });

  it("always starts reviewers fresh and rejects resumable reviewer state from either side", async () => {
    const first = await setup().harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    const reviewerLease = identityLease("local-reviewer");
    const reviewerRequest = providerRequest(reviewerLease);
    const resumeAttempt = {
      ...reviewerRequest,
      session: {
        mode: "resume",
        metadata_digest: first.result.resume_metadata_digest,
      },
    };
    const reviewer = setup();
    await expect(
      reviewer.harness.execute(
        resumeAttempt,
        reviewerLease,
        repositoryAuthority(),
        undefined,
        first.protectedResume,
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });
    expect(reviewer.transport.calls).toHaveLength(0);

    reviewer.transport.handler = async (input) => successfulTransport(input);
    await expect(
      reviewer.harness.execute(
        reviewerRequest,
        reviewerLease,
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "session-refused" });

    reviewer.transport.handler = async (input) =>
      successfulTransport(input, { protected_session_ref: null });
    const result = await reviewer.harness.execute(
      reviewerRequest,
      reviewerLease,
      repositoryAuthority(),
    );
    expect(result.result.resume_metadata_digest).toBeNull();
    expect(result.protectedResume).toBeNull();
  });

  it("classifies direct CLI, copied homes, and fakes as development-only and refuses them in production", () => {
    expect(classifyProviderBackend("host-credential-harness")).toMatchObject({
      productionEligible: true,
      classification: "production",
    });
    for (const backend of [
      "direct-cli",
      "copied-provider-home",
      "fake",
    ] as const) {
      expect(classifyProviderBackend(backend)).toMatchObject({
        productionEligible: false,
        classification: "development-only",
      });
      expect(() => setup({ backend })).toThrow(/development provider backends/);
    }
  });

  it("enforces provider budgets, deterministic pre-start cancellation, and monotonic deadlines", async () => {
    const excessive = new FakeHostTransport(async (input) =>
      successfulTransport(input, {
        output_bytes: 65_537,
        usage: { ...ZERO_USAGE, output_tokens: 5_001 },
      }),
    );
    await expect(
      setup({ transport: excessive }).harness.execute(
        providerRequest(),
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "provider-result-refused" });

    const insufficientEventBudget = setup();
    const eventStarved = providerRequest(identityLease(), {
      limits: {
        ...providerRequest().model_request.limits,
        max_events: 12,
        max_tool_calls: 5,
      },
    });
    await expect(
      insufficientEventBudget.harness.execute(
        eventStarved,
        identityLease(),
        repositoryAuthority(),
      ),
    ).rejects.toMatchObject({ reason: "limit-refused" });
    expect(insufficientEventBudget.transport.calls).toHaveLength(0);

    const cancelledSetup = setup();
    const beforeStart = new AbortController();
    beforeStart.abort("operator cancellation");
    const cancelled = await cancelledSetup.harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
      beforeStart.signal,
    );
    expect(cancelled.result.model_result.status).toBe("cancelled");
    expect(cancelled.protectedResume).toBeNull();
    expect(cancelledSetup.transport.calls).toHaveLength(0);

    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const timeoutTransport = new FakeHostTransport(async (input) => {
      clock.advanceMs(30_001);
      return successfulTransport(input);
    });
    const timedOut = await setup({
      clock,
      transport: timeoutTransport,
    }).harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    expect(timedOut.result.model_result.status).toBe("timeout");
    expect(timedOut.result.model_result.output_digest).toBeNull();
    expect(timedOut.result.resume_metadata_digest).toBeNull();
    expect(timedOut.protectedResume).toBeNull();
    expect(timedOut.result.events.at(-1)?.event).toEqual({
      type: "session.completed",
      status: "timeout",
    });
  });

  it("honors in-flight cancellation and never publishes resumable state afterward", async () => {
    const controller = new AbortController();
    const transport = new FakeHostTransport(async (input) => {
      controller.abort("ownership lost");
      return successfulTransport(input);
    });
    const result = await setup({ transport }).harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
      controller.signal,
    );

    expect(result.result.model_result.status).toBe("cancelled");
    expect(result.result.model_result.output_digest).toBeNull();
    expect(result.result.resume_metadata_digest).toBeNull();
    expect(result.protectedResume).toBeNull();
    expect(result.result.events.at(-1)?.event).toEqual({
      type: "session.completed",
      status: "cancelled",
    });
  });

  it("actively aborts an unresponsive provider at its deadline", async () => {
    const scheduler = new ManualScheduler();
    let observedAbort = false;
    let retainedAuthority:
      | TrustedProviderTransportInput["authority"]
      | undefined;
    const transport = new FakeHostTransport(async (input) => {
      retainedAuthority = input.authority;
      input.signal.addEventListener("abort", () => (observedAbort = true), {
        once: true,
      });
      return new Promise<never>(() => undefined);
    });
    const { harness } = setup({ transport, scheduler });

    const executionPromise = harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    await scheduler.runNext(30_000);
    const execution = await executionPromise;

    expect(observedAbort).toBe(true);
    expect(execution.result.model_result.status).toBe("timeout");
    expect(execution.result.model_result.output_digest).toBeNull();
    expect(execution.protectedResume).toBeNull();
    expect(retainedAuthority).toBeDefined();
    expect(() =>
      retainedAuthority?.useProviderCredential((credential) => credential),
    ).toThrow(/authority was used after its invocation ended/u);
    expect(() =>
      retainedAuthority?.useExecutionHandle((handle) => handle),
    ).toThrow(/authority was used after its invocation ended/u);
  });

  it("retains exact tool audit events when a provider times out after a completed tool call", async () => {
    const scheduler = new ManualScheduler();
    let markToolCompleted: (() => void) | undefined;
    const toolCompleted = new Promise<void>((resolve) => {
      markToolCompleted = resolve;
    });
    const transport = new FakeHostTransport(async (input) => {
      await input.invokeTool({
        schema: ASF_TOOL_REQUEST_SCHEMA,
        request_id: "tool-before-timeout",
        binding: input.request.model_request.binding,
        tool: {
          name: "repository.read",
          arguments: { path: "src/index.ts", max_bytes: 100 },
        },
        limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
      });
      markToolCompleted?.();
      return new Promise<never>(() => undefined);
    });
    const { harness } = setup({ transport, scheduler });
    const request = providerRequest(identityLease(), {
      allowed_tools: ["repository.read"],
    });
    const executionPromise = harness.execute(
      request,
      identityLease(),
      repositoryAuthority(),
    );

    await toolCompleted;
    await scheduler.runNext(30_000);
    const execution = await executionPromise;

    expect(execution.result.model_result.status).toBe("timeout");
    expect(execution.result.model_result.usage.tool_calls).toBe(1);
    expect(execution.result.events.map((event) => event.event.type)).toEqual([
      "session.started",
      "tool.requested",
      "tool.completed",
      "usage.updated",
      "session.completed",
    ]);
    expect(() => parseAsfProviderResult(execution.result)).not.toThrow();
  });

  it("actively aborts and refuses a long-running provider when its durable fence is lost", async () => {
    const scheduler = new ManualScheduler();
    let current = true;
    let observedAbort = false;
    const transport = new FakeHostTransport(async (input) => {
      input.signal.addEventListener("abort", () => (observedAbort = true), {
        once: true,
      });
      return new Promise<never>(() => undefined);
    });
    const { harness } = setup({
      transport,
      scheduler,
      current: () => current,
      fenceCheckIntervalMs: 250,
    });
    const executionPromise = harness.execute(
      providerRequest(),
      identityLease(),
      repositoryAuthority(),
    );
    current = false;
    await scheduler.runNext(250);

    await expect(executionPromise).rejects.toMatchObject({
      reason: "stale-generation",
    });
    expect(observedAbort).toBe(true);
  });

  it("aborts and joins an in-flight repository tool before refusing an early provider result", async () => {
    let markSandboxStarted: (() => void) | undefined;
    const sandboxStarted = new Promise<void>((resolve) => {
      markSandboxStarted = resolve;
    });
    let sandboxObservedAbort = false;
    const sandbox = new RestrictiveHarnessSandbox();
    sandbox.handler = async (input) => {
      markSandboxStarted?.();
      return new Promise<SandboxResult>((resolve) => {
        input.signal.addEventListener(
          "abort",
          () => {
            sandboxObservedAbort = true;
            resolve({
              outcome: "signaled",
              exitCode: null,
              signal: "ABORT",
              stdout: "",
              stderr: "",
              durationMs: 1,
            });
          },
          { once: true },
        );
      });
    };
    const transport = new FakeHostTransport(async (input) => {
      const pending = input.invokeTool({
        schema: ASF_TOOL_REQUEST_SCHEMA,
        request_id: "pending-tool-call",
        binding: input.request.model_request.binding,
        tool: {
          name: "repository.read",
          arguments: { path: "src/index.ts", max_bytes: 100 },
        },
        limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
      });
      void pending.catch(() => undefined);
      await sandboxStarted;
      return successfulTransport(input, {
        usage: { ...ZERO_USAGE, tool_calls: 1 },
      });
    });
    const { harness } = setup({ transport, sandbox });
    const raw = providerRequest(identityLease(), {
      allowed_tools: ["repository.read"],
    });

    await expect(
      harness.execute(raw, identityLease(), repositoryAuthority()),
    ).rejects.toMatchObject({ reason: "provider-result-refused" });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandboxObservedAbort).toBe(true);
  });

  it("invalidates the repository-tool callback as soon as the provider session returns", async () => {
    let retainedToolCall:
      | TrustedProviderTransportInput["invokeTool"]
      | undefined;
    const transport = new FakeHostTransport(async (input) => {
      retainedToolCall = input.invokeTool;
      return successfulTransport(input);
    });
    const { harness, sandbox } = setup({ transport });
    const raw = providerRequest(identityLease(), {
      allowed_tools: ["repository.read"],
    });
    await harness.execute(raw, identityLease(), repositoryAuthority());

    await expect(
      retainedToolCall?.({
        schema: ASF_TOOL_REQUEST_SCHEMA,
        request_id: "late-tool-call",
        binding: raw.model_request.binding,
        tool: {
          name: "repository.read",
          arguments: { path: "src/index.ts", max_bytes: 100 },
        },
        limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
      }),
    ).rejects.toMatchObject({ reason: "provider-result-refused" });
    expect(sandbox.calls).toHaveLength(0);
  });
});
