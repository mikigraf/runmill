import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateEffectivePathScope,
  parseWorkOrderEnvelope,
  resolveEffectivePolicy,
  validateWorkOrder,
  workOrderSigningPayload,
  type AsfAdmissionPolicy,
  type RepositoryAdmissionEvidence,
  type RepositoryAdmissionObserver,
  type WorkOrderEnvelope,
  type WorkOrderPayload,
} from "../../src/asf/work-order.js";
import { canonicalJson } from "../../src/asf/canonical-json.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const REPOSITORY_POLICY_BYTES = Buffer.from(
  "checks:\n  - id: integration\n    run: npm run integration\n",
  "utf8",
);
const FORGE_PROTECTION_BYTES = Buffer.from(
  canonicalJson({
    schema: "runmill.github-base-protection/v1",
    repository: "acme/payments",
    base_ref: "refs/heads/main",
    protection: {
      required_checks: ["branch-protection/test"],
      requires_approval: false,
      requires_conversation_resolution: false,
      uses_merge_queue: false,
    },
  }),
  "utf8",
);
const rawDigest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const DIGEST = {
  source: `sha256:${"1".repeat(64)}`,
  workOrderPolicy: `sha256:${"2".repeat(64)}`,
  harness: `sha256:${"3".repeat(64)}`,
  repository: rawDigest(REPOSITORY_POLICY_BYTES),
  operator: `sha256:${"5".repeat(64)}`,
  forge: rawDigest(FORGE_PROTECTION_BYTES),
} as const;

const BASE_SHA = "a".repeat(40);
const OBSERVED_BASE_SHA = "b".repeat(40);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function basePayload(): WorkOrderPayload {
  return {
    schema: "asf.work-order/v1",
    work_order_id: "wo_01J",
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
      title: "Fix settlement rounding",
      description: "Use the immutable acceptance contract.",
      acceptance_criteria: ["rounds half away from zero"],
      non_goals: ["change the public API"],
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
  const draft: WorkOrderEnvelope = {
    schema: "asf.work-order-envelope/v1",
    key_id: "asf-signing-key-2026-01",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T10:00:00Z",
    not_before: "2026-08-21T10:00:00Z",
    expires_at: "2026-08-21T10:15:00Z",
    payload: basePayload(),
    signature: "base64url:AA",
  };
  mutate?.(draft);
  const signature = signBytes(
    null,
    Buffer.from(workOrderSigningPayload(draft), "utf8"),
    signingKey,
  ).toString("base64url");
  draft.signature = `base64url:${signature}`;
  return draft;
}

function policy(key: KeyObject = publicKey): AsfAdmissionPolicy {
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
    trustedSigners: [{ keyId: "asf-signing-key-2026-01", publicKey: key }],
    authority: {
      pathScope: {
        allowedPaths: ["src/**", "test/**"],
        forbiddenPaths: [".github/**", ".runmill/**"],
      },
      definedLocalCheckIds: ["lint", "unit"],
      authorizedRepositoryCheckIds: ["integration"],
      requiredLocalCheckIds: ["lint"],
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

function repositoryEvidence(): RepositoryAdmissionEvidence {
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
    forgeProtectionDigest: DIGEST.forge,
    forgeProtectionBaseRef: "refs/heads/main",
    forgeProtectionBytesBase64: FORGE_PROTECTION_BYTES.toString("base64"),
    constraints: {
      pathScope: {
        allowedPaths: ["src/**"],
        forbiddenPaths: ["src/generated/**"],
      },
      definedLocalCheckIds: ["integration"],
      requiredLocalCheckIds: ["integration"],
      requiredRemoteChecks: ["ci/integration"],
    },
    forgeProtection: {
      pullRequestsAllowed: true,
      requiredRemoteChecks: ["branch-protection/test"],
    },
  };
}

function observer(evidence: RepositoryAdmissionEvidence = repositoryEvidence()): RepositoryAdmissionObserver {
  return { observe: async () => evidence };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe(code);
  }
}

async function expectAsyncCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RunmillError);
    expect((error as RunmillError).code).toBe(code);
  }
}

