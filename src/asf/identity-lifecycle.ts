import type {
  IdentityLease,
  IdentityOwnershipFenceValidator,
  ProviderIdentityBroker,
} from "../identity/broker.js";
import {
  assertIndependentIdentityLeases,
  identityBrokerFailureDisposition,
} from "../identity/broker.js";
import {
  PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
  protectedIdentityLeaseDigest,
  type ProtectedIdentityLeaseBinding,
  type ProtectedIdentityLeasePendingOperation,
  type ProtectedIdentityLeasePhase,
  type ProtectedIdentityLeaseRegistry,
  type ProtectedIdentityLeaseSnapshot,
} from "../identity/protected-lease-registry.js";
import type { Clock } from "../platform/clock.js";
import { sha256Digest, type JsonValue } from "./canonical-json.js";
import {
  ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
  ASF_REQUIRED_IDENTITY_ROLES as REQUIRED_IDENTITY_ROLES,
  assertIdentityLeaseAttribution,
  identityAttributionsDigest,
  identityLeaseAttributionDigest,
  type AsfIdentityLeaseAttribution,
  type AsfRequiredIdentityRole,
} from "./identity-attribution.js";
import type {
  AsfDeliveryBinding,
  AsfEffectInput,
  AsfIdentityController,
} from "./delivery-runner.js";

export type { AsfRequiredIdentityRole } from "./identity-attribution.js";

const MAX_IDENTITY_LEASE_DURATION_MS = 86_400_000;
const MAX_FENCE_CHECK_INTERVAL_MS = 60_000;
const IDENTIFIER_MAX_LENGTH = 512;

export interface AsfIdentityProfiles {
  readonly implementer: string;
  readonly localReviewer: string;
  readonly prReviewer: string;
}

export interface AsfIdentityProfileResolver {
  /** Resolve profiles only from immutable, controller-owned policy state. */
  resolve(
    binding: AsfDeliveryBinding,
  ): AsfIdentityProfiles | Promise<AsfIdentityProfiles>;
}

export interface AsfIdentityLifecycleTask {
  cancel(): void;
}

export interface AsfIdentityLifecycleScheduler {
  schedule(
    delayMs: number,
    task: () => void | Promise<void>,
  ): AsfIdentityLifecycleTask;
}

export type AsfIdentityAuthorityLossReason =
  | "lease-expired"
  | "ownership-lost"
  | "renewal-failed"
  | "cancelled"
  | "acquisition-rollback-incomplete"
  | "revocation-incomplete";

/** Public-safe notification. It deliberately contains no lease capability. */
export interface AsfIdentityAuthorityLoss {
  readonly binding: AsfIdentityObservationBinding;
  readonly reason: AsfIdentityAuthorityLossReason;
  readonly roles: readonly AsfRequiredIdentityRole[];
  readonly revocationComplete: boolean;
}

export interface AsfIdentityObservationBinding {
  readonly run_id: string;
  readonly work_order_id: string;
  readonly attempt_id: string;
  readonly policy_digest: string;
  readonly fencing_generation: number;
  readonly candidate_sha: null;
}

export interface AsfIdentityAcquisitionObservation {
  readonly schema: "asf.identity-acquisition-observation/v1";
  readonly binding: AsfIdentityObservationBinding;
  readonly evidence_digest: string;
  readonly attributions_digest: string;
  readonly roles: readonly AsfRequiredIdentityRole[];
  /** Public-safe attribution. Broker lease IDs and execution handles never leave this controller. */
  readonly attributions: readonly AsfIdentityLeaseAttribution[];
}

export interface AsfIdentityLifecycleStatus {
  readonly binding: AsfIdentityObservationBinding;
  readonly state: "active" | "revoking" | "retired" | "failed";
  readonly roles: readonly AsfRequiredIdentityRole[];
  readonly retiredRoles: readonly AsfRequiredIdentityRole[];
}

export type AsfIdentityLifecycleRefusalReason =
  | "malformed-input"
  | "profile-binding"
  | "lease-binding"
  | "identity-independence"
  | "reconciliation-unavailable"
  | "authority-unavailable"
  | "revocation-incomplete";

export class AsfIdentityLifecycleRefusalError extends Error {
  readonly reason: AsfIdentityLifecycleRefusalReason;

  constructor(reason: AsfIdentityLifecycleRefusalReason, detail: string) {
    super(`ASF identity lifecycle refused: ${detail}`);
    this.name = "AsfIdentityLifecycleRefusalError";
    this.reason = reason;
  }
}

export interface AsfIdentityLifecycleControllerOptions {
  readonly broker: ProviderIdentityBroker;
  readonly clock: Clock;
  readonly ownershipFence: IdentityOwnershipFenceValidator;
  readonly profiles: AsfIdentityProfileResolver;
  readonly requestedDurationMs: number;
  /** Renew no later than this much wall-clock time before expiry. */
  readonly renewalLeadMs: number;
  /** Also recheck durable ownership at this bounded interval. */
  readonly fenceCheckIntervalMs: number;
  readonly scheduler?: AsfIdentityLifecycleScheduler | undefined;
  /**
   * Optional host-protected durable state. Production ASF composition supplies
   * this so a new process can restore an exact quiescent lease set. Standalone
   * startup never constructs this lifecycle or reads this state.
   */
  readonly protectedLeaseRegistry?: ProtectedIdentityLeaseRegistry | undefined;
  /** Required integration seam: the worker must abort the run on this callback. */
  readonly onAuthorityLost: (
    event: AsfIdentityAuthorityLoss,
  ) => void | Promise<void>;
}

type SessionState = AsfIdentityLifecycleStatus["state"];

interface IdentitySession {
  readonly binding: AsfDeliveryBinding;
  readonly profiles: AsfIdentityProfiles;
  readonly leases: Map<AsfRequiredIdentityRole, IdentityLease>;
  /** Includes superseded and malformed snapshots until each is retired. */
  readonly allLeases: Set<IdentityLease>;
  readonly retiredLeases: Set<IdentityLease>;
  observation: AsfIdentityAcquisitionObservation | undefined;
  state: SessionState;
  denied: boolean;
  task: AsfIdentityLifecycleTask | undefined;
  inFlightRenewal: Promise<IdentityLease> | undefined;
  readonly abortSubscriptions: Map<AbortSignal, () => void>;
  revokePromise: Promise<boolean> | undefined;
  notified: boolean;
  registryPhase: ProtectedIdentityLeasePhase;
  registryRevision: number | null;
  readonly pendingOperations: ProtectedIdentityLeasePendingOperation[];
}

interface PendingAcquisition {
  readonly binding: AsfDeliveryBinding;
  readonly profiles: AsfIdentityProfiles;
  readonly session: IdentitySession;
  promise: Promise<AsfIdentityAcquisitionObservation>;
  denied: boolean;
}

