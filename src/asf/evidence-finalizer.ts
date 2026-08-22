import type { Clock } from "../platform/clock.js";
import type { AsfDurableRunSnapshot } from "../state/store.js";
import {
  asfEvidenceStatementSchema,
  signAsfEvidenceBundle,
  type AsfEvidenceStatement,
} from "../evidence/asf-bundle.js";
import {
  AsfEvidenceValidationError,
  validateSignedAsfEvidenceBundle,
  verifyAsfEvidenceArtifactContents,
  type ArtifactVerifiedAsfEvidenceBundle,
  type AsfEvidenceArtifactResolver,
  type AsfEvidenceExpectations,
} from "../evidence/asf-validator.js";
import type {
  AsfDeliveryBinding,
  AsfDeliveryStageIntent,
  AsfEvidenceFinalizationController,
} from "./delivery-runner.js";
import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";
import {
  assertRunEventTransition,
  parseRunEvent,
  type RunEvent,
  type RunEventPhase,
} from "./run-event.js";
import {
  evaluateEffectivePathScope,
  parseWorkOrderEnvelope,
  type EffectiveAsfPolicy,
  type WorkOrderEnvelope,
} from "./work-order.js";
import type { AsfEvidenceSigningKey } from "./evidence-signing-config.js";
import {
  asfIdentityLeaseAttributionSchema,
  assertIdentityLeaseAttribution,
  identityAttributionsDigest,
  type AsfIdentityLeaseAttribution,
} from "./identity-attribution.js";

export interface AsfEvidenceFinalizationMaterial {
  /** Statement assembled from durable controller evidence, not agent prose. */
  readonly statement: unknown;
  /**
   * Expectations independently assembled from authoritative state, checkpoint,
   * forge, and CAS records. They must not be copied out of `statement`.
   */
  readonly expectations: AsfEvidenceExpectations;
}

export interface AsfEvidenceMaterialRequest {
  readonly binding: AsfDeliveryBinding;
  readonly intent: AsfDeliveryStageIntent;
  readonly intentMode: "observe-before-apply" | "reconcile-only";
  readonly snapshot: AsfDurableRunSnapshot;
  readonly envelope: WorkOrderEnvelope;
  readonly effectivePolicy: EffectiveAsfPolicy;
  readonly events: readonly RunEvent[];
  readonly signal: AbortSignal;
}

/**
 * Production compositions implement this boundary over durable checkpoints,
 * effect observations, identity records, budget ledgers, and a CAS. The source
 * is read-only: signing and the decision to accept evidence stay here.
 */
export interface AsfEvidenceFinalizationMaterialSource {
  assemble(input: AsfEvidenceMaterialRequest): Promise<AsfEvidenceFinalizationMaterial>;
}

export interface ProductionAsfEvidenceFinalizationControllerOptions {
  readonly materialSource: AsfEvidenceFinalizationMaterialSource;
  readonly artifactResolver: AsfEvidenceArtifactResolver;
  readonly signingKey: AsfEvidenceSigningKey;
  readonly clock: Clock;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytes: number;
}

type FinalizationInput = Parameters<AsfEvidenceFinalizationController["finalize"]>[0];

interface AuthoritativeEvidenceFacts {
  readonly request: AsfEvidenceMaterialRequest;
  readonly candidateSha: string;
  readonly treeDigest: string;
  readonly completedAt: string;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly headRef: string;
    readonly baseRef: string;
  };
  readonly verificationEvidence: ReadonlyMap<string, string>;
  readonly ciEvidence: ReadonlyMap<string, string>;
  readonly reviewFindings: {
    readonly local: string;
    readonly pullRequest: string;
  };
  readonly identityAttributions: readonly AsfIdentityLeaseAttribution[];
}

function fail(failure: "schema" | "binding" | "missing-evidence", detail: string): never {
  throw new AsfEvidenceValidationError(failure, detail);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    fail("missing-evidence", `${label} is missing`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("missing-evidence", `${label} is missing or invalid`);
  }
  return value as number;
}

function parseDurableEvents(rawEvents: readonly RunEvent[]): readonly RunEvent[] {
  try {
    return rawEvents.map((event) => parseRunEvent(structuredClone(event)));
  } catch {
    return fail("schema", "durable event history contains an invalid authority-bearing event");
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail("binding", `${label} does not match authoritative durable state`);
  }
}

function assertSameValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualValues = new Set(actual);
  const expectedValues = new Set(expected);
  if (
    actualValues.size !== actual.length ||
    expectedValues.size !== expected.length ||
    actualValues.size !== expectedValues.size ||
    [...expectedValues].some((value) => !actualValues.has(value))
  ) {
    fail("binding", `${label} does not match authoritative durable state`);
  }
}