describe("Work Order schema and signature", () => {
  it("parses a strict v1 envelope and exposes deterministic signing bytes", () => {
    const envelope = signedEnvelope();
    expect(parseWorkOrderEnvelope(envelope)).toEqual(envelope);
    expect(workOrderSigningPayload(envelope)).not.toContain("signature");
    expect(workOrderSigningPayload(envelope)).toContain('"schema":"asf.work-order-envelope/v1"');
  });

  it("refuses unknown envelope and payload major versions before admission", () => {
    expectCode(
      () => parseWorkOrderEnvelope({ ...signedEnvelope(), schema: "asf.work-order-envelope/v2" }),
      "RM-WO-001",
    );
    expectCode(
      () =>
        parseWorkOrderEnvelope({
          ...signedEnvelope(),
          payload: { ...basePayload(), schema: "asf.work-order/v2" },
        }),
      "RM-WO-001",
    );
  });

  it("refuses unknown fields and malformed authority-bearing values", () => {
    expectCode(() => parseWorkOrderEnvelope({ ...signedEnvelope(), merge_now: true }), "RM-WO-002");
    expectCode(
      () =>
        parseWorkOrderEnvelope({
          ...signedEnvelope(),
          payload: { ...basePayload(), repository: { ...basePayload().repository, base_sha: "main" } },
        }),
      "RM-WO-002",
    );
  });

  it.each([
    "main",
    "refs/heads/../main",
    "refs/heads/.hidden",
    "refs/heads/release.lock",
    "refs/heads/topic//child",
    "refs/heads/topic@{1}",
  ])("refuses an ambiguous or invalid base ref: %s", (baseRef) => {
    expectCode(
      () =>
        parseWorkOrderEnvelope({
          ...signedEnvelope(),
          payload: {
            ...basePayload(),
            repository: { ...basePayload().repository, base_ref: baseRef },
          },
        }),
      "RM-WO-002",
    );
  });

  it("requires the idempotency key to bind the signed tenant, work item, and attempt", async () => {
    await expectAsyncCode(
      () =>
        validateWorkOrder(
          signedEnvelope((draft) => {
            draft.payload.idempotency_key = "tenant-acme/ENG-999/attempt_01";
          }),
          {
            policy: policy(),
            repository: observer(),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          },
        ),
      "RM-WO-002",
    );
  });

  it("accepts a valid Ed25519 signature and binds both envelope and payload digests", async () => {
    const result = await validateWorkOrder(signedEnvelope(), {
      policy: policy(),
      repository: observer(),
      clock: new FakeClock("2026-08-21T10:05:00Z"),
    });
    expect(result.signature).toEqual({
      verified: true,
      keyId: "asf-signing-key-2026-01",
      algorithm: "EdDSA",
    });
    expect(result.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.envelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.payloadDigest).not.toBe(result.envelopeDigest);
  });

  it("refuses tampering, an unknown signer, and a non-EdDSA trusted key", async () => {
    const tampered = signedEnvelope();
    tampered.payload.objective.description = "changed after signing";
    await expectAsyncCode(
      () => validateWorkOrder(tampered, { policy: policy(), repository: observer() }),
      "RM-WO-002",
    );

    const unknown = signedEnvelope((draft) => {
      draft.key_id = "unknown-key";
    });
    await expectAsyncCode(
      () => validateWorkOrder(unknown, { policy: policy(), repository: observer() }),
      "RM-WO-002",
    );

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    await expectAsyncCode(
      () => validateWorkOrder(signedEnvelope(), { policy: policy(rsa), repository: observer() }),
      "RM-WO-002",
    );
  });

  it("fails closed for future, expired, and contradictory validity windows", async () => {
    await expectAsyncCode(
      () =>
        validateWorkOrder(signedEnvelope(), {
          policy: policy(),
          repository: observer(),
          clock: new FakeClock("2026-08-21T09:59:59Z"),
        }),
      "RM-WO-002",
    );
    await expectAsyncCode(
      () =>
        validateWorkOrder(signedEnvelope(), {
          policy: policy(),
          repository: observer(),
          clock: new FakeClock("2026-08-21T10:15:00Z"),
        }),
      "RM-WO-002",
    );
    await expectAsyncCode(
      () =>
        validateWorkOrder(
          signedEnvelope((draft) => {
            draft.issued_at = "2026-08-21T10:05:00Z";
            draft.not_before = "2026-08-21T10:00:00Z";
          }),
          {
            policy: policy(),
            repository: observer(),
            clock: new FakeClock("2026-08-21T10:06:00Z"),
          },
        ),
      "RM-WO-002",
    );
  });
});

