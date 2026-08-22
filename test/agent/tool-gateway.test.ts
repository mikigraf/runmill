import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import {
  ASF_TOOL_REQUEST_SCHEMA,
  RepositoryToolGateway,
  ToolGatewayRefusalError,
  parseAsfToolRequest,
  parseAsfToolResult,
  type AsfRepositoryToolName,
  type CredentialFreeProductionSandbox,
  type CredentialFreeSandboxExecution,
  type RegisteredRepositoryTool,
  type ToolExecutionAuthority,
} from "../../src/agent/tool-gateway.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import type { SandboxResult } from "../../src/workspace/sandbox.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const CANDIDATE = "b".repeat(40);
const WORKSPACE = "/srv/runmill/workspaces/run-1";
const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/index.ts",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

const DEFAULT_SANDBOX_RESULT: SandboxResult = {
  outcome: "exited",
  exitCode: 0,
  signal: null,
  stdout: "ok",
  stderr: "",
  durationMs: 1,
};

class RestrictiveFakeSandbox implements CredentialFreeProductionSandbox {
  readonly mechanism = "bubblewrap" as const;
  readonly enforcement = "production-credential-free" as const;
  readonly calls: CredentialFreeSandboxExecution[] = [];
  result: SandboxResult = DEFAULT_SANDBOX_RESULT;
  onExecute: (() => void) | undefined;

  async execute(input: CredentialFreeSandboxExecution): Promise<SandboxResult> {
    if (input.sandbox.policy.allowNetwork || input.isolation.network !== "disabled") {
      throw new Error("fake refuses networked repository tools");
    }
    if (
      input.isolation.inheritEnvironment !== false ||
      input.isolation.providerCredentials !== "denied" ||
      input.isolation.hostCredentialPaths !== "denied" ||
      input.isolation.hostSockets !== "denied" ||
      input.isolation.otherWorkspaces !== "denied"
    ) {
      throw new Error("fake refuses incomplete isolation contracts");
    }
    const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);
    for (const key of Object.keys(input.sandbox.env ?? {})) {
      if (!allowedEnvironment.has(key)) throw new Error(`fake refuses environment key ${key}`);
    }
    if (input.sandbox.cwd !== WORKSPACE) throw new Error("fake refuses a different workspace");
    if (input.sandbox.policy.readablePaths?.some((path) => path !== WORKSPACE) === true) {
      throw new Error("fake refuses another readable workspace");
    }
    if (input.sandbox.policy.writablePaths.some((path) => path !== WORKSPACE)) {
      throw new Error("fake refuses writes outside the workspace");
    }
    if (input.signal.aborted) throw new Error("fake refuses to start an aborted process");
    this.calls.push(input);
    this.onExecute?.();
    return this.result;
  }
}

function binding(role: ToolExecutionAuthority["role"] = "implementer") {
  return {
    run_id: "run-1",
    work_order_id: "wo-1",
    attempt_id: "attempt-1",
    role,
    invocation_id: "invocation-1",
    policy_digest: DIGEST_A,
    candidate_sha: CANDIDATE,
    fencing_generation: 7,
  } as const;
}

