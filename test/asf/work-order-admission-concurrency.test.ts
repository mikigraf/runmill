import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkOrderAdmissionService,
  resolveEffectivePolicy,
  workOrderSigningPayload,
  type AsfAdmissionPolicy,
  type RepositoryAdmissionEvidence,
  type RepositoryAdmissionObserver,
  type WorkOrderEnvelope,
  type WorkOrderPayload,
} from "../../src/asf/work-order.js";
import { canonicalJson } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { StateStore } from "../../src/state/store.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const NOW = "2026-08-21T10:05:00.000Z";
const BASE_SHA = "a".repeat(40);
const OBSERVED_BASE_SHA = "b".repeat(40);
const REPOSITORY_POLICY_BYTES = Buffer.from("checks: []\n", "utf8");
const rawDigest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function forgeProtectionBytes(requiredChecks: readonly string[]): Buffer {
  return Buffer.from(
    canonicalJson({
      schema: "runmill.github-base-protection/v1",
      repository: "acme/payments",
      base_ref: "refs/heads/main",
      protection: {
        required_checks: [...requiredChecks],
        requires_approval: false,
        requires_conversation_resolution: false,
        uses_merge_queue: false,
      },
    }),
    "utf8",
  );
}

const DIGEST = {
  source: `sha256:${"1".repeat(64)}`,
  workOrderPolicy: `sha256:${"2".repeat(64)}`,
  harness: `sha256:${"3".repeat(64)}`,
  repository: rawDigest(REPOSITORY_POLICY_BYTES),
  operator: `sha256:${"5".repeat(64)}`,
  forge: rawDigest(forgeProtectionBytes(["branch/test"])),
  narrowForge: rawDigest(forgeProtectionBytes(["branch/strict"])),
} as const;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

let directory: string;
let clock: FakeClock;
const openStores = new Set<StateStore>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "runmill-work-order-race-"));
  clock = new FakeClock(NOW);
});

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  return join(directory, "runmill.db");
}

function openStore(): StateStore {
  const store = StateStore.open(databasePath(), { clock });
  openStores.add(store);
  return store;
}

function closeStore(store: StateStore): void {
  store.close();
  openStores.delete(store);
}

function basePayload(): WorkOrderPayload {
  return {
    schema: "asf.work-order/v1",
    work_order_id: "wo_01",
    tenant_id: "tenant-acme",
    work_item_id: "ENG-123",
    attempt_id: "attempt_01",
    idempotency_key: "tenant-acme/ENG-123/attempt_01",
    source: {
      system: "linear",
      external_id: "ENG-123",
      snapshot_digest: DIGEST.source,
    },
    repository: {
      forge: "github",
      repository: "acme/payments",
      base_ref: "refs/heads/main",
      base_sha: BASE_SHA,
    },
    objective: {
      title: "Make admission durable",
      description: "Exercise the signed admission contract.",
      acceptance_criteria: ["One durable run is acknowledged."],
      non_goals: ["Merge the result."],
    },
    scope: {
      allowed_paths: ["src/**", "test/**"],
      forbidden_paths: [".github/**", ".runmill/**"],
      risk_class: "low",
    },
    verification: {
      required_local_check_ids: ["unit"],
      required_remote_checks: ["ci/test"],
      policy_snapshot_digest: DIGEST.repository,
    },
    identities: {
      implementer: "codex:asf-production",
      local_reviewer: "claude:asf-review",
      pr_reviewer: "claude:asf-review",
    },
    runtime: {
      sandbox_profile: "linux-production-v1",
      tool_policy: "repo-change-v1",
      network_policy: "provider-only-v1",
    },
    budgets: {
      wall_seconds: 7_200,
      max_cost_usd: 10,
      max_agent_invocations: 12,
      max_fix_iterations: 3,
    },
    delivery: {
      closure_target: "pr",
      draft_pr: false,
      merge_policy_ref: null,
    },
    policy_digest: DIGEST.workOrderPolicy,
    harness_digest: DIGEST.harness,
  };
}

