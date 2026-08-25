import { z } from "zod";

/**
 * Byte-faithful zod representation of the published, controller-neutral
 * ctxlane v1 automation identity contracts:
 *
 * - `ctxlane.work-order-authorization/v1`
 * - `ctxlane.identity-lease-request/v1`
 * - `ctxlane.identity-lease/v1`
 * - authenticated private identity-lease lifecycle request/response envelopes
 * - lifecycle parameter objects and `ctxlane.lease-view/v1`
 *
 * These schemas are transcribed field-for-field, pattern-for-pattern, from
 * the vendored upstream JSON Schema documents under
 * `test/fixtures/ctxlane/schemas/` (see that directory's `PROVENANCE.md`).
 * `test/identity/ctxlane-broker.test.ts` proves every vendored example
 * parses here and that deliberate mutations of those examples are rejected,
 * so this module never drifts into an invented, locally-shaped projection.
 *
 * Runmill does not implement a ctxlane server and does not verify the
 * Ed25519 work-order-authorization signature itself; ctxlane is the
 * authoritative verifier. This module only proves that what Runmill sends
 * and accepts is exactly what ctxlane v1 publishes.
 */

export const CTXLANE_WORK_ORDER_AUTHORIZATION_SCHEMA =
  "ctxlane.work-order-authorization/v1" as const;
export const CTXLANE_IDENTITY_LEASE_REQUEST_SCHEMA =
  "ctxlane.identity-lease-request/v1" as const;
export const CTXLANE_IDENTITY_LEASE_SCHEMA =
  "ctxlane.identity-lease/v1" as const;
export const CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA =
  "ctxlane.identity-lease-lifecycle-private/v1" as const;
export const CTXLANE_LEASE_VIEW_SCHEMA = "ctxlane.lease-view/v1" as const;
export const CTXLANE_IDENTITY_LEASE_RENEW_ACKNOWLEDGEMENT_SCHEMA =
  "ctxlane.identity-lease-renew-acknowledgement/v1" as const;
export const CTXLANE_SERVICE_HEALTH_SCHEMA =
  "ctxlane.service-health/v1" as const;

const CTXLANE_ROLE_VALUES = [
  "implementer",
  "local-reviewer",
  "pr-reviewer",
] as const;
const CTXLANE_PROVIDER_VALUES = ["claude", "codex"] as const;

export type CtxlaneRole = (typeof CTXLANE_ROLE_VALUES)[number];
export type CtxlaneProvider = (typeof CTXLANE_PROVIDER_VALUES)[number];

const roleSchema = z.enum(CTXLANE_ROLE_VALUES);
const providerSchema = z.enum(CTXLANE_PROVIDER_VALUES);

/**
 * Exact ctxlane service-health v1 result returned by the authenticated MCP
 * health tool.  This is deliberately separate from an identity lease: a
 * healthy controller channel does not grant a provider identity or prove a
 * lease acquisition.
 */
export const ctxlaneServiceHealthSchema = z
  .object({
    schema: z.literal(CTXLANE_SERVICE_HEALTH_SCHEMA),
    process_liveness: z.boolean(),
    store_available: z.boolean(),
    recovery_complete: z.boolean(),
    controller_channel_ready: z.boolean(),
    policy_trust_root_valid: z.boolean(),
    profile_readiness: z.boolean(),
    harness_ready: z.boolean(),
    capacity_available: z.boolean(),
    audit_export_healthy: z.boolean(),
    ready: z.boolean(),
  })
  .strict()
  .superRefine((health, context) => {
    if (
      health.ready &&
      [
        health.process_liveness,
        health.store_available,
        health.recovery_complete,
        health.controller_channel_ready,
        health.policy_trust_root_valid,
        health.profile_readiness,
        health.harness_ready,
        health.capacity_available,
        health.audit_export_healthy,
      ].some((value) => !value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ready"],
        message: "ready may be true only when every service-health prerequisite is true",
      });
    }
  });

export type CtxlaneServiceHealth = z.infer<typeof ctxlaneServiceHealthSchema>;

export const CTXLANE_AUTOMATION_READINESS_SCHEMA =
  "ctxlane.automation-readiness/v1" as const;

const readinessProfileUidSchema = z
  .string()
  .regex(/^profile_[0-7][0-9A-HJKMNP-TV-Z]{25}$(?![\s\S])/u);
const readinessProfileRefSchema = z
  .string()
  .regex(/^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/u);
const readinessProviderSchema = providerSchema;
const readinessRoleSchema = roleSchema;
const readinessAuthModeSchema = z.enum([
  "wif",
  "subscription-token",
  "api-key",
  "chatgpt-oauth",
  "access-token",
] as const);
const readinessIsolationSchema = z.enum([
  "credential-isolated",
  "per-lease-isolated",
  "copied-credential-development",
  "unproven",
] as const);
const readinessEnvironmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$(?![\s\S])/u);
const readinessUtcTimestampSchema = z
  .string()
  .regex(
    /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]{1,9})?Z$(?![\s\S])/u,
  )
  .refine(isCanonicalUtcTimestamp, "must be a canonical UTC RFC 3339 timestamp");
const READINESS_CLAUDE_AUTH_MODE_VALUES = [
  "wif",
  "subscription-token",
  "api-key",
] as const;
const READINESS_CODEX_AUTH_MODE_VALUES = [
  "wif",
  "chatgpt-oauth",
  "api-key",
  "access-token",
] as const;

const READINESS_STATUS_VALUES = [
  "pass",
  "warn",
  "fail",
  "unknown",
  "not-applicable",
] as const;
const READINESS_REASON_CODE_VALUES = [
  "metadata-invalid",
  "credential-source-unavailable",
  "identity-token-stale",
  "harness-untrusted",
  "principal-unverified",
  "principal-mismatch",
  "expected-tenant-unverified",
  "organization-mismatch",
  "workspace-mismatch",
  "automation-policy-denied",
  "authentication-exception-required",
  "authentication-exception-acknowledged",
  "isolation-exception-required",
  "isolation-exception-acknowledged",
  "isolation-unproven",
  "probe-not-run",
  "probe-failed",
  "unsupported-platform",
  "not-applicable",
] as const;
const readinessStatusSchema = z.enum(READINESS_STATUS_VALUES);
const readinessReasonCodeSchema = z.enum(READINESS_REASON_CODE_VALUES);
const readinessCheckSchema = z
  .object({
    status: readinessStatusSchema,
    reason_code: z.union([readinessReasonCodeSchema, z.null()]),
  })
  .strict();

const READINESS_CHECK_NAMES = [
  "metadata-valid",
  "credential-source-available",
  "identity-token-current",
  "harness-trusted",
  "provider-principal-verified",
  "expected-tenant-verified",
  "automation-policy-permits",
  "credential-isolation-proven",
] as const;

const readinessChecksSchema = z
  .object({
    "metadata-valid": readinessCheckSchema,
    "credential-source-available": readinessCheckSchema,
    "identity-token-current": readinessCheckSchema,
    "harness-trusted": readinessCheckSchema,
    "provider-principal-verified": readinessCheckSchema,
    "expected-tenant-verified": readinessCheckSchema,
    "automation-policy-permits": readinessCheckSchema,
    "credential-isolation-proven": readinessCheckSchema,
  })
  .strict();

const PROBE_COST_VALUES = [
  "none",
  "provider-request-possible",
  "provider-request-incurred",
] as const;
const readinessProbeCostSchema = z.enum(PROBE_COST_VALUES);

type ReadinessCheck = z.infer<typeof readinessCheckSchema>;
type ReadinessChecks = z.infer<typeof readinessChecksSchema>;

function readinessCheckIs(
  check: ReadinessCheck,
  status: (typeof READINESS_STATUS_VALUES)[number],
  reasonCode: (typeof READINESS_REASON_CODE_VALUES)[number] | null,
): boolean {
  return check.status === status && check.reason_code === reasonCode;
}

function readinessCheckIn(
  check: ReadinessCheck,
  allowed: readonly [
    (typeof READINESS_STATUS_VALUES)[number],
    (typeof READINESS_REASON_CODE_VALUES)[number] | null,
  ][],
): boolean {
  return allowed.some(([status, reasonCode]) => readinessCheckIs(check, status, reasonCode));
}

function addReadinessIssue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

