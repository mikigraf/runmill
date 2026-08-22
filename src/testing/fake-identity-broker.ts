import type { AgentRole } from "../domain/types.js";
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
} from "../identity/broker.js";
import type { Clock } from "../platform/clock.js";

export interface FakeIdentityGrant {
  readonly role: AgentRole;
  readonly profile: string;
  /** Non-secret identity attribution returned on a lease. */
  readonly provider: string;
  /** Non-secret identity attribution returned on a lease. */
  readonly principal: string;
  readonly maxDurationMs: number;
}

export type FakeIdentityBrokerCall =
  | {
      readonly op: "acquire";
      readonly runId: string;
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly role: AgentRole;
      readonly profile: string;
      readonly fencingGeneration: number;
      readonly requestedDurationMs: number;
    }
  | {
      readonly op: "renew";
      readonly runId: string;
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly role: AgentRole;
      readonly profile: string;
      readonly fencingGeneration: number;
    }
  | {
      readonly op: "close";
      readonly runId: string;
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly role: AgentRole;
      readonly profile: string;
      readonly fencingGeneration: number;
      readonly disposition: LeaseDisposition;
    }
  | {
      readonly op: "revoke";
      readonly runId: string;
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly role: AgentRole;
      readonly profile: string;
      readonly fencingGeneration: number;
      readonly reason: string;
    };

export class IdentityLeaseDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityLeaseDeniedError";
  }
}

export class IdentityLeaseBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityLeaseBindingError";
  }
}

export class IdentityLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityLeaseStateError";
  }
}

interface LeaseRecord {
  lease: IdentityLease;
  readonly durationMs: number;
  state: "active" | "closed" | "revoked";
}

