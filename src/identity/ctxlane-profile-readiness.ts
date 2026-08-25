import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import {
  CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION,
  CTXLANE_MCP_HEALTH_PROBE_TRANSPORT,
  DEFAULT_CTXLANE_MCP_HEALTH_TIMEOUT_MS,
  MAX_CTXLANE_MCP_HEALTH_RESPONSE_BYTES,
  MAX_CTXLANE_MCP_HEALTH_TIMEOUT_MS,
  CtxlaneServiceHealthProbeError,
  runCtxlaneMcpStdio,
} from "./ctxlane-service-health.js";
import {
  ctxlaneAutomationReadinessSchema,
  type CtxlaneAutomationReadiness,
  type CtxlaneRole,
} from "./ctxlane-contracts.js";
import { strictJsonDecode } from "./ctxlane-transport.js";

export const CTXLANE_MCP_PROFILE_READINESS_METHOD = "ctxlane_check_profile" as const;
export const CTXLANE_MCP_PROFILE_READINESS_PROBE_QUALIFICATION =
  CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION;
export const DEFAULT_CTXLANE_MCP_PROFILE_READINESS_TIMEOUT_MS =
  DEFAULT_CTXLANE_MCP_HEALTH_TIMEOUT_MS;

const LOG_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$(?![\s\S])/u;
const PROFILE_UID_PATTERN = /^profile_[0-7][0-9A-HJKMNP-TV-Z]{25}$(?![\s\S])/u;
const PROFILE_REF_PATTERN =
  /^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$(?![\s\S])/u;
const profileReadinessRequestSchema = z
  .object({
    client_request_id: z.string().min(1).max(128).regex(LOG_SAFE_ID_PATTERN),
    profile_ref: z.string().regex(PROFILE_REF_PATTERN),
    profile_uid: z.string().regex(PROFILE_UID_PATTERN),
    environment: z.string().min(1).max(128).regex(ENVIRONMENT_PATTERN),
    role: z.enum(["implementer", "local-reviewer", "pr-reviewer"]),
    probe_timeout_milliseconds: z.number().int().min(1).max(30_000),
  })
  .strict();

const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.literal(1),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const hasResult = response.result !== undefined;
    const hasError = response.error !== undefined;
    if (hasResult === hasError) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "must contain exactly one result or error",
      });
    }
  });

type ProfileReadinessFailureReason =
  | "invalid-options"
  | "executable-unavailable"
  | "root-unavailable"
  | "timed-out"
  | "command-failed"
  | "cancelled"
  | "malformed-response"
  | "service-refused"
  | "invalid-readiness";

export class CtxlaneProfileReadinessProbeError extends Error {
  readonly reason: ProfileReadinessFailureReason;

  constructor(reason: ProfileReadinessFailureReason, message: string) {
    super(`ctxlane profile-readiness probe refused: ${message}`);
    this.name = "CtxlaneProfileReadinessProbeError";
    this.reason = reason;
  }
}

export interface CtxlaneProfileReadinessProbeOptions {
  readonly executable: string;
  readonly root: string;
  readonly clientRequestId: string;
  readonly profileUid: string;
  readonly profileRef: string;
  readonly environment: string;
  readonly role: CtxlaneRole;
  readonly timeoutMs?: number | undefined;
}

export interface CtxlaneProfileReadinessObservationEnvelope {
  readonly transport: typeof CTXLANE_MCP_HEALTH_PROBE_TRANSPORT;
  readonly qualification: typeof CTXLANE_MCP_PROFILE_READINESS_PROBE_QUALIFICATION;
  readonly observed_at: string;
  readonly request: {
    readonly profile_uid: string;
    readonly profile_ref: string;
    readonly environment: string;
    readonly role: CtxlaneRole;
  };
  readonly readiness: CtxlaneAutomationReadiness;
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CTXLANE_MCP_HEALTH_TIMEOUT_MS
  ) {
    throw new CtxlaneProfileReadinessProbeError(
      "invalid-options",
      "timeout is outside the safe range",
    );
  }
}

function responseValue(stdout: string): unknown {
  const text = stdout.trim();
  if (
    text === "" ||
    Buffer.byteLength(text, "utf8") > MAX_CTXLANE_MCP_HEALTH_RESPONSE_BYTES
  ) {
    throw new CtxlaneProfileReadinessProbeError(
      "malformed-response",
      "profile-readiness response is empty or exceeds the control limit",
    );
  }
  try {
    return strictJsonDecode(text);
  } catch {
    throw new CtxlaneProfileReadinessProbeError(
      "malformed-response",
      "profile-readiness response is not one unique JSON document",
    );
  }
}

