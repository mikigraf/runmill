import { constants, lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import type { CtxlaneHealthObservation } from "../asf/health.js";
import { runWithInput } from "../platform/process.js";
import {
  ctxlaneServiceHealthSchema,
  type CtxlaneServiceHealth,
} from "./ctxlane-contracts.js";
import { strictJsonDecode } from "./ctxlane-transport.js";

export const CTXLANE_MCP_HEALTH_PROBE_TRANSPORT = "ctxlane-mcp-stdio" as const;
export const CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION =
  "authenticated-observation-only" as const;
export const DEFAULT_CTXLANE_MCP_HEALTH_TIMEOUT_MS = 5_000;
export const MAX_CTXLANE_MCP_HEALTH_TIMEOUT_MS = 30_000;
export const MAX_CTXLANE_MCP_HEALTH_RESPONSE_BYTES = 64 * 1024;

const CTXLANE_MCP_HEALTH_REQUEST =
  '{"jsonrpc":"2.0","id":1,"method":"ctxlane_health","params":{}}\n';

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "WINDIR",
] as const;

type ProbeFailureReason =
  | "invalid-options"
  | "executable-unavailable"
  | "root-unavailable"
  | "timed-out"
  | "command-failed"
  | "cancelled"
  | "malformed-response"
  | "service-refused"
  | "invalid-health";

export class CtxlaneServiceHealthProbeError extends Error {
  readonly reason: ProbeFailureReason;

  constructor(reason: ProbeFailureReason, message: string) {
    super(`ctxlane service health probe refused: ${message}`);
    this.name = "CtxlaneServiceHealthProbeError";
    this.reason = reason;
  }
}

export interface CtxlaneServiceHealthProbeOptions {
  /** Absolute, operator-owned ctxlane executable; PATH lookup is forbidden. */
  readonly executable: string;
  /** Absolute, operator-owned ctxlane root; implicit discovery is forbidden. */
  readonly root: string;
  readonly timeoutMs?: number | undefined;
}

export interface CtxlaneServiceHealthObservationEnvelope {
  readonly transport: typeof CTXLANE_MCP_HEALTH_PROBE_TRANSPORT;
  readonly qualification: typeof CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION;
  readonly observed_at: string;
  readonly health: CtxlaneServiceHealth;
}

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

function trustedUid(uid: number): boolean {
  const currentUid = process.getuid?.();
  return currentUid === undefined || uid === 0 || uid === currentUid;
}

