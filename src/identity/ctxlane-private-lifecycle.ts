import {
  ctxlaneIdentityLeaseInspectSchema,
  ctxlaneLeaseViewSchema,
  parseCtxlaneIdentityLeaseLifecyclePrivateRequest,
  parseCtxlaneIdentityLeaseLifecyclePrivateResponse,
  type CtxlaneIdentityLease,
  type CtxlaneIdentityLeaseInspect,
  type CtxlaneIdentityLeaseLifecyclePrivateOperation,
  type CtxlaneIdentityLeaseLifecyclePrivateRequest,
  type CtxlaneIdentityLeaseLifecyclePrivateResponse,
  type CtxlaneIdentityLeaseLifecyclePrivateReason,
  type CtxlaneLeaseView,
} from "./ctxlane-contracts.js";
import { CtxlaneIdentityProtocolError } from "./ctxlane-transport.js";

/**
 * The transport-neutral seam for the authenticated private lifecycle channel.
 *
 * This interface deliberately contains no endpoint, socket, framing, or peer
 * policy.  A qualified deployment may provide it later; this adapter only
 * validates the exact published request/response contracts and their binding.
 * Inspection is kept on the separately published capability-free contract:
 * ctxlane has no private inspect envelope to consume here.
 */
export interface CtxlanePrivateLifecycleExchange {
  privateLifecycle(
    request: CtxlaneIdentityLeaseLifecyclePrivateRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
  inspect(
    request: CtxlaneIdentityLeaseInspect,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const PRIVATE_OPERATION_ERROR_OPERATION: Record<
  CtxlaneIdentityLeaseLifecyclePrivateOperation,
  "lease-renew" | "lease-revoke" | "lease-close"
> = {
  renew: "lease-renew",
  revoke: "lease-revoke",
  close: "lease-close",
};

const PRIVATE_REVOCATION_REASONS: ReadonlySet<
  CtxlaneIdentityLeaseLifecyclePrivateReason
> = new Set([
  "operator-revoked",
  "policy-revoked",
  "principal-mismatch",
  "heartbeat-lost",
  "process-unverifiable",
  "generation-superseded",
  "renewal-acknowledgement-failed",
  "service-recovery",
  "internal-error",
]);

function contractFailure(message: string): CtxlaneIdentityProtocolError {
  return new CtxlaneIdentityProtocolError(`ctxlane private lifecycle ${message}`);
}

function parsePrivateRequest(raw: unknown): CtxlaneIdentityLeaseLifecyclePrivateRequest {
  try {
    return parseCtxlaneIdentityLeaseLifecyclePrivateRequest(raw);
  } catch {
    throw contractFailure("request failed contract validation");
  }
}

function parsePrivateResponse(raw: unknown): CtxlaneIdentityLeaseLifecyclePrivateResponse {
  try {
    return parseCtxlaneIdentityLeaseLifecyclePrivateResponse(raw);
  } catch {
    throw contractFailure("response failed contract validation");
  }
}

function sameLeaseBinding(
  left: CtxlaneIdentityLease,
  right: CtxlaneIdentityLease,
): boolean {
  return (
    left.lease_id === right.lease_id &&
    left.tenant_id === right.tenant_id &&
    left.work_order_id === right.work_order_id &&
    left.work_order_digest === right.work_order_digest &&
    left.run_id === right.run_id &&
    left.attempt_id === right.attempt_id &&
    left.role === right.role &&
    left.provider === right.provider &&
    left.profile_uid === right.profile_uid &&
    left.profile_ref === right.profile_ref &&
    left.repository === right.repository &&
    left.workspace_id === right.workspace_id &&
    left.environment === right.environment &&
    left.caller_subject === right.caller_subject &&
    left.host_identity === right.host_identity
  );
}

function revokeStatusAcceptsReason(
  status: CtxlaneIdentityLease["status"],
  reason: CtxlaneIdentityLeaseLifecyclePrivateReason,
): boolean {
  switch (reason) {
    case "internal-error":
      return status === "error";
    case "process-unverifiable":
    case "service-recovery":
      return status === "revoked" || status === "error";
    case "operator-revoked":
    case "policy-revoked":
    case "principal-mismatch":
    case "heartbeat-lost":
    case "generation-superseded":
    case "renewal-acknowledgement-failed":
      return status === "revoked";
    case "completed":
    case "worker-failed":
      return false;
  }
}

function assertPrivateOperation(
  request: CtxlaneIdentityLeaseLifecyclePrivateRequest,
  expected: CtxlaneIdentityLeaseLifecyclePrivateOperation,
): void {
  if (request.operation !== expected) {
    throw contractFailure(`${expected} request has the wrong operation`);
  }
}

/**
 * Validate a private mutation response against the exact request that caused
 * it.  The schema validator proves shape; this function proves correlation,
 * immutable lease binding, and operation-specific state transitions.
 */
export function validateCtxlanePrivateLifecycleResponse(
  request: unknown,
  rawResponse: unknown,
): CtxlaneIdentityLeaseLifecyclePrivateResponse {
  const parsedRequest = parsePrivateRequest(request);
  const response = parsePrivateResponse(rawResponse);

  if (
    response.operation !== parsedRequest.operation ||
    response.client_request_id !== parsedRequest.client_request_id
  ) {
    throw contractFailure("response correlation does not match the request");
  }

  if (response.result.kind === "error") {
    const error = response.result.error;
    if (
      error.operation !== PRIVATE_OPERATION_ERROR_OPERATION[parsedRequest.operation] ||
      error.client_request_id !== parsedRequest.client_request_id ||
      (error.lease_id !== null && error.lease_id !== parsedRequest.lease.lease_id)
    ) {
      throw contractFailure("error result is not correlated to the request");
    }
    return response;
  }

  const lease = response.result.lease;
  if (!sameLeaseBinding(lease, parsedRequest.lease)) {
    throw contractFailure("response lease binding does not match the request");
  }

  switch (parsedRequest.operation) {
    case "renew": {
      const oldGeneration = parsedRequest.lease.fencing_generation;
      const newGeneration = lease.fencing_generation;
      if (
        lease.status !== "renewing" ||
        lease.execution_handle !== parsedRequest.lease.execution_handle ||
        oldGeneration === null ||
        newGeneration === null ||
        newGeneration <= oldGeneration
      ) {
        throw contractFailure(
          "renew response has an incompatible active/renewing state or generation",
        );
      }
      break;
    }
    case "revoke": {
      const reason = parsedRequest.reason;
      if (
        reason === undefined ||
        !PRIVATE_REVOCATION_REASONS.has(reason) ||
        lease.reason_code !== reason ||
        !revokeStatusAcceptsReason(lease.status, reason)
      ) {
        throw contractFailure("revoke response reason or terminal state is incompatible");
      }
      break;
    }
    case "close":
      if (
        lease.status !== "closed" ||
        lease.reason_code !== parsedRequest.reason
      ) {
        throw contractFailure("close response reason or terminal state is incompatible");
      }
      break;
  }

  return response;
}

/**
 * Validate the published capability-free inspection receipt.  It intentionally
 * returns only `ctxlane.lease-view/v1`; execution handles and fencing
 * generations are not part of this contract and cannot be smuggled through it.
 */
export function validateCtxlaneIdentityLeaseInspectResponse(
  request: unknown,
  rawResponse: unknown,
): CtxlaneLeaseView {
  let parsedRequest: CtxlaneIdentityLeaseInspect;
  try {
    const parsed = ctxlaneIdentityLeaseInspectSchema.safeParse(request);
    if (!parsed.success) throw new Error("invalid request");
    parsedRequest = parsed.data;
  } catch {
    throw contractFailure("inspect request failed contract validation");
  }

  let view: CtxlaneLeaseView;
  try {
    const parsed = ctxlaneLeaseViewSchema.safeParse(rawResponse);
    if (!parsed.success) throw new Error("invalid response");
    view = parsed.data;
  } catch {
    throw contractFailure("inspect response failed contract validation");
  }
  if (view.lease_id !== parsedRequest.lease_id) {
    throw contractFailure("inspect response lease binding does not match the request");
  }
  return view;
}

/**
 * Pure private lifecycle client.  It delegates bytes/records to an injected
 * exchange and performs no socket, network, process, or retry behavior.
 */
export class CtxlanePrivateLifecycleClient {
  readonly #exchange: CtxlanePrivateLifecycleExchange;

  constructor(exchange: CtxlanePrivateLifecycleExchange) {
    if (
      exchange === null ||
      typeof exchange !== "object" ||
      typeof exchange.privateLifecycle !== "function" ||
      typeof exchange.inspect !== "function"
    ) {
      throw contractFailure("exchange is incomplete");
    }
    this.#exchange = exchange;
  }

  renew(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<CtxlaneIdentityLeaseLifecyclePrivateResponse> {
    return this.#mutate("renew", request, signal);
  }

  revoke(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<CtxlaneIdentityLeaseLifecyclePrivateResponse> {
    return this.#mutate("revoke", request, signal);
  }

  close(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<CtxlaneIdentityLeaseLifecyclePrivateResponse> {
    return this.#mutate("close", request, signal);
  }

  async inspect(request: unknown, signal?: AbortSignal): Promise<CtxlaneLeaseView> {
    let parsedRequest: CtxlaneIdentityLeaseInspect;
    try {
      const parsed = ctxlaneIdentityLeaseInspectSchema.safeParse(request);
      if (!parsed.success) throw new Error("invalid request");
      parsedRequest = parsed.data;
    } catch {
      throw contractFailure("inspect request failed contract validation");
    }
    const rawResponse = await this.#exchange.inspect(parsedRequest, signal);
    return validateCtxlaneIdentityLeaseInspectResponse(parsedRequest, rawResponse);
  }

  async #mutate(
    operation: CtxlaneIdentityLeaseLifecyclePrivateOperation,
    rawRequest: unknown,
    signal?: AbortSignal,
  ): Promise<CtxlaneIdentityLeaseLifecyclePrivateResponse> {
    const request = parsePrivateRequest(rawRequest);
    assertPrivateOperation(request, operation);
    const rawResponse = await this.#exchange.privateLifecycle(request, signal);
    return validateCtxlanePrivateLifecycleResponse(request, rawResponse);
  }
}

export type {
  CtxlaneIdentityLeaseLifecyclePrivateRequest,
  CtxlaneIdentityLeaseLifecyclePrivateResponse,
};
