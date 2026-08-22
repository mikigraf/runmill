import {
  createHash,
  createPublicKey,
  KeyObject,
  randomUUID,
  verify as verifySignature,
  type KeyLike,
} from "node:crypto";
import { z } from "zod";
import { RunmillError } from "../errors/runmill-error.js";
import { ALWAYS_FORBIDDEN_PATHS } from "../agent/task-packet.js";
import type { Clock } from "../platform/clock.js";
import { SystemClock } from "../platform/clock.js";
import {
  evaluateChangedPathScope,
  pathMatchesPattern,
  type ChangeScope,
  type ChangeScopeViolation,
} from "../workspace/path-scope.js";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "./canonical-json.js";

export const WORK_ORDER_ENVELOPE_SCHEMA = "asf.work-order-envelope/v1" as const;
export const WORK_ORDER_SCHEMA = "asf.work-order/v1" as const;
export const EFFECTIVE_POLICY_SCHEMA = "runmill.effective-policy/v1" as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const identitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(768)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const baseRefSchema = z.string().refine((value) => {
  if (!value.startsWith("refs/heads/")) return false;
  const branch = value.slice("refs/heads/".length);
  if (
    branch === "" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(branch)
  ) {
    return false;
  }
  return branch
    .split("/")
    .every((component) => component !== "" && !component.startsWith(".") && !component.endsWith(".lock"));
}, "must be a fully qualified valid branch ref");
const gitShaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/u);
const pathPatternSchema = z.string().min(1).max(1024);
const remoteCheckSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain surrounding whitespace or control characters",
  );

const payloadSchema = z
  .object({
    schema: z.literal(WORK_ORDER_SCHEMA),
    work_order_id: identifierSchema,
    tenant_id: identifierSchema,
    work_item_id: identifierSchema,
    attempt_id: identifierSchema,
    idempotency_key: idempotencyKeySchema,
    source: z
      .object({
        system: identifierSchema,
        external_id: identifierSchema,
        snapshot_digest: digestSchema,
      })
      .strict(),
    repository: z
      .object({
        forge: identifierSchema,
        repository: repositorySchema,
        base_ref: baseRefSchema,
        base_sha: gitShaSchema,
      })
      .strict(),
    objective: z
      .object({
        title: z.string().min(1).max(1024),
        description: z.string().min(1),
        acceptance_criteria: z.array(z.string().min(1)).min(1),
        non_goals: z.array(z.string().min(1)),
      })
      .strict(),
    scope: z
      .object({
        allowed_paths: z.array(pathPatternSchema).min(1),
        forbidden_paths: z.array(pathPatternSchema),
        risk_class: z.enum(["low", "medium", "high", "critical"]),
      })
      .strict(),
    verification: z
      .object({
        required_local_check_ids: z.array(identifierSchema),
        required_remote_checks: z.array(remoteCheckSchema),
        policy_snapshot_digest: digestSchema,
      })
      .strict(),
    identities: z
      .object({
        implementer: identitySchema,
        local_reviewer: identitySchema,
        pr_reviewer: identitySchema,
      })
      .strict(),
    runtime: z
      .object({
        sandbox_profile: identifierSchema,
        tool_policy: identifierSchema,
        network_policy: identifierSchema,
      })
      .strict(),
    budgets: z
      .object({
        wall_seconds: z.number().int().positive(),
        max_cost_usd: z.number().finite().nonnegative(),
        max_agent_invocations: z.number().int().positive(),
        max_fix_iterations: z.number().int().nonnegative(),
      })
      .strict(),
    delivery: z
      .object({
        closure_target: z.enum(["pr", "merge", "deploy", "observe"]),
        draft_pr: z.boolean(),
        merge_policy_ref: z.string().min(1).max(512).nullable(),
      })
      .strict(),
    policy_digest: digestSchema,
    harness_digest: digestSchema,
  })
  .strict();

