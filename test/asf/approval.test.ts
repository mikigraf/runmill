import {
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  approvalSigningPayload,
  parseApprovalEnvelope,
  validateApproval,
  type ApprovalBinding,
  type ApprovalEnvelope,
  type TrustedApprovalSigner,
} from "../../src/asf/approval.js";
import { RunmillError } from "../../src/errors/runmill-error.js";
import { FakeClock } from "../../src/testing/fake-clock.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const CANDIDATE = "a".repeat(40);
const WORK_ORDER_DIGEST = `sha256:${"b".repeat(64)}`;
const POLICY_DIGEST = `sha256:${"c".repeat(64)}`;

const binding: ApprovalBinding = {
  workOrderId: "wo_01",
  workOrderDigest: WORK_ORDER_DIGEST,
  runId: "run_01",
  attemptId: "attempt_01",
  candidateSha: CANDIDATE,
  policyDigest: POLICY_DIGEST,
  decisionType: "delivery",
  requestedEffect: "pull-request-delivery",
};

function signer(key: KeyObject = publicKey): TrustedApprovalSigner {
  return {
    keyId: "approval-key-01",
    publicKey: key,
    subjects: ["user:release-owner"],
    authorities: ["asf:delivery-approver"],
    decisionTypes: ["delivery"],
    requestedEffects: ["pull-request-delivery"],
  };
}

function envelope(
  mutate?: (draft: ApprovalEnvelope) => void,
  key: KeyObject = privateKey,
): ApprovalEnvelope {
  const draft: ApprovalEnvelope = {
    schema: "asf.approval-envelope/v1",
    key_id: "approval-key-01",
    algorithm: "EdDSA",
    payload: {
      schema: "asf.approval/v1",
      approval_id: "approval_01",
      work_order_id: binding.workOrderId,
      work_order_digest: binding.workOrderDigest,
      run_id: binding.runId,
      attempt_id: binding.attemptId,
      candidate_sha: binding.candidateSha,
      decision: "approved",
      decision_type: binding.decisionType,
      requested_effect: binding.requestedEffect,
      policy_digest: binding.policyDigest,
      approver: {
        subject: "user:release-owner",
        authority: "asf:delivery-approver",
      },
      issued_at: "2026-08-21T10:00:00Z",
      expires_at: "2026-08-21T10:15:00Z",
    },
    signature: "base64url:AA",
  };
  mutate?.(draft);
  draft.signature = `base64url:${signBytes(
    null,
    Buffer.from(approvalSigningPayload(draft), "utf8"),
    key,
  ).toString("base64url")}`;
  return draft;
}

function validate(
  raw: unknown,
  trustedSigners: readonly TrustedApprovalSigner[] = [signer()],
): ReturnType<typeof validateApproval> {
  return validateApproval(raw, {
    clock: new FakeClock("2026-08-21T10:05:00Z"),
    trustedSigners,
    expected: binding,
  });
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

describe("ASF approval contract", () => {
  it("strictly parses and independently validates a candidate-bound signature", () => {
    const approved = validate(envelope());
    expect(approved.signature).toEqual({
      verified: true,
      keyId: "approval-key-01",
      algorithm: "EdDSA",
    });
    expect(approved.envelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(approved.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(parseApprovalEnvelope(approved.envelope)).toEqual(approved.envelope);
  });

  it("refuses unknown schemas and extra authority fields", () => {
    expectCode(
      () => parseApprovalEnvelope({ ...envelope(), schema: "asf.approval-envelope/v2" }),
      "RM-APPROVAL-001",
    );
    expectCode(
      () => parseApprovalEnvelope({ ...envelope(), merge_now: true }),
      "RM-APPROVAL-002",
    );
  });

  it("refuses tampering and an unknown signer", () => {
    const tampered = envelope();
    tampered.payload.candidate_sha = "d".repeat(40);
    expectCode(() => validate(tampered), "RM-APPROVAL-002");
    expectCode(() => validate(envelope(), []), "RM-APPROVAL-004");
  });

  it.each([
    ["workOrderId", { work_order_id: "wo_other" }],
    ["workOrderDigest", { work_order_digest: `sha256:${"d".repeat(64)}` }],
    ["runId", { run_id: "run_other" }],
    ["attemptId", { attempt_id: "attempt_02" }],
    ["candidateSha", { candidate_sha: "d".repeat(40) }],
    ["policyDigest", { policy_digest: `sha256:${"d".repeat(64)}` }],
    ["decisionType", { decision_type: "merge" }],
    ["requestedEffect", { requested_effect: "merge" }],
  ])("refuses stale %s binding even under a valid signature", (_label, patch) => {
    expectCode(
      () => validate(envelope((draft) => Object.assign(draft.payload, patch))),
      "RM-APPROVAL-003",
    );
  });

  it("refuses future, expired, and contradictory approval windows", () => {
    expectCode(
      () => validate(envelope((draft) => { draft.payload.issued_at = "2026-08-21T10:06:00Z"; })),
      "RM-APPROVAL-002",
    );
    expectCode(
      () => validate(envelope((draft) => { draft.payload.expires_at = "2026-08-21T10:05:00Z"; })),
      "RM-APPROVAL-002",
    );
    expectCode(
      () => validate(envelope((draft) => { draft.payload.expires_at = draft.payload.issued_at; })),
      "RM-APPROVAL-002",
    );
  });

  it("refuses revoked, expired, or not-yet-valid signer registrations", () => {
    expectCode(
      () => validate(envelope(), [{ ...signer(), revokedAt: "2026-08-21T10:04:00Z" }]),
      "RM-APPROVAL-004",
    );
    expectCode(
      () => validate(envelope(), [{ ...signer(), validUntil: "2026-08-21T10:05:00Z" }]),
      "RM-APPROVAL-004",
    );
    expectCode(
      () => validate(envelope(), [{ ...signer(), validFrom: "2026-08-21T10:01:00Z" }]),
      "RM-APPROVAL-004",
    );
  });

  it("intersects the signed assertion with signer subjects, authority, and effects", () => {
    expectCode(
      () => validate(envelope(), [{ ...signer(), subjects: [] }]),
      "RM-APPROVAL-004",
    );
    expectCode(
      () => validate(envelope(), [{ ...signer(), authorities: [] }]),
      "RM-APPROVAL-004",
    );
    expectCode(
      () => validate(envelope(), [{ ...signer(), decisionTypes: [] }]),
      "RM-APPROVAL-004",
    );
    expectCode(
      () => validate(envelope(), [{ ...signer(), requestedEffects: [] }]),
      "RM-APPROVAL-004",
    );
  });
});