function latestEvent(
  events: readonly RunEvent[],
  type: string,
  candidateSha?: string,
): RunEvent {
  const event = events
    .filter(
      (candidate) =>
        candidate.type === type &&
        (candidateSha === undefined || candidate.payload["candidate_sha"] === candidateSha),
    )
    .at(-1);
  if (event === undefined) fail("missing-evidence", `durable ${type} event is missing`);
  return event;
}

function exactEventMap(
  events: readonly RunEvent[],
  type: string,
  candidateSha: string,
  key: string,
  value: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    if (event.type !== type || event.payload["candidate_sha"] !== candidateSha) continue;
    const itemKey = asString(event.payload[key], `${type} ${key}`);
    const itemValue = asString(event.payload[value], `${type} ${value}`);
    if (result.has(itemKey)) {
      fail("binding", `${type} contains duplicate ${key} evidence for the current candidate`);
    }
    result.set(itemKey, itemValue);
  }
  return result;
}

function exactPassedCiEvidence(
  rawChecks: unknown,
  requiredContexts: readonly string[],
  label: string,
): {
  readonly checks: readonly {
    readonly context: string;
    readonly outcome: "passed";
    readonly evidence_digest: string;
  }[];
  readonly evidence: ReadonlyMap<string, string>;
} {
  if (!Array.isArray(rawChecks)) {
    fail("missing-evidence", `${label} context evidence is missing`);
  }
  const checks: Array<{
    readonly context: string;
    readonly outcome: "passed";
    readonly evidence_digest: string;
  }> = [];
  const evidence = new Map<string, string>();
  for (const rawCheck of rawChecks) {
    if (
      typeof rawCheck !== "object" ||
      rawCheck === null ||
      Array.isArray(rawCheck)
    ) {
      fail("schema", `${label} context evidence is malformed`);
    }
    const check = rawCheck as Record<string, unknown>;
    const context = asString(check["context"], `${label} context`);
    const evidenceDigest = asString(
      check["evidence_digest"],
      `${label} evidence digest`,
    );
    if (
      check["outcome"] !== "passed" ||
      !/^sha256:[a-f0-9]{64}$/u.test(evidenceDigest) ||
      evidence.has(context)
    ) {
      fail(
        "missing-evidence",
        `${label} context ${JSON.stringify(context)} is not uniquely passing`,
      );
    }
    checks.push({ context, outcome: "passed", evidence_digest: evidenceDigest });
    evidence.set(context, evidenceDigest);
  }
  assertSameValues([...evidence.keys()], requiredContexts, `${label} required contexts`);
  return { checks, evidence };
}

function assertIntent(
  input: FinalizationInput,
  snapshot: AsfDurableRunSnapshot,
  candidateSha: string,
): void {
  const { binding, intent } = input;
  const validIntentGeneration =
    input.intentMode === "observe-before-apply"
      ? intent.fencing_generation === binding.fencingGeneration
      : intent.fencing_generation <= binding.fencingGeneration;
  if (
    binding.runId !== snapshot.run.runId ||
    binding.workOrderId !== snapshot.admission.workOrderId ||
    binding.attemptId !== snapshot.admission.attemptId ||
    binding.policyDigest !== snapshot.admission.effectivePolicyDigest ||
    binding.fencingGeneration !== snapshot.run.generation ||
    binding.candidateSha !== candidateSha ||
    intent.schema !== "asf.delivery-stage-intent/v1" ||
    intent.stage !== "evidence" ||
    intent.run_id !== binding.runId ||
    intent.work_order_id !== binding.workOrderId ||
    intent.attempt_id !== binding.attemptId ||
    intent.policy_digest !== binding.policyDigest ||
    !validIntentGeneration ||
    intent.candidate_sha !== candidateSha ||
    intent.event_seq !== snapshot.latestSequence ||
    intent.intent_digest !== sha256Digest({
      attempt_id: intent.attempt_id,
      candidate_sha: intent.candidate_sha,
      created_at: intent.created_at,
      effect_key: intent.effect_key,
      event_seq: intent.event_seq,
      fencing_generation: intent.fencing_generation,
      intent_id: intent.intent_id,
      operation_digest: intent.operation_digest,
      policy_digest: intent.policy_digest,
      run_id: intent.run_id,
      schema: intent.schema,
      stage: intent.stage,
      work_order_id: intent.work_order_id,
    })
  ) {
    fail("binding", "evidence intent is stale, malformed, or bound to another run generation");
  }
}

