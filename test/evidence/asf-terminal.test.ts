import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/testing/fake-clock.js";
import {
  ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
  ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
  signAsfTerminalEvidenceBundle,
  validateSignedAsfTerminalEvidenceBundle,
  type AsfTerminalEvidenceStatement,
  type AsfTerminalProviderBudgetEvidence,
  type AsfTerminalPhase,
} from "../../src/evidence/asf-terminal.js";
import { IN_TOTO_STATEMENT_V1 } from "../../src/evidence/asf-bundle.js";
import { AsfEvidenceValidationError } from "../../src/evidence/asf-validator.js";
import { canonicalJson, sha256Digest } from "../../src/asf/canonical-json.js";
import { parseRunEvent } from "../../src/asf/run-event.js";
import {
  EFFECTIVE_POLICY_SCHEMA,
  WORK_ORDER_ENVELOPE_SCHEMA,
  WORK_ORDER_SCHEMA,
} from "../../src/asf/work-order.js";
import { buildAsfTerminalEffectLedger } from "../../src/evidence/asf-terminal-effects.js";

const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const CLEANUP_DIGEST = sha256Digest("cleanup");
const DELIVERY_DIGEST = sha256Digest("delivery");
const ADMITTED_AT = "2026-08-21T09:30:00.000Z";
const TERMINAL_AT = "2026-08-21T10:00:00.000Z";
const WORK_ORDER = {
  schema: WORK_ORDER_SCHEMA,
  work_order_id: "wo-01",
  tenant_id: "tenant-01",
  work_item_id: "item-01",
  attempt_id: "attempt-01",
  idempotency_key: "tenant-01/item-01/attempt-01",
  source: {
    system: "asf",
    external_id: "item-01",
    snapshot_digest: sha256Digest("source"),
  },
  repository: {
    forge: "github",
    repository: "acme/widgets",
    base_ref: "refs/heads/main",
    base_sha: BASE_SHA,
  },
  objective: {
    title: "Fix widgets",
    description: "Apply the bounded widget fix.",
    acceptance_criteria: ["checks pass"],
    non_goals: [],
  },
  scope: {
    allowed_paths: ["src/**"],
    forbidden_paths: [".runmill/**"],
    risk_class: "low" as const,
  },
  verification: {
    required_local_check_ids: ["unit"],
    required_remote_checks: ["ci/unit"],
    policy_snapshot_digest: sha256Digest("policy-snapshot"),
  },
  identities: {
    implementer: "implementer-profile",
    local_reviewer: "reviewer-profile",
    pr_reviewer: "reviewer-profile",
  },
  runtime: {
    sandbox_profile: "linux-production-v1",
    tool_policy: "repo-change-v1",
    network_policy: "provider-only-v1",
  },
  budgets: {
    wall_seconds: 3_600,
    max_cost_usd: 10,
    max_agent_invocations: 8,
    max_fix_iterations: 2,
  },
  delivery: { closure_target: "pr" as const, draft_pr: false, merge_policy_ref: null },
  policy_digest: sha256Digest("work-order-policy"),
  harness_digest: sha256Digest("harness"),
};
const ENVELOPE = {
  schema: WORK_ORDER_ENVELOPE_SCHEMA,
  key_id: "work-order-key",
  algorithm: "EdDSA" as const,
  issued_at: ADMITTED_AT,
  not_before: ADMITTED_AT,
  expires_at: "2026-08-22T09:30:00.000Z",
  payload: WORK_ORDER,
  signature: "base64url:AQ",
};
const UNSIGNED_POLICY = {
  schema: EFFECTIVE_POLICY_SCHEMA,
  inputs: {
    operatorPolicy: sha256Digest("operator"),
    workOrderPolicy: WORK_ORDER.policy_digest,
    workOrderPayload: sha256Digest(WORK_ORDER),
    harness: WORK_ORDER.harness_digest,
    repositoryPolicy: sha256Digest("repo-policy"),
    repositoryPolicyBaseSha: BASE_SHA,
    repositoryPolicyPath: ".runmill/checks.yaml",
    repositoryPolicyBytesBase64: "e30=",
    observedBaseSha: BASE_SHA,
    forgeProtection: sha256Digest("protection"),
    forgeProtectionBaseRef: "refs/heads/main",
    forgeProtectionBytesBase64: "e30=",
  },
  pathScopes: [],
  criticalPaths: { workClass: null, approvedPaths: [] },
  requiredLocalCheckIds: ["unit"],
  requiredRemoteChecks: ["ci/unit"],
  riskClass: "low",
  identities: {
    implementer: "implementer-profile",
    localReviewer: "reviewer-profile",
    prReviewer: "reviewer-profile",
  },
  runtime: {
    sandboxProfile: "linux-production-v1",
    toolPolicy: "repo-change-v1",
    networkPolicy: "provider-only-v1",
  },
  budgets: {
    wallSeconds: 3_600,
    maxCostUsd: 10,
    maxAgentInvocations: 8,
    maxFixIterations: 2,
  },
  delivery: { closureTarget: "pr", draftPr: false },
} as const;
const POLICY = { ...UNSIGNED_POLICY, digest: sha256Digest(UNSIGNED_POLICY) };
const POLICY_DIGEST = POLICY.digest;
const ENVELOPE_DIGEST = sha256Digest(ENVELOPE);
const PAYLOAD_DIGEST = sha256Digest(WORK_ORDER);
const ADMISSION_EVENT = parseRunEvent({
  schema: "asf.run-event/v1",
  event_id: "evt-admitted",
  run_id: "run-01",
  work_order_id: "wo-01",
  attempt_id: "attempt-01",
  seq: 1,
  occurred_at: ADMITTED_AT,
  type: "work_order.admitted",
  phase: "ADMITTED",
  payload: {
    work_order_id: "wo-01",
    attempt_id: "attempt-01",
    tenant_id: "tenant-01",
    payload_digest: PAYLOAD_DIGEST,
    envelope_digest: ENVELOPE_DIGEST,
    signature: { verified: true, key_id: ENVELOPE.key_id, algorithm: "EdDSA" },
  },
  policy_digest: POLICY_DIGEST,
});
const EVENT_CHAIN_DIGEST = sha256Digest([ADMISSION_EVENT]);
const PROVIDER_BUDGET: AsfTerminalProviderBudgetEvidence = {
  schema: "asf.provider-budget-evidence-summary/v1",
  run_id: "run-01",
  work_order_id: "wo-01",
  attempt_id: "attempt-01",
  policy_digest: POLICY_DIGEST,
  candidate_sha: null,
  usage: {
    max_cost_micros: 10_000_000,
    reported_actual_cost_micros: 0,
    settled_unknown_cost_micros: 0,
    outstanding_reserved_cost_micros: 0,
    conservative_cost_micros: 0,
    invocation_count: 0,
    completed_invocation_count: 0,
    settled_unknown_invocation_count: 0,
    outstanding_invocation_count: 0,
    denied_count: 0,
  },
  invocations: [],
  settlement_digests: [],
  ledger_digest: sha256Digest({ schema: "test-provider-ledger/v1", entries: [] }),
};
const SIDE_EFFECTS = buildAsfTerminalEffectLedger({
  run_id: "run-01",
  work_order_id: "wo-01",
  attempt_id: "attempt-01",
  policy_digest: POLICY_DIGEST,
  effects: [],
  reconciliations: [],
});
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const clock = new FakeClock("2026-08-21T11:00:00.000Z");