function signedEnvelope(
  mutate?: (draft: WorkOrderEnvelope) => void,
  signingKey: KeyObject = privateKey,
): WorkOrderEnvelope {
  const envelope: WorkOrderEnvelope = {
    schema: "asf.work-order-envelope/v1",
    key_id: "asf-signing-key-2026-01",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:00:00Z",
    not_before: "2026-08-21T10:00:00Z",
    expires_at: "2026-08-21T10:15:00Z",
    payload: basePayload(),
    signature: "base64url:AA",
  };
  mutate?.(envelope);
  envelope.signature = `base64url:${signBytes(
    null,
    Buffer.from(workOrderSigningPayload(envelope), "utf8"),
    signingKey,
  ).toString("base64url")}`;
  return envelope;
}

function policy(): AsfAdmissionPolicy {
  return {
    operatorPolicyDigest: DIGEST.operator,
    tenantIds: ["tenant-acme"],
    policyDigests: [DIGEST.workOrderPolicy],
    harnessDigests: [DIGEST.harness],
    repository: {
      forge: "github",
      repository: "acme/payments",
      baseRef: "refs/heads/main",
    },
    trustedSigners: [{ keyId: "asf-signing-key-2026-01", publicKey }],
    authority: {
      pathScope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      definedLocalCheckIds: ["unit"],
      authorizedRepositoryCheckIds: [],
      requiredLocalCheckIds: ["unit"],
      requiredRemoteChecks: ["security/scan"],
      allowedRiskClasses: ["low"],
      allowedClosureTargets: ["pr"],
      identityProfiles: {
        implementer: ["codex:asf-production"],
        localReviewer: ["claude:asf-review"],
        prReviewer: ["claude:asf-review"],
      },
      requireIndependentReviewers: true,
      sandboxProfiles: ["linux-production-v1"],
      toolPolicies: ["repo-change-v1"],
      networkPolicies: ["provider-only-v1"],
      budgetLimits: {
        wallSeconds: 3_600,
        maxCostUsd: 8,
        maxAgentInvocations: 10,
        maxFixIterations: 2,
      },
    },
  };
}

function repositoryEvidence(
  options: {
    readonly requiredRemoteChecks?: readonly string[];
  } = {},
): RepositoryAdmissionEvidence {
  const requiredRemoteChecks = [...(options.requiredRemoteChecks ?? ["branch/test"])];
  const protectionBytes = forgeProtectionBytes(requiredRemoteChecks);
  return {
    forge: "github",
    repository: "acme/payments",
    baseRef: "refs/heads/main",
    observedBaseSha: OBSERVED_BASE_SHA,
    requestedBaseShaReachable: true,
    repositoryPolicyDigest: DIGEST.repository,
    repositoryPolicyBaseSha: BASE_SHA,
    repositoryPolicyPath: ".runmill/checks.yaml",
    repositoryPolicyBytesBase64: REPOSITORY_POLICY_BYTES.toString("base64"),
    forgeProtectionDigest: rawDigest(protectionBytes),
    forgeProtectionBaseRef: "refs/heads/main",
    forgeProtectionBytesBase64: protectionBytes.toString("base64"),
    constraints: {
      pathScope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: ["src/generated/**"],
      },
      definedLocalCheckIds: [],
      requiredLocalCheckIds: [],
      requiredRemoteChecks: [],
    },
    forgeProtection: {
      pullRequestsAllowed: true,
      requiredRemoteChecks,
    },
  };
}

function observer(
  evidence: RepositoryAdmissionEvidence = repositoryEvidence(),
): RepositoryAdmissionObserver {
  return { observe: async () => evidence };
}

