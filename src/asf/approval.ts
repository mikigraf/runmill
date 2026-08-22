import {
  createPublicKey,
  KeyObject,
  verify as verifySignature,
  type KeyLike,
} from "node:crypto";
import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import type { Clock } from "../platform/clock.js";
import { canonicalJson, sha256Digest } from "./canonical-json.js";

export const APPROVAL_ENVELOPE_SCHEMA = "asf.approval-envelope/v1" as const;
export const APPROVAL_SCHEMA = "asf.approval/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);

export const approvalPayloadSchema = z
  .object({
    schema: z.literal(APPROVAL_SCHEMA),
    approval_id: identifierSchema,
    work_order_id: identifierSchema,
    work_order_digest: digestSchema,
    run_id: identifierSchema,
    attempt_id: identifierSchema,
    candidate_sha: gitShaSchema,
    decision: z.enum(["approved", "denied"]),
    decision_type: identifierSchema,
    requested_effect: identifierSchema,
    policy_digest: digestSchema,
    approver: z
      .object({
        subject: identifierSchema,
        authority: identifierSchema,
      })
      .strict(),
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const approvalEnvelopeSchema = z
  .object({
    schema: z.literal(APPROVAL_ENVELOPE_SCHEMA),
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
    payload: approvalPayloadSchema,
    signature: z.string().regex(/^base64url:[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;
export type ApprovalEnvelope = z.infer<typeof approvalEnvelopeSchema>;

export interface TrustedApprovalSigner {
  readonly keyId: string;
  readonly publicKey: KeyLike;
  readonly subjects: readonly string[];
  readonly authorities: readonly string[];
  readonly decisionTypes: readonly string[];
  readonly requestedEffects: readonly string[];
  /** Optional operator-owned key lifecycle bounds, independent of the assertion. */
  readonly validFrom?: string | undefined;
  readonly validUntil?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export interface ApprovalBinding {
  readonly workOrderId: string;
  readonly workOrderDigest: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly candidateSha: string;
  readonly policyDigest: string;
  readonly decisionType: string;
  readonly requestedEffect: string;
}

export interface ValidatedApproval {
  readonly envelope: ApprovalEnvelope;
  readonly canonicalEnvelope: string;
  readonly envelopeDigest: `sha256:${string}`;
  readonly bindingDigest: `sha256:${string}`;
  readonly signature: {
    readonly verified: true;
    readonly keyId: string;
    readonly algorithm: "EdDSA";
  };
}

export interface PersistedApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly decision: "approved" | "denied";
  readonly canonicalEnvelope: string;
  readonly envelopeDigest: string;
}

export interface ApprovalStore {
  getAsfRunSnapshot(runId: string):
    | {
        readonly run: {
          readonly runId: string;
          readonly workOrderId: string;
          readonly attemptId: string;
          readonly candidateSha: string | null;
        };
        readonly admission: {
          readonly payloadDigest: string;
          readonly effectivePolicyDigest: string;
        };
      }
    | undefined;
  recordAsfApproval(input: ValidatedApproval): {
    readonly approval: PersistedApproval;
    readonly created: boolean;
    readonly resumed: boolean;
    readonly resumePhase: string | null;
  };
  listAsfApprovals(input: {
    readonly runId: string;
    readonly candidateSha: string;
    readonly policyDigest: string;
    readonly decisionType: string;
    readonly requestedEffect: string;
  }): readonly PersistedApproval[];
}

export interface RecordApprovalResult {
  readonly approvalId: string;
  readonly runId: string;
  readonly decision: "approved" | "denied";
  readonly disposition: "recorded" | "existing";
  readonly envelopeDigest: string;
  readonly resumed: boolean;
  readonly resumePhase: string | null;
}

type ApprovalErrorCode =
  | "RM-APPROVAL-001"
  | "RM-APPROVAL-002"
  | "RM-APPROVAL-003"
  | "RM-APPROVAL-004";

function approvalError(code: ApprovalErrorCode, whatHappened: string): RunmillError {
  return RunmillError.fromCatalog(code, { whatHappened });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Refuse unknown authority-bearing schema versions before generic validation. */
export function parseApprovalEnvelope(raw: unknown): ApprovalEnvelope {
  const envelope = asRecord(raw);
  const payload = asRecord(envelope?.["payload"]);
  if (
    envelope?.["schema"] !== APPROVAL_ENVELOPE_SCHEMA ||
    payload?.["schema"] !== APPROVAL_SCHEMA
  ) {
    throw approvalError(
      "RM-APPROVAL-001",
      `unsupported approval schemas: envelope=${JSON.stringify(envelope?.["schema"])}, ` +
        `payload=${JSON.stringify(payload?.["schema"])}`,
    );
  }
  const parsed = approvalEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw approvalError(
      "RM-APPROVAL-002",
      "the approval envelope is malformed:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

/** Canonical bytes covered by the approval signature. */
export function approvalSigningPayload(envelope: ApprovalEnvelope): string {
  const { signature: _signature, ...signed } = envelope;
  return canonicalJson(signed);
}

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw approvalError("RM-APPROVAL-002", `${label} is not a valid timestamp`);
  }
  return parsed;
}

function assertSignerLifecycle(
  signer: TrustedApprovalSigner,
  payload: ApprovalPayload,
  now: number,
): void {
  const issuedAt = parseInstant(payload.issued_at, "approval issued_at");
  const expiresAt = parseInstant(payload.expires_at, "approval expires_at");
  if (issuedAt >= expiresAt || issuedAt > now || now >= expiresAt) {
    throw approvalError(
      "RM-APPROVAL-002",
      "approval freshness is invalid; require issued_at <= now < expires_at",
    );
  }
  if (signer.validFrom !== undefined && issuedAt < parseInstant(signer.validFrom, "signer validFrom")) {
    throw approvalError("RM-APPROVAL-004", "approval was issued before the signer became valid");
  }
  if (signer.validUntil !== undefined && now >= parseInstant(signer.validUntil, "signer validUntil")) {
    throw approvalError("RM-APPROVAL-004", "the approval signer is no longer valid");
  }
  if (signer.revokedAt !== undefined && now >= parseInstant(signer.revokedAt, "signer revokedAt")) {
    throw approvalError("RM-APPROVAL-004", "the approval signer has been revoked");
  }
}

function assertSignature(envelope: ApprovalEnvelope, signer: TrustedApprovalSigner): void {
  const encoded = envelope.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== encoded) {
    throw approvalError("RM-APPROVAL-002", "the approval signature is not canonical base64url");
  }
  try {
    const key =
      signer.publicKey instanceof KeyObject
        ? signer.publicKey
        : createPublicKey(signer.publicKey);
    if (
      key.type !== "public" ||
      (key.asymmetricKeyType !== "ed25519" && key.asymmetricKeyType !== "ed448")
    ) {
      throw new Error("trusted approval signer must be an EdDSA public key");
    }
    if (
      !verifySignature(
        null,
        Buffer.from(approvalSigningPayload(envelope), "utf8"),
        key,
        signature,
      )
    ) {
      throw new Error("signature verification returned false");
    }
  } catch (cause) {
    throw approvalError(
      "RM-APPROVAL-002",
      `approval signature verification failed for ${JSON.stringify(envelope.key_id)}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

function assertMember(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) {
    throw approvalError(
      "RM-APPROVAL-004",
      `${label} ${JSON.stringify(value)} is not authorized by the trusted signer registration`,
    );
  }
}

/** Digest of the values whose change makes an approval stale. */
export function approvalBindingDigest(payload: ApprovalPayload): `sha256:${string}` {
  return sha256Digest({
    work_order_id: payload.work_order_id,
    work_order_digest: payload.work_order_digest,
    run_id: payload.run_id,
    attempt_id: payload.attempt_id,
    candidate_sha: payload.candidate_sha,
    decision_type: payload.decision_type,
    requested_effect: payload.requested_effect,
    policy_digest: payload.policy_digest,
    approver: payload.approver,
  });
}

/** Verify origin, freshness, local authority, and every exact run/candidate binding. */
export function validateApproval(
  raw: unknown,
  options: {
    readonly clock: Clock;
    readonly trustedSigners: readonly TrustedApprovalSigner[];
    readonly expected: ApprovalBinding;
  },
): ValidatedApproval {
  const envelope = parseApprovalEnvelope(raw);
  const signer = options.trustedSigners.find((item) => item.keyId === envelope.key_id);
  if (signer === undefined) {
    throw approvalError(
      "RM-APPROVAL-004",
      `approval signer ${JSON.stringify(envelope.key_id)} is not trusted`,
    );
  }
  assertSignerLifecycle(signer, envelope.payload, options.clock.now().getTime());
  assertSignature(envelope, signer);

  const actual: ApprovalBinding = {
    workOrderId: envelope.payload.work_order_id,
    workOrderDigest: envelope.payload.work_order_digest,
    runId: envelope.payload.run_id,
    attemptId: envelope.payload.attempt_id,
    candidateSha: envelope.payload.candidate_sha,
    policyDigest: envelope.payload.policy_digest,
    decisionType: envelope.payload.decision_type,
    requestedEffect: envelope.payload.requested_effect,
  };
  for (const key of Object.keys(options.expected) as (keyof ApprovalBinding)[]) {
    if (actual[key] !== options.expected[key]) {
      throw approvalError(
        "RM-APPROVAL-003",
        `approval ${key} ${JSON.stringify(actual[key])} does not match current binding ` +
          JSON.stringify(options.expected[key]),
      );
    }
  }
  assertMember(envelope.payload.approver.subject, signer.subjects, "approver subject");
  assertMember(envelope.payload.approver.authority, signer.authorities, "approver authority");
  assertMember(envelope.payload.decision_type, signer.decisionTypes, "decision type");
  assertMember(envelope.payload.requested_effect, signer.requestedEffects, "requested effect");

  return {
    envelope,
    canonicalEnvelope: canonicalJson(envelope),
    envelopeDigest: sha256Digest(envelope),
    bindingDigest: approvalBindingDigest(envelope.payload),
    signature: { verified: true, keyId: envelope.key_id, algorithm: "EdDSA" },
  };
}

/**
 * Trusted approval control plane. It derives all run bindings from one
 * durable snapshot, validates the signed assertion, and lets the store repeat
 * those bindings atomically at commit time.
 */
export class AsfApprovalService {
  readonly #store: ApprovalStore;
  readonly #clock: Clock;
  readonly #trustedSigners: readonly TrustedApprovalSigner[];

  constructor(options: {
    readonly store: ApprovalStore;
    readonly clock: Clock;
    readonly trustedSigners: readonly TrustedApprovalSigner[];
  }) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#trustedSigners = options.trustedSigners;
  }

  record(raw: unknown): RecordApprovalResult {
    // Strict parsing here is read-only and lets us resolve the named durable
    // run. No approval authority is exercised until signature validation.
    const envelope = parseApprovalEnvelope(raw);
    const snapshot = this.#store.getAsfRunSnapshot(envelope.payload.run_id);
    if (snapshot === undefined || snapshot.run.candidateSha === null) {
      throw approvalError(
        "RM-APPROVAL-003",
        `approval names an unknown run or a run without a current candidate: ` +
          JSON.stringify(envelope.payload.run_id),
      );
    }
    const validated = validateApproval(envelope, {
      clock: this.#clock,
      trustedSigners: this.#trustedSigners,
      expected: {
        workOrderId: snapshot.run.workOrderId,
        workOrderDigest: snapshot.admission.payloadDigest,
        runId: snapshot.run.runId,
        attemptId: snapshot.run.attemptId,
        candidateSha: snapshot.run.candidateSha,
        policyDigest: snapshot.admission.effectivePolicyDigest,
        decisionType: envelope.payload.decision_type,
        requestedEffect: envelope.payload.requested_effect,
      },
    });
    const persisted = this.#store.recordAsfApproval(validated);
    return {
      approvalId: persisted.approval.approvalId,
      runId: persisted.approval.runId,
      decision: persisted.approval.decision,
      disposition: persisted.created ? "recorded" : "existing",
      envelopeDigest: persisted.approval.envelopeDigest,
      resumed: persisted.resumed,
      resumePhase: persisted.resumePhase,
    };
  }

  /**
   * Revalidate every stored assertion against current trust and time. A
   * current denial, malformed stored record, revocation, or stale assertion
   * fails closed; one current approval is required.
   */
  requireCurrent(
    runId: string,
    decisionType: string,
    requestedEffect: string,
  ): PersistedApproval {
    const snapshot = this.#store.getAsfRunSnapshot(runId);
    if (snapshot === undefined || snapshot.run.candidateSha === null) {
      throw approvalError(
        "RM-APPROVAL-003",
        `run ${JSON.stringify(runId)} has no current approval candidate`,
      );
    }
    const expected: ApprovalBinding = {
      workOrderId: snapshot.run.workOrderId,
      workOrderDigest: snapshot.admission.payloadDigest,
      runId,
      attemptId: snapshot.run.attemptId,
      candidateSha: snapshot.run.candidateSha,
      policyDigest: snapshot.admission.effectivePolicyDigest,
      decisionType,
      requestedEffect,
    };
    const records = this.#store.listAsfApprovals({
      runId,
      candidateSha: expected.candidateSha,
      policyDigest: expected.policyDigest,
      decisionType,
      requestedEffect,
    });
    let approved: PersistedApproval | undefined;
    for (const record of records) {
      let raw: unknown;
      try {
        raw = JSON.parse(record.canonicalEnvelope) as unknown;
      } catch {
        throw approvalError(
          "RM-APPROVAL-002",
          `stored approval ${record.approvalId} is not canonical JSON`,
        );
      }
      const validated = validateApproval(raw, {
        clock: this.#clock,
        trustedSigners: this.#trustedSigners,
        expected,
      });
      if (validated.envelopeDigest !== record.envelopeDigest) {
        throw approvalError(
          "RM-APPROVAL-002",
          `stored approval ${record.approvalId} digest is contradictory`,
        );
      }
      if (validated.envelope.payload.decision === "denied") {
        throw approvalError(
          "RM-APPROVAL-004",
          `a current authorized denial blocks ${decisionType}/${requestedEffect}`,
        );
      }
      approved = record;
    }
    if (approved === undefined) {
      throw approvalError(
        "RM-APPROVAL-003",
        `no current approval binds ${runId} to ${decisionType}/${requestedEffect}`,
      );
    }
    return approved;
  }
}