function grantKey(role: AgentRole, profile: string): string {
  return `${role}\u0000${profile}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new IdentityLeaseDeniedError(`identity lease ${field} must not be empty`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IdentityLeaseDeniedError(`identity lease ${field} must be a positive integer`);
  }
}

function freezeLease(lease: IdentityLease): IdentityLease {
  return Object.freeze(lease);
}

/**
 * Deny-by-default in-memory identity broker.
 *
 * A caller receives authority only for an exact role/profile grant. The fake
 * keeps opaque handles private except for the lease boundary itself, never
 * manufactures a provider credential or token, and validates the complete
 * lease snapshot on every lifecycle operation.
 */
export class FakeProviderIdentityBroker implements ProviderIdentityBroker {
  readonly calls: FakeIdentityBrokerCall[] = [];
  readonly #clock: Clock;
  readonly #grants = new Map<string, FakeIdentityGrant>();
  readonly #leases = new Map<IdentityLeaseId, LeaseRecord>();
  readonly #ownershipFenceValidator: IdentityOwnershipFenceValidator | undefined;
  #sequence = 0;

  constructor(
    clock: Clock,
    grants: readonly FakeIdentityGrant[] = [],
    ownershipFenceValidator?: IdentityOwnershipFenceValidator,
  ) {
    this.#clock = clock;
    this.#ownershipFenceValidator = ownershipFenceValidator;
    for (const grant of grants) this.#addGrant(grant);
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    this.calls.push({
      op: "acquire",
      runId: request.runId,
      workOrderId: request.workOrderId,
      attemptId: request.attemptId,
      role: request.role,
      profile: request.requestedProfile,
      fencingGeneration: request.fencingGeneration,
      requestedDurationMs: request.requestedDurationMs,
    });
    this.#validateRequest(request);

    const grant = this.#grants.get(grantKey(request.role, request.requestedProfile));
    if (grant === undefined) {
      throw new IdentityLeaseDeniedError(
        `identity profile ${request.requestedProfile} is not granted for role ${request.role}`,
      );
    }

    await this.#assertCurrentOwnershipFence(request, "acquire");
    this.#assertNoActiveRoleLease(request);

    const durationMs = Math.min(request.requestedDurationMs, grant.maxDurationMs);
    const now = this.#clock.now();
    this.#sequence += 1;
    const leaseId = `fake-identity-lease-${this.#sequence}` as IdentityLeaseId;
    const executionHandle =
      `fake-provider-execution-${this.#sequence}` as IdentityExecutionHandle;
    const lease = freezeLease({
      leaseId,
      executionHandle,
      runId: request.runId,
      workOrderId: request.workOrderId,
      attemptId: request.attemptId,
      role: request.role,
      policyDigest: request.policyDigest,
      provider: grant.provider,
      principal: grant.principal,
      profile: grant.profile,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + durationMs).toISOString(),
      fencingGeneration: request.fencingGeneration,
    });
    this.#leases.set(leaseId, { lease, durationMs, state: "active" });
    return lease;
  }

  async renew(lease: IdentityLease): Promise<IdentityLease> {
    this.calls.push({ op: "renew", ...this.#callFields(lease) });
    const record = this.#requireUsable(lease, "renew");
    await this.#assertCurrentOwnershipFence(record.lease, "renew");
    const now = this.#clock.now();
    const renewed = freezeLease({
      ...record.lease,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + record.durationMs).toISOString(),
    });
    record.lease = renewed;
    return renewed;
  }

  async close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    this.calls.push({ op: "close", ...this.#callFields(lease), disposition });
    if (!(LEASE_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new IdentityLeaseStateError(`unknown identity lease disposition: ${disposition}`);
    }
    const record = this.#requireUsable(lease, "close");
    record.state = "closed";
  }

  async revoke(lease: IdentityLease, reason: string): Promise<void> {
    this.calls.push({ op: "revoke", ...this.#callFields(lease), reason });
    if (reason.trim().length === 0) {
      throw new IdentityLeaseStateError("identity lease revocation reason must not be empty");
    }
    const record = this.#requireUsable(lease, "revoke");
    record.state = "revoked";
  }

  #addGrant(grant: FakeIdentityGrant): void {
    assertNonEmpty(grant.profile, "grant profile");
    assertNonEmpty(grant.provider, "grant provider");
    assertNonEmpty(grant.principal, "grant principal");
    assertPositiveInteger(grant.maxDurationMs, "grant maxDurationMs");
    const key = grantKey(grant.role, grant.profile);
    if (this.#grants.has(key)) {
      throw new IdentityLeaseDeniedError(
        `duplicate identity grant for role ${grant.role} and profile ${grant.profile}`,
      );
    }
    this.#grants.set(key, Object.freeze({ ...grant }));
  }

  #validateRequest(request: IdentityLeaseRequest): void {
    assertNonEmpty(request.runId, "runId");
    assertNonEmpty(request.workOrderId, "workOrderId");
    assertNonEmpty(request.attemptId, "attemptId");
    assertNonEmpty(request.requestedProfile, "requestedProfile");
    if (!POLICY_DIGEST_PATTERN.test(request.policyDigest)) {
      throw new IdentityLeaseDeniedError(
        "identity lease policyDigest must be a tagged lower-case SHA-256 digest",
      );
    }
    assertPositiveInteger(request.fencingGeneration, "fencingGeneration");
    assertPositiveInteger(request.requestedDurationMs, "requestedDurationMs");
  }

  #assertNoActiveRoleLease(request: IdentityLeaseRequest): void {
    const nowMs = this.#clock.now().getTime();
    for (const record of this.#leases.values()) {
      const lease = record.lease;
      const sameScopedRole =
        lease.runId === request.runId &&
        lease.workOrderId === request.workOrderId &&
        lease.attemptId === request.attemptId &&
        lease.role === request.role;
      if (
        sameScopedRole &&
        record.state === "active" &&
        nowMs < Date.parse(lease.expiresAt)
      ) {
        throw new IdentityLeaseDeniedError(
          `active identity lease already exists for role ${request.role} in run ${request.runId}`,
        );
      }
    }
  }

  async #assertCurrentOwnershipFence(
    binding: IdentityLease | IdentityLeaseRequest,
    operation: "acquire" | "renew",
  ): Promise<void> {
    if (this.#ownershipFenceValidator === undefined) {
      throw new IdentityLeaseStateError(
        `cannot ${operation} identity lease without a current ownership-fence validator`,
      );
    }

    let isCurrent: boolean;
    try {
      isCurrent = await this.#ownershipFenceValidator.isCurrent(
        identityOwnershipFenceFor(binding),
      );
    } catch {
      throw new IdentityLeaseStateError(
        `cannot ${operation} identity lease because ownership-fence validation failed`,
      );
    }
    if (isCurrent !== true) {
      throw new IdentityLeaseStateError(
        `cannot ${operation} identity lease for stale ownership-fence generation ` +
          `${binding.fencingGeneration}`,
      );
    }
  }

  #requireUsable(
    supplied: IdentityLease,
    operation: "renew" | "close" | "revoke",
  ): LeaseRecord {
    const record = this.#leases.get(supplied.leaseId);
    if (record === undefined) {
      throw new IdentityLeaseStateError(`cannot ${operation} unknown identity lease`);
    }
    this.#assertBinding(record.lease, supplied, operation);
    if (record.state !== "active") {
      throw new IdentityLeaseStateError(
        `cannot ${operation} ${record.state} identity lease ${record.lease.leaseId}`,
      );
    }
    if (this.#clock.now().getTime() >= Date.parse(record.lease.expiresAt)) {
      throw new IdentityLeaseStateError(
        `cannot ${operation} expired identity lease ${record.lease.leaseId}`,
      );
    }
    return record;
  }

  #assertBinding(
    expected: IdentityLease,
    supplied: IdentityLease,
    operation: "renew" | "close" | "revoke",
  ): void {
    const fields = [
      "executionHandle",
      "runId",
      "workOrderId",
      "attemptId",
      "role",
      "policyDigest",
      "provider",
      "principal",
      "profile",
      "issuedAt",
      "expiresAt",
      "fencingGeneration",
    ] as const;
    for (const field of fields) {
      if (expected[field] !== supplied[field]) {
        throw new IdentityLeaseBindingError(
          `cannot ${operation} identity lease with mismatched ${field}`,
        );
      }
    }
  }

  #callFields(lease: IdentityLease): {
    readonly runId: string;
    readonly workOrderId: string;
    readonly attemptId: string;
    readonly role: AgentRole;
    readonly profile: string;
    readonly fencingGeneration: number;
  } {
    return {
      runId: lease.runId,
      workOrderId: lease.workOrderId,
      attemptId: lease.attemptId,
      role: lease.role,
      profile: lease.profile,
      fencingGeneration: lease.fencingGeneration,
    };
  }
}
