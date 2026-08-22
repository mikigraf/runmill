import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Digest } from "../../src/asf/canonical-json.js";
import {
  ProductionAsfEvidenceFinalizationController,
  type AsfEvidenceFinalizationMaterial,
} from "../../src/asf/evidence-finalizer.js";
import {
  DeterministicAsfEvidenceMaterialSource,
  type AsfEvidenceFinalizationRecordSet,
} from "../../src/asf/evidence-material-source.js";
import {
  ASF_EVIDENCE_SIGNING_ENV,
  loadAsfEvidenceSigningKey,
  type AsfEvidenceSigningKey,
} from "../../src/asf/evidence-signing-config.js";
import type {
  AsfDeliveryBinding,
  AsfDeliveryStageIntent,
} from "../../src/asf/delivery-runner.js";
import type { RunEvent, RunEventPhase } from "../../src/asf/run-event.js";
import {
  EFFECTIVE_POLICY_SCHEMA,
  WORK_ORDER_ENVELOPE_SCHEMA,
  WORK_ORDER_SCHEMA,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
  workOrderSigningPayload,
} from "../../src/asf/work-order.js";
import {
  ASF_EVIDENCE_PREDICATE_SCHEMA,
  ASF_EVIDENCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_V1,
  type AsfEvidencePredicate,
  type AsfEvidenceStatement,
} from "../../src/evidence/asf-bundle.js";
import { AsfEvidenceValidationError } from "../../src/evidence/asf-validator.js";
import { FilesystemAsfArtifactStore } from "../../src/evidence/filesystem-cas.js";
import type { AsfDurableRunSnapshot } from "../../src/state/store.js";
import { FakeClock } from "../../src/testing/fake-clock.js";
import {
  ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
  identityAttributionsDigest,
  identityLeaseAttributionDigest,
  type AsfIdentityLeaseAttribution,
  type AsfRequiredIdentityRole,
} from "../../src/asf/identity-attribution.js";

const NOW = "2026-08-21T10:01:00.000Z";
const CANDIDATE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const STALE_SHA = "c".repeat(40);