function checkReadinessChecks(checks: ReadinessChecks, context: z.RefinementCtx): void {
  const allowed: Record<keyof ReadinessChecks, readonly [
    (typeof READINESS_STATUS_VALUES)[number],
    (typeof READINESS_REASON_CODE_VALUES)[number] | null,
  ][]> = {
    "metadata-valid": [
      ["pass", null],
      ["fail", "metadata-invalid"],
      ["fail", "unsupported-platform"],
    ],
    "credential-source-available": [
      ["pass", null],
      ["fail", "credential-source-unavailable"],
    ],
    "identity-token-current": [
      ["pass", null],
      ["fail", "identity-token-stale"],
      ["not-applicable", "not-applicable"],
    ],
    "harness-trusted": [
      ["pass", null],
      ["fail", "harness-untrusted"],
      ["fail", "unsupported-platform"],
    ],
    "provider-principal-verified": [
      ["pass", null],
      ["unknown", "principal-unverified"],
      ["unknown", "probe-not-run"],
      ["fail", "principal-mismatch"],
      ["fail", "probe-failed"],
    ],
    "expected-tenant-verified": [
      ["pass", null],
      ["unknown", "expected-tenant-unverified"],
      ["unknown", "probe-not-run"],
      ["fail", "organization-mismatch"],
      ["fail", "workspace-mismatch"],
      ["fail", "probe-failed"],
    ],
    "automation-policy-permits": [
      ["pass", null],
      ["fail", "automation-policy-denied"],
      ["fail", "authentication-exception-required"],
      ["warn", "authentication-exception-acknowledged"],
    ],
    "credential-isolation-proven": [
      ["pass", null],
      ["fail", "isolation-exception-required"],
      ["fail", "isolation-unproven"],
      ["warn", "isolation-exception-acknowledged"],
    ],
  };
  for (const name of READINESS_CHECK_NAMES) {
    if (!readinessCheckIn(checks[name], allowed[name])) {
      addReadinessIssue(
        context,
        ["checks", name],
        "status and reason_code are not a published ctxlane readiness combination",
      );
    }
  }
}

function readinessChecksAreReady(checks: ReadinessChecks): boolean {
  const common = [
    checks["metadata-valid"],
    checks["credential-source-available"],
    checks["harness-trusted"],
    checks["provider-principal-verified"],
    checks["expected-tenant-verified"],
  ].every((check) => readinessCheckIs(check, "pass", null));
  const authentication =
    readinessCheckIs(checks["identity-token-current"], "pass", null) &&
    readinessCheckIs(checks["automation-policy-permits"], "pass", null);
  const nonWifAuthentication =
    readinessCheckIs(checks["identity-token-current"], "not-applicable", "not-applicable") &&
    (readinessCheckIs(checks["automation-policy-permits"], "pass", null) ||
      readinessCheckIs(
        checks["automation-policy-permits"],
        "warn",
        "authentication-exception-acknowledged",
      ));
  const isolation =
    readinessCheckIs(checks["credential-isolation-proven"], "pass", null) ||
    readinessCheckIs(
      checks["credential-isolation-proven"],
      "warn",
      "isolation-exception-acknowledged",
    );
  return common && (authentication || nonWifAuthentication) && isolation;
}

/** Exact ctxlane automation-readiness/v1 observation, never an authority grant. */
export const ctxlaneAutomationReadinessSchema = z
  .object({
    schema: z.literal(CTXLANE_AUTOMATION_READINESS_SCHEMA),
    profile_uid: readinessProfileUidSchema,
    profile_ref: readinessProfileRefSchema,
    provider: readinessProviderSchema,
    auth_mode: readinessAuthModeSchema,
    environment: readinessEnvironmentSchema,
    role: readinessRoleSchema,
    ready: z.boolean(),
    isolation: readinessIsolationSchema,
    authentication_exception_acknowledged: z.boolean(),
    isolation_exception_acknowledged: z.boolean(),
    checked_at: readinessUtcTimestampSchema,
    valid_until: readinessUtcTimestampSchema,
    probe_cost: readinessProbeCostSchema,
    probe_timeout_milliseconds: z.number().int().min(1).max(30_000),
    probe_interactive: z.literal(false),
    checks: readinessChecksSchema,
  })
  .strict()
  .superRefine((value, context) => {
    assertProfileNamespace(context, value.provider, value.profile_ref, ["profile_ref"]);
    if (!isStrictlyBeforeUtc(value.checked_at, value.valid_until)) {
      addReadinessIssue(context, ["valid_until"], "valid_until must be strictly after checked_at");
    }
    if (
      (value.provider === "claude" && !READINESS_CLAUDE_AUTH_MODE_VALUES.includes(value.auth_mode as never)) ||
      (value.provider === "codex" && !READINESS_CODEX_AUTH_MODE_VALUES.includes(value.auth_mode as never))
    ) {
      addReadinessIssue(context, ["auth_mode"], "auth_mode is not supported by provider");
    }
    checkReadinessChecks(value.checks, context);
    const identity = value.checks["identity-token-current"];
    if (value.auth_mode !== "wif" && !readinessCheckIs(identity, "not-applicable", "not-applicable")) {
      addReadinessIssue(context, ["checks", "identity-token-current"], "non-WIF auth must use not-applicable identity check");
    }
    if (value.provider === "claude" && value.checks["expected-tenant-verified"].reason_code === "workspace-mismatch") {
      addReadinessIssue(context, ["checks", "expected-tenant-verified"], "Claude readiness cannot use workspace-mismatch");
    }
    if (value.provider === "codex" && value.checks["expected-tenant-verified"].reason_code === "organization-mismatch") {
      addReadinessIssue(context, ["checks", "expected-tenant-verified"], "Codex readiness cannot use organization-mismatch");
    }
    const isolationCheck = value.checks["credential-isolation-proven"];
    if (value.isolation === "credential-isolated" || value.isolation === "per-lease-isolated") {
      if (value.isolation_exception_acknowledged || !readinessCheckIs(isolationCheck, "pass", null)) {
        addReadinessIssue(context, ["isolation"], "isolated modes require a passing isolation check and no exception acknowledgement");
      }
    } else if (value.isolation === "copied-credential-development") {
      const expected = value.isolation_exception_acknowledged
        ? ["warn", "isolation-exception-acknowledged"] as const
        : ["fail", "isolation-exception-required"] as const;
      if (!readinessCheckIs(isolationCheck, expected[0], expected[1])) {
        addReadinessIssue(context, ["checks", "credential-isolation-proven"], "copied credential mode has an invalid isolation exception state");
      }
      if (value.ready && value.environment !== "local-development" && value.role !== "pr-reviewer") {
        addReadinessIssue(context, ["ready"], "ready copied-credential profiles are limited to local-development or pr-reviewer");
      }
      if (!value.ready && value.environment !== "local-development" && value.role !== "pr-reviewer" && !readinessCheckIs(value.checks["automation-policy-permits"], "fail", "automation-policy-denied")) {
        addReadinessIssue(context, ["checks", "automation-policy-permits"], "copied credentials outside local development require denied automation policy");
      }
    } else if (!readinessCheckIs(isolationCheck, "fail", "isolation-unproven")) {
      addReadinessIssue(context, ["checks", "credential-isolation-proven"], "unproven isolation requires an isolation-unproven failure");
    }
    const computedReady = readinessChecksAreReady(value.checks);
    if (value.ready !== computedReady) {
      addReadinessIssue(context, ["ready"], "ready must exactly match the published readiness checks");
    }
    if (value.ready && value.authentication_exception_acknowledged && value.checks["automation-policy-permits"].reason_code !== "authentication-exception-acknowledged") {
      addReadinessIssue(context, ["authentication_exception_acknowledged"], "acknowledged authentication exception requires its warning check");
    }
    if (!value.authentication_exception_acknowledged && value.checks["automation-policy-permits"].reason_code === "authentication-exception-acknowledged") {
      addReadinessIssue(context, ["authentication_exception_acknowledged"], "authentication exception warning requires acknowledgement");
    }
  });

export type CtxlaneAutomationReadiness = z.infer<typeof ctxlaneAutomationReadinessSchema>;

// `$defs/logSafeId`
const LOG_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$(?![\s\S])/u;
const logSafeIdSchema = z.string().min(1).max(128).regex(LOG_SAFE_ID_PATTERN);

// `$defs/repositoryId`
const REPOSITORY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}:[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._@+-]{0,127})*$(?![\s\S])/u;
const repositoryIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(REPOSITORY_ID_PATTERN);

// `$defs/profileUid`
const PROFILE_UID_PATTERN = /^profile_[0-7][0-9A-HJKMNP-TV-Z]{25}$(?![\s\S])/u;
const profileUidSchema = z.string().regex(PROFILE_UID_PATTERN);

// `$defs/sha256Digest`
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/u;
const sha256DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

