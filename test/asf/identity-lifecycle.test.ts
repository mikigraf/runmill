import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AsfIdentityLifecycleController,
  AsfIdentityLifecycleRefusalError,
  type AsfIdentityAuthorityLoss,
  type AsfIdentityLifecycleScheduler,
  type AsfIdentityLifecycleTask,
  type AsfIdentityProfiles,
} from "../../src/asf/identity-lifecycle.js";
import { sha256Digest, type JsonValue } from "../../src/asf/canonical-json.js";
import type {
  AsfDeliveryBinding,
  AsfEffectInput,
} from "../../src/asf/delivery-runner.js";
import type {
  IdentityLease,
  IdentityLeaseRequest,
  IdentityOwnershipFence,
  IdentityOwnershipFenceValidator,
  LeaseDisposition,
  ProviderIdentityBroker,
} from "../../src/identity/broker.js";
import { markDefinitiveIdentityBrokerFailure } from "../../src/identity/broker.js";
import {
  EncryptedFileIdentityLeaseRegistry,
  PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
  protectedIdentityLeaseDigest,
  type ProtectedIdentityLeaseRegistry,
} from "../../src/identity/protected-lease-registry.js";
import {
  FakeProviderIdentityBroker,
  type FakeIdentityGrant,
} from "../../src/testing/fake-identity-broker.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";
const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;
const PROFILES: AsfIdentityProfiles = {
  implementer: "codex:production",
  localReviewer: "claude:local-review",
  prReviewer: "claude:pr-review",
};

const GRANTS: readonly FakeIdentityGrant[] = [
  {
    role: "implementer",
    profile: PROFILES.implementer,
    provider: "openai",
    principal: "implementation-principal",
    maxDurationMs: 10_000,
  },
  {
    role: "local-reviewer",
    profile: PROFILES.localReviewer,
    provider: "anthropic",
    principal: "local-review-principal",
    maxDurationMs: 10_000,
  },
  {
    role: "pr-reviewer",
    profile: PROFILES.prReviewer,
    provider: "anthropic",
    principal: "pr-review-principal",
    maxDurationMs: 10_000,
  },
];

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

class MutableFence implements IdentityOwnershipFenceValidator {
  current = true;
  currentGeneration: number | null = null;
  readonly observations: IdentityOwnershipFence[] = [];

  isCurrent(fence: IdentityOwnershipFence): boolean {
    this.observations.push({ ...fence });
    return (
      this.current &&
      (this.currentGeneration === null ||
        fence.fencingGeneration === this.currentGeneration)
    );
  }
}

interface ScheduledEntry extends AsfIdentityLifecycleTask {
  readonly delayMs: number;
  readonly task: () => void | Promise<void>;
  cancelled: boolean;
}

class ManualScheduler implements AsfIdentityLifecycleScheduler {
  readonly entries: ScheduledEntry[] = [];

  schedule(
    delayMs: number,
    task: () => void | Promise<void>,
  ): AsfIdentityLifecycleTask {
    const entry: ScheduledEntry = {
      delayMs,
      task,
      cancelled: false,
      cancel() {
        entry.cancelled = true;
      },
    };
    this.entries.push(entry);
    return entry;
  }

  async runNext(): Promise<void> {
    const index = this.entries.findIndex((entry) => !entry.cancelled);
    if (index < 0) throw new Error("no live identity lifecycle task");
    const [entry] = this.entries.splice(index, 1);
    if (entry === undefined) throw new Error("scheduled task disappeared");
    entry.cancelled = true;
    await entry.task();
  }
}

class DeferredAcquireBroker implements ProviderIdentityBroker {
  readonly started: Promise<void>;
  readonly #inner: ProviderIdentityBroker;
  readonly #markStarted: () => void;
  readonly #resume: Promise<void>;
  readonly #release: () => void;

  constructor(inner: ProviderIdentityBroker) {
    this.#inner = inner;
    let markStarted: (() => void) | undefined;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    this.#resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (markStarted === undefined || release === undefined) {
      throw new Error("deferred broker promises were not initialized");
    }
    this.#markStarted = markStarted;
    this.#release = release;
  }

  release(): void {
    this.#release();
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    const lease = await this.#inner.acquire(request);
    if (request.role === "local-reviewer") {
      this.#markStarted();
      await this.#resume;
    }
    return lease;
  }

  renew(lease: IdentityLease): Promise<IdentityLease> {
    return this.#inner.renew(lease);
  }

  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    return this.#inner.close(lease, disposition);
  }

  revoke(lease: IdentityLease, reason: string): Promise<void> {
    return this.#inner.revoke(lease, reason);
  }
}

class DeferredRenewBroker implements ProviderIdentityBroker {
  readonly started: Promise<void>;
  readonly #inner: ProviderIdentityBroker;
  readonly #markStarted: () => void;
  readonly #resume: Promise<void>;
  readonly #release: () => void;

  constructor(inner: ProviderIdentityBroker) {
    this.#inner = inner;
    let markStarted: (() => void) | undefined;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    this.#resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (markStarted === undefined || release === undefined) {
      throw new Error("deferred broker promises were not initialized");
    }
    this.#markStarted = markStarted;
    this.#release = release;
  }

  release(): void {
    this.#release();
  }

  acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    return this.#inner.acquire(request);
  }

  async renew(lease: IdentityLease): Promise<IdentityLease> {
    const renewed = await this.#inner.renew(lease);
    this.#markStarted();
    await this.#resume;
    return renewed;
  }

  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    return this.#inner.close(lease, disposition);
  }

  revoke(lease: IdentityLease, reason: string): Promise<void> {
    return this.#inner.revoke(lease, reason);
  }
}

class MalformedAcquireBroker implements ProviderIdentityBroker {
  readonly revokedReturns: IdentityLease[] = [];
  readonly #inner: ProviderIdentityBroker;

  constructor(inner: ProviderIdentityBroker) {
    this.#inner = inner;
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    const lease = await this.#inner.acquire(request);
    if (request.role !== "local-reviewer") return lease;
    return Object.freeze({
      ...lease,
      attemptId: "broker-returned-wrong-attempt",
    });
  }

