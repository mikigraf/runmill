import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import type { Clock } from "../platform/clock.js";
import {
  LEASE_DISPOSITIONS,
  POLICY_DIGEST_PATTERN,
  identityOwnershipFenceFor,
  markDefinitiveIdentityBrokerFailure,
  type IdentityExecutionHandle,
  type IdentityLease,
  type IdentityLeaseId,
  type IdentityLeaseRequest,
  type IdentityOwnershipFenceValidator,
  type LeaseDisposition,
  type ProviderIdentityBroker,
} from "./broker.js";
import type {
  CtxlaneAcquisitionAuthority,
  CtxlaneAcquisitionAuthorityResolver,
} from "./ctxlane-authority.js";
import {
  CTXLANE_IDENTITY_LEASE_REQUEST_SCHEMA,
  CTXLANE_IDENTITY_LEASE_SCHEMA,
  ctxlaneAutomationErrorSchema,
  ctxlaneIdentityLeaseRequestSchema,
  ctxlaneIdentityLeaseSchema,
  ctxlaneWorkOrderAuthorizationSchema,
  isAtOrBeforeUtc,
  isStrictlyBeforeUtc,
  utcTimestampOrderKey,
  type CtxlaneIdentityLease,
  type CtxlaneIdentityLeaseRequest,
  type CtxlaneAutomationError,
} from "./ctxlane-contracts.js";
import {
  DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS,
  MAX_CTXLANE_REQUEST_TIMEOUT_MS,
  CtxlaneIdentityProtocolError,
  type CtxlaneIdentityLeaseAcquisitionClient,
} from "./ctxlane-transport.js";

export { CTXLANE_IDENTITY_LEASE_REQUEST_SCHEMA, CTXLANE_IDENTITY_LEASE_SCHEMA };
export {
  CTXLANE_UNIX_AUTOMATION_TRANSPORT_QUALIFICATION,
  DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS,
  MAX_CTXLANE_CONTROL_MESSAGE_BYTES,
  MAX_CTXLANE_REQUEST_TIMEOUT_MS,
  CtxlaneIdentityProtocolError,
  CtxlaneJsonDuplicateKeyError,
  CtxlaneUnixAutomationClient,
  strictJsonDecode,
} from "./ctxlane-transport.js";
export type {
  CtxlaneIdentityLeaseAcquisitionClient,
  CtxlaneUnixAutomationClientOptions,
} from "./ctxlane-transport.js";

export const MAX_CTXLANE_CLOCK_SKEW_MS = 30_000;
export const MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS = 86_400_000;

const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "u",
);
const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !CONTROL_CHARACTER_PATTERN.test(value),
    "must be a bounded printable identifier",
  );
const capabilitySchema = z
  .string()
  .min(16)
  .max(4_096)
  .refine(
    (value) => !CONTROL_CHARACTER_PATTERN.test(value),
    "must not contain controls",
  );
const digestSchema = z.string().regex(POLICY_DIGEST_PATTERN);
const roleSchema = z.enum([
  "implementer",
  "local-reviewer",
  "fixer",
  "pr-reviewer",
  "retrospective",
]);
const timestampSchema = z.iso.datetime({ offset: true });
const callerSubjectSchema = z
  .string()
  .regex(/^caller:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const hostIdentitySchema = z
  .string()
  .regex(/^host:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);

const identityLeaseRequestSchema = z
  .object({
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    role: roleSchema,
    requestedProfile: identifierSchema,
    policyDigest: digestSchema,
    fencingGeneration: z.number().int().positive().safe(),
    requestedDurationMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_CTXLANE_IDENTITY_LEASE_DURATION_MS),
  })
  .strict();

const acquisitionAuthoritySchema = z
  .object({
    intent: z
      .object({
        clientRequestId: identifierSchema,
        acquisitionRequest: ctxlaneIdentityLeaseRequestSchema,
        expectedCallerSubject: callerSubjectSchema,
        expectedHostIdentity: hostIdentitySchema,
      })
      .strict(),
    clientRequestId: identifierSchema,
    tenantId: identifierSchema,
    workOrderDigest: digestSchema,
    workOrderAuthorization: ctxlaneWorkOrderAuthorizationSchema,
    provider: z.enum(["claude", "codex"]),
    profileUid: identifierSchema,
    profileRef: identifierSchema,
    repository: identifierSchema,
    workspaceId: identifierSchema,
    environment: identifierSchema,
    expectedCallerSubject: callerSubjectSchema,
    expectedHostIdentity: hostIdentitySchema,
    ctxlanePolicyDigest: z.union([digestSchema, z.null()]),
  })
  .strict();

const ctxlaneAttributionSchema = z
  .object({
    clientRequestId: identifierSchema,
    requestedTtlSeconds: z.number().int().min(1).max(86_400),
    tenantId: identifierSchema,
    workOrderDigest: digestSchema,
    profileUid: identifierSchema,
    callerSubject: identifierSchema,
    hostIdentity: identifierSchema,
    workerIdentity: identifierSchema.nullable(),
    workspaceId: identifierSchema,
    environment: identifierSchema,
    repository: identifierSchema,
    workspaceRef: identifierSchema,
    authMode: identifierSchema,
    isolation: identifierSchema,
    fencingGeneration: z.number().int().positive().safe(),
    effectivePolicyDigest: digestSchema,
    maximumExpiresAt: timestampSchema,
    status: z.enum(["active", "renewing"]),
  })
  .strict();