// `properties/profile_ref` (shared shape; per-provider namespace is a cross-field check)
const PROFILE_REF_PATTERN =
  /^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/u;
const profileRefSchema = z.string().regex(PROFILE_REF_PATTERN);

// `properties/signature`: unpadded base64url encoding of a 64-byte Ed25519 signature.
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$(?![\s\S])/u;
const signatureSchema = z.string().regex(SIGNATURE_PATTERN);

// `$defs/leaseId` / `$defs/executionHandle`
const LEASE_ID_PATTERN = /^lease_[0-7][0-9A-HJKMNP-TV-Z]{25}$(?![\s\S])/u;
const leaseIdSchema = z.string().regex(LEASE_ID_PATTERN);
const EXECUTION_HANDLE_PATTERN =
  /^exec_[0-7][0-9A-HJKMNP-TV-Z]{25}$(?![\s\S])/u;
const executionHandleSchema = z.string().regex(EXECUTION_HANDLE_PATTERN);

// `$defs/callerSubject` / `$defs/hostIdentity` / `$defs/workerIdentity`
const CALLER_SUBJECT_PATTERN =
  /^caller:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/u;
const callerSubjectSchema = z.string().regex(CALLER_SUBJECT_PATTERN);
const HOST_IDENTITY_PATTERN =
  /^host:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/u;
const hostIdentitySchema = z.string().regex(HOST_IDENTITY_PATTERN);
const WORKER_IDENTITY_PATTERN =
  /^worker:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/u;
const workerIdentitySchema = z.string().regex(WORKER_IDENTITY_PATTERN);

// `$defs/principalRef` / `$defs/workspaceRef`
const PRINCIPAL_REF_PATTERN =
  /^(user|service-account):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/u;
const principalRefSchema = z.string().regex(PRINCIPAL_REF_PATTERN);
const WORKSPACE_REF_PATTERN =
  /^(claude-organization|chatgpt-workspace):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$(?![\s\S])/u;
const workspaceRefSchema = z.string().regex(WORKSPACE_REF_PATTERN);

// `$defs/isolation`
const ISOLATION_VALUES = [
  "credential-isolated",
  "per-lease-isolated",
  "copied-credential-development",
  "unproven",
] as const;
const isolationSchema = z.enum(ISOLATION_VALUES);
// `resolvedAttribution.isolation`: every resolved status excludes `unproven`.
const RESOLVED_ISOLATION_VALUES = [
  "credential-isolated",
  "per-lease-isolated",
  "copied-credential-development",
] as const;
const resolvedIsolationSchema = z.enum(RESOLVED_ISOLATION_VALUES);

// `$defs/authMode`
const AUTH_MODE_VALUES = [
  "wif",
  "subscription-token",
  "api-key",
  "chatgpt-oauth",
  "access-token",
] as const;
const authModeSchema = z.enum(AUTH_MODE_VALUES);
const CLAUDE_AUTH_MODE_VALUES = [
  "wif",
  "subscription-token",
  "api-key",
] as const;
const CODEX_AUTH_MODE_VALUES = [
  "wif",
  "chatgpt-oauth",
  "api-key",
  "access-token",
] as const;

// `$defs/refusalCode`
const REFUSAL_CODE_VALUES = [
  "work-order-proof-invalid",
  "work-order-authorization-mismatch",
  "requested-ttl-not-allowed",
  "policy-digest-mismatch",
  "profile-not-found",
  "provider-mismatch",
  "profile-not-eligible",
  "authentication-exception-required",
  "isolation-exception-required",
  "environment-not-allowed",
  "role-not-allowed",
  "caller-not-allowed",
  "repository-not-allowed",
  "profile-not-ready",
  "identity-token-stale",
  "harness-untrusted",
  "principal-unverified",
  "principal-mismatch",
  "organization-mismatch",
  "workspace-mismatch",
  "isolation-unproven",
  "capacity-exceeded",
] as const;
export type CtxlaneRefusalCode = (typeof REFUSAL_CODE_VALUES)[number];
const refusalCodeSchema = z.enum(REFUSAL_CODE_VALUES);

// `$defs/reasonCode`
const CLOSED_REASON_CODE_VALUES = ["completed", "worker-failed"] as const;
const EXPIRED_REASON_CODE_VALUES = [
  "lease-expired",
  "maximum-lifetime-reached",
] as const;
const REVOKED_REASON_CODE_VALUES = [
  "operator-revoked",
  "policy-revoked",
  "principal-mismatch",
  "heartbeat-lost",
  "process-unverifiable",
  "generation-superseded",
  "renewal-acknowledgement-failed",
  "service-recovery",
] as const;
const ERROR_REASON_CODE_VALUES = [
  "process-unverifiable",
  "service-recovery",
  "internal-error",
] as const;
const ALL_REASON_CODE_VALUES = [
  ...CLOSED_REASON_CODE_VALUES,
  ...EXPIRED_REASON_CODE_VALUES,
  ...REVOKED_REASON_CODE_VALUES,
  ...ERROR_REASON_CODE_VALUES,
] as const;
export type CtxlaneReasonCode = (typeof ALL_REASON_CODE_VALUES)[number];
const reasonCodeSchema = z.enum(ALL_REASON_CODE_VALUES);

// `properties/*_at`: canonical UTC RFC 3339. `format: date-time` is normative
// for this contract, so this checks real calendar validity, not only the
// regex shape (Feb 30, a >31 day-of-month, etc. must fail).
const UTC_TIMESTAMP_PATTERN =
  /^(?!0000-)([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-5][0-9])(\.[0-9]{1,9})?Z$(?![\s\S])/u;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maxDay = daysInMonth[month - 1];
  if (maxDay === undefined || day < 1 || day > maxDay) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  return true;
}

/**
 * Proleptic-Gregorian day count since the Unix epoch (1970-01-01), for a
 * calendar date already proven valid by `isCanonicalUtcTimestamp`.
 *
 * This contract allows years 0001-9999, including years below 100. `Date.UTC`
 * silently coerces a two-digit year (`0`-`99`) into `1900`-`1999` (a
 * historical `Date` constructor quirk it inherits), which would corrupt the
 * ordering key for e.g. `"0050-01-01T00:00:00Z"`. Howard Hinnant's
 * `days_from_civil` algorithm computes the day count directly from the
 * calendar fields instead, so no `Date`/`Date.UTC` call is ever involved.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthOfYear = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

const utcTimestampSchema = z
  .string()
  .refine(
    isCanonicalUtcTimestamp,
    "must be a canonical UTC RFC 3339 timestamp",
  );

/**
 * Exact, monotonic ordering key for a canonical UTC timestamp, expressed as
 * whole nanoseconds since the Unix epoch.
 *
 * `Date.parse` truncates to millisecond resolution, so two contract
 * timestamps that differ only in their sub-millisecond fractional digits
 * (this contract allows 1-9 fractional digits, i.e. up to nanoseconds) would
 * compare equal or invert their true order under it. This function decodes
 * the same regex capture groups `isCanonicalUtcTimestamp` already validated
 * and combines the whole-second epoch value with the exact fractional
 * nanosecond remainder as a `bigint`, so contract-to-contract ordering
 * comparisons never lose precision. Callers must validate the value with
 * `isCanonicalUtcTimestamp` (directly or via `utcTimestampSchema`) first;
 * this function throws on anything else.
 */
export function utcTimestampOrderKey(value: string): bigint {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null || !isCanonicalUtcTimestamp(value)) {
    throw new RangeError("value is not a canonical UTC RFC 3339 timestamp");
  }
  const [, year, month, day, hour, minute, second, fraction] =
    match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
    ];
  const days = daysFromCivil(Number(year), Number(month), Number(day));
  const epochSeconds =
    BigInt(days) * 86_400n +
    BigInt(hour) * 3_600n +
    BigInt(minute) * 60n +
    BigInt(second);
  const fractionDigits = fraction === undefined ? "" : fraction.slice(1);
  const nanosecondRemainder = BigInt(fractionDigits.padEnd(9, "0") || "0");
  return epochSeconds * 1_000_000_000n + nanosecondRemainder;
}

/** `true` when `a` is strictly before `b`, compared at exact nanosecond precision. */
export function isStrictlyBeforeUtc(a: string, b: string): boolean {
  return utcTimestampOrderKey(a) < utcTimestampOrderKey(b);
}

/** `true` when `a` is at or before `b`, compared at exact nanosecond precision. */
export function isAtOrBeforeUtc(a: string, b: string): boolean {
  return utcTimestampOrderKey(a) <= utcTimestampOrderKey(b);
}