function digest(body: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

const FINAL_PROTECTION = {
  required_checks: ["ci/test"],
  requires_approval: false,
  requires_conversation_resolution: false,
  uses_merge_queue: false,
} as const;
const FINAL_PROTECTION_DIGEST = sha256Digest({
  schema: "runmill.github-base-protection/v1",
  repository: "acme/payments",
  base_ref: "refs/heads/main",
  protection: FINAL_PROTECTION,
});

const BODY = {
  diff: "normalized-diff",
  runtime: "runtime-manifest",
  implementer: "implementer-outcome",
  localReviewer: "local-reviewer-outcome",
  prReviewer: "pr-reviewer-outcome",
  localCheck: "local-check",
  ci: "ci-observation",
  localReview: "local-review",
  prReview: "pr-review",
  push: "push-observation",
  pullRequest: "pull-request-observation",
} as const;

const DIGEST = {
  sourceSnapshot: digest("source-snapshot"),
  workOrderPolicy: digest("work-order-policy"),
  harness: digest("harness"),
  operatorPolicy: digest("operator-policy"),
  repositoryPolicy: digest("repository-policy"),
  forgePolicy: digest("forge-policy"),
  tree: digest("tree"),
  normalizedDiff: digest("normalized-diff-model"),
  diffArtifact: digest(BODY.diff),
  runtimeArtifact: digest(BODY.runtime),
  implementer: digest(BODY.implementer),
  localReviewer: digest(BODY.localReviewer),
  prReviewer: digest(BODY.prReviewer),
  localCheck: digest(BODY.localCheck),
  ci: digest(BODY.ci),
  localReview: digest(BODY.localReview),
  prReview: digest(BODY.prReview),
  push: digest(BODY.push),
  pullRequest: digest(BODY.pullRequest),
  command: digest("command"),
  toolchain: digest("toolchain"),
  sandbox: digest("sandbox"),
  toolPolicy: digest("tool-policy"),
  dependencies: digest("dependencies"),
  runtime: digest("runtime"),
} as const;

function envelopeFixture(): WorkOrderEnvelope {
  return {
    schema: WORK_ORDER_ENVELOPE_SCHEMA,
    key_id: "asf-work-order-2026",
    algorithm: "EdDSA",
    issued_at: "2026-08-21T09:55:00.000Z",
    not_before: "2026-08-21T09:55:00.000Z",
    expires_at: "2026-08-21T11:00:00.000Z",
    payload: {
      schema: WORK_ORDER_SCHEMA,
      work_order_id: "wo_01",
      tenant_id: "tenant_01",
      work_item_id: "item_01",
      attempt_id: "attempt_01",
      idempotency_key: "tenant_01/wo_01/attempt_01",
      source: {
        system: "linear",
        external_id: "ENG-1",
        snapshot_digest: DIGEST.sourceSnapshot,
      },
      repository: {
        forge: "github",
        repository: "acme/payments",
        base_ref: "refs/heads/main",
        base_sha: BASE_SHA,
      },
      objective: {
        title: "Implement payment guard",
        description: "Implement the signed Work Order only.",
        acceptance_criteria: ["The exact candidate passes verification."],
        non_goals: [],
      },
      scope: {
        allowed_paths: ["src/**", "test/**"],
        forbidden_paths: [],
        risk_class: "low",
      },
      verification: {
        required_local_check_ids: ["unit"],
        required_remote_checks: ["ci/test"],
        policy_snapshot_digest: DIGEST.repositoryPolicy,
      },
      identities: {
        implementer: "profile-implementer",
        local_reviewer: "profile-local-reviewer",
        pr_reviewer: "profile-pr-reviewer",
      },
      runtime: {
        sandbox_profile: "sandbox-production",
        tool_policy: "tools-production",
        network_policy: "network-deny-default",
      },
      budgets: {
        wall_seconds: 3_600,
        max_cost_usd: 10,
        max_agent_invocations: 10,
        max_fix_iterations: 2,
      },
      delivery: {
        closure_target: "pr",
        draft_pr: false,
        merge_policy_ref: null,
      },
      policy_digest: DIGEST.workOrderPolicy,
      harness_digest: DIGEST.harness,
    },
    signature: "base64url:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
}

function policyFixture(envelope: WorkOrderEnvelope): EffectiveAsfPolicy {
  const unsigned = {
    schema: EFFECTIVE_POLICY_SCHEMA,
    inputs: {
      operatorPolicy: DIGEST.operatorPolicy,
      workOrderPolicy: envelope.payload.policy_digest,
      workOrderPayload: sha256Digest(envelope.payload),
      harness: envelope.payload.harness_digest,
      repositoryPolicy: DIGEST.repositoryPolicy,
      repositoryPolicyBaseSha: BASE_SHA,
      repositoryPolicyPath: ".runmill/checks.yaml",
      repositoryPolicyBytesBase64: "Y2hlY2tzOiBbXQo=",
      observedBaseSha: BASE_SHA,
      forgeProtection: FINAL_PROTECTION_DIGEST,
      forgeProtectionBaseRef: "refs/heads/main",
      forgeProtectionBytesBase64: "e30=",
    },
    pathScopes: [
      { source: "operator" as const, allowedPaths: ["src/**", "test/**"], forbiddenPaths: [] },
      { source: "work-order" as const, allowedPaths: ["src/**", "test/**"], forbiddenPaths: [] },
      { source: "repository" as const, allowedPaths: ["src/**", "test/**"], forbiddenPaths: [] },
    ],
    criticalPaths: { workClass: null, approvedPaths: [] },
    requiredLocalCheckIds: ["unit"],
    requiredRemoteChecks: ["ci/test"],
    riskClass: "low" as const,
    identities: {
      implementer: "profile-implementer",
      localReviewer: "profile-local-reviewer",
      prReviewer: "profile-pr-reviewer",
    },
    runtime: {
      sandboxProfile: "sandbox-production",
      toolPolicy: "tools-production",
      networkPolicy: "network-deny-default",
    },
    budgets: {
      wallSeconds: 3_600,
      maxCostUsd: 10,
      maxAgentInvocations: 10,
      maxFixIterations: 2,
    },
    delivery: { closureTarget: "pr" as const, draftPr: false },
  };
  return { ...unsigned, digest: sha256Digest(unsigned) };
}

function event(
  policyDigest: string,
  seq: number,
  type: string,
  phase: RunEventPhase,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    schema: "asf.run-event/v1",
    event_id: `event_${seq}`,
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    seq,
    occurred_at: `2026-08-21T10:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    phase,
    payload,
    policy_digest: policyDigest,
  };
}

function identityAttributionsFixture(
  policy: EffectiveAsfPolicy,
): readonly AsfIdentityLeaseAttribution[] {
  const binding = {
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    policy_digest: policy.digest,
    fencing_generation: 1,
    candidate_sha: null,
  } as const;
  const values: ReadonlyArray<{
    role: AsfRequiredIdentityRole;
    provider: string;
    principal: string;
    profile: string;
  }> = [
    {
      role: "implementer",
      provider: "codex",
      principal: "principal-implementer",
      profile: policy.identities.implementer,
    },
    {
      role: "local-reviewer",
      provider: "claude",
      principal: "principal-local-reviewer",
      profile: policy.identities.localReviewer,
    },
    {
      role: "pr-reviewer",
      provider: "codex",
      principal: "principal-pr-reviewer",
      profile: policy.identities.prReviewer,
    },
  ];
  return values.map((value) => {
    const unsigned = {
      schema: ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA,
      role: value.role,
      provider: value.provider,
      principal_id: value.principal,
      profile: value.profile,
      fencing_generation: binding.fencing_generation,
      issued_at: "2026-08-21T10:00:02.000Z",
      expires_at: "2026-08-21T11:00:02.000Z",
    } as const;
    return {
      ...unsigned,
      lease_attribution_digest: identityLeaseAttributionDigest(binding, unsigned),
    };
  });
}

function eventsFixture(
  envelope: WorkOrderEnvelope,
  policy: EffectiveAsfPolicy,
): readonly RunEvent[] {
  const common = { candidate_sha: CANDIDATE_SHA };
  const attributions = identityAttributionsFixture(policy);
  const initialCiChecks = [
    { context: "ci/test", outcome: "passed" as const, evidence_digest: DIGEST.ci },
  ];
  const finalCiChecks = [
    { context: "ci/test", outcome: "passed" as const, evidence_digest: DIGEST.ci },
  ];
  const finalCiObservation = {
    schema: "asf.ci-head-observation/v1" as const,
    binding: {
      run_id: "run_01",
      work_order_id: "wo_01",
      attempt_id: "attempt_01",
      policy_digest: policy.digest,
      fencing_generation: 1,
      candidate_sha: CANDIDATE_SHA,
    },
    repository: "acme/payments",
    pull_request_number: 42,
    candidate_sha: CANDIDATE_SHA,
    observed_head_sha: CANDIDATE_SHA,
    observed_at: "2026-08-21T10:00:18.500Z",
    checks: finalCiChecks,
  };
  const finalDeliveryObservation = {
    schema: "asf.github-final-pr-delivery-observation/v1" as const,
    repository: "acme/payments",
    pull_request_number: 42,
    url: "https://github.com/acme/payments/pull/42",
    head_ref: "refs/heads/runmill/run_01",
    base_ref: "refs/heads/main",
    marker: "runmill:v1:run_01",
    head_sha: CANDIDATE_SHA,
    current_base_sha: BASE_SHA,
    collision_set_digest: digest("final-pr-collision-set"),
    base_observation_digest: digest("final-base-observation"),
    protection_digest: policy.inputs.forgeProtection,
    protection: FINAL_PROTECTION,
    observed_at: "2026-08-21T10:00:19.000Z",
    state: "open" as const,
    draft: false,
  };
  return [
    event(policy.digest, 1, "work_order.admitted", "ADMITTED", {
      work_order_id: "wo_01",
      attempt_id: "attempt_01",
      tenant_id: "tenant_01",
      payload_digest: sha256Digest(envelope.payload),
      envelope_digest: sha256Digest(envelope),
      signature: { verified: true, key_id: envelope.key_id, algorithm: "EdDSA" },
    }),
    event(policy.digest, 2, "repository.lease_acquired", "REPOSITORY_LEASED", {
      repository: "acme/payments",
      generation: 1,
    }),
    event(policy.digest, 3, "identity.leases_acquired", "IDENTITY_READY", {
      attributions_digest: identityAttributionsDigest(attributions),
      roles: ["implementer", "local-reviewer", "pr-reviewer"],
      attributions: [...attributions],
    }),
    event(policy.digest, 4, "workspace.prepared", "WORKSPACE_READY", {
      workspace_id: "workspace_01",
      sandbox_profile: "sandbox-production",
      isolation_evidence_digest: digest("isolation"),
    }),
    event(policy.digest, 5, "task_packet.created", "TASK_PACKET_READY", {
      task_packet_digest: digest("task-packet"),
      source_snapshot_digest: DIGEST.sourceSnapshot,
    }),
    event(policy.digest, 6, "implementation.started", "IMPLEMENTING", {
      session: "new",
      checkpoint_digest: digest("implementation-checkpoint"),
    }),
    event(policy.digest, 7, "candidate.created", "CANDIDATE_READY", {
      ...common,
      parent_sha: BASE_SHA,
      tree_digest: DIGEST.tree,
    }),
    event(policy.digest, 8, "verification.started", "LOCAL_VERIFY", {
      ...common,
      required_check_ids: ["unit"],
    }),
    event(policy.digest, 9, "verification.completed", "LOCAL_VERIFY", {
      ...common,
      check_id: "unit",
      outcome: "passed",
      evidence_digest: DIGEST.localCheck,
    }),
    event(policy.digest, 10, "review.started", "LOCAL_REVIEW", {
      ...common,
      reviewer_attribution: "profile-local-reviewer",
    }),
    event(policy.digest, 11, "review.completed", "LOCAL_REVIEW", {
      ...common,
      reviewer_attribution: "profile-local-reviewer",
      outcome: "approved",
      findings_digest: DIGEST.localReview,
    }),
    event(policy.digest, 12, "delivery.ready", "DELIVERY_READY", {
      ...common,
      required_remote_checks: ["ci/test"],
    }),
    event(policy.digest, 13, "branch.pushed", "PUSHED", {
      ...common,
      remote_ref: "refs/heads/runmill/run_01",
      observed_remote_sha: CANDIDATE_SHA,
    }),
    event(policy.digest, 14, "pull_request.opened", "PR_OPEN", {
      ...common,
      repository: "acme/payments",
      number: 42,
      url: "https://github.com/acme/payments/pull/42",
      observed_head_sha: CANDIDATE_SHA,
      base_sha: BASE_SHA,
    }),
    event(policy.digest, 15, "ci.waiting", "CI_WAIT", {
      ...common,
      snapshot_digest: digest("ci-snapshot"),
    }),
    event(policy.digest, 16, "ci.completed", "CI_WAIT", {
      ...common,
      outcome: "passed",
      checks_digest: sha256Digest(initialCiChecks),
      checks: initialCiChecks,
      observed_at: "2026-08-21T10:00:15.500Z",
    }),
    event(policy.digest, 17, "pr_review.started", "PR_REVIEW", {
      ...common,
      reviewer_attribution: "profile-pr-reviewer",
    }),
    event(policy.digest, 18, "pr_review.completed", "PR_REVIEW", {
      ...common,
      reviewer_attribution: "profile-pr-reviewer",
      outcome: "approved",
      findings_digest: DIGEST.prReview,
    }),
    event(policy.digest, 19, "ci.revalidated", "PR_REVIEW", {
      ...common,
      outcome: "passed",
      observation_intent_digest: digest("final-ci-intent"),
      observation_digest: sha256Digest(finalCiObservation),
      observation_fencing_generation: 1,
      checks_digest: sha256Digest(finalCiChecks),
      checks: finalCiChecks,
      observed_at: finalCiObservation.observed_at,
    }),
    event(policy.digest, 20, "pull_request.delivered", "PR_DELIVERED", {
      ...common,
      repository: "acme/payments",
      number: 42,
      url: "https://github.com/acme/payments/pull/42",
      head_ref: "refs/heads/runmill/run_01",
      base_ref: "refs/heads/main",
      marker: "runmill:v1:run_01",
      head_sha: CANDIDATE_SHA,
      observed_head_sha: CANDIDATE_SHA,
      current_base_sha: BASE_SHA,
      collision_set_digest: finalDeliveryObservation.collision_set_digest,
      base_observation_digest: finalDeliveryObservation.base_observation_digest,
      protection_digest: policy.inputs.forgeProtection,
      protection: {
        required_checks: [...FINAL_PROTECTION.required_checks],
        requires_approval: FINAL_PROTECTION.requires_approval,
        requires_conversation_resolution: FINAL_PROTECTION.requires_conversation_resolution,
        uses_merge_queue: FINAL_PROTECTION.uses_merge_queue,
      },
      state: "open",
      draft: false,
      delivery_observation_intent_digest: digest("final-delivery-intent"),
      delivery_observation_digest: sha256Digest(finalDeliveryObservation),
      observed_at: finalDeliveryObservation.observed_at,
      final_ci_observation_intent_digest: digest("final-ci-intent"),
      final_ci_observation_digest: sha256Digest(finalCiObservation),
      final_ci_observation_fencing_generation: 1,
      final_ci_checks_digest: sha256Digest(finalCiChecks),
      final_ci_checks: finalCiChecks,
      final_ci_observed_at: finalCiObservation.observed_at,
    }),
  ];
}

type ArtifactKind = AsfEvidencePredicate["artifacts"][number]["kind"];

function artifact(
  id: string,
  kind: ArtifactKind,
  body: string,
): AsfEvidencePredicate["artifacts"][number] {
  const artifactDigest = digest(body);
  return {
    artifact_id: id,
    kind,
    size_bytes: Buffer.byteLength(body),
    media_type: "application/json",
    digest: artifactDigest,
    retention_class: kind === "work-order-envelope" ? "protected" : "portable",
    location_ref: `cas://sha256/${artifactDigest.slice("sha256:".length)}`,
  };
}

interface Fixture {
  readonly envelope: WorkOrderEnvelope;
  readonly policy: EffectiveAsfPolicy;
  readonly snapshot: AsfDurableRunSnapshot;
  readonly events: readonly RunEvent[];
  readonly binding: AsfDeliveryBinding;
  readonly intent: AsfDeliveryStageIntent;
  readonly material: AsfEvidenceFinalizationMaterial;
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
}

function fixture(): Fixture {
  const envelope = envelopeFixture();
  const policy = policyFixture(envelope);
  const events = eventsFixture(envelope, policy);
  const identityAttributions = identityAttributionsFixture(policy);
  const envelopeBody = canonicalJson(envelope);
  const policyBody = canonicalJson(policy as any);
  const artifacts = [
    artifact("work-order", "work-order-envelope", envelopeBody),
    artifact("policy", "effective-policy", policyBody),
    artifact("diff", "normalized-diff", BODY.diff),
    artifact("runtime", "runtime-manifest", BODY.runtime),
    artifact("implementer", "agent-outcome", BODY.implementer),
    artifact("local-reviewer", "agent-outcome", BODY.localReviewer),
    artifact("pr-reviewer", "agent-outcome", BODY.prReviewer),
    artifact("unit", "verification", BODY.localCheck),
    artifact("ci", "ci-observation", BODY.ci),
    artifact("local-review", "review", BODY.localReview),
    artifact("pr-review", "review", BODY.prReview),
    artifact("push", "side-effect", BODY.push),
    artifact("pull-request", "side-effect", BODY.pullRequest),
  ];
  const statement: AsfEvidenceStatement = {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: "github:acme/payments", digest: { sha1: CANDIDATE_SHA } }],
    predicateType: ASF_EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: ASF_EVIDENCE_PREDICATE_SCHEMA,
      run: {
        run_id: "run_01",
        attempt_id: "attempt_01",
        work_order_id: "wo_01",
        completed_at: events.at(-1)?.occurred_at ?? "",
      },
      work_order: {
        envelope_digest: sha256Digest(envelope),
        payload_digest: sha256Digest(envelope.payload),
        envelope_artifact_digest: digest(envelopeBody),
        signature: { key_id: envelope.key_id, algorithm: "EdDSA", verified: true },
      },
      policy: {
        effective_policy_digest: policy.digest,
        effective_policy_artifact_digest: digest(policyBody),
        inputs: {
          operator_policy_digest: policy.inputs.operatorPolicy,
          work_order_policy_digest: policy.inputs.workOrderPolicy,
          repository_policy_digest: policy.inputs.repositoryPolicy,
          forge_policy_digest: policy.inputs.forgeProtection,
        },
        required_local_checks: ["unit"],
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
        normalized_diff_digest: DIGEST.normalizedDiff,
        normalized_diff_artifact_digest: DIGEST.diffArtifact,
        changed_paths: ["src/payment.ts", "test/payment.test.ts"],
      },
      runtime: {
        harness_digest: DIGEST.harness,
        tool_policy_digest: DIGEST.toolPolicy,
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
            lease_attribution_digest:
              identityAttributions[0]?.lease_attribution_digest ?? "",
          },
          {
            role: "local-reviewer",
            provider: "claude",
            model: "claude-sonnet",
            principal_id: "principal-local-reviewer",
            lease_attribution_digest:
              identityAttributions[1]?.lease_attribution_digest ?? "",
          },
          {
            role: "pull-request-reviewer",
            provider: "codex",
            model: "gpt-5.6-sol",
            principal_id: "principal-pr-reviewer",
            lease_attribution_digest:
              identityAttributions[2]?.lease_attribution_digest ?? "",
          },
        ],
      },
      role_outcomes: [
        { role: "implementer", outcome: "completed", candidate_sha: CANDIDATE_SHA, evidence_digest: DIGEST.implementer },
        { role: "local-reviewer", outcome: "passed", candidate_sha: CANDIDATE_SHA, evidence_digest: DIGEST.localReviewer },
        { role: "pull-request-reviewer", outcome: "passed", candidate_sha: CANDIDATE_SHA, evidence_digest: DIGEST.prReviewer },
      ],
      verification: {
        local_checks: [
          {
            check_id: "unit",
            candidate_sha: CANDIDATE_SHA,
            tree_digest: DIGEST.tree,
            command_digest: DIGEST.command,
            executor_id: "local-runner",
            toolchain_digest: DIGEST.toolchain,
            sandbox_profile_digest: DIGEST.sandbox,
            started_at: "2026-08-21T10:00:08.000Z",
            completed_at: "2026-08-21T10:00:09.000Z",
            conclusion: "success",
            coverage: "complete",
            evidence_digest: DIGEST.localCheck,
          },
        ],
        ci_contexts: [
          {
            context: "ci/test",
            candidate_sha: CANDIDATE_SHA,
            conclusion: "success",
            observed_at: "2026-08-21T10:00:16.000Z",
            evidence_digest: DIGEST.ci,
          },
        ],
      },
      reviews: [
        {
          review_id: "review-local",
          stage: "local",
          reviewer_principal: "principal-local-reviewer",
          reviewer_profile: "profile-local-reviewer",
          independent: true,
          candidate_sha: CANDIDATE_SHA,
          policy_digest: policy.digest,
          verdict: "pass",
          findings_digest: DIGEST.localReview,
          evidence_digest: DIGEST.localReview,
        },
        {
          review_id: "review-pr",
          stage: "pull-request",
          reviewer_principal: "principal-pr-reviewer",
          reviewer_profile: "profile-pr-reviewer",
          independent: true,
          candidate_sha: CANDIDATE_SHA,
          policy_digest: policy.digest,
          verdict: "pass",
          findings_digest: DIGEST.prReview,
          evidence_digest: DIGEST.prReview,
        },
      ],
      side_effects: [
        {
          effect_key: digest("push-effect"),
          kind: "branch.push",
          candidate_sha: CANDIDATE_SHA,
          intent_digest: digest("push-intent"),
          observation_digest: digest("push-observation-record"),
          reconciliation_digest: null,
          confirmation_digest: digest("push-confirmation"),
          status: "confirmed",
          evidence_digest: DIGEST.push,
        },
        {
          effect_key: digest("pr-effect"),
          kind: "pull-request.create",
          candidate_sha: CANDIDATE_SHA,
          intent_digest: digest("pr-intent"),
          observation_digest: digest("pr-observation-record"),
          reconciliation_digest: digest("pr-reconciliation"),
          confirmation_digest: digest("pr-confirmation"),
          status: "confirmed",
          evidence_digest: DIGEST.pullRequest,
        },
      ],
      approvals: [],
      cancellation: null,
      budget: {
        cost_usd: 1,
        agent_invocations: 3,
        fix_iterations: 0,
        elapsed_ms: 19_000,
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
          observed_at: "2026-08-21T10:00:19.000Z",
          evidence_digest: DIGEST.pullRequest,
        },
      },
      artifacts,
    },
  };
  const snapshot: AsfDurableRunSnapshot = {
    run: {
      runId: "run_01",
      issueId: "item_01",
      repo: "acme/payments",
      provider: "asf",
      state: "PR_DELIVERED",
      stateVersion: events.length,
      attempt: 1,
      baseCommit: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      branch: "refs/heads/runmill/run_01",
      mode: "asf-worker",
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      generation: 1,
      ownerId: "worker_01",
      heartbeatAt: "2026-08-21T10:00:19.000Z",
    },
    latestSequence: events.length,
    admission: {
      runId: "run_01",
      idempotencyKey: envelope.payload.idempotency_key,
      payloadDigest: sha256Digest(envelope.payload),
      envelopeDigest: sha256Digest(envelope),
      workOrderId: "wo_01",
      attemptId: "attempt_01",
      tenantId: "tenant_01",
      canonicalEnvelope: canonicalJson(envelope),
      effectivePolicy: canonicalJson(policy as any),
      effectivePolicyDigest: policy.digest,
      signatureKeyId: envelope.key_id,
      signatureAlgorithm: "EdDSA",
      acceptedAt: "2026-08-21T10:00:01.000Z",
    },
  };
  const binding: AsfDeliveryBinding = {
    runId: "run_01",
    workOrderId: "wo_01",
    attemptId: "attempt_01",
    policyDigest: policy.digest,
    fencingGeneration: 1,
    candidateSha: CANDIDATE_SHA,
  };
  const unsignedIntent = {
    schema: "asf.delivery-stage-intent/v1" as const,
    intent_id: "delivery_evidence_01",
    effect_key: "delivery_effect_evidence_01",
    stage: "evidence" as const,
    run_id: "run_01",
    work_order_id: "wo_01",
    attempt_id: "attempt_01",
    policy_digest: policy.digest,
    fencing_generation: 1,
    candidate_sha: CANDIDATE_SHA,
    event_seq: events.length,
    operation_digest: digest("evidence-operation"),
    created_at: events.at(-1)?.occurred_at ?? "",
  };
  const intent: AsfDeliveryStageIntent = {
    ...unsignedIntent,
    intent_digest: sha256Digest(unsignedIntent),
  };
  const material: AsfEvidenceFinalizationMaterial = {
    statement,
    expectations: {
      runId: "run_01",
      attemptId: "attempt_01",
      workOrderId: "wo_01",
      workOrderEnvelopeDigest: sha256Digest(envelope),
      workOrderPayloadDigest: sha256Digest(envelope.payload),
      effectivePolicyDigest: policy.digest,
      forge: "github",
      repository: "acme/payments",
      baseRef: "refs/heads/main",
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      treeDigest: DIGEST.tree,
      normalizedDiffDigest: DIGEST.normalizedDiff,
      changedPaths: ["src/payment.ts", "test/payment.test.ts"],
      requiredLocalCheckIds: ["unit"],
      requiredCiContexts: ["ci/test"],
      requireLocalReview: true,
      requirePullRequestReview: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/payments/pull/42",
        headRef: "refs/heads/runmill/run_01",
        baseRef: "refs/heads/main",
      },
    },
  };
  const artifactBodies = new Map<string, Uint8Array>();
  for (const [body, artifactDigest] of [
    [envelopeBody, digest(envelopeBody)],
    [policyBody, digest(policyBody)],
    ...Object.values(BODY).map((body) => [body, digest(body)] as const),
  ] as const) {
    artifactBodies.set(artifactDigest, Buffer.from(body, "utf8"));
  }
  return { envelope, policy, snapshot, events, binding, intent, material, artifacts: artifactBodies };
}

