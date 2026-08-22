import type { AgentRole } from "../domain/types.js";

declare const identityLeaseIdBrand: unique symbol;
declare const identityExecutionHandleBrand: unique symbol;

export const POLICY_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/**
 * Opaque, sensitive lease identifier.
 *
 * It is controller state, not an identifier for prompts, events, evidence, or
 * support output. Only a ProviderIdentityBroker implementation may mint one.
 */
export type IdentityLeaseId = string & {
  readonly [identityLeaseIdBrand]: "IdentityLeaseId";
};

/**
 * Opaque, sensitive capability used to start the provider harness.
 *
 * It must stay inside the trusted controller boundary and must never be put in
 * a provider prompt, tool environment, public event, evidence bundle, or
 * support output. It is deliberately not a credential or token value.
 */
export type IdentityExecutionHandle = string & {
  readonly [identityExecutionHandleBrand]: "IdentityExecutionHandle";
};

/** A role-scoped request for temporary provider execution authority. */
export interface IdentityLeaseRequest {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly role: AgentRole;
  readonly requestedProfile: string;
  readonly policyDigest: string;
  readonly fencingGeneration: number;
  /** Requested wall-clock lifetime. The broker may return a shorter lease. */
  readonly requestedDurationMs: number;
}

/**
 * Temporary provider execution authority bound to one role and run fence.
 *
 * `provider`, `principal`, and `profile` are non-secret attribution. The two
 * opaque fields above are sensitive controller state. This type intentionally
 * contains no credential, token, token-file path, or provider-home path.
 */
export interface IdentityLease {
  readonly leaseId: IdentityLeaseId;
  readonly executionHandle: IdentityExecutionHandle;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly role: AgentRole;
  readonly policyDigest: string;
  readonly provider: string;
  readonly principal: string;
  readonly profile: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly fencingGeneration: number;
}

/** Non-sensitive ownership coordinates used to validate the current run fence. */
export interface IdentityOwnershipFence {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly fencingGeneration: number;
}

/**
 * Authoritative current-ownership check, normally backed by durable run state.
 * Only an exact `true` authorizes acquisition or renewal; unknown state fails
 * closed without exposing the sensitive lease identifier or execution handle.
 */
export interface IdentityOwnershipFenceValidator {
  isCurrent(fence: IdentityOwnershipFence): boolean | Promise<boolean>;
}

export function identityOwnershipFenceFor(
  binding: IdentityLease | IdentityLeaseRequest,
): IdentityOwnershipFence {
  return {
    runId: binding.runId,
    workOrderId: binding.workOrderId,
    attemptId: binding.attemptId,
    fencingGeneration: binding.fencingGeneration,
  };
}

export const LEASE_DISPOSITIONS = ["completed", "cancelled", "failed", "refused"] as const;
export type LeaseDisposition = (typeof LEASE_DISPOSITIONS)[number];

export class IdentityLeaseIndependenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityLeaseIndependenceError";
  }
}

function refuseIndependence(reason: string): never {
  throw new IdentityLeaseIndependenceError(`reviewer identity independence refused: ${reason}`);
}

function assertLeaseAttribution(lease: IdentityLease, label: string): void {
  const requiredStrings = [
    "leaseId",
    "executionHandle",
    "runId",
    "workOrderId",
    "attemptId",
    "policyDigest",
    "provider",
    "principal",
    "profile",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof lease[field] !== "string" || lease[field].trim().length === 0) {
      refuseIndependence(`${label} lease has invalid ${field}`);
    }
  }
  if (!POLICY_DIGEST_PATTERN.test(lease.policyDigest)) {
    refuseIndependence(`${label} lease has invalid policyDigest`);
  }
  if (!Number.isSafeInteger(lease.fencingGeneration) || lease.fencingGeneration <= 0) {
    refuseIndependence(`${label} lease has invalid fencingGeneration`);
  }
}

/**
 * Fail-closed post-acquisition reviewer independence check.
 *
 * Call this after acquiring both leases and before starting the reviewer. It
 * proves the leases describe the same fenced work attempt, then rejects a
 * reviewer that resolved to the implementer's provider principal. Profile
 * names alone are not evidence of independent identity.
 */
export function assertIndependentIdentityLeases(
  implementer: IdentityLease,
  reviewer: IdentityLease,
): void {
  assertLeaseAttribution(implementer, "implementer");
  assertLeaseAttribution(reviewer, "reviewer");
  if (implementer.role !== "implementer") {
    refuseIndependence(`expected implementer lease, received role ${implementer.role}`);
  }
  if (reviewer.role !== "local-reviewer" && reviewer.role !== "pr-reviewer") {
    refuseIndependence(`expected reviewer lease, received role ${reviewer.role}`);
  }

  const bindingFields = [
    "runId",
    "workOrderId",
    "attemptId",
    "policyDigest",
    "fencingGeneration",
  ] as const;
  for (const field of bindingFields) {
    if (implementer[field] !== reviewer[field]) {
      refuseIndependence(`lease binding mismatch: ${field}`);
    }
  }

  if (implementer.leaseId === reviewer.leaseId) {
    refuseIndependence("implementer and reviewer received the same lease");
  }
  if (implementer.executionHandle === reviewer.executionHandle) {
    refuseIndependence("implementer and reviewer received the same execution handle");
  }

  if (
    implementer.provider === reviewer.provider &&
    implementer.principal === reviewer.principal
  ) {
    refuseIndependence("reviewer resolved to the implementer provider and principal");
  }
}

/** Host-side boundary for acquiring and retiring provider execution identity. */
export interface ProviderIdentityBroker {
  acquire(request: IdentityLeaseRequest): Promise<IdentityLease>;
  renew(lease: IdentityLease): Promise<IdentityLease>;
  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void>;
  revoke(lease: IdentityLease, reason: string): Promise<void>;
}