describe("Work Order repository and effective authority", () => {
  it("builds the monotonic check union, clamps budgets, and preserves layered path authority", async () => {
    const result = await validateWorkOrder(signedEnvelope(), {
      policy: policy(),
      repository: observer(),
      clock: new FakeClock("2026-08-21T10:05:00Z"),
    });
    expect(result.effectivePolicy.requiredLocalCheckIds).toEqual(["integration", "lint", "unit"]);
    expect(result.effectivePolicy.requiredRemoteChecks).toEqual([
      "branch-protection/test",
      "ci/integration",
      "ci/test",
      "security/scan",
    ]);
    expect(result.effectivePolicy.budgets).toEqual({
      wallSeconds: 3_600,
      maxCostUsd: 8,
      maxAgentInvocations: 10,
      maxFixIterations: 2,
    });
    expect(result.effectivePolicy.pathScopes.map((scope) => scope.source)).toEqual([
      "operator",
      "work-order",
      "repository",
    ]);
    expect(evaluateEffectivePathScope(["src/payment.ts"], result.effectivePolicy).accepted).toBe(true);
    const repositoryNarrowing = evaluateEffectivePathScope(
      ["test/payment.test.ts"],
      result.effectivePolicy,
    );
    expect(repositoryNarrowing.accepted).toBe(false);
    expect(repositoryNarrowing.violations).toContainEqual(
      expect.objectContaining({ source: "repository", reason: "outside-allowed-paths" }),
    );
    expect(evaluateEffectivePathScope(["src/generated/client.ts"], result.effectivePolicy)).toEqual(
      expect.objectContaining({ accepted: false }),
    );
  });

  it("binds the signed payload and harness version into the effective policy digest", () => {
    const firstPayload = basePayload();
    const secondPayload = basePayload();
    secondPayload.harness_digest = `sha256:${"7".repeat(64)}`;
    const expandedPolicy = {
      ...policy(),
      harnessDigests: [DIGEST.harness, secondPayload.harness_digest],
    };

    const first = resolveEffectivePolicy(firstPayload, expandedPolicy, repositoryEvidence());
    const second = resolveEffectivePolicy(secondPayload, expandedPolicy, repositoryEvidence());

    expect(first.inputs.workOrderPayload).not.toBe(second.inputs.workOrderPayload);
    expect(first.inputs.harness).toBe(DIGEST.harness);
    expect(second.inputs.harness).toBe(secondPayload.harness_digest);
    expect(first.digest).not.toBe(second.digest);
  });

  it("refuses locally unauthorized work before observing a repository", async () => {
    let observations = 0;
    await expectAsyncCode(
      () =>
        validateWorkOrder(
          signedEnvelope((draft) => {
            draft.payload.repository.repository = "attacker/fork";
          }),
          {
            policy: policy(),
            repository: {
              observe: async () => {
                observations += 1;
                return repositoryEvidence();
              },
            },
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          },
        ),
      "RM-WO-002",
    );
    expect(observations).toBe(0);
  });

  it("denies critical paths by default and requires an exact operator work-class grant", () => {
    const broadPayload = basePayload();
    broadPayload.scope.allowed_paths = ["**"];
    broadPayload.scope.forbidden_paths = [];
    const baseRepository = repositoryEvidence();
    const broadRepository: RepositoryAdmissionEvidence = {
      ...baseRepository,
      constraints: {
        ...baseRepository.constraints,
        pathScope: { allowedPaths: ["**"], forbiddenPaths: [] },
      },
    };
    const basePolicy = policy();
    const broadPolicy: AsfAdmissionPolicy = {
      ...basePolicy,
      authority: {
        ...basePolicy.authority,
        pathScope: { allowedPaths: ["**"], forbiddenPaths: [] },
      },
    };

    const denied = resolveEffectivePolicy(broadPayload, broadPolicy, broadRepository);
    expect(evaluateEffectivePathScope([".github/workflows/ci.yml"], denied).violations).toContainEqual(
      expect.objectContaining({ source: "runmill-default", reason: "forbidden-path" }),
    );
    expect(evaluateEffectivePathScope(["package-lock.json"], denied).accepted).toBe(false);
    expect(evaluateEffectivePathScope(["package.json"], denied).accepted).toBe(false);
    expect(evaluateEffectivePathScope(["requirements.lock"], denied).accepted).toBe(false);

    const grantedPolicy: AsfAdmissionPolicy = {
      ...broadPolicy,
      authority: {
        ...broadPolicy.authority,
        criticalPathGrants: [
          {
            workClass: "dependency-update",
            workOrderPolicyDigest: broadPayload.policy_digest,
            allowedPaths: ["Jenkinsfile", "package.json"],
          },
        ],
      },
    };
    const granted = resolveEffectivePolicy(broadPayload, grantedPolicy, broadRepository);
    expect(evaluateEffectivePathScope(["Jenkinsfile"], granted).accepted).toBe(true);
    expect(evaluateEffectivePathScope(["package.json"], granted).accepted).toBe(false);
    expect(evaluateEffectivePathScope([".github/workflows/ci.yml"], granted).accepted).toBe(false);
  });

  it("does not let a broad Work Order path request widen the operator", () => {
    const payload = basePayload();
    payload.scope.allowed_paths = ["**"];
    const effective = resolveEffectivePolicy(payload, policy(), repositoryEvidence());
    const result = evaluateEffectivePathScope(["docs/escape.md"], effective);
    expect(result.accepted).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ source: "operator", reason: "outside-allowed-paths" }),
    );
  });

  it("does not let repository policy enable an unapproved check command", () => {
    const base = repositoryEvidence();
    const evidence: RepositoryAdmissionEvidence = {
      ...base,
      constraints: {
        ...base.constraints,
        definedLocalCheckIds: ["repo-shell"],
        requiredLocalCheckIds: ["repo-shell"],
      },
    };
    expectCode(
      () => resolveEffectivePolicy(basePayload(), policy(), evidence),
      "RM-WO-005",
    );
  });

  it("refuses an unsupported closure target instead of silently downgrading it", async () => {
    await expectAsyncCode(
      () =>
        validateWorkOrder(
          signedEnvelope((draft) => {
            draft.payload.delivery.closure_target = "merge";
            draft.payload.delivery.merge_policy_ref = "merge-policy/v1";
          }),
          {
            policy: { ...policy(), authority: { ...policy().authority, allowedClosureTargets: ["pr", "merge"] } },
            repository: observer(),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          },
        ),
      "RM-WO-006",
    );
  });

  it("refuses unregistered tenants, identities, runtime profiles, and unknown checks", async () => {
    for (const mutate of [
      (draft: WorkOrderEnvelope): void => {
        draft.payload.tenant_id = "tenant-evil";
        draft.payload.idempotency_key = "tenant-evil/ENG-123/attempt_01";
      },
      (draft: WorkOrderEnvelope): void => {
        draft.payload.identities.implementer = "codex:unregistered";
      },
      (draft: WorkOrderEnvelope): void => {
        draft.payload.identities.local_reviewer = draft.payload.identities.implementer;
      },
      (draft: WorkOrderEnvelope): void => {
        draft.payload.runtime.network_policy = "unrestricted";
      },
      (draft: WorkOrderEnvelope): void => {
        draft.payload.verification.required_local_check_ids = ["repo-supplied-shell"];
      },
    ]) {
      await expectAsyncCode(
        () =>
          validateWorkOrder(signedEnvelope(mutate), {
            policy: policy(),
            repository: observer(),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          }),
        "RM-WO-005",
      );
    }
  });

  it("refuses repository identity, reachability, policy, and forge-protection contradictions", async () => {
    const stalePolicyBytes = Buffer.from("checks: []\n", "utf8");
    const cases: RepositoryAdmissionEvidence[] = [
      { ...repositoryEvidence(), repository: "other/repo" },
      { ...repositoryEvidence(), requestedBaseShaReachable: false },
      {
        ...repositoryEvidence(),
        repositoryPolicyDigest: rawDigest(stalePolicyBytes),
        repositoryPolicyBytesBase64: stalePolicyBytes.toString("base64"),
      },
      {
        ...repositoryEvidence(),
        forgeProtection: { ...repositoryEvidence().forgeProtection, pullRequestsAllowed: false },
      },
    ];
    for (const evidence of cases) {
      await expectAsyncCode(
        () =>
          validateWorkOrder(signedEnvelope(), {
            policy: policy(),
            repository: observer(evidence),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          }),
        evidence.requestedBaseShaReachable === false || evidence.repository === "other/repo"
          ? "RM-WO-004"
          : evidence.forgeProtection.pullRequestsAllowed
            ? "RM-WO-002"
            : "RM-WO-005",
      );
    }
  });

  it("refuses malformed or base-unbound repository and forge observations", async () => {
    const cases: RepositoryAdmissionEvidence[] = [
      { ...repositoryEvidence(), repositoryPolicyDigest: "not-a-digest" },
      { ...repositoryEvidence(), forgeProtectionDigest: "sha256:ABC" },
      { ...repositoryEvidence(), repositoryPolicyBaseSha: "c".repeat(40) },
      { ...repositoryEvidence(), forgeProtectionBaseRef: "refs/heads/release" },
      {
        ...repositoryEvidence(),
        constraints: {
          ...repositoryEvidence().constraints,
          requiredRemoteChecks: ["ci/test\nforged"],
        },
      },
    ];
    for (const evidence of cases) {
      await expectAsyncCode(
        () =>
          validateWorkOrder(signedEnvelope(), {
            policy: policy(),
            repository: observer(evidence),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          }),
        "RM-WO-004",
      );
    }
  });

  it("refuses a Work Order repository that differs from local registration before authority is used", async () => {
    await expectAsyncCode(
      () =>
        validateWorkOrder(
          signedEnvelope((draft) => {
            draft.payload.repository.repository = "attacker/fork";
          }),
          {
            policy: policy(),
            repository: observer(),
            clock: new FakeClock("2026-08-21T10:05:00Z"),
          },
        ),
      "RM-WO-002",
    );
  });
});