function signingKey(): AsfEvidenceSigningKey {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId: "worker-evidence-2026",
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
  };
}

function controller(
  base: Fixture,
  material: AsfEvidenceFinalizationMaterial = base.material,
  artifactBodies: ReadonlyMap<string, Uint8Array> = base.artifacts,
) {
  return new ProductionAsfEvidenceFinalizationController({
    materialSource: { assemble: async () => structuredClone(material) },
    artifactResolver: {
      async read(input) {
        const body = artifactBodies.get(input.expectedDigest);
        if (body === undefined) throw new Error("artifact is absent");
        expect(input.locationRef).toBe(
          `cas://sha256/${input.expectedDigest.slice("sha256:".length)}`,
        );
        expect(body.byteLength).toBeLessThanOrEqual(input.maxBytes);
        return body;
      },
    },
    signingKey: signingKey(),
    clock: new FakeClock(NOW),
    maxArtifactBytes: 64 * 1_024,
    maxTotalArtifactBytes: 1024 * 1024,
  });
}

function finalizationInput(base: Fixture) {
  return {
    binding: base.binding,
    intent: base.intent,
    intentMode: "observe-before-apply" as const,
    signal: new AbortController().signal,
    snapshot: base.snapshot,
    envelope: base.envelope,
    effectivePolicy: base.policy,
    events: base.events,
  };
}