function service(
  store: StateStore,
  repository: RepositoryAdmissionObserver,
  runId: string,
): WorkOrderAdmissionService {
  return new WorkOrderAdmissionService({
    store,
    policy: policy(),
    repository,
    clock,
    runId: () => runId,
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function rendezvousObserver(
  evidence: RepositoryAdmissionEvidence = repositoryEvidence(),
): RepositoryAdmissionObserver {
  const bothEntered = deferred();
  let entrants = 0;
  return {
    observe: async () => {
      entrants += 1;
      if (entrants === 2) bothEntered.resolve();
      await bothEntered.promise;
      return evidence;
    },
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe(code);
  }
}

describe("WorkOrderAdmissionService durable concurrency and replay", () => {
  it("converges simultaneous identical submissions on one immutable admission", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const repository = rendezvousObserver();
    const envelope = signedEnvelope();

    const results = await Promise.all([
      service(firstStore, repository, "run_from_first").submit(envelope),
      service(secondStore, repository, "run_from_second").submit(envelope),
    ]);

    expect(new Set(results.map((result) => result.runId))).toHaveLength(1);
    expect(results.map((result) => result.disposition).sort()).toEqual(["accepted", "existing"]);
    const runId = results[0]?.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) throw new Error("admission did not return a run id");
    expect(firstStore.listAsfRuns().map((run) => run.runId)).toEqual([runId]);
    expect(secondStore.listAsfRuns().map((run) => run.runId)).toEqual([runId]);
    expect(firstStore.eventsFor(runId)).toHaveLength(1);
    expect(firstStore.transitionHistory(runId)).toHaveLength(1);
    const admission = firstStore.getAsfAdmission(envelope.payload.idempotency_key);
    expect(admission).toMatchObject({
      runId,
      payloadDigest: results[0]?.payloadDigest,
    });
    const durablePolicy = JSON.parse(admission?.effectivePolicy ?? "null") as {
      readonly inputs: {
        readonly repositoryPolicyPath: string;
        readonly repositoryPolicyBytesBase64: string;
        readonly forgeProtectionBytesBase64: string;
      };
    };
    expect(durablePolicy.inputs).toMatchObject({
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: REPOSITORY_POLICY_BYTES.toString("base64"),
      forgeProtectionBytesBase64: forgeProtectionBytes(["branch/test"]).toString("base64"),
    });
  });

  it("creates one run when conflicting signed payloads race on an idempotency key", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const repository = rendezvousObserver();
    const first = signedEnvelope();
    const conflicting = signedEnvelope((draft) => {
      draft.payload.objective.title = "Different work under the same key";
    });

    const settled = await Promise.allSettled([
      service(firstStore, repository, "run_conflict_first").submit(first),
      service(secondStore, repository, "run_conflict_second").submit(conflicting),
    ]);

    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = rejected[0];
    expect(conflict?.status).toBe("rejected");
    if (conflict?.status !== "rejected") throw new Error("expected one rejected submission");
    expect(conflict.reason).toBeInstanceOf(RunmillError);
    expect((conflict.reason as RunmillError).code).toBe("RM-WO-003");

    const accepted = fulfilled[0];
    expect(accepted?.status).toBe("fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("expected one accepted submission");
    expect(firstStore.listAsfRuns()).toHaveLength(1);
    expect(firstStore.eventsFor(accepted.value.runId)).toHaveLength(1);
    expect(firstStore.getAsfAdmission(first.payload.idempotency_key)).toMatchObject({
      runId: accepted.value.runId,
      payloadDigest: accepted.value.payloadDigest,
    });
  });

  it("refuses the same Work Order attempt under another valid idempotency key", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const first = signedEnvelope();
    const alternateKey = signedEnvelope((draft) => {
      draft.payload.work_item_id = "ENG-456";
      draft.payload.idempotency_key = "tenant-acme/ENG-456/attempt_01";
      draft.payload.source.external_id = "ENG-456";
    });

    const admitted = await service(firstStore, observer(), "run_original").submit(first);
    await expectCode(
      () => service(secondStore, observer(), "run_alternate").submit(alternateKey),
      "RM-WO-003",
    );

    expect(firstStore.listAsfRuns().map((run) => run.runId)).toEqual([admitted.runId]);
    expect(secondStore.getAsfAdmission(alternateKey.payload.idempotency_key)).toBeUndefined();
    expect(firstStore.eventsFor(admitted.runId)).toHaveLength(1);
  });

  it("keeps the acknowledged run durable across immediate close and reopen", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const envelope = signedEnvelope();
    const acknowledgement = await service(firstStore, observer(), "run_acknowledged").submit(
      envelope,
    );
    expect(acknowledgement).toMatchObject({
      runId: "run_acknowledged",
      disposition: "accepted",
    });

    closeStore(firstStore);
    closeStore(secondStore);
    const reopenedFirst = openStore();
    const reopenedSecond = openStore();
    expect(reopenedFirst.getAsfRunSnapshot(acknowledgement.runId)).toMatchObject({
      run: { runId: acknowledgement.runId, state: "ADMITTED", stateVersion: 1 },
      admission: {
        runId: acknowledgement.runId,
        payloadDigest: acknowledgement.payloadDigest,
      },
      latestSequence: 1,
    });
    expect(reopenedSecond.eventsFor(acknowledgement.runId)).toHaveLength(1);
  });

  it("does not invoke repository authority for locally refused Work Orders", async () => {
    const firstStore = openStore();
    openStore();
    let observations = 0;
    const countingObserver: RepositoryAdmissionObserver = {
      observe: async () => {
        observations += 1;
        return repositoryEvidence();
      },
    };
    const admission = service(firstStore, countingObserver, "run_refused");
    const cases = [
      signedEnvelope((draft) => {
        draft.payload.tenant_id = "tenant-evil";
        draft.payload.idempotency_key = "tenant-evil/ENG-123/attempt_01";
      }),
      signedEnvelope((draft) => {
        draft.payload.repository.repository = "attacker/fork";
      }),
      signedEnvelope((draft) => {
        draft.payload.runtime.network_policy = "unrestricted";
      }),
    ];

    for (const envelope of cases) {
      await expectCode(
        () => admission.submit(envelope),
        envelope.payload.repository.repository === "attacker/fork" ? "RM-WO-002" : "RM-WO-005",
      );
    }
    expect(observations).toBe(0);
    expect(firstStore.listAsfRuns()).toEqual([]);
  });

  it("checks signatures and validity windows before invoking an adapter", async () => {
    const firstStore = openStore();
    openStore();
    let observations = 0;
    const countingObserver: RepositoryAdmissionObserver = {
      observe: async () => {
        observations += 1;
        return repositoryEvidence();
      },
    };
    const admission = service(firstStore, countingObserver, "run_invalid_envelope");
    const badSignature = signedEnvelope();
    badSignature.payload.objective.description = "tampered after signing";
    const notYetValid = signedEnvelope((draft) => {
      draft.issued_at = "2026-08-21T10:06:00Z";
      draft.not_before = "2026-08-21T10:06:00Z";
      draft.expires_at = "2026-08-21T10:20:00Z";
    });
    const expired = signedEnvelope((draft) => {
      draft.expires_at = NOW;
    });

    for (const envelope of [badSignature, notYetValid, expired]) {
      await expectCode(() => admission.submit(envelope), "RM-WO-002");
    }
    expect(observations).toBe(0);
    expect(firstStore.listAsfRuns()).toEqual([]);
  });

  it("does not let a slower broad forge observation overwrite stricter admitted policy", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const envelope = signedEnvelope();
    const broadEvidence = repositoryEvidence({
      requiredRemoteChecks: [],
    });
    const narrowEvidence = repositoryEvidence({
      requiredRemoteChecks: ["branch/strict"],
    });
    const broadEntered = deferred();
    const releaseBroad = deferred();
    const slowBroadObserver: RepositoryAdmissionObserver = {
      observe: async () => {
        broadEntered.resolve();
        await releaseBroad.promise;
        return broadEvidence;
      },
    };

    const broadSubmission = service(
      secondStore,
      slowBroadObserver,
      "run_stale_broad_observation",
    ).submit(envelope);
    await broadEntered.promise;
    const narrowResult = await service(
      firstStore,
      observer(narrowEvidence),
      "run_current_narrow_observation",
    ).submit(envelope);
    releaseBroad.resolve();
    const broadResult = await broadSubmission;

    expect(narrowResult.disposition).toBe("accepted");
    expect(broadResult).toMatchObject({
      runId: narrowResult.runId,
      disposition: "existing",
    });
    const admission = firstStore.getAsfAdmission(envelope.payload.idempotency_key);
    expect(admission).toBeDefined();
    const persistedPolicy = JSON.parse(admission?.effectivePolicy ?? "null") as {
      readonly inputs: { readonly forgeProtection: string };
      readonly requiredRemoteChecks: readonly string[];
    };
    expect(persistedPolicy.inputs.forgeProtection).toBe(DIGEST.narrowForge);
    expect(persistedPolicy.requiredRemoteChecks).toContain("branch/strict");
    const staleBroadPolicy = resolveEffectivePolicy(envelope.payload, policy(), broadEvidence);
    expect(admission?.effectivePolicyDigest).not.toBe(staleBroadPolicy.digest);
  });

  it("rejects an expired replay but accepts a freshly signed envelope for existing work", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    let observations = 0;
    const countingObserver: RepositoryAdmissionObserver = {
      observe: async () => {
        observations += 1;
        return repositoryEvidence();
      },
    };
    const original = signedEnvelope();
    const firstResult = await service(
      firstStore,
      countingObserver,
      "run_before_expiry",
    ).submit(original);
    clock.advanceMinutes(11);

    await expectCode(
      () => service(secondStore, countingObserver, "run_expired_replay").submit(original),
      "RM-WO-002",
    );
    const refreshed = signedEnvelope((draft) => {
      draft.issued_at = "2026-08-21T10:16:00Z";
      draft.not_before = "2026-08-21T10:16:00Z";
      draft.expires_at = "2026-08-21T10:30:00Z";
    });
    const replay = await service(
      secondStore,
      countingObserver,
      "run_fresh_replay",
    ).submit(refreshed);

    expect(replay).toEqual({ ...firstResult, disposition: "existing" });
    expect(observations).toBe(1);
    expect(firstStore.listAsfRuns().map((run) => run.runId)).toEqual([firstResult.runId]);
    expect(firstStore.eventsFor(firstResult.runId)).toHaveLength(1);
  });

  it("leaves no partial run after observer, signature, or store failure", async () => {
    const firstStore = openStore();
    const secondStore = openStore();
    const badSignature = signedEnvelope();
    badSignature.payload.objective.title = "unsigned tampering";
    await expectCode(
      () => service(firstStore, observer(), "run_bad_signature").submit(badSignature),
      "RM-WO-002",
    );
    await expect(
      service(
        secondStore,
        {
          observe: async () => {
            throw new Error("repository observation failed");
          },
        },
        "run_observer_failure",
      ).submit(signedEnvelope()),
    ).rejects.toThrow("repository observation failed");
    expect(firstStore.listAsfRuns()).toEqual([]);

    const admitted = await service(firstStore, observer(), "run_collision").submit(
      signedEnvelope(),
    );
    const differentWork = signedEnvelope((draft) => {
      draft.payload.work_order_id = "wo_02";
      draft.payload.work_item_id = "ENG-456";
      draft.payload.attempt_id = "attempt_02";
      draft.payload.idempotency_key = "tenant-acme/ENG-456/attempt_02";
      draft.payload.source.external_id = "ENG-456";
    });
    await expect(
      service(secondStore, observer(), "run_collision").submit(differentWork),
    ).rejects.toThrow();

    expect(firstStore.listAsfRuns().map((run) => run.runId)).toEqual([admitted.runId]);
    expect(firstStore.getAsfAdmission(differentWork.payload.idempotency_key)).toBeUndefined();
    expect(firstStore.eventsFor(admitted.runId)).toHaveLength(1);
    expect(firstStore.transitionHistory(admitted.runId)).toHaveLength(1);
  });
});