function statement(input: {
  phase: AsfTerminalPhase;
  candidateSha?: string | null;
  deliveryDigest?: string | null;
  cancellation?: boolean;
}): AsfTerminalEvidenceStatement {
  const candidateSha = input.candidateSha ?? null;
  const subjectSha = candidateSha ?? BASE_SHA;
  const deliveryDigest =
    input.deliveryDigest === undefined
      ? input.phase === "COMPLETED"
        ? DELIVERY_DIGEST
        : null
      : input.deliveryDigest;
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: "asf-run:run-01", digest: { sha1: subjectSha } }],
    predicateType: ASF_TERMINAL_EVIDENCE_PREDICATE_TYPE,
    predicate: {
      schema: ASF_TERMINAL_EVIDENCE_PREDICATE_SCHEMA,
      run: {
        run_id: "run-01",
        work_order_id: "wo-01",
        attempt_id: "attempt-01",
        terminal_phase: input.phase,
        terminal_event_seq: 2,
      },
      admission: {
        work_order_envelope_digest: ENVELOPE_DIGEST,
        work_order_payload_digest: PAYLOAD_DIGEST,
        effective_policy_digest: POLICY_DIGEST,
        work_order_envelope: ENVELOPE,
        signature_verification: {
          verified: true,
          key_id: ENVELOPE.key_id,
          algorithm: "EdDSA",
        },
        effective_policy: JSON.parse(canonicalJson(POLICY)),
      },
      source: {
        repository: "acme/widgets",
        base_sha: BASE_SHA,
        candidate_sha: candidateSha,
        subject_kind: candidateSha === null ? "base" : "candidate",
        subject_sha: subjectSha,
      },
      stop: {
        code: input.phase === "COMPLETED" ? "PR_DELIVERED" : `${input.phase}_STOP`,
        summary: "stable public terminal summary",
        interrupted_phase: candidateSha === null ? "ADMITTED" : "EVIDENCE_FINALIZED",
        retry_disposition: input.phase === "COMPLETED" ? "safe" : "new-attempt-required",
        required_actor: "asf",
        required_action: "acknowledge the exact signed terminal statement",
        evidence_refs: deliveryDigest === null ? [] : [deliveryDigest],
      },
      cancellation:
        input.cancellation === true
          ? {
              request_id: "cancel-01",
              event_type: "cancellation.requested",
              requester_subject: "operator-01",
              reason_digest: sha256Digest("cancel reason"),
              mode: "graceful",
              grace_seconds: 30,
              requested_at: "2026-08-21T10:00:00.000Z",
              event_digest: sha256Digest("cancellation event"),
            }
          : null,
      budget: {
        wall_seconds_limit: 3600,
        max_cost_usd: 10,
        max_agent_invocations: 8,
        max_fix_iterations: 2,
        observed_fix_iterations: 0,
        evidence_refs: [],
        provider_usage: {
          ...PROVIDER_BUDGET,
          candidate_sha: candidateSha,
        },
      },
      side_effects: SIDE_EFFECTS,
      timing: {
        admitted_at: ADMITTED_AT,
        terminal_evidence_at: TERMINAL_AT,
        elapsed_ms: Date.parse(TERMINAL_AT) - Date.parse(ADMITTED_AT),
      },
      cleanup: {
        intent_id: "cleanup-01",
        intent_digest: sha256Digest("cleanup intent"),
        observation_digest: CLEANUP_DIGEST,
        identity_leases: "released",
        repository_lease: "released",
        workspace: "removed",
        unresolved_effects: 0,
      },
      evidence: {
        preceding_event_count: 1,
        preceding_event_chain_digest: EVENT_CHAIN_DIGEST,
        observations: [
          {
            event_seq: 1,
            event_type: "work_order.admitted",
            phase: "ADMITTED",
            candidate_sha: null,
            event_digest: sha256Digest(ADMISSION_EVENT),
            evidence_refs: [ENVELOPE_DIGEST, PAYLOAD_DIGEST],
          },
        ],
        events: [ADMISSION_EVENT],
        delivery_bundle_digest: deliveryDigest,
      },
    },
  };
}