describe("production ASF evidence finalization", () => {
  it("signs stable exact-bound evidence and re-hashes every CAS artifact", async () => {
    const base = fixture();
    const signer = signingKey();
    const seen = new Set<string>();
    const finalizer = new ProductionAsfEvidenceFinalizationController({
      materialSource: {
        async assemble(request) {
          expect(request.snapshot.run.state).toBe("PR_DELIVERED");
          expect(request.binding.candidateSha).toBe(CANDIDATE_SHA);
          return structuredClone(base.material);
        },
      },
      artifactResolver: {
        async read(input) {
          seen.add(input.expectedDigest);
          const body = base.artifacts.get(input.expectedDigest);
          if (body === undefined) throw new Error("missing artifact");
          return body;
        },
      },
      signingKey: signer,
      clock: new FakeClock(NOW),
      maxArtifactBytes: 64 * 1_024,
      maxTotalArtifactBytes: 1024 * 1024,
    });

    const first = await finalizer.finalize(finalizationInput(base));
    const second = await finalizer.finalize(finalizationInput(base));

    expect(first.bundle).toEqual(second.bundle);
    expect(first.signer).toEqual({
      keyId: signer.keyId,
      algorithm: "EdDSA",
      verified: true,
    });
    expect(first.candidateSha).toBe(CANDIDATE_SHA);
    expect(first.artifacts).toMatchObject({
      verified: true,
      count: base.material.statement &&
        (base.material.statement as AsfEvidenceStatement).predicate.artifacts.length,
    });
    expect(seen).toEqual(new Set(base.artifacts.keys()));
  });

  it("refuses independent expectations for another run, policy, candidate, or PR", async () => {
    const cases: Array<(material: AsfEvidenceFinalizationMaterial) => void> = [
      (material) => {
        (material.expectations as any).runId = "run_other";
      },
      (material) => {
        (material.expectations as any).effectivePolicyDigest = digest("other-policy");
      },
      (material) => {
        (material.expectations as any).candidateSha = STALE_SHA;
      },
      (material) => {
        (material.expectations.pullRequest as any).number = 99;
      },
    ];
    for (const mutate of cases) {
      const base = fixture();
      const material = structuredClone(base.material);
      mutate(material);
      await expect(
        controller(base, material).finalize(finalizationInput(base)),
      ).rejects.toMatchObject({ failure: "binding" });
    }
  });

  it("refuses final CI evidence that is stale or differs from the immediately preceding revalidation", async () => {
    const mutations: Array<(events: RunEvent[]) => void> = [
      (events) => {
        const delivered = events.find(
          (event) => event.type === "pull_request.delivered",
        );
        if (delivered === undefined) throw new Error("missing delivered fixture event");
        (delivered.payload as Record<string, unknown>)[
          "final_ci_observation_digest"
        ] = digest("different-final-ci-observation");
      },
      (events) => {
        const revalidated = events.find(
          (event) => event.type === "ci.revalidated",
        );
        if (revalidated === undefined) throw new Error("missing final CI fixture event");
        (revalidated as { occurred_at: string }).occurred_at =
          "2026-08-21T10:00:17.500Z";
      },
      (events) => {
        const delivered = events.find(
          (event) => event.type === "pull_request.delivered",
        );
        if (delivered === undefined) throw new Error("missing delivered fixture event");
        (delivered.payload as Record<string, unknown>)["final_ci_checks_digest"] =
          digest("different-final-ci-checks");
      },
    ];
    for (const mutate of mutations) {
      const base = fixture();
      const events = structuredClone(base.events) as RunEvent[];
      mutate(events);
      await expect(
        controller(base).finalize({ ...finalizationInput(base), events }),
      ).rejects.toMatchObject({ failure: "binding" });
    }
  });

  it("refuses statement policy and event evidence that contradict durable observations", async () => {
    const base = fixture();
    const material = structuredClone(base.material);
    (material.statement as AsfEvidenceStatement).predicate.policy.inputs.operator_policy_digest =
      digest("wrong-operator-policy");
    await expect(
      controller(base, material).finalize(finalizationInput(base)),
    ).rejects.toMatchObject({ failure: "binding" });

    const spoofedIdentity = structuredClone(base.material);
    const implementer = (spoofedIdentity.statement as AsfEvidenceStatement).predicate.runtime
      .providers[0];
    if (implementer === undefined) throw new Error("missing implementer attribution");
    implementer.principal_id = "substituted-principal";
    await expect(
      controller(base, spoofedIdentity).finalize(finalizationInput(base)),
    ).rejects.toMatchObject({ failure: "binding" });

    const staleEvents = structuredClone(base.events);
    const delivered = staleEvents.at(-1);
    if (delivered === undefined) throw new Error("missing delivered event");
    delivered.payload["observed_head_sha"] = STALE_SHA;
    await expect(
      controller(base).finalize({ ...finalizationInput(base), events: staleEvents }),
    ).rejects.toBeInstanceOf(AsfEvidenceValidationError);
  });

  it("refuses a missing or digest-mismatched artifact body", async () => {
    const base = fixture();
    const missing = new Map(base.artifacts);
    missing.delete(DIGEST.ci);
    await expect(
      controller(base, base.material, missing).finalize(finalizationInput(base)),
    ).rejects.toMatchObject({ failure: "missing-evidence" });

    const changed = new Map(base.artifacts);
    changed.set(DIGEST.ci, Buffer.from("tampered", "utf8"));
    await expect(
      controller(base, base.material, changed).finalize(finalizationInput(base)),
    ).rejects.toMatchObject({ failure: "digest" });
  });
});

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyEnvironment(keyFile: string): NodeJS.ProcessEnv {
  return {
    [ASF_EVIDENCE_SIGNING_ENV.keyId]: "worker-evidence-2026",
    [ASF_EVIDENCE_SIGNING_ENV.keyFile]: keyFile,
    [ASF_EVIDENCE_SIGNING_ENV.validFrom]: "2026-01-01T00:00:00Z",
    [ASF_EVIDENCE_SIGNING_ENV.validUntil]: "2027-01-01T00:00:00Z",
  };
}

