import { describe, expect, it } from "vitest";
import {
  assertIndependentIdentityLeases,
  IdentityLeaseIndependenceError,
  type IdentityLease,
  type IdentityLeaseRequest,
  type IdentityOwnershipFence,
  type IdentityOwnershipFenceValidator,
} from "../../src/identity/broker.js";
import {
  FakeProviderIdentityBroker,
  IdentityLeaseBindingError,
  IdentityLeaseDeniedError,
  IdentityLeaseStateError,
  type FakeIdentityGrant,
} from "../../src/testing/fake-identity-broker.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const IMPLEMENTER_GRANT: FakeIdentityGrant = {
  role: "implementer",
  profile: "implementation",
  provider: "example-provider",
  principal: "implementation-principal",
  maxDurationMs: 60_000,
};

const REVIEWER_GRANT: FakeIdentityGrant = {
  role: "local-reviewer",
  profile: "local-review",
  provider: "independent-provider",
  principal: "review-principal",
  maxDurationMs: 60_000,
};

const CURRENT_FENCE: IdentityOwnershipFenceValidator = {
  isCurrent: (fence) =>
    fence.runId === "run-1" &&
    fence.workOrderId === "wo-1" &&
    fence.attemptId === "attempt-1" &&
    fence.fencingGeneration === 7,
};

function request(overrides: Partial<IdentityLeaseRequest> = {}): IdentityLeaseRequest {
  return {
    runId: "run-1",
    workOrderId: "wo-1",
    attemptId: "attempt-1",
    role: "implementer",
    requestedProfile: "implementation",
    policyDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fencingGeneration: 7,
    requestedDurationMs: 120_000,
    ...overrides,
  };
}

function brokerWithGrant(): { broker: FakeProviderIdentityBroker; clock: FakeClock } {
  const clock = new FakeClock("2026-08-21T10:00:00Z");
  return {
    clock,
    broker: new FakeProviderIdentityBroker(clock, [IMPLEMENTER_GRANT], CURRENT_FENCE),
  };
}

function changed(lease: IdentityLease, overrides: Partial<IdentityLease>): IdentityLease {
  return { ...lease, ...overrides };
}