/**
 * Exact nanosecond duration from `from` to `to`, compared at the same
 * nanosecond precision as `utcTimestampOrderKey`. Negative when `to` is
 * before `from`.
 */
export function utcTimestampNanosecondDelta(from: string, to: string): bigint {
  return utcTimestampOrderKey(to) - utcTimestampOrderKey(from);
}

function issue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

function assertProfileNamespace(
  context: z.RefinementCtx,
  provider: CtxlaneProvider,
  profileRef: string,
  path: readonly PropertyKey[],
): void {
  if (!profileRef.startsWith(`${provider}:`)) {
    issue(
      context,
      path,
      "profile_ref must be namespaced to the exact provider",
    );
  }
}

/** `ctxlane.work-order-authorization/v1` */
export const ctxlaneWorkOrderAuthorizationSchema = z
  .object({
    schema: z.literal(CTXLANE_WORK_ORDER_AUTHORIZATION_SCHEMA),
    algorithm: z.literal("ed25519"),
    key_id: logSafeIdSchema,
    client_request_id: logSafeIdSchema,
    tenant_id: logSafeIdSchema,
    work_order_id: logSafeIdSchema,
    work_order_digest: sha256DigestSchema,
    run_id: logSafeIdSchema,
    attempt_id: logSafeIdSchema,
    role: roleSchema,
    provider: providerSchema,
    profile_uid: profileUidSchema,
    profile_ref: profileRefSchema,
    repository: repositoryIdSchema,
    workspace_id: logSafeIdSchema,
    environment: logSafeIdSchema,
    not_before: utcTimestampSchema,
    expires_at: utcTimestampSchema,
    maximum_ttl_seconds: z.number().int().min(1).max(86_400),
    maximum_session_seconds: z.number().int().min(1).max(4_294_967_295),
    signature: signatureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    assertProfileNamespace(context, value.provider, value.profile_ref, [
      "profile_ref",
    ]);
    const bothTimestampsCanonical =
      isCanonicalUtcTimestamp(value.not_before) &&
      isCanonicalUtcTimestamp(value.expires_at);
    const strictlyOrdered = bothTimestampsCanonical
      ? isStrictlyBeforeUtc(value.not_before, value.expires_at)
      : false;
    if (bothTimestampsCanonical && !strictlyOrdered) {
      issue(
        context,
        ["expires_at"],
        "expires_at must be strictly after not_before",
      );
    }
    if (value.maximum_ttl_seconds > value.maximum_session_seconds) {
      issue(
        context,
        ["maximum_ttl_seconds"],
        "maximum_ttl_seconds must not exceed maximum_session_seconds",
      );
    }
    if (strictlyOrdered) {
      const signedIntervalNanoseconds =
        utcTimestampOrderKey(value.expires_at) -
        utcTimestampOrderKey(value.not_before);
      const maximumSessionNanoseconds =
        BigInt(value.maximum_session_seconds) * 1_000_000_000n;
      if (maximumSessionNanoseconds > signedIntervalNanoseconds) {
        issue(
          context,
          ["maximum_session_seconds"],
          "maximum_session_seconds must not outlive the signed not_before/expires_at interval",
        );
      }
    }
  });

export type CtxlaneWorkOrderAuthorization = z.infer<
  typeof ctxlaneWorkOrderAuthorizationSchema
>;

// The 13 fields the request duplicates from its embedded
// `work_order_authorization`, so a caller cannot bind a valid signed
// authorization to different top-level request identity/routing fields.
// Only these overlap: `schema` differs by contract, and
// `requested_ttl_seconds`/`policy_digest` have no authorization counterpart.
const REQUEST_AUTHORIZATION_DUPLICATED_FIELDS = [
  "client_request_id",
  "tenant_id",
  "work_order_id",
  "work_order_digest",
  "run_id",
  "attempt_id",
  "role",
  "provider",
  "profile_uid",
  "profile_ref",
  "repository",
  "workspace_id",
  "environment",
] as const;

/** `ctxlane.identity-lease-request/v1` */
export const ctxlaneIdentityLeaseRequestSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_REQUEST_SCHEMA),
    client_request_id: logSafeIdSchema,
    tenant_id: logSafeIdSchema,
    work_order_id: logSafeIdSchema,
    work_order_digest: sha256DigestSchema,
    work_order_authorization: ctxlaneWorkOrderAuthorizationSchema,
    run_id: logSafeIdSchema,
    attempt_id: logSafeIdSchema,
    role: roleSchema,
    provider: providerSchema,
    profile_uid: profileUidSchema,
    profile_ref: profileRefSchema,
    repository: repositoryIdSchema,
    workspace_id: logSafeIdSchema,
    environment: logSafeIdSchema,
    requested_ttl_seconds: z.number().int().min(1).max(86_400),
    policy_digest: z.union([sha256DigestSchema, z.null()]),
  })
  .strict()
  .superRefine((value, context) => {
    assertProfileNamespace(context, value.provider, value.profile_ref, [
      "profile_ref",
    ]);
    for (const field of REQUEST_AUTHORIZATION_DUPLICATED_FIELDS) {
      if (value[field] !== value.work_order_authorization[field]) {
        issue(
          context,
          [field],
          `${field} must match the embedded work_order_authorization.${field}`,
        );
      }
    }
    if (
      value.requested_ttl_seconds >
      value.work_order_authorization.maximum_ttl_seconds
    ) {
      issue(
        context,
        ["requested_ttl_seconds"],
        "requested_ttl_seconds must not exceed work_order_authorization.maximum_ttl_seconds",
      );
    }
    if (
      value.requested_ttl_seconds >
      value.work_order_authorization.maximum_session_seconds
    ) {
      issue(
        context,
        ["requested_ttl_seconds"],
        "requested_ttl_seconds must not exceed work_order_authorization.maximum_session_seconds",
      );
    }
  });

export type CtxlaneIdentityLeaseRequest = z.infer<
  typeof ctxlaneIdentityLeaseRequestSchema
>;

// The lifecycle parameter schemas are deliberately separate from the
// authority-bearing in-process lifecycle interface in `ctxlane-broker.ts`.
// They are the exact public ctxlane operation shapes: no `schema` member is
// present because these objects are operation parameters, and no capability
// is returned by their corresponding MCP receipts.
const lifecycleClientRequestIdSchema = logSafeIdSchema;
const lifecycleLeaseIdSchema = leaseIdSchema;

/** `ctxlane.identity-lease-renew.v1` parameters. */
export const ctxlaneIdentityLeaseRenewSchema = z
  .object({
    client_request_id: lifecycleClientRequestIdSchema,
    lease_id: lifecycleLeaseIdSchema,
    requested_ttl_seconds: z.number().int().min(1).max(86_400),
  })
  .strict();

export type CtxlaneIdentityLeaseRenew = z.infer<
  typeof ctxlaneIdentityLeaseRenewSchema
>;

/** `ctxlane.identity-lease-revoke.v1` parameters. */
export const ctxlaneIdentityLeaseRevokeSchema = z
  .object({
    client_request_id: lifecycleClientRequestIdSchema,
    lease_id: lifecycleLeaseIdSchema,
  })
  .strict();

export type CtxlaneIdentityLeaseRevoke = z.infer<
  typeof ctxlaneIdentityLeaseRevokeSchema
>;

/** `ctxlane.identity-lease-close.v1` parameters. */
export const ctxlaneIdentityLeaseCloseSchema = z
  .object({
    client_request_id: lifecycleClientRequestIdSchema,
    lease_id: lifecycleLeaseIdSchema,
    reason: z.enum(["completed", "worker-failed"]),
  })
  .strict();

export type CtxlaneIdentityLeaseClose = z.infer<
  typeof ctxlaneIdentityLeaseCloseSchema
>;

/** `ctxlane.identity-lease-inspect.v1` parameters. */
export const ctxlaneIdentityLeaseInspectSchema = z
  .object({
    client_request_id: lifecycleClientRequestIdSchema,
    lease_id: lifecycleLeaseIdSchema,
  })
  .strict();

export type CtxlaneIdentityLeaseInspect = z.infer<
  typeof ctxlaneIdentityLeaseInspectSchema
>;

/** `ctxlane.identity-lease-renew-acknowledgement.v1`. */
export const ctxlaneIdentityLeaseRenewAcknowledgementSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_RENEW_ACKNOWLEDGEMENT_SCHEMA),
    lease_id: lifecycleLeaseIdSchema,
    fencing_generation: z.number()
      .int()
      .min(1)
      .max(9_007_199_254_740_991),
  })
  .strict();

