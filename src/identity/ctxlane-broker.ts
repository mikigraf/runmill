import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import type { Clock } from "../platform/clock.js";
import { sha256Digest, type JsonValue } from "../asf/canonical-json.js";
import {
  LEASE_DISPOSITIONS,
  POLICY_DIGEST_PATTERN,
  identityOwnershipFenceFor,
  type IdentityExecutionHandle,
  type IdentityLease,
  type IdentityLeaseId,
  type IdentityLeaseRequest,
  type IdentityOwnershipFenceValidator,
  type LeaseDisposition,
  type ProviderIdentityBroker,
} from "./broker.js";

export const CTXLANE_AUTOMATION_REQUEST_SCHEMA =
  "ctxlane.automation-identity-request/v1" as const;
export const CTXLANE_AUTOMATION_RESPONSE_SCHEMA =
  "ctxlane.automation-identity-response/v1" as const;
export const CTXLANE_IDENTITY_LEASE_SCHEMA = "ctxlane.identity-lease/v1" as const;
export const MAX_CTXLANE_CONTROL_MESSAGE_BYTES = 256 * 1024;
export const DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_CTXLANE_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CTXLANE_CLOCK_SKEW_MS = 30_000;
export const MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS = 86_400_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
    "must be a bounded printable identifier",
  );
const secretCapabilitySchema = z
  .string()
  .min(16)
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain controls");
const digestSchema = z.string().regex(POLICY_DIGEST_PATTERN);
const roleSchema = z.enum([
  "implementer",
  "local-reviewer",
  "fixer",
  "pr-reviewer",
  "retrospective",
]);
const timestampSchema = z.iso.datetime({ offset: true });
const reasonSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
    "must be trimmed printable text",
  );

function assertCapabilitySeparation(
  leaseId: string,
  executionHandle: string,
  publicValues: readonly string[],
  context: z.RefinementCtx,
): void {
  if (leaseId.includes(executionHandle) || executionHandle.includes(leaseId)) {
    context.addIssue({
      code: "custom",
      path: ["execution_handle"],
      message: "must use a distinct capability namespace",
    });
  }
  if (
    publicValues.some(
      (value) => value.includes(leaseId) || value.includes(executionHandle),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["lease_id"],
      message: "capabilities must not appear in public attribution",
    });
  }
}

type WireOperation = "acquire" | "renew" | "close" | "revoke";
type WirePayload = Readonly<{ readonly [key: string]: JsonValue }>;

const leaseWireSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_SCHEMA),
    lease_id: secretCapabilitySchema,
    execution_handle: secretCapabilitySchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    role: roleSchema,
    policy_digest: digestSchema,
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    issued_at: timestampSchema,
    expires_at: timestampSchema,
    fencing_generation: z.number().int().positive(),
  })
  .strict()
  .superRefine((lease, context) => {
    assertCapabilitySeparation(
      lease.lease_id,
      lease.execution_handle,
      [
        lease.run_id,
        lease.work_order_id,
        lease.attempt_id,
        lease.role,
        lease.policy_digest,
        lease.provider,
        lease.principal,
        lease.profile,
        lease.issued_at,
        lease.expires_at,
      ],
      context,
    );
  });

const revocableLeaseWireSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_SCHEMA),
    lease_id: secretCapabilitySchema,
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    role: roleSchema,
    policy_digest: digestSchema,
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    fencing_generation: z.number().int().positive(),
  })
  .passthrough();

const identityLeaseSnapshotSchema = z
  .object({
    leaseId: secretCapabilitySchema,
    executionHandle: secretCapabilitySchema,
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    role: roleSchema,
    policyDigest: digestSchema,
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    fencingGeneration: z.number().int().positive(),
  })
  .strict()
  .superRefine((lease, context) => {
    assertCapabilitySeparation(
      lease.leaseId,
      lease.executionHandle,
      [
        lease.runId,
        lease.workOrderId,
        lease.attemptId,
        lease.role,
        lease.policyDigest,
        lease.provider,
        lease.principal,
        lease.profile,
        lease.issuedAt,
        lease.expiresAt,
      ],
      context,
    );
  });