export const workOrderEnvelopeSchema = z
  .object({
    schema: z.literal(WORK_ORDER_ENVELOPE_SCHEMA),
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
    issued_at: z.iso.datetime({ offset: true }),
    not_before: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    payload: payloadSchema,
    signature: z.string().regex(/^base64url:[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type WorkOrderPayload = z.infer<typeof payloadSchema>;
export type WorkOrderEnvelope = z.infer<typeof workOrderEnvelopeSchema>;
export type RiskClass = WorkOrderPayload["scope"]["risk_class"];
export type ClosureTarget = WorkOrderPayload["delivery"]["closure_target"];

export interface TrustedWorkOrderSigner {
  readonly keyId: string;
  readonly publicKey: KeyLike;
}

export interface AsfBudgetLimits {
  readonly wallSeconds: number;
  readonly maxCostUsd: number;
  readonly maxAgentInvocations: number;
  readonly maxFixIterations: number;
}

export interface AsfOperatorAuthority {
  readonly pathScope: ChangeScope;
  /** Check ids whose commands are defined in operator-owned policy. */
  readonly definedLocalCheckIds: readonly string[];
  /** Base-policy check definitions the operator explicitly permits Runmill to execute. */
  readonly authorizedRepositoryCheckIds: readonly string[];
  readonly requiredLocalCheckIds: readonly string[];
  readonly requiredRemoteChecks: readonly string[];
  readonly allowedRiskClasses: readonly RiskClass[];
  readonly allowedClosureTargets: readonly ClosureTarget[];
  readonly identityProfiles: {
    readonly implementer: readonly string[];
    readonly localReviewer: readonly string[];
    readonly prReviewer: readonly string[];
  };
  readonly requireIndependentReviewers: boolean;
  readonly sandboxProfiles: readonly string[];
  readonly toolPolicies: readonly string[];
  readonly networkPolicies: readonly string[];
  readonly budgetLimits: AsfBudgetLimits;
  /** Explicit operator grants for the otherwise-forbidden critical-path work class. */
  readonly criticalPathGrants?: readonly {
    readonly workClass: string;
    readonly workOrderPolicyDigest: string;
    readonly allowedPaths: readonly string[];
  }[];
}

export interface AsfAdmissionPolicy {
  readonly operatorPolicyDigest: string;
  readonly tenantIds: readonly string[];
  readonly policyDigests: readonly string[];
  readonly harnessDigests: readonly string[];
  readonly repository: {
    readonly forge: string;
    readonly repository: string;
    readonly baseRef: string;
  };
  readonly trustedSigners: readonly TrustedWorkOrderSigner[];
  readonly authority: AsfOperatorAuthority;
}

export interface RepositoryAdmissionEvidence {
  readonly forge: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly observedBaseSha: string;
  readonly requestedBaseShaReachable: boolean;
  readonly repositoryPolicyDigest: string;
  /** Commit whose repository policy bytes produced repositoryPolicyDigest. */
  readonly repositoryPolicyBaseSha: string;
  /** Operator-configured repository-relative path read from repositoryPolicyBaseSha. */
  readonly repositoryPolicyPath: string;
  /** Canonical base64 encoding of the exact repository-policy bytes. */
  readonly repositoryPolicyBytesBase64: string;
  readonly forgeProtectionDigest: string;
  /** Protected branch whose rules produced forgeProtectionDigest. */
  readonly forgeProtectionBaseRef: string;
  /** Canonical base64 encoding of the exact canonical forge-protection snapshot. */
  readonly forgeProtectionBytesBase64: string;
  readonly constraints: {
    readonly pathScope: ChangeScope;
    /** Check ids whose commands were read from the immutable base commit. */
    readonly definedLocalCheckIds: readonly string[];
    readonly requiredLocalCheckIds: readonly string[];
    readonly requiredRemoteChecks: readonly string[];
  };
  readonly forgeProtection: {
    readonly pullRequestsAllowed: boolean;
    readonly requiredRemoteChecks: readonly string[];
  };
}

export interface RepositoryAdmissionObserver {
  observe(payload: WorkOrderPayload): Promise<RepositoryAdmissionEvidence>;
}

export interface EffectivePathScope {
  readonly source: "operator" | "work-order" | "repository";
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

export interface EffectiveAsfPolicy {
  readonly schema: typeof EFFECTIVE_POLICY_SCHEMA;
  readonly digest: string;
  readonly inputs: {
    readonly operatorPolicy: string;
    readonly workOrderPolicy: string;
    readonly workOrderPayload: string;
    readonly harness: string;
    readonly repositoryPolicy: string;
    readonly repositoryPolicyBaseSha: string;
    readonly repositoryPolicyPath: string;
    readonly repositoryPolicyBytesBase64: string;
    readonly observedBaseSha: string;
    readonly forgeProtection: string;
    readonly forgeProtectionBaseRef: string;
    readonly forgeProtectionBytesBase64: string;
  };
  readonly pathScopes: readonly EffectivePathScope[];
  readonly criticalPaths: {
    readonly workClass: string | null;
    readonly approvedPaths: readonly string[];
  };
  readonly requiredLocalCheckIds: readonly string[];
  readonly requiredRemoteChecks: readonly string[];
  readonly riskClass: RiskClass;
  readonly identities: {
    readonly implementer: string;
    readonly localReviewer: string;
    readonly prReviewer: string;
  };
  readonly runtime: {
    readonly sandboxProfile: string;
    readonly toolPolicy: string;
    readonly networkPolicy: string;
  };
  readonly budgets: AsfBudgetLimits;
  readonly delivery: {
    readonly closureTarget: "pr";
    readonly draftPr: boolean;
  };
}

export interface ValidatedWorkOrder {
  readonly envelope: WorkOrderEnvelope;
  readonly canonicalEnvelope: string;
  readonly envelopeDigest: string;
  readonly payloadDigest: string;
  readonly signature: {
    readonly verified: true;
    readonly keyId: string;
    readonly algorithm: "EdDSA";
  };
  readonly repository: RepositoryAdmissionEvidence;
  readonly effectivePolicy: EffectiveAsfPolicy;
}

export interface AsfAdmissionRow {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly envelopeDigest: string;
}

export interface AsfWorkOrderAdmissionStore {
  getAsfAdmission(idempotencyKey: string): AsfAdmissionRow | undefined;
  admitAsfWorkOrder(input: {
    readonly runId: string;
    readonly envelope: WorkOrderEnvelope;
    readonly canonicalEnvelope: string;
    readonly envelopeDigest: string;
    readonly payloadDigest: string;
    readonly effectivePolicy: EffectiveAsfPolicy;
  }): { readonly runId: string; readonly created: boolean };
}

export interface SubmitWorkOrderResult {
  readonly runId: string;
  readonly disposition: "accepted" | "existing";
  readonly payloadDigest: string;
}

function workOrderError(
  code: "RM-WO-001" | "RM-WO-002" | "RM-WO-003" | "RM-WO-004" | "RM-WO-005" | "RM-WO-006",
  whatHappened: string,
): RunmillError {
  return RunmillError.fromCatalog(code, { whatHappened });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse without permitting an unknown major version to masquerade as malformed input. */
export function parseWorkOrderEnvelope(raw: unknown): WorkOrderEnvelope {
  const envelope = asRecord(raw);
  const envelopeSchema = envelope?.["schema"];
  const payload = asRecord(envelope?.["payload"]);
  const workOrderSchema = payload?.["schema"];
  if (envelopeSchema !== WORK_ORDER_ENVELOPE_SCHEMA || workOrderSchema !== WORK_ORDER_SCHEMA) {
    throw workOrderError(
      "RM-WO-001",
      `unsupported Work Order schemas: envelope=${JSON.stringify(envelopeSchema)}, ` +
        `payload=${JSON.stringify(workOrderSchema)}`,
    );
  }

  const parsed = workOrderEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw workOrderError(
      "RM-WO-002",
      "the Work Order envelope is malformed:\n" +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

/** Bytes covered by the EdDSA signature: the canonical envelope with `signature` omitted. */
export function workOrderSigningPayload(envelope: WorkOrderEnvelope): string {
  const { signature: _signature, ...signed } = envelope;
  return canonicalJson(signed);
}

function verifyEnvelopeSignature(
  envelope: WorkOrderEnvelope,
  policy: AsfAdmissionPolicy,
): void {
  const signer = policy.trustedSigners.find((candidate) => candidate.keyId === envelope.key_id);
  if (signer === undefined) {
    throw workOrderError("RM-WO-002", `Work Order signer ${JSON.stringify(envelope.key_id)} is not trusted`);
  }

  const encoded = envelope.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== encoded) {
    throw workOrderError("RM-WO-002", "the Work Order signature is not canonical base64url");
  }

  try {
    const publicKey =
      signer.publicKey instanceof KeyObject
        ? signer.publicKey
        : createPublicKey(signer.publicKey);
    if (publicKey.type !== "public") {
      throw new Error("trusted Work Order signer must be configured with a public key");
    }
    if (publicKey.asymmetricKeyType !== "ed25519" && publicKey.asymmetricKeyType !== "ed448") {
      throw new Error(`trusted key is ${publicKey.asymmetricKeyType ?? "not asymmetric"}, not EdDSA`);
    }
    const verified = verifySignature(
      null,
      Buffer.from(workOrderSigningPayload(envelope), "utf8"),
      publicKey,
      signature,
    );
    if (!verified) throw new Error("signature verification returned false");
  } catch (cause) {
    throw workOrderError(
      "RM-WO-002",
      `signature verification failed for signer ${JSON.stringify(envelope.key_id)}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

function validateAdmissionWindow(envelope: WorkOrderEnvelope, clock: Clock): void {
  const issuedAt = Date.parse(envelope.issued_at);
  const notBefore = Date.parse(envelope.not_before);
  const expiresAt = Date.parse(envelope.expires_at);
  const now = clock.now().getTime();
  if (issuedAt > notBefore || notBefore >= expiresAt) {
    throw workOrderError(
      "RM-WO-002",
      "the Work Order validity window is contradictory: require issued_at <= not_before < expires_at",
    );
  }
  if (now < notBefore) {
    throw workOrderError("RM-WO-002", `the Work Order is not valid before ${envelope.not_before}`);
  }
  if (now >= expiresAt) {
    throw workOrderError("RM-WO-002", `the Work Order expired at ${envelope.expires_at}`);
  }
}

function validatePayloadBindings(payload: WorkOrderPayload): void {
  const expectedIdempotencyKey = `${payload.tenant_id}/${payload.work_item_id}/${payload.attempt_id}`;
  if (payload.idempotency_key !== expectedIdempotencyKey) {
    throw workOrderError(
      "RM-WO-002",
      `idempotency key must bind tenant, work item, and attempt as ` +
        `${JSON.stringify(expectedIdempotencyKey)}, got ${JSON.stringify(payload.idempotency_key)}`,
    );
  }
  if (payload.delivery.closure_target === "pr" && payload.delivery.merge_policy_ref !== null) {
    throw workOrderError(
      "RM-WO-002",
      "a PR-only Work Order cannot carry merge authority in delivery.merge_policy_ref",
    );
  }
}

function requireMember(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) {
    throw workOrderError(
      "RM-WO-005",
      `${label} ${JSON.stringify(value)} exceeds operator authority; allowed: ` +
        (allowed.length === 0 ? "<none>" : allowed.map((item) => JSON.stringify(item)).join(", ")),
    );
  }
}

function requireDigest(
  value: string,
  label: string,
  source: "operator" | "repository",
): void {
  if (!digestSchema.safeParse(value).success) {
    throw workOrderError(
      source === "operator" ? "RM-WO-005" : "RM-WO-004",
      `${label} is not a tagged lower-case SHA-256 digest`,
    );
  }
}

function requireRemoteChecks(
  values: readonly string[],
  label: string,
  source: "operator" | "repository",
): void {
  const invalid = values.find((value) => !remoteCheckSchema.safeParse(value).success);
  if (invalid !== undefined) {
    throw workOrderError(
      source === "operator" ? "RM-WO-005" : "RM-WO-004",
      `${label} contains an invalid remote check context: ${JSON.stringify(invalid)}`,
    );
  }
}

function validateOperatorEvidence(policy: AsfAdmissionPolicy): void {
  requireDigest(policy.operatorPolicyDigest, "operator policy digest", "operator");
  for (const digest of policy.policyDigests) {
    requireDigest(digest, "allowed Work Order policy digest", "operator");
  }
  for (const digest of policy.harnessDigests) {
    requireDigest(digest, "allowed harness digest", "operator");
  }
  requireRemoteChecks(policy.authority.requiredRemoteChecks, "operator policy", "operator");
  for (const grant of policy.authority.criticalPathGrants ?? []) {
    requireDigest(grant.workOrderPolicyDigest, "critical-path grant policy digest", "operator");
    validatePathScope(
      { allowedPaths: grant.allowedPaths, forbiddenPaths: [] },
      `critical-path work class ${JSON.stringify(grant.workClass)}`,
    );
  }
}

function validateRegisteredRepository(
  payload: WorkOrderPayload,
  policy: AsfAdmissionPolicy,
): void {
  const requested = payload.repository;
  const configured = policy.repository;
  if (
    requested.forge !== configured.forge ||
    requested.repository.toLowerCase() !== configured.repository.toLowerCase() ||
    requested.base_ref !== configured.baseRef
  ) {
    throw workOrderError(
      "RM-WO-002",
      `Work Order repository ${requested.forge}:${requested.repository}@${requested.base_ref} ` +
        `does not match operator registration ${configured.forge}:${configured.repository}@${configured.baseRef}`,
    );
  }
}

/** Checks all signed inputs that require no repository or forge observation. */
function validateLocalAuthority(payload: WorkOrderPayload, policy: AsfAdmissionPolicy): void {
  validateOperatorEvidence(policy);
  validateRegisteredRepository(payload, policy);
  requireMember(payload.tenant_id, policy.tenantIds, "tenant");
  requireMember(payload.policy_digest, policy.policyDigests, "Work Order policy digest");
  requireMember(payload.harness_digest, policy.harnessDigests, "harness digest");

  if (payload.delivery.closure_target !== "pr") {
    throw workOrderError(
      "RM-WO-006",
      `closure target ${JSON.stringify(payload.delivery.closure_target)} is unsupported in P0; only "pr" is available`,
    );
  }
  requireMember(
    payload.delivery.closure_target,
    policy.authority.allowedClosureTargets,
    "closure target",
  );
  requireMember(payload.scope.risk_class, policy.authority.allowedRiskClasses, "risk class");
  requireMember(
    payload.identities.implementer,
    policy.authority.identityProfiles.implementer,
    "implementer identity",
  );
  requireMember(
    payload.identities.local_reviewer,
    policy.authority.identityProfiles.localReviewer,
    "local reviewer identity",
  );
  requireMember(
    payload.identities.pr_reviewer,
    policy.authority.identityProfiles.prReviewer,
    "PR reviewer identity",
  );
  if (
    policy.authority.requireIndependentReviewers &&
    (payload.identities.local_reviewer === payload.identities.implementer ||
      payload.identities.pr_reviewer === payload.identities.implementer)
  ) {
    throw workOrderError(
      "RM-WO-005",
      "reviewer identities must be independent from the implementer identity",
    );
  }
  requireMember(
    payload.runtime.sandbox_profile,
    policy.authority.sandboxProfiles,
    "sandbox profile",
  );
  requireMember(payload.runtime.tool_policy, policy.authority.toolPolicies, "tool policy");
  requireMember(
    payload.runtime.network_policy,
    policy.authority.networkPolicies,
    "network policy",
  );
  validatePathScope(policy.authority.pathScope, "operator");
  validatePathScope(
    { allowedPaths: payload.scope.allowed_paths, forbiddenPaths: payload.scope.forbidden_paths },
    "Work Order",
  );
}

function validatePathScope(scope: ChangeScope, source: string): void {
  const result = evaluateChangedPathScope([], scope);
  if (!result.accepted) {
    throw workOrderError(
      "RM-WO-005",
      `${source} path policy is invalid: ${result.violations.map((item) => item.detail).join("; ")}`,
    );
  }
}

function union(...sets: readonly (readonly string[])[]): string[] {
  return [...new Set(sets.flat())].sort();
}

function assertChecksDefined(required: readonly string[], defined: readonly string[]): void {
  const missing = required.filter((check) => !defined.includes(check));
  if (missing.length > 0) {
    throw workOrderError(
      "RM-WO-005",
      `required local checks have no trusted command definition: ${missing.join(", ")}`,
    );
  }
}

function validateRepositoryEvidence(
  payload: WorkOrderPayload,
  policy: AsfAdmissionPolicy,
  evidence: RepositoryAdmissionEvidence,
): void {
  const requested = payload.repository;
  validateRegisteredRepository(payload, policy);
  if (
    evidence.forge !== requested.forge ||
    evidence.repository.toLowerCase() !== requested.repository.toLowerCase() ||
    evidence.baseRef !== requested.base_ref
  ) {
    throw workOrderError("RM-WO-004", "repository observation does not describe the requested forge, repository, and base ref");
  }
  if (!/^[a-fA-F0-9]{40}$/u.test(evidence.observedBaseSha)) {
    throw workOrderError("RM-WO-004", "repository observation returned an invalid base SHA");
  }
  if (!/^[a-fA-F0-9]{40}$/u.test(evidence.repositoryPolicyBaseSha)) {
    throw workOrderError("RM-WO-004", "repository policy observation returned an invalid base SHA");
  }
  requireDigest(evidence.repositoryPolicyDigest, "repository policy digest", "repository");
  requireDigest(evidence.forgeProtectionDigest, "forge-protection digest", "repository");
  const decodeEvidenceBytes = (encoded: string, label: string): Buffer => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw workOrderError("RM-WO-004", `${label} is not canonical base64`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 1_048_576) {
      throw workOrderError("RM-WO-004", `${label} is not canonical base64 or exceeds 1 MiB`);
    }
    return bytes;
  };
  const repositoryPolicyBytes = decodeEvidenceBytes(
    evidence.repositoryPolicyBytesBase64,
    "repository policy bytes",
  );
  const repositoryPolicyDigest =
    `sha256:${createHash("sha256").update(repositoryPolicyBytes).digest("hex")}`;
  if (repositoryPolicyDigest !== evidence.repositoryPolicyDigest) {
    throw workOrderError("RM-WO-004", "repository policy digest does not bind its exact bytes");
  }
  if (
    evidence.repositoryPolicyPath === "" ||
    evidence.repositoryPolicyPath.startsWith("/") ||
    evidence.repositoryPolicyPath.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw workOrderError("RM-WO-004", "repository policy path is not a normalized repository-relative path");
  }
  const forgeProtectionBytes = decodeEvidenceBytes(
    evidence.forgeProtectionBytesBase64,
    "forge-protection bytes",
  );
  let forgeProtectionSnapshot: unknown;
  try {
    forgeProtectionSnapshot = JSON.parse(forgeProtectionBytes.toString("utf8")) as unknown;
  } catch {
    throw workOrderError("RM-WO-004", "forge-protection bytes are not canonical JSON");
  }
  const forgeSnapshot = asRecord(forgeProtectionSnapshot);
  const forgeConstraints = asRecord(forgeSnapshot?.["protection"]);
  const requiredChecks = forgeConstraints?.["required_checks"];
  if (
    forgeSnapshot?.["schema"] !== "runmill.github-base-protection/v1" ||
    forgeSnapshot["repository"] !== evidence.repository.toLowerCase() ||
    forgeSnapshot["base_ref"] !== evidence.forgeProtectionBaseRef ||
    !Array.isArray(requiredChecks) ||
    requiredChecks.some((check) => typeof check !== "string") ||
    canonicalJson(forgeProtectionSnapshot as JsonValue) !== forgeProtectionBytes.toString("utf8") ||
    canonicalJson([...requiredChecks].sort() as JsonValue) !==
      canonicalJson([...evidence.forgeProtection.requiredRemoteChecks].sort())
  ) {
    throw workOrderError("RM-WO-004", "forge-protection bytes contradict the parsed protection constraints");
  }
  const forgeProtectionDigest =
    `sha256:${createHash("sha256").update(forgeProtectionBytes).digest("hex")}`;
  if (forgeProtectionDigest !== evidence.forgeProtectionDigest) {
    throw workOrderError("RM-WO-004", "forge-protection digest does not bind its exact bytes");
  }
  requireRemoteChecks(
    evidence.constraints.requiredRemoteChecks,
    "repository policy",
    "repository",
  );
  requireRemoteChecks(
    evidence.forgeProtection.requiredRemoteChecks,
    "forge protection",
    "repository",
  );
  if (!evidence.requestedBaseShaReachable) {
    throw workOrderError(
      "RM-WO-004",
      `base SHA ${requested.base_sha} is not reachable from ${requested.base_ref}`,
    );
  }
  if (evidence.repositoryPolicyBaseSha.toLowerCase() !== requested.base_sha.toLowerCase()) {
    throw workOrderError(
      "RM-WO-004",
      `repository policy was read from ${evidence.repositoryPolicyBaseSha}, not requested base ` +
        requested.base_sha,
    );
  }
  if (evidence.forgeProtectionBaseRef !== requested.base_ref) {
    throw workOrderError(
      "RM-WO-004",
      `forge protection describes ${JSON.stringify(evidence.forgeProtectionBaseRef)}, not ` +
        JSON.stringify(requested.base_ref),
    );
  }
  if (payload.verification.policy_snapshot_digest !== evidence.repositoryPolicyDigest) {
    throw workOrderError(
      "RM-WO-002",
      `repository policy snapshot digest is stale: Work Order has ` +
        `${payload.verification.policy_snapshot_digest}, observed ${evidence.repositoryPolicyDigest}`,
    );
  }
  if (!evidence.forgeProtection.pullRequestsAllowed) {
    throw workOrderError("RM-WO-005", "current forge protection does not authorize pull-request delivery");
  }
}

export function resolveEffectivePolicy(
  payload: WorkOrderPayload,
  policy: AsfAdmissionPolicy,
  repository: RepositoryAdmissionEvidence,
): EffectiveAsfPolicy {
  validateLocalAuthority(payload, policy);
  validatePathScope(repository.constraints.pathScope, "repository");

  const criticalPathGrant = (policy.authority.criticalPathGrants ?? []).find(
    (grant) => grant.workOrderPolicyDigest === payload.policy_digest,
  );

  const definedChecks = union(
    policy.authority.definedLocalCheckIds,
    repository.constraints.definedLocalCheckIds.filter((check) =>
      policy.authority.authorizedRepositoryCheckIds.includes(check),
    ),
  );
  const requiredLocalCheckIds = union(
    policy.authority.requiredLocalCheckIds,
    payload.verification.required_local_check_ids,
    repository.constraints.requiredLocalCheckIds,
  );
  assertChecksDefined(requiredLocalCheckIds, definedChecks);

  const unsigned = {
    schema: EFFECTIVE_POLICY_SCHEMA,
    inputs: {
      operatorPolicy: policy.operatorPolicyDigest,
      workOrderPolicy: payload.policy_digest,
      workOrderPayload: sha256Digest(payload),
      harness: payload.harness_digest,
      repositoryPolicy: repository.repositoryPolicyDigest,
      repositoryPolicyBaseSha: repository.repositoryPolicyBaseSha.toLowerCase(),
      repositoryPolicyPath: repository.repositoryPolicyPath,
      repositoryPolicyBytesBase64: repository.repositoryPolicyBytesBase64,
      observedBaseSha: repository.observedBaseSha.toLowerCase(),
      forgeProtection: repository.forgeProtectionDigest,
      forgeProtectionBaseRef: repository.forgeProtectionBaseRef,
      forgeProtectionBytesBase64: repository.forgeProtectionBytesBase64,
    },
    pathScopes: [
      {
        source: "operator" as const,
        allowedPaths: [...policy.authority.pathScope.allowedPaths],
        forbiddenPaths: [...policy.authority.pathScope.forbiddenPaths],
      },
      {
        source: "work-order" as const,
        allowedPaths: [...payload.scope.allowed_paths],
        forbiddenPaths: [...payload.scope.forbidden_paths],
      },
      {
        source: "repository" as const,
        allowedPaths: [...repository.constraints.pathScope.allowedPaths],
        forbiddenPaths: [...repository.constraints.pathScope.forbiddenPaths],
      },
    ],
    criticalPaths: {
      workClass: criticalPathGrant?.workClass ?? null,
      approvedPaths: [...(criticalPathGrant?.allowedPaths ?? [])],
    },
    requiredLocalCheckIds,
    requiredRemoteChecks: union(
      policy.authority.requiredRemoteChecks,
      payload.verification.required_remote_checks,
      repository.constraints.requiredRemoteChecks,
      repository.forgeProtection.requiredRemoteChecks,
    ),
    riskClass: payload.scope.risk_class,
    identities: {
      implementer: payload.identities.implementer,
      localReviewer: payload.identities.local_reviewer,
      prReviewer: payload.identities.pr_reviewer,
    },
    runtime: {
      sandboxProfile: payload.runtime.sandbox_profile,
      toolPolicy: payload.runtime.tool_policy,
      networkPolicy: payload.runtime.network_policy,
    },
    budgets: {
      wallSeconds: Math.min(payload.budgets.wall_seconds, policy.authority.budgetLimits.wallSeconds),
      maxCostUsd: Math.min(payload.budgets.max_cost_usd, policy.authority.budgetLimits.maxCostUsd),
      maxAgentInvocations: Math.min(
        payload.budgets.max_agent_invocations,
        policy.authority.budgetLimits.maxAgentInvocations,
      ),
      maxFixIterations: Math.min(
        payload.budgets.max_fix_iterations,
        policy.authority.budgetLimits.maxFixIterations,
      ),
    },
    delivery: {
      closureTarget: "pr" as const,
      draftPr: payload.delivery.draft_pr,
    },
  };

  return { ...unsigned, digest: sha256Digest(unsigned) };
}

export interface EffectivePathViolation extends ChangeScopeViolation {
  readonly source: EffectivePathScope["source"] | "runmill-default";
}

/** Critical repository controls that ordinary Work Orders can never edit. */
export const DEFAULT_CRITICAL_PATH_PATTERNS = [
  ...ALWAYS_FORBIDDEN_PATHS,
  ".circleci/**",
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  "CODEOWNERS",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "Podfile.lock",
] as const;

/** Every layer must allow a changed path; no layer can widen another. */
export function evaluateEffectivePathScope(
  changedPaths: readonly string[],
  policy: EffectiveAsfPolicy,
): { readonly accepted: boolean; readonly violations: readonly EffectivePathViolation[] } {
  const layerViolations = policy.pathScopes.flatMap((scope) =>
    evaluateChangedPathScope(changedPaths, {
      allowedPaths: scope.allowedPaths,
      forbiddenPaths: scope.forbiddenPaths,
    }).violations.map((violation) => ({ ...violation, source: scope.source })),
  );
  const criticalViolations: EffectivePathViolation[] = [];
  for (const changedPath of changedPaths) {
    const criticalPattern = DEFAULT_CRITICAL_PATH_PATTERNS.find((pattern) => {
      try {
        return pathMatchesPattern(changedPath, pattern);
      } catch {
        return false;
      }
    });
    if (criticalPattern === undefined) continue;
    const explicitlyApproved = policy.criticalPaths.approvedPaths.some((pattern) => {
      try {
        return pathMatchesPattern(changedPath, pattern);
      } catch {
        return false;
      }
    });
    const isAbsoluteLocalMaximum = ALWAYS_FORBIDDEN_PATHS.some((pattern) => {
      try {
        return pathMatchesPattern(changedPath, pattern);
      } catch {
        return true;
      }
    });
    if (!explicitlyApproved || isAbsoluteLocalMaximum) {
      criticalViolations.push({
        path: changedPath,
        reason: "forbidden-path",
        pattern: criticalPattern,
        detail:
          `${changedPath} is a critical path and requires a separately approved ` +
          "operator work class",
        source: "runmill-default",
      });
    }
  }
  const violations = [...layerViolations, ...criticalViolations];
  return { accepted: violations.length === 0, violations };
}

export async function validateWorkOrder(
  raw: unknown,
  options: {
    readonly policy: AsfAdmissionPolicy;
    readonly repository: RepositoryAdmissionObserver;
    readonly clock?: Clock | undefined;
  },
): Promise<ValidatedWorkOrder> {
  const envelope = parseWorkOrderEnvelope(raw);
  verifyEnvelopeSignature(envelope, options.policy);
  validateAdmissionWindow(envelope, options.clock ?? new SystemClock());
  validatePayloadBindings(envelope.payload);
  // No adapter is allowed to observe an unregistered repository or otherwise
  // use authority before every locally decidable maximum has passed.
  validateLocalAuthority(envelope.payload, options.policy);

  const repository = await options.repository.observe(envelope.payload);
  validateRepositoryEvidence(envelope.payload, options.policy, repository);
  const effectivePolicy = resolveEffectivePolicy(envelope.payload, options.policy, repository);
  const canonicalEnvelope = canonicalJson(envelope);
  return {
    envelope,
    canonicalEnvelope,
    envelopeDigest: sha256Digest(envelope),
    payloadDigest: sha256Digest(envelope.payload),
    signature: { verified: true, keyId: envelope.key_id, algorithm: "EdDSA" },
    repository,
    effectivePolicy,
  };
}

function defaultRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

/**
 * Admission is asynchronous only for deterministic repository observation.
 * Once validated, the store creates the run, immutable envelope, transition,
 * and first event in one transaction before this method returns.
 */
export class WorkOrderAdmissionService {
  readonly #store: AsfWorkOrderAdmissionStore;
  readonly #policy: AsfAdmissionPolicy;
  readonly #repository: RepositoryAdmissionObserver;
  readonly #clock: Clock;
  readonly #runId: () => string;

  constructor(options: {
    readonly store: AsfWorkOrderAdmissionStore;
    readonly policy: AsfAdmissionPolicy;
    readonly repository: RepositoryAdmissionObserver;
    readonly clock?: Clock | undefined;
    readonly runId?: (() => string) | undefined;
  }) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#repository = options.repository;
    this.#clock = options.clock ?? new SystemClock();
    this.#runId = options.runId ?? defaultRunId;
  }

  async submit(raw: unknown): Promise<SubmitWorkOrderResult> {
    const envelope = parseWorkOrderEnvelope(raw);
    verifyEnvelopeSignature(envelope, this.#policy);
    validateAdmissionWindow(envelope, this.#clock);
    validatePayloadBindings(envelope.payload);
    const payloadDigest = sha256Digest(envelope.payload);
    const existing = this.#store.getAsfAdmission(envelope.payload.idempotency_key);
    if (existing !== undefined) {
      if (existing.payloadDigest !== payloadDigest) {
        throw workOrderError(
          "RM-WO-003",
          `idempotency key ${JSON.stringify(envelope.payload.idempotency_key)} is already bound ` +
            `to payload ${existing.payloadDigest}, not ${payloadDigest}`,
        );
      }
      return { runId: existing.runId, disposition: "existing", payloadDigest };
    }

    const validated = await validateWorkOrder(envelope, {
      policy: this.#policy,
      repository: this.#repository,
      clock: this.#clock,
    });
    const admitted = this.#store.admitAsfWorkOrder({
      runId: this.#runId(),
      envelope: validated.envelope,
      canonicalEnvelope: validated.canonicalEnvelope,
      envelopeDigest: validated.envelopeDigest,
      payloadDigest: validated.payloadDigest,
      effectivePolicy: validated.effectivePolicy,
    });
    return {
      runId: admitted.runId,
      disposition: admitted.created ? "accepted" : "existing",
      payloadDigest: validated.payloadDigest,
    };
  }
}