  renew(lease: IdentityLease): Promise<IdentityLease> {
    return this.#inner.renew(lease);
  }

  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    return this.#inner.close(lease, disposition);
  }

  revoke(lease: IdentityLease, reason: string): Promise<void> {
    this.revokedReturns.push(lease);
    return this.#inner.revoke(lease, reason);
  }
}

/** Models a process dying after ctxlane applied acquire but before its response was retained. */
class LostAcquireResponseBroker implements ProviderIdentityBroker {
  readonly #inner: ProviderIdentityBroker;

  constructor(inner: ProviderIdentityBroker) {
    this.#inner = inner;
  }

  async acquire(request: IdentityLeaseRequest): Promise<IdentityLease> {
    await this.#inner.acquire(request);
    throw new Error("simulated lost acquire response");
  }

  renew(lease: IdentityLease): Promise<IdentityLease> {
    return this.#inner.renew(lease);
  }

  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    return this.#inner.close(lease, disposition);
  }

  revoke(lease: IdentityLease, reason: string): Promise<void> {
    return this.#inner.revoke(lease, reason);
  }
}

class DefinitiveAcquireFailureBroker implements ProviderIdentityBroker {
  readonly #inner: ProviderIdentityBroker;

  constructor(inner: ProviderIdentityBroker) {
    this.#inner = inner;
  }

  acquire(_request: IdentityLeaseRequest): Promise<IdentityLease> {
    return Promise.reject(
      markDefinitiveIdentityBrokerFailure(
        new Error("simulated correlated refusal"),
        "unchanged",
      ),
    );
  }

  renew(lease: IdentityLease): Promise<IdentityLease> {
    return this.#inner.renew(lease);
  }

  close(lease: IdentityLease, disposition: LeaseDisposition): Promise<void> {
    return this.#inner.close(lease, disposition);
  }

  revoke(lease: IdentityLease, reason: string): Promise<void> {
    return this.#inner.revoke(lease, reason);
  }
}

function binding(
  overrides: Partial<AsfDeliveryBinding> = {},
): AsfDeliveryBinding {
  return {
    runId: "run-identity-01",
    workOrderId: "wo-identity-01",
    attemptId: "attempt-identity-01",
    policyDigest: POLICY_DIGEST,
    fencingGeneration: 7,
    candidateSha: null,
    ...overrides,
  };
}

