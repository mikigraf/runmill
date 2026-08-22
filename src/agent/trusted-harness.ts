import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../asf/canonical-json.js";
import { AuthorizedImplementerResume } from "../asf/checkpoint-policy.js";
import {
  ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
  identityLeaseAttributionDigest,
} from "../asf/identity-attribution.js";
import type { AgentRole } from "../domain/types.js";
import { assertResumable } from "./adapter.js";
import {
  POLICY_DIGEST_PATTERN,
  identityOwnershipFenceFor,
  type IdentityExecutionHandle,
  type IdentityLease,
  type IdentityOwnershipFenceValidator,
} from "../identity/broker.js";
import type { Clock } from "../platform/clock.js";
import type { ChangeScope } from "../workspace/path-scope.js";
import {
  ASF_REPOSITORY_TOOL_NAMES,
  ASF_TOOL_RESULT_SCHEMA,
  RepositoryToolGateway,
  parseAsfToolRequest,
  type AsfRepositoryToolName,
  type AsfToolRequest,
  type AsfToolResult,
  type ToolResourceLimits,
} from "./tool-gateway.js";

export const ASF_MODEL_REQUEST_SCHEMA = "asf.model-request/v1" as const;
export const ASF_MODEL_RESULT_SCHEMA = "asf.model-result/v1" as const;
export const ASF_PROVIDER_REQUEST_SCHEMA = "asf.provider-request/v1" as const;
export const ASF_PROVIDER_RESULT_SCHEMA = "asf.provider-result/v1" as const;
export const ASF_PROVIDER_EVENT_SCHEMA = "asf.provider-event/v1" as const;
export const ASF_PROTECTED_SESSION_SCHEMA =
  "asf.protected-implementer-session/v1" as const;
export const ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA =
  "asf.trusted-implementer-resume-descriptor/v1" as const;
export const ASF_PROVIDER_BACKEND_SCHEMA = "asf.provider-backend/v1" as const;

export const ASF_PROVIDER_BACKENDS = [
  "host-credential-harness",
  "direct-cli",
  "copied-provider-home",
  "fake",
] as const;

export type AsfProviderBackend = (typeof ASF_PROVIDER_BACKENDS)[number];

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
const timestampSchema = z.iso.datetime({ offset: true });
const hmacSchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u);
const roleSchema = z.enum(AGENT_ROLES);
const toolNameSchema = z.enum(ASF_REPOSITORY_TOOL_NAMES);

const exactBindingSchema = z
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

function sortedUnique<T extends z.ZodType<string>>(item: T, minimum = 0) {
  return z
    .array(item)
    .min(minimum)
    .superRefine((values, context) => {
      for (let index = 1; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          previous >= current
        ) {
          context.addIssue({
            code: "custom",
            message: "must be unique and lexically sorted",
          });
          return;
        }
      }
    });
}

const providerUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().finite().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  })
  .strict();

const providerLimitsSchema = z
  .object({
    timeout_ms: z.number().int().min(1).max(86_400_000),
    max_turns: z.number().int().min(1).max(10_000),
    max_input_tokens: z.number().int().min(1).max(100_000_000),
    max_output_tokens: z.number().int().min(1).max(100_000_000),
    max_output_bytes: z.number().int().min(1).max(268_435_456),
    max_cost_usd: z.number().finite().nonnegative().max(1_000_000),
    max_events: z.number().int().min(1).max(1_000_000),
    max_tool_calls: z.number().int().min(0).max(100_000),
  })
  .strict();

export const protectedImplementerSessionSchema = z
  .object({
    schema: z.literal(ASF_PROTECTED_SESSION_SCHEMA),
    protected_session_ref: digestSchema,
    lease_digest: digestSchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    invocation_id: identifierSchema,
    policy_digest: digestSchema,
    task_packet_digest: digestSchema,
    instruction_digest: digestSchema,
    context_set_digest: digestSchema,
    candidate_sha: gitShaSchema,
    fencing_generation: z.number().int().positive(),
    provider: identifierSchema,
    model: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    issued_at: timestampSchema,
    binding_mac: hmacSchema,
  })
  .strict();

const providerSessionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fresh") }).strict(),
  z
    .object({
      mode: z.literal("resume"),
      metadata_digest: digestSchema,
    })
    .strict(),
]);

export const asfModelRequestSchema = z
  .object({
    schema: z.literal(ASF_MODEL_REQUEST_SCHEMA),
    request_id: identifierSchema,
    binding: exactBindingSchema,
    provider: identifierSchema,
    model: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    task_packet_digest: digestSchema,
    instruction_digest: digestSchema,
    context_digests: sortedUnique(digestSchema),
    allowed_tools: sortedUnique(toolNameSchema),
    allowed_check_ids: sortedUnique(identifierSchema),
    limits: providerLimitsSchema,
  })
  .strict();

export const asfProviderRequestSchema = z
  .object({
    schema: z.literal(ASF_PROVIDER_REQUEST_SCHEMA),
    model_request: asfModelRequestSchema,
    session: providerSessionSchema,
  })
  .strict();

const providerStatusSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "timeout",
]);
const providerFailureSchema = z
  .object({
    class: z.enum([
      "authentication",
      "rate-limit",
      "transport",
      "provider-internal",
      "policy-refusal",
      "tool-failure",
    ]),
    retryable: z.boolean(),
  })
  .strict();

const providerEventBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.started"),
    })
    .strict(),
  z
    .object({
      type: z.literal("model.output"),
      output_digest: digestSchema,
      byte_count: z.number().int().nonnegative().max(268_435_456),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool.requested"),
      tool_request_id: identifierSchema,
      tool_name: toolNameSchema,
      request_digest: digestSchema,
      arguments_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tool.completed"),
      tool_request_id: identifierSchema,
      tool_name: toolNameSchema,
      status: z.enum(["success", "failure", "refused", "cancelled", "timeout"]),
      result_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("usage.updated"),
      cumulative: z.literal(true),
      usage: providerUsageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.completed"),
      status: providerStatusSchema,
    })
    .strict(),
]);

export const asfProviderEventSchema = z
  .object({
    schema: z.literal(ASF_PROVIDER_EVENT_SCHEMA),
    request_id: identifierSchema,
    binding: exactBindingSchema,
    sequence: z.number().int().positive(),
    observed_at: timestampSchema,
    event: providerEventBodySchema,
  })
  .strict();

export const asfModelResultSchema = z
  .object({
    schema: z.literal(ASF_MODEL_RESULT_SCHEMA),
    request_id: identifierSchema,
    binding: exactBindingSchema,
    provider: identifierSchema,
    model: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    task_packet_digest: digestSchema,
    instruction_digest: digestSchema,
    context_set_digest: digestSchema,
    status: providerStatusSchema,
    output_digest: digestSchema.nullable(),
    output_bytes: z.number().int().nonnegative().max(268_435_456),
    turns: z.number().int().nonnegative(),
    usage: providerUsageSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "success" && result.output_digest === null) {
      context.addIssue({
        code: "custom",
        path: ["output_digest"],
        message: "required on success",
      });
    }
    if (result.status !== "success" && result.output_digest !== null) {
      context.addIssue({
        code: "custom",
        path: ["output_digest"],
        message: "allowed only on success",
      });
    }
  });

