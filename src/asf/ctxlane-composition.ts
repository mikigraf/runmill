import type { Clock } from "../platform/clock.js";
import type {
  IdentityOwnershipFenceValidator,
  ProviderIdentityBroker,
} from "../identity/broker.js";
import {
  CtxlaneProviderIdentityBroker,
  type CtxlaneIdentityLeaseAcquisitionClient,
  type CtxlaneLeaseLifecycleClient,
} from "../identity/ctxlane-broker.js";
import type { CtxlaneAcquisitionAuthorityResolver } from "../identity/ctxlane-authority.js";
import {
  AsfIdentityLifecycleController,
  type AsfIdentityAuthorityLoss,
  type AsfIdentityLifecycleControllerOptions,
  type AsfIdentityLifecycleScheduler,
  type AsfIdentityProfileResolver,
} from "./identity-lifecycle.js";
import type { ProtectedIdentityLeaseRegistry } from "../identity/protected-lease-registry.js";
import {
  CTXLANE_NATIVE_SEQPACKET_AUTHENTICATED_TRANSPORT_QUALIFICATION,
} from "../identity/ctxlane-transport.js";

/**
 * Explicit operator-owned dependencies for the ASF/ctxlane identity seam.
 *
 * This factory intentionally does not accept a Work Order or repository
 * object. Every ctxlane coordinate (including the signed authorization and
 * profile UID) must come from the supplied authority resolver, which is the
 * only component allowed to translate an admitted binding into ctxlane's
 * contract.
 */
export interface AsfCtxlaneIdentityCompositionOptions {
  readonly client: CtxlaneIdentityLeaseAcquisitionClient;
  readonly lifecycleClient: CtxlaneLeaseLifecycleClient;
  readonly authority: CtxlaneAcquisitionAuthorityResolver;
  readonly clock: Clock;
  readonly ownershipFence: IdentityOwnershipFenceValidator;
  readonly profiles: AsfIdentityProfileResolver;
  readonly requestedDurationMs: number;
  readonly renewalLeadMs: number;
  readonly fenceCheckIntervalMs: number;
  readonly scheduler?: AsfIdentityLifecycleScheduler | undefined;
  readonly protectedLeaseRegistry?:
    | ProtectedIdentityLeaseRegistry
    | undefined;
  readonly onAuthorityLost: (
    event: AsfIdentityAuthorityLoss,
  ) => void | Promise<void>;
  readonly maximumClockSkewMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /**
   * Require the operator-qualified transport status before constructing an
   * ASF production composition.  The default remains false so deterministic
   * test and embedding seams retain their existing behavior.
   */
  readonly productionMode?: boolean | undefined;
}

/**
 * Options accepted by the sealed production composition entrypoint.
 *
 * `productionMode` is deliberately not part of this type: callers cannot
 * construct a production composition while leaving the gate unspecified or
 * setting it to false.  The entrypoint below supplies the gate internally.
 */
export type AsfCtxlaneIdentityProductionCompositionOptions = Omit<
  AsfCtxlaneIdentityCompositionOptions,
  "productionMode"
>;

export class AsfCtxlaneIdentityCompositionError extends Error {
  readonly reason:
    | "dependencies-incomplete"
    | "transport-unqualified"
    | "dependency-construction-failed";

  constructor(
    reason:
      | "dependencies-incomplete"
      | "transport-unqualified"
      | "dependency-construction-failed",
  ) {
    super(`ASF ctxlane identity composition refused: ${reason}`);
    this.name = "AsfCtxlaneIdentityCompositionError";
    this.reason = reason;
  }
}

function hasProductionQualifiedTransport(
  client: CtxlaneIdentityLeaseAcquisitionClient,
): boolean {
  try {
    return (
      client.qualification ===
      CTXLANE_NATIVE_SEQPACKET_AUTHENTICATED_TRANSPORT_QUALIFICATION
    );
  } catch {
    return false;
  }
}

