import {
  createHash,
  createPublicKey,
  KeyObject,
  verify as verifySignature,
  type KeyLike,
} from "node:crypto";
import type { Clock } from "../platform/clock.js";
import { sha256Digest } from "../asf/canonical-json.js";
import {
  asfEvidenceSigningPayload,
  signedAsfEvidenceBundleSchema,
  type SignedAsfEvidenceBundle,
} from "./asf-bundle.js";

export type AsfEvidenceValidationFailure =
  | "schema"
  | "digest"
  | "trust"
  | "signature"
  | "binding"
  | "missing-evidence";

export class AsfEvidenceValidationError extends Error {
  readonly failure: AsfEvidenceValidationFailure;

  constructor(failure: AsfEvidenceValidationFailure, detail: string) {
    super(`ASF evidence ${failure} validation failed: ${detail}`);
    this.name = "AsfEvidenceValidationError";
    this.failure = failure;
  }
}

export interface TrustedAsfEvidenceSigner {
  readonly keyId: string;
  readonly publicKey: KeyLike;
  /** Inclusive signing-time boundary. */
  readonly validFrom: string;
  /** Exclusive signing-time boundary. */
  readonly validUntil: string;
  /** A revoked signing key is never accepted, including for backdated statements. */
  readonly revokedAt?: string | null | undefined;
}

export interface AsfEvidenceExpectations {
  readonly runId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly workOrderEnvelopeDigest: string;
  readonly workOrderPayloadDigest: string;
  readonly effectivePolicyDigest: string;
  readonly forge: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly treeDigest: string;
  readonly normalizedDiffDigest: string;
  readonly changedPaths: readonly string[];
  readonly requiredLocalCheckIds: readonly string[];
  readonly requiredCiContexts: readonly string[];
  readonly requireLocalReview: boolean;
  readonly requirePullRequestReview: boolean;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly headRef: string;
    readonly baseRef: string;
  };
}

export interface ValidateAsfEvidenceOptions {
  readonly clock: Clock;
  readonly trustedSigners: readonly TrustedAsfEvidenceSigner[];
  readonly expected: AsfEvidenceExpectations;
}

export interface ValidatedAsfEvidenceBundle {
  readonly bundle: SignedAsfEvidenceBundle;
  readonly bundleDigest: string;
  readonly candidateSha: string;
  readonly signer: {
    readonly keyId: string;
    readonly algorithm: "EdDSA";
    readonly verified: true;
  };
}

export interface ArtifactVerifiedAsfEvidenceBundle
  extends ValidatedAsfEvidenceBundle {
  readonly artifacts: {
    readonly verified: true;
    readonly count: number;
    readonly totalBytes: number;
    readonly manifestDigest: string;
  };
}

export interface AsfEvidenceArtifactResolver {
  read(input: {
    readonly locationRef: string;
    readonly expectedDigest: string;
    readonly maxBytes: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<Uint8Array>;
}

function fail(failure: AsfEvidenceValidationFailure, detail: string): never {
  throw new AsfEvidenceValidationError(failure, detail);
}

function parseInstant(value: string, label: string, failure: AsfEvidenceValidationFailure): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(failure, `${label} is not a valid timestamp`);
  return timestamp;
}

function assertEqual(
  actual: string | number,
  expected: string | number,
  label: string,
): void {
  if (actual !== expected) fail("binding", `${label} does not match authoritative input`);
}

function uniqueValues(values: readonly string[], label: string): Set<string> {
  const unique = new Set(values);
  if (unique.size !== values.length) fail("binding", `${label} contains duplicate values`);
  return unique;
}

function assertSameValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualValues = uniqueValues(actual, label);
  const expectedValues = uniqueValues(expected, `authoritative ${label}`);
  if (
    actualValues.size !== expectedValues.size ||
    [...expectedValues].some((value) => !actualValues.has(value))
  ) {
    fail("binding", `${label} does not match authoritative requirements`);
  }
}

function assertUniqueBy(
  values: readonly Record<string, unknown>[],
  field: string,
  label: string,
): void {
  const seen = new Set<unknown>();
  for (const value of values) {
    const key = value[field];
    if (seen.has(key)) fail("binding", `${label} contains duplicate ${field}`);
    seen.add(key);
  }
}