function assertAdmission(
  input: FinalizationInput,
): {
  readonly snapshot: AsfDurableRunSnapshot;
  readonly envelope: WorkOrderEnvelope;
  readonly policy: EffectiveAsfPolicy;
  readonly candidateSha: string;
} {
  const snapshot = structuredClone(input.snapshot);
  const envelope = parseWorkOrderEnvelope(structuredClone(input.envelope));
  const policy = structuredClone(input.effectivePolicy);
  const candidateSha = snapshot.run.candidateSha;
  if (
    snapshot.run.mode !== "asf-worker" ||
    snapshot.run.state !== "PR_DELIVERED" ||
    snapshot.run.stateVersion !== snapshot.latestSequence ||
    snapshot.run.ownerId === null ||
    candidateSha === null ||
    !/^[a-f0-9]{40}$/u.test(candidateSha)
  ) {
    fail("binding", "evidence finalization requires an owned exact-candidate PR_DELIVERED snapshot");
  }
  if (
    snapshot.run.workOrderId !== snapshot.admission.workOrderId ||
    snapshot.run.attemptId !== snapshot.admission.attemptId ||
    envelope.payload.work_order_id !== snapshot.admission.workOrderId ||
    envelope.payload.attempt_id !== snapshot.admission.attemptId ||
    envelope.payload.tenant_id !== snapshot.admission.tenantId ||
    canonicalJson(envelope) !== snapshot.admission.canonicalEnvelope ||
    sha256Digest(envelope) !== snapshot.admission.envelopeDigest ||
    sha256Digest(envelope.payload) !== snapshot.admission.payloadDigest ||
    envelope.key_id !== snapshot.admission.signatureKeyId ||
    envelope.algorithm !== snapshot.admission.signatureAlgorithm ||
    envelope.payload.repository.repository.toLowerCase() !== snapshot.run.repo.toLowerCase() ||
    envelope.payload.repository.base_sha.toLowerCase() !== snapshot.run.baseCommit
  ) {
    fail("binding", "Work Order admission snapshot is contradictory or not canonical");
  }
  const { digest: policyDigest, ...unsignedPolicy } = policy;
  if (
    policy.schema !== "runmill.effective-policy/v1" ||
    policyDigest !== snapshot.admission.effectivePolicyDigest ||
    sha256Digest(unsignedPolicy as unknown as JsonValue) !== policyDigest ||
    canonicalJson(policy as unknown as JsonValue) !== snapshot.admission.effectivePolicy ||
    policy.inputs.workOrderPayload !== snapshot.admission.payloadDigest ||
    policy.inputs.workOrderPolicy !== envelope.payload.policy_digest ||
    policy.inputs.harness !== envelope.payload.harness_digest ||
    policy.inputs.observedBaseSha !== envelope.payload.repository.base_sha.toLowerCase() ||
    policy.inputs.repositoryPolicyBaseSha !== envelope.payload.repository.base_sha.toLowerCase() ||
    policy.inputs.forgeProtectionBaseRef !== envelope.payload.repository.base_ref ||
    policy.runtime.sandboxProfile !== envelope.payload.runtime.sandbox_profile ||
    policy.runtime.toolPolicy !== envelope.payload.runtime.tool_policy ||
    policy.runtime.networkPolicy !== envelope.payload.runtime.network_policy ||
    policy.identities.implementer !== envelope.payload.identities.implementer ||
    policy.identities.localReviewer !== envelope.payload.identities.local_reviewer ||
    policy.identities.prReviewer !== envelope.payload.identities.pr_reviewer ||
    policy.delivery.closureTarget !== "pr"
  ) {
    fail("binding", "effective policy is stale or contradicts immutable admission inputs");
  }
  for (const checkId of envelope.payload.verification.required_local_check_ids) {
    if (!policy.requiredLocalCheckIds.includes(checkId)) {
      fail("binding", `effective policy dropped required local check ${JSON.stringify(checkId)}`);
    }
  }
  for (const context of envelope.payload.verification.required_remote_checks) {
    if (!policy.requiredRemoteChecks.includes(context)) {
      fail("binding", `effective policy dropped required CI context ${JSON.stringify(context)}`);
    }
  }
  assertIntent(input, snapshot, candidateSha);
  return { snapshot, envelope, policy, candidateSha };
}

