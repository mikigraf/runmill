import {
  createPrivateKey,
  KeyObject,
  sign as signBytes,
  type KeyLike,
} from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  sha256Digest,
} from "../asf/canonical-json.js";

export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1" as const;
export const ASF_EVIDENCE_PREDICATE_TYPE =
  "https://runmill.dev/attestations/asf-evidence/v1" as const;
export const ASF_EVIDENCE_PREDICATE_SCHEMA = "asf.evidence-bundle/v1" as const;
export const ASF_SIGNED_EVIDENCE_SCHEMA = "asf.signed-evidence/v1" as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const referenceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u);
const repositorySchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const branchRefSchema = z
  .string()
  .min(12)
  .max(512)
  .regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const pathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").includes("..") &&
      !/[\u0000-\u001f\u007f]/u.test(path),
    "must be a normalized repository-relative path",
  );
const mediaTypeSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
const publicHttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}, "must be a public HTTPS URL without credentials, query, or fragment");

function sortedUniqueStrings<T extends z.ZodType<string>>(item: T) {
  return z.array(item).max(2_048).superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          message: "must contain unique strings in lexical order",
        });
        return;
      }
    }
  });
}

const artifactSchema = z
  .object({
    artifact_id: identifierSchema,
    kind: z.enum([
      "work-order-envelope",
      "effective-policy",
      "normalized-diff",
      "agent-outcome",
      "verification",
      "ci-observation",
      "review",
      "side-effect",
      "approval",
      "runtime-manifest",
    ]),
    // Bound each declaration so aggregate-size arithmetic remains exact even
    // for the largest permitted manifest.
    size_bytes: z.number().int().nonnegative().max(1_073_741_824),
    media_type: mediaTypeSchema,
    digest: digestSchema,
    retention_class: z.enum(["portable", "protected", "restricted"]),
    location_ref: z.string().regex(/^cas:\/\/sha256\/[a-f0-9]{64}$/u),
  })
  .strict();

const localCheckSchema = z
  .object({
    check_id: referenceSchema,
    candidate_sha: gitShaSchema,
    tree_digest: digestSchema,
    command_digest: digestSchema,
    executor_id: identifierSchema,
    toolchain_digest: digestSchema,
    sandbox_profile_digest: digestSchema,
    started_at: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }),
    conclusion: z.enum(["success", "failure", "error"]),
    coverage: z.enum(["complete", "partial", "unknown"]),
    evidence_digest: digestSchema,
  })
  .strict();

const ciContextSchema = z
  .object({
    context: referenceSchema,
    candidate_sha: gitShaSchema,
    conclusion: z.enum([
      "success",
      "failure",
      "pending",
      "cancelled",
      "skipped",
      "neutral",
      "unknown",
    ]),
    observed_at: z.iso.datetime({ offset: true }),
    evidence_digest: digestSchema,
  })
  .strict();

const reviewSchema = z
  .object({
    review_id: identifierSchema,
    stage: z.enum(["local", "pull-request"]),
    reviewer_principal: identifierSchema,
    reviewer_profile: identifierSchema,
    independent: z.literal(true),
    candidate_sha: gitShaSchema,
    policy_digest: digestSchema,
    verdict: z.enum(["pass", "fail", "unknown"]),
    findings_digest: digestSchema,
    evidence_digest: digestSchema,
  })
  .strict();

const sideEffectSchema = z
  .object({
    effect_key: digestSchema,
    kind: z.enum([
      "branch.push",
      "pull-request.create",
      "pull-request.update",
      "pull-request.observe",
      "ci.observe",
      "review.observe",
    ]),
    candidate_sha: gitShaSchema,
    intent_digest: digestSchema,
    observation_digest: digestSchema,
    reconciliation_digest: digestSchema.nullable(),
    confirmation_digest: digestSchema,
    status: z.literal("confirmed"),
    evidence_digest: digestSchema,
  })
  .strict();

const approvalSchema = z
  .object({
    approval_id: identifierSchema,
    decision_type: identifierSchema,
    requested_effect: identifierSchema,
    approver_subject: identifierSchema,
    authority_digest: digestSchema,
    work_order_digest: digestSchema,
    candidate_sha: gitShaSchema,
    policy_digest: digestSchema,
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    applied_at: z.iso.datetime({ offset: true }),
    signature_digest: digestSchema,
    evidence_digest: digestSchema,
  })
  .strict();

