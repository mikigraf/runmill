import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "../../src/asf/canonical-json.js";
import {
  ASF_EVIDENCE_PREDICATE_SCHEMA,
  ASF_EVIDENCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_V1,
  asfEvidenceStatementSchema,
  signAsfEvidenceBundle,
  type AsfEvidencePredicate,
  type AsfEvidenceStatement,
} from "../../src/evidence/asf-bundle.js";
import {
  AsfEvidenceValidationError,
  validateSignedAsfEvidenceBundle,
  verifyAsfEvidenceArtifactContents,
  type AsfEvidenceExpectations,
  type AsfEvidenceValidationFailure,
  type TrustedAsfEvidenceSigner,
} from "../../src/evidence/asf-validator.js";
import {
  ASF_EVIDENCE_EXPECTATIONS_SCHEMA,
  ASF_EVIDENCE_TRUST_SCHEMA,
  parseAsfEvidenceExpectationsDocument,
  parseAsfEvidenceTrustDocument,
  verifyPortableAsfEvidenceBundle,
} from "../../src/evidence/portable-verifier.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const STALE_SHA = "c".repeat(40);
const KEY_ID = "worker-evidence-2026";

function digest(label: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}`;
}

const DIGEST = {
  workOrderEnvelope: digest("work-order-envelope"),
  workOrderPayload: digest("work-order-payload"),
  workOrderArtifact: digest("work-order-artifact"),
  effectivePolicy: digest("effective-policy"),
  policyArtifact: digest("policy-artifact"),
  operatorPolicy: digest("operator-policy"),
  workOrderPolicy: digest("work-order-policy"),
  repositoryPolicy: digest("repository-policy"),
  forgePolicy: digest("forge-policy"),
  tree: digest("candidate-tree"),
  diff: digest("normalized-diff"),
  diffArtifact: digest("normalized-diff-artifact"),
  harness: digest("harness"),
  tools: digest("tool-policy"),
  sandbox: digest("sandbox-profile"),
  dependencies: digest("dependencies"),
  runtime: digest("runtime"),
  runtimeArtifact: digest("runtime-artifact"),
  implementer: digest("implementer-outcome"),
  localReviewer: digest("local-reviewer-outcome"),
  prReviewer: digest("pr-reviewer-outcome"),
  lint: digest("lint-evidence"),
  unit: digest("unit-evidence"),
  ci: digest("ci-evidence"),
  localReview: digest("local-review-evidence"),
  prReview: digest("pr-review-evidence"),
  push: digest("push-evidence"),
  prCreate: digest("pr-create-evidence"),
  commandLint: digest("command-lint"),
  commandUnit: digest("command-unit"),
  toolchain: digest("toolchain"),
} as const;

const ARTIFACT_CONTENT = new Map<string, string>([
  [DIGEST.workOrderArtifact, "work-order-artifact"],
  [DIGEST.policyArtifact, "policy-artifact"],
  [DIGEST.diffArtifact, "normalized-diff-artifact"],
  [DIGEST.runtimeArtifact, "runtime-artifact"],
  [DIGEST.implementer, "implementer-outcome"],
  [DIGEST.localReviewer, "local-reviewer-outcome"],
  [DIGEST.prReviewer, "pr-reviewer-outcome"],
  [DIGEST.lint, "lint-evidence"],
  [DIGEST.unit, "unit-evidence"],
  [DIGEST.ci, "ci-evidence"],
  [DIGEST.localReview, "local-review-evidence"],
  [DIGEST.prReview, "pr-review-evidence"],
  [DIGEST.push, "push-evidence"],
  [DIGEST.prCreate, "pr-create-evidence"],
]);

type ArtifactKind = AsfEvidencePredicate["artifacts"][number]["kind"];

function artifact(
  artifactId: string,
  kind: ArtifactKind,
  artifactDigest: string,
): AsfEvidencePredicate["artifacts"][number] {
  const content = ARTIFACT_CONTENT.get(artifactDigest);
  if (content === undefined) throw new Error(`missing artifact content for ${artifactDigest}`);
  return {
    artifact_id: artifactId,
    kind,
    size_bytes: Buffer.byteLength(content),
    media_type: "application/json",
    digest: artifactDigest,
    retention_class: kind === "work-order-envelope" ? "protected" : "portable",
    location_ref: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
  };
}

function statementFixture(): AsfEvidenceStatement {
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: "github:acme/payments", digest: { sha1: CANDIDATE_SHA } }],
    predicateType: ASF_EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: ASF_EVIDENCE_PREDICATE_SCHEMA,
      run: {
        run_id: "run_01",
        attempt_id: "attempt_01",
        work_order_id: "wo_01",
        completed_at: "2026-08-21T10:19:00Z",
      },
      work_order: {
        envelope_digest: DIGEST.workOrderEnvelope,
        payload_digest: DIGEST.workOrderPayload,
        envelope_artifact_digest: DIGEST.workOrderArtifact,
        signature: {
          key_id: "asf-work-order-key-2026",
          algorithm: "EdDSA",
          verified: true,
        },
      },
      policy: {
        effective_policy_digest: DIGEST.effectivePolicy,
        effective_policy_artifact_digest: DIGEST.policyArtifact,
        inputs: {
          operator_policy_digest: DIGEST.operatorPolicy,
          work_order_policy_digest: DIGEST.workOrderPolicy,
          repository_policy_digest: DIGEST.repositoryPolicy,
          forge_policy_digest: DIGEST.forgePolicy,
        },
        required_local_checks: ["lint", "unit"],
        required_ci_contexts: ["ci/test"],
        require_local_review: true,
        require_pull_request_review: true,
      },
      source: {
        forge: "github",
        repository: "acme/payments",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
        candidate_sha: CANDIDATE_SHA,
        remote_head_sha: CANDIDATE_SHA,
        merge_sha: null,
        tree_digest: DIGEST.tree,
        normalized_diff_digest: DIGEST.diff,
        normalized_diff_artifact_digest: DIGEST.diffArtifact,
        changed_paths: ["src/payment.ts", "test/payment.test.ts"],
      },
      runtime: {
        harness_digest: DIGEST.harness,
        tool_policy_digest: DIGEST.tools,
        sandbox_profile_digest: DIGEST.sandbox,
        dependency_digest: DIGEST.dependencies,
        runtime_digest: DIGEST.runtime,
        runtime_manifest_digest: DIGEST.runtimeArtifact,
        providers: [
          {
            role: "implementer",
            provider: "codex",
            model: "gpt-5.6-sol",
            principal_id: "principal-implementer",
            lease_attribution_digest: DIGEST.implementer,
          },
          {
            role: "local-reviewer",
            provider: "claude",
            model: "claude-sonnet",
            principal_id: "principal-local-reviewer",
            lease_attribution_digest: DIGEST.localReviewer,
          },
          {
            role: "pull-request-reviewer",
            provider: "codex",
            model: "gpt-5.6-sol",
            principal_id: "principal-pr-reviewer",
            lease_attribution_digest: DIGEST.prReviewer,
          },
        ],
      },
      role_outcomes: [
        {
          role: "implementer",
          outcome: "completed",
          candidate_sha: CANDIDATE_SHA,
          evidence_digest: DIGEST.implementer,
        },
        {
          role: "local-reviewer",
          outcome: "passed",
          candidate_sha: CANDIDATE_SHA,
          evidence_digest: DIGEST.localReviewer,
        },
        {
          role: "pull-request-reviewer",
          outcome: "passed",
          candidate_sha: CANDIDATE_SHA,
          evidence_digest: DIGEST.prReviewer,
        },
      ],
      verification: {
        local_checks: [
          {
            check_id: "lint",
            candidate_sha: CANDIDATE_SHA,
            tree_digest: DIGEST.tree,
            command_digest: DIGEST.commandLint,
            executor_id: "local-runner",
            toolchain_digest: DIGEST.toolchain,
            sandbox_profile_digest: DIGEST.sandbox,
            started_at: "2026-08-21T10:10:00Z",
            completed_at: "2026-08-21T10:11:00Z",
            conclusion: "success",
            coverage: "complete",
            evidence_digest: DIGEST.lint,
          },
          {
            check_id: "unit",
            candidate_sha: CANDIDATE_SHA,
            tree_digest: DIGEST.tree,
            command_digest: DIGEST.commandUnit,
            executor_id: "local-runner",
            toolchain_digest: DIGEST.toolchain,
            sandbox_profile_digest: DIGEST.sandbox,
            started_at: "2026-08-21T10:11:00Z",
            completed_at: "2026-08-21T10:12:00Z",
            conclusion: "success",
            coverage: "complete",
            evidence_digest: DIGEST.unit,
          },
        ],
        ci_contexts: [
          {
            context: "ci/test",
            candidate_sha: CANDIDATE_SHA,
            conclusion: "success",
            observed_at: "2026-08-21T10:15:00Z",
            evidence_digest: DIGEST.ci,
          },
        ],
      },
      reviews: [
        {
          review_id: "review-local-01",
          stage: "local",
          reviewer_principal: "principal-local-reviewer",
          reviewer_profile: "local-review-profile",
          independent: true,
          candidate_sha: CANDIDATE_SHA,
          policy_digest: DIGEST.effectivePolicy,
          verdict: "pass",
          findings_digest: DIGEST.localReview,
          evidence_digest: DIGEST.localReview,
        },
        {
          review_id: "review-pr-01",
          stage: "pull-request",
          reviewer_principal: "principal-pr-reviewer",
          reviewer_profile: "pr-review-profile",
          independent: true,
          candidate_sha: CANDIDATE_SHA,
          policy_digest: DIGEST.effectivePolicy,
          verdict: "pass",
          findings_digest: DIGEST.prReview,
          evidence_digest: DIGEST.prReview,
        },
      ],
      side_effects: [
        {
          effect_key: digest("effect-push"),
          kind: "branch.push",
          candidate_sha: CANDIDATE_SHA,
          intent_digest: digest("push-intent"),
          observation_digest: digest("push-observation"),
          reconciliation_digest: null,
          confirmation_digest: digest("push-confirmation"),
          status: "confirmed",
          evidence_digest: DIGEST.push,
        },
        {
          effect_key: digest("effect-pr-create"),
          kind: "pull-request.create",
          candidate_sha: CANDIDATE_SHA,
          intent_digest: digest("pr-intent"),
          observation_digest: digest("pr-observation"),
          reconciliation_digest: digest("pr-reconciliation"),
          confirmation_digest: digest("pr-confirmation"),
          status: "confirmed",
          evidence_digest: DIGEST.prCreate,
        },
      ],
      approvals: [],
      cancellation: null,
      budget: {
        cost_usd: 2.5,
        agent_invocations: 4,
        fix_iterations: 1,
        elapsed_ms: 1_140_000,
        stop_reason: "pr-delivered",
      },
      delivery: {
        closure_target: "pr",
        satisfied: true,
        pull_request: {
          forge: "github",
          repository: "acme/payments",
          number: 42,
          url: "https://github.com/acme/payments/pull/42",
          head_ref: "refs/heads/runmill/run_01",
          base_ref: "refs/heads/main",
          head_sha: CANDIDATE_SHA,
          observed_at: "2026-08-21T10:18:00Z",
          evidence_digest: DIGEST.prCreate,
        },
      },
      artifacts: [
        artifact("artifact-work-order", "work-order-envelope", DIGEST.workOrderArtifact),
        artifact("artifact-policy", "effective-policy", DIGEST.policyArtifact),
        artifact("artifact-diff", "normalized-diff", DIGEST.diffArtifact),
        artifact("artifact-runtime", "runtime-manifest", DIGEST.runtimeArtifact),
        artifact("artifact-implementer", "agent-outcome", DIGEST.implementer),
        artifact("artifact-local-reviewer", "agent-outcome", DIGEST.localReviewer),
        artifact("artifact-pr-reviewer", "agent-outcome", DIGEST.prReviewer),
        artifact("artifact-lint", "verification", DIGEST.lint),
        artifact("artifact-unit", "verification", DIGEST.unit),
        artifact("artifact-ci", "ci-observation", DIGEST.ci),
        artifact("artifact-local-review", "review", DIGEST.localReview),
        artifact("artifact-pr-review", "review", DIGEST.prReview),
        artifact("artifact-push", "side-effect", DIGEST.push),
        artifact("artifact-pr-create", "side-effect", DIGEST.prCreate),
      ],
    },
  };
}

function expected(overrides: Partial<AsfEvidenceExpectations> = {}): AsfEvidenceExpectations {
  return {
    runId: "run_01",
    attemptId: "attempt_01",
    workOrderId: "wo_01",
    workOrderEnvelopeDigest: DIGEST.workOrderEnvelope,
    workOrderPayloadDigest: DIGEST.workOrderPayload,
    effectivePolicyDigest: DIGEST.effectivePolicy,
    forge: "github",
    repository: "acme/payments",
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    treeDigest: DIGEST.tree,
    normalizedDiffDigest: DIGEST.diff,
    changedPaths: ["src/payment.ts", "test/payment.test.ts"],
    requiredLocalCheckIds: ["lint", "unit"],
    requiredCiContexts: ["ci/test"],
    requireLocalReview: true,
    requirePullRequestReview: true,
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/payments/pull/42",
      headRef: "refs/heads/runmill/run_01",
      baseRef: "refs/heads/main",
    },
    ...overrides,
  };
}

function trustedSigner(
  overrides: Partial<TrustedAsfEvidenceSigner> = {},
): TrustedAsfEvidenceSigner {
  return {
    keyId: KEY_ID,
    publicKey,
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

function signed(
  statement = statementFixture(),
  signingKey: KeyObject = privateKey,
  keyId = KEY_ID,
) {
  return signAsfEvidenceBundle({
    statement,
    keyId,
    privateKey: signingKey,
    issuedAt: "2026-08-21T10:20:00Z",
  });
}

function portableTrustDocument(): Record<string, unknown> {
  return {
    schema: ASF_EVIDENCE_TRUST_SCHEMA,
    signers: [
      {
        key_id: KEY_ID,
        public_key_pem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        valid_from: "2026-01-01T00:00:00Z",
        valid_until: "2027-01-01T00:00:00Z",
        revoked_at: null,
      },
    ],
  };
}

function portableExpectationsDocument(): Record<string, unknown> {
  const value = expected();
  return {
    schema: ASF_EVIDENCE_EXPECTATIONS_SCHEMA,
    run_id: value.runId,
    attempt_id: value.attemptId,
    work_order_id: value.workOrderId,
    work_order_envelope_digest: value.workOrderEnvelopeDigest,
    work_order_payload_digest: value.workOrderPayloadDigest,
    effective_policy_digest: value.effectivePolicyDigest,
    forge: value.forge,
    repository: value.repository,
    base_ref: value.baseRef,
    base_sha: value.baseSha,
    candidate_sha: value.candidateSha,
    tree_digest: value.treeDigest,
    normalized_diff_digest: value.normalizedDiffDigest,
    changed_paths: [...value.changedPaths],
    required_local_check_ids: [...value.requiredLocalCheckIds],
    required_ci_contexts: [...value.requiredCiContexts],
    require_local_review: value.requireLocalReview,
    require_pull_request_review: value.requirePullRequestReview,
    pull_request: {
      number: value.pullRequest.number,
      url: value.pullRequest.url,
      head_ref: value.pullRequest.headRef,
      base_ref: value.pullRequest.baseRef,
    },
  };
}

function validate(
  raw: unknown,
  options: {
    readonly expected?: AsfEvidenceExpectations | undefined;
    readonly signers?: readonly TrustedAsfEvidenceSigner[] | undefined;
  } = {},
) {
  return validateSignedAsfEvidenceBundle(raw, {
    clock: new FakeClock("2026-08-21T10:21:00Z"),
    trustedSigners: options.signers ?? [trustedSigner()],
    expected: options.expected ?? expected(),
  });
}

function expectFailure(
  action: () => unknown,
  failure: AsfEvidenceValidationFailure,
): AsfEvidenceValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AsfEvidenceValidationError);
    expect(error).toMatchObject({ failure });
    return error as AsfEvidenceValidationError;
  }
  throw new Error(`expected ASF evidence ${failure} failure`);
}

describe("signed portable ASF evidence", () => {
  it("independently validates a canonical candidate- and PR-bound Ed25519 statement", () => {
    const result = validate(signed());

    expect(result.signer).toEqual({
      keyId: KEY_ID,
      algorithm: "EdDSA",
      verified: true,
    });
    expect(result.candidateSha).toBe(CANDIDATE_SHA);
    expect(result.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.bundle.bundle_digest).toBe(result.bundleDigest);
    expect(JSON.stringify(result.bundle)).not.toMatch(
      /access[_-]?token|credential|private[_-]?key|transcript|prompt/iu,
    );
  });

  it("keeps archival approval evidence valid after expiry when authority was applied in time", () => {
    const statement = statementFixture();
    statement.predicate.approvals = [
      {
        approval_id: "approval-01",
        decision_type: "repository-write",
        requested_effect: "pull-request-create",
        approver_subject: "operator-01",
        authority_digest: digest("approval-authority"),
        work_order_digest: DIGEST.workOrderPayload,
        candidate_sha: CANDIDATE_SHA,
        policy_digest: DIGEST.effectivePolicy,
        issued_at: "2026-08-21T10:00:00Z",
        expires_at: "2026-08-21T10:05:00Z",
        applied_at: "2026-08-21T10:04:00Z",
        signature_digest: digest("approval-signature"),
        evidence_digest: DIGEST.localReview,
      },
    ];

    expect(() => validate(signed(statement))).not.toThrow();

    statement.predicate.approvals[0]!.applied_at = "2026-08-21T10:05:00Z";
    expectFailure(() => validate(signed(statement)), "missing-evidence");
  });

  it("rejects statement tampering even when an attacker recomputes the public digest", () => {
    const tampered = structuredClone(signed());
    tampered.statement.predicate.source.candidate_sha = STALE_SHA;
    tampered.bundle_digest = sha256Digest(tampered.statement);

    expectFailure(() => validate(tampered), "signature");
  });

  it("rejects a valid signature when the candidate or PR delivery is stale", () => {
    expectFailure(
      () => validate(signed(), { expected: expected({ candidateSha: STALE_SHA }) }),
      "binding",
    );

    const contradictory = statementFixture();
    contradictory.predicate.delivery.pull_request.head_sha = STALE_SHA;
    expectFailure(() => validate(signed(contradictory)), "binding");
  });

  it("rejects unknown, expired, and revoked signing identities", () => {
    expectFailure(() => validate(signed(), { signers: [] }), "trust");
    expectFailure(
      () =>
        validate(signed(), {
          signers: [trustedSigner({ validUntil: "2026-08-21T10:19:59Z" })],
        }),
      "trust",
    );
    expectFailure(
      () =>
        validate(signed(), {
          signers: [trustedSigner({ revokedAt: "2026-08-21T10:20:30Z" })],
        }),
      "trust",
    );
    expectFailure(
      () =>
        validate(signed(statementFixture(), otherKey.privateKey), {
          signers: [trustedSigner()],
        }),
      "signature",
    );
  });

  it("fails closed when required checks or confirmed delivery effects are missing", () => {
    const missingCheck = statementFixture();
    missingCheck.predicate.verification.local_checks =
      missingCheck.predicate.verification.local_checks.filter(
        (check) => check.check_id !== "unit",
      );
    expectFailure(() => validate(signed(missingCheck)), "missing-evidence");

    const missingPush = statementFixture();
    missingPush.predicate.side_effects = missingPush.predicate.side_effects.filter(
      (effect) => effect.kind !== "branch.push",
    );
    expectFailure(() => validate(signed(missingPush)), "missing-evidence");
  });

  it("excludes credential-bearing and non-content-addressed fields from the strict schema", () => {
    const credentialBearing = structuredClone(statementFixture()) as unknown as {
      predicate: { runtime: Record<string, unknown> };
    };
    credentialBearing.predicate.runtime["provider_token"] = "not-portable";
    expect(asfEvidenceStatementSchema.safeParse(credentialBearing).success).toBe(false);

    const leaseCapability = structuredClone(statementFixture()) as unknown as {
      predicate: { runtime: { providers: Array<Record<string, unknown>> } };
    };
    const firstProvider = leaseCapability.predicate.runtime.providers[0];
    if (firstProvider === undefined) throw new Error("missing provider fixture");
    firstProvider["lease_id"] = "sensitive-controller-lease-capability";
    expect(asfEvidenceStatementSchema.safeParse(leaseCapability).success).toBe(false);

    const badLocation = statementFixture();
    const firstArtifact = badLocation.predicate.artifacts[0];
    if (firstArtifact === undefined) throw new Error("missing artifact fixture");
    firstArtifact.location_ref = `cas://sha256/${"f".repeat(64)}`;
    expectFailure(() => validate(signed(badLocation)), "digest");
  });

  it("re-hashes every bounded CAS artifact before permitting durable finalization", async () => {
    const verified = await verifyAsfEvidenceArtifactContents(validate(signed()), {
      maxArtifactBytes: 1_024,
      maxTotalBytes: 64 * 1_024,
      resolver: {
        async read(input) {
          const content = ARTIFACT_CONTENT.get(input.expectedDigest);
          if (content === undefined) throw new Error("missing test artifact");
          return Buffer.from(content, "utf8");
        },
      },
    });

    expect(verified.artifacts).toEqual({
      verified: true,
      count: verified.bundle.statement.predicate.artifacts.length,
      totalBytes: [...ARTIFACT_CONTENT.values()].reduce(
        (total, value) => total + Buffer.byteLength(value),
        0,
      ),
      manifestDigest: sha256Digest(verified.bundle.statement.predicate.artifacts),
    });
  });

  it("fails closed when a CAS body, declared size, or verification budget is wrong", async () => {
    const validated = validate(signed());
    await expect(
      verifyAsfEvidenceArtifactContents(validated, {
        maxArtifactBytes: 1_024,
        maxTotalBytes: 64 * 1_024,
        resolver: { read: async () => Buffer.from("tampered", "utf8") },
      }),
    ).rejects.toMatchObject({ failure: "digest" });
    await expect(
      verifyAsfEvidenceArtifactContents(validated, {
        maxArtifactBytes: 1,
        maxTotalBytes: 64 * 1_024,
        resolver: { read: async () => Buffer.alloc(0) },
      }),
    ).rejects.toMatchObject({ failure: "missing-evidence" });
  });

  it("verifies a bundle from portable trust and authoritative-facts documents", async () => {
    const result = await verifyPortableAsfEvidenceBundle({
      bundle: signed(),
      trust: portableTrustDocument(),
      expectations: portableExpectationsDocument(),
      clock: new FakeClock("2026-08-21T10:21:00Z"),
      artifactResolver: {
        async read(input) {
          const content = ARTIFACT_CONTENT.get(input.expectedDigest);
          if (content === undefined) throw new Error("missing test artifact");
          return Buffer.from(content, "utf8");
        },
      },
    });

    expect(result.kind).toBe("delivery");
    if (result.kind !== "delivery") throw new Error("unexpected terminal bundle");
    expect(result.validated.signer).toEqual({
      keyId: KEY_ID,
      algorithm: "EdDSA",
      verified: true,
    });
    expect(result.artifacts?.artifacts.verified).toBe(true);
    expect(result.artifacts?.artifacts.count).toBe(
      result.validated.bundle.statement.predicate.artifacts.length,
    );
  });

  it("rejects contradictory portable trust metadata before touching a bundle", () => {
    const trust = portableTrustDocument();
    trust.signers = [
      ...(trust.signers as unknown[]),
      ...(trust.signers as unknown[]),
    ];
    expect(() => parseAsfEvidenceTrustDocument(trust)).toThrow(
      /duplicate key ids/u,
    );
    expect(() =>
      parseAsfEvidenceExpectationsDocument({
        ...portableExpectationsDocument(),
        unexpected: true,
      }),
    ).toThrow(/unexpected/u);
  });
});