const identityLeaseRequestSchema = z
  .object({
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    role: roleSchema,
    requestedProfile: identifierSchema,
    policyDigest: digestSchema,
    fencingGeneration: z.number().int().positive(),
    requestedDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS),
  })
  .strict();

const acquirePayloadSchema = z
  .object({
    schema: z.literal("ctxlane.identity-lease-request/v1"),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    role: roleSchema,
    requested_profile: identifierSchema,
    policy_digest: digestSchema,
    fencing_generation: z.number().int().positive(),
    requested_duration_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS),
  })
  .strict();

const leaseLifecycleBindingShape = {
  lease_id: secretCapabilitySchema,
  lease_id_digest: digestSchema,
  run_id: identifierSchema,
  work_order_id: identifierSchema,
  attempt_id: identifierSchema,
  role: roleSchema,
  policy_digest: digestSchema,
  provider: identifierSchema,
  principal: identifierSchema,
  profile: identifierSchema,
  fencing_generation: z.number().int().positive(),
} satisfies z.ZodRawShape;

const renewPayloadSchema = z
  .object({
    schema: z.literal("ctxlane.identity-lease-renewal/v1"),
    ...leaseLifecycleBindingShape,
    prior_lease_digest: digestSchema,
    requested_duration_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS),
  })
  .strict();
const closePayloadSchema = z
  .object({
    schema: z.literal("ctxlane.identity-lease-close/v1"),
    ...leaseLifecycleBindingShape,
    disposition: z.enum(LEASE_DISPOSITIONS),
  })
  .strict();
const revokePayloadSchema = z
  .object({
    schema: z.literal("ctxlane.identity-lease-revocation/v1"),
    ...leaseLifecycleBindingShape,
    reason: reasonSchema,
  })
  .strict();

const dispositionWireSchema = z
  .object({
    lease_id_digest: digestSchema,
    disposition: z.enum(["completed", "cancelled", "failed", "refused", "revoked"]),
  })
  .strict();

const successResponseSchema = z
  .object({
    schema: z.literal(CTXLANE_AUTOMATION_RESPONSE_SCHEMA),
    request_id: digestSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();
const failureResponseSchema = z
  .object({
    schema: z.literal(CTXLANE_AUTOMATION_RESPONSE_SCHEMA),
    request_id: digestSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z0-9_]+$/u),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
const responseSchema = z.union([successResponseSchema, failureResponseSchema]);

export interface CtxlaneAutomationRequest {
  readonly schema: typeof CTXLANE_AUTOMATION_REQUEST_SCHEMA;
  readonly request_id: string;
  readonly operation: WireOperation;
  readonly payload: WirePayload;
}

export function ctxlaneAutomationRequestId(
  operation: WireOperation,
  payload: WirePayload,
): string {
  return sha256Digest({
    schema: CTXLANE_AUTOMATION_REQUEST_SCHEMA,
    operation,
    payload,
  });
}

const automationRequestSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        schema: z.literal(CTXLANE_AUTOMATION_REQUEST_SCHEMA),
        request_id: digestSchema,
        operation: z.literal("acquire"),
        payload: acquirePayloadSchema,
      })
      .strict(),
    z
      .object({
        schema: z.literal(CTXLANE_AUTOMATION_REQUEST_SCHEMA),
        request_id: digestSchema,
        operation: z.literal("renew"),
        payload: renewPayloadSchema,
      })
      .strict(),
    z
      .object({
        schema: z.literal(CTXLANE_AUTOMATION_REQUEST_SCHEMA),
        request_id: digestSchema,
        operation: z.literal("close"),
        payload: closePayloadSchema,
      })
      .strict(),
    z
      .object({
        schema: z.literal(CTXLANE_AUTOMATION_REQUEST_SCHEMA),
        request_id: digestSchema,
        operation: z.literal("revoke"),
        payload: revokePayloadSchema,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (request.operation !== "acquire") {
      const expectedLeaseDigest = sha256Digest({ lease_id: request.payload.lease_id });
      if (request.payload.lease_id_digest !== expectedLeaseDigest) {
        context.addIssue({
          code: "custom",
          path: ["payload", "lease_id_digest"],
          message: "must bind the exact lease identifier",
        });
      }
      if (
        request.operation === "renew" &&
        request.payload.prior_lease_digest !== expectedLeaseDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "prior_lease_digest"],
          message: "must bind the exact prior lease identifier",
        });
      }
    }
    if (
      request.request_id !==
      ctxlaneAutomationRequestId(request.operation, request.payload)
    ) {
      context.addIssue({
        code: "custom",
        path: ["request_id"],
        message: "must bind the exact schema, operation, and payload",
      });
    }
  });