export const asfProviderResultSchema = z
  .object({
    schema: z.literal(ASF_PROVIDER_RESULT_SCHEMA),
    started_at: timestampSchema,
    completed_at: timestampSchema,
    model_result: asfModelResultSchema,
    events: z.array(asfProviderEventSchema).max(1_000_000),
    resume_metadata_digest: digestSchema.nullable(),
    failure: providerFailureSchema.nullable(),
    result_digest: digestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.model_result.status === "failure" && result.failure === null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "required on failure",
      });
    }
    if (result.model_result.status !== "failure" && result.failure !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "allowed only on failure",
      });
    }
    if (
      (result.model_result.status === "cancelled" ||
        result.model_result.status === "timeout") &&
      result.resume_metadata_digest !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["resume_metadata_digest"],
        message: "cancelled or timed-out sessions are not resumable",
      });
    }
  });

export const asfProviderBackendSchema = z
  .object({
    schema: z.literal(ASF_PROVIDER_BACKEND_SCHEMA),
    backend: z.enum(ASF_PROVIDER_BACKENDS),
  })
  .strict();

export type ProtectedImplementerSession = z.infer<
  typeof protectedImplementerSessionSchema
>;
export type AsfModelRequest = z.infer<typeof asfModelRequestSchema>;
export type AsfProviderRequest = z.infer<typeof asfProviderRequestSchema>;
export type AsfProviderEvent = z.infer<typeof asfProviderEventSchema>;
export type AsfModelResult = z.infer<typeof asfModelResultSchema>;
export type AsfProviderResult = z.infer<typeof asfProviderResultSchema>;
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export type ProviderEventBody = z.infer<typeof providerEventBodySchema>;

const protectedResumeCapabilityBrand: unique symbol = Symbol(
  "ProtectedResumeCapability",
);
const authorizedResumeBindingBrand: unique symbol = Symbol(
  "AuthorizedResumeBinding",
);

/**
 * Non-serializable handle to metadata that belongs in protected controller
 * storage, never in normalized requests, events, evidence, or public results.
 */
export interface ProtectedResumeCapability {
  readonly [protectedResumeCapabilityBrand]: true;
  readonly [authorizedResumeBindingBrand]?:
    | AuthorizedImplementerResume["binding"]
    | undefined;
  useMetadata<T>(operation: (metadata: ProtectedImplementerSession) => T): T;
}

/**
 * Protected runtime storage used only by the trusted harness. Implementations
 * must durably seal the authenticated session metadata and must not return it
 * through public events, evidence, logs, or support output.
 */
export interface ProtectedImplementerSessionVault {
  load(input: {
    readonly protectedResumeRef: string;
    readonly sessionIdentityDigest: string;
    readonly authorizationBinding: AuthorizedImplementerResume["binding"];
  }): Promise<unknown>;
}

export interface TrustedImplementerResumeDescriptor {
  readonly schema: typeof ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA;
  readonly authorization_digest: string;
  readonly session_identity_digest: string;
  readonly invocation_id: string;
  readonly provider_candidate_sha: string;
  readonly task_packet_digest: string;
  readonly descriptor_digest: string;
}

export interface TrustedProviderExecution {
  readonly result: AsfProviderResult;
  readonly protectedResume: ProtectedResumeCapability | null;
}

function protectedResumeCapability(
  metadata: ProtectedImplementerSession,
  authorizationBinding?: AuthorizedImplementerResume["binding"],
): ProtectedResumeCapability {
  return Object.freeze({
    [protectedResumeCapabilityBrand]: true as const,
    ...(authorizationBinding === undefined
      ? {}
      : { [authorizedResumeBindingBrand]: authorizationBinding }),
    useMetadata<T>(operation: (value: ProtectedImplementerSession) => T): T {
      return operation(metadata);
    },
  });
}

export interface ProviderHarnessMaximums {
  readonly timeoutMs: number;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly outputBytes: number;
  readonly costUsd: number;
  readonly events: number;
  readonly toolCalls: number;
}

export interface ProviderHarnessScheduledTask {
  cancel(): void;
}

export interface ProviderHarnessScheduler {
  schedule(delayMs: number, task: () => void): ProviderHarnessScheduledTask;
}

const DEFAULT_HARNESS_SCHEDULER: ProviderHarnessScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface ProviderRepositoryAuthority {
  readonly invocationId: string;
  readonly candidateSha: string;
  readonly taskPacketDigest: string;
  readonly instructionDigest: string;
  readonly contextDigests: readonly string[];
  readonly model: string;
  readonly workspaceRoot: string;
  readonly pathScope: ChangeScope;
  readonly allowedTools: readonly AsfRepositoryToolName[];
  readonly allowedCheckIds: readonly string[];
  readonly toolResourceLimits: ToolResourceLimits;
  readonly freshCandidate: boolean;
}

interface TransportEvent {
  readonly sequence: number;
  readonly observed_at: string;
  readonly event: ProviderEventBody;
}

interface CompletedTool {
  readonly request: AsfToolRequest;
  readonly argumentsDigest: string;
  readonly result: AsfToolResult;
}

export interface TrustedProviderTransportResult {
  readonly status: "success" | "failure" | "cancelled" | "timeout";
  readonly output_digest: string | null;
  readonly output_bytes: number;
  readonly turns: number;
  readonly usage: ProviderUsage;
  readonly events: readonly TransportEvent[];
  /** Digest/reference to a session record held in protected storage, never a raw session id. */
  readonly protected_session_ref: string | null;
  readonly failure: z.infer<typeof providerFailureSchema> | null;
}

const transportEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    observed_at: timestampSchema,
    event: providerEventBodySchema,
  })
  .strict();

const trustedProviderTransportResultSchema = z
  .object({
    status: providerStatusSchema,
    output_digest: digestSchema.nullable(),
    output_bytes: z.number().int().nonnegative().max(268_435_456),
    turns: z.number().int().nonnegative(),
    usage: providerUsageSchema,
    events: z.array(transportEventSchema).max(1_000_000),
    protected_session_ref: digestSchema.nullable(),
    failure: providerFailureSchema.nullable(),
  })
  .strict();

const trustedProviderAuthorityBrand: unique symbol = Symbol(
  "TrustedProviderAuthority",
);

/**
 * Non-serializable capability passed only to the host-side provider transport.
 * Neither secret is an enumerable field and this type cannot be constructed by
 * an untrusted adapter because the brand is module-private.
 */
export interface TrustedProviderAuthority {
  readonly [trustedProviderAuthorityBrand]: true;
  useProviderCredential<T>(operation: (credential: string) => T): T;
  useExecutionHandle<T>(operation: (handle: IdentityExecutionHandle) => T): T;
}

function trustedProviderAuthority(
  credential: string,
  executionHandle: IdentityExecutionHandle,
): {
  readonly authority: TrustedProviderAuthority;
  readonly revoke: () => void;
} {
  let active = true;
  const requireActive = (): void => {
    if (!active) {
      refuse(
        "provider-result-refused",
        "provider authority was used after its invocation ended",
      );
    }
  };
  return {
    authority: Object.freeze({
      [trustedProviderAuthorityBrand]: true as const,
      useProviderCredential<T>(operation: (value: string) => T): T {
        requireActive();
        return operation(credential);
      },
      useExecutionHandle<T>(
        operation: (value: IdentityExecutionHandle) => T,
      ): T {
        requireActive();
        return operation(executionHandle);
      },
    }),
    revoke: () => {
      active = false;
    },
  };
}

