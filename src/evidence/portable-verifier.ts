import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import { SystemClock } from "../platform/clock.js";
import {
  AsfEvidenceValidationError,
  validateSignedAsfEvidenceBundle,
  verifyAsfEvidenceArtifactContents,
  type ArtifactVerifiedAsfEvidenceBundle,
  type AsfEvidenceExpectations,
  type AsfEvidenceArtifactResolver,
  type TrustedAsfEvidenceSigner,
  type ValidatedAsfEvidenceBundle,
} from "./asf-validator.js";
import {
  ASF_SIGNED_TERMINAL_EVIDENCE_SCHEMA,
  ASF_TERMINAL_PHASES,
  asfTerminalProviderBudgetEvidenceSchema,
  validateSignedAsfTerminalEvidenceBundle,
  type AsfTerminalEvidenceExpectations,
  type ValidatedAsfTerminalEvidenceBundle,
} from "./asf-terminal.js";
import { asfTerminalEffectLedgerSchema } from "./asf-terminal-effects.js";

export const ASF_EVIDENCE_TRUST_SCHEMA =
  "runmill.asf-evidence-trust/v1" as const;
export const ASF_EVIDENCE_EXPECTATIONS_SCHEMA =
  "runmill.asf-evidence-expectations/v1" as const;
export const ASF_TERMINAL_EVIDENCE_EXPECTATIONS_SCHEMA =
  "runmill.asf-terminal-evidence-expectations/v1" as const;
export const ASF_EVIDENCE_VERIFICATION_REPORT_SCHEMA =
  "runmill.asf-evidence-verification-report/v1" as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedTextSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain controls");
const pathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    "must be a normalized repository-relative path",
  );