function verifyTrustAndSignature(
  bundle: SignedAsfEvidenceBundle,
  options: ValidateAsfEvidenceOptions,
): void {
  const matchingSigners = options.trustedSigners.filter(
    (signer) => signer.keyId === bundle.key_id,
  );
  if (matchingSigners.length !== 1) {
    fail(
      "trust",
      matchingSigners.length === 0
        ? `signer ${JSON.stringify(bundle.key_id)} is unknown`
        : `signer ${JSON.stringify(bundle.key_id)} has contradictory trust entries`,
    );
  }
  const signer = matchingSigners[0];
  if (signer === undefined) fail("trust", "trusted signer lookup failed");
  if (signer.revokedAt !== undefined && signer.revokedAt !== null) {
    parseInstant(signer.revokedAt, "signer revocation", "trust");
    fail("trust", `signer ${JSON.stringify(bundle.key_id)} is revoked`);
  }

  const issuedAt = parseInstant(bundle.issued_at, "bundle issuance", "schema");
  const validFrom = parseInstant(signer.validFrom, "signer validFrom", "trust");
  const validUntil = parseInstant(signer.validUntil, "signer validUntil", "trust");
  if (validFrom >= validUntil) fail("trust", "signer validity window is contradictory");
  if (issuedAt < validFrom || issuedAt >= validUntil) {
    fail("trust", `signer ${JSON.stringify(bundle.key_id)} was not valid at signing time`);
  }
  if (issuedAt > options.clock.now().getTime()) {
    fail("trust", "bundle issuance is in the future");
  }

  const encoded = bundle.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== encoded
  ) {
    fail("signature", "signature is not canonical Ed25519 base64url");
  }

  try {
    const publicKey =
      signer.publicKey instanceof KeyObject
        ? signer.publicKey
        : createPublicKey(signer.publicKey);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      fail("trust", "trusted evidence signer must be a public Ed25519 key");
    }
    if (
      !verifySignature(
        null,
        Buffer.from(asfEvidenceSigningPayload(bundle), "utf8"),
        publicKey,
        signature,
      )
    ) {
      fail("signature", "Ed25519 signature verification returned false");
    }
  } catch (error) {
    if (error instanceof AsfEvidenceValidationError) throw error;
    fail("signature", "Ed25519 signature verification could not be completed");
  }
}

function verifyArtifactReferences(bundle: SignedAsfEvidenceBundle): void {
  const { predicate } = bundle.statement;
  assertUniqueBy(predicate.artifacts, "artifact_id", "artifact manifest");
  const artifactDigests = new Set<string>();
  for (const artifact of predicate.artifacts) {
    const expectedLocation = `cas://sha256/${artifact.digest.slice("sha256:".length)}`;
    if (artifact.location_ref !== expectedLocation) {
      fail("digest", `artifact ${artifact.artifact_id} location is not content-addressed`);
    }
    artifactDigests.add(artifact.digest);
  }

  const references: { readonly label: string; readonly digest: string }[] = [
    {
      label: "Work Order envelope",
      digest: predicate.work_order.envelope_artifact_digest,
    },
    {
      label: "effective policy",
      digest: predicate.policy.effective_policy_artifact_digest,
    },
    {
      label: "normalized diff",
      digest: predicate.source.normalized_diff_artifact_digest,
    },
    {
      label: "runtime manifest",
      digest: predicate.runtime.runtime_manifest_digest,
    },
    ...predicate.role_outcomes.map((outcome) => ({
      label: `${outcome.role} outcome`,
      digest: outcome.evidence_digest,
    })),
    ...predicate.verification.local_checks.map((check) => ({
      label: `local check ${check.check_id}`,
      digest: check.evidence_digest,
    })),
    ...predicate.verification.ci_contexts.map((check) => ({
      label: `CI context ${check.context}`,
      digest: check.evidence_digest,
    })),
    ...predicate.reviews.flatMap((review) => [
      { label: `review ${review.review_id}`, digest: review.evidence_digest },
      { label: `review findings ${review.review_id}`, digest: review.findings_digest },
    ]),
    ...predicate.side_effects.map((effect) => ({
      label: `side effect ${effect.kind}`,
      digest: effect.evidence_digest,
    })),
    ...predicate.approvals.map((approval) => ({
      label: `approval ${approval.approval_id}`,
      digest: approval.evidence_digest,
    })),
    {
      label: "pull request delivery",
      digest: predicate.delivery.pull_request.evidence_digest,
    },
  ];
  if (predicate.cancellation !== null) {
    references.push({
      label: "cancellation",
      digest: predicate.cancellation.evidence_digest,
    });
  }
  for (const reference of references) {
    if (!artifactDigests.has(reference.digest)) {
      fail(
        "missing-evidence",
        `${reference.label} digest is absent from the artifact manifest`,
      );
    }
  }
}