function authority(
  overrides: Partial<ToolExecutionAuthority> = {},
): ToolExecutionAuthority {
  return {
    ...binding(),
    workspaceRoot: WORKSPACE,
    pathScope: { allowedPaths: ["src/**"], forbiddenPaths: ["src/private/**"] },
    allowedTools: [
      "repository.read",
      "repository.apply_patch",
      "repository.check",
    ],
    allowedCheckIds: ["unit"],
    resourceLimits: {
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

function request(
  name: AsfRepositoryToolName = "repository.read",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const tool =
    name === "repository.read"
      ? { name, arguments: { path: "src/index.ts", max_bytes: 4096 } }
      : name === "repository.apply_patch"
        ? {
            name,
            arguments: {
              patch: PATCH,
              patch_digest: sha256Digest(PATCH),
              paths: ["src/index.ts"],
            },
          }
        : name === "repository.check"
          ? { name, arguments: { check_id: "unit" } }
          : name === "repository.list"
            ? { name, arguments: { path: "src", max_entries: 100 } }
            : { name, arguments: { path: "src", query: "needle", max_matches: 100 } };
  return {
    schema: ASF_TOOL_REQUEST_SCHEMA,
    request_id: "tool-call-1",
    binding: binding(),
    tool,
    limits: { timeout_ms: 30_000, max_output_bytes: 4_096 },
    ...overrides,
  };
}

const tools: readonly RegisteredRepositoryTool[] = [
  {
    name: "repository.read",
    access: "read",
    allowedRoles: ["implementer", "fixer", "local-reviewer", "pr-reviewer"],
    buildInvocation(tool) {
      if (tool.name !== "repository.read") throw new Error("wrong dispatch");
      return {
        command: "/usr/bin/sed",
        args: ["-n", `1,${String(tool.arguments.max_bytes)}p`, tool.arguments.path],
        repositoryPaths: [tool.arguments.path],
      };
    },
  },
  {
    name: "repository.apply_patch",
    access: "write",
    allowedRoles: ["implementer", "fixer"],
    buildInvocation(tool) {
      if (tool.name !== "repository.apply_patch") throw new Error("wrong dispatch");
      return {
        command: "/usr/bin/apply_patch",
        args: [],
        stdin: tool.arguments.patch,
        repositoryPaths: tool.arguments.paths,
      };
    },
  },
  {
    name: "repository.check",
    access: "verification",
    allowedRoles: ["implementer", "fixer", "local-reviewer", "pr-reviewer"],
    buildInvocation(tool) {
      if (tool.name !== "repository.check") throw new Error("wrong dispatch");
      return {
        command: "/usr/bin/runmill-check",
        args: [tool.arguments.check_id],
        repositoryPaths: [],
      };
    },
  },
];

function setup(options: {
  readonly sandbox?: RestrictiveFakeSandbox;
  readonly current?: () => boolean;
  readonly sensitiveValues?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
} = {}) {
  const sandbox = options.sandbox ?? new RestrictiveFakeSandbox();
  const clock = new FakeClock("2026-08-21T10:00:00Z");
  const gateway = new RepositoryToolGateway({
    clock,
    fenceValidator: { isCurrent: options.current ?? (() => true) },
    sandbox,
    tools,
    environment: options.environment ?? { LANG: "C.UTF-8" },
    sensitiveValues: options.sensitiveValues,
  });
  return { gateway, sandbox, clock };
}

describe("RepositoryToolGateway", () => {
  it("executes only a registered direct tool in a credential-free, networkless sandbox", async () => {
    const protectedValues = [
      "provider-credential-super-secret",
      "ctxlane-execution-handle-secret",
      "unix:///run/ctxlane/secret.sock",
      "ghp_github-secret",
      "/tmp/ssh-agent.sock",
      "aws-cloud-secret",
    ];
    const sandbox = new RestrictiveFakeSandbox();
    sandbox.result = {
      ...DEFAULT_SANDBOX_RESULT,
      stdout:
        `provider=${protectedValues[0]} handle=${protectedValues[1]} socket=${protectedValues[2]} ` +
        `GITHUB_TOKEN=${protectedValues[3]} SSH_AUTH_SOCK=${protectedValues[4]} ` +
        `AWS_SECRET_ACCESS_KEY=${protectedValues[5]}`,
    };
    const { gateway } = setup({ sandbox, sensitiveValues: protectedValues });

    const result = await gateway.execute(request(), authority());

    expect(result).toMatchObject({
      schema: "asf.repository-tool-result/v1",
      status: "success",
      tool_name: "repository.read",
      exit_code: 0,
    });
    expect(result.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.request_digest).toBe(sha256Digest(parseAsfToolRequest(request())));
    expect(() => parseAsfToolResult(result)).not.toThrow();
    expect(() =>
      parseAsfToolResult({
        ...result,
        request_digest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(/does not match its digest/);
    expect(sandbox.calls).toHaveLength(1);
    const execution = sandbox.calls[0];
    expect(execution?.sandbox).toMatchObject({
      command: "/usr/bin/sed",
      cwd: WORKSPACE,
      timeoutMs: 30_000,
      env: { LANG: "C.UTF-8" },
      policy: { writablePaths: [], allowNetwork: false },
    });
    expect(execution?.isolation).toMatchObject({
      inheritEnvironment: false,
      providerCredentials: "denied",
      hostCredentialPaths: "denied",
      hostSockets: "denied",
      otherWorkspaces: "denied",
      network: "disabled",
      candidate: CANDIDATE,
    });
    const publicResult = JSON.stringify(result);
    for (const value of protectedValues) expect(publicResult).not.toContain(value);
    expect(publicResult).not.toMatch(/GITHUB_TOKEN|SSH_AUTH_SOCK|AWS_SECRET_ACCESS_KEY/);
    const toolEnvironment = JSON.stringify(execution?.sandbox.env);
    expect(toolEnvironment).not.toMatch(
      /TOKEN|SECRET|CREDENTIAL|CTXLANE|SSH_AUTH_SOCK|AWS_|GOOGLE_|AZURE_/,
    );
  });

  it("passes patch bytes only on stdin and applies immutable path and patch bindings", async () => {
    const { gateway, sandbox } = setup();
    const raw = request("repository.apply_patch");
    const result = await gateway.execute(raw, authority());

    expect(result.status).toBe("success");
    expect(sandbox.calls[0]?.sandbox.policy.writablePaths).toEqual([WORKSPACE]);
    expect(sandbox.calls[0]?.stdin).toBe(PATCH);

    const tampered = structuredClone(raw) as any;
    tampered.tool.arguments.patch += "\nsecret mutation";
    await expect(gateway.execute(tampered, authority())).rejects.toMatchObject({
      reason: "integrity-mismatch",
    });
    const hiddenPath = structuredClone(raw) as any;
    hiddenPath.tool.arguments.patch = PATCH.replace(
      "src/index.ts",
      ".github/workflows/pwn.yml",
    );
    hiddenPath.tool.arguments.patch_digest = sha256Digest(hiddenPath.tool.arguments.patch);
    await expect(gateway.execute(hiddenPath, authority())).rejects.toMatchObject({
      reason: "integrity-mismatch",
    });
    expect(sandbox.calls).toHaveLength(1);
  });

  it("fails closed for unknown tools, checks, paths, roles, and repository control files", async () => {
    const { gateway, sandbox } = setup();
    const cases: readonly [unknown, ToolExecutionAuthority, string][] = [
      [
        { ...request(), tool: { name: "host.shell", arguments: { command: "env" } } },
        authority(),
        "malformed-request",
      ],
      [request("repository.search"), authority(), "unknown-tool"],
      [
        request("repository.read", {
          tool: { name: "repository.read", arguments: { path: "../outside", max_bytes: 1 } },
        }),
        authority(),
        "malformed-request",
      ],
      [
        request("repository.read", {
          tool: { name: "repository.read", arguments: { path: "docs/outside.md", max_bytes: 1 } },
        }),
        authority(),
        "path-refused",
      ],
      [
        request("repository.apply_patch", {
          tool: {
            name: "repository.apply_patch",
            arguments: {
              patch: "x",
              patch_digest: sha256Digest("x"),
              paths: [".github/workflows/pwn.yml"],
            },
          },
        }),
        authority({ pathScope: { allowedPaths: ["**"], forbiddenPaths: [] } }),
        "path-refused",
      ],
      [
        request("repository.apply_patch", { binding: binding("local-reviewer") }),
        authority({ ...binding("local-reviewer") }),
        "role-refused",
      ],
      [
        request("repository.check", {
          tool: { name: "repository.check", arguments: { check_id: "unregistered" } },
        }),
        authority(),
        "unknown-tool",
      ],
      [request("repository.check"), authority({ freshCandidate: false }), "path-refused"],
    ];

    for (const [raw, toolAuthority, reason] of cases) {
      await expect(gateway.execute(raw, toolAuthority)).rejects.toMatchObject({ reason });
    }
    expect(sandbox.calls).toHaveLength(0);
  });

  it("refuses every substituted binding or operator limit before sandbox execution", async () => {
    const { gateway, sandbox } = setup();
    for (const [field, value] of [
      ["run_id", "run-2"],
      ["work_order_id", "wo-2"],
      ["attempt_id", "attempt-2"],
      ["role", "fixer"],
      ["invocation_id", "invocation-2"],
      ["policy_digest", `sha256:${"c".repeat(64)}`],
      ["candidate_sha", "d".repeat(40)],
      ["fencing_generation", 8],
    ] as const) {
      const raw = request();
      (raw["binding"] as Record<string, unknown>)[field] = value;
      await expect(gateway.execute(raw, authority())).rejects.toMatchObject({
        reason: "binding-mismatch",
      });
    }
    await expect(
      gateway.execute(
        request("repository.read", {
          limits: { timeout_ms: 30_001, max_output_bytes: 4_096 },
        }),
        authority(),
      ),
    ).rejects.toMatchObject({ reason: "limit-refused" });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("checks the durable generation before and after sandbox execution", async () => {
    const denied = setup({ current: () => false });
    await expect(denied.gateway.execute(request(), authority())).rejects.toMatchObject({
      reason: "stale-generation",
    });
    expect(denied.sandbox.calls).toHaveLength(0);

    let checks = 0;
    const lost = setup({ current: () => ++checks === 1 });
    await expect(lost.gateway.execute(request(), authority())).rejects.toMatchObject({
      reason: "stale-generation",
    });
    expect(lost.sandbox.calls).toHaveLength(1);
  });

  it("bounds UTF-8 output, normalizes timeouts, and honors pre-start cancellation", async () => {
    const sandbox = new RestrictiveFakeSandbox();
    sandbox.result = {
      ...DEFAULT_SANDBOX_RESULT,
      outcome: "timeout",
      exitCode: null,
      stdout: "🙂".repeat(100),
    };
    const { gateway } = setup({ sandbox });
    const smallAuthority = authority({
      resourceLimits: { ...authority().resourceLimits, maxOutputBytes: 64 },
    });
    const smallRequest = request("repository.read", {
      limits: { timeout_ms: 30_000, max_output_bytes: 64 },
    });

    const timedOut = await gateway.execute(smallRequest, smallAuthority);
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.output.truncated).toBe(true);
    expect(timedOut.output.stdout).not.toContain("�");
    expect(timedOut.usage.output_bytes).toBeLessThanOrEqual(64);

    const controller = new AbortController();
    controller.abort("operator cancellation");
    const cancelled = await gateway.execute(smallRequest, smallAuthority, controller.signal);
    expect(cancelled.status).toBe("cancelled");
    expect(sandbox.calls).toHaveLength(1);
  });

  it("rejects ambient credential keys and non-production sandbox claims at construction", () => {
    expect(() => setup({ environment: { GITHUB_TOKEN: "secret" } })).toThrow(
      ToolGatewayRefusalError,
    );
    expect(
      () =>
        new RepositoryToolGateway({
          clock: new FakeClock(),
          fenceValidator: { isCurrent: () => true },
          sandbox: {
            mechanism: "seatbelt",
            enforcement: "best-effort",
            execute: async () => DEFAULT_SANDBOX_RESULT,
          } as unknown as CredentialFreeProductionSandbox,
          tools,
        }),
    ).toThrow(/lacks production isolation/);
  });

  it("treats an unexpected sandbox executor failure as a production-isolation refusal", async () => {
    const sandbox = new RestrictiveFakeSandbox();
    sandbox.onExecute = () => {
      throw new Error("bubblewrap setup failed");
    };
    const { gateway } = setup({ sandbox });

    await expect(gateway.execute(request(), authority())).rejects.toMatchObject({
      reason: "sandbox-not-production",
    });
  });

  it("refuses a registry entry that maps a repository tool to a generic host shell", async () => {
    const sandbox = new RestrictiveFakeSandbox();
    const shellTool: RegisteredRepositoryTool = {
      ...tools[0]!,
      buildInvocation: () => ({
        command: "/bin/sh",
        args: ["-c", "env"],
        repositoryPaths: ["src/index.ts"],
      }),
    };
    const gateway = new RepositoryToolGateway({
      clock: new FakeClock("2026-08-21T10:00:00Z"),
      fenceValidator: { isCurrent: () => true },
      sandbox,
      tools: [shellTool],
    });

    await expect(gateway.execute(request(), authority())).rejects.toMatchObject({
      reason: "tool-definition-refused",
    });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("keeps request and result schemas closed to command, environment, and credential fields", async () => {
    const { gateway } = setup();
    await expect(
      gateway.execute({ ...request(), command: "/bin/sh", env: { GH_TOKEN: "secret" } }, authority()),
    ).rejects.toMatchObject({ reason: "malformed-request" });
    expect(() =>
      parseAsfToolResult({
        schema: "asf.repository-tool-result/v1",
        github_token: "secret",
      }),
    ).toThrow(/versioned schema/);
  });
});
