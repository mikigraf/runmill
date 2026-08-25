import {
  CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
  ctxlaneIdentityLeaseInspectSchema,
  ctxlaneIdentityLeaseSchema,
  type CtxlaneAutomationError,
  type CtxlaneIdentityLease,
  type CtxlaneIdentityLeaseInspect,
  type CtxlaneIdentityLeaseLifecyclePrivateResponse,
  type CtxlaneLeaseView,
} from "./ctxlane-contracts.js";
import type {
  CtxlaneLeaseCloseRequest,
  CtxlaneLeaseLifecycleClient,
  CtxlaneLeaseRenewalRequest,
  CtxlaneLeaseRevocationRequest,
  CtxlaneProviderIdentityLease,
} from "./ctxlane-broker.js";
import {
  CtxlanePrivateLifecycleClient,
  type CtxlanePrivateLifecycleExchange,
} from "./ctxlane-private-lifecycle.js";
import { CtxlaneIdentityProtocolError } from "./ctxlane-transport.js";

/**
 * Authenticated lifecycle exchange supplied by a local ctxlane deployment.
 *
 * This is intentionally a record-level seam.  It does not accept a socket
 * path, a bearer token, a provider credential, or an unauthenticated MCP
 * callback.  The deployment is responsible for binding the exchange to the
 * already-authenticated local channel; this adapter only turns the broker's
 * protected lease into the exact private lifecycle envelope and validates the
 * response through {@link CtxlanePrivateLifecycleClient}.
 */
export type CtxlaneAuthenticatedLifecycleExchange =
  CtxlanePrivateLifecycleExchange;

const PRIVATE_REVOCATION_REASONS = new Set([
  "operator-revoked",
  "policy-revoked",
  "principal-mismatch",
  "heartbeat-lost",
  "process-unverifiable",
  "generation-superseded",
  "renewal-acknowledgement-failed",
  "service-recovery",
  "internal-error",
] as const);

type PrivateRevocationReason =
  | "operator-revoked"
  | "policy-revoked"
  | "principal-mismatch"
  | "heartbeat-lost"
  | "process-unverifiable"
  | "generation-superseded"
  | "renewal-acknowledgement-failed"
  | "service-recovery"
  | "internal-error";

function protocolFailure(message: string): CtxlaneIdentityProtocolError {
  return new CtxlaneIdentityProtocolError(`ctxlane authenticated lifecycle ${message}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Translate Runmill's opaque protected lease back to the exact ctxlane lease
 * object required by the authenticated private lifecycle wire.  This is the
 * only place in Runmill where the private execution capability is serialized.
 */
function privateLeaseFor(
  lease: CtxlaneProviderIdentityLease,
): CtxlaneIdentityLease {
  const attribution = lease.ctxlane;
  if (attribution === undefined) throw protocolFailure("lease attribution missing");
  const parsed = ctxlaneIdentityLeaseSchema.safeParse({
    schema: "ctxlane.identity-lease/v1",
    lease_id: lease.leaseId,
    status: attribution.status,
    tenant_id: attribution.tenantId,
    work_order_id: lease.workOrderId,
    work_order_digest: attribution.workOrderDigest,
    run_id: lease.runId,
    attempt_id: lease.attemptId,
    role: lease.role,
    provider: lease.provider,
    profile_uid: attribution.profileUid,
    profile_ref: lease.profile,
    repository: attribution.repository,
    workspace_id: attribution.workspaceId,
    environment: attribution.environment,
    caller_subject: attribution.callerSubject,
    host_identity: attribution.hostIdentity,
    worker_identity: attribution.workerIdentity,
    principal_ref: lease.principal,
    workspace_ref: attribution.workspaceRef,
    auth_mode: attribution.authMode,
    fencing_generation: attribution.fencingGeneration,
    issued_at: lease.issuedAt,
    expires_at: lease.expiresAt,
    maximum_expires_at: attribution.maximumExpiresAt,
    execution_handle: lease.executionHandle,
    isolation: attribution.isolation,
    effective_policy_digest: attribution.effectivePolicyDigest,
    refusal_code: null,
    reason_code: null,
  });
  if (!parsed.success) throw protocolFailure("lease attribution failed contract validation");
  return parsed.data;
}

function privateReason(reason: string): PrivateRevocationReason {
  if (PRIVATE_REVOCATION_REASONS.has(reason as PrivateRevocationReason)) {
    return reason as PrivateRevocationReason;
  }
  // Runmill's broker deliberately permits an internal descriptive reason so
  // it can classify failures without exposing them.  The private wire has a
  // closed reason enum; unknown internal causes are conservatively collapsed
  // to the non-disclosing terminal reason.
  return "internal-error";
}

function unwrap(
  response: CtxlaneIdentityLeaseLifecyclePrivateResponse,
): CtxlaneIdentityLease | CtxlaneAutomationError {
  if (response.result.kind === "error") return response.result.error;
  // Preserve the service's renewing state.  It is part of the authenticated
  // lease binding and must be sent back on the next private close/revoke or
  // renewal request; promoting it to active here would make the following
  // server-side current-row comparison fail closed.
  return clone(response.result.lease);
}

/**
 * Concrete transport-neutral bridge between the authenticated private
 * lifecycle adapter and Runmill's provider identity broker.
 *
 * `inspect` remains capability-free and is exposed separately for callers
 * that need a public MCP lease view.  Renew/revoke/close are sent only over
 * the injected authenticated private exchange; there is no public-MCP
 * fallback that could promote a lease view into execution authority.
 */
export class CtxlaneAuthenticatedMcpLifecycleClient
  implements CtxlaneLeaseLifecycleClient
{
  readonly #privateClient: CtxlanePrivateLifecycleClient;

  constructor(exchange: CtxlaneAuthenticatedLifecycleExchange) {
    this.#privateClient = new CtxlanePrivateLifecycleClient(exchange);
  }

  async inspect(request: CtxlaneIdentityLeaseInspect): Promise<CtxlaneLeaseView> {
    const parsed = ctxlaneIdentityLeaseInspectSchema.safeParse(request);
    if (!parsed.success) throw protocolFailure("inspect request failed contract validation");
    return this.#privateClient.inspect(parsed.data);
  }

  async renew(request: CtxlaneLeaseRenewalRequest): Promise<unknown> {
    const lease = privateLeaseFor(request.lease);
    const response = await this.#privateClient.renew({
      schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
      operation: "renew",
      client_request_id: request.lease.ctxlane?.clientRequestId ?? "",
      lease,
      requested_ttl_seconds: request.requestedTtlSeconds,
    });
    return unwrap(response);
  }

  async close(request: CtxlaneLeaseCloseRequest): Promise<unknown> {
    const lease = privateLeaseFor(request.lease);
    const response = await this.#privateClient.close({
      schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
      operation: "close",
      client_request_id: request.lease.ctxlane?.clientRequestId ?? "",
      lease,
      reason: request.disposition,
    });
    return unwrap(response);
  }

  async revoke(request: CtxlaneLeaseRevocationRequest): Promise<unknown> {
    const lease = privateLeaseFor(request.lease);
    const response = await this.#privateClient.revoke({
      schema: CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA,
      operation: "revoke",
      client_request_id: request.lease.ctxlane?.clientRequestId ?? "",
      lease,
      reason: privateReason(request.reason),
    });
    return unwrap(response);
  }
}