const ctxlaneProviderIdentityLeaseSchema = z
  .object({
    leaseId: capabilitySchema,
    executionHandle: capabilitySchema,
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
    fencingGeneration: z.number().int().positive().safe(),
    ctxlane: ctxlaneAttributionSchema,
  })
  .strict();

export type CtxlaneProviderIdentityLease = IdentityLease & {
  readonly ctxlane: NonNullable<IdentityLease["ctxlane"]>;
};

export interface CtxlaneLeaseRenewalRequest {
  readonly lease: CtxlaneProviderIdentityLease;
  readonly requestedTtlSeconds: number;
}

export interface CtxlaneLeaseCloseRequest {
  readonly lease: CtxlaneProviderIdentityLease;
  readonly disposition: "completed" | "worker-failed";
}

export interface CtxlaneLeaseRevocationRequest {
  readonly lease: CtxlaneProviderIdentityLease;
  readonly reason: string;
}

/**
 * Trusted in-process lifecycle boundary supplied by the deployment.
 *
 * ctxlane has not published lifecycle request wire schemas. These methods
 * therefore make no wire-format claim and may return only a full published
 * `ctxlane.identity-lease/v1` object or published automation error.
 */
export interface CtxlaneLeaseLifecycleClient {
  renew(
    request: CtxlaneLeaseRenewalRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(
    request: CtxlaneLeaseCloseRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
  revoke(
    request: CtxlaneLeaseRevocationRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

function identityFailure(
  stage: string,
  runId?: string,
  disposition?: "unchanged" | "retired",
): RunmillError {
  const error = RunmillError.fromCatalog("RM-AUTH-003", {
    whatHappened: `ctxlane identity ${stage} failed closed; protected remote details were omitted`,
    ...(runId === undefined ? {} : { runId }),
  });
  return disposition === undefined
    ? error
    : markDefinitiveIdentityBrokerFailure(error, disposition);
}

function deepFreezeSnapshot<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSnapshot(child);
  }
  return Object.freeze(value);
}

function validateIdentityRequest(
  request: IdentityLeaseRequest,
): Readonly<IdentityLeaseRequest> {
  try {
    const parsed = identityLeaseRequestSchema.safeParse(request);
    if (parsed.success) return deepFreezeSnapshot(parsed.data);
  } catch {
    // Getter-bearing or otherwise hostile values are invalid.
  }
  throw identityFailure("request validation", undefined, "unchanged");
}

function snapshotAcquisitionAuthority(
  authority: unknown,
  runId: string,
): CtxlaneAcquisitionAuthority {
  try {
    const parsed = acquisitionAuthoritySchema.safeParse(authority);
    if (parsed.success) {
      return deepFreezeSnapshot(parsed.data);
    }
  } catch {
    // Getter-bearing or otherwise hostile values are invalid.
  }
  throw identityFailure("authority validation", runId, "unchanged");
}

function capabilitiesAreSeparated(
  leaseId: string,
  executionHandle: string,
  publicValues: readonly string[],
): boolean {
  return (
    !leaseId.includes(executionHandle) &&
    !executionHandle.includes(leaseId) &&
    publicValues.every(
      (value) => !value.includes(leaseId) && !value.includes(executionHandle),
    )
  );
}

function validateLeaseSnapshot(
  lease: IdentityLease,
): CtxlaneProviderIdentityLease {
  try {
    const parsed = ctxlaneProviderIdentityLeaseSchema.safeParse(lease);
    if (
      parsed.success &&
      ctxlaneIdentityLeaseSchema.safeParse({
        schema: CTXLANE_IDENTITY_LEASE_SCHEMA,
        lease_id: parsed.data.leaseId,
        status: parsed.data.ctxlane.status,
        tenant_id: parsed.data.ctxlane.tenantId,
        work_order_id: parsed.data.workOrderId,
        work_order_digest: parsed.data.ctxlane.workOrderDigest,
        run_id: parsed.data.runId,
        attempt_id: parsed.data.attemptId,
        role: parsed.data.role,
        provider: parsed.data.provider,
        profile_uid: parsed.data.ctxlane.profileUid,
        profile_ref: parsed.data.profile,
        repository: parsed.data.ctxlane.repository,
        workspace_id: parsed.data.ctxlane.workspaceId,
        environment: parsed.data.ctxlane.environment,
        caller_subject: parsed.data.ctxlane.callerSubject,
        host_identity: parsed.data.ctxlane.hostIdentity,
        worker_identity: parsed.data.ctxlane.workerIdentity,
        principal_ref: parsed.data.principal,
        workspace_ref: parsed.data.ctxlane.workspaceRef,
        auth_mode: parsed.data.ctxlane.authMode,
        fencing_generation: parsed.data.ctxlane.fencingGeneration,
        issued_at: parsed.data.issuedAt,
        expires_at: parsed.data.expiresAt,
        maximum_expires_at: parsed.data.ctxlane.maximumExpiresAt,
        execution_handle: parsed.data.executionHandle,
        isolation: parsed.data.ctxlane.isolation,
        effective_policy_digest: parsed.data.ctxlane.effectivePolicyDigest,
        refusal_code: null,
        reason_code: null,
      }).success &&
      capabilitiesAreSeparated(
        parsed.data.leaseId,
        parsed.data.executionHandle,
        [
          parsed.data.runId,
          parsed.data.workOrderId,
          parsed.data.attemptId,
          parsed.data.policyDigest,
          parsed.data.provider,
          parsed.data.principal,
          parsed.data.profile,
          parsed.data.ctxlane.clientRequestId,
          parsed.data.ctxlane.tenantId,
          parsed.data.ctxlane.workOrderDigest,
          parsed.data.ctxlane.profileUid,
          parsed.data.ctxlane.callerSubject,
          parsed.data.ctxlane.hostIdentity,
          parsed.data.ctxlane.repository,
          parsed.data.ctxlane.workspaceId,
        ],
      )
    ) {
      return deepFreezeSnapshot(parsed.data) as CtxlaneProviderIdentityLease;
    }
  } catch {
    // Getter-bearing or otherwise hostile values are invalid.
  }
  throw identityFailure("lease validation");
}

function exactMilliseconds(value: number): bigint {
  return BigInt(value) * 1_000_000n;
}

function requestedTtlSeconds(lease: CtxlaneProviderIdentityLease): number {
  const seconds = lease.ctxlane.requestedTtlSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw identityFailure("renewal validation", lease.runId);
  }
  return seconds;
}

function freezeIdentityLease(
  lease: CtxlaneIdentityLease,
  request: Pick<IdentityLeaseRequest, "policyDigest" | "fencingGeneration">,
  clientRequestId: string,
  originalRequestedTtlSeconds: number,
): CtxlaneProviderIdentityLease {
  if (
    lease.execution_handle === null ||
    lease.principal_ref === null ||
    lease.workspace_ref === null ||
    lease.auth_mode === null ||
    lease.fencing_generation === null ||
    lease.expires_at === null ||
    lease.maximum_expires_at === null ||
    lease.isolation === null ||
    lease.effective_policy_digest === null ||
    (lease.status !== "active" && lease.status !== "renewing")
  ) {
    throw identityFailure("resolved lease projection", lease.run_id);
  }
  const attribution = Object.freeze({
    clientRequestId,
    requestedTtlSeconds: originalRequestedTtlSeconds,
    tenantId: lease.tenant_id,
    workOrderDigest: lease.work_order_digest,
    profileUid: lease.profile_uid,
    callerSubject: lease.caller_subject,
    hostIdentity: lease.host_identity,
    workerIdentity: lease.worker_identity,
    workspaceId: lease.workspace_id,
    environment: lease.environment,
    repository: lease.repository,
    workspaceRef: lease.workspace_ref,
    authMode: lease.auth_mode,
    isolation: lease.isolation,
    fencingGeneration: lease.fencing_generation,
    effectivePolicyDigest: lease.effective_policy_digest,
    maximumExpiresAt: lease.maximum_expires_at,
    status: lease.status,
  });
  return Object.freeze({
    leaseId: lease.lease_id as IdentityLeaseId,
    executionHandle: lease.execution_handle as IdentityExecutionHandle,
    runId: lease.run_id,
    workOrderId: lease.work_order_id,
    attemptId: lease.attempt_id,
    role: lease.role,
    policyDigest: request.policyDigest,
    provider: lease.provider,
    principal: lease.principal_ref,
    profile: lease.profile_ref,
    issuedAt: lease.issued_at,
    expiresAt: lease.expires_at,
    fencingGeneration: request.fencingGeneration,
    ctxlane: attribution,
  });
}

function safePublishedLease(raw: unknown): CtxlaneIdentityLease | null {
  try {
    const parsed = ctxlaneIdentityLeaseSchema.safeParse(raw);
    return parsed.success ? deepFreezeSnapshot(parsed.data) : null;
  } catch {
    return null;
  }
}

function safePublishedAutomationError(
  raw: unknown,
): CtxlaneAutomationError | null {
  try {
    const parsed = ctxlaneAutomationErrorSchema.safeParse(raw);
    return parsed.success ? deepFreezeSnapshot(parsed.data) : null;
  } catch {
    return null;
  }
}

function isRetiredLifecycleStatus(
  status: CtxlaneIdentityLease["status"],
): status is "closed" | "revoked" | "expired" {
  return status === "closed" || status === "revoked" || status === "expired";
}

export interface CtxlaneProviderIdentityBrokerOptions {
  readonly client: CtxlaneIdentityLeaseAcquisitionClient;
  readonly lifecycleClient: CtxlaneLeaseLifecycleClient;
  readonly clock: Clock;
  readonly ownershipFence: IdentityOwnershipFenceValidator;
  readonly authority: CtxlaneAcquisitionAuthorityResolver;
  readonly maximumClockSkewMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

/** Production identity broker backed by ctxlane's exact published acquisition contract. */
export class CtxlaneProviderIdentityBroker implements ProviderIdentityBroker {
  readonly #client: CtxlaneIdentityLeaseAcquisitionClient;
  readonly #lifecycleClient: CtxlaneLeaseLifecycleClient;
  readonly #clock: Clock;
  readonly #ownershipFence: IdentityOwnershipFenceValidator;
  readonly #authority: CtxlaneAcquisitionAuthorityResolver;
  readonly #maximumClockSkewMs: number;
  readonly #requestTimeoutMs: number;

  constructor(options: CtxlaneProviderIdentityBrokerOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.client?.acquire !== "function" ||
      typeof options.lifecycleClient?.renew !== "function" ||
      typeof options.lifecycleClient?.close !== "function" ||
      typeof options.lifecycleClient?.revoke !== "function" ||
      typeof options.authority?.resolveAcquisitionAuthority !== "function" ||
      typeof options.ownershipFence?.isCurrent !== "function" ||
      typeof options.clock?.now !== "function"
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane broker dependencies are incomplete",
      );
    }
    this.#client = options.client;
    this.#lifecycleClient = options.lifecycleClient;
    this.#clock = options.clock;
    this.#ownershipFence = options.ownershipFence;
    this.#authority = options.authority;
    this.#maximumClockSkewMs = options.maximumClockSkewMs ?? 30_000;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_CTXLANE_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#maximumClockSkewMs) ||
      this.#maximumClockSkewMs < 0 ||
      this.#maximumClockSkewMs > MAX_CTXLANE_CLOCK_SKEW_MS
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane clock skew is outside the safe range",
      );
    }
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > MAX_CTXLANE_REQUEST_TIMEOUT_MS
    ) {
      throw new CtxlaneIdentityProtocolError(
        "ctxlane request timeout is outside the safe range",
      );
    }
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    const requestSnapshot = validateIdentityRequest(request);
    if (
      requestSnapshot.role !== "implementer" &&
      requestSnapshot.role !== "local-reviewer" &&
      requestSnapshot.role !== "pr-reviewer"
    ) {
      throw identityFailure(
        "acquire role validation",
        requestSnapshot.runId,
        "unchanged",
      );
    }
    if (requestSnapshot.requestedDurationMs % 1_000 !== 0) {
      throw identityFailure(
        "acquire ttl conversion",
        requestSnapshot.runId,
        "unchanged",
      );
    }
    try {
      await this.#assertCurrent(requestSnapshot, "acquisition");
    } catch {
      throw identityFailure(
        "acquisition ownership fence",
        requestSnapshot.runId,
        "unchanged",
      );
    }

    let authority: CtxlaneAcquisitionAuthority;
    try {
      authority = snapshotAcquisitionAuthority(
        await this.#authority.resolveAcquisitionAuthority(requestSnapshot),
        requestSnapshot.runId,
      );
    } catch {
      throw identityFailure(
        "authority resolution",
        requestSnapshot.runId,
        "unchanged",
      );
    }
    let wire: CtxlaneIdentityLeaseRequest;
    try {
      this.#assertAuthorityIntent(authority, requestSnapshot);
      wire = this.#buildAcquireRequest(requestSnapshot, authority);
    } catch {
      throw identityFailure(
        "authority request binding",
        requestSnapshot.runId,
        "unchanged",
      );
    }
    const raw = await this.#dispatch(
      (signal) => this.#client.acquire(wire, signal),
      "acquire transport",
      requestSnapshot.runId,
    );
    const publishedError = safePublishedAutomationError(raw);
    if (publishedError !== null) {
      const correlated =
        publishedError.operation === "lease-acquire" &&
        publishedError.client_request_id === wire.client_request_id;
      throw identityFailure(
        "acquisition refusal",
        requestSnapshot.runId,
        correlated ? "unchanged" : undefined,
      );
    }
    const published = safePublishedLease(raw);
    if (published === null) {
      throw identityFailure(
        "acquire response validation",
        requestSnapshot.runId,
      );
    }
    if (published.status !== "active") {
      if (
        published.status === "renewing" &&
        this.#hasAcquisitionCleanupAuthority(published, wire, authority)
      ) {
        await this.#retirePublishedOrFail(
          published,
          requestSnapshot,
          wire.client_request_id,
          wire.requested_ttl_seconds,
          "ctxlane returned non-active acquisition authority",
          "acquisition non-active response",
        );
        throw identityFailure(
          "acquisition non-active response",
          requestSnapshot.runId,
          "retired",
        );
      }
      const terminal =
        ["closed", "revoked", "expired", "refused"].includes(
          published.status,
        ) && this.#hasAcquisitionCleanupAuthority(published, wire, authority);
      throw identityFailure(
        "acquisition not active",
        requestSnapshot.runId,
        terminal ? "unchanged" : undefined,
      );
    }

    let lease: CtxlaneProviderIdentityLease;
    try {
      this.#assertAcquireBinding(
        published,
        wire,
        authority,
        requestSnapshot.runId,
      );
      this.#assertAcquiredTimes(published, wire, requestSnapshot.runId);
      lease = freezeIdentityLease(
        published,
        requestSnapshot,
        wire.client_request_id,
        wire.requested_ttl_seconds,
      );
      validateLeaseSnapshot(lease);
    } catch {
      if (!this.#hasAcquisitionCleanupAuthority(published, wire, authority)) {
        throw identityFailure(
          "acquisition invalid binding outside cleanup authority",
          requestSnapshot.runId,
        );
      }
      await this.#retirePublishedOrFail(
        published,
        requestSnapshot,
        wire.client_request_id,
        wire.requested_ttl_seconds,
        "ctxlane returned an invalid identity acquisition binding",
        "acquisition invalid binding",
      );
      throw identityFailure(
        "acquisition invalid binding",
        requestSnapshot.runId,
        "retired",
      );
    }
    await this.#assertCurrentOrRevoke(lease, "acquisition");
    return lease;
  }

  async renew(lease: IdentityLease): Promise<IdentityLease> {
    let current: CtxlaneProviderIdentityLease;
    let ttlSeconds: number;
    try {
      current = validateLeaseSnapshot(lease);
      this.#assertActive(current, "renewal");
      ttlSeconds = requestedTtlSeconds(current);
      await this.#assertCurrent(current, "renewal");
    } catch {
      throw identityFailure("renewal precondition", undefined, "unchanged");
    }
    const renewalStartedAtMs = this.#clock.now().getTime();
    if (!Number.isFinite(renewalStartedAtMs)) {
      throw identityFailure("renewal clock", current.runId, "unchanged");
    }
    const raw = await this.#dispatch(
      (signal) =>
        this.#lifecycleClient.renew(
          { lease: current, requestedTtlSeconds: ttlSeconds },
          signal,
        ),
      "renewal transport",
      current.runId,
    );
    const published = this.#requireLifecycleLease(
      raw,
      "renewal",
      current.runId,
    );
    if (
      isRetiredLifecycleStatus(published.status) &&
      this.#hasLifecycleCleanupAuthority(published, current)
    ) {
      throw identityFailure(
        "renewal returned terminal authority",
        current.runId,
        "retired",
      );
    }
    const renewalObservedAtMs = this.#clock.now().getTime();
    let renewed: CtxlaneProviderIdentityLease;
    try {
      this.#assertRenewalBinding(published, current);
      if (
        !Number.isFinite(renewalObservedAtMs) ||
        renewalObservedAtMs < renewalStartedAtMs - this.#maximumClockSkewMs ||
        published.execution_handle !== current.executionHandle ||
        published.fencing_generation === null ||
        current.ctxlane.fencingGeneration === null ||
        published.fencing_generation !==
          current.ctxlane.fencingGeneration + 1 ||
        published.expires_at === null ||
        !isStrictlyBeforeUtc(current.expiresAt, published.expires_at) ||
        utcTimestampOrderKey(published.expires_at) <=
          exactMilliseconds(renewalObservedAtMs) ||
        utcTimestampOrderKey(published.expires_at) >
          exactMilliseconds(
            renewalObservedAtMs + ttlSeconds * 1_000 + this.#maximumClockSkewMs,
          )
      ) {
        throw identityFailure("renewal binding", current.runId);
      }
      renewed = freezeIdentityLease(
        published,
        {
          policyDigest: current.policyDigest,
          fencingGeneration: current.fencingGeneration,
        },
        current.ctxlane.clientRequestId,
        current.ctxlane.requestedTtlSeconds,
      );
      this.#assertActive(renewed, "renewal");
    } catch {
      if (
        (published.status === "active" || published.status === "renewing") &&
        this.#hasLifecycleCleanupAuthority(published, current)
      ) {
        await this.#retirePublishedOrFail(
          published,
          current,
          current.ctxlane.clientRequestId,
          current.ctxlane.requestedTtlSeconds,
          "ctxlane returned an invalid identity renewal binding",
          "renewal invalid binding",
        );
      } else {
        try {
          await this.#revokeValidated(
            current,
            "ctxlane returned an invalid identity renewal binding",
          );
        } catch {
          throw identityFailure(
            "renewal invalid binding with unresolved revocation",
            current.runId,
          );
        }
      }
      throw identityFailure(
        "renewal invalid binding",
        current.runId,
        "retired",
      );
    }
    await this.#assertCurrentOrRevoke(renewed, "renewal");
    return renewed;
  }

  async close(
    lease: IdentityLease,
    disposition: LeaseDisposition,
  ): Promise<void> {
    let current: CtxlaneProviderIdentityLease;
    try {
      current = validateLeaseSnapshot(lease);
    } catch {
      throw identityFailure("close precondition", undefined, "unchanged");
    }
    if (!(LEASE_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw identityFailure("close validation", current.runId, "unchanged");
    }
    if (disposition === "cancelled" || disposition === "refused") {
      await this.#revokeValidated(current, `runmill-${disposition}`);
      return;
    }
    const expectedReason =
      disposition === "completed" ? "completed" : "worker-failed";
    const raw = await this.#dispatch(
      (signal) =>
        this.#lifecycleClient.close(
          { lease: current, disposition: expectedReason },
          signal,
        ),
      "close transport",
      current.runId,
    );
    const published = this.#requireLifecycleLease(raw, "close", current.runId);
    if (
      isRetiredLifecycleStatus(published.status) &&
      this.#hasLifecycleCleanupAuthority(published, current)
    ) {
      if (
        published.status === "closed" &&
        published.reason_code === expectedReason
      ) {
        return;
      }
      throw identityFailure(
        "close returned another terminal outcome",
        current.runId,
        "retired",
      );
    }
    this.#assertLifecycleBinding(published, current, "closed");
  }

  async revoke(lease: IdentityLease, reason: string): Promise<void> {
    let current: CtxlaneProviderIdentityLease;
    try {
      current = validateLeaseSnapshot(lease);
    } catch {
      throw identityFailure("revocation precondition", undefined, "unchanged");
    }
    if (
      typeof reason !== "string" ||
      reason.trim() === "" ||
      reason.trim() !== reason ||
      reason.length > 1_024 ||
      CONTROL_CHARACTER_PATTERN.test(reason) ||
      reason.includes(current.leaseId) ||
      reason.includes(current.executionHandle)
    ) {
      throw identityFailure(
        "revocation validation",
        current.runId,
        "unchanged",
      );
    }
    await this.#revokeValidated(current, reason);
  }

  #assertAuthorityIntent(
    authority: CtxlaneAcquisitionAuthority,
    request: IdentityLeaseRequest,
  ): void {
    try {
      if (
        authority === null ||
        typeof authority !== "object" ||
        authority.profileRef !== request.requestedProfile ||
        authority.intent === null ||
        typeof authority.intent !== "object" ||
        authority.intent.clientRequestId !== authority.clientRequestId ||
        authority.intent.expectedCallerSubject !==
          authority.expectedCallerSubject ||
        authority.intent.expectedHostIdentity !== authority.expectedHostIdentity
      ) {
        throw new Error("mismatch");
      }
    } catch {
      throw identityFailure("authority intent binding", request.runId);
    }
  }

  #buildAcquireRequest(
    request: IdentityLeaseRequest,
    authority: CtxlaneAcquisitionAuthority,
  ): CtxlaneIdentityLeaseRequest {
    let parsed: z.ZodSafeParseResult<CtxlaneIdentityLeaseRequest>;
    try {
      parsed = ctxlaneIdentityLeaseRequestSchema.safeParse({
        schema: CTXLANE_IDENTITY_LEASE_REQUEST_SCHEMA,
        client_request_id: authority.clientRequestId,
        tenant_id: authority.tenantId,
        work_order_id: request.workOrderId,
        work_order_digest: authority.workOrderDigest,
        work_order_authorization: authority.workOrderAuthorization,
        run_id: request.runId,
        attempt_id: request.attemptId,
        role: request.role,
        provider: authority.provider,
        profile_uid: authority.profileUid,
        profile_ref: authority.profileRef,
        repository: authority.repository,
        workspace_id: authority.workspaceId,
        environment: authority.environment,
        requested_ttl_seconds: request.requestedDurationMs / 1_000,
        policy_digest: authority.ctxlanePolicyDigest,
      });
    } catch {
      throw identityFailure(
        "acquire request contract validation",
        request.runId,
      );
    }
    if (!parsed.success) {
      throw identityFailure(
        "acquire request contract validation",
        request.runId,
      );
    }
    if (!isDeepStrictEqual(authority.intent.acquisitionRequest, parsed.data)) {
      throw identityFailure("authority intent binding", request.runId);
    }
    return deepFreezeSnapshot(parsed.data);
  }

  #assertAcquireBinding(
    lease: CtxlaneIdentityLease,
    wire: CtxlaneIdentityLeaseRequest,
    authority: CtxlaneAcquisitionAuthority,
    runId: string,
  ): void {
    if (
      lease.tenant_id !== wire.tenant_id ||
      lease.work_order_id !== wire.work_order_id ||
      lease.work_order_digest !== wire.work_order_digest ||
      lease.run_id !== wire.run_id ||
      lease.attempt_id !== wire.attempt_id ||
      lease.role !== wire.role ||
      lease.provider !== wire.provider ||
      lease.profile_uid !== wire.profile_uid ||
      lease.profile_ref !== wire.profile_ref ||
      lease.repository !== wire.repository ||
      lease.workspace_id !== wire.workspace_id ||
      lease.environment !== wire.environment ||
      lease.caller_subject !== authority.expectedCallerSubject ||
      lease.host_identity !== authority.expectedHostIdentity ||
      (wire.policy_digest !== null &&
        lease.effective_policy_digest !== wire.policy_digest)
    ) {
      throw identityFailure("acquire response binding", runId);
    }
  }

  #hasAcquisitionCleanupAuthority(
    lease: CtxlaneIdentityLease,
    wire: CtxlaneIdentityLeaseRequest,
    authority: CtxlaneAcquisitionAuthority,
  ): boolean {
    return (
      lease.tenant_id === wire.tenant_id &&
      lease.work_order_id === wire.work_order_id &&
      lease.work_order_digest === wire.work_order_digest &&
      lease.run_id === wire.run_id &&
      lease.attempt_id === wire.attempt_id &&
      lease.role === wire.role &&
      lease.provider === wire.provider &&
      lease.profile_uid === wire.profile_uid &&
      lease.profile_ref === wire.profile_ref &&
      lease.repository === wire.repository &&
      lease.workspace_id === wire.workspace_id &&
      lease.environment === wire.environment &&
      lease.caller_subject === authority.expectedCallerSubject &&
      lease.host_identity === authority.expectedHostIdentity
    );
  }

  #assertAcquiredTimes(
    lease: CtxlaneIdentityLease,
    wire: CtxlaneIdentityLeaseRequest,
    runId: string,
  ): void {
    if (lease.expires_at === null || lease.maximum_expires_at === null) {
      throw identityFailure("acquire response time binding", runId);
    }
    const now = this.#clock.now().getTime();
    if (!Number.isFinite(now))
      throw identityFailure("acquire response time binding", runId);
    const nowKey = exactMilliseconds(now);
    const skew = exactMilliseconds(this.#maximumClockSkewMs);
    const issued = utcTimestampOrderKey(lease.issued_at);
    const expires = utcTimestampOrderKey(lease.expires_at);
    const maximum = utcTimestampOrderKey(lease.maximum_expires_at);
    const authorization = wire.work_order_authorization;
    const authorizationNotBefore = utcTimestampOrderKey(
      authorization.not_before,
    );
    const authorizationExpires = utcTimestampOrderKey(authorization.expires_at);
    if (
      issued > nowKey + skew ||
      issued < authorizationNotBefore - skew ||
      expires <= nowKey ||
      !isStrictlyBeforeUtc(lease.issued_at, lease.expires_at) ||
      !isAtOrBeforeUtc(lease.expires_at, lease.maximum_expires_at) ||
      expires - issued > BigInt(wire.requested_ttl_seconds) * 1_000_000_000n ||
      maximum > authorizationExpires ||
      maximum >
        issued + BigInt(authorization.maximum_session_seconds) * 1_000_000_000n
    ) {
      throw identityFailure("acquire response time binding", runId);
    }
  }

  #requireLifecycleLease(
    raw: unknown,
    stage: string,
    runId: string,
  ): CtxlaneIdentityLease {
    if (safePublishedAutomationError(raw) !== null) {
      throw identityFailure(`${stage} refusal`, runId);
    }
    const lease = safePublishedLease(raw);
    if (lease === null)
      throw identityFailure(`${stage} response validation`, runId);
    return lease;
  }

  #assertLifecycleBinding(
    published: CtxlaneIdentityLease,
    current: CtxlaneProviderIdentityLease,
    expectedStatus: "active" | "closed" | "revoked",
  ): void {
    const ctxlane = current.ctxlane;
    if (
      published.status !== expectedStatus ||
      published.lease_id !== current.leaseId ||
      published.tenant_id !== ctxlane.tenantId ||
      published.work_order_id !== current.workOrderId ||
      published.work_order_digest !== ctxlane.workOrderDigest ||
      published.run_id !== current.runId ||
      published.attempt_id !== current.attemptId ||
      published.role !== current.role ||
      published.provider !== current.provider ||
      published.profile_uid !== ctxlane.profileUid ||
      published.profile_ref !== current.profile ||
      published.repository !== ctxlane.repository ||
      published.workspace_id !== ctxlane.workspaceId ||
      published.environment !== ctxlane.environment ||
      published.caller_subject !== ctxlane.callerSubject ||
      published.host_identity !== ctxlane.hostIdentity ||
      published.worker_identity !== ctxlane.workerIdentity ||
      published.principal_ref !== current.principal ||
      published.workspace_ref !== ctxlane.workspaceRef ||
      published.auth_mode !== ctxlane.authMode ||
      published.isolation !== ctxlane.isolation ||
      published.issued_at !== current.issuedAt ||
      published.maximum_expires_at !== ctxlane.maximumExpiresAt ||
      published.effective_policy_digest !== ctxlane.effectivePolicyDigest ||
      published.fencing_generation === null ||
      ctxlane.fencingGeneration === null ||
      (expectedStatus !== "active" &&
        published.fencing_generation !== ctxlane.fencingGeneration)
    ) {
      throw identityFailure(
        `${expectedStatus} lifecycle binding`,
        current.runId,
      );
    }
  }

  #assertRenewalBinding(
    published: CtxlaneIdentityLease,
    current: CtxlaneProviderIdentityLease,
  ): void {
    const ctxlane = current.ctxlane;
    if (
      published.status !== "active" ||
      published.lease_id !== current.leaseId ||
      published.tenant_id !== ctxlane.tenantId ||
      published.work_order_id !== current.workOrderId ||
      published.work_order_digest !== ctxlane.workOrderDigest ||
      published.run_id !== current.runId ||
      published.attempt_id !== current.attemptId ||
      published.role !== current.role ||
      published.provider !== current.provider ||
      published.profile_uid !== ctxlane.profileUid ||
      published.profile_ref !== current.profile ||
      published.repository !== ctxlane.repository ||
      published.workspace_id !== ctxlane.workspaceId ||
      published.environment !== ctxlane.environment ||
      published.caller_subject !== ctxlane.callerSubject ||
      published.host_identity !== ctxlane.hostIdentity ||
      published.worker_identity !== ctxlane.workerIdentity ||
      published.principal_ref !== current.principal ||
      published.workspace_ref !== ctxlane.workspaceRef ||
      published.auth_mode !== ctxlane.authMode ||
      published.isolation !== ctxlane.isolation ||
      published.issued_at !== current.issuedAt ||
      published.maximum_expires_at === null ||
      ctxlane.maximumExpiresAt === null ||
      !isAtOrBeforeUtc(
        published.maximum_expires_at,
        ctxlane.maximumExpiresAt,
      ) ||
      published.effective_policy_digest === null
    ) {
      throw identityFailure("active renewal binding", current.runId);
    }
  }

  #hasLifecycleCleanupAuthority(
    published: CtxlaneIdentityLease,
    current: CtxlaneProviderIdentityLease,
  ): boolean {
    const ctxlane = current.ctxlane;
    return (
      published.lease_id === current.leaseId &&
      published.tenant_id === ctxlane.tenantId &&
      published.work_order_id === current.workOrderId &&
      published.work_order_digest === ctxlane.workOrderDigest &&
      published.run_id === current.runId &&
      published.attempt_id === current.attemptId &&
      published.role === current.role &&
      published.provider === current.provider &&
      published.profile_uid === ctxlane.profileUid &&
      published.profile_ref === current.profile &&
      published.repository === ctxlane.repository &&
      published.workspace_id === ctxlane.workspaceId &&
      published.environment === ctxlane.environment &&
      published.caller_subject === ctxlane.callerSubject &&
      published.host_identity === ctxlane.hostIdentity &&
      published.worker_identity === ctxlane.workerIdentity &&
      published.principal_ref === current.principal &&
      published.workspace_ref === ctxlane.workspaceRef &&
      published.auth_mode === ctxlane.authMode &&
      published.isolation === ctxlane.isolation &&
      published.issued_at === current.issuedAt
    );
  }

  #assertActive(lease: CtxlaneProviderIdentityLease, stage: string): void {
    const now = this.#clock.now().getTime();
    if (
      lease.ctxlane.status !== "active" ||
      !Number.isFinite(now) ||
      utcTimestampOrderKey(lease.issuedAt) >
        exactMilliseconds(now + this.#maximumClockSkewMs) ||
      utcTimestampOrderKey(lease.expiresAt) <= exactMilliseconds(now) ||
      !isStrictlyBeforeUtc(lease.issuedAt, lease.expiresAt)
    ) {
      throw identityFailure(`${stage} inactive lease`, lease.runId);
    }
  }

  async #revokeValidated(
    lease: CtxlaneProviderIdentityLease,
    reason: string,
  ): Promise<void> {
    const raw = await this.#dispatch(
      (signal) => this.#lifecycleClient.revoke({ lease, reason }, signal),
      "revoke transport",
      lease.runId,
    );
    const published = this.#requireLifecycleLease(raw, "revoke", lease.runId);
    if (
      isRetiredLifecycleStatus(published.status) &&
      this.#hasLifecycleCleanupAuthority(published, lease)
    ) {
      return;
    }
    this.#assertLifecycleBinding(published, lease, "revoked");
  }

  async #retirePublishedOrFail(
    published: CtxlaneIdentityLease,
    binding: Pick<
      IdentityLeaseRequest,
      "policyDigest" | "fencingGeneration" | "runId"
    >,
    clientRequestId: string,
    originalRequestedTtlSeconds: number,
    reason: string,
    stage: string,
  ): Promise<void> {
    let lease: CtxlaneProviderIdentityLease;
    try {
      lease = freezeIdentityLease(
        published,
        binding,
        clientRequestId,
        originalRequestedTtlSeconds,
      );
    } catch {
      throw identityFailure(
        `${stage} with unresolved revocation`,
        binding.runId,
      );
    }
    try {
      await this.#revokeValidated(lease, reason);
    } catch {
      throw identityFailure(
        `${stage} with unresolved revocation`,
        binding.runId,
      );
    }
  }

  async #assertCurrent(
    binding: IdentityLease | IdentityLeaseRequest,
    stage: string,
  ): Promise<void> {
    let current = false;
    try {
      current =
        (await this.#ownershipFence.isCurrent(
          identityOwnershipFenceFor(binding),
        )) === true;
    } catch {
      current = false;
    }
    if (!current)
      throw identityFailure(`${stage} ownership fence`, binding.runId);
  }

  async #assertCurrentOrRevoke(
    lease: CtxlaneProviderIdentityLease,
    stage: string,
  ): Promise<void> {
    try {
      await this.#assertCurrent(lease, stage);
    } catch {
      try {
        await this.#revokeValidated(
          lease,
          `fencing generation changed during identity ${stage}`,
        );
      } catch {
        throw identityFailure(
          `${stage} fence loss with unresolved revocation`,
          lease.runId,
        );
      }
      throw identityFailure(`${stage} fence loss`, lease.runId, "retired");
    }
  }

  async #dispatch(
    invoke: (signal: AbortSignal) => Promise<unknown>,
    stage: string,
    runId: string,
  ): Promise<unknown> {
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const abortController = new AbortController();
        let settled = false;
        const finish = (error: unknown, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error === undefined) resolve(value);
          else reject(new Error("ctxlane operation failed"));
        };
        const deadline = setTimeout(() => {
          abortController.abort();
          finish(new Error("timeout"));
        }, this.#requestTimeoutMs);
        void Promise.resolve()
          .then(() => invoke(abortController.signal))
          .then(
            (value) => finish(undefined, value),
            (error: unknown) => finish(error),
          );
      });
    } catch {
      throw identityFailure(stage, runId);
    }
  }
}
