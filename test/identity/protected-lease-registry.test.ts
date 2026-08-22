import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  IdentityExecutionHandle,
  IdentityLease,
  IdentityLeaseId,
} from "../../src/identity/broker.js";
import {
  EncryptedFileIdentityLeaseRegistry,
  PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
  protectedIdentityLeaseDigest,
  type ProtectedIdentityLeaseBinding,
  type ProtectedIdentityLeaseSnapshot,
} from "../../src/identity/protected-lease-registry.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:00:00.000Z";
const POLICY_DIGEST = `sha256:${"a".repeat(64)}`;

function binding(
  overrides: Partial<ProtectedIdentityLeaseBinding> = {},
): ProtectedIdentityLeaseBinding {
  return {
    runId: "run-protected-identity-01",
    workOrderId: "wo-protected-identity-01",
    attemptId: "attempt-protected-identity-01",
    policyDigest: POLICY_DIGEST,
    fencingGeneration: 4,
    ...overrides,
  };
}

function lease(): IdentityLease {
  return Object.freeze({
    leaseId: "sensitive-lease-capability-0001" as IdentityLeaseId,
    executionHandle:
      "sensitive-provider-execution-capability-0001" as IdentityExecutionHandle,
    runId: binding().runId,
    workOrderId: binding().workOrderId,
    attemptId: binding().attemptId,
    role: "implementer",
    policyDigest: POLICY_DIGEST,
    provider: "example-provider",
    principal: "implementation-principal",
    profile: "implementation-profile",
    issuedAt: NOW,
    expiresAt: "2026-08-21T10:10:00.000Z",
    fencingGeneration: binding().fencingGeneration,
  });
}

function ctxlaneLease(): IdentityLease {
  return Object.freeze({
    ...lease(),
    provider: "codex",
    principal: "service-account:automation-worker",
    profile: "codex:automation-production",
    ctxlane: Object.freeze({
      clientRequestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      requestedTtlSeconds: 600,
      tenantId: "tenant-acme",
      workOrderDigest: `sha256:${"b".repeat(64)}`,
      profileUid: "profile_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      callerSubject: "caller:local-controller",
      hostIdentity: "host:runner-01",
      workerIdentity: "worker:controller-01",
      workspaceId: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environment: "production",
      repository: "github:acme/payments",
      workspaceRef: "chatgpt-workspace:ws_automation_prod",
      authMode: "wif",
      isolation: "credential-isolated",
      fencingGeneration: 3,
      effectivePolicyDigest: `sha256:${"c".repeat(64)}`,
      maximumExpiresAt: "2026-08-21T14:00:00.000Z",
      status: "active",
    }),
  });
}

function update(
  overrides: Partial<
    Omit<
      ProtectedIdentityLeaseSnapshot,
      "revision" | "updatedAt" | "recordDigest"
    >
  > = {},
): Omit<
  ProtectedIdentityLeaseSnapshot,
  "revision" | "updatedAt" | "recordDigest"
> {
  const exactLease = lease();
  return {
    schema: PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA,
    binding: binding(),
    profiles: {
      implementer: "implementation-profile",
      localReviewer: "local-review-profile",
      prReviewer: "pr-review-profile",
    },
    phase: "acquiring",
    leases: [
      {
        leaseDigest: protectedIdentityLeaseDigest(exactLease),
        lease: exactLease,
        currentRole: "implementer",
        retired: false,
      },
    ],
    pendingOperations: [],
    acquisitionObservation: null,
    ...overrides,
  };
}