export type CtxlaneIdentityLeaseRenewAcknowledgement = z.infer<
  typeof ctxlaneIdentityLeaseRenewAcknowledgementSchema
>;

// `ctxlane.lease-view/v1` intentionally has broader identifier patterns than
// the authority-bearing identity lease. Transcribe those patterns exactly;
// do not reuse the stricter lease/profile UID schemas and accidentally reject
// a valid capability-free inspection result.
const leaseViewLabelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$(?![\s\S])/u);
const leaseViewDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$(?![\s\S])/u);
const leaseViewTimestampSchema = utcTimestampSchema;
const leaseViewStatusSchema = z.enum([
  "requested",
  "active",
  "renewing",
  "closed",
  "revoked",
  "expired",
  "refused",
  "error",
]);
const leaseViewProfileUidSchema = z
  .string()
  .regex(/^profile_[A-Za-z0-9]{26}$(?![\s\S])/u);
const leaseViewProfileRefSchema = z
  .string()
  .regex(/^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/u);
const leaseViewRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$(?![\s\S])/u);
const leaseViewCallerSubjectSchema = z
  .string()
  .regex(/^caller:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$(?![\s\S])/u);
const leaseViewHostIdentitySchema = z
  .string()
  .regex(/^host:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$(?![\s\S])/u);
const leaseViewWorkerIdentitySchema = z
  .string()
  .regex(/^worker:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$(?![\s\S])/u);
const leaseViewPrincipalRefSchema = z
  .string()
  .regex(/^(user|service-account):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$(?![\s\S])/u);
const leaseViewWorkspaceRefSchema = z
  .string()
  .regex(/^(claude-organization|chatgpt-workspace):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$(?![\s\S])/u);
const leaseViewAuthModeSchema = z.enum([
  "wif",
  "subscription-token",
  "api-key",
  "chatgpt-oauth",
  "access-token",
]);
const leaseViewIsolationSchema = z.enum([
  "credential-isolated",
  "per-lease-isolated",
  "unproven",
  "copied-credential-development",
]);
const leaseViewReasonCodeSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$(?![\s\S])/u);

/** `ctxlane.lease-view/v1`, the capability-free lifecycle/inspection view. */
export const ctxlaneLeaseViewSchema = z
  .object({
    schema: z.literal(CTXLANE_LEASE_VIEW_SCHEMA),
    lease_id: z.string().regex(/^lease_[A-Za-z0-9]{26}$(?![\s\S])/u),
    status: leaseViewStatusSchema,
    tenant_id: leaseViewLabelSchema,
    work_order_id: leaseViewLabelSchema,
    work_order_digest: leaseViewDigestSchema,
    run_id: leaseViewLabelSchema,
    attempt_id: leaseViewLabelSchema,
    role: roleSchema,
    provider: providerSchema,
    profile_uid: leaseViewProfileUidSchema,
    profile_ref: leaseViewProfileRefSchema,
    repository: leaseViewRepositorySchema,
    workspace_id: leaseViewLabelSchema,
    environment: leaseViewLabelSchema,
    caller_subject: leaseViewCallerSubjectSchema,
    host_identity: leaseViewHostIdentitySchema,
    worker_identity: z.union([leaseViewWorkerIdentitySchema, z.null()]),
    principal_ref: z.union([leaseViewPrincipalRefSchema, z.null()]),
    workspace_ref: z.union([leaseViewWorkspaceRefSchema, z.null()]),
    auth_mode: z.union([leaseViewAuthModeSchema, z.null()]),
    issued_at: leaseViewTimestampSchema,
    expires_at: z.union([leaseViewTimestampSchema, z.null()]),
    maximum_expires_at: z.union([leaseViewTimestampSchema, z.null()]),
    isolation: z.union([leaseViewIsolationSchema, z.null()]),
    effective_policy_digest: z.union([leaseViewDigestSchema, z.null()]),
    refusal_code: z.union([leaseViewReasonCodeSchema, z.null()]),
    reason_code: z.union([leaseViewReasonCodeSchema, z.null()]),
  })
  .strict();

export type CtxlaneLeaseView = z.infer<typeof ctxlaneLeaseViewSchema>;

// Receipt schemas are aliases in the published contract: each receipt
// references the same capability-free lease-view object.
export const ctxlaneIdentityLeaseRenewReceiptSchema = ctxlaneLeaseViewSchema;
export const ctxlaneIdentityLeaseRevokeReceiptSchema = ctxlaneLeaseViewSchema;
export const ctxlaneIdentityLeaseCloseReceiptSchema = ctxlaneLeaseViewSchema;
export const ctxlaneIdentityLeaseInspectReceiptSchema = ctxlaneLeaseViewSchema;

export type CtxlaneIdentityLeaseRenewReceipt = CtxlaneLeaseView;
export type CtxlaneIdentityLeaseRevokeReceipt = CtxlaneLeaseView;
export type CtxlaneIdentityLeaseCloseReceipt = CtxlaneLeaseView;
export type CtxlaneIdentityLeaseInspectReceipt = CtxlaneLeaseView;

const CTXLANE_LEASE_STATUS_VALUES = [
  "requested",
  "active",
  "renewing",
  "closed",
  "revoked",
  "expired",
  "refused",
  "error",
] as const;
export type CtxlaneLeaseStatus = (typeof CTXLANE_LEASE_STATUS_VALUES)[number];
const statusSchema = z.enum(CTXLANE_LEASE_STATUS_VALUES);

const NULL_ONLY_ATTRIBUTION_FIELDS = [
  "worker_identity",
  "principal_ref",
  "workspace_ref",
  "auth_mode",
  "fencing_generation",
  "expires_at",
  "maximum_expires_at",
  "execution_handle",
  "isolation",
  "effective_policy_digest",
] as const;

const RESOLVED_ATTRIBUTION_FIELDS = [
  "principal_ref",
  "workspace_ref",
  "auth_mode",
  "fencing_generation",
  "expires_at",
  "maximum_expires_at",
  "isolation",
  "effective_policy_digest",
] as const;