function sign(value: AsfTerminalEvidenceStatement) {
  return signAsfTerminalEvidenceBundle({
    statement: value,
    keyId: "terminal-evidence-2026",
    privateKey,
    issuedAt: TERMINAL_AT,
  });
}

function validate(
  bundle: ReturnType<typeof sign>,
  input: {
    phase: AsfTerminalPhase;
    candidateSha: string | null;
    deliveryDigest: string | null;
  },
) {
  return validateSignedAsfTerminalEvidenceBundle(bundle, {
    clock,
    trustedSigners: [
      {
        keyId: "terminal-evidence-2026",
        publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
      },
    ],
    expected: {
      runId: "run-01",
      workOrderId: "wo-01",
      attemptId: "attempt-01",
      workOrderEnvelopeDigest: ENVELOPE_DIGEST,
      workOrderPayloadDigest: PAYLOAD_DIGEST,
      effectivePolicyDigest: POLICY_DIGEST,
      repository: "acme/widgets",
      baseSha: BASE_SHA,
      candidateSha: input.candidateSha,
      terminalPhase: input.phase,
      terminalEventSeq: 2,
      cleanupObservationDigest: CLEANUP_DIGEST,
      deliveryBundleDigest: input.deliveryDigest,
      precedingEventChainDigest: EVENT_CHAIN_DIGEST,
      providerBudget: {
        ...PROVIDER_BUDGET,
        candidate_sha: input.candidateSha,
      },
      sideEffects: SIDE_EFFECTS,
      admittedAt: ADMITTED_AT,
      terminalEvidenceAt: TERMINAL_AT,
      elapsedMs: Date.parse(TERMINAL_AT) - Date.parse(ADMITTED_AT),
    },
  });
}