describe("ASF evidence signing key loading", () => {
  it("loads only an explicitly configured private Ed25519 key", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-evidence-key-"));
    cleanup.push(directory);
    const keyFile = join(directory, "evidence.pem");
    const pem = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    writeFileSync(keyFile, pem, { mode: 0o600 });

    const loaded = loadAsfEvidenceSigningKey(keyEnvironment(keyFile));

    expect(loaded.keyId).toBe("worker-evidence-2026");
    expect(loaded.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(loaded.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("refuses symlinks, hard links, public modes, and writable key parents", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-evidence-key-"));
    cleanup.push(directory);
    const keyFile = join(directory, "evidence.pem");
    const linkFile = join(directory, "evidence-link.pem");
    const hardLinkFile = join(directory, "evidence-hard-link.pem");
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    writeFileSync(keyFile, pem, { mode: 0o600 });
    symlinkSync(keyFile, linkFile);
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(linkFile))).toThrow(/private regular/u);

    linkSync(keyFile, hardLinkFile);
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/private regular/u);
    rmSync(hardLinkFile);

    chmodSync(keyFile, 0o644);
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/private regular/u);
    chmodSync(keyFile, 0o600);
    chmodSync(directory, 0o777);
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/private regular/u);
  });

  it("refuses malformed, public-only, non-Ed25519, and incomplete configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-evidence-key-"));
    cleanup.push(directory);
    const keyFile = join(directory, "evidence.pem");
    writeFileSync(keyFile, "not-a-private-key-but-long-enough-to-pass-the-size-check", {
      mode: 0o600,
    });
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/malformed/u);

    const ed25519 = generateKeyPairSync("ed25519");
    writeFileSync(
      keyFile,
      ed25519.publicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o600 },
    );
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/private/u);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyFile, rsa.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    expect(() => loadAsfEvidenceSigningKey(keyEnvironment(keyFile))).toThrow(/Ed25519/u);
    expect(() => loadAsfEvidenceSigningKey({})).toThrow(
      ASF_EVIDENCE_SIGNING_ENV.keyId,
    );
  });
});

