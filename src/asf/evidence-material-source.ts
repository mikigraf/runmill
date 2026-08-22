import {
  createPublicKey,
  KeyObject,
  verify as verifySignature,
} from "node:crypto";
import { z } from "zod";
import {
  ASF_EVIDENCE_PREDICATE_SCHEMA,
  ASF_EVIDENCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_V1,
  asfEvidenceStatementSchema,
  type AsfEvidencePredicate,
} from "../evidence/asf-bundle.js";
import type {
  AsfEvidenceArtifactWriter,
  PutAsfArtifactInput,
} from "../evidence/filesystem-cas.js";
import { AsfEvidenceValidationError } from "../evidence/asf-validator.js";
import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";
import type {
  AsfEvidenceFinalizationMaterial,
  AsfEvidenceFinalizationMaterialSource,
  AsfEvidenceMaterialRequest,
} from "./evidence-finalizer.js";
import {
  asfIdentityLeaseAttributionSchema,
  type AsfIdentityLeaseAttribution,
} from "./identity-attribution.js";
import { parseRunEvent, type RunEvent } from "./run-event.js";
import {
  workOrderSigningPayload,
  type TrustedWorkOrderSigner,
  type WorkOrderEnvelope,
} from "./work-order.js";

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
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
const artifactIdSchema = identifierSchema;

const artifactMaterialSchema = z
  .object({
    artifact_id: artifactIdSchema,
    kind: z.enum([
      "normalized-diff",
      "agent-outcome",
      "verification",
      "ci-observation",
      "review",
      "side-effect",
      "approval",
      "runtime-manifest",
    ]),
    media_type: mediaTypeSchema,
    retention_class: z.enum(["portable", "protected", "restricted"]),
    privacy_class: z.enum([
      "structured-evidence",
      "prompt",
      "model-transcript",
      "raw-source-archive",
    ]),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    expected_digest: digestSchema.optional(),
  })
  .strict();