function fixture(): {
  readonly root: string;
  readonly directory: string;
  readonly clock: FakeClock;
  readonly registry: EncryptedFileIdentityLeaseRegistry;
  readonly remove: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "runmill-protected-identities-"));
  chmodSync(root, 0o700);
  const directory = join(root, "sealed");
  mkdirSync(directory, { mode: 0o700 });
  const clock = new FakeClock(NOW);
  return {
    root,
    directory,
    clock,
    registry: new EncryptedFileIdentityLeaseRegistry({
      directory,
      keyId: "identity-registry-test-key",
      key: Buffer.alloc(32, 0x37),
      clock,
    }),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("EncryptedFileIdentityLeaseRegistry", () => {
  it("round-trips exact state while keeping lease capabilities out of the file", async () => {
    const test = fixture();
    try {
      const first = await test.registry.save(update(), null);
      expect(first.revision).toBe(1);
      expect(first.updatedAt).toBe(NOW);

      const [name] = readdirSync(test.directory);
      expect(name).toMatch(/^[a-f0-9]{64}\.identity-sealed$/u);
      const path = join(test.directory, name ?? "missing");
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      const sealed = readFileSync(path, "utf8");
      expect(sealed).not.toContain(String(lease().leaseId));
      expect(sealed).not.toContain(String(lease().executionHandle));
      expect(sealed).not.toContain("implementation-principal");

      await expect(test.registry.load(binding())).resolves.toEqual(first);
      test.clock.advanceMs(1_000);
      const second = await test.registry.save(
        update({ phase: "failed" }),
        first.revision,
      );
      expect(second.revision).toBe(2);
      expect(second.updatedAt).toBe("2026-08-21T10:00:01.000Z");
    } finally {
      test.remove();
    }
  });

  it("round-trips and deep-freezes complete ctxlane attribution", async () => {
    const test = fixture();
    try {
      const exactLease = ctxlaneLease();
      const saved = await test.registry.save(
        update({
          leases: [
            {
              leaseDigest: protectedIdentityLeaseDigest(exactLease),
              lease: exactLease,
              currentRole: "implementer",
              retired: false,
            },
          ],
        }),
        null,
      );

      const loaded = await test.registry.load(binding());
      expect(loaded).toEqual(saved);
      const loadedLease = loaded?.leases[0]?.lease;
      expect(loadedLease?.ctxlane).toEqual(exactLease.ctxlane);
      expect(Object.isFrozen(loadedLease)).toBe(true);
      expect(Object.isFrozen(loadedLease?.ctxlane)).toBe(true);

      const [name] = readdirSync(test.directory);
      const sealed = readFileSync(
        join(test.directory, name ?? "missing"),
        "utf8",
      );
      expect(sealed).not.toContain("caller:local-controller");
      expect(sealed).not.toContain("profile_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    } finally {
      test.remove();
    }
  });

  it("refuses stale compare-and-swap writers and leaves the current record intact", async () => {
    const test = fixture();
    try {
      const first = await test.registry.save(update(), null);
      await expect(
        test.registry.save(update({ phase: "failed" }), null),
      ).rejects.toThrow(/unavailable or contradictory/u);
      await expect(
        test.registry.save(update({ phase: "failed" }), 99),
      ).rejects.toThrow(/unavailable or contradictory/u);
      await expect(test.registry.load(binding())).resolves.toEqual(first);
    } finally {
      test.remove();
    }
  });

  it("rejects authenticated-ciphertext tampering without exposing protected state", async () => {
    const test = fixture();
    try {
      await test.registry.save(update(), null);
      const [name] = readdirSync(test.directory);
      const path = join(test.directory, name ?? "missing");
      const sealed = JSON.parse(readFileSync(path, "utf8")) as {
        ciphertext: string;
        [key: string]: unknown;
      };
      const replacement = sealed.ciphertext[0] === "A" ? "B" : "A";
      sealed.ciphertext = `${replacement}${sealed.ciphertext.slice(1)}`;
      writeFileSync(path, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });

      await expect(test.registry.load(binding())).rejects.toThrow(
        /^protected identity lease state is unavailable or contradictory$/u,
      );
    } finally {
      test.remove();
    }
  });

  it("rejects permissive storage and permissive sealed files", async () => {
    const test = fixture();
    try {
      chmodSync(test.directory, 0o755);
      expect(
        () =>
          new EncryptedFileIdentityLeaseRegistry({
            directory: test.directory,
            keyId: "identity-registry-test-key",
            key: Buffer.alloc(32, 0x37),
            clock: test.clock,
          }),
      ).toThrow(/unavailable or contradictory/u);

      chmodSync(test.directory, 0o700);
      const registry = new EncryptedFileIdentityLeaseRegistry({
        directory: test.directory,
        keyId: "identity-registry-test-key",
        key: Buffer.alloc(32, 0x37),
        clock: test.clock,
      });
      await registry.save(update(), null);
      const [name] = readdirSync(test.directory);
      chmodSync(join(test.directory, name ?? "missing"), 0o644);
      await expect(registry.load(binding())).rejects.toThrow(
        /unavailable or contradictory/u,
      );
    } finally {
      test.remove();
    }
  });

  it("does not return another fence's sealed state", async () => {
    const test = fixture();
    try {
      await test.registry.save(update(), null);
      await expect(
        test.registry.load(binding({ fencingGeneration: 5 })),
      ).resolves.toBeNull();
    } finally {
      test.remove();
    }
  });
});