function signedWorkOrderFixture(base: Fixture): {
  readonly fixture: Fixture;
  readonly publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
} {
  const pair = generateKeyPairSync("ed25519");
  const envelope = structuredClone(base.envelope);
  envelope.signature = `base64url:${signBytes(
    null,
    Buffer.from(workOrderSigningPayload(envelope), "utf8"),
    pair.privateKey,
  ).toString("base64url")}`;
  const envelopeDigest = sha256Digest(envelope);
  const snapshot: AsfDurableRunSnapshot = {
    ...structuredClone(base.snapshot),
    admission: {
      ...structuredClone(base.snapshot.admission),
      canonicalEnvelope: canonicalJson(envelope),
      envelopeDigest,
    },
  };
  const events = structuredClone(base.events);
  const admitted = events[0];
  if (admitted === undefined) throw new Error("missing admission event");
  admitted.payload["envelope_digest"] = envelopeDigest;
  return {
    fixture: { ...base, envelope, snapshot, events },
    publicKey: pair.publicKey,
  };
}

function recordSetFixture(base: Fixture): AsfEvidenceFinalizationRecordSet {
  const statement = base.material.statement as AsfEvidenceStatement;
  const { predicate } = statement;
  const artifactByDigest = new Map(
    predicate.artifacts.map((artifact) => [artifact.digest, artifact]),
  );
  const artifactId = (artifactDigest: string): string => {
    const declaration = artifactByDigest.get(artifactDigest);
    if (declaration === undefined) throw new Error(`missing ${artifactDigest}`);
    return declaration.artifact_id;
  };
  const artifacts: AsfEvidenceFinalizationRecordSet["artifacts"] = predicate.artifacts
    .filter(
      (artifact) =>
        artifact.kind !== "work-order-envelope" && artifact.kind !== "effective-policy",
    )
    .map((artifact) => {
      const bytes = base.artifacts.get(artifact.digest);
      if (bytes === undefined) throw new Error(`missing artifact body ${artifact.digest}`);
      if (artifact.kind === "work-order-envelope" || artifact.kind === "effective-policy") {
        throw new Error("generated artifact escaped filter");
      }
      return {
        artifact_id: artifact.artifact_id,
        kind: artifact.kind,
        media_type: "text/plain",
        retention_class: "protected",
        privacy_class: "structured-evidence",
        bytes,
        expected_digest: artifact.digest,
      };
    });
  return {
    schema: "asf.evidence-finalization-records/v1",
    source: {
      normalized_diff_digest: predicate.source.normalized_diff_digest,
      normalized_diff_artifact_id: artifactId(
        predicate.source.normalized_diff_artifact_digest,
      ),
      changed_paths: [...predicate.source.changed_paths],
    },
    runtime: {
      tool_policy_digest: predicate.runtime.tool_policy_digest,
      sandbox_profile_digest: predicate.runtime.sandbox_profile_digest,
      dependency_digest: predicate.runtime.dependency_digest,
      runtime_digest: predicate.runtime.runtime_digest,
      runtime_manifest_artifact_id: artifactId(predicate.runtime.runtime_manifest_digest),
      provider_models: predicate.runtime.providers.map((provider) => ({
        role: provider.role,
        model: provider.model,
      })),
    },
    role_outcomes: predicate.role_outcomes.map((outcome) => ({
      role: outcome.role,
      outcome: outcome.outcome,
      artifact_id: artifactId(outcome.evidence_digest),
    })),
    local_checks: predicate.verification.local_checks.map((check) => ({
      check_id: check.check_id,
      command_digest: check.command_digest,
      executor_id: check.executor_id,
      toolchain_digest: check.toolchain_digest,
      sandbox_profile_digest: check.sandbox_profile_digest,
      started_at: check.started_at,
      completed_at: check.completed_at,
      conclusion: check.conclusion,
      coverage: check.coverage,
      artifact_id: artifactId(check.evidence_digest),
    })),
    ci_contexts: predicate.verification.ci_contexts.map((check) => ({
      context: check.context,
      conclusion: check.conclusion,
      observed_at: check.observed_at,
      artifact_id: artifactId(check.evidence_digest),
    })),
    reviews: predicate.reviews.map((review) => ({
      review_id: review.review_id,
      stage: review.stage,
      verdict: review.verdict,
      findings_artifact_id: artifactId(review.findings_digest),
      evidence_artifact_id: artifactId(review.evidence_digest),
    })),
    side_effects: predicate.side_effects.map((effect) => ({
      effect_key: effect.effect_key,
      kind: effect.kind,
      intent_digest: effect.intent_digest,
      observation_digest: effect.observation_digest,
      reconciliation_digest: effect.reconciliation_digest,
      confirmation_digest: effect.confirmation_digest,
      status: effect.status,
      artifact_id: artifactId(effect.evidence_digest),
    })),
    approvals: predicate.approvals.map((approval) => ({
      approval_id: approval.approval_id,
      decision_type: approval.decision_type,
      requested_effect: approval.requested_effect,
      approver_subject: approval.approver_subject,
      authority_digest: approval.authority_digest,
      issued_at: approval.issued_at,
      expires_at: approval.expires_at,
      applied_at: approval.applied_at,
      signature_digest: approval.signature_digest,
      artifact_id: artifactId(approval.evidence_digest),
    })),
    budget: {
      cost_usd: predicate.budget.cost_usd,
      agent_invocations: predicate.budget.agent_invocations,
      fix_iterations: predicate.budget.fix_iterations,
      elapsed_ms: predicate.budget.elapsed_ms,
    },
    delivery_evidence_artifact_id: artifactId(
      predicate.delivery.pull_request.evidence_digest,
    ),
    artifacts,
  };
}