const DEFAULT_SCHEDULER: AsfIdentityLifecycleScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(() => {
      void Promise.resolve(task()).catch(() => undefined);
    }, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

function refusal(
  reason: AsfIdentityLifecycleRefusalReason,
  detail: string,
): AsfIdentityLifecycleRefusalError {
  return new AsfIdentityLifecycleRefusalError(reason, detail);
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function sameIdentityBinding(
  left: AsfDeliveryBinding,
  right: AsfDeliveryBinding,
): boolean {
  return (
    left.runId === right.runId &&
    left.workOrderId === right.workOrderId &&
    left.attemptId === right.attemptId &&
    left.policyDigest === right.policyDigest &&
    left.fencingGeneration === right.fencingGeneration
  );
}

function sameIdentityScope(
  left: AsfDeliveryBinding,
  right: AsfDeliveryBinding,
): boolean {
  return (
    left.runId === right.runId &&
    left.workOrderId === right.workOrderId &&
    left.attemptId === right.attemptId &&
    left.policyDigest === right.policyDigest
  );
}

function sameProfiles(
  left: AsfIdentityProfiles,
  right: AsfIdentityProfiles,
): boolean {
  return (
    left.implementer === right.implementer &&
    left.localReviewer === right.localReviewer &&
    left.prReviewer === right.prReviewer
  );
}

function observationBinding(
  binding: AsfDeliveryBinding,
): AsfIdentityObservationBinding {
  return Object.freeze({
    run_id: binding.runId,
    work_order_id: binding.workOrderId,
    attempt_id: binding.attemptId,
    policy_digest: binding.policyDigest,
    fencing_generation: binding.fencingGeneration,
    candidate_sha: null,
  });
}

function protectedBinding(
  binding: AsfDeliveryBinding,
): ProtectedIdentityLeaseBinding {
  return Object.freeze({
    runId: binding.runId,
    workOrderId: binding.workOrderId,
    attemptId: binding.attemptId,
    policyDigest: binding.policyDigest,
    fencingGeneration: binding.fencingGeneration,
  });
}

function samePendingOperation(
  left: ProtectedIdentityLeasePendingOperation,
  right: ProtectedIdentityLeasePendingOperation,
): boolean {
  return (
    left.kind === right.kind &&
    left.role === right.role &&
    left.leaseDigest === right.leaseDigest
  );
}

function profileFor(
  profiles: AsfIdentityProfiles,
  role: AsfRequiredIdentityRole,
): string {
  switch (role) {
    case "implementer":
      return profiles.implementer;
    case "local-reviewer":
      return profiles.localReviewer;
    case "pr-reviewer":
      return profiles.prReviewer;
  }
}

function safeRevocationReason(cause: string): string {
  return `Runmill ASF identity authority retired: ${cause}`;
}

/**
 * Trusted ASF identity lifecycle around a production ProviderIdentityBroker.
 *
 * This module is never imported or constructed by standalone startup. It keeps
 * execution handles in protected memory, returns only the runner's bounded
 * attribution shape, periodically rechecks ownership, and denies use before it
 * attempts best-effort revocation of every lease.
 */
export class AsfIdentityLifecycleController implements AsfIdentityController {
  readonly #broker: ProviderIdentityBroker;
  readonly #clock: Clock;
  readonly #ownershipFence: IdentityOwnershipFenceValidator;
  readonly #profiles: AsfIdentityProfileResolver;
  readonly #requestedDurationMs: number;
  readonly #renewalLeadMs: number;
  readonly #fenceCheckIntervalMs: number;
  readonly #scheduler: AsfIdentityLifecycleScheduler;
  readonly #protectedLeaseRegistry: ProtectedIdentityLeaseRegistry | undefined;
  readonly #onAuthorityLost: AsfIdentityLifecycleControllerOptions["onAuthorityLost"];
  readonly #sessions = new Map<string, IdentitySession>();
  readonly #pending = new Map<string, PendingAcquisition>();

  constructor(options: AsfIdentityLifecycleControllerOptions) {
    if (
      !Number.isSafeInteger(options.requestedDurationMs) ||
      options.requestedDurationMs < 1 ||
      options.requestedDurationMs > MAX_IDENTITY_LEASE_DURATION_MS
    ) {
      throw refusal(
        "malformed-input",
        "requested lease duration is outside the production bound",
      );
    }
    if (
      !Number.isSafeInteger(options.renewalLeadMs) ||
      options.renewalLeadMs < 1 ||
      options.renewalLeadMs >= options.requestedDurationMs
    ) {
      throw refusal(
        "malformed-input",
        "renewal lead must be positive and shorter than the lease",
      );
    }
    if (
      !Number.isSafeInteger(options.fenceCheckIntervalMs) ||
      options.fenceCheckIntervalMs < 1 ||
      options.fenceCheckIntervalMs > MAX_FENCE_CHECK_INTERVAL_MS
    ) {
      throw refusal(
        "malformed-input",
        "ownership checks must run at a bounded interval",
      );
    }
    if (typeof options.onAuthorityLost !== "function") {
      throw refusal(
        "malformed-input",
        "an authority-loss abort callback is required",
      );
    }
    this.#broker = options.broker;
    this.#clock = options.clock;
    this.#ownershipFence = options.ownershipFence;
    this.#profiles = options.profiles;
    this.#requestedDurationMs = options.requestedDurationMs;
    this.#renewalLeadMs = options.renewalLeadMs;
    this.#fenceCheckIntervalMs = options.fenceCheckIntervalMs;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#protectedLeaseRegistry = options.protectedLeaseRegistry;
    this.#onAuthorityLost = options.onAuthorityLost;
  }

  async acquireRequiredRoles(
    input: AsfEffectInput,
  ): Promise<AsfIdentityAcquisitionObservation> {
    this.#assertInputBinding(input);
    if (input.signal.aborted) {
      throw refusal(
        "authority-unavailable",
        "identity acquisition was cancelled before it began",
      );
    }
    const profiles = this.#parseProfiles(
      await this.#profiles.resolve(input.binding),
    );
    this.#assertProfileIntent(input, profiles);

    const existing = this.#sessions.get(input.binding.runId);
    if (existing !== undefined) {
      return this.#reuseExisting(existing, input, profiles);
    }

    const existingPending = this.#pending.get(input.binding.runId);
    if (existingPending !== undefined) {
      if (
        !sameIdentityBinding(existingPending.binding, input.binding) ||
        !sameProfiles(existingPending.profiles, profiles)
      ) {
        throw refusal(
          "authority-unavailable",
          "another identity acquisition owns this run id",
        );
      }
      this.#attachAbort(existingPending.session, input.signal);
      return existingPending.promise;
    }

    if (input.intentMode === "reconcile-only") {
      return this.#recoverProtectedSession(input, profiles);
    }

    return this.#acquireFreshSession(input, profiles);
  }

  async #acquireFreshSession(
    input: AsfEffectInput,
    profiles: AsfIdentityProfiles,
  ): Promise<AsfIdentityAcquisitionObservation> {
    const session: IdentitySession = {
      binding: Object.freeze({ ...input.binding }),
      profiles,
      leases: new Map(),
      allLeases: new Set(),
      retiredLeases: new Set(),
      observation: undefined,
      state: "active",
      denied: false,
      task: undefined,
      inFlightRenewal: undefined,
      abortSubscriptions: new Map(),
      revokePromise: undefined,
      notified: false,
      registryPhase: "acquiring",
      registryRevision: null,
      pendingOperations: [],
    };
    const pending: PendingAcquisition = {
      binding: Object.freeze({ ...input.binding }),
      profiles,
      session,
      promise: Promise.resolve(undefined as never),
      denied: false,
    };
    this.#pending.set(input.binding.runId, pending);
    this.#attachAbort(session, input.signal);
    const promise = this.#acquire(pending);
    pending.promise = promise;
    try {
      return await promise;
    } finally {
      if (this.#pending.get(input.binding.runId)?.promise === promise) {
        this.#pending.delete(input.binding.runId);
      }
    }
  }

  async #recoverProtectedSession(
    input: AsfEffectInput,
    profiles: AsfIdentityProfiles,
  ): Promise<AsfIdentityAcquisitionObservation> {
    if (this.#protectedLeaseRegistry === undefined) {
      throw refusal(
        "reconciliation-unavailable",
        "protected lease state is unavailable; exact broker lookup/status is required",
      );
    }

    const currentGeneration = input.binding.fencingGeneration;
    let lineage: readonly ProtectedIdentityLeaseSnapshot[];
    try {
      lineage = await this.#protectedLeaseRegistry.loadLineage(
        protectedBinding(input.binding),
      );
    } catch {
      throw refusal(
        "reconciliation-unavailable",
        "protected lease state is missing, stale, unreadable, or contradictory",
      );
    }

    const requestedGeneration = input.intent.fencing_generation;
    const generations = new Set<number>();
    const malformedLineage = lineage.some((candidate) => {
      const generation = candidate.binding.fencingGeneration;
      if (
        generations.has(generation) ||
        candidate.binding.runId !== input.binding.runId ||
        candidate.binding.workOrderId !== input.binding.workOrderId ||
        candidate.binding.attemptId !== input.binding.attemptId ||
        candidate.binding.policyDigest !== input.binding.policyDigest ||
        generation > currentGeneration
      ) {
        return true;
      }
      generations.add(generation);
      return false;
    });
    const current = lineage.filter(
      (candidate) => candidate.binding.fencingGeneration === currentGeneration,
    );
    const requested = lineage.filter(
      (candidate) =>
        candidate.binding.fencingGeneration === requestedGeneration,
    );
    const currentSnapshot = current[0];
    // A current-generation snapshot wins even while the durable delivery
    // intent still names its predecessor. That is the expected crash boundary
    // after handoff created generation N but before delivery acknowledged it.
    // Its pending marker must be reconciled, never bypassed by replaying the
    // predecessor and attempting a second generation-N acquisition.
    const recoveringCurrent = currentSnapshot !== undefined;
    const snapshot = recoveringCurrent ? currentSnapshot : requested[0];
    const selectedGeneration = snapshot?.binding.fencingGeneration;
    const anotherUnretired = lineage.some(
      (candidate) =>
        candidate.phase !== "retired" &&
        candidate.binding.fencingGeneration !== selectedGeneration,
    );
    const laterProtectedGeneration =
      !recoveringCurrent &&
      lineage.some(
        (candidate) =>
          candidate.binding.fencingGeneration > requestedGeneration,
      );
    if (
      malformedLineage ||
      current.length > 1 ||
      requested.length > 1 ||
      anotherUnretired ||
      laterProtectedGeneration
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected lease lineage contains multiple, future, or contradictory snapshots",
      );
    }
    if (
      snapshot === undefined ||
      requestedGeneration > currentGeneration ||
      (!recoveringCurrent && requestedGeneration >= currentGeneration)
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "no exact protected lease state exists for the fenced identity intent",
      );
    }

    const protectedGeneration = snapshot.binding.fencingGeneration;
    const protectedSessionBinding: AsfDeliveryBinding = {
      ...input.binding,
      fencingGeneration: protectedGeneration,
      candidateSha: null,
    };

    const session = this.#sessionFromProtectedSnapshot(
      snapshot,
      protectedSessionBinding,
    );
    this.#sessions.set(input.binding.runId, session);
    if (session.pendingOperations.length > 0) {
      session.denied = true;
      session.state = "failed";
      throw refusal(
        "reconciliation-unavailable",
        "a broker mutation crossed the last durable boundary; exact broker lookup/status is required",
      );
    }
    if (!sameProfiles(session.profiles, profiles)) {
      session.denied = true;
      session.state = "failed";
      const complete = await this.#revokeLeases(
        session,
        "protected profile contradiction",
      );
      if (!complete)
        await this.#notify(session, "revocation-incomplete", false);
      throw refusal(
        "profile-binding",
        "protected lease profiles contradict current immutable policy",
      );
    }
    this.#attachAbort(session, input.signal);
    if (protectedGeneration < input.binding.fencingGeneration) {
      return this.#replacePriorGenerationSession(session, input, profiles);
    }
    if (!(await this.#isCurrent(input.binding))) {
      await this.#loseAuthority(session, "ownership-lost");
      throw refusal(
        "authority-unavailable",
        "protected lease state no longer owns the durable fence",
      );
    }

    if (snapshot.phase === "active") {
      let observation: AsfIdentityAcquisitionObservation;
      try {
        observation = this.#validateRestoredActiveSession(session);
        // A successful exact renewal is the only operation in the base broker
        // contract that proves the sealed snapshot is still live remotely.
        await this.#renewAllRoles(session);
      } catch {
        await this.#loseAuthority(session, "renewal-failed");
        throw refusal(
          "reconciliation-unavailable",
          "the broker did not confirm every restored role lease",
        );
      }
      session.observation = observation;
      session.state = "active";
      session.denied = false;
      this.#schedule(session);
      return observation;
    }

    if (
      snapshot.phase === "acquiring" &&
      this.#hasCompleteCurrentLeaseSet(session)
    ) {
      try {
        for (const role of REQUIRED_IDENTITY_ROLES) {
          const lease = session.leases.get(role);
          if (lease === undefined) {
            throw refusal(
              "lease-binding",
              "protected role lease set is incomplete",
            );
          }
          this.#assertLease(
            lease,
            input.binding,
            role,
            profileFor(profiles, role),
          );
        }
        this.#assertLeaseSet(session.leases);
      } catch {
        await this.#loseAuthority(session, "renewal-failed");
        throw refusal(
          "reconciliation-unavailable",
          "the complete protected acquisition snapshot could not be validated",
        );
      }
      const observation = this.#observation(input.binding, session.leases);
      session.observation = observation;
      session.registryPhase = "active";
      await this.#persistSession(session);
      session.state = "active";
      session.denied = false;
      this.#schedule(session);
      return observation;
    }

    if (
      (snapshot.phase === "acquiring" ||
        snapshot.phase === "revoking" ||
        snapshot.phase === "failed") &&
      session.allLeases.size > 0
    ) {
      const complete = await this.#revokeLeases(
        session,
        "incomplete protected identity recovery",
      );
      if (!complete) {
        await this.#notify(session, "revocation-incomplete", false);
      }
    }
    throw refusal(
      "reconciliation-unavailable",
      snapshot.phase === "retired"
        ? "the exact protected identity session was already retired"
        : "protected identity acquisition was incomplete and cannot be acknowledged",
    );
  }

  async #replacePriorGenerationSession(
    prior: IdentitySession,
    input: AsfEffectInput,
    profiles: AsfIdentityProfiles,
  ): Promise<AsfIdentityAcquisitionObservation> {
    if (!(await this.#isCurrent(input.binding))) {
      throw refusal(
        "authority-unavailable",
        "current durable ownership is unproven for prior-generation identity retirement",
      );
    }
    this.#assertProtectedPriorLeases(prior);
    if (!sameProfiles(prior.profiles, profiles)) {
      const retired = await this.#revokeLeases(
        prior,
        "prior-generation profile contradiction",
      );
      if (!retired) await this.#notify(prior, "revocation-incomplete", false);
      throw refusal(
        "profile-binding",
        "prior-generation protected lease profiles contradict current immutable policy",
      );
    }
    if (prior.registryPhase !== "retired") {
      const retired = await this.#revokeLeases(
        prior,
        "prior-generation ownership fence advanced",
      );
      if (!retired) {
        await this.#notify(prior, "revocation-incomplete", false);
        throw refusal(
          "reconciliation-unavailable",
          "not every prior-generation role lease has exact retirement evidence",
        );
      }
    }
    if (input.signal.aborted || !(await this.#isCurrent(input.binding))) {
      throw refusal(
        "authority-unavailable",
        "current durable ownership was lost before fresh identity acquisition",
      );
    }
    if (this.#sessions.get(input.binding.runId) === prior) {
      this.#sessions.delete(input.binding.runId);
    }
    return this.#acquireFreshSession(input, profiles);
  }

  #assertProtectedPriorLeases(session: IdentitySession): void {
    const entriesByRole = new Map<AsfRequiredIdentityRole, IdentityLease[]>(
      REQUIRED_IDENTITY_ROLES.map((role) => [role, []]),
    );
    for (const lease of session.allLeases) {
      const role = REQUIRED_IDENTITY_ROLES.find(
        (candidate) => candidate === lease.role,
      );
      if (
        role === undefined ||
        !validIdentifier(lease.leaseId) ||
        !validIdentifier(lease.executionHandle) ||
        !validIdentifier(lease.provider) ||
        !validIdentifier(lease.principal) ||
        !validIdentifier(lease.profile) ||
        lease.runId !== session.binding.runId ||
        lease.workOrderId !== session.binding.workOrderId ||
        lease.attemptId !== session.binding.attemptId ||
        lease.policyDigest !== session.binding.policyDigest ||
        lease.fencingGeneration !== session.binding.fencingGeneration ||
        lease.profile !== profileFor(session.profiles, role) ||
        !Number.isFinite(Date.parse(lease.issuedAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.issuedAt) > this.#clock.now().getTime() ||
        Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt) ||
        Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt) >
          this.#requestedDurationMs
      ) {
        throw refusal(
          "reconciliation-unavailable",
          "protected prior-generation lease state is stale or contradictory",
        );
      }
      entriesByRole.get(role)?.push(lease);
    }
    if (
      [...session.allLeases].some(
        (lease) =>
          !session.retiredLeases.has(lease) &&
          ![...session.leases.values()].includes(lease),
      ) ||
      [...session.leases].some(
        ([role, lease]) =>
          (session.retiredLeases.has(lease) &&
            session.registryPhase !== "retired") ||
          lease.role !== role,
      )
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected prior-generation lease history is incomplete or contradictory",
      );
    }

    if (session.registryPhase === "acquiring") {
      const cleanPartialAcquisition =
        session.observation === undefined &&
        session.pendingOperations.length === 0 &&
        [...entriesByRole.values()].every((entries) => entries.length <= 1) &&
        REQUIRED_IDENTITY_ROLES.every((role, index) =>
          index < session.leases.size
            ? session.leases.has(role)
            : !session.leases.has(role),
        ) &&
        [...session.allLeases].every(
          (lease) =>
            !session.retiredLeases.has(lease) &&
            session.leases.get(lease.role as AsfRequiredIdentityRole) === lease,
        ) &&
        session.leases.size === session.allLeases.size;
      if (!cleanPartialAcquisition) {
        throw refusal(
          "reconciliation-unavailable",
          "protected prior-generation acquiring history is contradictory",
        );
      }
      const known = [...session.leases.values()];
      if (
        new Set(known.map((lease) => lease.leaseId)).size !== known.length ||
        new Set(known.map((lease) => lease.executionHandle)).size !==
          known.length
      ) {
        throw refusal(
          "reconciliation-unavailable",
          "protected prior-generation acquiring history reused a lease capability",
        );
      }
      const implementer = session.leases.get("implementer");
      if (implementer !== undefined) {
        try {
          for (const reviewerRole of [
            "local-reviewer",
            "pr-reviewer",
          ] as const) {
            const reviewer = session.leases.get(reviewerRole);
            if (reviewer !== undefined) {
              assertIndependentIdentityLeases(implementer, reviewer);
            }
          }
        } catch {
          throw refusal(
            "reconciliation-unavailable",
            "protected prior-generation acquiring identities are not independent",
          );
        }
      }
      if (session.leases.size === REQUIRED_IDENTITY_ROLES.length) {
        this.#assertLeaseSet(session.leases);
      }
      return;
    }

    if (session.registryPhase === "retired") {
      if (
        session.pendingOperations.length > 0 ||
        [...session.allLeases].some(
          (lease) => !session.retiredLeases.has(lease),
        )
      ) {
        throw refusal(
          "reconciliation-unavailable",
          "protected prior-generation retirement state is contradictory",
        );
      }
      return;
    }

    if (
      REQUIRED_IDENTITY_ROLES.some(
        (role) => (entriesByRole.get(role)?.length ?? 0) === 0,
      )
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected prior-generation lease history is incomplete",
      );
    }

    if (
      session.registryPhase === "active" &&
      !this.#hasCompleteCurrentLeaseSet(session)
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected prior-generation lease set is not complete",
      );
    }
    if (session.registryPhase === "failed") {
      throw refusal(
        "reconciliation-unavailable",
        "protected prior-generation retirement state is contradictory",
      );
    }
    if (session.leases.size === REQUIRED_IDENTITY_ROLES.length) {
      this.#assertLeaseSet(session.leases);
    }
  }

  #sameProtectedSessionState(
    left: IdentitySession,
    right: IdentitySession,
  ): boolean {
    const descriptor = (session: IdentitySession): JsonValue => {
      const currentRoles = new Map(
        [...session.leases].map(([role, lease]) => [lease, role] as const),
      );
      const leases = [...session.allLeases]
        .map((lease) => ({
          lease_digest: protectedIdentityLeaseDigest(lease),
          current_role: session.retiredLeases.has(lease)
            ? null
            : (currentRoles.get(lease) ?? null),
          retired: session.retiredLeases.has(lease),
        }))
        .sort((a, b) => a.lease_digest.localeCompare(b.lease_digest));
      const pendingOperations = [...session.pendingOperations]
        .map((operation) => ({ ...operation }))
        .sort((a, b) =>
          `${a.kind}\u0000${a.role}\u0000${a.leaseDigest ?? ""}`.localeCompare(
            `${b.kind}\u0000${b.role}\u0000${b.leaseDigest ?? ""}`,
          ),
        );
      return json({
        binding: protectedBinding(session.binding),
        profiles: session.profiles,
        phase: session.registryPhase,
        leases,
        pending_operations: pendingOperations,
        acquisition_observation:
          session.observation === undefined ? null : session.observation,
      });
    };
    return (
      left.registryRevision === right.registryRevision &&
      sha256Digest(descriptor(left)) === sha256Digest(descriptor(right))
    );
  }

  #sessionFromProtectedSnapshot(
    snapshot: ProtectedIdentityLeaseSnapshot,
    binding: AsfDeliveryBinding,
  ): IdentitySession {
    if (
      !sameIdentityBinding(
        { ...binding, candidateSha: null },
        {
          runId: snapshot.binding.runId,
          workOrderId: snapshot.binding.workOrderId,
          attemptId: snapshot.binding.attemptId,
          policyDigest: snapshot.binding.policyDigest,
          fencingGeneration: snapshot.binding.fencingGeneration,
          candidateSha: null,
        },
      )
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected lease state is bound to another run fence",
      );
    }
    const profiles = this.#parseProfiles(snapshot.profiles);
    const leases = new Map<AsfRequiredIdentityRole, IdentityLease>();
    const allLeases = new Set<IdentityLease>();
    const retiredLeases = new Set<IdentityLease>();
    for (const entry of snapshot.leases) {
      allLeases.add(entry.lease);
      if (entry.retired) retiredLeases.add(entry.lease);
      if (entry.currentRole !== null)
        leases.set(entry.currentRole, entry.lease);
    }
    const active =
      snapshot.phase === "active" || snapshot.phase === "acquiring";
    return {
      binding: Object.freeze({ ...binding, candidateSha: null }),
      profiles,
      leases,
      allLeases,
      retiredLeases,
      observation:
        snapshot.acquisitionObservation === null
          ? undefined
          : this.#parseRestoredObservation(
              snapshot.acquisitionObservation,
              binding,
            ),
      state: active
        ? "active"
        : snapshot.phase === "retired"
          ? "retired"
          : "failed",
      denied: !active,
      task: undefined,
      inFlightRenewal: undefined,
      abortSubscriptions: new Map(),
      revokePromise: undefined,
      notified: false,
      registryPhase: snapshot.phase,
      registryRevision: snapshot.revision,
      pendingOperations: snapshot.pendingOperations.map((operation) => ({
        ...operation,
      })),
    };
  }

  #hasCompleteCurrentLeaseSet(session: IdentitySession): boolean {
    return (
      session.leases.size === REQUIRED_IDENTITY_ROLES.length &&
      REQUIRED_IDENTITY_ROLES.every((role) => session.leases.has(role)) &&
      [...session.allLeases].every(
        (lease) =>
          session.retiredLeases.has(lease) ||
          [...session.leases.values()].includes(lease),
      )
    );
  }

  #validateRestoredActiveSession(
    session: IdentitySession,
  ): AsfIdentityAcquisitionObservation {
    if (
      !this.#hasCompleteCurrentLeaseSet(session) ||
      session.observation === undefined
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "active protected identity state does not contain one exact lease per required role",
      );
    }
    for (const role of REQUIRED_IDENTITY_ROLES) {
      const lease = session.leases.get(role);
      if (lease === undefined) {
        throw refusal(
          "lease-binding",
          "protected role lease set is incomplete",
        );
      }
      this.#assertLease(
        lease,
        session.binding,
        role,
        profileFor(session.profiles, role),
      );
      const attribution = session.observation.attributions.find(
        (candidate) => candidate.role === role,
      );
      if (
        attribution === undefined ||
        attribution.provider !== lease.provider ||
        attribution.principal_id !== lease.principal ||
        attribution.profile !== lease.profile ||
        attribution.fencing_generation !== lease.fencingGeneration ||
        Date.parse(attribution.expires_at) <= this.#clock.now().getTime()
      ) {
        throw refusal(
          "lease-binding",
          "protected attribution is stale or contradicts its current role lease",
        );
      }
    }
    this.#assertLeaseSet(session.leases);
    return session.observation;
  }

  /**
   * Give another trusted controller temporary access to the opaque execution
   * lease without serializing it or returning it through the lifecycle API.
   */
  async withLease<T>(
    binding: AsfDeliveryBinding,
    role: AsfRequiredIdentityRole,
    operation: (lease: IdentityLease) => T | Promise<T>,
  ): Promise<T> {
    const rawRole: unknown = role;
    const rawOperation: unknown = operation;
    if (
      !REQUIRED_IDENTITY_ROLES.some((candidate) => candidate === rawRole) ||
      typeof rawOperation !== "function"
    ) {
      throw refusal(
        "malformed-input",
        "protected lease access request is malformed",
      );
    }
    const session = this.#requireSession(binding);
    if (session.state !== "active" || session.denied) {
      throw refusal(
        "authority-unavailable",
        "identity authority is not active",
      );
    }
    const now = this.#clock.now().getTime();
    if (
      [...session.leases.values()].some(
        (lease) => Date.parse(lease.expiresAt) <= now,
      )
    ) {
      await this.#loseAuthority(session, "lease-expired");
      throw refusal("authority-unavailable", "identity authority expired");
    }
    if (!(await this.#isCurrent(binding))) {
      await this.#loseAuthority(session, "ownership-lost");
      throw refusal(
        "authority-unavailable",
        "identity authority lost durable ownership",
      );
    }
    if (session.state !== "active" || session.denied) {
      throw refusal(
        "authority-unavailable",
        "identity authority was retired during access",
      );
    }
    const lease = session.leases.get(role);
    if (lease === undefined) {
      await this.#loseAuthority(session, "renewal-failed");
      throw refusal(
        "authority-unavailable",
        "required role authority is unavailable",
      );
    }
    return operation(lease);
  }

  /** Forced cancellation. The first call denies access before contacting the broker. */
  async cancel(binding: AsfDeliveryBinding): Promise<void> {
    await this.#explicitRevoke(binding, "cancellation");
  }

  /** Terminal cleanup. All remaining role leases are revoked, not merely forgotten. */
  async cleanup(binding: AsfDeliveryBinding): Promise<void> {
    await this.#explicitRevoke(binding, "cleanup");
  }

  /** Explicit ownership-loss hook for a worker heartbeat/fencing coordinator. */
  async ownershipLost(binding: AsfDeliveryBinding): Promise<void> {
    const session = this.#requireSession(binding);
    await this.#loseAuthority(session, "ownership-lost");
  }

  status(runId: string): AsfIdentityLifecycleStatus | undefined {
    const session = this.#sessions.get(runId);
    if (session === undefined) return undefined;
    return Object.freeze({
      binding: observationBinding(session.binding),
      state: session.state,
      roles: Object.freeze([...session.leases.keys()].sort()),
      retiredRoles: Object.freeze(
        [...session.leases]
          .filter(([, lease]) => session.retiredLeases.has(lease))
          .map(([role]) => role)
          .sort(),
      ),
    });
  }

  async #acquire(
    pending: PendingAcquisition,
  ): Promise<AsfIdentityAcquisitionObservation> {
    const { binding, profiles, session } = pending;
    const { leases } = session;
    try {
      if (!(await this.#isCurrent(binding))) {
        throw refusal(
          "authority-unavailable",
          "durable ownership is not current before acquisition",
        );
      }
      await this.#persistSession(session);
      for (const role of REQUIRED_IDENTITY_ROLES) {
        if (pending.denied || session.denied) {
          throw refusal(
            "authority-unavailable",
            "identity acquisition was cancelled",
          );
        }
        const protectedOperation = await this.#beginProtectedOperation(
          session,
          {
            kind: "acquire",
            role,
            leaseDigest: null,
          },
        );
        let lease: IdentityLease;
        try {
          lease = await this.#broker.acquire({
            runId: binding.runId,
            workOrderId: binding.workOrderId,
            attemptId: binding.attemptId,
            role,
            requestedProfile: profileFor(profiles, role),
            policyDigest: binding.policyDigest,
            fencingGeneration: binding.fencingGeneration,
            requestedDurationMs: this.#requestedDurationMs,
          });
        } catch (error) {
          if (identityBrokerFailureDisposition(error) !== undefined) {
            await this.#completeProtectedOperation(session, protectedOperation);
          }
          throw error;
        }
        // Retain even a malformed response until revocation has been attempted.
        leases.set(role, lease);
        session.allLeases.add(lease);
        await this.#completeProtectedOperation(session, protectedOperation);
        if (pending.denied || session.denied) {
          await this.#revokeLeases(session, "cancelled acquisition");
          throw refusal(
            "authority-unavailable",
            "late identity authority arrived after cancellation",
          );
        }
        this.#assertLease(lease, binding, role, profileFor(profiles, role));
      }
      this.#assertLeaseSet(leases);
      if (!(await this.#isCurrent(binding))) {
        throw refusal(
          "authority-unavailable",
          "durable ownership changed during acquisition",
        );
      }
      if (pending.denied || session.denied) {
        throw refusal(
          "authority-unavailable",
          "identity acquisition was cancelled before acknowledgement",
        );
      }

      const observation = this.#observation(binding, leases);
      session.observation = observation;
      session.registryPhase = "active";
      await this.#persistSession(session);
      this.#sessions.set(binding.runId, session);
      this.#schedule(session);
      return observation;
    } catch (error) {
      if (leases.size > 0 || session.pendingOperations.length > 0) {
        this.#sessions.set(binding.runId, session);
        const complete = await this.#revokeLeases(
          session,
          "failed acquisition rollback",
        );
        if (!complete) {
          await this.#notify(session, "acquisition-rollback-incomplete", false);
        }
      } else {
        this.#detachAbort(session);
      }
      if (error instanceof AsfIdentityLifecycleRefusalError) throw error;
      throw refusal(
        "authority-unavailable",
        "required role acquisition failed",
      );
    }
  }

  async #reuseExisting(
    session: IdentitySession,
    input: AsfEffectInput,
    profiles: AsfIdentityProfiles,
  ): Promise<AsfIdentityAcquisitionObservation> {
    if (
      !sameIdentityBinding(session.binding, input.binding) ||
      !sameProfiles(session.profiles, profiles)
    ) {
      throw refusal(
        "authority-unavailable",
        "existing identity authority has another exact binding",
      );
    }
    this.#attachAbort(session, input.signal);
    if (
      session.state !== "active" ||
      session.denied ||
      session.observation === undefined
    ) {
      throw refusal(
        "authority-unavailable",
        "existing identity authority is not reusable",
      );
    }
    const now = this.#clock.now().getTime();
    if (
      session.observation.attributions.some(
        (attribution) => Date.parse(attribution.expires_at) <= now,
      )
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "the immutable acquisition observation expired and cannot be rebound to renewed leases",
      );
    }
    if (!(await this.#isCurrent(input.binding))) {
      await this.#loseAuthority(session, "ownership-lost");
      throw refusal(
        "authority-unavailable",
        "existing identity authority lost durable ownership",
      );
    }
    return session.observation;
  }

  #assertInputBinding(input: AsfEffectInput): void {
    const { binding, intent } = input;
    const { intent_digest: intentDigest, ...unsignedIntent } = intent;
    const generationIsAuthorized =
      input.intentMode === "observe-before-apply"
        ? intent.fencing_generation === binding.fencingGeneration
        : intent.fencing_generation <= binding.fencingGeneration;
    if (
      (input.intentMode !== "observe-before-apply" &&
        input.intentMode !== "reconcile-only") ||
      !validDigest(intentDigest) ||
      sha256Digest(json(unsignedIntent)) !== intentDigest ||
      !validIdentifier(binding.runId) ||
      !validIdentifier(binding.workOrderId) ||
      !validIdentifier(binding.attemptId) ||
      !validDigest(binding.policyDigest) ||
      !Number.isSafeInteger(binding.fencingGeneration) ||
      binding.fencingGeneration < 1 ||
      binding.candidateSha !== null ||
      intent.stage !== "identity-leases" ||
      intent.run_id !== binding.runId ||
      intent.work_order_id !== binding.workOrderId ||
      intent.attempt_id !== binding.attemptId ||
      intent.policy_digest !== binding.policyDigest ||
      !generationIsAuthorized ||
      intent.candidate_sha !== null
    ) {
      throw refusal(
        "malformed-input",
        "identity intent is not exact-bound to the pre-candidate run",
      );
    }
  }

  #parseProfiles(raw: AsfIdentityProfiles): AsfIdentityProfiles {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Object.keys(raw).sort().join("\u0000") !==
        ["implementer", "localReviewer", "prReviewer"].sort().join("\u0000") ||
      !validIdentifier(raw.implementer) ||
      !validIdentifier(raw.localReviewer) ||
      !validIdentifier(raw.prReviewer)
    ) {
      throw refusal(
        "profile-binding",
        "immutable policy returned malformed identity profiles",
      );
    }
    return Object.freeze({ ...raw });
  }

  #assertProfileIntent(
    input: AsfEffectInput,
    profiles: AsfIdentityProfiles,
  ): void {
    const expected = sha256Digest(json({ identities: profiles }));
    if (input.intent.operation_digest !== expected) {
      throw refusal(
        "profile-binding",
        "identity intent does not bind the resolved effective policy",
      );
    }
  }

  #assertLease(
    lease: IdentityLease,
    binding: AsfDeliveryBinding,
    role: AsfRequiredIdentityRole,
    profile: string,
  ): void {
    const issuedAt = Date.parse(lease.issuedAt);
    const expiresAt = Date.parse(lease.expiresAt);
    const now = this.#clock.now().getTime();
    if (
      !validIdentifier(lease.leaseId) ||
      !validIdentifier(lease.executionHandle) ||
      !validIdentifier(lease.provider) ||
      !validIdentifier(lease.principal) ||
      !validIdentifier(lease.profile) ||
      lease.runId !== binding.runId ||
      lease.workOrderId !== binding.workOrderId ||
      lease.attemptId !== binding.attemptId ||
      lease.policyDigest !== binding.policyDigest ||
      lease.fencingGeneration !== binding.fencingGeneration ||
      lease.role !== role ||
      lease.profile !== profile ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > this.#requestedDurationMs
    ) {
      throw refusal(
        "lease-binding",
        `broker returned a malformed or stale ${role} lease`,
      );
    }
  }

  #assertLeaseSet(leases: Map<AsfRequiredIdentityRole, IdentityLease>): void {
    const implementer = leases.get("implementer");
    const localReviewer = leases.get("local-reviewer");
    const prReviewer = leases.get("pr-reviewer");
    if (
      implementer === undefined ||
      localReviewer === undefined ||
      prReviewer === undefined
    ) {
      throw refusal(
        "lease-binding",
        "broker did not return exactly the three required roles",
      );
    }
    if (
      new Set([...leases.values()].map((lease) => lease.leaseId)).size !==
        leases.size ||
      new Set([...leases.values()].map((lease) => lease.executionHandle))
        .size !== leases.size
    ) {
      throw refusal(
        "identity-independence",
        "role leases reused protected capabilities",
      );
    }
    try {
      assertIndependentIdentityLeases(implementer, localReviewer);
      assertIndependentIdentityLeases(implementer, prReviewer);
    } catch {
      throw refusal(
        "identity-independence",
        "reviewer provider principals are not independent from the implementer",
      );
    }
  }

  #parseRestoredObservation(
    raw: JsonValue,
    binding: AsfDeliveryBinding,
  ): AsfIdentityAcquisitionObservation {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation is malformed",
      );
    }
    const record = raw as { readonly [key: string]: JsonValue };
    const exactObservationKeys = [
      "attributions",
      "attributions_digest",
      "binding",
      "evidence_digest",
      "roles",
      "schema",
    ]
      .sort()
      .join("\u0000");
    if (Object.keys(record).sort().join("\u0000") !== exactObservationKeys) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation is malformed",
      );
    }
    const rawBinding = record.binding;
    if (
      rawBinding === null ||
      typeof rawBinding !== "object" ||
      Array.isArray(rawBinding)
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation binding is malformed",
      );
    }
    const observedBinding = rawBinding as { readonly [key: string]: JsonValue };
    if (
      Object.keys(observedBinding).sort().join("\u0000") !==
        [
          "attempt_id",
          "candidate_sha",
          "fencing_generation",
          "policy_digest",
          "run_id",
          "work_order_id",
        ]
          .sort()
          .join("\u0000") ||
      observedBinding.run_id !== binding.runId ||
      observedBinding.work_order_id !== binding.workOrderId ||
      observedBinding.attempt_id !== binding.attemptId ||
      observedBinding.policy_digest !== binding.policyDigest ||
      observedBinding.fencing_generation !== binding.fencingGeneration ||
      observedBinding.candidate_sha !== null
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation binding is stale",
      );
    }
    if (
      record.schema !== "asf.identity-acquisition-observation/v1" ||
      !validDigest(record.attributions_digest) ||
      !validDigest(record.evidence_digest) ||
      !Array.isArray(record.roles) ||
      record.roles.length !== REQUIRED_IDENTITY_ROLES.length ||
      !record.roles.every(
        (role, index) => role === REQUIRED_IDENTITY_ROLES[index],
      ) ||
      !Array.isArray(record.attributions) ||
      record.attributions.length !== REQUIRED_IDENTITY_ROLES.length
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation is malformed",
      );
    }
    let attributions: AsfIdentityLeaseAttribution[];
    try {
      attributions = record.attributions.map((attribution) =>
        assertIdentityLeaseAttribution(
          observationBinding(binding),
          attribution,
        ),
      );
    } catch {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity attribution is malformed or contradictory",
      );
    }
    if (
      !attributions.every(
        (attribution, index) =>
          attribution.role === REQUIRED_IDENTITY_ROLES[index],
      ) ||
      identityAttributionsDigest(attributions) !== record.attributions_digest
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity attributions are incomplete or contradictory",
      );
    }
    const unsigned = {
      schema: "asf.identity-acquisition-observation/v1" as const,
      binding: observationBinding(binding),
      attributions_digest: record.attributions_digest,
      roles: Object.freeze([...REQUIRED_IDENTITY_ROLES]),
      attributions: Object.freeze(
        attributions.map((attribution) => Object.freeze(attribution)),
      ),
    };
    if (sha256Digest(json(unsigned)) !== record.evidence_digest) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity observation digest is contradictory",
      );
    }
    return Object.freeze({
      ...unsigned,
      evidence_digest: record.evidence_digest,
    });
  }

  async #persistSession(session: IdentitySession): Promise<void> {
    if (this.#protectedLeaseRegistry === undefined) return;
    const entries = [...session.allLeases]
      .map((lease) => {
        const leaseDigest = protectedIdentityLeaseDigest(lease);
        const currentRole = session.retiredLeases.has(lease)
          ? null
          : ([...session.leases].find(
              ([, candidate]) => candidate === lease,
            )?.[0] ?? null);
        return Object.freeze({
          leaseDigest,
          lease,
          currentRole,
          retired: session.retiredLeases.has(lease),
        });
      })
      .sort((left, right) => left.leaseDigest.localeCompare(right.leaseDigest));
    const pendingOperations = [...session.pendingOperations]
      .map((operation) => Object.freeze({ ...operation }))
      .sort((left, right) =>
        `${left.kind}\u0000${left.role}\u0000${left.leaseDigest ?? ""}`.localeCompare(
          `${right.kind}\u0000${right.role}\u0000${right.leaseDigest ?? ""}`,
        ),
      );
    const saved = await this.#protectedLeaseRegistry.save(
      {
        schema: PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
        binding: protectedBinding(session.binding),
        profiles: Object.freeze({ ...session.profiles }),
        phase: session.registryPhase,
        leases: Object.freeze(entries),
        pendingOperations: Object.freeze(pendingOperations),
        acquisitionObservation:
          session.observation === undefined ? null : json(session.observation),
      },
      session.registryRevision,
    );
    session.registryRevision = saved.revision;
  }

  async #beginProtectedOperation(
    session: IdentitySession,
    operation: ProtectedIdentityLeasePendingOperation,
  ): Promise<ProtectedIdentityLeasePendingOperation | undefined> {
    if (this.#protectedLeaseRegistry === undefined) return undefined;
    if (
      session.pendingOperations.some((pending) =>
        samePendingOperation(pending, operation),
      )
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity mutation marker is contradictory",
      );
    }
    const marker = Object.freeze({ ...operation });
    session.pendingOperations.push(marker);
    try {
      await this.#persistSession(session);
      return marker;
    } catch (error) {
      const index = session.pendingOperations.indexOf(marker);
      if (index >= 0) session.pendingOperations.splice(index, 1);
      throw error;
    }
  }

  async #completeProtectedOperation(
    session: IdentitySession,
    operation: ProtectedIdentityLeasePendingOperation | undefined,
  ): Promise<void> {
    if (operation === undefined) return;
    const index = session.pendingOperations.findIndex((pending) =>
      samePendingOperation(pending, operation),
    );
    if (index < 0) {
      throw refusal(
        "reconciliation-unavailable",
        "protected identity mutation marker disappeared before acknowledgement",
      );
    }
    const [removed] = session.pendingOperations.splice(index, 1);
    try {
      await this.#persistSession(session);
    } catch (error) {
      if (removed !== undefined)
        session.pendingOperations.splice(index, 0, removed);
      throw error;
    }
  }

  #observation(
    binding: AsfDeliveryBinding,
    leases: Map<AsfRequiredIdentityRole, IdentityLease>,
  ): AsfIdentityAcquisitionObservation {
    const observationBindingValue = observationBinding(binding);
    const attributions = REQUIRED_IDENTITY_ROLES.map((role) => {
      const lease = leases.get(role);
      if (lease === undefined) {
        throw refusal(
          "lease-binding",
          "required role lease disappeared before observation",
        );
      }
      const unsigned = {
        schema: ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
        role,
        provider: lease.provider,
        principal_id: lease.principal,
        profile: lease.profile,
        fencing_generation: lease.fencingGeneration,
        issued_at: lease.issuedAt,
        expires_at: lease.expiresAt,
      } as const;
      return Object.freeze({
        ...unsigned,
        lease_attribution_digest: identityLeaseAttributionDigest(
          observationBindingValue,
          unsigned,
        ),
      });
    });
    const attributionsDigest = identityAttributionsDigest(attributions);
    const unsigned = {
      schema: "asf.identity-acquisition-observation/v1" as const,
      binding: observationBindingValue,
      attributions_digest: attributionsDigest,
      roles: Object.freeze([...REQUIRED_IDENTITY_ROLES]),
      attributions: Object.freeze(attributions),
    };
    return Object.freeze({
      ...unsigned,
      evidence_digest: sha256Digest(json(unsigned)),
    });
  }

  #schedule(session: IdentitySession): void {
    session.task?.cancel();
    session.task = undefined;
    if (
      session.state !== "active" ||
      session.denied ||
      session.leases.size === 0
    )
      return;
    const now = this.#clock.now().getTime();
    const remaining = Math.min(
      ...[...session.leases.values()].map(
        (lease) => Date.parse(lease.expiresAt) - now,
      ),
    );
    const renewalDelay =
      remaining <= this.#renewalLeadMs
        ? Math.max(1, Math.floor(remaining / 2))
        : remaining - this.#renewalLeadMs;
    const delay = Math.max(
      1,
      Math.min(this.#fenceCheckIntervalMs, renewalDelay),
    );
    session.task = this.#scheduler.schedule(delay, () => this.#tick(session));
  }

  async #tick(session: IdentitySession): Promise<void> {
    session.task = undefined;
    if (session.state !== "active" || session.denied) return;
    try {
      if (!(await this.#isCurrent(session.binding))) {
        await this.#loseAuthority(session, "ownership-lost");
        return;
      }
      if (session.state !== "active" || session.denied) return;
      const now = this.#clock.now().getTime();
      if (
        [...session.leases.values()].some(
          (lease) => Date.parse(lease.expiresAt) <= now,
        )
      ) {
        await this.#loseAuthority(session, "lease-expired");
        return;
      }
      const renewalDue = [...session.leases.values()].some(
        (lease) => Date.parse(lease.expiresAt) - now <= this.#renewalLeadMs,
      );
      if (renewalDue) {
        await this.#renewAllRoles(session);
      }
      this.#schedule(session);
    } catch {
      if (session.denied) {
        await this.#revokeLeases(
          session,
          "late renewal after authority retirement",
        );
        return;
      }
      await this.#loseAuthority(session, "renewal-failed");
    }
  }

  async #renewAllRoles(session: IdentitySession): Promise<void> {
    for (const role of REQUIRED_IDENTITY_ROLES) {
      if (session.state !== "active" || session.denied) {
        throw refusal(
          "authority-unavailable",
          "identity authority retired during renewal",
        );
      }
      const current = session.leases.get(role);
      if (current === undefined)
        throw new Error("required identity lease is missing");
      const protectedOperation = await this.#beginProtectedOperation(session, {
        kind: "renew",
        role,
        leaseDigest: protectedIdentityLeaseDigest(current),
      });
      const renewal = this.#broker.renew(current);
      session.inFlightRenewal = renewal;
      let renewed: IdentityLease;
      try {
        renewed = await renewal;
      } catch (error) {
        const disposition = identityBrokerFailureDisposition(error);
        if (disposition !== undefined) {
          if (disposition === "retired") session.retiredLeases.add(current);
          await this.#completeProtectedOperation(session, protectedOperation);
        }
        throw error;
      } finally {
        if (session.inFlightRenewal === renewal)
          session.inFlightRenewal = undefined;
      }
      // Retain the returned snapshot before validating it. This lets a
      // concurrent cancellation or a malformed response retire the exact
      // capability the broker produced, including a superseded lease.
      const unchangedSnapshot =
        protectedIdentityLeaseDigest(renewed) ===
        protectedIdentityLeaseDigest(current);
      if (!unchangedSnapshot) session.allLeases.add(renewed);
      session.leases.set(role, unchangedSnapshot ? current : renewed);
      this.#assertLease(
        renewed,
        session.binding,
        role,
        profileFor(session.profiles, role),
      );
      // A validated renewal supersedes the snapshot supplied to renew.
      if (!unchangedSnapshot) session.retiredLeases.add(current);
      await this.#completeProtectedOperation(session, protectedOperation);
      if (session.state !== "active" || session.denied) {
        await this.#revokeLeases(
          session,
          "late renewal after authority retirement",
        );
        throw refusal(
          "authority-unavailable",
          "identity authority retired during renewal",
        );
      }
    }
    this.#assertLeaseSet(session.leases);
  }

  async #explicitRevoke(
    binding: AsfDeliveryBinding,
    cause: "cancellation" | "cleanup",
  ): Promise<void> {
    if (!(await this.#isCurrent(binding))) {
      throw refusal(
        "authority-unavailable",
        `current durable ownership is unproven for identity ${cause}`,
      );
    }
    let session = this.#sessions.get(binding.runId);
    const pending = this.#pending.get(binding.runId);
    if (pending !== undefined) {
      if (
        !sameIdentityScope(pending.binding, binding) ||
        pending.binding.fencingGeneration > binding.fencingGeneration ||
        (session !== undefined && session !== pending.session)
      ) {
        throw refusal(
          "reconciliation-unavailable",
          "pending identity authority contradicts the current cleanup fence",
        );
      }
      pending.denied = true;
      session = pending.session;
      // Do not race the acquisition's durable completion marker. Once denied,
      // its own completion path retains and retires every late broker return;
      // a rejected/unknown outcome intentionally leaves the acquire marker for
      // the exact-status refusal below.
      await pending.promise.catch(() => undefined);
      session = this.#sessions.get(binding.runId) ?? pending.session;
    }
    if (pending === undefined && this.#protectedLeaseRegistry !== undefined) {
      let protectedSession: IdentitySession | undefined;
      try {
        protectedSession = await this.#loadExplicitRevocationSession(
          binding,
          session,
        );
      } catch (error) {
        if (session !== undefined) {
          session.denied = true;
          session.state = "failed";
        }
        throw error;
      }
      if (protectedSession === undefined) {
        return;
      }
      if (protectedSession.registryPhase === "retired") {
        this.#sessions.set(binding.runId, protectedSession);
        return;
      }
      session = protectedSession;
      this.#sessions.set(binding.runId, session);
    }
    if (
      session === undefined ||
      !sameIdentityScope(session.binding, binding) ||
      session.binding.fencingGeneration > binding.fencingGeneration
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "no bounded protected lease session is available for this cleanup fence",
      );
    }
    if (session.pendingOperations.length > 0) {
      throw refusal(
        "reconciliation-unavailable",
        "a broker mutation crossed the last durable cleanup boundary; exact broker lookup/status is required",
      );
    }
    this.#assertProtectedPriorLeases(session);
    const complete = await this.#revokeAndDrainRenewal(session, cause);
    if (!complete) {
      await this.#notify(session, "revocation-incomplete", false);
      throw refusal(
        "revocation-incomplete",
        `not every role lease acknowledged ${cause}`,
      );
    }
  }

  async #loadExplicitRevocationSession(
    binding: AsfDeliveryBinding,
    inMemorySession: IdentitySession | undefined,
  ): Promise<IdentitySession | undefined> {
    if (this.#protectedLeaseRegistry === undefined) return undefined;
    let lineage: readonly ProtectedIdentityLeaseSnapshot[];
    try {
      lineage = await this.#protectedLeaseRegistry.loadLineage(
        protectedBinding(binding),
      );
    } catch {
      throw refusal(
        "reconciliation-unavailable",
        "protected cleanup lineage is missing, unreadable, or contradictory",
      );
    }
    if (lineage.length === 0) {
      throw refusal(
        "reconciliation-unavailable",
        "protected cleanup lineage has no authenticated identity snapshot",
      );
    }
    const generations = new Set<number>();
    for (const snapshot of lineage) {
      if (
        generations.has(snapshot.binding.fencingGeneration) ||
        snapshot.binding.runId !== binding.runId ||
        snapshot.binding.workOrderId !== binding.workOrderId ||
        snapshot.binding.attemptId !== binding.attemptId ||
        snapshot.binding.policyDigest !== binding.policyDigest ||
        snapshot.binding.fencingGeneration > binding.fencingGeneration
      ) {
        throw refusal(
          "reconciliation-unavailable",
          "protected cleanup lineage contains a future, duplicate, or differently bound snapshot",
        );
      }
      generations.add(snapshot.binding.fencingGeneration);
    }
    const unretired = lineage.filter(
      (snapshot) => snapshot.phase !== "retired",
    );
    if (unretired.length === 0 && inMemorySession === undefined) {
      return undefined;
    }
    if (unretired.length !== 1) {
      if (unretired.length > 1) {
        throw refusal(
          "reconciliation-unavailable",
          "protected cleanup lineage contains multiple unretired identity generations",
        );
      }
    }
    const snapshot =
      unretired[0] ??
      lineage.find(
        (candidate) =>
          candidate.binding.fencingGeneration ===
          inMemorySession?.binding.fencingGeneration,
      );
    if (snapshot === undefined) {
      throw refusal(
        "reconciliation-unavailable",
        "in-memory identity authority has no exact protected cleanup snapshot",
      );
    }
    if (snapshot.pendingOperations.length > 0) {
      throw refusal(
        "reconciliation-unavailable",
        "a protected broker mutation has unknown status; exact broker lookup/status is required",
      );
    }
    const protectedSessionBinding: AsfDeliveryBinding = {
      ...binding,
      fencingGeneration: snapshot.binding.fencingGeneration,
      candidateSha: null,
    };
    const session = this.#sessionFromProtectedSnapshot(
      snapshot,
      protectedSessionBinding,
    );
    this.#assertProtectedPriorLeases(session);
    if (
      inMemorySession !== undefined &&
      !this.#sameProtectedSessionState(inMemorySession, session)
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "in-memory identity authority contradicts its exact protected cleanup snapshot",
      );
    }
    return session;
  }

  async #loseAuthority(
    session: IdentitySession,
    reason: Exclude<
      AsfIdentityAuthorityLossReason,
      "acquisition-rollback-incomplete" | "revocation-incomplete"
    >,
  ): Promise<void> {
    const complete = await this.#revokeAndDrainRenewal(session, reason);
    await this.#notify(session, reason, complete);
  }

  async #revokeAndDrainRenewal(
    session: IdentitySession,
    cause: string,
  ): Promise<boolean> {
    session.denied = true;
    const inFlight = session.inFlightRenewal;
    const initial = await this.#revokeLeases(session, cause);
    if (inFlight === undefined) return initial;
    await inFlight.catch(() => undefined);
    return this.#revokeLeases(session, cause);
  }

  async #revokeLeases(
    session: IdentitySession,
    cause: string,
  ): Promise<boolean> {
    while (session.revokePromise !== undefined) {
      await session.revokePromise;
    }
    const operation = this.#performRevocation(session, cause);
    session.revokePromise = operation;
    try {
      return await operation;
    } finally {
      if (session.revokePromise === operation)
        session.revokePromise = undefined;
    }
  }

  async #performRevocation(
    session: IdentitySession,
    cause: string,
  ): Promise<boolean> {
    session.task?.cancel();
    session.task = undefined;
    this.#detachAbort(session);
    session.denied = true;
    session.state = "revoking";
    session.registryPhase = "revoking";
    let durable = true;
    try {
      await this.#persistSession(session);
    } catch {
      durable = false;
    }
    const pending = [...session.allLeases].filter(
      (lease) => !session.retiredLeases.has(lease),
    );
    const outcomes: boolean[] = [];
    for (const lease of pending) {
      const role =
        [...session.leases].find(([, candidate]) => candidate === lease)?.[0] ??
        (REQUIRED_IDENTITY_ROLES.includes(lease.role as AsfRequiredIdentityRole)
          ? (lease.role as AsfRequiredIdentityRole)
          : undefined);
      if (role === undefined) {
        outcomes.push(false);
        continue;
      }
      let protectedOperation:
        | ProtectedIdentityLeasePendingOperation
        | undefined;
      try {
        protectedOperation = await this.#beginProtectedOperation(session, {
          kind: "revoke",
          role,
          leaseDigest: protectedIdentityLeaseDigest(lease),
        });
      } catch {
        durable = false;
        outcomes.push(false);
        continue;
      }
      try {
        await this.#broker.revoke(lease, safeRevocationReason(cause));
        session.retiredLeases.add(lease);
        await this.#completeProtectedOperation(session, protectedOperation);
        outcomes.push(true);
      } catch (error) {
        const disposition = identityBrokerFailureDisposition(error);
        if (disposition === undefined) {
          // Unknown broker failures remain ambiguous until a provider-specific
          // exact lookup/status API resolves them.
          outcomes.push(false);
          continue;
        }
        if (disposition === "retired") session.retiredLeases.add(lease);
        try {
          await this.#completeProtectedOperation(session, protectedOperation);
          outcomes.push(disposition === "retired");
        } catch {
          durable = false;
          outcomes.push(false);
        }
      }
    }
    const complete =
      durable &&
      outcomes.every((outcome) => outcome) &&
      session.pendingOperations.length === 0 &&
      [...session.allLeases].every((lease) => session.retiredLeases.has(lease));
    session.state = complete ? "retired" : "failed";
    session.registryPhase = complete ? "retired" : "failed";
    try {
      await this.#persistSession(session);
    } catch {
      session.state = "failed";
      session.registryPhase = "failed";
      return false;
    }
    return complete;
  }

  async #abortBinding(binding: AsfDeliveryBinding): Promise<void> {
    const pending = this.#pending.get(binding.runId);
    if (
      pending !== undefined &&
      sameIdentityBinding(pending.binding, binding)
    ) {
      pending.denied = true;
      pending.session.denied = true;
      await this.#revokeLeases(pending.session, "cancelled");
      // An acquire call is still outside the controller boundary. Its outcome
      // is unknown until it returns, so reporting completed revocation here
      // would be an unsafe claim even when every lease seen so far retired.
      await this.#notify(pending.session, "cancelled", false);
      return;
    }
    const session = this.#sessions.get(binding.runId);
    if (
      session !== undefined &&
      sameIdentityBinding(session.binding, binding)
    ) {
      await this.#loseAuthority(session, "cancelled");
    }
  }

  #detachAbort(session: IdentitySession): void {
    for (const [signal, listener] of session.abortSubscriptions) {
      signal.removeEventListener("abort", listener);
    }
    session.abortSubscriptions.clear();
  }

  #attachAbort(session: IdentitySession, signal: AbortSignal): void {
    if (session.abortSubscriptions.has(signal)) return;
    const listener = (): void => {
      void this.#abortBinding(session.binding);
    };
    session.abortSubscriptions.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
    // Abort can race registration and EventTarget does not replay it.
    if (signal.aborted) listener();
  }

  async #notify(
    session: IdentitySession,
    reason: AsfIdentityAuthorityLossReason,
    revocationComplete: boolean,
  ): Promise<void> {
    if (session.notified) return;
    session.notified = true;
    try {
      await this.#onAuthorityLost(
        Object.freeze({
          binding: observationBinding(session.binding),
          reason,
          roles: Object.freeze([...REQUIRED_IDENTITY_ROLES]),
          revocationComplete,
        }),
      );
    } catch {
      // Notification cannot re-enable authority or prevent attempted revocation.
    }
  }

  async #isCurrent(binding: AsfDeliveryBinding): Promise<boolean> {
    try {
      return (
        (await this.#ownershipFence.isCurrent({
          runId: binding.runId,
          workOrderId: binding.workOrderId,
          attemptId: binding.attemptId,
          fencingGeneration: binding.fencingGeneration,
        })) === true
      );
    } catch {
      return false;
    }
  }

  #requireSession(binding: AsfDeliveryBinding): IdentitySession {
    const session = this.#sessions.get(binding.runId);
    if (
      session === undefined ||
      !sameIdentityBinding(session.binding, binding)
    ) {
      throw refusal(
        "reconciliation-unavailable",
        "no exact protected lease session is available for this binding",
      );
    }
    return session;
  }
}