function assertEvents(
  snapshot: AsfDurableRunSnapshot,
  envelope: WorkOrderEnvelope,
  policy: EffectiveAsfPolicy,
  candidateSha: string,
  rawEvents: readonly RunEvent[],
  intentCreatedAt: string,
  now: number,
): Omit<AuthoritativeEvidenceFacts, "request"> {
  if (rawEvents.length !== snapshot.latestSequence || rawEvents.length === 0) {
    fail("missing-evidence", "complete uncompacted durable event history is required");
  }
  const events = parseDurableEvents(rawEvents);
  let priorPhase: RunEventPhase = "RECEIVED";
  let priorTime = Number.NEGATIVE_INFINITY;
  for (const [index, event] of events.entries()) {
    if (
      event.seq !== index + 1 ||
      event.run_id !== snapshot.run.runId ||
      event.work_order_id !== snapshot.admission.workOrderId ||
      event.attempt_id !== snapshot.admission.attemptId ||
      event.policy_digest !== snapshot.admission.effectivePolicyDigest
    ) {
      fail("binding", "durable event history contains a gap or foreign binding");
    }
    try {
      assertRunEventTransition(priorPhase, event);
    } catch {
      fail("binding", "durable event history contains an invalid lifecycle transition");
    }
    priorPhase = event.phase;
    const occurredAt = Date.parse(event.occurred_at);
    if (!Number.isFinite(occurredAt) || occurredAt < priorTime || occurredAt > now) {
      fail("binding", "durable event chronology is invalid or in the future");
    }
    priorTime = occurredAt;
  }
  if (priorPhase !== snapshot.run.state) {
    fail("binding", "durable event history does not end at the current snapshot phase");
  }
  const intentTime = Date.parse(intentCreatedAt);
  if (!Number.isFinite(intentTime) || intentTime < priorTime || intentTime > now) {
    fail("binding", "evidence intent timestamp does not follow the delivered event history");
  }

  const admitted = latestEvent(events, "work_order.admitted");
  if (
    admitted.seq !== 1 ||
    admitted.payload["work_order_id"] !== snapshot.admission.workOrderId ||
    admitted.payload["attempt_id"] !== snapshot.admission.attemptId ||
    admitted.payload["tenant_id"] !== snapshot.admission.tenantId ||
    admitted.payload["payload_digest"] !== snapshot.admission.payloadDigest ||
    admitted.payload["envelope_digest"] !== snapshot.admission.envelopeDigest
  ) {
    fail("binding", "Work Order admission event contradicts its immutable snapshot");
  }
  const admittedSignature = admitted.payload["signature"] as
    | Record<string, unknown>
    | undefined;
  if (
    admittedSignature?.["verified"] !== true ||
    admittedSignature["key_id"] !== snapshot.admission.signatureKeyId ||
    admittedSignature["algorithm"] !== snapshot.admission.signatureAlgorithm
  ) {
    fail("binding", "Work Order signature verification event is missing or contradictory");
  }

  const identity = latestEvent(events, "identity.leases_acquired");
  const rawAttributions = identity.payload["attributions"];
  if (!Array.isArray(rawAttributions) || rawAttributions.length !== 3) {
    fail("missing-evidence", "durable identity attribution set is missing");
  }
  const identityAttributions = rawAttributions.map((raw) => {
    const parsed = asfIdentityLeaseAttributionSchema.safeParse(raw);
    if (!parsed.success) fail("schema", "durable identity attribution is malformed");
    try {
      return assertIdentityLeaseAttribution(
        {
          run_id: identity.run_id,
          work_order_id: identity.work_order_id,
          attempt_id: identity.attempt_id,
          policy_digest: identity.policy_digest,
          fencing_generation: parsed.data.fencing_generation,
          candidate_sha: null,
        },
        parsed.data,
      );
    } catch {
      return fail("binding", "durable identity attribution digest is contradictory");
    }
  });
  const identityRoles = identityAttributions.map((attribution) => attribution.role);
  const declaredRoles = identity.payload["roles"];
  if (
    !Array.isArray(declaredRoles) ||
    new Set(identityRoles).size !== 3 ||
    !["implementer", "local-reviewer", "pr-reviewer"].every(
      (role) => identityRoles.includes(role as (typeof identityRoles)[number]),
    ) ||
    declaredRoles.length !== identityRoles.length ||
    declaredRoles.some((role, index) => role !== identityRoles[index]) ||
    identity.payload["attributions_digest"] !==
      identityAttributionsDigest(identityAttributions) ||
    identityAttributions.some(
      (attribution) =>
        Date.parse(attribution.issued_at) > Date.parse(identity.occurred_at) ||
        Date.parse(attribution.expires_at) <= Date.parse(identity.occurred_at),
    )
  ) {
    fail("binding", "durable identity attribution set is incomplete or contradictory");
  }

  const candidate = latestEvent(events, "candidate.created", candidateSha);
  const treeDigest = asString(candidate.payload["tree_digest"], "candidate tree digest");
  for (const event of events.slice(candidate.seq)) {
    const eventCandidate = event.payload["candidate_sha"];
    if (eventCandidate !== undefined && eventCandidate !== candidateSha) {
      fail("binding", "post-candidate event history contains stale candidate evidence");
    }
  }

  const verificationEvidence = exactEventMap(
    events.slice(candidate.seq),
    "verification.completed",
    candidateSha,
    "check_id",
    "evidence_digest",
  );
  assertSameValues([...verificationEvidence.keys()], policy.requiredLocalCheckIds, "local checks");
  for (const event of events) {
    if (
      event.type === "verification.completed" &&
      event.payload["candidate_sha"] === candidateSha &&
      event.payload["outcome"] !== "passed"
    ) {
      fail("missing-evidence", "current candidate has a non-passing local verification result");
    }
  }

  const localReview = latestEvent(events, "review.completed", candidateSha);
  const pullRequestReview = latestEvent(events, "pr_review.completed", candidateSha);
  if (
    localReview.payload["outcome"] !== "approved" ||
    pullRequestReview.payload["outcome"] !== "approved"
  ) {
    fail("missing-evidence", "current candidate lacks both approved independent review events");
  }

  const branch = latestEvent(events, "branch.pushed", candidateSha);
  const opened = latestEvent(events, "pull_request.opened", candidateSha);
  const ciWaiting = latestEvent(events, "ci.waiting", candidateSha);
  const ci = latestEvent(events, "ci.completed", candidateSha);
  const delivered = latestEvent(events, "pull_request.delivered", candidateSha);
  const initialCi = exactPassedCiEvidence(
    ci.payload["checks"],
    policy.requiredRemoteChecks,
    "initial CI",
  );
  const initialCiObservedAtText = asString(
    ci.payload["observed_at"],
    "initial CI observation time",
  );
  const initialCiObservedAt = Date.parse(initialCiObservedAtText);
  if (
    ci.payload["outcome"] !== "passed" ||
    ci.payload["checks_digest"] !==
      sha256Digest(initialCi.checks) ||
    initialCiObservedAt < Date.parse(ciWaiting.occurred_at) ||
    initialCiObservedAt > Date.parse(ci.occurred_at) ||
    Date.parse(ci.occurred_at) > Date.parse(pullRequestReview.occurred_at)
  ) {
    fail(
      "binding",
      "initial exact-head CI gate is stale, contradictory, or later than fresh review",
    );
  }
  const headRef = asString(branch.payload["remote_ref"], "pushed head ref");
  const number = asNumber(opened.payload["number"], "pull request number");
  const url = asString(opened.payload["url"], "pull request URL");
  const deliveredRepository = asString(
    delivered.payload["repository"],
    "final PR repository",
  ).toLowerCase();
  const deliveredHeadRef = asString(delivered.payload["head_ref"], "final PR head ref");
  const deliveredBaseRef = asString(delivered.payload["base_ref"], "final PR base ref");
  const deliveredMarker = asString(delivered.payload["marker"], "final PR marker");
  const collisionSetDigest = asString(
    delivered.payload["collision_set_digest"],
    "final PR collision-set digest",
  );
  const baseObservationDigest = asString(
    delivered.payload["base_observation_digest"],
    "final base observation digest",
  );
  const protectionDigest = asString(
    delivered.payload["protection_digest"],
    "final protection digest",
  );
  const observationIntentDigest = asString(
    delivered.payload["delivery_observation_intent_digest"],
    "final PR observation intent digest",
  );
  const observationDigest = asString(
    delivered.payload["delivery_observation_digest"],
    "final PR observation digest",
  );
  const finalCiObservationIntentDigest = asString(
    delivered.payload["final_ci_observation_intent_digest"],
    "final CI observation intent digest",
  );
  const finalCiObservationDigest = asString(
    delivered.payload["final_ci_observation_digest"],
    "final CI observation digest",
  );
  const finalCiChecksDigest = asString(
    delivered.payload["final_ci_checks_digest"],
    "final CI checks digest",
  );
  const finalCiObservedAtText = asString(
    delivered.payload["final_ci_observed_at"],
    "final CI observation time",
  );
  const finalCiObservedAt = Date.parse(finalCiObservedAtText);
  const finalCiFencingGeneration = asNumber(
    delivered.payload["final_ci_observation_fencing_generation"],
    "final CI observation fencing generation",
  );
  const finalCi = exactPassedCiEvidence(
    delivered.payload["final_ci_checks"],
    policy.requiredRemoteChecks,
    "final CI",
  );
  const finalCiEvent = events.find((candidate) => candidate.seq === delivered.seq - 1);
  const finalCiEventChecks = finalCiEvent?.payload["checks"];
  const rawProtection = delivered.payload["protection"] as unknown as {
    readonly required_checks: readonly string[];
    readonly requires_approval: boolean;
    readonly requires_conversation_resolution: boolean;
    readonly uses_merge_queue: boolean;
  };
  const protection = {
    required_checks: [...rawProtection.required_checks],
    requires_approval: rawProtection.requires_approval,
    requires_conversation_resolution: rawProtection.requires_conversation_resolution,
    uses_merge_queue: rawProtection.uses_merge_queue,
  };
  const deliveredDraft = delivered.payload["draft"];
  if (typeof deliveredDraft !== "boolean") {
    fail("schema", "final PR draft evidence is malformed");
  }
  const observedAtText = asString(
    delivered.payload["observed_at"],
    "final PR observation time",
  );
  const finalObservedAt = Date.parse(
    observedAtText,
  );
  const expectedProtectionDigest = sha256Digest({
    schema: "runmill.github-base-protection/v1",
    repository: deliveredRepository,
    base_ref: deliveredBaseRef,
    protection,
  });
  const expectedObservationDigest = sha256Digest({
    schema: "asf.github-final-pr-delivery-observation/v1",
    repository: deliveredRepository,
    pull_request_number: number,
    url,
    head_ref: deliveredHeadRef,
    base_ref: deliveredBaseRef,
    marker: deliveredMarker,
    head_sha: candidateSha,
    current_base_sha: policy.inputs.observedBaseSha,
    collision_set_digest: collisionSetDigest,
    base_observation_digest: baseObservationDigest,
    protection_digest: protectionDigest,
    protection,
    observed_at: observedAtText,
    state: "open",
    draft: deliveredDraft,
  });
  const expectedFinalCiObservationDigest = sha256Digest({
    schema: "asf.ci-head-observation/v1",
    binding: {
      run_id: snapshot.run.runId,
      work_order_id: snapshot.admission.workOrderId,
      attempt_id: snapshot.admission.attemptId,
      policy_digest: snapshot.admission.effectivePolicyDigest,
      fencing_generation: finalCiFencingGeneration,
      candidate_sha: candidateSha,
    },
    repository: deliveredRepository,
    pull_request_number: number,
    candidate_sha: candidateSha,
    observed_head_sha: candidateSha,
    observed_at: finalCiObservedAtText,
    checks: finalCi.checks,
  });
  if (
    branch.payload["observed_remote_sha"] !== candidateSha ||
    opened.payload["repository"]?.toString().toLowerCase() !== snapshot.run.repo.toLowerCase() ||
    opened.payload["observed_head_sha"] !== candidateSha ||
    opened.payload["base_sha"] !== envelope.payload.repository.base_sha.toLowerCase() ||
    deliveredRepository !== snapshot.run.repo.toLowerCase() ||
    delivered.payload["number"] !== number ||
    delivered.payload["url"] !== url ||
    deliveredHeadRef !== headRef ||
    deliveredBaseRef !== envelope.payload.repository.base_ref ||
    delivered.payload["head_sha"] !== candidateSha ||
    delivered.payload["observed_head_sha"] !== candidateSha ||
    delivered.payload["current_base_sha"] !== policy.inputs.observedBaseSha ||
    protectionDigest !== policy.inputs.forgeProtection ||
    protectionDigest !== expectedProtectionDigest ||
    protection.required_checks.length !== new Set(protection.required_checks).size ||
    protection.required_checks.some(
      (context) => !policy.requiredRemoteChecks.includes(context),
    ) ||
    delivered.payload["state"] !== "open" ||
    deliveredDraft !== policy.delivery.draftPr ||
    observationDigest !== expectedObservationDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(observationIntentDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(finalCiObservationIntentDigest) ||
    finalCiObservationIntentDigest === observationIntentDigest ||
    finalCiObservationDigest !== expectedFinalCiObservationDigest ||
    finalCiChecksDigest !==
      sha256Digest(finalCi.checks) ||
    finalCiFencingGeneration > snapshot.run.generation ||
    finalCiEvent?.type !== "ci.revalidated" ||
    finalCiEvent.phase !== "PR_REVIEW" ||
    finalCiEvent.payload["candidate_sha"] !== candidateSha ||
    finalCiEvent.payload["outcome"] !== "passed" ||
    finalCiEvent.payload["observation_intent_digest"] !==
      finalCiObservationIntentDigest ||
    finalCiEvent.payload["observation_digest"] !== finalCiObservationDigest ||
    finalCiEvent.payload["observation_fencing_generation"] !==
      finalCiFencingGeneration ||
    finalCiEvent.payload["checks_digest"] !== finalCiChecksDigest ||
    finalCiEventChecks === undefined ||
    canonicalJson(finalCiEventChecks) !== canonicalJson(finalCi.checks) ||
    finalCiEvent.payload["observed_at"] !== finalCiObservedAtText ||
    finalCiObservedAt < Date.parse(pullRequestReview.occurred_at) ||
    finalCiObservedAt > Date.parse(finalCiEvent.occurred_at) ||
    Date.parse(finalCiEvent.occurred_at) > finalObservedAt ||
    finalCiObservedAt > finalObservedAt ||
    finalCiObservedAt > Date.parse(delivered.occurred_at) ||
    finalObservedAt < Date.parse(pullRequestReview.occurred_at) ||
    finalObservedAt > Date.parse(delivered.occurred_at)
  ) {
    fail(
      "binding",
      "durable final PR, collision/base/protection, remote-head, or CI evidence is contradictory",
    );
  }
  return {
    candidateSha,
    treeDigest,
    completedAt: delivered.occurred_at,
    pullRequest: {
      number,
      url,
      headRef,
      baseRef: envelope.payload.repository.base_ref,
    },
    verificationEvidence,
    ciEvidence: finalCi.evidence,
    reviewFindings: {
      local: asString(localReview.payload["findings_digest"], "local review findings"),
      pullRequest: asString(
        pullRequestReview.payload["findings_digest"],
        "pull-request review findings",
      ),
    },
    identityAttributions,
  };
}

function captureAuthoritativeFacts(
  input: FinalizationInput,
  now: number,
): AuthoritativeEvidenceFacts {
  const { snapshot, envelope, policy, candidateSha } = assertAdmission(input);
  const events = parseDurableEvents(input.events);
  const request: AsfEvidenceMaterialRequest = {
    binding: structuredClone(input.binding),
    intent: structuredClone(input.intent),
    intentMode: input.intentMode,
    snapshot,
    envelope,
    effectivePolicy: policy,
    events,
    signal: input.signal,
  };
  return {
    request,
    ...assertEvents(
      snapshot,
      envelope,
      policy,
      candidateSha,
      events,
      input.intent.created_at,
      now,
    ),
  };
}

function assertExpectations(
  expected: AsfEvidenceExpectations,
  facts: AuthoritativeEvidenceFacts,
): void {
  const { snapshot, envelope, effectivePolicy: policy, binding } = facts.request;
  for (const [label, actual, authoritative] of [
    ["run id", expected.runId, snapshot.run.runId],
    ["attempt id", expected.attemptId, snapshot.admission.attemptId],
    ["Work Order id", expected.workOrderId, snapshot.admission.workOrderId],
    ["Work Order envelope digest", expected.workOrderEnvelopeDigest, snapshot.admission.envelopeDigest],
    ["Work Order payload digest", expected.workOrderPayloadDigest, snapshot.admission.payloadDigest],
    ["effective policy digest", expected.effectivePolicyDigest, snapshot.admission.effectivePolicyDigest],
    ["forge", expected.forge, envelope.payload.repository.forge],
    ["repository", expected.repository, snapshot.run.repo],
    ["base ref", expected.baseRef, envelope.payload.repository.base_ref],
    ["base SHA", expected.baseSha, envelope.payload.repository.base_sha.toLowerCase()],
    ["candidate SHA", expected.candidateSha, facts.candidateSha],
    ["candidate tree digest", expected.treeDigest, facts.treeDigest],
    ["pull request number", expected.pullRequest.number, facts.pullRequest.number],
    ["pull request URL", expected.pullRequest.url, facts.pullRequest.url],
    ["pull request head ref", expected.pullRequest.headRef, facts.pullRequest.headRef],
    ["pull request base ref", expected.pullRequest.baseRef, facts.pullRequest.baseRef],
    ["fenced candidate", binding.candidateSha, facts.candidateSha],
  ] as const) {
    assertEqual(actual, authoritative, label);
  }
  assertSameValues(expected.requiredLocalCheckIds, policy.requiredLocalCheckIds, "required local checks");
  assertSameValues(expected.requiredCiContexts, policy.requiredRemoteChecks, "required CI contexts");
  if (!expected.requireLocalReview || !expected.requirePullRequestReview) {
    fail("binding", "P0 delivery evidence must require both fresh independent reviews");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(expected.normalizedDiffDigest)) {
    fail("schema", "authoritative normalized diff digest is invalid");
  }
  const pathScope = evaluateEffectivePathScope(expected.changedPaths, policy);
  if (!pathScope.accepted) {
    fail("binding", "authoritative changed paths exceed the effective policy scope");
  }
}

function assertStatement(
  statement: AsfEvidenceStatement,
  facts: AuthoritativeEvidenceFacts,
): void {
  const { snapshot, effectivePolicy: policy } = facts.request;
  const predicate = statement.predicate;
  if (
    predicate.run.completed_at !== facts.completedAt ||
    predicate.work_order.signature.key_id !== snapshot.admission.signatureKeyId ||
    predicate.work_order.signature.algorithm !== snapshot.admission.signatureAlgorithm ||
    predicate.policy.inputs.operator_policy_digest !== policy.inputs.operatorPolicy ||
    predicate.policy.inputs.work_order_policy_digest !== policy.inputs.workOrderPolicy ||
    predicate.policy.inputs.repository_policy_digest !== policy.inputs.repositoryPolicy ||
    predicate.policy.inputs.forge_policy_digest !== policy.inputs.forgeProtection ||
    predicate.runtime.harness_digest !== policy.inputs.harness
  ) {
    fail("binding", "evidence statement contradicts signed admission or policy provenance");
  }

  const evidenceRoles = {
    implementer: "implementer",
    "local-reviewer": "local-reviewer",
    "pr-reviewer": "pull-request-reviewer",
  } as const;
  for (const attribution of facts.identityAttributions) {
    const provider = predicate.runtime.providers.find(
      (candidate) => candidate.role === evidenceRoles[attribution.role],
    );
    if (
      provider === undefined ||
      provider.provider !== attribution.provider ||
      provider.principal_id !== attribution.principal_id ||
      provider.lease_attribution_digest !==
        attribution.lease_attribution_digest
    ) {
      fail(
        "binding",
        `${evidenceRoles[attribution.role]} provider attribution contradicts durable identity evidence`,
      );
    }
  }

  const localChecks = new Map(
    predicate.verification.local_checks.map((check) => [check.check_id, check.evidence_digest]),
  );
  const ciContexts = new Map(
    predicate.verification.ci_contexts.map((check) => [check.context, check.evidence_digest]),
  );
  for (const [checkId, evidenceDigest] of facts.verificationEvidence) {
    assertEqual(localChecks.get(checkId), evidenceDigest, `local check ${checkId} evidence`);
  }
  for (const [context, evidenceDigest] of facts.ciEvidence) {
    assertEqual(ciContexts.get(context), evidenceDigest, `CI context ${context} evidence`);
  }
  const localReview = predicate.reviews.find((review) => review.stage === "local");
  const pullRequestReview = predicate.reviews.find(
    (review) => review.stage === "pull-request",
  );
  assertEqual(
    localReview?.findings_digest,
    facts.reviewFindings.local,
    "local review findings",
  );
  assertEqual(
    pullRequestReview?.findings_digest,
    facts.reviewFindings.pullRequest,
    "pull-request review findings",
  );
}

/** Concrete ASF-only signing and independent verification boundary. */
export class ProductionAsfEvidenceFinalizationController
  implements AsfEvidenceFinalizationController
{
  readonly #options: ProductionAsfEvidenceFinalizationControllerOptions;

  constructor(options: ProductionAsfEvidenceFinalizationControllerOptions) {
    this.#options = options;
  }

  async finalize(input: FinalizationInput): Promise<ArtifactVerifiedAsfEvidenceBundle> {
    if (input.signal.aborted) fail("missing-evidence", "evidence finalization was cancelled");
    const now = this.#options.clock.now().getTime();
    const facts = captureAuthoritativeFacts(input, now);
    const material = await this.#options.materialSource.assemble(facts.request);
    if (input.signal.aborted) fail("missing-evidence", "evidence finalization was cancelled");

    const expected = structuredClone(material.expectations);
    assertExpectations(expected, facts);
    const parsedStatement = asfEvidenceStatementSchema.safeParse(material.statement);
    if (!parsedStatement.success) {
      fail("schema", "authoritative evidence source returned an invalid statement");
    }
    assertStatement(parsedStatement.data, facts);

    // The intent timestamp is durable and stable across recovery, so Ed25519
    // finalization is byte-identical after a crash before the state transition.
    const bundle = signAsfEvidenceBundle({
      statement: parsedStatement.data,
      keyId: this.#options.signingKey.keyId,
      privateKey: this.#options.signingKey.privateKey,
      issuedAt: facts.request.intent.created_at,
    });
    const validated = validateSignedAsfEvidenceBundle(bundle, {
      clock: this.#options.clock,
      trustedSigners: [
        {
          keyId: this.#options.signingKey.keyId,
          publicKey: this.#options.signingKey.publicKey,
          validFrom: this.#options.signingKey.validFrom,
          validUntil: this.#options.signingKey.validUntil,
          revokedAt: null,
        },
      ],
      expected,
    });
    const verified = await verifyAsfEvidenceArtifactContents(validated, {
      resolver: this.#options.artifactResolver,
      maxArtifactBytes: this.#options.maxArtifactBytes,
      maxTotalBytes: this.#options.maxTotalArtifactBytes,
      signal: input.signal,
    });
    if (input.signal.aborted) fail("missing-evidence", "evidence finalization was cancelled");
    return verified;
  }
}