function artifactStoreFixture(clock: FakeClock): FilesystemAsfArtifactStore {
  const rootDirectory = mkdtempSync(join(tmpdir(), "runmill-evidence-cas-"));
  cleanup.push(rootDirectory);
  return new FilesystemAsfArtifactStore({
    rootDirectory,
    clock,
    maxArtifactBytes: 64 * 1_024,
    retentionMs: {
      portable: 365 * 24 * 60 * 60 * 1_000,
      protected: 30 * 24 * 60 * 60 * 1_000,
      restricted: 7 * 24 * 60 * 60 * 1_000,
    },
  });
}

describe("deterministic ASF evidence material source", () => {
  it("assembles and finalizes exact records without a handcrafted statement", async () => {
    const signed = signedWorkOrderFixture(fixture());
    const records = recordSetFixture(signed.fixture);
    const clock = new FakeClock(NOW);
    const artifacts = artifactStoreFixture(clock);
    const materialSource = new DeterministicAsfEvidenceMaterialSource({
      records: { load: async () => structuredClone(records) },
      artifacts,
      trustedWorkOrderSigners: [
        { keyId: signed.fixture.envelope.key_id, publicKey: signed.publicKey },
      ],
    });
    const finalizer = new ProductionAsfEvidenceFinalizationController({
      materialSource,
      artifactResolver: artifacts,
      signingKey: signingKey(),
      clock,
      maxArtifactBytes: 64 * 1_024,
      maxTotalArtifactBytes: 1024 * 1024,
    });

    const finalized = await finalizer.finalize(finalizationInput(signed.fixture));

    expect(finalized.artifacts.verified).toBe(true);
    expect(finalized.bundle.statement.predicate.source.candidate_sha).toBe(CANDIDATE_SHA);
    expect(finalized.bundle.statement.predicate.work_order.signature.verified).toBe(true);
    expect(finalized.bundle.statement.predicate.artifacts).toHaveLength(
      records.artifacts.length + 2,
    );
  });

  it("re-verifies the Work Order signature before reading records or writing artifacts", async () => {
    const signed = signedWorkOrderFixture(fixture());
    const records = recordSetFixture(signed.fixture);
    const clock = new FakeClock(NOW);
    const artifacts = artifactStoreFixture(clock);
    let loads = 0;
    const source = new DeterministicAsfEvidenceMaterialSource({
      records: {
        async load() {
          loads += 1;
          return records;
        },
      },
      artifacts,
      trustedWorkOrderSigners: [
        { keyId: signed.fixture.envelope.key_id, publicKey: generateKeyPairSync("ed25519").publicKey },
      ],
    });

    await expect(source.assemble(finalizationInput(signed.fixture))).rejects.toMatchObject({
      failure: "signature",
    });
    expect(loads).toBe(0);
  });

  it("refuses missing record artifacts and canonicalizes unordered exact records", async () => {
    const signed = signedWorkOrderFixture(fixture());
    const records = recordSetFixture(signed.fixture);
    const clock = new FakeClock(NOW);
    const artifacts = artifactStoreFixture(clock);
    const missing = structuredClone(records);
    missing.artifacts = missing.artifacts.filter(
      (artifact) => artifact.artifact_id !== missing.delivery_evidence_artifact_id,
    );
    const missingSource = new DeterministicAsfEvidenceMaterialSource({
      records: { load: async () => missing },
      artifacts,
      trustedWorkOrderSigners: [
        { keyId: signed.fixture.envelope.key_id, publicKey: signed.publicKey },
      ],
    });
    await expect(
      missingSource.assemble(finalizationInput(signed.fixture)),
    ).rejects.toMatchObject({ failure: "missing-evidence" });

    let reversed = false;
    const deterministicSource = new DeterministicAsfEvidenceMaterialSource({
      records: {
        async load() {
          reversed = !reversed;
          const value = structuredClone(records);
          if (reversed) {
            value.artifacts.reverse();
            value.role_outcomes.reverse();
            value.reviews.reverse();
            value.side_effects.reverse();
          }
          return value;
        },
      },
      artifacts,
      trustedWorkOrderSigners: [
        { keyId: signed.fixture.envelope.key_id, publicKey: signed.publicKey },
      ],
    });
    const first = await deterministicSource.assemble(finalizationInput(signed.fixture));
    const second = await deterministicSource.assemble(finalizationInput(signed.fixture));
    expect(second).toEqual(first);
  });
});
