import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ALWAYS_FORBIDDEN_PATHS } from "./task-packet.js";
import type { AgentRole } from "../domain/types.js";
import type { IdentityOwnershipFenceValidator } from "../identity/broker.js";
import type { Clock } from "../platform/clock.js";
import type { SandboxResult, SandboxRunInput } from "../workspace/sandbox.js";
import {
  evaluateChangedPathScope,
  normalizeRepositoryPath,
  type ChangeScope,
} from "../workspace/path-scope.js";
import { sha256Digest } from "../asf/canonical-json.js";

export const ASF_TOOL_REQUEST_SCHEMA = "asf.repository-tool-request/v1" as const;
export const ASF_TOOL_RESULT_SCHEMA = "asf.repository-tool-result/v1" as const;

export const ASF_REPOSITORY_TOOL_NAMES = [
  "repository.read",
  "repository.list",
  "repository.search",
  "repository.apply_patch",
  "repository.check",
] as const;

export type AsfRepositoryToolName = (typeof ASF_REPOSITORY_TOOL_NAMES)[number];

const AGENT_ROLES = [
  "implementer",
  "local-reviewer",
  "fixer",
  "pr-reviewer",
  "retrospective",
] as const satisfies readonly AgentRole[];

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const roleSchema = z.enum(AGENT_ROLES);
const toolNameSchema = z.enum(ASF_REPOSITORY_TOOL_NAMES);
const timestampSchema = z.iso.datetime({ offset: true });

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => {
    try {
      normalizeRepositoryPath(path);
      return true;
    } catch {
      return false;
    }
  }, "must be an unambiguous repository-relative path");

export const asfToolBindingSchema = z
  .object({
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    role: roleSchema,
    invocation_id: identifierSchema,
    policy_digest: digestSchema,
    candidate_sha: gitShaSchema,
    fencing_generation: z.number().int().positive(),
  })
  .strict();

const toolRequestBodySchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("repository.read"),
      arguments: z
        .object({
          path: repositoryPathSchema,
          max_bytes: z.number().int().min(1).max(1_048_576),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("repository.list"),
      arguments: z
        .object({
          path: repositoryPathSchema,
          max_entries: z.number().int().min(1).max(10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("repository.search"),
      arguments: z
        .object({
          path: repositoryPathSchema,
          query: z.string().min(1).max(4096),
          max_matches: z.number().int().min(1).max(10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("repository.apply_patch"),
      arguments: z
        .object({
          patch: z.string().min(1).max(1_048_576),
          patch_digest: digestSchema,
          paths: z.array(repositoryPathSchema).min(1).max(10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal("repository.check"),
      arguments: z
        .object({
          check_id: identifierSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const asfToolRequestSchema = z
  .object({
    schema: z.literal(ASF_TOOL_REQUEST_SCHEMA),
    request_id: identifierSchema,
    binding: asfToolBindingSchema,
    tool: toolRequestBodySchema,
    limits: z
      .object({
        timeout_ms: z.number().int().min(1).max(86_400_000),
        max_output_bytes: z.number().int().min(1).max(16_777_216),
      })
      .strict(),
  })
  .strict();

const toolStatusSchema = z.enum([
  "success",
  "failure",
  "refused",
  "cancelled",
  "timeout",
]);

export const asfToolResultSchema = z
  .object({
    schema: z.literal(ASF_TOOL_RESULT_SCHEMA),
    request_id: identifierSchema,
    request_digest: digestSchema,
    binding: asfToolBindingSchema,
    tool_name: toolNameSchema,
    status: toolStatusSchema,
    started_at: timestampSchema,
    completed_at: timestampSchema,
    exit_code: z.number().int().nullable(),
    output: z
      .object({
        stdout: z.string().max(16_777_216),
        stderr: z.string().max(16_777_216),
        truncated: z.boolean(),
      })
      .strict(),
    usage: z
      .object({
        wall_ms: z.number().finite().nonnegative(),
        output_bytes: z.number().int().nonnegative(),
      })
      .strict(),
    result_digest: digestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "success" && result.exit_code !== 0) {
      context.addIssue({
        code: "custom",
        path: ["exit_code"],
        message: "successful execution must have exit code zero",
      });
    }
    if (result.status === "timeout" && result.exit_code !== null) {
      context.addIssue({
        code: "custom",
        path: ["exit_code"],
        message: "timed-out execution cannot report a final exit code",
      });
    }
  });

export type AsfToolBinding = z.infer<typeof asfToolBindingSchema>;
export type AsfToolRequest = z.infer<typeof asfToolRequestSchema>;
export type AsfToolRequestBody = z.infer<typeof toolRequestBodySchema>;
export type AsfToolResult = z.infer<typeof asfToolResultSchema>;
export type AsfToolStatus = z.infer<typeof toolStatusSchema>;

export interface ToolResourceLimits {
  readonly cpuMillis: number;
  readonly memoryMib: number;
  readonly processes: number;
  readonly fileSizeBytes: number;
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
}

export interface ToolExecutionAuthority extends AsfToolBinding {
  readonly workspaceRoot: string;
  readonly pathScope: ChangeScope;
  readonly allowedTools: readonly AsfRepositoryToolName[];
  /** Operator-owned check identifiers; check ids never become commands. */
  readonly allowedCheckIds: readonly string[];
  readonly resourceLimits: ToolResourceLimits;
  /** A check must run in a workspace freshly materialized at candidateSha. */
  readonly freshCandidate: boolean;
}

export type RepositoryToolAccess = "read" | "write" | "verification";

/**
 * A direct process invocation derived from operator-owned registration.
 *
 * Model input cannot supply a command, argument vector, cwd, environment, or
 * network choice. `repositoryPaths` declares every path the invocation may
 * touch so the gateway can enforce the work-order scope before execution.
 */
export interface RegisteredToolInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string | undefined;
  readonly repositoryPaths: readonly string[];
}

export interface RegisteredRepositoryTool {
  readonly name: AsfRepositoryToolName;
  readonly access: RepositoryToolAccess;
  readonly allowedRoles: readonly AgentRole[];
  buildInvocation(
    request: AsfToolRequestBody,
    authority: ToolExecutionAuthority,
  ): RegisteredToolInvocation;
}

export interface CredentialFreeSandboxExecution {
  readonly sandbox: SandboxRunInput;
  readonly stdin?: string | undefined;
  readonly signal: AbortSignal;
  readonly limits: Omit<ToolResourceLimits, "maxOutputBytes" | "wallTimeMs">;
  readonly isolation: {
    readonly inheritEnvironment: false;
    readonly providerCredentials: "denied";
    readonly hostCredentialPaths: "denied";
    readonly hostSockets: "denied";
    readonly otherWorkspaces: "denied";
    readonly network: "disabled";
    readonly candidate: string;
    readonly freshCandidate: boolean;
  };
}

/**
 * Production adapter seam. The concrete implementation must enforce these
 * guarantees; the legacy Sandbox alone does not yet enforce resource limits or
 * cancellation and therefore is intentionally not accepted directly.
 */
export interface CredentialFreeProductionSandbox {
  readonly mechanism: "bubblewrap";
  readonly enforcement: "production-credential-free";
  execute(input: CredentialFreeSandboxExecution): Promise<SandboxResult>;
}

export type ToolGatewayRefusalReason =
  | "malformed-request"
  | "binding-mismatch"
  | "stale-generation"
  | "unknown-tool"
  | "role-refused"
  | "path-refused"
  | "integrity-mismatch"
  | "limit-refused"
  | "sandbox-not-production"
  | "tool-definition-refused";

export class ToolGatewayRefusalError extends Error {
  readonly code = "RM-ASF-TOOL-REFUSED";
  readonly reason: ToolGatewayRefusalReason;

  constructor(reason: ToolGatewayRefusalReason, summary: string) {
    super(`repository tool request refused: ${summary}`);
    this.name = "ToolGatewayRefusalError";
    this.reason = reason;
  }
}

export interface RepositoryToolGatewayOptions {
  readonly clock: Clock;
  readonly fenceValidator: IdentityOwnershipFenceValidator;
  readonly sandbox: CredentialFreeProductionSandbox;
  readonly tools: readonly RegisteredRepositoryTool[];
  /** Explicitly safe values only. Production should normally leave this empty. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** Values held elsewhere in the trusted host boundary and scrubbed defensively. */
  readonly sensitiveValues?: readonly string[] | undefined;
}

const SAFE_ENVIRONMENT_KEYS = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);
const FORBIDDEN_GENERIC_SHELLS = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "sh",
  "zsh",
]);
const CREDENTIAL_ASSIGNMENT =
  /\b(?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*|SSH_AUTH_SOCK|CTXLANE(?:_SOCKET|_HANDLE)?|AWS_SESSION_TOKEN)\s*[:=]\s*[^\s,;]+/giu;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

function refusal(reason: ToolGatewayRefusalReason, summary: string): never {
  throw new ToolGatewayRefusalError(reason, summary);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    refusal("limit-refused", `${label} is outside the production limit contract`);
  }
}

function sanitizeEnvironment(
  raw: Readonly<Record<string, string>> | undefined,
  sensitiveValues: readonly string[],
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key)) {
      refusal("sandbox-not-production", "tool environment contains a non-allowlisted key");
    }
    if (/\u0000|[\r\n]/u.test(value) || sensitiveValues.some((secret) => secret !== "" && value.includes(secret))) {
      refusal("sandbox-not-production", "tool environment contains protected data");
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

function redact(text: string, sensitiveValues: readonly string[]): string {
  let safe = text;
  for (const value of sensitiveValues) {
    if (value !== "") safe = safe.split(value).join("[REDACTED]");
  }
  safe = safe.replace(CREDENTIAL_ASSIGNMENT, "[REDACTED]");
  return safe.replace(CREDENTIAL_URL, "$1[REDACTED]@");
}

function utf8Prefix(text: string, limit: number): string {
  let output = "";
  let used = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (used + width > limit) break;
    output += character;
    used += width;
  }
  return output;
}

function utf8Suffix(text: string, limit: number): string {
  const characters = [...text];
  const output: string[] = [];
  let used = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] ?? "";
    const width = Buffer.byteLength(character, "utf8");
    if (used + width > limit) break;
    output.push(character);
    used += width;
  }
  return output.reverse().join("");
}

function boundedUtf8(text: string, limit: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  if (limit === 0) return { text: "", truncated: true };

  const marker = Buffer.from("[...truncated...]\n", "utf8");
  if (marker.length >= limit) {
    return { text: utf8Prefix(text, limit), truncated: true };
  }
  return {
    text: `${marker.toString("utf8")}${utf8Suffix(text, limit - marker.length)}`,
    truncated: true,
  };
}

function requestPaths(tool: AsfToolRequestBody): readonly string[] {
  switch (tool.name) {
    case "repository.read":
    case "repository.list":
    case "repository.search":
      return [tool.arguments.path];
    case "repository.apply_patch":
      return tool.arguments.paths;
    case "repository.check":
      return [];
  }
}

function pathsDeclaredByPatch(patch: string): readonly string[] {
  const normalized = patch.replaceAll("\r\n", "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    refusal("integrity-mismatch", "patch does not use the registered patch envelope");
  }
  const paths: string[] = [];
  for (const line of lines) {
    const file = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u)?.[1];
    const move = line.match(/^\*\*\* Move to: (.+)$/u)?.[1];
    const candidate = file ?? move;
    if (candidate === undefined) continue;
    try {
      paths.push(normalizeRepositoryPath(candidate));
    } catch {
      refusal("path-refused", "patch contains an invalid repository path");
    }
  }
  if (paths.length === 0) refusal("integrity-mismatch", "patch declares no repository files");
  return [...new Set(paths)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function expectedAccess(name: AsfRepositoryToolName): RepositoryToolAccess {
  if (name === "repository.apply_patch") return "write";
  if (name === "repository.check") return "verification";
  return "read";
}

function sameBinding(request: AsfToolBinding, authority: ToolExecutionAuthority): boolean {
  return (
    request.run_id === authority.run_id &&
    request.work_order_id === authority.work_order_id &&
    request.attempt_id === authority.attempt_id &&
    request.role === authority.role &&
    request.invocation_id === authority.invocation_id &&
    request.policy_digest === authority.policy_digest &&
    request.candidate_sha === authority.candidate_sha &&
    request.fencing_generation === authority.fencing_generation
  );
}

function assertScopedPaths(
  paths: readonly string[],
  authority: ToolExecutionAuthority,
  mutation: boolean,
): void {
  const result = evaluateChangedPathScope(paths, {
    allowedPaths: authority.pathScope.allowedPaths,
    forbiddenPaths: mutation
      ? [...authority.pathScope.forbiddenPaths, ...ALWAYS_FORBIDDEN_PATHS]
      : authority.pathScope.forbiddenPaths,
  });
  if (!result.accepted) refusal("path-refused", "a repository path is outside the admitted scope");
}

function safeInvocation(invocation: RegisteredToolInvocation): void {
  if (
    !isAbsolute(invocation.command) ||
    invocation.command.trim() === "" ||
    invocation.command.includes("\0") ||
    invocation.args.some((argument) => argument.includes("\0")) ||
    FORBIDDEN_GENERIC_SHELLS.has(basename(invocation.command).toLowerCase())
  ) {
    refusal(
      "tool-definition-refused",
      "registered tool produced a non-absolute, shell-based, or invalid direct invocation",
    );
  }
  for (const path of invocation.repositoryPaths) {
    try {
      normalizeRepositoryPath(path);
    } catch {
      refusal("tool-definition-refused", "registered tool produced an invalid repository path");
    }
  }
}

/** Strictly parse a portable tool request. Unknown fields and tool names fail closed. */
export function parseAsfToolRequest(raw: unknown): AsfToolRequest {
  const parsed = asfToolRequestSchema.safeParse(raw);
  if (!parsed.success) refusal("malformed-request", "request does not match the versioned schema");
  return parsed.data;
}

/** Strictly parse a normalized public tool result. */
export function parseAsfToolResult(raw: unknown): AsfToolResult {
  const parsed = asfToolResultSchema.safeParse(raw);
  if (!parsed.success) refusal("malformed-request", "result does not match the versioned schema");
  if (Date.parse(parsed.data.started_at) > Date.parse(parsed.data.completed_at)) {
    refusal("malformed-request", "result timestamps are contradictory");
  }
  const actualOutputBytes =
    Buffer.byteLength(parsed.data.output.stdout, "utf8") +
    Buffer.byteLength(parsed.data.output.stderr, "utf8");
  if (actualOutputBytes !== parsed.data.usage.output_bytes || actualOutputBytes > 16_777_216) {
    refusal("integrity-mismatch", "result output contradicts its byte accounting");
  }
  const { result_digest: resultDigest, ...unsigned } = parsed.data;
  if (sha256Digest(unsigned) !== resultDigest) {
    refusal("integrity-mismatch", "result content does not match its digest");
  }
  return parsed.data;
}

/**
 * Fenced, allowlisted repository-tool executor.
 *
 * It has no host-shell operation and it always executes direct invocations in
 * a credential-free production sandbox with networking disabled.
 */
export class RepositoryToolGateway {
  readonly #clock: Clock;
  readonly #fenceValidator: IdentityOwnershipFenceValidator;
  readonly #sandbox: CredentialFreeProductionSandbox;
  readonly #tools: ReadonlyMap<AsfRepositoryToolName, RegisteredRepositoryTool>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #sensitiveValues: readonly string[];

  constructor(options: RepositoryToolGatewayOptions) {
    if (
      options.sandbox.mechanism !== "bubblewrap" ||
      options.sandbox.enforcement !== "production-credential-free"
    ) {
      refusal("sandbox-not-production", "executor lacks production isolation guarantees");
    }
    this.#clock = options.clock;
    this.#fenceValidator = options.fenceValidator;
    this.#sandbox = options.sandbox;
    this.#sensitiveValues = Object.freeze([...(options.sensitiveValues ?? [])]);
    this.#environment = sanitizeEnvironment(options.environment, this.#sensitiveValues);

    const tools = new Map<AsfRepositoryToolName, RegisteredRepositoryTool>();
    for (const tool of options.tools) {
      if (!toolNameSchema.safeParse(tool.name).success || tools.has(tool.name)) {
        refusal("tool-definition-refused", "tool registry is invalid or contains duplicates");
      }
      if (tool.access !== expectedAccess(tool.name) || tool.allowedRoles.length === 0) {
        refusal("tool-definition-refused", "tool registration grants an invalid capability");
      }
      tools.set(tool.name, tool);
    }
    this.#tools = tools;
  }

  async execute(
    rawRequest: unknown,
    authority: ToolExecutionAuthority,
    signal: AbortSignal = new AbortController().signal,
    invocationSensitiveValues: readonly string[] = [],
  ): Promise<AsfToolResult> {
    const request = parseAsfToolRequest(rawRequest);
    this.#assertAuthority(request, authority);

    const registered = this.#tools.get(request.tool.name);
    if (registered === undefined || !authority.allowedTools.includes(request.tool.name)) {
      refusal("unknown-tool", "tool is not registered and admitted for this invocation");
    }
    if (!registered.allowedRoles.includes(authority.role)) {
      refusal("role-refused", "role is not authorized for this repository tool");
    }
    if (registered.access === "write" && authority.role !== "implementer" && authority.role !== "fixer") {
      refusal("role-refused", "only an implementation role may mutate the repository");
    }
    if (registered.access === "verification" && !authority.freshCandidate) {
      refusal("path-refused", "verification requires a fresh exact-candidate workspace");
    }
    if (
      request.tool.name === "repository.check" &&
      !authority.allowedCheckIds.includes(request.tool.arguments.check_id)
    ) {
      refusal("unknown-tool", "check id is not registered in operator policy");
    }

    const paths = requestPaths(request.tool);
    assertScopedPaths(paths, authority, registered.access === "write");
    if (
      request.tool.name === "repository.apply_patch" &&
      sha256Digest(request.tool.arguments.patch) !== request.tool.arguments.patch_digest
    ) {
      refusal("integrity-mismatch", "patch bytes do not match the bound digest");
    }
    if (
      request.tool.name === "repository.apply_patch" &&
      !sameStringSet(
        pathsDeclaredByPatch(request.tool.arguments.patch),
        request.tool.arguments.paths,
      )
    ) {
      refusal("integrity-mismatch", "patch file headers do not match its declared path set");
    }

    const currentBefore = await this.#isCurrent(authority);
    if (!currentBefore) refusal("stale-generation", "ownership fence is not current");

    let invocation: RegisteredToolInvocation;
    try {
      invocation = registered.buildInvocation(request.tool, authority);
    } catch {
      refusal("tool-definition-refused", "registered tool could not derive an invocation");
    }
    safeInvocation(invocation);
    assertScopedPaths(invocation.repositoryPaths, authority, registered.access === "write");

    const startedAt = this.#clock.now().toISOString();
    const startedMonotonic = this.#clock.monotonicMs();
    let sandboxResult: SandboxResult;
    if (signal.aborted) {
      sandboxResult = {
        outcome: "signaled",
        exitCode: null,
        signal: "ABORT",
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    } else {
      try {
        sandboxResult = await this.#sandbox.execute({
          sandbox: {
            command: invocation.command,
            args: invocation.args,
            cwd: authority.workspaceRoot,
            timeoutMs: authority.resourceLimits.wallTimeMs,
            env: this.#environment,
            policy: {
              writablePaths: registered.access === "write" ? [authority.workspaceRoot] : [],
              readablePaths: [authority.workspaceRoot],
              protectedPaths: [
                join(authority.workspaceRoot, ".git"),
                join(authority.workspaceRoot, ".runmill"),
              ],
              allowNetwork: false,
            },
          },
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          signal,
          limits: {
            cpuMillis: authority.resourceLimits.cpuMillis,
            memoryMib: authority.resourceLimits.memoryMib,
            processes: authority.resourceLimits.processes,
            fileSizeBytes: authority.resourceLimits.fileSizeBytes,
          },
          isolation: {
            inheritEnvironment: false,
            providerCredentials: "denied",
            hostCredentialPaths: "denied",
            hostSockets: "denied",
            otherWorkspaces: "denied",
            network: "disabled",
            candidate: authority.candidate_sha,
            freshCandidate: authority.freshCandidate,
          },
        });
      } catch {
        if (signal.aborted) {
          sandboxResult = {
            outcome: "signaled",
            exitCode: null,
            signal: "ABORT",
            stdout: "",
            stderr: "",
            durationMs: 0,
          };
        } else {
          refusal(
            "sandbox-not-production",
            "production sandbox executor failed to establish or complete isolation",
          );
        }
      }
    }

    const currentAfter = await this.#isCurrent(authority);
    if (!currentAfter) refusal("stale-generation", "ownership fence was lost during execution");

    const completedAt = this.#clock.now().toISOString();
    const wallMs = Math.max(0, this.#clock.monotonicMs() - startedMonotonic);
    const status = this.#statusFor(sandboxResult, signal, wallMs, authority.resourceLimits.wallTimeMs);
    const redactionValues = [...this.#sensitiveValues, ...invocationSensitiveValues];
    const stdoutBudget = Math.floor(authority.resourceLimits.maxOutputBytes / 2);
    const safeStdout = boundedUtf8(
      redact(sandboxResult.stdout, redactionValues),
      stdoutBudget,
    );
    const remaining = Math.max(
      0,
      authority.resourceLimits.maxOutputBytes - Buffer.byteLength(safeStdout.text, "utf8"),
    );
    const safeStderr = boundedUtf8(
      redact(sandboxResult.stderr, redactionValues),
      remaining,
    );
    const outputBytes =
      Buffer.byteLength(safeStdout.text, "utf8") + Buffer.byteLength(safeStderr.text, "utf8");

    const unsigned = {
      schema: ASF_TOOL_RESULT_SCHEMA,
      request_id: request.request_id,
      request_digest: sha256Digest(request),
      binding: request.binding,
      tool_name: request.tool.name,
      status,
      started_at: startedAt,
      completed_at: completedAt,
      exit_code:
        status === "success" || status === "failure" ? sandboxResult.exitCode : null,
      output: {
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        truncated: safeStdout.truncated || safeStderr.truncated,
      },
      usage: { wall_ms: wallMs, output_bytes: outputBytes },
    } satisfies Omit<AsfToolResult, "result_digest">;

    return parseAsfToolResult({
      ...unsigned,
      result_digest: sha256Digest(unsigned),
    });
  }

  #assertAuthority(request: AsfToolRequest, authority: ToolExecutionAuthority): void {
    const authorityBinding: AsfToolBinding = {
      run_id: authority.run_id,
      work_order_id: authority.work_order_id,
      attempt_id: authority.attempt_id,
      role: authority.role,
      invocation_id: authority.invocation_id,
      policy_digest: authority.policy_digest,
      candidate_sha: authority.candidate_sha,
      fencing_generation: authority.fencing_generation,
    };
    if (
      !asfToolBindingSchema.safeParse(authorityBinding).success ||
      !sameBinding(request.binding, authority)
    ) {
      refusal("binding-mismatch", "request is not exact-bound to invocation authority");
    }
    if (!isAbsolute(authority.workspaceRoot) || authority.workspaceRoot.includes("\0")) {
      refusal("path-refused", "workspace root is not an absolute trusted path");
    }
    for (const [label, value] of Object.entries(authority.resourceLimits)) {
      assertPositiveInteger(value, label);
    }
    if (
      authority.resourceLimits.cpuMillis > 64_000 ||
      authority.resourceLimits.memoryMib > 262_144 ||
      authority.resourceLimits.processes > 4_096 ||
      authority.resourceLimits.fileSizeBytes > 1_099_511_627_776 ||
      authority.resourceLimits.wallTimeMs > 86_400_000 ||
      authority.resourceLimits.maxOutputBytes > 16_777_216
    ) {
      refusal("limit-refused", "operator resource limit exceeds the production ceiling");
    }
    if (
      request.limits.timeout_ms !== authority.resourceLimits.wallTimeMs ||
      request.limits.max_output_bytes !== authority.resourceLimits.maxOutputBytes
    ) {
      refusal("limit-refused", "request limits do not match operator authority");
    }
  }

  async #isCurrent(authority: ToolExecutionAuthority): Promise<boolean> {
    try {
      return (
        (await this.#fenceValidator.isCurrent({
          runId: authority.run_id,
          workOrderId: authority.work_order_id,
          attemptId: authority.attempt_id,
          fencingGeneration: authority.fencing_generation,
        })) === true
      );
    } catch {
      return false;
    }
  }

  #statusFor(
    result: SandboxResult,
    signal: AbortSignal,
    wallMs: number,
    timeoutMs: number,
  ): AsfToolStatus {
    if (signal.aborted) return "cancelled";
    if (wallMs > timeoutMs) return "timeout";
    if (result.outcome === "timeout") return "timeout";
    if (result.outcome === "sandbox-denied") return "refused";
    if (result.outcome === "signaled") return "cancelled";
    return result.exitCode === 0 ? "success" : "failure";
  }
}