describe("signed portable ASF terminal evidence", () => {
  it("chains successful delivery to exact post-cleanup terminal evidence", () => {
    const bundle = sign(
      statement({ phase: "COMPLETED", candidateSha: CANDIDATE_SHA }),
    );
    expect(
      validate(bundle, {
        phase: "COMPLETED",
        candidateSha: CANDIDATE_SHA,
        deliveryDigest: DELIVERY_DIGEST,
      }),
    ).toMatchObject({ terminalPhase: "COMPLETED", candidateSha: CANDIDATE_SHA });
  });

  it.each(["FAILED", "REFUSED", "QUARANTINED", "BUDGET_EXHAUSTED"] as const)(
    "uses the admitted base as the truthful subject for a pre-candidate %s stop",
    (phase) => {
      const bundle = sign(statement({ phase, candidateSha: null }));
      expect(
        validate(bundle, { phase, candidateSha: null, deliveryDigest: null }),
      ).toMatchObject({ terminalPhase: phase, candidateSha: null });
      expect(bundle.statement.predicate.source).toMatchObject({
        subject_kind: "base",
        subject_sha: BASE_SHA,
      });
    },
  );

  it("requires cancellation evidence for CANCELLED", () => {
    expect(() => sign(statement({ phase: "CANCELLED" }))).toThrow();
    const bundle = sign(statement({ phase: "CANCELLED", cancellation: true }));
    expect(
      validate(bundle, {
        phase: "CANCELLED",
        candidateSha: null,
        deliveryDigest: null,
      }).bundle.statement.predicate.cancellation,
    ).toMatchObject({ request_id: "cancel-01", requester_subject: "operator-01" });
  });

  it("truthfully preserves cancellation and delivery context on a later FAILED stop", () => {
    const bundle = sign(
      statement({
        phase: "FAILED",
        candidateSha: CANDIDATE_SHA,
        deliveryDigest: DELIVERY_DIGEST,
        cancellation: true,
      }),
    );
    const validated = validate(bundle, {
      phase: "FAILED",
      candidateSha: CANDIDATE_SHA,
      deliveryDigest: DELIVERY_DIGEST,
    });
    expect(validated.bundle.statement.predicate).toMatchObject({
      cancellation: { request_id: "cancel-01" },
      evidence: { delivery_bundle_digest: DELIVERY_DIGEST },
    });
  });

  it("rejects tampering, missing cleanup proof, and incomplete event coverage", () => {
    const valid = sign(statement({ phase: "REFUSED" }));
    const tampered = structuredClone(valid);
    tampered.statement.predicate.cleanup.observation_digest = sha256Digest("other");
    expect(() =>
      validate(tampered, {
        phase: "REFUSED",
        candidateSha: null,
        deliveryDigest: null,
      }),
    ).toThrow(AsfEvidenceValidationError);

    const missingCleanup = structuredClone(statement({ phase: "REFUSED" })) as unknown as {
      predicate: Record<string, unknown>;
    };
    delete missingCleanup.predicate["cleanup"];
    expect(() => sign(missingCleanup as unknown as AsfTerminalEvidenceStatement)).toThrow();

    const incomplete = structuredClone(statement({ phase: "REFUSED" }));
    incomplete.predicate.evidence.observations = [];
    expect(() =>
      validate(sign(incomplete), {
        phase: "REFUSED",
        candidateSha: null,
        deliveryDigest: null,
      }),
    ).toThrow(AsfEvidenceValidationError);

    const budgetTamper = structuredClone(valid);
    budgetTamper.statement.predicate.budget.provider_usage.ledger_digest =
      sha256Digest("other ledger");
    expect(() =>
      validate(budgetTamper, {
        phase: "REFUSED",
        candidateSha: null,
        deliveryDigest: null,
      }),
    ).toThrow(AsfEvidenceValidationError);

    const outstanding = structuredClone(statement({ phase: "REFUSED" }));
    outstanding.predicate.budget.provider_usage.usage.outstanding_reserved_cost_micros =
      1;
    outstanding.predicate.budget.provider_usage.usage.conservative_cost_micros =
      1;
    expect(() => sign(outstanding)).toThrow();

    const wrongElapsed = structuredClone(statement({ phase: "REFUSED" }));
    wrongElapsed.predicate.timing.elapsed_ms += 1;
    expect(() => sign(wrongElapsed)).toThrow();
  });
});
