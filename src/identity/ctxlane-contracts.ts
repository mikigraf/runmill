import { z } from "zod";

/**
 * Byte-faithful zod representation of the published, controller-neutral
 * ctxlane v1 automation identity contracts:
 *
 * - `ctxlane.work-order-authorization/v1`
 * - `ctxlane.identity-lease-request/v1`
 * - `ctxlane.identity-lease/v1`
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