function verifyBindings(
  bundle: SignedAsfEvidenceBundle,
  options: ValidateAsfEvidenceOptions,
): void {
  const { expected } = options;
  const { statement } = bundle;
  const { predicate } = statement;
  const { source } = predicate;

  assertEqual(predicate.run.run_id, expected.runId, "run id");
  assertEqual(predicate.run.attempt_id, expected.attemptId, "attempt id");
  assertEqual(predicate.run.work_order_id, expected.workOrderId, "Work Order id");
  assertEqual(
    predicate.work_order.envelope_digest,
    expected.workOrderEnvelopeDigest,
    "Work Order envelope digest",
  );
  assertEqual(
    predicate.work_order.payload_digest,
    expected.workOrderPayloadDigest,
    "Work Order payload digest",
  );
  assertEqual(
    predicate.policy.effective_policy_digest,
    expected.effectivePolicyDigest,
    "effective policy digest",
  );
  assertEqual(source.forge, expected.forge, "forge");
  assertEqual(source.repository, expected.repository, "repository");
  assertEqual(source.base_ref, expected.baseRef, "base ref");
  assertEqual(source.base_sha, expected.baseSha, "base SHA");
  assertEqual(source.candidate_sha, expected.candidateSha, "candidate SHA");
  assertEqual(source.remote_head_sha, expected.candidateSha, "remote head SHA");
  assertEqual(source.tree_digest, expected.treeDigest, "candidate tree digest");
  assertEqual(
    source.normalized_diff_digest,
    expected.normalizedDiffDigest,
    "normalized diff digest",
  );
  assertSameValues(source.changed_paths, expected.changedPaths, "changed paths");
  if (source.merge_sha !== null) {
    fail("binding", "PR-only evidence must not claim a merge SHA");
  }

  const subject = statement.subject[0];
  if (subject === undefined) fail("schema", "statement subject is missing");
  assertEqual(subject.name, `${expected.forge}:${expected.repository}`, "statement subject");
  assertEqual(subject.digest.sha1, expected.candidateSha, "statement subject digest");

  assertSameValues(
    predicate.policy.required_local_checks,
    expected.requiredLocalCheckIds,
    "required local checks",
  );
  assertSameValues(
    predicate.policy.required_ci_contexts,
    expected.requiredCiContexts,
    "required CI contexts",
  );
  if (predicate.policy.require_local_review !== expected.requireLocalReview) {
    fail("binding", "local review requirement does not match authoritative policy");
  }
  if (
    predicate.policy.require_pull_request_review !==
    expected.requirePullRequestReview
  ) {
    fail("binding", "pull-request review requirement does not match authoritative policy");
  }

  const delivery = predicate.delivery.pull_request;
  assertEqual(delivery.forge, expected.forge, "pull request forge");
  assertEqual(delivery.repository, expected.repository, "pull request repository");
  assertEqual(delivery.number, expected.pullRequest.number, "pull request number");
  assertEqual(delivery.url, expected.pullRequest.url, "pull request URL");
  assertEqual(delivery.head_ref, expected.pullRequest.headRef, "pull request head ref");
  assertEqual(delivery.base_ref, expected.pullRequest.baseRef, "pull request base ref");
  assertEqual(delivery.base_ref, expected.baseRef, "source and pull request base ref");
  assertEqual(delivery.head_sha, expected.candidateSha, "pull request head SHA");
  if (predicate.cancellation !== null) {
    fail("binding", "a cancelled run cannot claim PR delivery satisfaction");
  }

  assertUniqueBy(predicate.runtime.providers, "role", "provider attributions");
  for (const role of [
    "implementer",
    "local-reviewer",
    "pull-request-reviewer",
  ] as const) {
    if (!predicate.runtime.providers.some((provider) => provider.role === role)) {
      fail("missing-evidence", `${role} provider attribution is missing`);
    }
  }

  assertUniqueBy(predicate.verification.local_checks, "check_id", "local checks");
  const localChecks = new Map(
    predicate.verification.local_checks.map((check) => [check.check_id, check]),
  );
  for (const check of predicate.verification.local_checks) {
    assertEqual(check.candidate_sha, expected.candidateSha, `local check ${check.check_id} candidate`);
    assertEqual(check.tree_digest, expected.treeDigest, `local check ${check.check_id} tree`);
    if (check.conclusion !== "success" || check.coverage !== "complete") {
      fail("missing-evidence", `local check ${check.check_id} is not a complete success`);
    }
    if (Date.parse(check.started_at) > Date.parse(check.completed_at)) {
      fail("binding", `local check ${check.check_id} timestamps are contradictory`);
    }
  }
  for (const checkId of expected.requiredLocalCheckIds) {
    if (!localChecks.has(checkId)) {
      fail("missing-evidence", `required local check ${checkId} is missing`);
    }
  }

  assertUniqueBy(predicate.verification.ci_contexts, "context", "CI contexts");
  const ciContexts = new Map(
    predicate.verification.ci_contexts.map((check) => [check.context, check]),
  );
  for (const check of predicate.verification.ci_contexts) {
    assertEqual(check.candidate_sha, expected.candidateSha, `CI context ${check.context} candidate`);
    if (check.conclusion !== "success") {
      fail("missing-evidence", `CI context ${check.context} is not a non-skipped success`);
    }
  }
  for (const context of expected.requiredCiContexts) {
    if (!ciContexts.has(context)) {
      fail("missing-evidence", `required CI context ${context} is missing`);
    }
  }

  assertUniqueBy(predicate.reviews, "review_id", "reviews");
  for (const review of predicate.reviews) {
    assertEqual(review.candidate_sha, expected.candidateSha, `review ${review.review_id} candidate`);
    assertEqual(
      review.policy_digest,
      expected.effectivePolicyDigest,
      `review ${review.review_id} policy`,
    );
    if (review.verdict !== "pass") {
      fail("missing-evidence", `review ${review.review_id} did not pass`);
    }
  }
  if (
    expected.requireLocalReview &&
    !predicate.reviews.some((review) => review.stage === "local")
  ) {
    fail("missing-evidence", "required independent local review is missing");
  }
  if (
    expected.requirePullRequestReview &&
    !predicate.reviews.some((review) => review.stage === "pull-request")
  ) {
    fail("missing-evidence", "required independent pull-request review is missing");
  }

  assertUniqueBy(predicate.side_effects, "effect_key", "side effects");
  for (const effect of predicate.side_effects) {
    assertEqual(effect.candidate_sha, expected.candidateSha, `side effect ${effect.kind} candidate`);
  }
  for (const requiredKind of ["branch.push", "pull-request.create"] as const) {
    if (!predicate.side_effects.some((effect) => effect.kind === requiredKind)) {
      fail("missing-evidence", `confirmed ${requiredKind} evidence is missing`);
    }
  }

  assertUniqueBy(predicate.role_outcomes, "role", "role outcomes");
  for (const outcome of predicate.role_outcomes) {
    assertEqual(outcome.candidate_sha, expected.candidateSha, `${outcome.role} outcome candidate`);
  }
  if (!predicate.role_outcomes.some((outcome) => outcome.role === "implementer")) {
    fail("missing-evidence", "implementer outcome is missing");
  }
  if (
    expected.requireLocalReview &&
    !predicate.role_outcomes.some(
      (outcome) => outcome.role === "local-reviewer" && outcome.outcome === "passed",
    )
  ) {
    fail("missing-evidence", "local reviewer outcome is missing or did not pass");
  }
  if (
    expected.requirePullRequestReview &&
    !predicate.role_outcomes.some(
      (outcome) =>
        outcome.role === "pull-request-reviewer" && outcome.outcome === "passed",
    )
  ) {
    fail("missing-evidence", "pull-request reviewer outcome is missing or did not pass");
  }

  const completedAt = parseInstant(predicate.run.completed_at, "run completion", "binding");
  for (const approval of predicate.approvals) {
    assertEqual(approval.work_order_digest, expected.workOrderPayloadDigest, "approval Work Order");
    assertEqual(approval.candidate_sha, expected.candidateSha, "approval candidate");
    assertEqual(approval.policy_digest, expected.effectivePolicyDigest, "approval policy");
    const issuedAt = parseInstant(approval.issued_at, "approval issuance", "binding");
    const expiresAt = parseInstant(approval.expires_at, "approval expiration", "binding");
    const appliedAt = parseInstant(approval.applied_at, "approval application", "binding");
    if (
      issuedAt > appliedAt ||
      appliedAt >= expiresAt ||
      appliedAt > completedAt
    ) {
      fail(
        "missing-evidence",
        `approval ${approval.approval_id} was not valid when its authority was applied`,
      );
    }
  }

  const bundleIssuedAt = parseInstant(bundle.issued_at, "bundle issuance", "binding");
  if (bundleIssuedAt < completedAt) {
    fail("binding", "bundle was issued before the run completed");
  }
}