function hasMethod(value: unknown, method: string): boolean {
  if (value === null || typeof value !== "object") return false;
  try {
    return typeof (value as Record<string, unknown>)[method] === "function";
  } catch {
    return false;
  }
}

function dependenciesAreComplete(
  options: AsfCtxlaneIdentityCompositionOptions,
): boolean {
  try {
    return (
      hasMethod(options.client, "acquire") &&
      hasMethod(options.lifecycleClient, "renew") &&
      hasMethod(options.lifecycleClient, "close") &&
      hasMethod(options.lifecycleClient, "revoke") &&
      hasMethod(options.authority, "resolveAcquisitionAuthority") &&
      hasMethod(options.clock, "now") &&
      hasMethod(options.ownershipFence, "isCurrent") &&
      hasMethod(options.profiles, "resolve") &&
      typeof options.onAuthorityLost === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Construct the real ctxlane-backed ASF lifecycle controller.
 *
 * The returned controller remains an ASF-only composition artifact. Nothing
 * here is imported by standalone startup, and no dependency is inferred from
 * repository-controlled input.
 */
export function createAsfCtxlaneIdentityController(
  options: AsfCtxlaneIdentityCompositionOptions,
): AsfIdentityLifecycleController {
  if (
    options === null ||
    typeof options !== "object" ||
    !dependenciesAreComplete(options)
  ) {
    throw new AsfCtxlaneIdentityCompositionError("dependencies-incomplete");
  }

  if (
    options.productionMode === true &&
    !hasProductionQualifiedTransport(options.client)
  ) {
    throw new AsfCtxlaneIdentityCompositionError("transport-unqualified");
  }

  try {
    const brokerOptions = {
      client: options.client,
      lifecycleClient: options.lifecycleClient,
      authority: options.authority,
      clock: options.clock,
      ownershipFence: options.ownershipFence,
      ...(options.maximumClockSkewMs === undefined
        ? {}
        : { maximumClockSkewMs: options.maximumClockSkewMs }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    };
    const broker: ProviderIdentityBroker =
      new CtxlaneProviderIdentityBroker(brokerOptions);
    const lifecycleOptions: AsfIdentityLifecycleControllerOptions = {
      broker,
      clock: options.clock,
      ownershipFence: options.ownershipFence,
      profiles: options.profiles,
      requestedDurationMs: options.requestedDurationMs,
      renewalLeadMs: options.renewalLeadMs,
      fenceCheckIntervalMs: options.fenceCheckIntervalMs,
      ...(options.scheduler === undefined
        ? {}
        : { scheduler: options.scheduler }),
      ...(options.protectedLeaseRegistry === undefined
        ? {}
        : { protectedLeaseRegistry: options.protectedLeaseRegistry }),
      onAuthorityLost: options.onAuthorityLost,
    };
    return new AsfIdentityLifecycleController(lifecycleOptions);
  } catch {
    throw new AsfCtxlaneIdentityCompositionError(
      "dependency-construction-failed",
    );
  }
}

/**
 * Construct an ASF ctxlane controller for an operator-qualified production
 * deployment.
 *
 * This is the only production entrypoint.  Its options intentionally omit
 * `productionMode`, and the implementation always sets it to true before
 * crossing the generic composition boundary.  Therefore a missing,
 * development-only, or otherwise unqualified transport is refused before a
 * broker can be constructed, while existing test/embedding callers may keep
 * using the generic factory.
 */
export function createAsfCtxlaneIdentityProductionController(
  options: AsfCtxlaneIdentityProductionCompositionOptions,
): AsfIdentityLifecycleController {
  if (options === null || typeof options !== "object") {
    throw new AsfCtxlaneIdentityCompositionError("dependencies-incomplete");
  }

  return createAsfCtxlaneIdentityController({
    ...options,
    productionMode: true,
  });
}

export const createAsfCtxlaneIdentityLifecycleController =
  createAsfCtxlaneIdentityController;