const trustedSignerDocumentSchema = z
  .object({
    key_id: identifierSchema,
    public_key_pem: z.string().min(1).max(16_384),
    valid_from: z.iso.datetime({ offset: true }),
    valid_until: z.iso.datetime({ offset: true }),
    revoked_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const asfEvidenceTrustDocumentSchema = z
  .object({
    schema: z.literal(ASF_EVIDENCE_TRUST_SCHEMA),
    signers: z.array(trustedSignerDocumentSchema).min(1).max(128),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const signer of document.signers) {
      if (ids.has(signer.key_id)) {
        context.addIssue({
          code: "custom",
          path: ["signers"],
          message: "must not contain duplicate key ids",
        });
      }
      ids.add(signer.key_id);
    }
  });

const pullRequestExpectationSchema = z
  .object({
    number: z.number().int().positive().safe(),
    url: z.url(),
    head_ref: boundedTextSchema,
    base_ref: boundedTextSchema,
  })
  .strict();

export const asfEvidenceExpectationsDocumentSchema = z
  .object({
    schema: z.literal(ASF_EVIDENCE_EXPECTATIONS_SCHEMA),
    run_id: identifierSchema,
    attempt_id: identifierSchema,
    work_order_id: identifierSchema,
    work_order_envelope_digest: digestSchema,
    work_order_payload_digest: digestSchema,
    effective_policy_digest: digestSchema,
    forge: identifierSchema,
    repository: z
      .string()
      .min(3)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    base_ref: boundedTextSchema,
    base_sha: gitShaSchema,
    candidate_sha: gitShaSchema,
    tree_digest: digestSchema,
    normalized_diff_digest: digestSchema,
    changed_paths: z.array(pathSchema).max(2_048),
    required_local_check_ids: z.array(boundedTextSchema).max(2_048),
    required_ci_contexts: z.array(boundedTextSchema).max(2_048),
    require_local_review: z.boolean(),
    require_pull_request_review: z.boolean(),
    pull_request: pullRequestExpectationSchema,
  })
  .strict();

export const asfTerminalEvidenceExpectationsDocumentSchema = z
  .object({
    schema: z.literal(ASF_TERMINAL_EVIDENCE_EXPECTATIONS_SCHEMA),
    run_id: identifierSchema,
    work_order_id: identifierSchema,
    attempt_id: identifierSchema,
    work_order_envelope_digest: digestSchema,
    work_order_payload_digest: digestSchema,
    effective_policy_digest: digestSchema,
    repository: z
      .string()
      .min(3)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    base_sha: gitShaSchema,
    candidate_sha: gitShaSchema.nullable(),
    terminal_phase: z.enum(ASF_TERMINAL_PHASES),
    terminal_event_seq: z.number().int().positive().safe(),
    cleanup_observation_digest: digestSchema,
    delivery_bundle_digest: digestSchema.nullable(),
    preceding_event_chain_digest: digestSchema,
    provider_budget: asfTerminalProviderBudgetEvidenceSchema,
    side_effects: asfTerminalEffectLedgerSchema,
    admitted_at: z.iso.datetime({ offset: true }),
    terminal_evidence_at: z.iso.datetime({ offset: true }),
    elapsed_ms: z.number().int().nonnegative().safe(),
  })
  .strict();

export type AsfEvidenceTrustDocument = z.infer<
  typeof asfEvidenceTrustDocumentSchema
>;
export type AsfEvidenceExpectationsDocument = z.infer<
  typeof asfEvidenceExpectationsDocumentSchema
>;
export type AsfTerminalEvidenceExpectationsDocument = z.infer<
  typeof asfTerminalEvidenceExpectationsDocumentSchema
>;

function parseDocument<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} is invalid: ${detail}`);
  }
  return parsed.data;
}

export function parseAsfEvidenceTrustDocument(
  raw: unknown,
): readonly TrustedAsfEvidenceSigner[] {
  const document = parseDocument(
    asfEvidenceTrustDocumentSchema,
    raw,
    "evidence trust document",
  );
  return Object.freeze(
    document.signers.map((signer) => {
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey(signer.public_key_pem);
      } catch {
        throw new Error(
          `evidence trust document contains an invalid public key for ${JSON.stringify(signer.key_id)}`,
        );
      }
      if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error(
          `evidence trust document key ${JSON.stringify(signer.key_id)} is not a public Ed25519 key`,
        );
      }
      return Object.freeze({
        keyId: signer.key_id,
        publicKey,
        validFrom: signer.valid_from,
        validUntil: signer.valid_until,
        revokedAt: signer.revoked_at,
      });
    }),
  );
}

export function parseAsfEvidenceExpectationsDocument(
  raw: unknown,
): AsfEvidenceExpectations {
  const document = parseDocument(
    asfEvidenceExpectationsDocumentSchema,
    raw,
    "evidence expectations document",
  );
  return {
    runId: document.run_id,
    attemptId: document.attempt_id,
    workOrderId: document.work_order_id,
    workOrderEnvelopeDigest: document.work_order_envelope_digest,
    workOrderPayloadDigest: document.work_order_payload_digest,
    effectivePolicyDigest: document.effective_policy_digest,
    forge: document.forge,
    repository: document.repository,
    baseRef: document.base_ref,
    baseSha: document.base_sha,
    candidateSha: document.candidate_sha,
    treeDigest: document.tree_digest,
    normalizedDiffDigest: document.normalized_diff_digest,
    changedPaths: document.changed_paths,
    requiredLocalCheckIds: document.required_local_check_ids,
    requiredCiContexts: document.required_ci_contexts,
    requireLocalReview: document.require_local_review,
    requirePullRequestReview: document.require_pull_request_review,
    pullRequest: {
      number: document.pull_request.number,
      url: document.pull_request.url,
      headRef: document.pull_request.head_ref,
      baseRef: document.pull_request.base_ref,
    },
  };
}

export function parseAsfTerminalEvidenceExpectationsDocument(
  raw: unknown,
): AsfTerminalEvidenceExpectations {
  const document = parseDocument(
    asfTerminalEvidenceExpectationsDocumentSchema,
    raw,
    "terminal evidence expectations document",
  );
  return {
    runId: document.run_id,
    workOrderId: document.work_order_id,
    attemptId: document.attempt_id,
    workOrderEnvelopeDigest: document.work_order_envelope_digest,
    workOrderPayloadDigest: document.work_order_payload_digest,
    effectivePolicyDigest: document.effective_policy_digest,
    repository: document.repository,
    baseSha: document.base_sha,
    candidateSha: document.candidate_sha,
    terminalPhase: document.terminal_phase,
    terminalEventSeq: document.terminal_event_seq,
    cleanupObservationDigest: document.cleanup_observation_digest,
    deliveryBundleDigest: document.delivery_bundle_digest,
    precedingEventChainDigest: document.preceding_event_chain_digest,
    providerBudget: document.provider_budget,
    sideEffects: document.side_effects,
    admittedAt: document.admitted_at,
    terminalEvidenceAt: document.terminal_evidence_at,
    elapsedMs: document.elapsed_ms,
  };
}

const CAS_LOCATION_PATTERN = /^cas:\/\/sha256\/([a-f0-9]{64})$/u;

/**
 * Resolve only the flat, content-addressed files used by the portable
 * evidence bundle format. The directory is deployment-owned; no bundle field
 * can choose a path, follow a symlink, or escape it.
 */
export function createFilesystemAsfEvidenceArtifactResolver(
  directory: string,
): AsfEvidenceArtifactResolver {
  if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) {
    throw new Error("evidence artifact directory must be an absolute path without controls");
  }
  const root = resolve(directory);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("evidence artifact directory must be a regular directory");
  }
  return {
    async read(input) {
      if (input.signal?.aborted === true) {
        throw new Error("artifact read was cancelled");
      }
      const match = CAS_LOCATION_PATTERN.exec(input.locationRef);
      if (match?.[1] === undefined || input.expectedDigest !== `sha256:${match[1]}`) {
        throw new Error("artifact location and digest are not the same canonical CAS coordinate");
      }
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
        throw new Error("artifact read limit is invalid");
      }
      const path = join(root, match[1]);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1 || before.size > input.maxBytes) {
          throw new Error("artifact is not a bounded regular file");
        }
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        ) {
          throw new Error("artifact changed while being read");
        }
        return new Uint8Array(bytes);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
  };
}

export type PortableAsfEvidenceVerificationResult =
  | {
      readonly kind: "delivery";
      readonly validated: ValidatedAsfEvidenceBundle;
      readonly artifacts: ArtifactVerifiedAsfEvidenceBundle | null;
    }
  | {
      readonly kind: "terminal";
      readonly validated: ValidatedAsfTerminalEvidenceBundle;
      readonly artifacts: null;
    };

export async function verifyPortableAsfEvidenceBundle(input: {
  readonly bundle: unknown;
  readonly trust: unknown;
  readonly expectations: unknown;
  readonly clock?: Clock;
  readonly artifactResolver?: AsfEvidenceArtifactResolver;
  readonly maxArtifactBytes?: number;
  readonly maxTotalBytes?: number;
}): Promise<PortableAsfEvidenceVerificationResult> {
  const trustedSigners = parseAsfEvidenceTrustDocument(input.trust);
  const rawBundle =
    typeof input.bundle === "object" && input.bundle !== null
      ? (input.bundle as Readonly<Record<string, unknown>>)
      : undefined;
  if (rawBundle?.["schema"] === ASF_SIGNED_TERMINAL_EVIDENCE_SCHEMA) {
    if (input.artifactResolver !== undefined) {
      throw new Error(
        "terminal evidence has no portable artifact manifest; omit --artifacts-dir",
      );
    }
    const expected = parseAsfTerminalEvidenceExpectationsDocument(
      input.expectations,
    );
    const validated = validateSignedAsfTerminalEvidenceBundle(input.bundle, {
      clock: input.clock ?? new SystemClock(),
      trustedSigners,
      expected,
    });
    return { kind: "terminal", validated, artifacts: null };
  }
  const expected = parseAsfEvidenceExpectationsDocument(input.expectations);
  const validated = validateSignedAsfEvidenceBundle(input.bundle, {
    clock: input.clock ?? new SystemClock(),
    trustedSigners,
    expected,
  });
  if (input.artifactResolver === undefined) {
    return { kind: "delivery", validated, artifacts: null };
  }
  const artifacts = await verifyAsfEvidenceArtifactContents(validated, {
    resolver: input.artifactResolver,
    maxArtifactBytes: input.maxArtifactBytes ?? 16 * 1024 * 1024,
    maxTotalBytes: input.maxTotalBytes ?? 256 * 1024 * 1024,
  });
  return { kind: "delivery", validated, artifacts };
}

export function isAsfEvidenceValidationError(
  error: unknown,
): error is AsfEvidenceValidationError {
  return error instanceof AsfEvidenceValidationError;
}