/** `ctxlane.identity-lease/v1` */
export const ctxlaneIdentityLeaseSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_SCHEMA),
    lease_id: leaseIdSchema,
    status: statusSchema,
    tenant_id: logSafeIdSchema,
    work_order_id: logSafeIdSchema,
    work_order_digest: sha256DigestSchema,
    run_id: logSafeIdSchema,
    attempt_id: logSafeIdSchema,
    role: roleSchema,
    provider: providerSchema,
    profile_uid: profileUidSchema,
    profile_ref: profileRefSchema,
    repository: repositoryIdSchema,
    workspace_id: logSafeIdSchema,
    environment: logSafeIdSchema,
    caller_subject: callerSubjectSchema,
    host_identity: hostIdentitySchema,
    worker_identity: z.union([workerIdentitySchema, z.null()]),
    principal_ref: z.union([principalRefSchema, z.null()]),
    workspace_ref: z.union([workspaceRefSchema, z.null()]),
    auth_mode: z.union([authModeSchema, z.null()]),
    fencing_generation: z.union([
      z.number().int().min(1).max(9_007_199_254_740_991),
      z.null(),
    ]),
    issued_at: utcTimestampSchema,
    expires_at: z.union([utcTimestampSchema, z.null()]),
    maximum_expires_at: z.union([utcTimestampSchema, z.null()]),
    execution_handle: z.union([executionHandleSchema, z.null()]),
    isolation: z.union([isolationSchema, z.null()]),
    effective_policy_digest: z.union([sha256DigestSchema, z.null()]),
    refusal_code: z.union([refusalCodeSchema, z.null()]),
    reason_code: z.union([reasonCodeSchema, z.null()]),
  })
  .strict()
  .superRefine((value, context) => {
    assertProfileNamespace(context, value.provider, value.profile_ref, [
      "profile_ref",
    ]);
    if (value.provider === "claude") {
      if (
        value.auth_mode !== null &&
        !(CLAUDE_AUTH_MODE_VALUES as readonly string[]).includes(
          value.auth_mode,
        )
      ) {
        issue(
          context,
          ["auth_mode"],
          "auth_mode is not permitted for the claude provider",
        );
      }
      if (
        value.workspace_ref !== null &&
        !value.workspace_ref.startsWith("claude-organization:")
      ) {
        issue(
          context,
          ["workspace_ref"],
          "workspace_ref must be a claude-organization reference",
        );
      }
    } else {
      if (
        value.auth_mode !== null &&
        !(CODEX_AUTH_MODE_VALUES as readonly string[]).includes(value.auth_mode)
      ) {
        issue(
          context,
          ["auth_mode"],
          "auth_mode is not permitted for the codex provider",
        );
      }
      if (
        value.workspace_ref !== null &&
        !value.workspace_ref.startsWith("chatgpt-workspace:")
      ) {
        issue(
          context,
          ["workspace_ref"],
          "workspace_ref must be a chatgpt-workspace reference",
        );
      }
    }
    if (
      value.refusal_code === "organization-mismatch" &&
      value.provider !== "claude"
    ) {
      issue(
        context,
        ["refusal_code"],
        "organization-mismatch is only valid for the claude provider",
      );
    }
    if (
      value.refusal_code === "workspace-mismatch" &&
      value.provider !== "codex"
    ) {
      issue(
        context,
        ["refusal_code"],
        "workspace-mismatch is only valid for the codex provider",
      );
    }
    if (
      value.isolation === "copied-credential-development" &&
      value.environment !== "local-development" &&
      value.role !== "pr-reviewer"
    ) {
      issue(
        context,
        ["isolation"],
        "copied-credential-development requires local-development or the pr-reviewer role",
      );
    }

    const assertNull = (fields: readonly string[]): void => {
      for (const field of fields) {
        if ((value as Record<string, unknown>)[field] !== null) {
          issue(
            context,
            [field],
            `${field} must be null for status ${value.status}`,
          );
        }
      }
    };
    const assertResolvedAttribution = (): void => {
      for (const field of RESOLVED_ATTRIBUTION_FIELDS) {
        if ((value as Record<string, unknown>)[field] === null) {
          issue(
            context,
            [field],
            `${field} must not be null for status ${value.status}`,
          );
        }
      }
      if (
        value.isolation !== null &&
        !resolvedIsolationSchema.safeParse(value.isolation).success
      ) {
        issue(
          context,
          ["isolation"],
          "isolation must not be unproven for a resolved status",
        );
      }
      if (
        value.issued_at !== null &&
        value.expires_at !== null &&
        isCanonicalUtcTimestamp(value.issued_at) &&
        isCanonicalUtcTimestamp(value.expires_at)
      ) {
        if (!isStrictlyBeforeUtc(value.issued_at, value.expires_at)) {
          issue(
            context,
            ["expires_at"],
            "expires_at must be strictly after issued_at",
          );
        }
      }
      if (
        value.expires_at !== null &&
        value.maximum_expires_at !== null &&
        isCanonicalUtcTimestamp(value.expires_at) &&
        isCanonicalUtcTimestamp(value.maximum_expires_at)
      ) {
        if (!isAtOrBeforeUtc(value.expires_at, value.maximum_expires_at)) {
          issue(
            context,
            ["maximum_expires_at"],
            "maximum_expires_at must not be before expires_at",
          );
        }
      }
    };

    switch (value.status) {
      case "requested": {
        assertNull(NULL_ONLY_ATTRIBUTION_FIELDS);
        if (value.refusal_code !== null)
          issue(context, ["refusal_code"], "must be null when requested");
        if (value.reason_code !== null)
          issue(context, ["reason_code"], "must be null when requested");
        break;
      }
      case "refused": {
        assertNull(NULL_ONLY_ATTRIBUTION_FIELDS);
        if (value.refusal_code === null) {
          issue(
            context,
            ["refusal_code"],
            "refused status requires a refusal_code",
          );
        }
        if (value.reason_code !== null)
          issue(context, ["reason_code"], "must be null when refused");
        break;
      }
      case "active":
      case "renewing": {
        assertResolvedAttribution();
        if (value.execution_handle === null) {
          issue(
            context,
            ["execution_handle"],
            "execution_handle must not be null while active",
          );
        }
        if (value.refusal_code !== null)
          issue(
            context,
            ["refusal_code"],
            "must be null for a resolved status",
          );
        if (value.reason_code !== null)
          issue(context, ["reason_code"], "must be null for this status");
        break;
      }
      case "closed": {
        assertResolvedAttribution();
        if (value.execution_handle !== null) {
          issue(
            context,
            ["execution_handle"],
            "execution_handle must be null once closed",
          );
        }
        if (value.refusal_code !== null)
          issue(
            context,
            ["refusal_code"],
            "must be null for a resolved status",
          );
        if (
          value.reason_code === null ||
          !(CLOSED_REASON_CODE_VALUES as readonly string[]).includes(
            value.reason_code,
          )
        ) {
          issue(
            context,
            ["reason_code"],
            "closed status requires a closed reason_code",
          );
        }
        break;
      }
      case "expired": {
        assertResolvedAttribution();
        if (value.execution_handle !== null) {
          issue(
            context,
            ["execution_handle"],
            "execution_handle must be null once expired",
          );
        }
        if (value.refusal_code !== null)
          issue(
            context,
            ["refusal_code"],
            "must be null for a resolved status",
          );
        if (
          value.reason_code === null ||
          !(EXPIRED_REASON_CODE_VALUES as readonly string[]).includes(
            value.reason_code,
          )
        ) {
          issue(
            context,
            ["reason_code"],
            "expired status requires an expired reason_code",
          );
        }
        break;
      }
      case "revoked": {
        assertResolvedAttribution();
        if (value.execution_handle !== null) {
          issue(
            context,
            ["execution_handle"],
            "execution_handle must be null once revoked",
          );
        }
        if (value.refusal_code !== null)
          issue(
            context,
            ["refusal_code"],
            "must be null for a resolved status",
          );
        if (
          value.reason_code === null ||
          !(REVOKED_REASON_CODE_VALUES as readonly string[]).includes(
            value.reason_code,
          )
        ) {
          issue(
            context,
            ["reason_code"],
            "revoked status requires a revoked reason_code",
          );
        }
        break;
      }
      case "error": {
        assertResolvedAttribution();
        if (value.execution_handle !== null) {
          issue(
            context,
            ["execution_handle"],
            "execution_handle must be null in the error state",
          );
        }
        if (value.refusal_code !== null)
          issue(
            context,
            ["refusal_code"],
            "must be null for a resolved status",
          );
        if (
          value.reason_code === null ||
          !(ERROR_REASON_CODE_VALUES as readonly string[]).includes(
            value.reason_code,
          )
        ) {
          issue(
            context,
            ["reason_code"],
            "error status requires an error reason_code",
          );
        }
        break;
      }
    }
  });

export type CtxlaneIdentityLease = z.infer<typeof ctxlaneIdentityLeaseSchema>;

/**
 * Exact, capability-free ctxlane profile-list/v1 projection. A listed profile
 * is metadata only; this object contains no credential, lease, or execution
 * authority and cannot be used to skip a fresh readiness evaluation.
 */
export const CTXLANE_PROFILE_LIST_SCHEMA = "ctxlane.profile-list/v1" as const;

const profileListConcurrencyModeSchema = z.enum(["exclusive", "shared"] as const);
const profileListSharedStateIsolationSchema = z.union([
  z.enum(["stateless", "per-lease-isolated"] as const),
  z.null(),
]);

const ctxlaneProfileListEntrySchema = z
  .object({
    profile_uid: profileUidSchema,
    profile_ref: profileRefSchema,
    provider: providerSchema,
    auth_mode: authModeSchema,
    eligible: z.boolean(),
    environment_count: z.number().int().min(0).max(32),
    roles: z.array(roleSchema).max(3),
    caller_subject_count: z.number().int().min(0).max(64),
    lease_ttl_seconds: z.number().int().min(1).max(86_400),
    max_session_seconds: z.number().int().min(1).max(604_800),
    max_concurrent_leases: z.number().int().min(1).max(64),
    concurrency_mode: profileListConcurrencyModeSchema,
    shared_state_isolation_requirement: profileListSharedStateIsolationSchema,
    require_workload_identity: z.boolean(),
    authentication_exception_acknowledged: z.boolean(),
    isolation_exception_acknowledged: z.boolean(),
  })
  .strict()
  .superRefine((profile, context) => {
    assertProfileNamespace(context, profile.provider, profile.profile_ref, ["profile_ref"]);
    if (new Set(profile.roles).size !== profile.roles.length) {
      issue(context, ["roles"], "roles must contain unique values");
    }
    if (
      profile.provider === "claude" &&
      !(CLAUDE_AUTH_MODE_VALUES as readonly string[]).includes(profile.auth_mode)
    ) {
      issue(context, ["auth_mode"], "auth_mode is not supported by Claude");
    }
    if (
      profile.provider === "codex" &&
      !(CODEX_AUTH_MODE_VALUES as readonly string[]).includes(profile.auth_mode)
    ) {
      issue(context, ["auth_mode"], "auth_mode is not supported by Codex");
    }
    if (profile.concurrency_mode === "exclusive") {
      if (profile.max_concurrent_leases !== 1) {
        issue(context, ["max_concurrent_leases"], "exclusive profiles must allow exactly one lease");
      }
      if (profile.shared_state_isolation_requirement !== null) {
        issue(context, ["shared_state_isolation_requirement"], "exclusive profiles must not declare shared-state isolation");
      }
    } else {
      if (profile.max_concurrent_leases < 2) {
        issue(context, ["max_concurrent_leases"], "shared profiles must allow at least two leases");
      }
      if (profile.shared_state_isolation_requirement === null) {
        issue(context, ["shared_state_isolation_requirement"], "shared profiles must declare shared-state isolation");
      }
    }
    if (profile.eligible) {
      if (profile.environment_count < 1) {
        issue(context, ["environment_count"], "eligible profiles must expose at least one environment");
      }
      if (profile.roles.length < 1) {
        issue(context, ["roles"], "eligible profiles must expose at least one role");
      }
      if (profile.caller_subject_count < 1) {
        issue(context, ["caller_subject_count"], "eligible profiles must expose at least one caller subject");
      }
    }
    if ((profile.auth_mode === "wif" || profile.require_workload_identity) && profile.authentication_exception_acknowledged) {
      issue(context, ["authentication_exception_acknowledged"], "WIF or workload-identity-required profiles cannot acknowledge an authentication exception");
    }
  });