describe("FakeProviderIdentityBroker", () => {
  it("denies by default and records the attempted acquisition", async () => {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const broker = new FakeProviderIdentityBroker(clock);

    await expect(broker.acquire(request())).rejects.toThrow(IdentityLeaseDeniedError);
    expect(broker.calls).toEqual([
      {
        op: "acquire",
        runId: "run-1",
        workOrderId: "wo-1",
        attemptId: "attempt-1",
        role: "implementer",
        profile: "implementation",
        fencingGeneration: 7,
        requestedDurationMs: 120_000,
      },
    ]);
  });

  it("caps the lease duration and returns only opaque authority plus non-secret attribution", async () => {
    const { broker } = brokerWithGrant();
    const lease = await broker.acquire(request());

    expect(lease).toMatchObject({
      runId: "run-1",
      workOrderId: "wo-1",
      attemptId: "attempt-1",
      role: "implementer",
      provider: "example-provider",
      principal: "implementation-principal",
      profile: "implementation",
      fencingGeneration: 7,
      issuedAt: "2026-08-21T10:00:00.000Z",
      expiresAt: "2026-08-21T10:01:00.000Z",
    });
    expect(lease.leaseId).toMatch(/^fake-identity-lease-/);
    expect(lease.executionHandle).toMatch(/^fake-provider-execution-/);
    expect(Object.keys(lease).some((key) => /credential|token/i.test(key))).toBe(false);
  });

  it("fails closed when no current ownership-fence validator is configured", async () => {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const broker = new FakeProviderIdentityBroker(clock, [IMPLEMENTER_GRANT]);

    await expect(broker.acquire(request())).rejects.toThrow(/without a current ownership-fence/);
  });

  it("refuses stale acquisition after an ownership generation takeover", async () => {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    let currentGeneration = 7;
    const validator: IdentityOwnershipFenceValidator = {
      isCurrent: (fence) => fence.fencingGeneration === currentGeneration,
    };
    const broker = new FakeProviderIdentityBroker(clock, [IMPLEMENTER_GRANT], validator);

    currentGeneration = 8;
    await expect(broker.acquire(request())).rejects.toThrow(
      /stale ownership-fence generation 7/,
    );
  });

  it("refuses renewal when durable ownership advances to a new generation", async () => {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    let currentFence: IdentityOwnershipFence = {
      runId: "run-1",
      workOrderId: "wo-1",
      attemptId: "attempt-1",
      fencingGeneration: 7,
    };
    const validator: IdentityOwnershipFenceValidator = {
      isCurrent: (fence) =>
        fence.runId === currentFence.runId &&
        fence.workOrderId === currentFence.workOrderId &&
        fence.attemptId === currentFence.attemptId &&
        fence.fencingGeneration === currentFence.fencingGeneration,
    };
    const broker = new FakeProviderIdentityBroker(clock, [IMPLEMENTER_GRANT], validator);
    const lease = await broker.acquire(request());

    currentFence = { ...currentFence, fencingGeneration: 8 };
    await expect(broker.renew(lease)).rejects.toThrow(/stale ownership-fence generation 7/);
  });

  it("fails closed when the authoritative fence lookup errors", async () => {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const broker = new FakeProviderIdentityBroker(clock, [IMPLEMENTER_GRANT], {
      isCurrent: () => {
        throw new Error("state store unavailable");
      },
    });

    await expect(broker.acquire(request())).rejects.toThrow(/ownership-fence validation failed/);
  });

  it("requires the grant to match both role and profile", async () => {
    const { broker } = brokerWithGrant();

    await expect(
      broker.acquire(request({ role: "local-reviewer" })),
    ).rejects.toThrow(/not granted for role local-reviewer/);
    await expect(
      broker.acquire(request({ requestedProfile: "review" })),
    ).rejects.toThrow(/profile review is not granted/);
  });

  it("rejects malformed policy digests", async () => {
    const { broker } = brokerWithGrant();

    await expect(broker.acquire(request({ policyDigest: "not-a-digest" }))).rejects.toThrow(
      /tagged lower-case SHA-256 digest/,
    );
    await expect(
      broker.acquire(request({ policyDigest: `sha256:${"A".repeat(64)}` })),
    ).rejects.toThrow(IdentityLeaseDeniedError);
  });

  it("refuses a duplicate active lease for the same scoped role", async () => {
    const { broker } = brokerWithGrant();
    const first = await broker.acquire(request());

    await expect(broker.acquire(request())).rejects.toThrow(/active identity lease already exists/);
    await broker.close(first, "completed");
    await expect(broker.acquire(request())).resolves.toMatchObject({ role: "implementer" });
  });

  it("rejects role, profile, run, and stale-generation substitutions", async () => {
    const { broker } = brokerWithGrant();
    const lease = await broker.acquire(request());

    await expect(
      broker.renew(changed(lease, { role: "local-reviewer" })),
    ).rejects.toThrow(/mismatched role/);
    await expect(
      broker.close(changed(lease, { profile: "review" }), "failed"),
    ).rejects.toThrow(/mismatched profile/);
    await expect(
      broker.revoke(changed(lease, { runId: "run-2" }), "cancelled"),
    ).rejects.toThrow(/mismatched runId/);
    await expect(
      broker.renew(changed(lease, { fencingGeneration: 6 })),
    ).rejects.toThrow(IdentityLeaseBindingError);
  });

  it("refuses renewal and retirement after expiry", async () => {
    const { broker, clock } = brokerWithGrant();
    const lease = await broker.acquire(request({ requestedDurationMs: 1_000 }));
    clock.advanceMs(1_000);

    await expect(broker.renew(lease)).rejects.toThrow(/expired identity lease/);
    await expect(broker.close(lease, "failed")).rejects.toThrow(/expired identity lease/);
    await expect(broker.revoke(lease, "expired cleanup")).rejects.toThrow(
      /expired identity lease/,
    );
  });

  it("renews an active lease from the injected clock and rejects the stale snapshot", async () => {
    const { broker, clock } = brokerWithGrant();
    const lease = await broker.acquire(request({ requestedDurationMs: 30_000 }));
    clock.advanceMs(20_000);
    const renewed = await broker.renew(lease);

    expect(renewed.issuedAt).toBe("2026-08-21T10:00:20.000Z");
    expect(renewed.expiresAt).toBe("2026-08-21T10:00:50.000Z");
    await expect(broker.close(lease, "failed")).rejects.toThrow(/mismatched issuedAt/);
    await expect(broker.close(renewed, "completed")).resolves.toBeUndefined();
  });

  it("refuses every form of reuse after revoke", async () => {
    const { broker } = brokerWithGrant();
    const lease = await broker.acquire(request());
    await broker.revoke(lease, "operator cancellation");

    await expect(broker.renew(lease)).rejects.toThrow(/revoked identity lease/);
    await expect(broker.close(lease, "cancelled")).rejects.toThrow(/revoked identity lease/);
    await expect(broker.revoke(lease, "again")).rejects.toThrow(/revoked identity lease/);
  });

  it("refuses every form of reuse after close", async () => {
    const { broker } = brokerWithGrant();
    const lease = await broker.acquire(request());
    await broker.close(lease, "completed");

    await expect(broker.renew(lease)).rejects.toThrow(/closed identity lease/);
    await expect(broker.close(lease, "completed")).rejects.toThrow(/closed identity lease/);
    await expect(broker.revoke(lease, "again")).rejects.toThrow(IdentityLeaseStateError);
  });

  it("records lifecycle calls without placing opaque handles in the call log", async () => {
    const { broker, clock } = brokerWithGrant();
    const lease = await broker.acquire(request({ requestedDurationMs: 30_000 }));
    clock.advanceMs(1_000);
    const renewed = await broker.renew(lease);
    await broker.close(renewed, "completed");

    expect(broker.calls.map((call) => call.op)).toEqual(["acquire", "renew", "close"]);
    const serialized = JSON.stringify(broker.calls);
    expect(serialized).not.toContain(String(lease.leaseId));
    expect(serialized).not.toContain(String(lease.executionHandle));
    expect(serialized).not.toMatch(/credential|token/i);
  });
});