export const asfEvidencePredicateSchema = z
  .object({
    schema: z.literal(ASF_EVIDENCE_PREDICATE_SCHEMA),
    run: z
      .object({
        run_id: identifierSchema,
        attempt_id: identifierSchema,
        work_order_id: identifierSchema,
        completed_at: z.iso.datetime({ offset: true }),
      })
      .strict(),
    work_order: z
      .object({
        envelope_digest: digestSchema,
        payload_digest: digestSchema,
        envelope_artifact_digest: digestSchema,
        signature: z
          .object({
            key_id: identifierSchema,
            algorithm: z.literal("EdDSA"),
            verified: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    policy: z
      .object({
        effective_policy_digest: digestSchema,
        effective_policy_artifact_digest: digestSchema,
        inputs: z
          .object({
            operator_policy_digest: digestSchema,
            work_order_policy_digest: digestSchema,
            repository_policy_digest: digestSchema,
            forge_policy_digest: digestSchema,
          })
          .strict(),
        required_local_checks: sortedUniqueStrings(referenceSchema),
        required_ci_contexts: sortedUniqueStrings(referenceSchema),
        require_local_review: z.boolean(),
        require_pull_request_review: z.boolean(),
      })
      .strict(),
    source: z
      .object({
        forge: identifierSchema,
        repository: repositorySchema,
        base_ref: branchRefSchema,
        base_sha: gitShaSchema,
        candidate_sha: gitShaSchema,
        remote_head_sha: gitShaSchema,
        merge_sha: gitShaSchema.nullable(),
        tree_digest: digestSchema,
        normalized_diff_digest: digestSchema,
        normalized_diff_artifact_digest: digestSchema,
        changed_paths: sortedUniqueStrings(pathSchema),
      })
      .strict(),
    runtime: z
      .object({
        harness_digest: digestSchema,
        tool_policy_digest: digestSchema,
        sandbox_profile_digest: digestSchema,
        dependency_digest: digestSchema,
        runtime_digest: digestSchema,
        runtime_manifest_digest: digestSchema,
        providers: z.array(
          z
            .object({
              role: z.enum(["implementer", "local-reviewer", "pull-request-reviewer"]),
              provider: identifierSchema,
              model: referenceSchema,
              principal_id: identifierSchema,
              // Identity lease IDs are sensitive controller capabilities. The
              // portable bundle carries only a one-way attribution digest
              // assembled from the broker's non-secret attribution fields.
              lease_attribution_digest: digestSchema,
            })
            .strict(),
        ).max(3),
      })
      .strict(),
    role_outcomes: z.array(
      z
        .object({
          role: z.enum(["implementer", "local-reviewer", "pull-request-reviewer"]),
          outcome: z.enum(["completed", "passed", "stopped"]),
          candidate_sha: gitShaSchema,
          evidence_digest: digestSchema,
        })
        .strict(),
    ).max(3),
    verification: z
      .object({
        local_checks: z.array(localCheckSchema).max(256),
        ci_contexts: z.array(ciContextSchema).max(256),
      })
      .strict(),
    reviews: z.array(reviewSchema).max(16),
    side_effects: z.array(sideEffectSchema).max(1_024),
    approvals: z.array(approvalSchema).max(256),
    cancellation: z
      .object({
        requester_subject: identifierSchema,
        reason_code: identifierSchema,
        requested_at: z.iso.datetime({ offset: true }),
        evidence_digest: digestSchema,
      })
      .strict()
      .nullable(),
    budget: z
      .object({
        cost_usd: z.number().finite().nonnegative(),
        agent_invocations: z.number().int().nonnegative(),
        fix_iterations: z.number().int().nonnegative(),
        elapsed_ms: z.number().int().nonnegative(),
        stop_reason: z.literal("pr-delivered"),
      })
      .strict(),
    delivery: z
      .object({
        closure_target: z.literal("pr"),
        satisfied: z.literal(true),
        pull_request: z
          .object({
            forge: identifierSchema,
            repository: repositorySchema,
            number: z.number().int().positive(),
            url: publicHttpsUrlSchema,
            head_ref: branchRefSchema,
            base_ref: branchRefSchema,
            head_sha: gitShaSchema,
            observed_at: z.iso.datetime({ offset: true }),
            evidence_digest: digestSchema,
          })
          .strict(),
      })
      .strict(),
    artifacts: z.array(artifactSchema).max(2_048),
  })
  .strict();

export const asfEvidenceStatementSchema = z
  .object({
    _type: z.literal(IN_TOTO_STATEMENT_V1),
    subject: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9._-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
            digest: z.object({ sha1: gitShaSchema }).strict(),
          })
          .strict(),
      )
      .length(1),
    predicateType: z.literal(ASF_EVIDENCE_PREDICATE_TYPE),
    predicate: asfEvidencePredicateSchema,
  })
  .strict();

export const signedAsfEvidenceBundleSchema = z
  .object({
    schema: z.literal(ASF_SIGNED_EVIDENCE_SCHEMA),
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
    issued_at: z.iso.datetime({ offset: true }),
    bundle_digest: digestSchema,
    statement: asfEvidenceStatementSchema,
    signature: z.string().regex(/^base64url:[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type AsfEvidencePredicate = z.infer<typeof asfEvidencePredicateSchema>;
export type AsfEvidenceStatement = z.infer<typeof asfEvidenceStatementSchema>;
export type SignedAsfEvidenceBundle = z.infer<typeof signedAsfEvidenceBundleSchema>;

export interface SignAsfEvidenceBundleInput {
  readonly statement: AsfEvidenceStatement;
  readonly keyId: string;
  readonly privateKey: KeyLike;
  readonly issuedAt: string;
}

/** Canonical bytes covered by the worker's Ed25519 signature. */
export function asfEvidenceSigningPayload(bundle: SignedAsfEvidenceBundle): string {
  const { signature: _signature, ...unsigned } = bundle;
  return canonicalJson(unsigned);
}

/** Finalize an immutable, content-addressed statement and sign its envelope. */
export function signAsfEvidenceBundle(
  input: SignAsfEvidenceBundleInput,
): SignedAsfEvidenceBundle {
  const statement = asfEvidenceStatementSchema.parse(input.statement);
  const unsigned = {
    schema: ASF_SIGNED_EVIDENCE_SCHEMA,
    key_id: identifierSchema.parse(input.keyId),
    algorithm: "EdDSA" as const,
    issued_at: z.iso.datetime({ offset: true }).parse(input.issuedAt),
    bundle_digest: sha256Digest(statement),
    statement,
  };
  const key =
    input.privateKey instanceof KeyObject
      ? input.privateKey
      : createPrivateKey(input.privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("ASF evidence signing requires a private Ed25519 key");
  }
  const signature = signBytes(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    key,
  ).toString("base64url");
  return signedAsfEvidenceBundleSchema.parse({
    ...unsigned,
    signature: `base64url:${signature}`,
  });
}