export const ctxlaneProfileListSchema = z
  .object({
    schema: z.literal(CTXLANE_PROFILE_LIST_SCHEMA),
    profiles: z.array(ctxlaneProfileListEntrySchema),
  })
  .strict();

export type CtxlaneProfileListEntry = z.infer<typeof ctxlaneProfileListEntrySchema>;
export type CtxlaneProfileList = z.infer<typeof ctxlaneProfileListSchema>;

// `ctxlane.automation-error/v1`: pre-attribution failures, transcribed
// field-for-field from the vendored JSON Schema's `oneOf` operation/code/
// lease_id combinations (see
// `test/fixtures/ctxlane/schemas/ctxlane.automation-error.v1.schema.json`).
export const CTXLANE_AUTOMATION_ERROR_SCHEMA =
  "ctxlane.automation-error/v1" as const;

const AUTOMATION_ERROR_OPERATION_VALUES = [
  "profile-list",
  "profile-readiness",
  "profile-resolve",
  "lease-acquire",
  "lease-inspect",
  "lease-renew",
  "lease-revoke",
  "lease-close",
  "service-health",
  "execution-start",
] as const;
export type CtxlaneAutomationErrorOperation =
  (typeof AUTOMATION_ERROR_OPERATION_VALUES)[number];
const automationErrorOperationSchema = z.enum(
  AUTOMATION_ERROR_OPERATION_VALUES,
);

// `$defs/commonCode`
const COMMON_ERROR_CODE_VALUES = [
  "invalid-request",
  "unsupported-schema",
  "caller-unauthenticated",
  "caller-unauthorized",
  "rate-limited",
  "service-recovering",
  "unsupported-platform",
  "store-unavailable",
  "internal-error",
] as const;
// `properties/operation` branch: `profile-readiness`
const PROFILE_READINESS_ERROR_CODE_VALUES = [
  "profile-not-found",
  "provider-mismatch",
] as const;
// `$defs/profileResolveCode`
const PROFILE_RESOLVE_ERROR_CODE_VALUES = [
  "profile-not-found",
  "provider-mismatch",
  "profile-not-eligible",
  "authentication-exception-required",
  "isolation-exception-required",
  "environment-not-allowed",
  "role-not-allowed",
  "caller-not-allowed",
  "repository-not-allowed",
  "profile-not-ready",
  "identity-token-stale",
  "harness-untrusted",
  "principal-unverified",
  "principal-mismatch",
  "organization-mismatch",
  "workspace-mismatch",
  "isolation-unproven",
] as const;
// `properties/operation` branch: `lease-acquire`
const LEASE_ACQUIRE_ERROR_CODE_VALUES = ["idempotency-conflict"] as const;
// `properties/operation` branch: `lease-inspect`
const LEASE_INSPECT_ERROR_CODE_VALUES = ["lease-not-found"] as const;
// `$defs/leaseMutationCode`
const LEASE_MUTATION_ERROR_CODE_VALUES = [
  "lease-not-found",
  "lease-not-active",
  "lease-expired",
  "lease-revoked",
  "generation-mismatch",
  "run-mismatch",
  "role-mismatch",
  "tenant-mismatch",
  "host-mismatch",
  "session-limit-reached",
] as const;
// `properties/operation` branch: `lease-revoke`
const LEASE_REVOKE_ERROR_CODE_VALUES = [
  "lease-not-found",
  "lease-not-active",
] as const;
// `$defs/leaseCloseCode`
const LEASE_CLOSE_ERROR_CODE_VALUES = [
  "lease-not-found",
  "lease-not-active",
  "lease-expired",
  "lease-revoked",
  "generation-mismatch",
  "run-mismatch",
  "role-mismatch",
  "tenant-mismatch",
  "host-mismatch",
] as const;
// `$defs/executionStartCode`
const EXECUTION_START_ERROR_CODE_VALUES = [
  "lease-not-found",
  "lease-not-active",
  "lease-expired",
  "lease-revoked",
  "generation-mismatch",
  "run-mismatch",
  "role-mismatch",
  "tenant-mismatch",
  "host-mismatch",
  "session-limit-reached",
  "profile-not-ready",
  "identity-token-stale",
  "harness-untrusted",
  "principal-unverified",
  "principal-mismatch",
  "organization-mismatch",
  "workspace-mismatch",
  "isolation-unproven",
] as const;

// `properties/code` (top-level enum): the full, deduplicated union of every
// code legal for at least one operation.
const AUTOMATION_ERROR_CODE_VALUES = [
  ...COMMON_ERROR_CODE_VALUES,
  "profile-not-found",
  "provider-mismatch",
  "profile-not-eligible",
  "authentication-exception-required",
  "isolation-exception-required",
  "environment-not-allowed",
  "role-not-allowed",
  "caller-not-allowed",
  "repository-not-allowed",
  "profile-not-ready",
  "identity-token-stale",
  "harness-untrusted",
  "principal-unverified",
  "principal-mismatch",
  "organization-mismatch",
  "workspace-mismatch",
  "isolation-unproven",
  "idempotency-conflict",
  "lease-not-found",
  "lease-not-active",
  "lease-expired",
  "lease-revoked",
  "generation-mismatch",
  "run-mismatch",
  "role-mismatch",
  "tenant-mismatch",
  "host-mismatch",
  "session-limit-reached",
] as const;
export type CtxlaneAutomationErrorCode =
  (typeof AUTOMATION_ERROR_CODE_VALUES)[number];
const automationErrorCodeSchema = z.enum(AUTOMATION_ERROR_CODE_VALUES);

// Per-operation legal codes, each implicitly widened by the vendored
// schema's operation-agnostic `commonCode` branch.
const OPERATION_SPECIFIC_ERROR_CODE_VALUES: Record<
  CtxlaneAutomationErrorOperation,
  readonly string[]
> = {
  "profile-list": [],
  "profile-readiness": PROFILE_READINESS_ERROR_CODE_VALUES,
  "profile-resolve": PROFILE_RESOLVE_ERROR_CODE_VALUES,
  "lease-acquire": LEASE_ACQUIRE_ERROR_CODE_VALUES,
  "lease-inspect": LEASE_INSPECT_ERROR_CODE_VALUES,
  "lease-renew": LEASE_MUTATION_ERROR_CODE_VALUES,
  "lease-revoke": LEASE_REVOKE_ERROR_CODE_VALUES,
  "lease-close": LEASE_CLOSE_ERROR_CODE_VALUES,
  "service-health": [],
  "execution-start": EXECUTION_START_ERROR_CODE_VALUES,
};

// Operations whose vendored `oneOf` branch requires a non-null `lease_id`.
const OPERATIONS_REQUIRING_LEASE_ID: readonly CtxlaneAutomationErrorOperation[] =
  [
    "lease-inspect",
    "lease-renew",
    "lease-revoke",
    "lease-close",
    "execution-start",
  ];