function validatePrivateAncestors(path: string, kind: "executable" | "root"): void {
  let current = dirname(path);
  for (;;) {
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("unsafe ancestor");
      }
      if (!trustedUid(metadata.uid)) throw new Error("untrusted ancestor owner");
      if ((metadata.mode & constants.S_IWGRP) !== 0 || (metadata.mode & constants.S_IWOTH) !== 0) {
        throw new Error("writable ancestor");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unavailable";
      throw new CtxlaneServiceHealthProbeError(
        kind === "executable" ? "executable-unavailable" : "root-unavailable",
        `${kind} ancestor is unavailable: ${detail}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validatePrivatePath(path: string, kind: "executable" | "root"): void {
  if (
    !isAbsolute(path) ||
    path !== normalize(path) ||
    path.includes("\0") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new CtxlaneServiceHealthProbeError(
      "invalid-options",
      `${kind} must be an absolute normalized path`,
    );
  }
  validatePrivateAncestors(path, kind);
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("symbolic link");
    if (kind === "executable" && !metadata.isFile()) throw new Error("not a file");
    if (kind === "executable" && (metadata.mode & constants.S_IXUSR) === 0) {
      throw new Error("not executable");
    }
    if (kind === "root" && !metadata.isDirectory()) throw new Error("not a directory");
    if (!trustedUid(metadata.uid)) throw new Error("untrusted owner");
    if ((metadata.mode & constants.S_IWGRP) !== 0 || (metadata.mode & constants.S_IWOTH) !== 0) {
      throw new Error("group/world writable");
    }
  } catch (error) {
    const reason = kind === "executable" ? "executable-unavailable" : "root-unavailable";
    const detail = error instanceof Error ? error.message : "unavailable";
    throw new CtxlaneServiceHealthProbeError(reason, `${kind} is unavailable: ${detail}`);
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * Run one operator-pinned, credential-free ctxlane MCP observation request.
 * The helper is shared by read-only probes; callers still must validate and
 * interpret the returned JSON against the operation's published contract.
 */
export async function runCtxlaneMcpStdio(
  executable: string,
  root: string,
  request: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  validatePrivatePath(executable, "executable");
  validatePrivatePath(root, "root");
  validateTimeout(timeoutMs);
  return runWithInput(
    executable,
    ["--root", root, "mcp", "serve", "--stdio"],
    request,
    {
      env: safeEnvironment(),
      signal,
      timeoutMs,
    },
  );
}

function responseValue(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "" || Buffer.byteLength(text, "utf8") > MAX_CTXLANE_MCP_HEALTH_RESPONSE_BYTES) {
    throw new CtxlaneServiceHealthProbeError(
      "malformed-response",
      "health response is empty or exceeds the control limit",
    );
  }
  try {
    return strictJsonDecode(text);
  } catch {
    throw new CtxlaneServiceHealthProbeError(
      "malformed-response",
      "health response is not one unique JSON document",
    );
  }
}

function parseHealthResponse(stdout: string): CtxlaneServiceHealth {
  const raw = responseValue(stdout);
  const parsedEnvelope = jsonRpcResponseSchema.safeParse(raw);
  if (!parsedEnvelope.success) {
    throw new CtxlaneServiceHealthProbeError(
      "malformed-response",
      "health response is not the expected JSON-RPC 2.0 result envelope",
    );
  }
  if (parsedEnvelope.data.error !== undefined) {
    throw new CtxlaneServiceHealthProbeError(
      "service-refused",
      "ctxlane refused the authenticated health request",
    );
  }
  const health = ctxlaneServiceHealthSchema.safeParse(parsedEnvelope.data.result);
  if (!health.success) {
    throw new CtxlaneServiceHealthProbeError(
      "invalid-health",
      "ctxlane returned a result outside service-health/v1",
    );
  }
  return health.data;
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CTXLANE_MCP_HEALTH_TIMEOUT_MS
  ) {
    throw new CtxlaneServiceHealthProbeError(
      "invalid-options",
      "timeout is outside the safe range",
    );
  }
}

/**
 * Query only ctxlane's authenticated, capability-free service-health MCP
 * result.  This adapter never acquires, renews, revokes, or promotes a lease;
 * an operator-supplied private lifecycle client remains mandatory for ASF
 * identity authority.
 */
export class CtxlaneMcpServiceHealthProbe {
  readonly qualification = CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION;
  readonly transport = CTXLANE_MCP_HEALTH_PROBE_TRANSPORT;
  readonly #executable: string;
  readonly #root: string;
  readonly #timeoutMs: number;

  constructor(options: CtxlaneServiceHealthProbeOptions) {
    if (options === null || typeof options !== "object") {
      throw new CtxlaneServiceHealthProbeError("invalid-options", "options are required");
    }
    validatePrivatePath(options.executable, "executable");
    validatePrivatePath(options.root, "root");
    const timeoutMs = options.timeoutMs ?? DEFAULT_CTXLANE_MCP_HEALTH_TIMEOUT_MS;
    validateTimeout(timeoutMs);
    this.#executable = options.executable;
    this.#root = options.root;
    this.#timeoutMs = timeoutMs;
  }

  async probe(signal?: AbortSignal): Promise<CtxlaneServiceHealth> {
    if (signal !== undefined && signal.aborted) {
      throw new CtxlaneServiceHealthProbeError("cancelled", "probe was cancelled");
    }
    const result = await runCtxlaneMcpStdio(
      this.#executable,
      this.#root,
      CTXLANE_MCP_HEALTH_REQUEST,
      this.#timeoutMs,
      signal,
    );
    if (signal?.aborted === true) {
      throw new CtxlaneServiceHealthProbeError("cancelled", "probe was cancelled");
    }
    if (!result.ok) {
      const reason = result.stderr.includes("timed out after") ? "timed-out" : "command-failed";
      throw new CtxlaneServiceHealthProbeError(reason, "ctxlane health command failed");
    }
    return parseHealthResponse(result.stdout);
  }
}

/** Convert a service-health result into Runmill's diagnostic-only ASF probe shape. */
export function toAsfCtxlaneHealthObservation(
  health: CtxlaneServiceHealth,
  clock: Clock,
): CtxlaneHealthObservation {
  const parsed = ctxlaneServiceHealthSchema.parse(health);
  return {
    schema: "asf.health-observation/v1",
    kind: "ctxlane",
    observed_at: clock.now().toISOString(),
    data: {
      reachable: true,
      // Preserve ctxlane's own controller-channel readiness bit. A successful
      // response still proves no identity lease: this probe deliberately
      // reports the lease check as false.
      mutually_authenticated: parsed.controller_channel_ready,
      automation_lease_probe_passed: false,
    },
  } satisfies CtxlaneHealthObservation;
}

export function toCtxlaneServiceHealthObservationEnvelope(
  health: CtxlaneServiceHealth,
  clock: Clock,
): CtxlaneServiceHealthObservationEnvelope {
  return {
    transport: CTXLANE_MCP_HEALTH_PROBE_TRANSPORT,
    qualification: CTXLANE_MCP_HEALTH_PROBE_QUALIFICATION,
    observed_at: clock.now().toISOString(),
    health: ctxlaneServiceHealthSchema.parse(health),
  };
}