export interface TrustedProviderTransportInput {
  readonly authority: TrustedProviderAuthority;
  readonly resume: ProtectedResumeCapability | null;
  readonly request: AsfProviderRequest;
  readonly signal: AbortSignal;
  /** Monotonic deadline; the transport must terminate its process tree when reached. */
  readonly deadlineMonotonicMs: number;
  invokeTool(rawRequest: unknown): Promise<AsfToolResult>;
}

/** Host-side only. Implementations may reveal the branded authority but must never serialize it. */
export interface TrustedProviderTransport {
  execute(input: TrustedProviderTransportInput): Promise<unknown>;
}

export type ProviderHarnessRefusalReason =
  | "malformed-request"
  | "backend-refused"
  | "identity-mismatch"
  | "lease-inactive"
  | "stale-generation"
  | "limit-refused"
  | "role-refused"
  | "session-refused"
  | "tool-policy-refused"
  | "malformed-provider-result"
  | "provider-result-refused";

export class ProviderHarnessRefusalError extends Error {
  readonly code = "RM-ASF-PROVIDER-REFUSED";
  readonly reason: ProviderHarnessRefusalReason;

  constructor(reason: ProviderHarnessRefusalReason, summary: string) {
    super(`provider invocation refused: ${summary}`);
    this.name = "ProviderHarnessRefusalError";
    this.reason = reason;
  }
}

export interface TrustedProviderHarnessOptions {
  readonly backend: AsfProviderBackend;
  readonly providerCredential: string;
  /** Dedicated high-entropy key for authenticating protected resume metadata. */
  readonly sessionProtectionKey: string | Uint8Array;
  readonly clock: Clock;
  readonly fenceValidator: IdentityOwnershipFenceValidator;
  readonly transport: TrustedProviderTransport;
  readonly toolGateway: RepositoryToolGateway;
  readonly maximums: ProviderHarnessMaximums;
  readonly scheduler?: ProviderHarnessScheduler | undefined;
  /** How often a live provider process is re-fenced against durable ownership. */
  readonly fenceCheckIntervalMs?: number | undefined;
  /** Host-only socket/token/path values scrubbed from any sandbox output. */
  readonly protectedHostValues?: readonly string[] | undefined;
}

function refuse(reason: ProviderHarnessRefusalReason, summary: string): never {
  throw new ProviderHarnessRefusalError(reason, summary);
}

function equalBinding(
  request: z.infer<typeof exactBindingSchema>,
  lease: IdentityLease,
): boolean {
  return (
    request.run_id === lease.runId &&
    request.work_order_id === lease.workOrderId &&
    request.attempt_id === lease.attemptId &&
    request.role === lease.role &&
    request.policy_digest === lease.policyDigest &&
    request.fencing_generation === lease.fencingGeneration
  );
}

function equalExactBindings(
  left: z.infer<typeof exactBindingSchema>,
  right: z.infer<typeof exactBindingSchema>,
): boolean {
  return (
    left.run_id === right.run_id &&
    left.work_order_id === right.work_order_id &&
    left.attempt_id === right.attempt_id &&
    left.role === right.role &&
    left.invocation_id === right.invocation_id &&
    left.policy_digest === right.policy_digest &&
    left.candidate_sha === right.candidate_sha &&
    left.fencing_generation === right.fencing_generation
  );
}

function isSubset<T>(values: readonly T[], authority: readonly T[]): boolean {
  return values.every((value) => authority.includes(value));
}

function sameUsage(left: ProviderUsage, right: ProviderUsage): boolean {
  return (
    left.input_tokens === right.input_tokens &&
    left.output_tokens === right.output_tokens &&
    left.cost_usd === right.cost_usd &&
    left.tool_calls === right.tool_calls
  );
}

/** Development backends stay explicit and can never be mistaken for ASF production. */
export function classifyProviderBackend(backend: AsfProviderBackend): {
  readonly backend: AsfProviderBackend;
  readonly productionEligible: boolean;
  readonly classification: "production" | "development-only";
} {
  const parsed = asfProviderBackendSchema.safeParse({
    schema: ASF_PROVIDER_BACKEND_SCHEMA,
    backend,
  });
  if (!parsed.success) refuse("backend-refused", "provider backend is unknown");
  const productionEligible = parsed.data.backend === "host-credential-harness";
  return {
    backend: parsed.data.backend,
    productionEligible,
    classification: productionEligible ? "production" : "development-only",
  };
}

export function requireProductionProviderBackend(
  backend: AsfProviderBackend,
): void {
  if (!classifyProviderBackend(backend).productionEligible) {
    refuse(
      "backend-refused",
      "development provider backends are not valid for ASF production",
    );
  }
}

export function parseAsfProviderRequest(raw: unknown): AsfProviderRequest {
  const parsed = asfProviderRequestSchema.safeParse(raw);
  if (!parsed.success)
    refuse("malformed-request", "request does not match the versioned schema");
  return parsed.data;
}

export function parseAsfProviderResult(raw: unknown): AsfProviderResult {
  const parsed = asfProviderResultSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      "malformed-provider-result",
      "result does not match the versioned public schema",
    );
  }
  const result = parsed.data;
  const startedAt = Date.parse(result.started_at);
  const completedAt = Date.parse(result.completed_at);
  if (startedAt > completedAt) {
    refuse(
      "malformed-provider-result",
      "provider result timestamps are contradictory",
    );
  }
  let sessionStarted = false;
  let terminalStatus: AsfModelResult["status"] | undefined;
  let previousEventTime = -Infinity;
  let latestUsage: ProviderUsage | undefined;
  let modelOutputBytes = 0;
  const requestedTools = new Map<string, AsfRepositoryToolName>();
  const completedTools = new Set<string>();
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index];
    if (event === undefined || event.sequence !== index + 1) {
      refuse(
        "provider-result-refused",
        "provider event sequence is not contiguous",
      );
    }
    const eventTime = Date.parse(event.observed_at);
    if (
      event.request_id !== result.model_result.request_id ||
      !equalExactBindings(event.binding, result.model_result.binding) ||
      eventTime < startedAt ||
      eventTime > completedAt ||
      eventTime < previousEventTime
    ) {
      refuse(
        "provider-result-refused",
        "provider event is not exact-bound to its result",
      );
    }
    previousEventTime = eventTime;
    if (event.event.type === "session.started") {
      if (sessionStarted || index !== 0) {
        refuse(
          "provider-result-refused",
          "provider session start is duplicated or not first",
        );
      }
      sessionStarted = true;
    } else if (!sessionStarted) {
      refuse(
        "provider-result-refused",
        "provider event arrived before session start",
      );
    }
    if (event.event.type === "model.output") {
      modelOutputBytes += event.event.byte_count;
    }
    if (event.event.type === "usage.updated") {
      latestUsage = event.event.usage;
    }
    if (event.event.type === "tool.requested") {
      if (requestedTools.has(event.event.tool_request_id)) {
        refuse(
          "provider-result-refused",
          "provider tool request event is duplicated",
        );
      }
      requestedTools.set(event.event.tool_request_id, event.event.tool_name);
    }
    if (event.event.type === "tool.completed") {
      if (
        requestedTools.get(event.event.tool_request_id) !==
          event.event.tool_name ||
        completedTools.has(event.event.tool_request_id)
      ) {
        refuse(
          "provider-result-refused",
          "provider tool completion lacks its exact request",
        );
      }
      completedTools.add(event.event.tool_request_id);
    }
    if (event.event.type === "session.completed") {
      if (terminalStatus !== undefined || index !== result.events.length - 1) {
        refuse(
          "provider-result-refused",
          "provider terminal event is duplicated or not final",
        );
      }
      terminalStatus = event.event.status;
    }
  }
  if (
    terminalStatus !== undefined &&
    terminalStatus !== result.model_result.status
  ) {
    refuse(
      "provider-result-refused",
      "provider terminal event contradicts result status",
    );
  }
  if (
    latestUsage !== undefined &&
    !sameUsage(latestUsage, result.model_result.usage)
  ) {
    refuse(
      "provider-result-refused",
      "provider usage event contradicts result usage",
    );
  }
  if (
    modelOutputBytes > 0 &&
    modelOutputBytes !== result.model_result.output_bytes
  ) {
    refuse(
      "provider-result-refused",
      "provider output events contradict result byte accounting",
    );
  }
  if (
    [...requestedTools.keys()].some(
      (requestId) => !completedTools.has(requestId),
    )
  ) {
    refuse(
      "provider-result-refused",
      "provider result contains an incomplete tool event pair",
    );
  }
  if (
    result.model_result.status === "success" &&
    (!sessionStarted || terminalStatus !== "success")
  ) {
    refuse(
      "provider-result-refused",
      "successful provider result lacks a complete event stream",
    );
  }
  const { result_digest: resultDigest, ...unsigned } = result;
  if (sha256Digest(unsigned) !== resultDigest) {
    refuse(
      "provider-result-refused",
      "provider result content does not match its digest",
    );
  }
  return result;
}