/**
 * Independently validate portable ASF evidence using trusted key metadata and
 * controller-observed candidate/delivery facts, never narrative assertions.
 */
export function validateSignedAsfEvidenceBundle(
  raw: unknown,
  options: ValidateAsfEvidenceOptions,
): ValidatedAsfEvidenceBundle {
  const parsed = signedAsfEvidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    fail("schema", details);
  }
  const bundle = parsed.data;
  const computedDigest = sha256Digest(bundle.statement);
  if (bundle.bundle_digest !== computedDigest) {
    fail("digest", "bundle digest does not match the canonical statement");
  }

  verifyTrustAndSignature(bundle, options);
  verifyBindings(bundle, options);
  verifyArtifactReferences(bundle);
  return {
    bundle,
    bundleDigest: computedDigest,
    candidateSha: bundle.statement.predicate.source.candidate_sha,
    signer: {
      keyId: bundle.key_id,
      algorithm: "EdDSA",
      verified: true,
    },
  };
}

/**
 * Re-hash every referenced artifact body before evidence can be finalized.
 * A content-addressed URI alone is not proof that the resolver returned those
 * bytes, so the durable store accepts only this stronger result type.
 */
export async function verifyAsfEvidenceArtifactContents(
  validated: ValidatedAsfEvidenceBundle,
  options: {
    readonly resolver: AsfEvidenceArtifactResolver;
    readonly maxArtifactBytes: number;
    readonly maxTotalBytes: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<ArtifactVerifiedAsfEvidenceBundle> {
  for (const [label, value] of [
    ["maximum artifact bytes", options.maxArtifactBytes],
    ["maximum total artifact bytes", options.maxTotalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail("schema", `${label} must be a positive safe integer`);
    }
  }
  let totalBytes = 0;
  for (const artifact of validated.bundle.statement.predicate.artifacts) {
    if (options.signal?.aborted === true) {
      fail("missing-evidence", "artifact verification was cancelled");
    }
    if (artifact.size_bytes > options.maxArtifactBytes) {
      fail("missing-evidence", `artifact ${artifact.artifact_id} exceeds the verification limit`);
    }
    if (totalBytes + artifact.size_bytes > options.maxTotalBytes) {
      fail("missing-evidence", "artifact manifest exceeds the total verification limit");
    }
    let bytes: Uint8Array;
    try {
      bytes = await options.resolver.read({
        locationRef: artifact.location_ref,
        expectedDigest: artifact.digest,
        maxBytes: options.maxArtifactBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      fail("missing-evidence", `artifact ${artifact.artifact_id} could not be resolved`);
    }
    if (!(bytes instanceof Uint8Array)) {
      fail("missing-evidence", `artifact ${artifact.artifact_id} resolver returned invalid bytes`);
    }
    if (bytes.byteLength !== artifact.size_bytes) {
      fail("digest", `artifact ${artifact.artifact_id} size does not match its manifest`);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== artifact.digest) {
      fail("digest", `artifact ${artifact.artifact_id} body does not match its digest`);
    }
    totalBytes += bytes.byteLength;
  }
  return {
    ...validated,
    artifacts: {
      verified: true,
      count: validated.bundle.statement.predicate.artifacts.length,
      totalBytes,
      manifestDigest: sha256Digest(validated.bundle.statement.predicate.artifacts),
    },
  };
}