const recordSetSchema = z
  .object({
    schema: z.literal("asf.evidence-finalization-records/v1"),
    source: z
      .object({
        normalized_diff_digest: digestSchema,
        normalized_diff_artifact_id: artifactIdSchema,
        changed_paths: z.array(pathSchema).max(2_048),
      })
      .strict(),
    runtime: z
      .object({
        tool_policy_digest: digestSchema,
        sandbox_profile_digest: digestSchema,
        dependency_digest: digestSchema,
        runtime_digest: digestSchema,
        runtime_manifest_artifact_id: artifactIdSchema,
        provider_models: z
          .array(
            z
              .object({
                role: z.enum(["implementer", "local-reviewer", "pull-request-reviewer"]),
                model: referenceSchema,
              })
              .strict(),
          )
          .length(3),
      })
      .strict(),
    role_outcomes: z
      .array(
        z
          .object({
            role: z.enum(["implementer", "local-reviewer", "pull-request-reviewer"]),
            outcome: z.enum(["completed", "passed", "stopped"]),
            artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .length(3),
    local_checks: z
      .array(
        z
          .object({
            check_id: referenceSchema,
            command_digest: digestSchema,
            executor_id: identifierSchema,
            toolchain_digest: digestSchema,
            sandbox_profile_digest: digestSchema,
            started_at: z.iso.datetime({ offset: true }),
            completed_at: z.iso.datetime({ offset: true }),
            conclusion: z.enum(["success", "failure", "error"]),
            coverage: z.enum(["complete", "partial", "unknown"]),
            artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .max(256),
    ci_contexts: z
      .array(
        z
          .object({
            context: referenceSchema,
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
            artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .max(256),
    reviews: z
      .array(
        z
          .object({
            review_id: identifierSchema,
            stage: z.enum(["local", "pull-request"]),
            verdict: z.enum(["pass", "fail", "unknown"]),
            findings_artifact_id: artifactIdSchema,
            evidence_artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .max(16),
    side_effects: z
      .array(
        z
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
            intent_digest: digestSchema,
            observation_digest: digestSchema,
            reconciliation_digest: digestSchema.nullable(),
            confirmation_digest: digestSchema,
            status: z.literal("confirmed"),
            artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .max(1_024),
    approvals: z
      .array(
        z
          .object({
            approval_id: identifierSchema,
            decision_type: identifierSchema,
            requested_effect: identifierSchema,
            approver_subject: identifierSchema,
            authority_digest: digestSchema,
            issued_at: z.iso.datetime({ offset: true }),
            expires_at: z.iso.datetime({ offset: true }),
            applied_at: z.iso.datetime({ offset: true }),
            signature_digest: digestSchema,
            artifact_id: artifactIdSchema,
          })
          .strict(),
      )
      .max(256),
    budget: z
      .object({
        cost_usd: z.number().finite().nonnegative(),
        agent_invocations: z.number().int().nonnegative(),
        fix_iterations: z.number().int().nonnegative(),
        elapsed_ms: z.number().int().nonnegative(),
      })
      .strict(),
    delivery_evidence_artifact_id: artifactIdSchema,
    artifacts: z.array(artifactMaterialSchema).max(2_046),
  })
  .strict();

export type AsfEvidenceFinalizationRecordSet = z.infer<typeof recordSetSchema>;

export interface AsfEvidenceExactRecordSource {
  /** Return exact controller records and bytes; prose or inferred defaults are invalid input. */
  load(input: AsfEvidenceMaterialRequest): Promise<unknown>;
}

export interface DeterministicAsfEvidenceMaterialSourceOptions {
  readonly records: AsfEvidenceExactRecordSource;
  readonly artifacts: AsfEvidenceArtifactWriter;
  readonly trustedWorkOrderSigners: readonly TrustedWorkOrderSigner[];
}

function fail(failure: "schema" | "trust" | "signature" | "binding" | "missing-evidence", detail: string): never {
  throw new AsfEvidenceValidationError(failure, detail);
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) fail("binding", `${label} contains duplicates`);
}

function exactEvent(
  events: readonly RunEvent[],
  type: string,
  candidateSha?: string,
): RunEvent {
  const matches = events.filter(
    (event) =>
      event.type === type &&
      (candidateSha === undefined || event.payload["candidate_sha"] === candidateSha),
  );
  if (matches.length !== 1) {
    fail("missing-evidence", `expected exactly one durable ${type} event for the exact candidate`);
  }
  const event = matches[0];
  if (event === undefined) fail("missing-evidence", `durable ${type} event is missing`);
  return event;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") fail("missing-evidence", `${label} is missing`);
  return value;
}

function positiveIntegerField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("missing-evidence", `${label} is missing or invalid`);
  }
  return value as number;
}

function verifyWorkOrderSignatureAgain(
  envelope: WorkOrderEnvelope,
  trustedSigners: readonly TrustedWorkOrderSigner[],
): void {
  const matching = trustedSigners.filter((signer) => signer.keyId === envelope.key_id);
  if (matching.length !== 1) {
    fail(
      "trust",
      matching.length === 0
        ? `Work Order signer ${JSON.stringify(envelope.key_id)} is not trusted by evidence finalization`
        : `Work Order signer ${JSON.stringify(envelope.key_id)} has contradictory trust entries`,
    );
  }
  const signer = matching[0];
  if (signer === undefined) fail("trust", "Work Order signer lookup failed");
  const encoded = envelope.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== encoded) {
    fail("signature", "Work Order signature is not canonical base64url");
  }
  try {
    const publicKey =
      signer.publicKey instanceof KeyObject
        ? signer.publicKey
        : createPublicKey(signer.publicKey);
    if (
      publicKey.type !== "public" ||
      (publicKey.asymmetricKeyType !== "ed25519" && publicKey.asymmetricKeyType !== "ed448")
    ) {
      fail("trust", "trusted Work Order signer must be a public EdDSA key");
    }
    if (
      !verifySignature(
        null,
        Buffer.from(workOrderSigningPayload(envelope), "utf8"),
        publicKey,
        signature,
      )
    ) {
      fail("signature", "Work Order signature verification returned false during finalization");
    }
  } catch (error) {
    if (error instanceof AsfEvidenceValidationError) throw error;
    fail("signature", "Work Order signature could not be independently verified");
  }
}

function parseIdentityAttributions(events: readonly RunEvent[]): readonly AsfIdentityLeaseAttribution[] {
  const identity = exactEvent(events, "identity.leases_acquired");
  const raw = identity.payload["attributions"];
  if (!Array.isArray(raw) || raw.length !== 3) {
    fail("missing-evidence", "exact identity attribution records are missing");
  }
  const values = raw.map((value) => {
    const parsed = asfIdentityLeaseAttributionSchema.safeParse(value);
    if (!parsed.success) fail("schema", "identity attribution record is malformed");
    return parsed.data;
  });
  unique(values.map((value) => value.role), "identity attribution roles");
  return values;
}

function evidenceRole(role: AsfIdentityLeaseAttribution["role"]): "implementer" | "local-reviewer" | "pull-request-reviewer" {
  return role === "pr-reviewer" ? "pull-request-reviewer" : role;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  unique(values, label);
  return [...values].sort();
}

function artifactInput(material: z.infer<typeof artifactMaterialSchema>): PutAsfArtifactInput {
  return {
    artifactId: material.artifact_id,
    kind: material.kind,
    mediaType: material.media_type,
    retentionClass: material.retention_class,
    privacyClass: material.privacy_class,
    bytes: material.bytes,
    ...(material.expected_digest === undefined
      ? {}
      : { expectedDigest: material.expected_digest }),
  };
}

/**
 * Builds the complete statement and its independent validator expectations
 * from durable run bindings plus an explicit record source. It never accepts
 * a pre-built statement from production composition.
 */
export class DeterministicAsfEvidenceMaterialSource
  implements AsfEvidenceFinalizationMaterialSource
{
  readonly #options: DeterministicAsfEvidenceMaterialSourceOptions;

  constructor(options: DeterministicAsfEvidenceMaterialSourceOptions) {
    this.#options = options;
  }

  async assemble(input: AsfEvidenceMaterialRequest): Promise<AsfEvidenceFinalizationMaterial> {
    if (input.signal.aborted) fail("missing-evidence", "evidence material assembly was cancelled");
    verifyWorkOrderSignatureAgain(input.envelope, this.#options.trustedWorkOrderSigners);
    const rawRecords = await this.#options.records.load(input);
    const parsedRecords = recordSetSchema.safeParse(rawRecords);
    if (!parsedRecords.success) {
      fail(
        "schema",
        "exact evidence record source returned malformed or incomplete records: " +
          parsedRecords.error.issues.map((issue) => issue.path.join(".")).join(", "),
      );
    }
    const records = parsedRecords.data;
    const events = input.events.map((event) => parseRunEvent(structuredClone(event)));
    const candidateShaValue = input.binding.candidateSha;
    if (typeof candidateShaValue !== "string" || !gitShaSchema.safeParse(candidateShaValue).success) {
      fail("binding", "candidate SHA is invalid");
    }
    const candidateSha = candidateShaValue;
    const candidate = exactEvent(events, "candidate.created", candidateSha);
    const delivered = exactEvent(events, "pull_request.delivered", candidateSha);
    const identityAttributions = parseIdentityAttributions(events);
    const treeDigest = stringField(candidate.payload, "tree_digest", "candidate tree digest");
    if (!digestSchema.safeParse(treeDigest).success) fail("schema", "candidate tree digest is invalid");

    unique(records.artifacts.map((artifact) => artifact.artifact_id), "artifact ids");
    unique(records.runtime.provider_models.map((provider) => provider.role), "provider model roles");
    unique(records.role_outcomes.map((outcome) => outcome.role), "role outcome roles");
    unique(records.local_checks.map((check) => check.check_id), "local check ids");
    unique(records.ci_contexts.map((check) => check.context), "CI contexts");
    unique(records.reviews.map((review) => review.review_id), "review ids");
    unique(records.reviews.map((review) => review.stage), "review stages");
    unique(records.side_effects.map((effect) => effect.effect_key), "side-effect keys");
    unique(records.approvals.map((approval) => approval.approval_id), "approval ids");

    const requiredArtifactIds = [
      records.source.normalized_diff_artifact_id,
      records.runtime.runtime_manifest_artifact_id,
      records.delivery_evidence_artifact_id,
      ...records.role_outcomes.map((record) => record.artifact_id),
      ...records.local_checks.map((record) => record.artifact_id),
      ...records.ci_contexts.map((record) => record.artifact_id),
      ...records.reviews.flatMap((record) => [record.findings_artifact_id, record.evidence_artifact_id]),
      ...records.side_effects.map((record) => record.artifact_id),
      ...records.approvals.map((record) => record.artifact_id),
    ];
    const availableArtifactIds = new Set(records.artifacts.map((artifact) => artifact.artifact_id));
    for (const artifactId of requiredArtifactIds) {
      if (!availableArtifactIds.has(artifactId)) {
        fail("missing-evidence", `referenced artifact ${JSON.stringify(artifactId)} is missing`);
      }
    }
    for (const reserved of ["work-order-envelope", "effective-policy"] as const) {
      if (availableArtifactIds.has(reserved)) {
        fail("binding", `record source attempted to replace reserved artifact ${reserved}`);
      }
    }
    const artifactMaterialById = new Map(
      records.artifacts.map((artifact) => [artifact.artifact_id, artifact]),
    );
    const requireArtifactKind = (
      artifactId: string,
      kind: z.infer<typeof artifactMaterialSchema>["kind"],
      label: string,
    ): void => {
      if (artifactMaterialById.get(artifactId)?.kind !== kind) {
        fail("binding", `${label} must reference a ${kind} artifact`);
      }
    };
    requireArtifactKind(
      records.source.normalized_diff_artifact_id,
      "normalized-diff",
      "normalized diff",
    );
    requireArtifactKind(
      records.runtime.runtime_manifest_artifact_id,
      "runtime-manifest",
      "runtime manifest",
    );
    for (const record of records.role_outcomes) {
      requireArtifactKind(record.artifact_id, "agent-outcome", `${record.role} outcome`);
    }
    for (const record of records.local_checks) {
      requireArtifactKind(record.artifact_id, "verification", `local check ${record.check_id}`);
    }
    for (const record of records.ci_contexts) {
      requireArtifactKind(record.artifact_id, "ci-observation", `CI context ${record.context}`);
    }
    for (const record of records.reviews) {
      requireArtifactKind(record.findings_artifact_id, "review", `review ${record.review_id} findings`);
      requireArtifactKind(record.evidence_artifact_id, "review", `review ${record.review_id} evidence`);
    }
    for (const record of records.side_effects) {
      requireArtifactKind(record.artifact_id, "side-effect", `side effect ${record.effect_key}`);
    }
    for (const record of records.approvals) {
      requireArtifactKind(record.artifact_id, "approval", `approval ${record.approval_id}`);
    }
    requireArtifactKind(
      records.delivery_evidence_artifact_id,
      "side-effect",
      "pull-request delivery",
    );

    const generated: readonly PutAsfArtifactInput[] = [
      {
        artifactId: "work-order-envelope",
        kind: "work-order-envelope",
        mediaType: "application/json",
        retentionClass: "protected",
        privacyClass: "structured-evidence",
        bytes: Buffer.from(canonicalJson(input.envelope), "utf8"),
        expectedDigest: input.snapshot.admission.envelopeDigest,
        signal: input.signal,
      },
      {
        artifactId: "effective-policy",
        kind: "effective-policy",
        mediaType: "application/json",
        retentionClass: "portable",
        privacyClass: "structured-evidence",
        bytes: Buffer.from(
          canonicalJson(input.effectivePolicy as unknown as JsonValue),
          "utf8",
        ),
        expectedDigest: sha256Digest(input.effectivePolicy as unknown as JsonValue),
        signal: input.signal,
      },
    ];
    const declarations = [] as AsfEvidencePredicate["artifacts"][number][];
    for (const artifact of [
      ...generated,
      ...[...records.artifacts]
        .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id))
        .map(artifactInput),
    ]) {
      const declaration = await this.#options.artifacts.put({
        ...artifact,
        signal: input.signal,
      });
      if (
        declaration.artifact_id !== artifact.artifactId ||
        declaration.kind !== artifact.kind ||
        declaration.media_type !== artifact.mediaType ||
        declaration.retention_class !== artifact.retentionClass ||
        declaration.size_bytes !== artifact.bytes.byteLength ||
        (artifact.expectedDigest !== undefined && declaration.digest !== artifact.expectedDigest)
      ) {
        fail("binding", `artifact writer contradicted ${JSON.stringify(artifact.artifactId)}`);
      }
      declarations.push(declaration);
    }
    if (input.signal.aborted) fail("missing-evidence", "evidence material assembly was cancelled");
    unique(declarations.map((artifact) => artifact.artifact_id), "stored artifact ids");
    const artifactById = new Map(declarations.map((artifact) => [artifact.artifact_id, artifact]));
    const artifactDigest = (artifactId: string): string => {
      const artifact = artifactById.get(artifactId);
      if (artifact === undefined) fail("missing-evidence", `stored artifact ${JSON.stringify(artifactId)} is missing`);
      return artifact.digest;
    };

    const providers = identityAttributions
      .map((attribution) => {
        const role = evidenceRole(attribution.role);
        const model = records.runtime.provider_models.find((record) => record.role === role);
        if (model === undefined) fail("missing-evidence", `${role} model record is missing`);
        return {
          role,
          provider: attribution.provider,
          model: model.model,
          principal_id: attribution.principal_id,
          lease_attribution_digest: attribution.lease_attribution_digest,
        };
      })
      .sort((left, right) => left.role.localeCompare(right.role));
    const reviewAttribution = (stage: "local" | "pull-request") => {
      const role = stage === "local" ? "local-reviewer" : "pr-reviewer";
      const attribution = identityAttributions.find((value) => value.role === role);
      if (attribution === undefined) fail("missing-evidence", `${role} attribution is missing`);
      return attribution;
    };

    const repository = input.envelope.payload.repository.repository.toLowerCase();
    const baseSha = input.envelope.payload.repository.base_sha.toLowerCase();
    const number = positiveIntegerField(delivered.payload, "number", "delivered PR number");
    const url = stringField(delivered.payload, "url", "delivered PR URL");
    const headRef = stringField(delivered.payload, "head_ref", "delivered PR head ref");
    const baseRef = stringField(delivered.payload, "base_ref", "delivered PR base ref");
    const observedAt = stringField(delivered.payload, "observed_at", "delivered PR observation time");
    if (
      delivered.payload["repository"]?.toString().toLowerCase() !== repository ||
      delivered.payload["head_sha"] !== candidateSha ||
      delivered.payload["observed_head_sha"] !== candidateSha ||
      baseRef !== input.envelope.payload.repository.base_ref
    ) {
      fail("binding", "delivered PR record contradicts the exact Work Order or candidate");
    }

    const policyBody = canonicalJson(input.effectivePolicy as unknown as JsonValue);
    const workOrderArtifactDigest = artifactDigest("work-order-envelope");
    const policyArtifactDigest = artifactDigest("effective-policy");
    const statement = asfEvidenceStatementSchema.parse({
      _type: IN_TOTO_STATEMENT_V1,
      subject: [
        {
          name: `${input.envelope.payload.repository.forge}:${repository}`,
          digest: { sha1: candidateSha },
        },
      ],
      predicateType: ASF_EVIDENCE_PREDICATE_TYPE,
      predicate: {
        schema: ASF_EVIDENCE_PREDICATE_SCHEMA,
        run: {
          run_id: input.snapshot.run.runId,
          attempt_id: input.snapshot.admission.attemptId,
          work_order_id: input.snapshot.admission.workOrderId,
          completed_at: delivered.occurred_at,
        },
        work_order: {
          envelope_digest: input.snapshot.admission.envelopeDigest,
          payload_digest: input.snapshot.admission.payloadDigest,
          envelope_artifact_digest: workOrderArtifactDigest,
          signature: {
            key_id: input.envelope.key_id,
            algorithm: "EdDSA",
            verified: true,
          },
        },
        policy: {
          effective_policy_digest: input.snapshot.admission.effectivePolicyDigest,
          effective_policy_artifact_digest: policyArtifactDigest,
          inputs: {
            operator_policy_digest: input.effectivePolicy.inputs.operatorPolicy,
            work_order_policy_digest: input.effectivePolicy.inputs.workOrderPolicy,
            repository_policy_digest: input.effectivePolicy.inputs.repositoryPolicy,
            forge_policy_digest: input.effectivePolicy.inputs.forgeProtection,
          },
          required_local_checks: sortedUnique(
            input.effectivePolicy.requiredLocalCheckIds,
            "effective local checks",
          ),
          required_ci_contexts: sortedUnique(
            input.effectivePolicy.requiredRemoteChecks,
            "effective CI contexts",
          ),
          require_local_review: true,
          require_pull_request_review: true,
        },
        source: {
          forge: input.envelope.payload.repository.forge,
          repository,
          base_ref: input.envelope.payload.repository.base_ref,
          base_sha: baseSha,
          candidate_sha: candidateSha,
          remote_head_sha: candidateSha,
          merge_sha: null,
          tree_digest: treeDigest,
          normalized_diff_digest: records.source.normalized_diff_digest,
          normalized_diff_artifact_digest: artifactDigest(
            records.source.normalized_diff_artifact_id,
          ),
          changed_paths: sortedUnique(records.source.changed_paths, "changed paths"),
        },
        runtime: {
          harness_digest: input.effectivePolicy.inputs.harness,
          tool_policy_digest: records.runtime.tool_policy_digest,
          sandbox_profile_digest: records.runtime.sandbox_profile_digest,
          dependency_digest: records.runtime.dependency_digest,
          runtime_digest: records.runtime.runtime_digest,
          runtime_manifest_digest: artifactDigest(
            records.runtime.runtime_manifest_artifact_id,
          ),
          providers,
        },
        role_outcomes: [...records.role_outcomes]
          .sort((left, right) => left.role.localeCompare(right.role))
          .map((outcome) => ({
            role: outcome.role,
            outcome: outcome.outcome,
            candidate_sha: candidateSha,
            evidence_digest: artifactDigest(outcome.artifact_id),
          })),
        verification: {
          local_checks: [...records.local_checks]
            .sort((left, right) => left.check_id.localeCompare(right.check_id))
            .map((check) => ({
              check_id: check.check_id,
              candidate_sha: candidateSha,
              tree_digest: treeDigest,
              command_digest: check.command_digest,
              executor_id: check.executor_id,
              toolchain_digest: check.toolchain_digest,
              sandbox_profile_digest: check.sandbox_profile_digest,
              started_at: check.started_at,
              completed_at: check.completed_at,
              conclusion: check.conclusion,
              coverage: check.coverage,
              evidence_digest: artifactDigest(check.artifact_id),
            })),
          ci_contexts: [...records.ci_contexts]
            .sort((left, right) => left.context.localeCompare(right.context))
            .map((check) => ({
              context: check.context,
              candidate_sha: candidateSha,
              conclusion: check.conclusion,
              observed_at: check.observed_at,
              evidence_digest: artifactDigest(check.artifact_id),
            })),
        },
        reviews: [...records.reviews]
          .sort((left, right) => left.review_id.localeCompare(right.review_id))
          .map((review) => {
            const attribution = reviewAttribution(review.stage);
            return {
              review_id: review.review_id,
              stage: review.stage,
              reviewer_principal: attribution.principal_id,
              reviewer_profile: attribution.profile,
              independent: true,
              candidate_sha: candidateSha,
              policy_digest: input.snapshot.admission.effectivePolicyDigest,
              verdict: review.verdict,
              findings_digest: artifactDigest(review.findings_artifact_id),
              evidence_digest: artifactDigest(review.evidence_artifact_id),
            };
          }),
        side_effects: [...records.side_effects]
          .sort((left, right) => left.effect_key.localeCompare(right.effect_key))
          .map((effect) => ({
            effect_key: effect.effect_key,
            kind: effect.kind,
            candidate_sha: candidateSha,
            intent_digest: effect.intent_digest,
            observation_digest: effect.observation_digest,
            reconciliation_digest: effect.reconciliation_digest,
            confirmation_digest: effect.confirmation_digest,
            status: effect.status,
            evidence_digest: artifactDigest(effect.artifact_id),
          })),
        approvals: [...records.approvals]
          .sort((left, right) => left.approval_id.localeCompare(right.approval_id))
          .map((approval) => ({
            approval_id: approval.approval_id,
            decision_type: approval.decision_type,
            requested_effect: approval.requested_effect,
            approver_subject: approval.approver_subject,
            authority_digest: approval.authority_digest,
            work_order_digest: input.snapshot.admission.payloadDigest,
            candidate_sha: candidateSha,
            policy_digest: input.snapshot.admission.effectivePolicyDigest,
            issued_at: approval.issued_at,
            expires_at: approval.expires_at,
            applied_at: approval.applied_at,
            signature_digest: approval.signature_digest,
            evidence_digest: artifactDigest(approval.artifact_id),
          })),
        cancellation: null,
        budget: {
          ...records.budget,
          stop_reason: "pr-delivered",
        },
        delivery: {
          closure_target: "pr",
          satisfied: true,
          pull_request: {
            forge: input.envelope.payload.repository.forge,
            repository,
            number,
            url,
            head_ref: headRef,
            base_ref: baseRef,
            head_sha: candidateSha,
            observed_at: observedAt,
            evidence_digest: artifactDigest(records.delivery_evidence_artifact_id),
          },
        },
        artifacts: [...declarations].sort((left, right) =>
          left.artifact_id.localeCompare(right.artifact_id),
        ),
      },
    });
    if (policyArtifactDigest !== sha256Digest(JSON.parse(policyBody) as JsonValue)) {
      fail("binding", "stored effective policy artifact digest is contradictory");
    }

    return {
      statement,
      expectations: {
        runId: input.snapshot.run.runId,
        attemptId: input.snapshot.admission.attemptId,
        workOrderId: input.snapshot.admission.workOrderId,
        workOrderEnvelopeDigest: input.snapshot.admission.envelopeDigest,
        workOrderPayloadDigest: input.snapshot.admission.payloadDigest,
        effectivePolicyDigest: input.snapshot.admission.effectivePolicyDigest,
        forge: input.envelope.payload.repository.forge,
        repository,
        baseRef: input.envelope.payload.repository.base_ref,
        baseSha,
        candidateSha,
        treeDigest,
        normalizedDiffDigest: records.source.normalized_diff_digest,
        changedPaths: sortedUnique(records.source.changed_paths, "changed paths"),
        requiredLocalCheckIds: sortedUnique(
          input.effectivePolicy.requiredLocalCheckIds,
          "effective local checks",
        ),
        requiredCiContexts: sortedUnique(
          input.effectivePolicy.requiredRemoteChecks,
          "effective CI contexts",
        ),
        requireLocalReview: true,
        requirePullRequestReview: true,
        pullRequest: { number, url, headRef, baseRef },
      },
    };
  }
}