function parseReadinessResponse(
  stdout: string,
  request: z.infer<typeof profileReadinessRequestSchema>,
): CtxlaneAutomationReadiness {
  const envelope = jsonRpcResponseSchema.safeParse(responseValue(stdout));
  if (!envelope.success) {
    throw new CtxlaneProfileReadinessProbeError(
      "malformed-response",
      "response is not the expected JSON-RPC 2.0 result envelope",
    );
  }
  if (envelope.data.error !== undefined) {
    throw new CtxlaneProfileReadinessProbeError(
      "service-refused",
      "ctxlane refused the authenticated profile-readiness request",
    );
  }
  const readiness = ctxlaneAutomationReadinessSchema.safeParse(envelope.data.result);
  if (!readiness.success) {
    throw new CtxlaneProfileReadinessProbeError(
      "invalid-readiness",
      "ctxlane returned a result outside automation-readiness/v1",
    );
  }
  if (
    readiness.data.profile_uid !== request.profile_uid ||
    readiness.data.profile_ref !== request.profile_ref ||
    readiness.data.environment !== request.environment ||
    readiness.data.role !== request.role
  ) {
    throw new CtxlaneProfileReadinessProbeError(
      "invalid-readiness",
      "ctxlane returned readiness for a different profile or execution scope",
    );
  }
  return readiness.data;
}

/**
 * Read the published ctxlane profile-readiness result over the optional MCP
 * STDIO connector. This is observation-only: it never acquires or promotes a
 * lease, returns a capability, or authorizes provider execution.
 */
export class CtxlaneMcpProfileReadinessProbe {
  readonly qualification = CTXLANE_MCP_PROFILE_READINESS_PROBE_QUALIFICATION;
  readonly transport = CTXLANE_MCP_HEALTH_PROBE_TRANSPORT;
  readonly #options: CtxlaneProfileReadinessProbeOptions;
  readonly #timeoutMs: number;

  constructor(options: CtxlaneProfileReadinessProbeOptions) {
    const parsed = profileReadinessRequestSchema.safeParse({
      client_request_id: options?.clientRequestId,
      profile_ref: options?.profileRef,
      profile_uid: options?.profileUid,
      environment: options?.environment,
      role: options?.role,
      probe_timeout_milliseconds: options?.timeoutMs ?? DEFAULT_CTXLANE_MCP_PROFILE_READINESS_TIMEOUT_MS,
    });
    if (!parsed.success) {
      throw new CtxlaneProfileReadinessProbeError(
        "invalid-options",
        "profile-readiness request fields are invalid",
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CTXLANE_MCP_PROFILE_READINESS_TIMEOUT_MS;
    validateTimeout(timeoutMs);
    this.#options = options;
    this.#timeoutMs = timeoutMs;
  }

  async probe(signal?: AbortSignal): Promise<CtxlaneAutomationReadiness> {
    if (signal?.aborted) {
      throw new CtxlaneProfileReadinessProbeError("cancelled", "probe was cancelled");
    }
    const request = profileReadinessRequestSchema.parse({
      client_request_id: this.#options.clientRequestId,
      profile_ref: this.#options.profileRef,
      profile_uid: this.#options.profileUid,
      environment: this.#options.environment,
      role: this.#options.role,
      probe_timeout_milliseconds: this.#timeoutMs,
    });
    const wireRequest = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: CTXLANE_MCP_PROFILE_READINESS_METHOD,
      params: request,
    })}\n`;
    let result;
    try {
      result = await runCtxlaneMcpStdio(
        this.#options.executable,
        this.#options.root,
        wireRequest,
        this.#timeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof CtxlaneProfileReadinessProbeError) throw error;
      if (error instanceof CtxlaneServiceHealthProbeError) {
        const reason = error.reason === "invalid-health" ? "invalid-readiness" : error.reason;
        throw new CtxlaneProfileReadinessProbeError(reason, error.message);
      }
      throw new CtxlaneProfileReadinessProbeError("command-failed", "ctxlane probe failed");
    }
    if (signal?.aborted) {
      throw new CtxlaneProfileReadinessProbeError("cancelled", "probe was cancelled");
    }
    if (!result.ok) {
      const reason = result.stderr.includes("timed out after") ? "timed-out" : "command-failed";
      throw new CtxlaneProfileReadinessProbeError(reason, "ctxlane profile-readiness command failed");
    }
    return parseReadinessResponse(result.stdout, request);
  }
}

export function toCtxlaneProfileReadinessObservationEnvelope(
  readiness: CtxlaneAutomationReadiness,
  request: Pick<
    CtxlaneProfileReadinessProbeOptions,
    "profileUid" | "profileRef" | "environment" | "role"
  >,
  clock: Clock,
): CtxlaneProfileReadinessObservationEnvelope {
  const parsed = ctxlaneAutomationReadinessSchema.parse(readiness);
  if (
    parsed.profile_uid !== request.profileUid ||
    parsed.profile_ref !== request.profileRef ||
    parsed.environment !== request.environment ||
    parsed.role !== request.role
  ) {
    throw new CtxlaneProfileReadinessProbeError(
      "invalid-readiness",
      "cannot envelope readiness for a different profile or execution scope",
    );
  }
  return {
    transport: CTXLANE_MCP_HEALTH_PROBE_TRANSPORT,
    qualification: CTXLANE_MCP_PROFILE_READINESS_PROBE_QUALIFICATION,
    observed_at: clock.now().toISOString(),
    request: {
      profile_uid: request.profileUid,
      profile_ref: request.profileRef,
      environment: request.environment,
      role: request.role,
    },
    readiness: parsed,
  };
}