export class TrustedProviderHarness {
  readonly #credential: string;
  readonly #sessionProtectionKey: Buffer;
  readonly #clock: Clock;
  readonly #fenceValidator: IdentityOwnershipFenceValidator;
  readonly #transport: TrustedProviderTransport;
  readonly #toolGateway: RepositoryToolGateway;
  readonly #maximums: ProviderHarnessMaximums;
  readonly #scheduler: ProviderHarnessScheduler;
  readonly #fenceCheckIntervalMs: number;
  readonly #protectedHostValues: readonly string[];

  constructor(options: TrustedProviderHarnessOptions) {
    requireProductionProviderBackend(options.backend);
    if (
      options.providerCredential.length < 16 ||
      options.providerCredential.includes("\0") ||
      /[\r\n]/u.test(options.providerCredential)
    ) {
      refuse("identity-mismatch", "provider credential is invalid");
    }
    const sessionProtectionKey = Buffer.from(options.sessionProtectionKey);
    if (sessionProtectionKey.byteLength < 32) {
      refuse(
        "session-refused",
        "session protection key must contain at least 32 bytes",
      );
    }
    for (const value of Object.values(options.maximums)) {
      if (!Number.isFinite(value) || value < 0) {
        refuse("limit-refused", "production maximums are invalid");
      }
    }
    const fenceCheckIntervalMs = options.fenceCheckIntervalMs ?? 1_000;
    if (
      !Number.isSafeInteger(fenceCheckIntervalMs) ||
      fenceCheckIntervalMs <= 0
    ) {
      refuse("limit-refused", "fence watchdog interval is invalid");
    }
    this.#credential = options.providerCredential;
    this.#sessionProtectionKey = Buffer.from(sessionProtectionKey);
    this.#clock = options.clock;
    this.#fenceValidator = options.fenceValidator;
    this.#transport = options.transport;
    this.#toolGateway = options.toolGateway;
    this.#maximums = options.maximums;
    this.#scheduler = options.scheduler ?? DEFAULT_HARNESS_SCHEDULER;
    this.#fenceCheckIntervalMs = fenceCheckIntervalMs;
    this.#protectedHostValues = Object.freeze([
      ...(options.protectedHostValues ?? []),
      ...(typeof options.sessionProtectionKey === "string"
        ? [options.sessionProtectionKey]
        : []),
    ]);
  }

  /** Rehydrate authenticated metadata read from protected controller storage. */
  restoreProtectedResume(raw: unknown): ProtectedResumeCapability {
    const parsed = protectedImplementerSessionSchema.safeParse(raw);
    if (!parsed.success || !this.#validSessionMac(parsed.data)) {
      refuse(
        "session-refused",
        "stored resume metadata is malformed or unauthenticated",
      );
    }
    return protectedResumeCapability(parsed.data);
  }

  /**
   * Resolve only a recovery-policy authorization into public invocation
   * bindings. The protected resolver reference and lease material never leave
   * this method and are deliberately absent from the returned descriptor.
   */
  async describeAuthorizedImplementerResume(
    authorization: AuthorizedImplementerResume,
    vault: ProtectedImplementerSessionVault,
  ): Promise<TrustedImplementerResumeDescriptor> {
    const { metadata } = await this.#resolveAuthorizedImplementerResume(
      authorization,
      vault,
    );
    const unsigned = {
      schema: ASF_TRUSTED_IMPLEMENTER_RESUME_DESCRIPTOR_SCHEMA,
      authorization_digest: sha256Digest(
        authorization.binding as unknown as JsonValue,
      ),
      session_identity_digest: authorization.binding.sessionIdentityDigest,
      invocation_id: metadata.invocation_id,
      provider_candidate_sha: metadata.candidate_sha,
      task_packet_digest: metadata.task_packet_digest,
    } as const;
    return Object.freeze({
      ...unsigned,
      descriptor_digest: sha256Digest(unsigned),
    });
  }

  /**
   * Execute a resumed provider invocation without exposing the protected
   * capability to the delivery runner or implementation controller.
   */
  async executeAuthorizedImplementerResume(
    rawRequest: unknown,
    lease: IdentityLease,
    repository: ProviderRepositoryAuthority,
    authorization: AuthorizedImplementerResume,
    vault: ProtectedImplementerSessionVault,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TrustedProviderExecution> {
    const request = parseAsfProviderRequest(rawRequest);
    const { capability: _capability, metadata } =
      await this.#resolveAuthorizedImplementerResume(authorization, vault);
    const binding = authorization.binding;
    if (
      request.session.mode !== "resume" ||
      request.session.metadata_digest !== binding.sessionIdentityDigest ||
      request.model_request.binding.run_id !== binding.runId ||
      request.model_request.binding.work_order_id !== binding.workOrderId ||
      request.model_request.binding.attempt_id !== binding.attemptId ||
      request.model_request.binding.policy_digest !== binding.policyDigest ||
      request.model_request.binding.fencing_generation !==
        binding.authorizationFencingGeneration ||
      request.model_request.binding.role !== "implementer" ||
      request.model_request.binding.invocation_id !== metadata.invocation_id ||
      request.model_request.binding.candidate_sha !== metadata.candidate_sha ||
      request.model_request.task_packet_digest !== metadata.task_packet_digest
    ) {
      refuse(
        "session-refused",
        "authorized resume does not exactly bind the provider request and checkpoint",
      );
    }
    return this.execute(
      request,
      lease,
      repository,
      signal,
      protectedResumeCapability(metadata, binding),
    );
  }

  async #resolveAuthorizedImplementerResume(
    authorization: AuthorizedImplementerResume,
    vault: ProtectedImplementerSessionVault,
  ): Promise<{
    readonly capability: ProtectedResumeCapability;
    readonly metadata: ProtectedImplementerSession;
  }> {
    if (!(authorization instanceof AuthorizedImplementerResume)) {
      refuse(
        "session-refused",
        "protected resume state requires an AuthorizedImplementerResume",
      );
    }
    const binding = authorization.binding;
    let protectedResumeRef: string;
    try {
      protectedResumeRef = authorization.protectedResumeRefForTrustedHarness();
    } catch {
      return refuse(
        "session-refused",
        "protected resume authorization could not be read",
      );
    }
    const raw = await vault.load({
      protectedResumeRef,
      sessionIdentityDigest: binding.sessionIdentityDigest,
      authorizationBinding: binding,
    });
    const capability = this.restoreProtectedResume(raw);
    const metadata = capability.useMetadata((value) => value);
    if (
      metadata.protected_session_ref !== protectedResumeRef ||
      sha256Digest(metadata) !== binding.sessionIdentityDigest ||
      metadata.run_id !== binding.runId ||
      metadata.work_order_id !== binding.workOrderId ||
      metadata.attempt_id !== binding.attemptId ||
      metadata.policy_digest !== binding.policyDigest ||
      metadata.fencing_generation !== binding.fencingGeneration
    ) {
      refuse(
        "session-refused",
        "sealed provider session does not exactly bind the recovery authorization",
      );
    }
    return { capability, metadata };
  }

  async execute(
    rawRequest: unknown,
    lease: IdentityLease,
    repository: ProviderRepositoryAuthority,
    signal: AbortSignal = new AbortController().signal,
    protectedResume: ProtectedResumeCapability | null = null,
  ): Promise<TrustedProviderExecution> {
    const request = parseAsfProviderRequest(rawRequest);
    this.#assertLease(request, lease);
    this.#assertLimits(request.model_request);
    this.#assertToolPolicy(request.model_request, repository);
    const resume = this.#assertSession(request, lease, protectedResume);
    if (!(await this.#isCurrent(lease))) {
      refuse(
        "stale-generation",
        "identity lease does not own the current durable fence",
      );
    }

    const startedAt = this.#clock.now().toISOString();
    const deadline =
      this.#clock.monotonicMs() + request.model_request.limits.timeout_ms;
    const completedTools = new Map<string, CompletedTool>();
    const seenToolRequestIds = new Set<string>();
    const pendingToolCalls = new Set<Promise<AsfToolResult>>();
    let toolCallCount = 0;
    let toolInFlight = false;
    let transportActive = true;
    let transportReturnedWithPendingTool = false;

    if (signal.aborted) {
      return {
        result: this.#cancelledResult(request, startedAt),
        protectedResume: null,
      };
    }

    const executionController = new AbortController();
    type StopOutcome = {
      readonly kind: "cancelled" | "timeout" | "stale-generation";
    };
    let resolveStop: (outcome: StopOutcome) => void = () => undefined;
    const stopPromise = new Promise<StopOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const forwardCancellation = (): void => {
      resolveStop({ kind: "cancelled" });
      executionController.abort(signal.reason);
    };
    signal.addEventListener("abort", forwardCancellation, { once: true });
    if (signal.aborted) forwardCancellation();
    const deadlineTask = this.#scheduler.schedule(
      request.model_request.limits.timeout_ms,
      () => {
        resolveStop({ kind: "timeout" });
        executionController.abort("provider invocation deadline reached");
      },
    );
    const fenceWatchdog: { task: ProviderHarnessScheduledTask | null } = {
      task: null,
    };
    const scheduleFenceCheck = (): void => {
      fenceWatchdog.task = this.#scheduler.schedule(
        Math.min(
          this.#fenceCheckIntervalMs,
          request.model_request.limits.timeout_ms,
        ),
        () => {
          void (async () => {
            if (!transportActive || executionController.signal.aborted) return;
            const current = await this.#isCurrent(lease);
            if (!transportActive || executionController.signal.aborted) return;
            if (!current) {
              resolveStop({ kind: "stale-generation" });
              executionController.abort("identity ownership fence was lost");
              return;
            }
            scheduleFenceCheck();
          })();
        },
      );
    };
    scheduleFenceCheck();

    let rawResult: unknown;
    let forcedStop = false;
    let forcedStopKind: StopOutcome["kind"] | null = null;
    const providerAuthority = trustedProviderAuthority(
      this.#credential,
      lease.executionHandle,
    );
    try {
      const transportPromise = this.#transport.execute({
        authority: providerAuthority.authority,
        resume,
        request,
        signal: executionController.signal,
        deadlineMonotonicMs: deadline,
        invokeTool: (rawToolRequest) => {
          const operation = (async (): Promise<AsfToolResult> => {
            if (!transportActive) {
              refuse(
                "provider-result-refused",
                "provider invoked a tool after its session ended",
              );
            }
            if (toolInFlight) {
              refuse(
                "provider-result-refused",
                "concurrent repository-tool calls are not permitted",
              );
            }
            this.#assertLease(request, lease);
            toolCallCount += 1;
            if (toolCallCount > request.model_request.limits.max_tool_calls) {
              refuse(
                "limit-refused",
                "provider exceeded the admitted tool-call budget",
              );
            }
            const parsedToolRequest = parseAsfToolRequest(rawToolRequest);
            if (seenToolRequestIds.has(parsedToolRequest.request_id)) {
              refuse(
                "provider-result-refused",
                "provider reused a repository-tool request id",
              );
            }
            seenToolRequestIds.add(parsedToolRequest.request_id);
            toolInFlight = true;
            try {
              const result = await this.#toolGateway.execute(
                parsedToolRequest,
                {
                  ...request.model_request.binding,
                  workspaceRoot: repository.workspaceRoot,
                  pathScope: repository.pathScope,
                  allowedTools: request.model_request.allowed_tools,
                  allowedCheckIds: request.model_request.allowed_check_ids,
                  resourceLimits: repository.toolResourceLimits,
                  freshCandidate: repository.freshCandidate,
                },
                executionController.signal,
                [
                  this.#credential,
                  String(lease.executionHandle),
                  String(lease.leaseId),
                  ...this.#protectedHostValues,
                ],
              );
              completedTools.set(result.request_id, {
                request: parsedToolRequest,
                argumentsDigest: sha256Digest(parsedToolRequest.tool.arguments),
                result,
              });
              this.#assertLease(request, lease);
              return result;
            } finally {
              toolInFlight = false;
            }
          })();
          pendingToolCalls.add(operation);
          void operation.then(
            () => pendingToolCalls.delete(operation),
            () => pendingToolCalls.delete(operation),
          );
          return operation;
        },
      });
      const outcome = await Promise.race([
        transportPromise.then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        stopPromise,
      ]);
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "result") {
        rawResult = outcome.value;
      } else {
        forcedStop = true;
        forcedStopKind = outcome.kind;
        rawResult = null;
      }
    } catch (error) {
      if (error instanceof ProviderHarnessRefusalError) throw error;
      rawResult = {
        status: signal.aborted ? "cancelled" : "failure",
        output_digest: null,
        output_bytes: 0,
        turns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          tool_calls: toolCallCount,
        },
        events: [],
        protected_session_ref: null,
        failure: signal.aborted
          ? null
          : { class: "provider-internal", retryable: true },
      };
    } finally {
      transportActive = false;
      providerAuthority.revoke();
      if (pendingToolCalls.size > 0) {
        transportReturnedWithPendingTool = !forcedStop;
        executionController.abort(
          "provider session ended with a pending repository tool",
        );
        await Promise.allSettled([...pendingToolCalls]);
      }
      deadlineTask.cancel();
      fenceWatchdog.task?.cancel();
      signal.removeEventListener("abort", forwardCancellation);
    }

    if (transportReturnedWithPendingTool) {
      refuse(
        "provider-result-refused",
        "provider session ended before a repository tool completed",
      );
    }
    if (forcedStopKind === "stale-generation") {
      refuse(
        "stale-generation",
        "identity lease lost the durable fence during execution",
      );
    }

    if (forcedStopKind === "cancelled" || forcedStopKind === "timeout") {
      rawResult = this.#forcedTransportResult(
        forcedStopKind,
        completedTools,
        toolCallCount,
        startedAt,
      );
    }

    this.#assertLease(request, lease);
    if (!(await this.#isCurrent(lease))) {
      refuse(
        "stale-generation",
        "identity lease lost the durable fence during execution",
      );
    }

    const parsedTransport =
      trustedProviderTransportResultSchema.safeParse(rawResult);
    if (!parsedTransport.success) {
      refuse(
        "malformed-provider-result",
        "host transport returned an invalid normalized result",
      );
    }
    const transport = parsedTransport.data;
    this.#assertNoProtectedTransportValues(transport, lease);
    this.#assertTransportResult(
      request,
      transport,
      completedTools,
      toolCallCount,
      Date.parse(startedAt),
      forcedStop,
    );

    const timedOut = this.#clock.monotonicMs() > deadline;
    const status = signal.aborted
      ? "cancelled"
      : timedOut
        ? "timeout"
        : transport.status;
    const events = transport.events.map((event) => ({
      schema: ASF_PROVIDER_EVENT_SCHEMA,
      request_id: request.model_request.request_id,
      binding: request.model_request.binding,
      ...event,
      event:
        event.event.type === "session.completed" &&
        event.event.status !== status
          ? { ...event.event, status }
          : event.event,
    }));
    const completedAt = this.#clock.now().toISOString();
    const resumeMetadata =
      lease.role === "implementer" &&
      transport.protected_session_ref !== null &&
      status !== "cancelled" &&
      status !== "timeout"
        ? this.#resumeMetadata(
            request,
            lease,
            transport.protected_session_ref,
            completedAt,
          )
        : null;
    const failure =
      status === "failure"
        ? (transport.failure ?? {
            class: "provider-internal" as const,
            retryable: true,
          })
        : null;
    const modelResult: AsfModelResult = {
      schema: ASF_MODEL_RESULT_SCHEMA,
      request_id: request.model_request.request_id,
      binding: request.model_request.binding,
      provider: request.model_request.provider,
      model: request.model_request.model,
      principal: request.model_request.principal,
      profile: request.model_request.profile,
      task_packet_digest: request.model_request.task_packet_digest,
      instruction_digest: request.model_request.instruction_digest,
      context_set_digest: sha256Digest(request.model_request.context_digests),
      status,
      output_digest: status === "success" ? transport.output_digest : null,
      output_bytes: transport.output_bytes,
      turns: transport.turns,
      usage: transport.usage,
    };
    const unsigned = {
      schema: ASF_PROVIDER_RESULT_SCHEMA,
      started_at: startedAt,
      completed_at: completedAt,
      model_result: modelResult,
      events,
      resume_metadata_digest:
        resumeMetadata === null ? null : sha256Digest(resumeMetadata),
      failure,
    } satisfies Omit<AsfProviderResult, "result_digest">;

    return {
      result: parseAsfProviderResult({
        ...unsigned,
        result_digest: sha256Digest(unsigned),
      }),
      protectedResume:
        resumeMetadata === null
          ? null
          : protectedResumeCapability(resumeMetadata),
    };
  }

  #assertLease(request: AsfProviderRequest, lease: IdentityLease): void {
    const model = request.model_request;
    if (
      !equalBinding(model.binding, lease) ||
      model.provider !== lease.provider ||
      model.principal !== lease.principal ||
      model.profile !== lease.profile ||
      !POLICY_DIGEST_PATTERN.test(lease.policyDigest) ||
      typeof lease.leaseId !== "string" ||
      lease.leaseId === "" ||
      typeof lease.executionHandle !== "string" ||
      lease.executionHandle === ""
    ) {
      refuse(
        "identity-mismatch",
        "request is not exact-bound to its identity lease",
      );
    }
    const issuedAt = Date.parse(lease.issuedAt);
    const expiresAt = Date.parse(lease.expiresAt);
    const now = this.#clock.now().getTime();
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now ||
      expiresAt <= now ||
      issuedAt >= expiresAt
    ) {
      refuse(
        "lease-inactive",
        "identity lease is not active at the injected clock",
      );
    }
    if (request.model_request.limits.timeout_ms > expiresAt - now) {
      refuse(
        "lease-inactive",
        "provider timeout extends beyond the current identity lease",
      );
    }
  }

  #assertLimits(request: AsfModelRequest): void {
    const limits = request.limits;
    if (
      limits.timeout_ms > this.#maximums.timeoutMs ||
      limits.max_turns > this.#maximums.turns ||
      limits.max_input_tokens > this.#maximums.inputTokens ||
      limits.max_output_tokens > this.#maximums.outputTokens ||
      limits.max_output_bytes > this.#maximums.outputBytes ||
      limits.max_cost_usd > this.#maximums.costUsd ||
      limits.max_events > this.#maximums.events ||
      limits.max_tool_calls > this.#maximums.toolCalls
    ) {
      refuse("limit-refused", "request exceeds operator-owned provider limits");
    }
    if (limits.max_events < limits.max_tool_calls * 2 + 3) {
      refuse(
        "limit-refused",
        "event budget cannot record the admitted repository-tool budget",
      );
    }
  }

  #assertToolPolicy(
    request: AsfModelRequest,
    repository: ProviderRepositoryAuthority,
  ): void {
    if (
      request.binding.invocation_id !== repository.invocationId ||
      request.binding.candidate_sha !== repository.candidateSha ||
      request.task_packet_digest !== repository.taskPacketDigest ||
      request.instruction_digest !== repository.instructionDigest ||
      request.model !== repository.model ||
      !isSubset(request.context_digests, repository.contextDigests) ||
      !isSubset(request.allowed_tools, repository.allowedTools) ||
      !isSubset(request.allowed_check_ids, repository.allowedCheckIds)
    ) {
      refuse(
        "tool-policy-refused",
        "request widens admitted repository-tool authority",
      );
    }
    if (
      (request.binding.role === "local-reviewer" ||
        request.binding.role === "pr-reviewer" ||
        request.binding.role === "retrospective") &&
      request.allowed_tools.includes("repository.apply_patch")
    ) {
      refuse("role-refused", "review and retrospective roles are read-only");
    }
  }

  #assertSession(
    request: AsfProviderRequest,
    lease: IdentityLease,
    protectedResume: ProtectedResumeCapability | null,
  ): ProtectedResumeCapability | null {
    if (request.session.mode === "fresh") {
      if (protectedResume !== null) {
        refuse(
          "session-refused",
          "fresh provider session received stale resume authority",
        );
      }
      return null;
    }
    try {
      assertResumable(lease.role);
    } catch {
      refuse(
        "session-refused",
        "only the implementer may resume a protected session",
      );
    }
    if (protectedResume === null) {
      refuse(
        "session-refused",
        "resume request is missing protected session authority",
      );
    }
    let rawMetadata: unknown;
    try {
      rawMetadata = protectedResume.useMetadata((metadata) => metadata);
    } catch {
      refuse(
        "session-refused",
        "protected session authority could not be read",
      );
    }
    const parsed = protectedImplementerSessionSchema.safeParse(rawMetadata);
    if (!parsed.success || !this.#validSessionMac(parsed.data)) {
      refuse(
        "session-refused",
        "protected session authority is malformed or unauthenticated",
      );
    }
    const metadata = parsed.data;
    const model = request.model_request;
    const authorizedBinding =
      protectedResume[authorizedResumeBindingBrand] ?? null;
    const sessionGeneration =
      authorizedBinding?.fencingGeneration ?? model.binding.fencing_generation;
    const authorizationGeneration =
      authorizedBinding?.authorizationFencingGeneration ??
      model.binding.fencing_generation;
    const generationRebound = sessionGeneration !== authorizationGeneration;
    const authorizationIdentityDigest = identityLeaseAttributionDigest(
      {
        run_id: model.binding.run_id,
        work_order_id: model.binding.work_order_id,
        attempt_id: model.binding.attempt_id,
        policy_digest: model.binding.policy_digest,
        fencing_generation: authorizationGeneration,
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
    if (
      request.session.metadata_digest !== sha256Digest(metadata) ||
      (generationRebound
        ? metadata.lease_digest === sha256Digest(String(lease.leaseId))
        : metadata.lease_digest !== sha256Digest(String(lease.leaseId))) ||
      metadata.run_id !== model.binding.run_id ||
      metadata.work_order_id !== model.binding.work_order_id ||
      metadata.attempt_id !== model.binding.attempt_id ||
      metadata.invocation_id !== model.binding.invocation_id ||
      metadata.policy_digest !== model.binding.policy_digest ||
      metadata.task_packet_digest !== model.task_packet_digest ||
      metadata.instruction_digest !== model.instruction_digest ||
      metadata.context_set_digest !== sha256Digest(model.context_digests) ||
      metadata.candidate_sha !== model.binding.candidate_sha ||
      metadata.fencing_generation !== sessionGeneration ||
      model.binding.fencing_generation !== authorizationGeneration ||
      (authorizedBinding !== null &&
        authorizationIdentityDigest !==
          authorizedBinding.authorizationIdentityLeaseBindingDigest) ||
      metadata.provider !== model.provider ||
      metadata.model !== model.model ||
      metadata.principal !== model.principal ||
      metadata.profile !== model.profile ||
      Date.parse(metadata.issued_at) > this.#clock.now().getTime()
    ) {
      refuse(
        "session-refused",
        "protected session metadata is not exact-bound to the invocation",
      );
    }
    return protectedResume;
  }

  #assertTransportResult(
    request: AsfProviderRequest,
    result: TrustedProviderTransportResult,
    completedTools: ReadonlyMap<string, CompletedTool>,
    observedToolCalls: number,
    invocationStartedAt: number,
    forcedStop: boolean,
  ): void {
    const limits = request.model_request.limits;
    if (
      result.events.length > limits.max_events ||
      result.turns > limits.max_turns ||
      result.usage.input_tokens > limits.max_input_tokens ||
      result.usage.output_tokens > limits.max_output_tokens ||
      result.output_bytes > limits.max_output_bytes ||
      result.usage.cost_usd > limits.max_cost_usd ||
      result.usage.tool_calls > limits.max_tool_calls ||
      result.usage.tool_calls !== observedToolCalls
    ) {
      refuse(
        "provider-result-refused",
        "provider result exceeds or contradicts admitted usage",
      );
    }
    if (result.status === "success" && result.output_digest === null) {
      refuse(
        "provider-result-refused",
        "successful provider result is missing its output digest",
      );
    }
    if (
      result.status === "failure"
        ? result.failure === null
        : result.failure !== null
    ) {
      refuse(
        "provider-result-refused",
        "provider failure evidence contradicts its status",
      );
    }
    if (
      request.model_request.binding.role !== "implementer" &&
      result.protected_session_ref !== null
    ) {
      refuse(
        "session-refused",
        "non-implementer transport returned resumable session state",
      );
    }

    let previousTime = -Infinity;
    let previousUsage: ProviderUsage | undefined;
    let latestUsage: ProviderUsage | undefined;
    const requestedTools = new Set<string>();
    const completedToolEvents = new Set<string>();
    let terminalStatus: TrustedProviderTransportResult["status"] | undefined;
    let sessionStarted = false;
    let modelOutputBytes = 0;
    const invocationCompletedAt = this.#clock.now().getTime();
    for (let index = 0; index < result.events.length; index += 1) {
      const event = result.events[index];
      if (event === undefined || event.sequence !== index + 1) {
        refuse(
          "malformed-provider-result",
          "provider event sequence is not contiguous",
        );
      }
      const observedAt = Date.parse(event.observed_at);
      if (
        !Number.isFinite(observedAt) ||
        observedAt < previousTime ||
        observedAt < invocationStartedAt ||
        observedAt > invocationCompletedAt
      ) {
        refuse(
          "malformed-provider-result",
          "provider event timestamps are not monotonic",
        );
      }
      previousTime = observedAt;
      if (event.event.type === "session.started") {
        if (sessionStarted || index !== 0) {
          refuse(
            "malformed-provider-result",
            "provider session-start event is duplicated or not first",
          );
        }
        sessionStarted = true;
      } else if (!sessionStarted) {
        refuse(
          "malformed-provider-result",
          "provider event arrived before session start",
        );
      }
      if (
        event.event.type === "model.output" &&
        event.event.byte_count > limits.max_output_bytes
      ) {
        refuse(
          "provider-result-refused",
          "model output exceeds its admitted byte bound",
        );
      }
      if (event.event.type === "model.output")
        modelOutputBytes += event.event.byte_count;
      if (modelOutputBytes > limits.max_output_bytes) {
        refuse(
          "provider-result-refused",
          "cumulative model output exceeds its admitted byte bound",
        );
      }
      if (event.event.type === "usage.updated") {
        if (
          previousUsage !== undefined &&
          (event.event.usage.input_tokens < previousUsage.input_tokens ||
            event.event.usage.output_tokens < previousUsage.output_tokens ||
            event.event.usage.cost_usd < previousUsage.cost_usd ||
            event.event.usage.tool_calls < previousUsage.tool_calls)
        ) {
          refuse(
            "provider-result-refused",
            "cumulative provider usage moved backwards",
          );
        }
        previousUsage = event.event.usage;
        latestUsage = event.event.usage;
      }
      if (event.event.type === "tool.requested") {
        const completed = completedTools.get(event.event.tool_request_id);
        if (
          completed === undefined ||
          completed.request.tool.name !== event.event.tool_name ||
          completed.result.request_digest !== event.event.request_digest ||
          completed.argumentsDigest !== event.event.arguments_digest ||
          requestedTools.has(event.event.tool_request_id)
        ) {
          refuse(
            "provider-result-refused",
            "tool request event is not exact-bound to a gateway call",
          );
        }
        requestedTools.add(event.event.tool_request_id);
      }
      if (event.event.type === "tool.completed") {
        const completed = completedTools.get(event.event.tool_request_id);
        if (
          completed === undefined ||
          !requestedTools.has(event.event.tool_request_id) ||
          completedToolEvents.has(event.event.tool_request_id) ||
          completed.result.schema !== ASF_TOOL_RESULT_SCHEMA ||
          completed.result.tool_name !== event.event.tool_name ||
          completed.result.status !== event.event.status ||
          completed.result.result_digest !== event.event.result_digest
        ) {
          refuse(
            "provider-result-refused",
            "tool event is not bound to an executed gateway result",
          );
        }
        completedToolEvents.add(event.event.tool_request_id);
      }
      if (event.event.type === "session.completed") {
        if (
          terminalStatus !== undefined ||
          index !== result.events.length - 1
        ) {
          refuse(
            "malformed-provider-result",
            "provider terminal event is duplicated or not final",
          );
        }
        terminalStatus = event.event.status;
      }
    }
    if (latestUsage !== undefined && !sameUsage(latestUsage, result.usage)) {
      refuse(
        "provider-result-refused",
        "final cumulative usage contradicts the provider result",
      );
    }
    if (modelOutputBytes > 0 && modelOutputBytes !== result.output_bytes) {
      refuse(
        "provider-result-refused",
        "model output byte evidence contradicts the provider result",
      );
    }
    if (terminalStatus !== undefined && terminalStatus !== result.status) {
      refuse(
        "provider-result-refused",
        "terminal provider event contradicts result status",
      );
    }
    for (const tool of completedTools.values()) {
      const reported = result.events.some(
        (event) =>
          event.event.type === "tool.completed" &&
          event.event.tool_request_id === tool.result.request_id &&
          event.event.result_digest === tool.result.result_digest,
      );
      if (!reported && !forcedStop) {
        refuse(
          "provider-result-refused",
          "executed tool is missing its completion event",
        );
      }
    }
  }

  #assertNoProtectedTransportValues(
    result: TrustedProviderTransportResult,
    lease: IdentityLease,
  ): void {
    const protectedValues = [
      this.#credential,
      String(lease.executionHandle),
      String(lease.leaseId),
      ...this.#protectedHostValues,
    ].filter((value) => value !== "");
    const visit = (value: unknown): boolean => {
      if (typeof value === "string") {
        return protectedValues.some((protectedValue) =>
          value.includes(protectedValue),
        );
      }
      if (Array.isArray(value)) return value.some(visit);
      if (value !== null && typeof value === "object") {
        return Object.values(value).some(visit);
      }
      return false;
    };
    if (visit(result)) {
      refuse(
        "malformed-provider-result",
        "provider result contains protected host data",
      );
    }
  }

  #forcedTransportResult(
    status: "cancelled" | "timeout",
    completedTools: ReadonlyMap<string, CompletedTool>,
    toolCallCount: number,
    startedAt: string,
  ): TrustedProviderTransportResult {
    const events: TransportEvent[] = [
      {
        sequence: 1,
        observed_at: startedAt,
        event: { type: "session.started" },
      },
    ];
    for (const completed of completedTools.values()) {
      events.push({
        sequence: events.length + 1,
        observed_at: completed.result.started_at,
        event: {
          type: "tool.requested",
          tool_request_id: completed.result.request_id,
          tool_name: completed.result.tool_name,
          request_digest: completed.result.request_digest,
          arguments_digest: completed.argumentsDigest,
        },
      });
      events.push({
        sequence: events.length + 1,
        observed_at: completed.result.completed_at,
        event: {
          type: "tool.completed",
          tool_request_id: completed.result.request_id,
          tool_name: completed.result.tool_name,
          status: completed.result.status,
          result_digest: completed.result.result_digest,
        },
      });
    }
    const completedAt = this.#clock.now().toISOString();
    const usage: ProviderUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      tool_calls: toolCallCount,
    };
    events.push({
      sequence: events.length + 1,
      observed_at: completedAt,
      event: { type: "usage.updated", cumulative: true, usage },
    });
    events.push({
      sequence: events.length + 1,
      observed_at: completedAt,
      event: { type: "session.completed", status },
    });
    return {
      status,
      output_digest: null,
      output_bytes: 0,
      turns: 0,
      usage,
      events,
      protected_session_ref: null,
      failure: null,
    };
  }

  #resumeMetadata(
    request: AsfProviderRequest,
    lease: IdentityLease,
    protectedSessionRef: string,
    issuedAt: string,
  ): ProtectedImplementerSession {
    const model = request.model_request;
    const unsigned: Omit<ProtectedImplementerSession, "binding_mac"> = {
      schema: ASF_PROTECTED_SESSION_SCHEMA,
      protected_session_ref: protectedSessionRef,
      lease_digest: sha256Digest(String(lease.leaseId)),
      run_id: model.binding.run_id,
      work_order_id: model.binding.work_order_id,
      attempt_id: model.binding.attempt_id,
      invocation_id: model.binding.invocation_id,
      policy_digest: model.binding.policy_digest,
      task_packet_digest: model.task_packet_digest,
      instruction_digest: model.instruction_digest,
      context_set_digest: sha256Digest(model.context_digests),
      candidate_sha: model.binding.candidate_sha,
      fencing_generation: model.binding.fencing_generation,
      provider: model.provider,
      model: model.model,
      principal: model.principal,
      profile: model.profile,
      issued_at: issuedAt,
    };
    return { ...unsigned, binding_mac: this.#sessionMac(unsigned) };
  }

  #sessionMac(
    metadata: Omit<ProtectedImplementerSession, "binding_mac">,
  ): string {
    return `hmac-sha256:${createHmac("sha256", this.#sessionProtectionKey)
      .update(canonicalJson(metadata))
      .digest("hex")}`;
  }

  #validSessionMac(metadata: ProtectedImplementerSession): boolean {
    const { binding_mac: bindingMac, ...unsigned } = metadata;
    const expected = this.#sessionMac(unsigned);
    const actualBytes = Buffer.from(bindingMac, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actualBytes, expectedBytes)
    );
  }

  #cancelledResult(
    request: AsfProviderRequest,
    startedAt: string,
  ): AsfProviderResult {
    const completedAt = this.#clock.now().toISOString();
    const modelResult: AsfModelResult = {
      schema: ASF_MODEL_RESULT_SCHEMA,
      request_id: request.model_request.request_id,
      binding: request.model_request.binding,
      provider: request.model_request.provider,
      model: request.model_request.model,
      principal: request.model_request.principal,
      profile: request.model_request.profile,
      task_packet_digest: request.model_request.task_packet_digest,
      instruction_digest: request.model_request.instruction_digest,
      context_set_digest: sha256Digest(request.model_request.context_digests),
      status: "cancelled",
      output_digest: null,
      output_bytes: 0,
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, tool_calls: 0 },
    };
    const unsigned = {
      schema: ASF_PROVIDER_RESULT_SCHEMA,
      started_at: startedAt,
      completed_at: completedAt,
      model_result: modelResult,
      events: [],
      resume_metadata_digest: null,
      failure: null,
    } satisfies Omit<AsfProviderResult, "result_digest">;
    return parseAsfProviderResult({
      ...unsigned,
      result_digest: sha256Digest(unsigned),
    });
  }

  async #isCurrent(lease: IdentityLease): Promise<boolean> {
    try {
      return (
        (await this.#fenceValidator.isCurrent(
          identityOwnershipFenceFor(lease),
        )) === true
      );
    } catch {
      return false;
    }
  }
}
