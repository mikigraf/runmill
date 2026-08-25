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
}

export class AsfCtxlaneIdentityCompositionError extends Error {
  readonly reason:
    | "dependencies-incomplete"
    | "dependency-construction-failed";

  constructor(
    reason:
      | "dependencies-incomplete"
      | "dependency-construction-failed",
  ) {
    super(`ASF ctxlane identity composition refused: ${reason}`);
    this.name = "AsfCtxlaneIdentityCompositionError";
    this.reason = reason;
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

export const createAsfCtxlaneIdentityLifecycleController =
  createAsfCtxlaneIdentityController;