describe("assertIndependentIdentityLeases", () => {
  async function acquirePair(
    reviewerGrant: FakeIdentityGrant = REVIEWER_GRANT,
  ): Promise<{ implementer: IdentityLease; reviewer: IdentityLease }> {
    const clock = new FakeClock("2026-08-21T10:00:00Z");
    const broker = new FakeProviderIdentityBroker(
      clock,
      [IMPLEMENTER_GRANT, reviewerGrant],
      CURRENT_FENCE,
    );
    const implementer = await broker.acquire(request());
    const reviewer = await broker.acquire(
      request({ role: "local-reviewer", requestedProfile: reviewerGrant.profile }),
    );
    return { implementer, reviewer };
  }

  it("accepts separately attributed leases for the same fenced work attempt", async () => {
    const { implementer, reviewer } = await acquirePair();

    expect(() => assertIndependentIdentityLeases(implementer, reviewer)).not.toThrow();
  });

  it("refuses a reviewer resolved to the implementer provider and principal", async () => {
    const { implementer, reviewer } = await acquirePair({
      ...REVIEWER_GRANT,
      provider: IMPLEMENTER_GRANT.provider,
      principal: IMPLEMENTER_GRANT.principal,
    });

    expect(() => assertIndependentIdentityLeases(implementer, reviewer)).toThrow(
      /implementer provider and principal/,
    );
  });

  it("refuses shared lease authority even when attribution claims independence", async () => {
    const { implementer, reviewer } = await acquirePair();

    expect(() =>
      assertIndependentIdentityLeases(
        implementer,
        changed(reviewer, { executionHandle: implementer.executionHandle }),
      ),
    ).toThrow(/same execution handle/);
  });

  it.each([
    ["runId", "run-2"],
    ["workOrderId", "wo-2"],
    ["attemptId", "attempt-2"],
    ["policyDigest", `sha256:${"b".repeat(64)}`],
    ["fencingGeneration", 8],
  ] as const)("refuses a mismatched %s binding", async (field, value) => {
    const { implementer, reviewer } = await acquirePair();
    const mismatched = changed(reviewer, { [field]: value });

    expect(() => assertIndependentIdentityLeases(implementer, mismatched)).toThrow(
      new RegExp(`binding mismatch: ${field}`),
    );
  });

  it("fails closed for wrong roles and malformed attribution", async () => {
    const { implementer, reviewer } = await acquirePair();

    expect(() =>
      assertIndependentIdentityLeases(changed(implementer, { role: "fixer" }), reviewer),
    ).toThrow(IdentityLeaseIndependenceError);
    expect(() =>
      assertIndependentIdentityLeases(implementer, changed(reviewer, { principal: "" })),
    ).toThrow(/invalid principal/);
  });
});