/** Trusted local transport boundary for the ctxlane automation service. */
export interface CtxlaneAutomationIdentityClient {
  request(request: CtxlaneAutomationRequest, signal?: AbortSignal): Promise<unknown>;
}

export class CtxlaneIdentityProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtxlaneIdentityProtocolError";
  }
}

function parseUnixEndpoint(endpoint: string): string {
  if (!endpoint.startsWith("unix:///")) {
    throw new CtxlaneIdentityProtocolError("ctxlane endpoint must be an absolute unix URI");
  }
  if (
    /[\u0000-\u001f\u007f]/u.test(endpoint) ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    endpoint.includes("@")
  ) {
    throw new CtxlaneIdentityProtocolError("ctxlane endpoint contains forbidden URI data");
  }
  let socketPath: string;
  try {
    socketPath = decodeURIComponent(endpoint.slice("unix://".length));
  } catch {
    throw new CtxlaneIdentityProtocolError("ctxlane endpoint contains invalid escaping");
  }
  if (
    !isAbsolute(socketPath) ||
    socketPath.length > 4_096 ||
    socketPath !== normalize(socketPath) ||
    /[\u0000-\u001f\u007f?#@]/u.test(socketPath)
  ) {
    throw new CtxlaneIdentityProtocolError("ctxlane socket path must be absolute");
  }
  return socketPath;
}

export interface CtxlaneUnixAutomationClientOptions {
  readonly endpoint: string;
  readonly timeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  /** Root and the current user are accepted by default. */
  readonly trustedOwnerUids?: readonly number[] | undefined;
}

interface PrivateSocketSnapshot {
  readonly socketDevice: number;
  readonly socketInode: number;
  readonly directoryDevice: number;
  readonly directoryInode: number;
}

function sameSocketSnapshot(
  expected: PrivateSocketSnapshot,
  current: PrivateSocketSnapshot,
): boolean {
  return (
    expected.socketDevice === current.socketDevice &&
    expected.socketInode === current.socketInode &&
    expected.directoryDevice === current.directoryDevice &&
    expected.directoryInode === current.directoryInode
  );
}

/**
 * One-request/one-response client for a private ctxlane Unix control socket.
 *
 * It validates the socket itself before every request, bounds both directions,
 * and never reflects remote text or local paths in its public errors.
 */
export class CtxlaneUnixAutomationClient implements CtxlaneAutomationIdentityClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #trustedOwnerUids: ReadonlySet<number>;

  constructor(options: CtxlaneUnixAutomationClientOptions) {
    this.#socketPath = parseUnixEndpoint(options.endpoint);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_CTXLANE_CONTROL_MESSAGE_BYTES;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS
    ) {
      throw new CtxlaneIdentityProtocolError("ctxlane timeout is outside the safe range");
    }
    if (
      !Number.isSafeInteger(this.#maxMessageBytes) ||
      this.#maxMessageBytes < 1_024 ||
      this.#maxMessageBytes > MAX_CTXLANE_CONTROL_MESSAGE_BYTES
    ) {
      throw new CtxlaneIdentityProtocolError("ctxlane message limit is outside the safe range");
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const owners = options.trustedOwnerUids ?? (currentUid === undefined ? [0] : [0, currentUid]);
    if (
      owners.length === 0 ||
      owners.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
    ) {
      throw new CtxlaneIdentityProtocolError("ctxlane trusted owner set is invalid");
    }
    this.#trustedOwnerUids = new Set(owners);
  }

  async request(request: CtxlaneAutomationRequest, signal?: AbortSignal): Promise<unknown> {
    let validated: z.infer<typeof automationRequestSchema>;
    try {
      const parsed = automationRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new CtxlaneIdentityProtocolError("ctxlane request is malformed or unbound");
      }
      validated = parsed.data;
    } catch (error) {
      if (error instanceof CtxlaneIdentityProtocolError) throw error;
      throw new CtxlaneIdentityProtocolError("ctxlane request is malformed or unbound");
    }
    const requestText = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(requestText, "utf8") > this.#maxMessageBytes) {
      throw new CtxlaneIdentityProtocolError("ctxlane request exceeds the control limit");
    }
    if (signal?.aborted === true) {
      throw new CtxlaneIdentityProtocolError("ctxlane request was cancelled");
    }
    const expectedSocket = this.#privateSocketSnapshot();

    return new Promise<unknown>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = createConnection(this.#socketPath);
      } catch {
        reject(new CtxlaneIdentityProtocolError("ctxlane control connection failed"));
        return;
      }
      let settled = false;
      let response = "";
      let receivedBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });

      const finish = (error: Error | undefined, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const fail = (reason: string): void =>
        finish(new CtxlaneIdentityProtocolError(reason));
      const abort = (): void => fail("ctxlane request was cancelled");
      const deadline = setTimeout(() => fail("ctxlane request timed out"), this.#timeoutMs);

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      socket.once("connect", () => {
        let currentSocket: PrivateSocketSnapshot;
        try {
          currentSocket = this.#privateSocketSnapshot();
        } catch {
          fail("ctxlane control endpoint changed before connection");
          return;
        }
        if (!sameSocketSnapshot(expectedSocket, currentSocket)) {
          fail("ctxlane control endpoint changed before connection");
          return;
        }
        socket.write(requestText, "utf8");
      });
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > this.#maxMessageBytes) {
          fail("ctxlane response exceeds the control limit");
          return;
        }
        try {
          response += decoder.decode(chunk, { stream: true });
        } catch {
          fail("ctxlane returned invalid UTF-8");
          return;
        }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        if (response.slice(newline + 1).trim() !== "") {
          fail("ctxlane returned more than one response");
          return;
        }
        try {
          finish(undefined, JSON.parse(response.slice(0, newline)) as unknown);
        } catch {
          fail("ctxlane returned invalid JSON");
        }
      });
      socket.once("error", () => fail("ctxlane control connection failed"));
      socket.once("end", () => {
        if (settled) return;
        try {
          response += decoder.decode();
        } catch {
          fail("ctxlane returned invalid UTF-8");
          return;
        }
        fail("ctxlane closed without a complete response");
      });
      socket.once("close", () => {
        if (!settled) fail("ctxlane closed without a complete response");
      });
    });
  }

  #privateSocketSnapshot(): PrivateSocketSnapshot {
    try {
      const directory = lstatSync(dirname(this.#socketPath));
      if (!directory.isDirectory()) throw new Error("directory type");
      if (!this.#trustedOwnerUids.has(directory.uid)) throw new Error("directory owner");
      if ((directory.mode & 0o022) !== 0) throw new Error("directory writable");
      const stat = lstatSync(this.#socketPath);
      if (!stat.isSocket()) throw new Error("not socket");
      if (!this.#trustedOwnerUids.has(stat.uid)) throw new Error("owner");
      // Connection permission on a Unix socket is carried by write bits.
      if ((stat.mode & 0o022) !== 0) throw new Error("writable");
      return {
        socketDevice: stat.dev,
        socketInode: stat.ino,
        directoryDevice: directory.dev,
        directoryInode: directory.ino,
      };
    } catch {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane control endpoint or directory is missing or not privately owned",
      );
    }
  }
}

function identityFailure(stage: string, runId?: string): RunmillError {
  return RunmillError.fromCatalog("RM-AUTH-003", {
    whatHappened: `ctxlane identity ${stage} failed closed; protected remote details were omitted`,
    ...(runId === undefined ? {} : { runId }),
  });
}

function leaseIdDigest(lease: IdentityLease): string {
  return sha256Digest({ lease_id: lease.leaseId });
}

function leaseLifecycleBinding(lease: IdentityLease) {
  return {
    lease_id: lease.leaseId,
    lease_id_digest: leaseIdDigest(lease),
    run_id: lease.runId,
    work_order_id: lease.workOrderId,
    attempt_id: lease.attemptId,
    role: lease.role,
    policy_digest: lease.policyDigest,
    provider: lease.provider,
    principal: lease.principal,
    profile: lease.profile,
    fencing_generation: lease.fencingGeneration,
  } as const;
}

function durationMs(lease: IdentityLease): number {
  return Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt);
}

function validateIdentityRequest(request: IdentityLeaseRequest): void {
  try {
    const parsed = identityLeaseRequestSchema.safeParse(request);
    if (parsed.success) return;
  } catch {
    // Getter-bearing or otherwise hostile runtime input is invalid.
  }
  throw identityFailure("request validation");
}

function validateLeaseSnapshot(lease: IdentityLease): void {
  try {
    const parsed = identityLeaseSnapshotSchema.safeParse(lease);
    if (parsed.success) return;
  } catch {
    // Getter-bearing or otherwise hostile runtime input is invalid.
  }
  throw identityFailure("lease validation");
}

function freezeWireLease(raw: z.infer<typeof leaseWireSchema>): IdentityLease {
  return Object.freeze({
    leaseId: raw.lease_id as IdentityLeaseId,
    executionHandle: raw.execution_handle as IdentityExecutionHandle,
    runId: raw.run_id,
    workOrderId: raw.work_order_id,
    attemptId: raw.attempt_id,
    role: raw.role,
    policyDigest: raw.policy_digest,
    provider: raw.provider,
    principal: raw.principal,
    profile: raw.profile,
    issuedAt: raw.issued_at,
    expiresAt: raw.expires_at,
    fencingGeneration: raw.fencing_generation,
  });
}

type LeaseAuthorityBinding = IdentityLease | IdentityLeaseRequest;

function sameWorkAttempt(
  lease: {
    readonly runId: string;
    readonly workOrderId: string;
    readonly attemptId: string;
  },
  binding: LeaseAuthorityBinding,
): boolean {
  return (
    lease.runId === binding.runId &&
    lease.workOrderId === binding.workOrderId &&
    lease.attemptId === binding.attemptId
  );
}

function sameWireWorkAttempt(
  lease: z.infer<typeof revocableLeaseWireSchema>,
  binding: LeaseAuthorityBinding,
): boolean {
  return (
    lease.run_id === binding.runId &&
    lease.work_order_id === binding.workOrderId &&
    lease.attempt_id === binding.attemptId
  );
}

function wireLeaseLifecycleBinding(lease: z.infer<typeof revocableLeaseWireSchema>) {
  return {
    lease_id: lease.lease_id,
    lease_id_digest: sha256Digest({ lease_id: lease.lease_id }),
    run_id: lease.run_id,
    work_order_id: lease.work_order_id,
    attempt_id: lease.attempt_id,
    role: lease.role,
    policy_digest: lease.policy_digest,
    provider: lease.provider,
    principal: lease.principal,
    profile: lease.profile,
    fencing_generation: lease.fencing_generation,
  } as const;
}

export interface CtxlaneProviderIdentityBrokerOptions {
  readonly client: CtxlaneAutomationIdentityClient;
  readonly clock: Clock;
  readonly ownershipFence: IdentityOwnershipFenceValidator;
  readonly maximumClockSkewMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

/** Production identity broker backed by the trusted ctxlane automation plane. */
export class CtxlaneProviderIdentityBroker implements ProviderIdentityBroker {
  readonly #client: CtxlaneAutomationIdentityClient;
  readonly #clock: Clock;
  readonly #ownershipFence: IdentityOwnershipFenceValidator;
  readonly #maximumClockSkewMs: number;
  readonly #requestTimeoutMs: number;

  constructor(options: CtxlaneProviderIdentityBrokerOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#ownershipFence = options.ownershipFence;
    this.#maximumClockSkewMs = options.maximumClockSkewMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#maximumClockSkewMs) ||
      this.#maximumClockSkewMs < 0 ||
      this.#maximumClockSkewMs > MAX_CTXLANE_CLOCK_SKEW_MS
    ) {
      throw new CtxlaneIdentityProtocolError("ctxlane clock skew is outside the safe range");
    }
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS
    ) {
      throw new CtxlaneIdentityProtocolError("ctxlane request timeout is outside the safe range");
    }
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    validateIdentityRequest(request);
    await this.#assertCurrent(request, "acquisition");
    const payload = {
      schema: "ctxlane.identity-lease-request/v1",
      run_id: request.runId,
      work_order_id: request.workOrderId,
      attempt_id: request.attemptId,
      role: request.role,
      requested_profile: request.requestedProfile,
      policy_digest: request.policyDigest,
      fencing_generation: request.fencingGeneration,
      requested_duration_ms: request.requestedDurationMs,
    } as const;
    const lease = await this.#requestLease("acquire", payload, request);
    await this.#validateIssuedLeaseOrRevoke(lease, request, "acquisition", () => {
      this.#assertBindings(lease, request, request.requestedProfile);
      this.#assertFreshDuration(lease, request.requestedDurationMs);
    });
    await this.#assertCurrentOrRevoke(lease, "acquisition");
    return lease;
  }

  async renew(lease: IdentityLease): Promise<IdentityLease> {
    validateLeaseSnapshot(lease);
    this.#assertActiveLease(lease, "renewal");
    const requestedDurationMs = durationMs(lease);
    if (
      !Number.isSafeInteger(requestedDurationMs) ||
      requestedDurationMs < 1 ||
      requestedDurationMs > MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS
    ) {
      throw identityFailure("renewal validation", lease.runId);
    }
    await this.#assertCurrent(lease, "renewal");
    const payload = {
      schema: "ctxlane.identity-lease-renewal/v1",
      ...leaseLifecycleBinding(lease),
      prior_lease_digest: leaseIdDigest(lease),
      requested_duration_ms: requestedDurationMs,
    } as const;
    const renewed = await this.#requestLease("renew", payload, lease);
    await this.#validateIssuedLeaseOrRevoke(renewed, lease, "renewal", () => {
      this.#assertBindings(renewed, lease, lease.profile);
      if (
        renewed.provider !== lease.provider ||
        renewed.principal !== lease.principal ||
        renewed.profile !== lease.profile ||
        Date.parse(renewed.expiresAt) < Date.parse(lease.expiresAt)
      ) {
        throw identityFailure("renewal identity binding", lease.runId);
      }
      this.#assertFreshDuration(renewed, requestedDurationMs);
    });
    await this.#assertCurrentOrRevoke(renewed, "renewal");
    return renewed;
  }

  async close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    validateLeaseSnapshot(lease);
    if (!(LEASE_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw identityFailure("close validation", lease.runId);
    }
    await this.#requestDisposition(
      "close",
      {
        schema: "ctxlane.identity-lease-close/v1",
        ...leaseLifecycleBinding(lease),
        disposition,
      },
      lease,
      disposition,
    );
  }

  async revoke(lease: IdentityLease, reason: string): Promise<void> {
    validateLeaseSnapshot(lease);
    if (
      typeof reason !== "string" ||
      reason.trim() === "" ||
      reason.trim() !== reason ||
      reason.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(reason) ||
      reason.includes(lease.leaseId) ||
      reason.includes(lease.executionHandle)
    ) {
      throw identityFailure("revocation validation", lease.runId);
    }
    await this.#requestDisposition(
      "revoke",
      {
        schema: "ctxlane.identity-lease-revocation/v1",
        ...leaseLifecycleBinding(lease),
        reason,
      },
      lease,
      "revoked",
    );
  }

  async #requestLease(
    operation: "acquire" | "renew",
    payload: WirePayload,
    binding: LeaseAuthorityBinding,
  ): Promise<IdentityLease> {
    const raw = await this.#request(operation, payload, binding.runId);
    let parsed: z.ZodSafeParseResult<z.infer<typeof leaseWireSchema>>;
    try {
      parsed = leaseWireSchema.safeParse(raw);
    } catch {
      throw identityFailure(`${operation} response validation`, binding.runId);
    }
    if (!parsed.success) {
      let revocable: z.ZodSafeParseResult<z.infer<typeof revocableLeaseWireSchema>>;
      try {
        revocable = revocableLeaseWireSchema.safeParse(raw);
      } catch {
        throw identityFailure(`${operation} response validation`, binding.runId);
      }
      if (revocable.success && sameWireWorkAttempt(revocable.data, binding)) {
        try {
          await this.#revokeWireLease(
            revocable.data,
            binding.runId,
            `ctxlane returned an invalid identity ${operation} response`,
          );
        } catch {
          throw identityFailure(
            `${operation} invalid response with unresolved revocation`,
            binding.runId,
          );
        }
      }
      throw identityFailure(`${operation} response validation`, binding.runId);
    }
    return freezeWireLease(parsed.data);
  }

  async #revokeWireLease(
    lease: z.infer<typeof revocableLeaseWireSchema>,
    runId: string,
    reason: string,
  ): Promise<void> {
    const leaseDigest = sha256Digest({ lease_id: lease.lease_id });
    const raw = await this.#request(
      "revoke",
      {
        schema: "ctxlane.identity-lease-revocation/v1",
        ...wireLeaseLifecycleBinding(lease),
        reason,
      },
      runId,
    );
    let parsed: z.ZodSafeParseResult<z.infer<typeof dispositionWireSchema>>;
    try {
      parsed = dispositionWireSchema.safeParse(raw);
    } catch {
      throw identityFailure("revoke response validation", runId);
    }
    if (
      !parsed.success ||
      parsed.data.lease_id_digest !== leaseDigest ||
      parsed.data.disposition !== "revoked"
    ) {
      throw identityFailure("revoke response validation", runId);
    }
  }

  async #requestDisposition(
    operation: "close" | "revoke",
    payload: WirePayload,
    lease: IdentityLease,
    expected: LeaseDisposition | "revoked",
  ): Promise<void> {
    const raw = await this.#request(operation, payload, lease.runId);
    let parsed: z.ZodSafeParseResult<z.infer<typeof dispositionWireSchema>>;
    try {
      parsed = dispositionWireSchema.safeParse(raw);
    } catch {
      throw identityFailure(`${operation} response validation`, lease.runId);
    }
    if (
      !parsed.success ||
      parsed.data.lease_id_digest !== leaseIdDigest(lease) ||
      parsed.data.disposition !== expected
    ) {
      throw identityFailure(`${operation} response validation`, lease.runId);
    }
  }

  async #request(
    operation: WireOperation,
    payload: WirePayload,
    runId: string,
  ): Promise<unknown> {
    const requestId = ctxlaneAutomationRequestId(operation, payload);
    const request = {
      schema: CTXLANE_AUTOMATION_REQUEST_SCHEMA,
      request_id: requestId,
      operation,
      payload,
    } as const;
    let raw: unknown;
    try {
      raw = await new Promise<unknown>((resolve, reject) => {
        const abortController = new AbortController();
        let settled = false;
        const finish = (error: unknown, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error === undefined) resolve(value);
          else reject(new CtxlaneIdentityProtocolError("ctxlane client request failed"));
        };
        const deadline = setTimeout(() => {
          abortController.abort();
          finish(new CtxlaneIdentityProtocolError("ctxlane request timed out"));
        }, this.#requestTimeoutMs);
        void Promise.resolve()
          .then(() => this.#client.request(request, abortController.signal))
          .then(
            (value) => finish(undefined, value),
            (error: unknown) => finish(error),
          );
      });
    } catch {
      throw identityFailure(`${operation} transport`, runId);
    }
    let response: z.ZodSafeParseResult<z.infer<typeof responseSchema>>;
    try {
      response = responseSchema.safeParse(raw);
    } catch {
      throw identityFailure(`${operation} response binding`, runId);
    }
    if (!response.success || response.data.request_id !== requestId) {
      throw identityFailure(`${operation} response binding`, runId);
    }
    if (!response.data.ok) {
      throw identityFailure(`${operation} refusal`, runId);
    }
    return response.data.result;
  }

  #assertBindings(
    lease: IdentityLease,
    binding: IdentityLease | IdentityLeaseRequest,
    profile: string,
  ): void {
    if (
      lease.runId !== binding.runId ||
      lease.workOrderId !== binding.workOrderId ||
      lease.attemptId !== binding.attemptId ||
      lease.role !== binding.role ||
      lease.policyDigest !== binding.policyDigest ||
      lease.fencingGeneration !== binding.fencingGeneration ||
      lease.profile !== profile
    ) {
      throw identityFailure("lease binding", binding.runId);
    }
  }

  #assertFreshDuration(lease: IdentityLease, requestedDurationMs: number): void {
    const nowMs = this.#clock.now().getTime();
    const issuedAtMs = Date.parse(lease.issuedAt);
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs > nowMs + this.#maximumClockSkewMs ||
      expiresAtMs <= nowMs ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > requestedDurationMs
    ) {
      throw identityFailure("lease time binding", lease.runId);
    }
  }

  #assertActiveLease(lease: IdentityLease, stage: string): void {
    const nowMs = this.#clock.now().getTime();
    const issuedAtMs = Date.parse(lease.issuedAt);
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs > nowMs + this.#maximumClockSkewMs ||
      expiresAtMs <= nowMs ||
      expiresAtMs <= issuedAtMs
    ) {
      throw identityFailure(`${stage} inactive lease`, lease.runId);
    }
  }

  async #assertCurrent(
    binding: IdentityLease | IdentityLeaseRequest,
    stage: string,
  ): Promise<void> {
    let current = false;
    try {
      current = (await this.#ownershipFence.isCurrent(identityOwnershipFenceFor(binding))) === true;
    } catch {
      current = false;
    }
    if (!current) throw identityFailure(`${stage} ownership fence`, binding.runId);
  }

  async #assertCurrentOrRevoke(lease: IdentityLease, stage: string): Promise<void> {
    try {
      await this.#assertCurrent(lease, stage);
    } catch {
      try {
        await this.revoke(lease, `fencing generation changed during identity ${stage}`);
      } catch {
        throw identityFailure(`${stage} fence loss with unresolved revocation`, lease.runId);
      }
      throw identityFailure(`${stage} fence loss`, lease.runId);
    }
  }

  async #validateIssuedLeaseOrRevoke(
    lease: IdentityLease,
    binding: LeaseAuthorityBinding,
    stage: string,
    validate: () => void,
  ): Promise<void> {
    try {
      validate();
      return;
    } catch {
      if (!sameWorkAttempt(lease, binding)) {
        throw identityFailure(`${stage} invalid binding outside cleanup authority`, binding.runId);
      }
      try {
        await this.revoke(lease, `ctxlane returned an invalid identity ${stage} binding`);
      } catch {
        throw identityFailure(`${stage} invalid binding with unresolved revocation`, binding.runId);
      }
      throw identityFailure(`${stage} invalid binding`, binding.runId);
    }
  }
}