function effectInput(
  overrides: Partial<AsfEffectInput> = {},
  identityProfiles: AsfIdentityProfiles = PROFILES,
): AsfEffectInput {
  const exactBinding = overrides.binding ?? binding();
  const operationDigest = sha256Digest(json({ identities: identityProfiles }));
  const unsignedIntent = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: "delivery_identity_01",
    effect_key: "delivery_effect_identity_01",
    stage: "identity-leases" as const,
    run_id: exactBinding.runId,
    work_order_id: exactBinding.workOrderId,
    attempt_id: exactBinding.attemptId,
    policy_digest: exactBinding.policyDigest,
    fencing_generation: exactBinding.fencingGeneration,
    candidate_sha: exactBinding.candidateSha,
    event_seq: 2,
    operation_digest: operationDigest,
    created_at: NOW,
  };
  return {
    binding: exactBinding,
    intent: {
      ...unsignedIntent,
      intent_digest: sha256Digest(json(unsignedIntent)),
    },
    intentMode: "observe-before-apply",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function generationRecoveryEffectInput(
  priorGeneration: number,
  currentGeneration: number,
): AsfEffectInput {
  const prior = effectInput({
    binding: binding({ fencingGeneration: priorGeneration }),
  });
  return {
    ...prior,
    binding: binding({ fencingGeneration: currentGeneration }),
    intentMode: "reconcile-only",
  };
}

function setup(
  options: {
    readonly grants?: readonly FakeIdentityGrant[];
    readonly profiles?: AsfIdentityProfiles;
    readonly broker?: FakeProviderIdentityBroker;
    readonly clock?: FakeClock;
    readonly fence?: MutableFence;
    readonly registry?: ProtectedIdentityLeaseRegistry;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(NOW);
  const fence = options.fence ?? new MutableFence();
  const scheduler = new ManualScheduler();
  const authorityLosses: AsfIdentityAuthorityLoss[] = [];
  const broker =
    options.broker ??
    new FakeProviderIdentityBroker(clock, options.grants ?? GRANTS, fence);
  const controller = new AsfIdentityLifecycleController({
    broker,
    clock,
    ownershipFence: fence,
    profiles: { resolve: () => options.profiles ?? PROFILES },
    requestedDurationMs: 10_000,
    renewalLeadMs: 4_000,
    fenceCheckIntervalMs: 2_000,
    scheduler,
    protectedLeaseRegistry: options.registry,
    onAuthorityLost: (event) => {
      authorityLosses.push(event);
    },
  });
  return { authorityLosses, broker, clock, controller, fence, scheduler };
}

function protectedRegistryFixture(clock: FakeClock): {
  readonly directory: string;
  readonly registry: EncryptedFileIdentityLeaseRegistry;
  readonly remove: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "runmill-identity-lifecycle-"));
  chmodSync(root, 0o700);
  const directory = join(root, "sealed");
  mkdirSync(directory, { mode: 0o700 });
  return {
    directory,
    registry: new EncryptedFileIdentityLeaseRegistry({
      directory,
      keyId: "identity-registry-test-key",
      key: Buffer.alloc(32, 0x5a),
      clock,
    }),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function restartableController(input: {
  readonly broker: ProviderIdentityBroker;
  readonly clock: FakeClock;
  readonly fence: MutableFence;
  readonly registry: ProtectedIdentityLeaseRegistry;
  readonly scheduler?: ManualScheduler;
  readonly authorityLosses?: AsfIdentityAuthorityLoss[];
}): AsfIdentityLifecycleController {
  return new AsfIdentityLifecycleController({
    broker: input.broker,
    clock: input.clock,
    ownershipFence: input.fence,
    profiles: { resolve: () => PROFILES },
    requestedDurationMs: 10_000,
    renewalLeadMs: 4_000,
    fenceCheckIntervalMs: 2_000,
    scheduler: input.scheduler ?? new ManualScheduler(),
    protectedLeaseRegistry: input.registry,
    onAuthorityLost: (event) => {
      input.authorityLosses?.push(event);
    },
  });
}

const CLEAN_ACQUIRING_ROLES = [
  "implementer",
  "local-reviewer",
  "pr-reviewer",
] as const;

async function seedCleanAcquiringSnapshot(input: {
  readonly count: 0 | 1 | 2;
  readonly broker: ProviderIdentityBroker;
  readonly registry: ProtectedIdentityLeaseRegistry;
}): Promise<readonly IdentityLease[]> {
  const exact = binding();
  const leases: IdentityLease[] = [];
  for (const role of CLEAN_ACQUIRING_ROLES.slice(0, input.count)) {
    leases.push(
      await input.broker.acquire({
        runId: exact.runId,
        workOrderId: exact.workOrderId,
        attemptId: exact.attemptId,
        role,
        requestedProfile:
          role === "implementer"
            ? PROFILES.implementer
            : role === "local-reviewer"
              ? PROFILES.localReviewer
              : PROFILES.prReviewer,
        policyDigest: exact.policyDigest,
        fencingGeneration: exact.fencingGeneration,
        requestedDurationMs: 10_000,
      }),
    );
  }
  await input.registry.save(
    {
      schema: PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
      binding: {
        runId: exact.runId,
        workOrderId: exact.workOrderId,
        attemptId: exact.attemptId,
        policyDigest: exact.policyDigest,
        fencingGeneration: exact.fencingGeneration,
      },
      profiles: PROFILES,
      phase: "acquiring",
      leases: leases.map((lease) => ({
        leaseDigest: protectedIdentityLeaseDigest(lease),
        lease,
        currentRole: lease.role as (typeof CLEAN_ACQUIRING_ROLES)[number],
        retired: false,
      })),
      pendingOperations: [],
      acquisitionObservation: null,
    },
    null,
  );
  return leases;
}

describe("AsfIdentityLifecycleController", () => {
  it("acquires exactly three bound roles without returning protected lease capabilities", async () => {
    const test = setup();
    const observation =
      await test.controller.acquireRequiredRoles(effectInput());

    expect(test.broker.calls.filter((call) => call.op === "acquire")).toEqual([
      expect.objectContaining({
        role: "implementer",
        profile: PROFILES.implementer,
      }),
      expect.objectContaining({
        role: "local-reviewer",
        profile: PROFILES.localReviewer,
      }),
      expect.objectContaining({
        role: "pr-reviewer",
        profile: PROFILES.prReviewer,
      }),
    ]);
    expect(observation).toMatchObject({
      schema: "asf.identity-acquisition-observation/v1",
      binding: {
        run_id: "run-identity-01",
        work_order_id: "wo-identity-01",
        attempt_id: "attempt-identity-01",
        policy_digest: POLICY_DIGEST,
        fencing_generation: 7,
        candidate_sha: null,
      },
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
    });
    expect(
      observation.attributions.map((attribution) => attribution.role),
    ).toEqual(observation.roles);
    expect(observation.attributions_digest).toBe(
      sha256Digest(json(observation.attributions)),
    );
    expect(observation.evidence_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("fake-provider-execution");
    expect(serialized).not.toContain("fake-identity-lease");
    expect(serialized).not.toContain("lease_id");
    expect(serialized).not.toMatch(/credential|token|provider.home/iu);
    expect(
      observation.attributions.every(
        (attribution) => Object.keys(attribution).length === 9,
      ),
    ).toBe(true);
  });

  it("renews all roles before expiry and permits protected use after candidate creation", async () => {
    const test = setup();
    await test.controller.acquireRequiredRoles(effectInput());

    test.clock.advanceMs(6_000);
    await test.scheduler.runNext();
    expect(
      test.broker.calls.filter((call) => call.op === "renew"),
    ).toHaveLength(3);

    const expiresAt = await test.controller.withLease(
      binding({ candidateSha: "b".repeat(40) }),
      "pr-reviewer",
      (lease) => lease.expiresAt,
    );
    expect(expiresAt).toBe("2026-08-21T10:00:16.000Z");
    expect(test.controller.status(binding().runId)).toMatchObject({
      state: "active",
    });
  });

  it("drains and revokes a renewal that returns during cleanup", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const scheduler = new ManualScheduler();
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const broker = new DeferredRenewBroker(inner);
    const controller = new AsfIdentityLifecycleController({
      broker,
      clock,
      ownershipFence: fence,
      profiles: { resolve: () => PROFILES },
      requestedDurationMs: 10_000,
      renewalLeadMs: 4_000,
      fenceCheckIntervalMs: 2_000,
      scheduler,
      onAuthorityLost: () => undefined,
    });
    await controller.acquireRequiredRoles(effectInput());
    clock.advanceMs(6_000);
    const renewalTick = scheduler.runNext();
    await broker.started;

    let cleanupSettled = false;
    const cleanup = controller.cleanup(binding()).finally(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    broker.release();
    await Promise.all([renewalTick, cleanup]);

    expect(inner.calls.filter((call) => call.op === "renew")).toHaveLength(1);
    expect(inner.calls.filter((call) => call.op === "revoke")).toEqual([
      expect.objectContaining({ role: "implementer" }),
      expect.objectContaining({ role: "local-reviewer" }),
      expect.objectContaining({ role: "pr-reviewer" }),
      expect.objectContaining({ role: "implementer" }),
    ]);
    expect(controller.status(binding().runId)).toMatchObject({
      state: "retired",
      retiredRoles: ["implementer", "local-reviewer", "pr-reviewer"],
    });
    await expect(
      controller.withLease(binding(), "implementer", () => undefined),
    ).rejects.toThrow(/not active/u);
  });

  it("revokes every role and aborts authority when durable ownership is lost", async () => {
    const test = setup();
    await test.controller.acquireRequiredRoles(effectInput());
    test.fence.current = false;

    await test.scheduler.runNext();

    expect(
      test.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(3);
    expect(test.controller.status(binding().runId)).toMatchObject({
      state: "retired",
      retiredRoles: ["implementer", "local-reviewer", "pr-reviewer"],
    });
    expect(test.authorityLosses).toEqual([
      expect.objectContaining({
        reason: "ownership-lost",
        revocationComplete: true,
      }),
    ]);
    await expect(
      test.controller.withLease(binding(), "implementer", () => undefined),
    ).rejects.toThrow(/not active/u);
  });

  it("fails closed after wall-clock expiry and attempts every revocation", async () => {
    const test = setup();
    await test.controller.acquireRequiredRoles(effectInput());
    test.clock.simulateSuspend(10_001);

    await test.scheduler.runNext();

    // The restrictive fake rejects late revocation, while the ctxlane broker can
    // still send it. The controller attempts all roles and reports the ambiguity.
    expect(
      test.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(3);
    expect(test.controller.status(binding().runId)).toMatchObject({
      state: "failed",
    });
    expect(test.authorityLosses).toEqual([
      expect.objectContaining({
        reason: "lease-expired",
        revocationComplete: false,
      }),
    ]);
  });

  it("revokes all acquired leases when reviewer independence cannot be proven", async () => {
    const conflicted = GRANTS.map((grant) =>
      grant.role === "local-reviewer"
        ? {
            ...grant,
            provider: "openai",
            principal: "implementation-principal",
          }
        : grant,
    );
    const test = setup({ grants: conflicted });

    await expect(
      test.controller.acquireRequiredRoles(effectInput()),
    ).rejects.toMatchObject({
      reason: "identity-independence",
    });
    expect(
      test.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(3);
    expect(test.controller.status(binding().runId)).toMatchObject({
      state: "retired",
    });
  });

  it("rolls back every partial acquisition before returning a safe failure", async () => {
    const test = setup({ grants: GRANTS.slice(0, 2) });

    await expect(
      test.controller.acquireRequiredRoles(effectInput()),
    ).rejects.toThrow(AsfIdentityLifecycleRefusalError);
    expect(
      test.broker.calls.filter((call) => call.op === "acquire"),
    ).toHaveLength(3);
    expect(
      test.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(2);
    expect(JSON.stringify(test.broker.calls)).not.toContain(
      "fake-provider-execution",
    );
  });

  it("denies abort and cleanup during acquisition, then revokes a late lease", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const scheduler = new ManualScheduler();
    const authorityLosses: AsfIdentityAuthorityLoss[] = [];
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const broker = new DeferredAcquireBroker(inner);
    const controller = new AsfIdentityLifecycleController({
      broker,
      clock,
      ownershipFence: fence,
      profiles: { resolve: () => PROFILES },
      requestedDurationMs: 10_000,
      renewalLeadMs: 4_000,
      fenceCheckIntervalMs: 2_000,
      scheduler,
      onAuthorityLost: (event) => {
        authorityLosses.push(event);
      },
    });
    const abort = new AbortController();
    const acquisition = controller.acquireRequiredRoles(
      effectInput({ signal: abort.signal }),
    );
    await broker.started;

    abort.abort();
    const cleanup = controller.cleanup(binding());
    broker.release();

    await expect(acquisition).rejects.toMatchObject({
      reason: "authority-unavailable",
    });
    await cleanup;
    expect(inner.calls.filter((call) => call.op === "acquire")).toEqual([
      expect.objectContaining({ role: "implementer" }),
      expect.objectContaining({ role: "local-reviewer" }),
    ]);
    expect(inner.calls.filter((call) => call.op === "revoke")).toEqual([
      expect.objectContaining({ role: "implementer" }),
      expect.objectContaining({ role: "local-reviewer" }),
    ]);
    expect(controller.status(binding().runId)).toMatchObject({
      state: "retired",
      retiredRoles: ["implementer", "local-reviewer"],
    });
    expect(authorityLosses).toEqual([
      expect.objectContaining({
        reason: "cancelled",
        roles: ["implementer", "local-reviewer", "pr-reviewer"],
        revocationComplete: false,
      }),
    ]);
    await expect(
      controller.withLease(binding(), "implementer", () => undefined),
    ).rejects.toThrow(/not active/u);
  });

  it("tracks malformed broker returns and exposes unresolved revocation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const authorityLosses: AsfIdentityAuthorityLoss[] = [];
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const broker = new MalformedAcquireBroker(inner);
    const controller = new AsfIdentityLifecycleController({
      broker,
      clock,
      ownershipFence: fence,
      profiles: { resolve: () => PROFILES },
      requestedDurationMs: 10_000,
      renewalLeadMs: 4_000,
      fenceCheckIntervalMs: 2_000,
      scheduler: new ManualScheduler(),
      onAuthorityLost: (event) => {
        authorityLosses.push(event);
      },
    });

    await expect(
      controller.acquireRequiredRoles(effectInput()),
    ).rejects.toMatchObject({
      reason: "lease-binding",
    });
    expect(broker.revokedReturns).toEqual([
      expect.objectContaining({
        role: "implementer",
        attemptId: binding().attemptId,
      }),
      expect.objectContaining({
        role: "local-reviewer",
        attemptId: "broker-returned-wrong-attempt",
      }),
    ]);
    expect(inner.calls.filter((call) => call.op === "revoke")).toHaveLength(2);
    expect(controller.status(binding().runId)).toMatchObject({
      state: "failed",
      roles: ["implementer", "local-reviewer"],
      retiredRoles: ["implementer"],
    });
    expect(authorityLosses).toEqual([
      expect.objectContaining({
        reason: "acquisition-rollback-incomplete",
        revocationComplete: false,
      }),
    ]);
    await expect(
      controller.withLease(binding(), "implementer", () => undefined),
    ).rejects.toThrow(/not active/u);
  });

  it("restores a clean exact lease set after process restart and confirms it through renewal", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const acquired = await first.acquireRequiredRoles(effectInput());

      // A new controller has no in-memory session. Reconcile-only must recover
      // from the sealed exact snapshot and must not acquire a duplicate role.
      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const recovered = await restarted.acquireRequiredRoles(
        effectInput({ intentMode: "reconcile-only" }),
      );

      expect(recovered).toEqual(acquired);
      expect(broker.calls.filter((call) => call.op === "acquire")).toHaveLength(
        3,
      );
      expect(broker.calls.filter((call) => call.op === "renew")).toHaveLength(
        3,
      );
      await expect(
        restarted.withLease(binding(), "local-reviewer", (lease) => lease.role),
      ).resolves.toBe("local-reviewer");
      const sealed = readFileSync(
        join(
          protectedState.directory,
          readdirSync(protectedState.directory)[0] ?? "missing",
        ),
        "utf8",
      );
      expect(sealed).not.toContain("fake-identity-lease");
      expect(sealed).not.toContain("fake-provider-execution");
      expect(JSON.stringify(recovered)).not.toMatch(
        /leaseId|executionHandle|lease_id/iu,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("retires exact generation-7 leases before acquiring fresh generation-8 roles", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const recovered = await restarted.acquireRequiredRoles(
        generationRecoveryEffectInput(7, 8),
      );

      expect(recovered.binding.fencing_generation).toBe(8);
      expect(
        recovered.attributions.every(
          (attribution) => attribution.fencing_generation === 8,
        ),
      ).toBe(true);
      expect(
        broker.calls.map((call) => `${call.op}:${call.fencingGeneration}`),
      ).toEqual([
        "acquire:7",
        "acquire:7",
        "acquire:7",
        "revoke:7",
        "revoke:7",
        "revoke:7",
        "acquire:8",
        "acquire:8",
        "acquire:8",
      ]);
      expect(broker.calls.some((call) => call.op === "renew")).toBe(false);
      await expect(
        restarted.withLease(
          binding({ fencingGeneration: 8 }),
          "implementer",
          (lease) => lease.fencingGeneration,
        ),
      ).resolves.toBe(8);
      await expect(
        restarted.withLease(binding(), "implementer", () => undefined),
      ).rejects.toThrow(/exact protected lease session/u);
    } finally {
      protectedState.remove();
    }
  });

  it("retires the exact durable generation-7 identity intent after an empty generation-8 claim crash and acquires generation-9 roles", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      // Generation 8 claimed the run but crashed before the identity
      // controller's initial protected persist, so the exact durable identity
      // intent and sole unretired protected session both remain generation 7.
      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const recovered = await restarted.acquireRequiredRoles(
        generationRecoveryEffectInput(7, 9),
      );

      expect(recovered.binding.fencing_generation).toBe(9);
      expect(
        broker.calls.map((call) => `${call.op}:${call.fencingGeneration}`),
      ).toEqual([
        "acquire:7",
        "acquire:7",
        "acquire:7",
        "revoke:7",
        "revoke:7",
        "revoke:7",
        "acquire:9",
        "acquire:9",
        "acquire:9",
      ]);
      expect(
        await protectedState.registry.load({
          runId: binding().runId,
          workOrderId: binding().workOrderId,
          attemptId: binding().attemptId,
          policyDigest: binding().policyDigest,
          fencingGeneration: 7,
        }),
      ).toMatchObject({ phase: "retired", pendingOperations: [] });
    } finally {
      protectedState.remove();
    }
  });

  it("continues generation-8 acquisition after generation-7 retirement was durably acknowledged", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());
      await first.cleanup(binding());

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).resolves.toMatchObject({
        binding: { fencing_generation: 8 },
      });
      expect(
        broker.calls.map((call) => `${call.op}:${call.fencingGeneration}`),
      ).toEqual([
        "acquire:7",
        "acquire:7",
        "acquire:7",
        "revoke:7",
        "revoke:7",
        "revoke:7",
        "acquire:8",
        "acquire:8",
        "acquire:8",
      ]);
    } finally {
      protectedState.remove();
    }
  });

  it("recovers the clean current generation while durable intent still names its predecessor", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());
      const takeover = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await takeover.acquireRequiredRoles(generationRecoveryEffectInput(7, 8));

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).resolves.toMatchObject({
        binding: { fencing_generation: 8 },
      });
      expect(broker.calls.filter((call) => call.op === "acquire")).toHaveLength(
        6,
      );
      expect(broker.calls.filter((call) => call.op === "revoke")).toHaveLength(
        3,
      );
      expect(broker.calls.filter((call) => call.op === "renew")).toHaveLength(
        3,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("refuses a pending current-generation mutation while durable intent names its predecessor", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker: inner,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      const lostResponse = new LostAcquireResponseBroker(inner);
      const takeover = restartableController({
        broker: lostResponse,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        takeover.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({ reason: "authority-unavailable" });
      const callsBeforeRestart = inner.calls.length;

      const restarted = restartableController({
        broker: inner,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/exact broker lookup\/status/u),
      });
      expect(inner.calls).toHaveLength(callsBeforeRestart);
    } finally {
      protectedState.remove();
    }
  });

  it("refuses multiple live protected generations before any recovery broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      for (const generation of [6, 7]) {
        const seedingBroker = new FakeProviderIdentityBroker(
          clock,
          GRANTS,
          fence,
        );
        const seeding = restartableController({
          broker: seedingBroker,
          clock,
          fence,
          registry: protectedState.registry,
        });
        await seeding.acquireRequiredRoles(
          effectInput({ binding: binding({ fencingGeneration: generation }) }),
        );
      }

      const recoveryBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const restarted = restartableController({
        broker: recoveryBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/multiple, future, or contradictory/u),
      });
      expect(recoveryBroker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it("refuses a future protected generation before any recovery broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      const futureBroker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
      const future = restartableController({
        broker: futureBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await future.acquireRequiredRoles(
        effectInput({ binding: binding({ fencingGeneration: 9 }) }),
      );

      const recoveryBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const restarted = restartableController({
        broker: recoveryBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/multiple, future, or contradictory/u),
      });
      expect(recoveryBroker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it.each([
    { boundary: "initial acquiring persist", knownLeaseCount: 0 as const },
    { boundary: "first acquire marker cleared", knownLeaseCount: 1 as const },
    { boundary: "second acquire marker cleared", knownLeaseCount: 2 as const },
  ])(
    "retires a clean prior-generation $boundary and acquires all current roles",
    async ({ knownLeaseCount }) => {
      const clock = new FakeClock(NOW);
      const fence = new MutableFence();
      const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
      const protectedState = protectedRegistryFixture(clock);
      try {
        const known = await seedCleanAcquiringSnapshot({
          count: knownLeaseCount,
          broker,
          registry: protectedState.registry,
        });
        const restarted = restartableController({
          broker,
          clock,
          fence,
          registry: protectedState.registry,
        });

        const recovered = await restarted.acquireRequiredRoles(
          generationRecoveryEffectInput(7, 8),
        );

        expect(recovered.binding.fencing_generation).toBe(8);
        expect(
          recovered.attributions.map((attribution) => attribution.role),
        ).toEqual([...CLEAN_ACQUIRING_ROLES]);
        const revocations = broker.calls.filter((call) => call.op === "revoke");
        expect(revocations).toHaveLength(knownLeaseCount);
        expect(revocations.map((call) => call.role).sort()).toEqual(
          known.map((lease) => lease.role).sort(),
        );
        expect(
          broker.calls.filter(
            (call) => call.op === "acquire" && call.fencingGeneration === 8,
          ),
        ).toHaveLength(3);
        const firstCurrentAcquire = broker.calls.findIndex(
          (call) => call.op === "acquire" && call.fencingGeneration === 8,
        );
        expect(
          broker.calls
            .slice(firstCurrentAcquire)
            .some(
              (call) => call.op === "revoke" && call.fencingGeneration === 7,
            ),
        ).toBe(false);

        const retired = await protectedState.registry.load({
          runId: binding().runId,
          workOrderId: binding().workOrderId,
          attemptId: binding().attemptId,
          policyDigest: binding().policyDigest,
          fencingGeneration: 7,
        });
        expect(retired).toMatchObject({
          phase: "retired",
          pendingOperations: [],
        });
        expect(retired?.leases.every((entry) => entry.retired)).toBe(true);
      } finally {
        protectedState.remove();
      }
    },
  );

  it("refuses contradictory duplicate acquiring history before broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      await seedCleanAcquiringSnapshot({
        count: 1,
        broker,
        registry: protectedState.registry,
      });
      const prior = await protectedState.registry.load({
        runId: binding().runId,
        workOrderId: binding().workOrderId,
        attemptId: binding().attemptId,
        policyDigest: binding().policyDigest,
        fencingGeneration: 7,
      });
      const first = prior?.leases[0];
      if (prior === null || first === undefined) {
        throw new Error("contradictory history fixture was not persisted");
      }
      const duplicate = Object.freeze({
        ...first.lease,
        leaseId: `${first.lease.leaseId}-duplicate` as IdentityLease["leaseId"],
        executionHandle:
          `${first.lease.executionHandle}-duplicate` as IdentityLease["executionHandle"],
      });
      await protectedState.registry.save(
        {
          schema: prior.schema,
          binding: prior.binding,
          profiles: prior.profiles,
          phase: "acquiring",
          leases: [
            ...prior.leases,
            {
              leaseDigest: protectedIdentityLeaseDigest(duplicate),
              lease: duplicate,
              currentRole: null,
              retired: false,
            },
          ],
          pendingOperations: [],
          acquisitionObservation: null,
        },
        prior.revision,
      );
      const callsBeforeRecovery = broker.calls.length;
      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });

      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(broker.calls).toHaveLength(callsBeforeRecovery);
    } finally {
      protectedState.remove();
    }
  });

  it("refuses a non-prefix reviewer-only acquiring snapshot before broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const exact = binding();
      const reviewer = await broker.acquire({
        runId: exact.runId,
        workOrderId: exact.workOrderId,
        attemptId: exact.attemptId,
        role: "local-reviewer",
        requestedProfile: PROFILES.localReviewer,
        policyDigest: exact.policyDigest,
        fencingGeneration: exact.fencingGeneration,
        requestedDurationMs: 10_000,
      });
      await protectedState.registry.save(
        {
          schema: PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
          binding: {
            runId: exact.runId,
            workOrderId: exact.workOrderId,
            attemptId: exact.attemptId,
            policyDigest: exact.policyDigest,
            fencingGeneration: exact.fencingGeneration,
          },
          profiles: PROFILES,
          phase: "acquiring",
          leases: [
            {
              leaseDigest: protectedIdentityLeaseDigest(reviewer),
              lease: reviewer,
              currentRole: "local-reviewer",
              retired: false,
            },
          ],
          pendingOperations: [],
          acquisitionObservation: null,
        },
        null,
      );
      const callsBeforeRecovery = broker.calls.length;
      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });

      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(broker.calls).toHaveLength(callsBeforeRecovery);
    } finally {
      protectedState.remove();
    }
  });

  it("uses prior-snapshot CAS before revocation and refuses a concurrent rebind", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      const seedingBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const first = restartableController({
        broker: seedingBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      let raced = false;
      const racingRegistry: ProtectedIdentityLeaseRegistry = {
        load: (exact) => protectedState.registry.load(exact),
        save: (snapshot, expectedRevision) =>
          protectedState.registry.save(snapshot, expectedRevision),
        async loadLineage(exact) {
          const lineage = await protectedState.registry.loadLineage(exact);
          if (!raced) {
            raced = true;
            const prior = lineage.find(
              (candidate) => candidate.binding.fencingGeneration === 7,
            );
            if (prior === undefined)
              throw new Error("prior snapshot disappeared");
            await protectedState.registry.save(
              {
                schema: prior.schema,
                binding: prior.binding,
                profiles: prior.profiles,
                phase: prior.phase,
                leases: prior.leases,
                pendingOperations: prior.pendingOperations,
                acquisitionObservation: prior.acquisitionObservation,
              },
              prior.revision,
            );
          }
          return lineage;
        },
      };
      const recoveryBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const restarted = restartableController({
        broker: recoveryBroker,
        clock,
        fence,
        registry: racingRegistry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(recoveryBroker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it("serializes filesystem CAS so only one writer can advance an exact snapshot", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());
      const snapshot = await protectedState.registry.load({
        runId: binding().runId,
        workOrderId: binding().workOrderId,
        attemptId: binding().attemptId,
        policyDigest: binding().policyDigest,
        fencingGeneration: 7,
      });
      if (snapshot === null)
        throw new Error("seeded protected snapshot disappeared");
      const update = {
        schema: snapshot.schema,
        binding: snapshot.binding,
        profiles: snapshot.profiles,
        phase: snapshot.phase,
        leases: snapshot.leases,
        pendingOperations: snapshot.pendingOperations,
        acquisitionObservation: snapshot.acquisitionObservation,
      } as const;

      const outcomes = await Promise.allSettled([
        protectedState.registry.save(update, snapshot.revision),
        protectedState.registry.save(update, snapshot.revision),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      expect(readdirSync(protectedState.directory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.identity-lock$/u)]),
      );
    } finally {
      protectedState.remove();
    }
  });

  it("refuses stale prior-generation lookup without any broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(6, 8)),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(broker.calls.filter((call) => call.op !== "acquire")).toEqual([]);
      expect(broker.calls.filter((call) => call.op === "acquire")).toHaveLength(
        3,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("refuses a recovery intent whose durable digest no longer matches its fields", async () => {
    const test = setup();
    const input = generationRecoveryEffectInput(7, 8);
    await expect(
      test.controller.acquireRequiredRoles({
        ...input,
        intent: { ...input.intent, event_seq: input.intent.event_seq + 1 },
      }),
    ).rejects.toMatchObject({ reason: "malformed-input" });
    expect(test.broker.calls).toEqual([]);
  });

  it("refuses a missing immediate predecessor in the filesystem registry", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(broker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it("loads and revokes the exact sealed role leases during restart cleanup", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await restarted.cleanup(binding({ candidateSha: "c".repeat(40) }));
      expect(
        broker.calls
          .filter((call) => call.op === "revoke")
          .map((call) => call.role)
          .sort(),
      ).toEqual(["implementer", "local-reviewer", "pr-reviewer"]);

      const restartedAgain = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await restartedAgain.cleanup(binding());
      expect(broker.calls.filter((call) => call.op === "revoke")).toHaveLength(
        3,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("refuses multiple unretired protected generations during explicit cleanup before broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      for (const generation of [7, 8]) {
        const seedingBroker = new FakeProviderIdentityBroker(
          clock,
          GRANTS,
          fence,
        );
        await restartableController({
          broker: seedingBroker,
          clock,
          fence,
          registry: protectedState.registry,
        }).acquireRequiredRoles(
          effectInput({ binding: binding({ fencingGeneration: generation }) }),
        );
      }
      const cleanupBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const cleanup = restartableController({
        broker: cleanupBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });

      await expect(
        cleanup.cleanup(binding({ fencingGeneration: 9 })),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/multiple unretired/u),
      });
      expect(cleanupBroker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it("refuses a future protected generation during explicit cleanup before broker mutation", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const protectedState = protectedRegistryFixture(clock);
    try {
      const seedingBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      await restartableController({
        broker: seedingBroker,
        clock,
        fence,
        registry: protectedState.registry,
      }).acquireRequiredRoles(
        effectInput({ binding: binding({ fencingGeneration: 10 }) }),
      );
      const cleanupBroker = new FakeProviderIdentityBroker(
        clock,
        GRANTS,
        fence,
      );
      const cleanup = restartableController({
        broker: cleanupBroker,
        clock,
        fence,
        registry: protectedState.registry,
      });

      await expect(
        cleanup.cleanup(binding({ fencingGeneration: 9 })),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(cleanupBroker.calls).toEqual([]);
    } finally {
      protectedState.remove();
    }
  });

  it("retires generation-7 protected leases after graceful and forced cancellation fencing plus a generation-10 cleanup claim", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    fence.currentGeneration = 7;
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());

      // Graceful cancellation advances the durable fence to 8, forced
      // escalation advances it once to 9, and the cleanup worker's subsequent
      // owner-null claim advances it once more to 10.
      fence.currentGeneration = 8;
      fence.current = false;
      fence.currentGeneration = 9;
      fence.currentGeneration = 10;
      fence.current = true;
      const cleanupWorker = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await cleanupWorker.cleanup(binding({ fencingGeneration: 10 }));

      const revocations = broker.calls.filter((call) => call.op === "revoke");
      expect(revocations).toHaveLength(3);
      expect(revocations.every((call) => call.fencingGeneration === 7)).toBe(
        true,
      );
      expect(
        broker.calls.some(
          (call) => call.op === "acquire" && call.fencingGeneration === 9,
        ),
      ).toBe(false);
      expect(
        await protectedState.registry.load({
          runId: binding().runId,
          workOrderId: binding().workOrderId,
          attemptId: binding().attemptId,
          policyDigest: binding().policyDigest,
          fencingGeneration: 7,
        }),
      ).toMatchObject({ phase: "retired", pendingOperations: [] });

      const cleanupRetry = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await cleanupRetry.cleanup(binding({ fencingGeneration: 10 }));
      expect(broker.calls.filter((call) => call.op === "revoke")).toHaveLength(
        3,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("retires an in-memory generation-7 session through a current generation-9 cleanup fence", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    fence.currentGeneration = 7;
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const test = setup({ broker, clock, fence });
    await test.controller.acquireRequiredRoles(effectInput());

    fence.currentGeneration = 9;
    await test.controller.cleanup(binding({ fencingGeneration: 9 }));

    expect(broker.calls.filter((call) => call.op === "revoke")).toHaveLength(3);
    expect(test.controller.status(binding().runId)).toMatchObject({
      state: "retired",
    });
  });

  it("refuses and denies an active in-memory session when its protected lineage claims it is already retired", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const controller = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await controller.acquireRequiredRoles(effectInput());
      const active = await protectedState.registry.load({
        runId: binding().runId,
        workOrderId: binding().workOrderId,
        attemptId: binding().attemptId,
        policyDigest: binding().policyDigest,
        fencingGeneration: 7,
      });
      if (active === null) {
        throw new Error("active protected identity fixture disappeared");
      }
      await protectedState.registry.save(
        {
          schema: active.schema,
          binding: active.binding,
          profiles: active.profiles,
          phase: "retired",
          leases: active.leases.map((entry) => ({
            leaseDigest: entry.leaseDigest,
            lease: entry.lease,
            currentRole: null,
            retired: true,
          })),
          pendingOperations: [],
          acquisitionObservation: active.acquisitionObservation,
        },
        active.revision,
      );
      const callsBeforeCleanup = broker.calls.length;

      await expect(controller.cleanup(binding())).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/contradicts its exact protected/u),
      });
      expect(broker.calls).toHaveLength(callsBeforeCleanup);
      await expect(
        controller.withLease(binding(), "implementer", () => undefined),
      ).rejects.toThrow(/not active/u);
    } finally {
      protectedState.remove();
    }
  });

  it("denies an older in-flight acquisition and revokes every known and late lease before newer-fence cleanup returns", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    fence.currentGeneration = 7;
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const broker = new DeferredAcquireBroker(inner);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const controller = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const acquisition = controller.acquireRequiredRoles(effectInput());
      await broker.started;

      fence.currentGeneration = 9;
      const cleanup = controller.cleanup(binding({ fencingGeneration: 9 }));
      broker.release();
      await cleanup;
      await expect(acquisition).rejects.toMatchObject({
        reason: "authority-unavailable",
      });

      expect(
        inner.calls
          .filter((call) => call.op === "acquire")
          .map((call) => call.role),
      ).toEqual(["implementer", "local-reviewer"]);
      expect(
        inner.calls
          .filter((call) => call.op === "revoke")
          .map((call) => call.role)
          .sort(),
      ).toEqual(["implementer", "local-reviewer"]);
      expect(inner.calls.filter((call) => call.op === "revoke")).toHaveLength(
        2,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("persists an ambiguous acquire marker and refuses restart recovery without broker lookup", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const broker = new LostAcquireResponseBroker(inner);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        first.acquireRequiredRoles(effectInput()),
      ).rejects.toMatchObject({
        reason: "authority-unavailable",
      });
      expect(inner.calls.filter((call) => call.op === "acquire")).toHaveLength(
        1,
      );

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        restarted.acquireRequiredRoles(generationRecoveryEffectInput(7, 8)),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/exact broker lookup\/status/u),
      });
      expect(inner.calls.filter((call) => call.op === "acquire")).toHaveLength(
        1,
      );
      expect(inner.calls.filter((call) => call.op === "renew")).toHaveLength(0);
      expect(inner.calls.filter((call) => call.op === "revoke")).toHaveLength(
        0,
      );

      const cleanupRestart = restartableController({
        broker: inner,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        cleanupRestart.cleanup(binding({ fencingGeneration: 10 })),
      ).rejects.toMatchObject({
        reason: "reconciliation-unavailable",
        message: expect.stringMatching(/lookup\/status/u),
      });
      expect(inner.calls.filter((call) => call.op === "revoke")).toHaveLength(
        0,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("clears a definitively unchanged acquire marker and permits fenced restart recovery", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const inner = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    try {
      const first = restartableController({
        broker: new DefinitiveAcquireFailureBroker(inner),
        clock,
        fence,
        registry: protectedState.registry,
      });
      await expect(
        first.acquireRequiredRoles(effectInput()),
      ).rejects.toMatchObject({ reason: "authority-unavailable" });

      const persisted = await protectedState.registry.load({
        runId: binding().runId,
        workOrderId: binding().workOrderId,
        attemptId: binding().attemptId,
        policyDigest: binding().policyDigest,
        fencingGeneration: binding().fencingGeneration,
      });
      expect(persisted).toMatchObject({
        phase: "acquiring",
        leases: [],
        pendingOperations: [],
      });

      const restarted = restartableController({
        broker: inner,
        clock,
        fence,
        registry: protectedState.registry,
      });
      const observation = await restarted.acquireRequiredRoles(
        generationRecoveryEffectInput(7, 8),
      );
      expect(observation.binding.fencing_generation).toBe(8);
      expect(inner.calls.filter((call) => call.op === "acquire")).toHaveLength(
        3,
      );
    } finally {
      protectedState.remove();
    }
  });

  it("fails closed and attempts exact retirement when a sealed lease set expired during downtime", async () => {
    const clock = new FakeClock(NOW);
    const fence = new MutableFence();
    const broker = new FakeProviderIdentityBroker(clock, GRANTS, fence);
    const protectedState = protectedRegistryFixture(clock);
    const authorityLosses: AsfIdentityAuthorityLoss[] = [];
    try {
      const first = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
      });
      await first.acquireRequiredRoles(effectInput());
      clock.simulateSuspend(10_001);

      const restarted = restartableController({
        broker,
        clock,
        fence,
        registry: protectedState.registry,
        authorityLosses,
      });
      await expect(
        restarted.acquireRequiredRoles(
          effectInput({ intentMode: "reconcile-only" }),
        ),
      ).rejects.toMatchObject({ reason: "reconciliation-unavailable" });
      expect(broker.calls.filter((call) => call.op === "renew")).toHaveLength(
        0,
      );
      expect(broker.calls.filter((call) => call.op === "revoke")).toHaveLength(
        3,
      );
      expect(authorityLosses).toEqual([
        expect.objectContaining({
          reason: "renewal-failed",
          revocationComplete: false,
        }),
      ]);
      await expect(
        restarted.withLease(binding(), "implementer", () => undefined),
      ).rejects.toThrow(/not active/u);
    } finally {
      protectedState.remove();
    }
  });

  it("refuses blind reconcile-only acquisition when protected lease state is absent", async () => {
    const test = setup();
    const input = effectInput({ intentMode: "reconcile-only" });

    await expect(
      test.controller.acquireRequiredRoles(input),
    ).rejects.toMatchObject({
      reason: "reconciliation-unavailable",
    });
    expect(test.broker.calls).toEqual([]);
  });

  it("binds the intent to immutable profile policy before contacting the broker", async () => {
    const test = setup({
      profiles: { ...PROFILES, prReviewer: "other:reviewer" },
    });

    await expect(
      test.controller.acquireRequiredRoles(effectInput()),
    ).rejects.toMatchObject({
      reason: "profile-binding",
    });
    expect(test.broker.calls).toEqual([]);
  });

  it("revokes cancellation and cleanup idempotently without serializing capabilities", async () => {
    const cancelled = setup();
    await cancelled.controller.acquireRequiredRoles(effectInput());
    await cancelled.controller.cancel(
      binding({ candidateSha: "c".repeat(40) }),
    );
    await cancelled.controller.cancel(binding());
    expect(
      cancelled.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(3);

    const cleaned = setup();
    await cleaned.controller.acquireRequiredRoles(effectInput());
    await cleaned.controller.cleanup(binding({ candidateSha: "d".repeat(40) }));
    await cleaned.controller.cleanup(binding());
    expect(
      cleaned.broker.calls.filter((call) => call.op === "revoke"),
    ).toHaveLength(3);
    expect(cleaned.controller.status(binding().runId)).toMatchObject({
      state: "retired",
    });
  });
});