export const ctxlaneAutomationErrorSchema = z
  .object({
    schema: z.literal(CTXLANE_AUTOMATION_ERROR_SCHEMA),
    operation: automationErrorOperationSchema,
    code: automationErrorCodeSchema,
    client_request_id: z.union([logSafeIdSchema, z.null()]),
    lease_id: z.union([leaseIdSchema, z.null()]),
  })
  .strict()
  .superRefine((value, context) => {
    const isCommonCode = (
      COMMON_ERROR_CODE_VALUES as readonly string[]
    ).includes(value.code);
    if (isCommonCode) {
      if (value.lease_id !== null) {
        issue(
          context,
          ["lease_id"],
          "lease_id must be null for a common error code",
        );
      }
      return;
    }
    const operationCodes =
      OPERATION_SPECIFIC_ERROR_CODE_VALUES[value.operation];
    if (!operationCodes.includes(value.code)) {
      issue(
        context,
        ["code"],
        `code is not legal for the ${value.operation} operation`,
      );
      return;
    }
    const requiresLeaseId = OPERATIONS_REQUIRING_LEASE_ID.includes(
      value.operation,
    );
    if (requiresLeaseId && value.lease_id === null) {
      issue(
        context,
        ["lease_id"],
        `lease_id must not be null for the ${value.operation} operation`,
      );
    } else if (!requiresLeaseId && value.lease_id !== null) {
      issue(
        context,
        ["lease_id"],
        `lease_id must be null for the ${value.operation} operation`,
      );
    }
  });

export type CtxlaneAutomationError = z.infer<
  typeof ctxlaneAutomationErrorSchema
>;

// `lease-acquire`-only narrowing: the operation/code/lease_id shape this
// broker actually sends and receives. `ctxlaneAutomationErrorSchema` is the
// byte-faithful published contract across every ctxlane operation; this is a
// locally-shaped projection for the one operation this module calls, kept
// separate so the published schema is never renamed into an
// acquisition-only shape.
export const ctxlaneLeaseAcquireAutomationErrorSchema = z
  .object({
    schema: z.literal(CTXLANE_AUTOMATION_ERROR_SCHEMA),
    operation: z.literal("lease-acquire"),
    code: z.enum([
      ...COMMON_ERROR_CODE_VALUES,
      ...LEASE_ACQUIRE_ERROR_CODE_VALUES,
    ] as const),
    client_request_id: z.union([logSafeIdSchema, z.null()]),
    lease_id: z.null(),
  })
  .strict();

export type CtxlaneLeaseAcquireAutomationError = z.infer<
  typeof ctxlaneLeaseAcquireAutomationErrorSchema
>;

const PRIVATE_LIFECYCLE_OPERATION_VALUES = [
  "renew",
  "revoke",
  "close",
] as const;
export type CtxlaneIdentityLeaseLifecyclePrivateOperation =
  (typeof PRIVATE_LIFECYCLE_OPERATION_VALUES)[number];
const privateLifecycleOperationSchema = z.enum(
  PRIVATE_LIFECYCLE_OPERATION_VALUES,
);

const PRIVATE_LIFECYCLE_REASON_VALUES = [
  "completed",
  "worker-failed",
  "operator-revoked",
  "policy-revoked",
  "principal-mismatch",
  "heartbeat-lost",
  "process-unverifiable",
  "generation-superseded",
  "renewal-acknowledgement-failed",
  "service-recovery",
  "internal-error",
] as const;
export type CtxlaneIdentityLeaseLifecyclePrivateReason =
  (typeof PRIVATE_LIFECYCLE_REASON_VALUES)[number];
const privateLifecycleReasonSchema = z.enum(PRIVATE_LIFECYCLE_REASON_VALUES);

const privateLifecycleRequestSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA),
    operation: privateLifecycleOperationSchema,
    client_request_id: lifecycleClientRequestIdSchema,
    lease: ctxlaneIdentityLeaseSchema,
    requested_ttl_seconds: z.number().int().min(1).max(86_400).optional(),
    reason: privateLifecycleReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // The private Rust wire type requires a live, capability-bearing lease;
    // a public lease-view or terminal lease can never authorize a mutation.
    if (value.lease.status !== "active" && value.lease.status !== "renewing") {
      issue(
        context,
        ["lease", "status"],
        "private lifecycle requests require an active or renewing lease",
      );
    }
    if (value.lease.execution_handle === null) {
      issue(
        context,
        ["lease", "execution_handle"],
        "private lifecycle requests require an execution handle",
      );
    }
    if (value.lease.fencing_generation === null) {
      issue(
        context,
        ["lease", "fencing_generation"],
        "private lifecycle requests require a fencing generation",
      );
    }
    if (value.lease.effective_policy_digest === null) {
      issue(
        context,
        ["lease", "effective_policy_digest"],
        "private lifecycle requests require an effective policy digest",
      );
    }

    const hasRequestedTtl = value.requested_ttl_seconds !== undefined;
    const hasReason = value.reason !== undefined;
    if (value.operation === "renew") {
      if (!hasRequestedTtl) {
        issue(
          context,
          ["requested_ttl_seconds"],
          "renew requires requested_ttl_seconds",
        );
      }
      if (hasReason) {
        issue(context, ["reason"], "renew must not include reason");
      }
    } else {
      if (hasRequestedTtl) {
        issue(
          context,
          ["requested_ttl_seconds"],
          `${value.operation} must not include requested_ttl_seconds`,
        );
      }
      if (!hasReason) {
        issue(context, ["reason"], `${value.operation} requires reason`);
      } else if (
        value.operation === "close" &&
        value.reason !== "completed" &&
        value.reason !== "worker-failed"
      ) {
        issue(
          context,
          ["reason"],
          "close reason must be completed or worker-failed",
        );
      } else if (
        value.operation === "revoke" &&
        (value.reason === "completed" || value.reason === "worker-failed")
      ) {
        issue(
          context,
          ["reason"],
          "revoke reason must be a revocation reason",
        );
      }
    }
  });

export const ctxlaneIdentityLeaseLifecyclePrivateRequestSchema =
  privateLifecycleRequestSchema;

export type CtxlaneIdentityLeaseLifecyclePrivateRequest = z.infer<
  typeof ctxlaneIdentityLeaseLifecyclePrivateRequestSchema
>;

const privateLifecycleLeaseResultSchema = z
  .object({
    kind: z.literal("lease"),
    lease: ctxlaneIdentityLeaseSchema,
  })
  .strict();
const privateLifecycleErrorResultSchema = z
  .object({
    kind: z.literal("error"),
    error: ctxlaneAutomationErrorSchema,
  })
  .strict();

export const ctxlaneIdentityLeaseLifecyclePrivateResponseSchema = z
  .object({
    schema: z.literal(CTXLANE_IDENTITY_LEASE_LIFECYCLE_PRIVATE_SCHEMA),
    operation: privateLifecycleOperationSchema,
    client_request_id: lifecycleClientRequestIdSchema,
    result: z.discriminatedUnion("kind", [
      privateLifecycleLeaseResultSchema,
      privateLifecycleErrorResultSchema,
    ]),
  })
  .strict();

export type CtxlaneIdentityLeaseLifecyclePrivateResponse = z.infer<
  typeof ctxlaneIdentityLeaseLifecyclePrivateResponseSchema
>;

function parsePrivateLifecycleContract<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${label} failed contract validation: ${parsed.error.issues
        .map((entry) => `${entry.path.join(".") || "<root>"}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Parse an already decoded private lifecycle request without coercion. */
export function parseCtxlaneIdentityLeaseLifecyclePrivateRequest(
  raw: unknown,
): CtxlaneIdentityLeaseLifecyclePrivateRequest {
  return parsePrivateLifecycleContract(
    ctxlaneIdentityLeaseLifecyclePrivateRequestSchema,
    raw,
    "ctxlane private lifecycle request",
  );
}

/** Parse an already decoded private lifecycle response without coercion. */
export function parseCtxlaneIdentityLeaseLifecyclePrivateResponse(
  raw: unknown,
): CtxlaneIdentityLeaseLifecyclePrivateResponse {
  return parsePrivateLifecycleContract(
    ctxlaneIdentityLeaseLifecyclePrivateResponseSchema,
    raw,
    "ctxlane private lifecycle response",
  );
}

/** Serialize a validated private lifecycle request for the private channel. */
export function serializeCtxlaneIdentityLeaseLifecyclePrivateRequest(
  raw: unknown,
): string {
  return JSON.stringify(parseCtxlaneIdentityLeaseLifecyclePrivateRequest(raw));
}

/** Serialize a validated private lifecycle response for the private channel. */
export function serializeCtxlaneIdentityLeaseLifecyclePrivateResponse(
  raw: unknown,
): string {
  return JSON.stringify(parseCtxlaneIdentityLeaseLifecyclePrivateResponse(raw));
}
