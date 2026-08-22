import type { IdentityLeaseRequest } from "./broker.js";
import type {
  CtxlaneIdentityLeaseRequest,
  CtxlaneProvider,
  CtxlaneWorkOrderAuthorization,
} from "./ctxlane-contracts.js";

/**
 * Durable binding from a stable `client_request_id` to the complete canonical
 * acquisition request and authenticated transport identity it was first
 * resolved for.
 *
 * ctxlane treats `client_request_id` as a service-global idempotency/replay
 * key (see `test/fixtures/ctxlane/PROVENANCE.md` and the vendored schema
 * README): an exact retry of the same request may reuse it safely, but reuse
 * with any changed request, caller, or host coordinate must never be resolved
 * silently. A `CtxlaneAcquisitionAuthorityResolver` implementation is
 * obligated to:
 *
 * 1. Record this coordinate in durable state the first time a given
 *    `client_request_id` is resolved.
 * 2. On every later resolution attempt with the same `client_request_id`,
 *    compare the complete durably recorded request and authenticated caller/
 *    host binding against the acquisition being resolved now, and refuse
 *    (throw, never silently rebind or widen) on any mismatch.
 * 3. Never synthesize a coordinate from repository-controlled or
 *    candidate-controlled input; every field must come from durable,
 *    operator-approved, or immutable admitted-Work-Order state.
 *
 * `CtxlaneProviderIdentityBroker` also independently checks this coordinate
 * against the `IdentityLeaseRequest` it was given, so a resolver that
 * returns an authority whose `intent` does not match the request in hand is
 * refused even if the resolver itself failed to enforce obligation 2.
 */
export interface CtxlaneAcquisitionIntentCoordinate {
  readonly clientRequestId: string;
  readonly acquisitionRequest: CtxlaneIdentityLeaseRequest;
  readonly expectedCallerSubject: string;
  readonly expectedHostIdentity: string;
}

/**
 * The ctxlane-specific coordinates Runmill's internal {@link IdentityLeaseRequest}
 * does not carry: the durable acquisition intent binding, operator-approved
 * profile identity, the signed work-order authorization envelope, the
 * immutable admitted Work Order coordinates ctxlane requires on every lease
 * request, the authenticated caller/host ctxlane is expected to bind the
 * lease to, and ctxlane's own (never Runmill's) policy equality
 * expectation.
 *
 * A resolver implementation must source every field from durable,
 * operator-approved, or immutable admitted-Work-Order state. None of these
 * fields may be derived from repository-controlled or candidate-controlled
 * input; doing so would let a repository widen its own operator authority,
 * which `CtxlaneProviderIdentityBroker` and the vendored contract both
 * refuse to accept without also rejecting the request.
 */
export interface CtxlaneAcquisitionAuthority {
  readonly intent: CtxlaneAcquisitionIntentCoordinate;
  /** Service-global idempotency/replay key for this exact request. */
  readonly clientRequestId: string;
  readonly tenantId: string;
  readonly workOrderDigest: string;
  /** Fully signed; this broker does not sign work orders. */
  readonly workOrderAuthorization: CtxlaneWorkOrderAuthorization;
  readonly provider: CtxlaneProvider;
  /** Immutable profile identity; never resolved from a display alias alone. */
  readonly profileUid: string;
  readonly profileRef: string;
  readonly repository: string;
  readonly workspaceId: string;
  readonly environment: string;
  /**
   * The authenticated caller and host ctxlane is expected to bind the
   * resolved lease to. Never derived from the lease response itself: the
   * broker asserts the response echoes exactly these values.
   */
  readonly expectedCallerSubject: string;
  readonly expectedHostIdentity: string;
  /**
   * ctxlane's own `policy_digest` equality expectation, or `null` for no
   * precondition. This is a distinct field from Runmill's own
   * `IdentityLeaseRequest.policyDigest`: the two digests cover different
   * domains, and a resolver must never copy one into the other
   * automatically. `null` here means "no ctxlane-side equality
   * precondition", not "no policy".
   */
  readonly ctxlanePolicyDigest: string | null;
}

/**
 * The smallest seam a trusted controller (the ASF identity lifecycle, or any
 * other operator-owned composition) needs to supply in order for
 * {@link CtxlaneProviderIdentityBroker} to build a strict
 * `ctxlane.identity-lease-request/v1` object. Runmill's own durable
 * ownership fence (`IdentityLeaseRequest.fencingGeneration`) is
 * intentionally excluded: it is never sent to ctxlane, and the lease
 * returned by ctxlane carries its own, unrelated `fencing_generation`.
 */
export interface CtxlaneAcquisitionAuthorityResolver {
  resolveAcquisitionAuthority(
    request: IdentityLeaseRequest,
  ): CtxlaneAcquisitionAuthority | Promise<CtxlaneAcquisitionAuthority>;
}
