import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ctxlaneAutomationErrorSchema,
  ctxlaneAutomationReadinessSchema,
  ctxlaneProfileListSchema,
  ctxlaneIdentityLeaseCloseSchema,
  ctxlaneIdentityLeaseCloseReceiptSchema,
  ctxlaneIdentityLeaseInspectSchema,
  ctxlaneIdentityLeaseInspectReceiptSchema,
  ctxlaneIdentityLeaseRequestSchema,
  ctxlaneIdentityLeaseRenewAcknowledgementSchema,
  ctxlaneIdentityLeaseRenewReceiptSchema,
  ctxlaneIdentityLeaseRenewSchema,
  ctxlaneIdentityLeaseRevokeSchema,
  ctxlaneIdentityLeaseRevokeReceiptSchema,
  ctxlaneIdentityLeaseSchema,
  ctxlaneLeaseViewSchema,
  ctxlaneServiceHealthSchema,
  ctxlaneLeaseAcquireAutomationErrorSchema,
  ctxlaneWorkOrderAuthorizationSchema,
  isAtOrBeforeUtc,
  isStrictlyBeforeUtc,
  utcTimestampNanosecondDelta,
  utcTimestampOrderKey,
} from "../../src/identity/ctxlane-contracts.js";

const FIXTURES_DIR = join(__dirname, "..", "fixtures", "ctxlane", "examples");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const workOrderAuthorizationFixture = loadFixture("work-order-authorization.v1.json") as Record<
  string,
  unknown
>;
const identityLeaseRequestFixture = loadFixture("identity-lease-request.v1.json") as Record<
  string,
  unknown
>;
const identityLeaseActiveFixture = loadFixture("identity-lease-active.v1.json") as Record<
  string,
  unknown
>;
const identityLeaseRefusedFixture = loadFixture("identity-lease-refused.v1.json") as Record<
  string,
  unknown
>;
const automationErrorFixture = loadFixture("automation-error.v1.json") as Record<string, unknown>;
const serviceHealthFixture = loadFixture("service-health.v1.json") as Record<string, unknown>;
const profileListFixture = loadFixture("profile-list.v1.json") as Record<string, unknown>;
const readinessFixtures = {
  ready: loadFixture("automation-readiness-ready.v1.json"),
  notReady: loadFixture("automation-readiness-not-ready.v1.json"),
  developmentException: loadFixture("automation-readiness-development-exception.v1.json"),
} as const;
const lifecycleFixtures = {
  closeRequest: loadFixture("lease-close-request.v1.json"),
  closeReceipt: loadFixture("lease-close-receipt.v1.json"),
  inspectRequest: loadFixture("lease-inspect-request.v1.json"),
  inspectReceipt: loadFixture("lease-inspect-receipt.v1.json"),
  renewRequest: loadFixture("lease-renew-request.v1.json"),
  renewReceipt: loadFixture("lease-renew-receipt.v1.json"),
  renewAcknowledgement: loadFixture("lease-renew-acknowledgement.v1.json"),
  revokeRequest: loadFixture("lease-revoke-request.v1.json"),
  revokeReceipt: loadFixture("lease-revoke-receipt.v1.json"),
  viewActive: loadFixture("lease-view-active.v1.json"),
  viewPerLeaseIsolated: loadFixture("lease-view-per-lease-isolated.v1.json"),
  viewClosed: loadFixture("lease-view-closed.v1.json"),
  viewRefused: loadFixture("lease-view-refused.v1.json"),
  viewRenewing: loadFixture("lease-view-renewing.v1.json"),
  viewRevoked: loadFixture("lease-view-revoked.v1.json"),
} as const;

describe("vendored ctxlane v1 fixtures parse byte-for-byte", () => {
  it("accepts the vendored work-order-authorization example", () => {
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(workOrderAuthorizationFixture).success).toBe(
      true,
    );
  });

  it("accepts the vendored identity-lease-request example", () => {
    expect(ctxlaneIdentityLeaseRequestSchema.safeParse(identityLeaseRequestFixture).success).toBe(true);
  });

  it("accepts the vendored active identity-lease example", () => {
    expect(ctxlaneIdentityLeaseSchema.safeParse(identityLeaseActiveFixture).success).toBe(true);
  });

  it("accepts the vendored refused identity-lease example", () => {
    expect(ctxlaneIdentityLeaseSchema.safeParse(identityLeaseRefusedFixture).success).toBe(true);
  });

  it("accepts the vendored automation-error example", () => {
    expect(ctxlaneAutomationErrorSchema.safeParse(automationErrorFixture).success).toBe(true);
  });

  it("accepts the vendored service-health example", () => {
    expect(ctxlaneServiceHealthSchema.safeParse(serviceHealthFixture).success).toBe(true);
  });

  it("accepts the vendored profile-list example", () => {
    expect(ctxlaneProfileListSchema.safeParse(profileListFixture).success).toBe(true);
  });

  it.each([
    ["ready", readinessFixtures.ready],
    ["not-ready", readinessFixtures.notReady],
    ["development exception", readinessFixtures.developmentException],
  ] as const)("accepts the vendored %s automation-readiness example", (_label, fixture) => {
    expect(ctxlaneAutomationReadinessSchema.safeParse(fixture).success).toBe(true);
  });
});

describe("ctxlane automation-readiness fail-closed bindings", () => {
  it("rejects a ready result with a failed common prerequisite", () => {
    const mutated = clone(readinessFixtures.ready as Record<string, unknown>);
    const checks = mutated.checks as Record<string, Record<string, unknown>>;
    checks["harness-trusted"] = { status: "fail", reason_code: "harness-untrusted" };
    expect(ctxlaneAutomationReadinessSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects provider-incompatible auth and tenant reason combinations", () => {
    const authMutated = clone(readinessFixtures.ready as Record<string, unknown>);
    authMutated.auth_mode = "subscription-token";
    expect(ctxlaneAutomationReadinessSchema.safeParse(authMutated).success).toBe(false);

    const tenantMutated = clone(readinessFixtures.ready as Record<string, unknown>);
    const checks = tenantMutated.checks as Record<string, Record<string, unknown>>;
    checks["expected-tenant-verified"] = {
      status: "fail",
      reason_code: "organization-mismatch",
    };
    tenantMutated.ready = false;
    expect(ctxlaneAutomationReadinessSchema.safeParse(tenantMutated).success).toBe(false);
  });

  it("rejects non-interactive results with an invalid validity interval", () => {
    const mutated = clone(readinessFixtures.ready as Record<string, unknown>);
    mutated.probe_interactive = true;
    mutated.valid_until = mutated.checked_at;
    expect(ctxlaneAutomationReadinessSchema.safeParse(mutated).success).toBe(false);
  });
});

describe("ctxlane profile-list fail-closed bindings", () => {
  it.each([
    ["provider namespace", (profile: Record<string, unknown>) => {
      profile.profile_ref = "claude:automation-production";
    }],
    ["shared concurrency", (profile: Record<string, unknown>) => {
      profile.concurrency_mode = "shared";
      profile.max_concurrent_leases = 1;
      profile.shared_state_isolation_requirement = null;
    }],
    ["eligible scope", (profile: Record<string, unknown>) => {
      profile.eligible = true;
      profile.environment_count = 0;
      profile.roles = [];
      profile.caller_subject_count = 0;
    }],
    ["WIF exception", (profile: Record<string, unknown>) => {
      profile.authentication_exception_acknowledged = true;
    }],
  ] as const)("rejects an invalid %s projection", (_label, mutate) => {
    const mutated = clone(profileListFixture);
    const profiles = mutated.profiles as Array<Record<string, unknown>>;
    mutate(profiles[0]!);
    expect(ctxlaneProfileListSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects duplicate roles and authority-bearing fields", () => {
    const duplicateRoles = clone(profileListFixture);
    const profiles = duplicateRoles.profiles as Array<Record<string, unknown>>;
    profiles[0]!.roles = ["implementer", "implementer"];
    expect(ctxlaneProfileListSchema.safeParse(duplicateRoles).success).toBe(false);

    const capability = clone(profileListFixture);
    const capabilityProfiles = capability.profiles as Array<Record<string, unknown>>;
    capabilityProfiles[0]!.execution_handle = "exec_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneProfileListSchema.safeParse(capability).success).toBe(false);
  });
});

describe("vendored ctxlane lifecycle contracts", () => {
  it.each([
    ["renew parameters", ctxlaneIdentityLeaseRenewSchema, lifecycleFixtures.renewRequest],
    ["revoke parameters", ctxlaneIdentityLeaseRevokeSchema, lifecycleFixtures.revokeRequest],
    ["close parameters", ctxlaneIdentityLeaseCloseSchema, lifecycleFixtures.closeRequest],
    ["inspect parameters", ctxlaneIdentityLeaseInspectSchema, lifecycleFixtures.inspectRequest],
    [
      "renew acknowledgement",
      ctxlaneIdentityLeaseRenewAcknowledgementSchema,
      lifecycleFixtures.renewAcknowledgement,
    ],
    ["renew receipt", ctxlaneIdentityLeaseRenewReceiptSchema, lifecycleFixtures.renewReceipt],
    ["revoke receipt", ctxlaneIdentityLeaseRevokeReceiptSchema, lifecycleFixtures.revokeReceipt],
    ["close receipt", ctxlaneIdentityLeaseCloseReceiptSchema, lifecycleFixtures.closeReceipt],
    ["inspect receipt", ctxlaneIdentityLeaseInspectReceiptSchema, lifecycleFixtures.inspectReceipt],
    ["active lease view", ctxlaneLeaseViewSchema, lifecycleFixtures.viewActive],
    [
      "per-lease-isolated lease view",
      ctxlaneLeaseViewSchema,
      lifecycleFixtures.viewPerLeaseIsolated,
    ],
    ["closed lease view", ctxlaneLeaseViewSchema, lifecycleFixtures.viewClosed],
    ["refused lease view", ctxlaneLeaseViewSchema, lifecycleFixtures.viewRefused],
    ["renewing lease view", ctxlaneLeaseViewSchema, lifecycleFixtures.viewRenewing],
    ["revoked lease view", ctxlaneLeaseViewSchema, lifecycleFixtures.viewRevoked],
  ] as const)("accepts the published %s example", (_label, schema, fixture) => {
    expect(schema.safeParse(fixture).success).toBe(true);
  });

  it("rejects capability-bearing fields from the capability-free lease view", () => {
    const mutated = clone(lifecycleFixtures.viewActive as Record<string, unknown>);
    mutated.execution_handle = "exec_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    mutated.fencing_generation = 2;
    expect(ctxlaneLeaseViewSchema.safeParse(mutated).success).toBe(false);
    expect(ctxlaneIdentityLeaseSchema.safeParse(lifecycleFixtures.viewActive).success).toBe(false);
  });

  it.each([
    ["renew parameters", ctxlaneIdentityLeaseRenewSchema, lifecycleFixtures.renewRequest],
    ["revoke parameters", ctxlaneIdentityLeaseRevokeSchema, lifecycleFixtures.revokeRequest],
    ["close parameters", ctxlaneIdentityLeaseCloseSchema, lifecycleFixtures.closeRequest],
    ["inspect parameters", ctxlaneIdentityLeaseInspectSchema, lifecycleFixtures.inspectRequest],
    [
      "renew acknowledgement",
      ctxlaneIdentityLeaseRenewAcknowledgementSchema,
      lifecycleFixtures.renewAcknowledgement,
    ],
  ] as const)("rejects unknown fields on %s", (_label, schema, fixture) => {
    const mutated = clone(fixture as Record<string, unknown>);
    mutated.unexpected_field = "surprise";
    expect(schema.safeParse(mutated).success).toBe(false);
  });
});

describe("unknown and missing fields", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["work-order-authorization", ctxlaneWorkOrderAuthorizationSchema, workOrderAuthorizationFixture],
    ["identity-lease-request", ctxlaneIdentityLeaseRequestSchema, identityLeaseRequestFixture],
    ["identity-lease", ctxlaneIdentityLeaseSchema, identityLeaseActiveFixture],
    ["automation-error", ctxlaneAutomationErrorSchema, automationErrorFixture],
    ["service-health", ctxlaneServiceHealthSchema, serviceHealthFixture],
    ["profile-list", ctxlaneProfileListSchema, profileListFixture],
    ["automation-readiness", ctxlaneAutomationReadinessSchema, readinessFixtures.ready],
  ];

  for (const [label, schema, fixture] of cases) {
    it(`rejects an unknown top-level property on ${label}`, () => {
      const mutated = clone(fixture as Record<string, unknown>);
      mutated.unexpected_field = "surprise";
      expect((schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(mutated).success).toBe(
        false,
      );
    });

    for (const field of Object.keys(fixture as Record<string, unknown>)) {
      it(`rejects ${label} missing required field ${field}`, () => {
        const mutated = clone(fixture as Record<string, unknown>);
        delete mutated[field];
        expect(
          (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(mutated).success,
        ).toBe(false);
      });
    }
  }
});

describe("13 duplicated request/authorization equalities", () => {
  const DUPLICATED_FIELDS = [
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

  it("has exactly 13 duplicated fields to check", () => {
    expect(DUPLICATED_FIELDS.length).toBe(13);
  });

  const MISMATCH_REPLACEMENTS: Record<string, unknown> = {
    client_request_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    tenant_id: "tenant-other",
    work_order_id: "wo_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    work_order_digest: "sha256:b36dbc1704725260b0896399529c16a86acabb6849bb1c9abeb251d7ffd16e6c",
    run_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    attempt_id: "attempt_02",
    role: "local-reviewer",
    provider: "claude",
    profile_uid: "profile_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    profile_ref: "claude:automation-production",
    repository: "github:acme/other-repo",
    workspace_id: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    environment: "staging",
  };

  for (const field of DUPLICATED_FIELDS) {
    it(`rejects a request whose top-level ${field} differs from work_order_authorization.${field}`, () => {
      const mutated = clone(identityLeaseRequestFixture);
      mutated[field] = MISMATCH_REPLACEMENTS[field];
      const result = ctxlaneIdentityLeaseRequestSchema.safeParse(mutated);
      expect(result.success).toBe(false);
    });

    it(`rejects a request whose embedded work_order_authorization.${field} differs from the top level`, () => {
      const mutated = clone(identityLeaseRequestFixture);
      const authorization = mutated.work_order_authorization as Record<string, unknown>;
      authorization[field] = MISMATCH_REPLACEMENTS[field];
      const result = ctxlaneIdentityLeaseRequestSchema.safeParse(mutated);
      expect(result.success).toBe(false);
    });
  }
});

describe("provider/profile namespace binding", () => {
  it("rejects a work-order-authorization whose profile_ref is namespaced to the other provider", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.profile_ref = "claude:automation-production";
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects an identity-lease-request whose top-level profile_ref does not match its provider", () => {
    const mutated = clone(identityLeaseRequestFixture);
    mutated.provider = "claude";
    // Keep the embedded authorization's provider/profile_ref consistent so
    // only the top-level namespace check can fail here, not the duplicated
    // equality check.
    (mutated.work_order_authorization as Record<string, unknown>).provider = "claude";
    mutated.profile_ref = "codex:automation-production";
    (mutated.work_order_authorization as Record<string, unknown>).profile_ref =
      "codex:automation-production";
    expect(ctxlaneIdentityLeaseRequestSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects an identity-lease whose profile_ref is not namespaced to its provider", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.profile_ref = "claude:automation-production";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects claude auth_mode values not permitted for codex", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.auth_mode = "subscription-token";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a workspace_ref namespaced to the wrong provider", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.workspace_ref = "claude-organization:acme";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects organization-mismatch refusal_code for a non-claude provider", () => {
    const mutated = clone(identityLeaseRefusedFixture);
    mutated.refusal_code = "organization-mismatch";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects workspace-mismatch refusal_code for a non-codex provider", () => {
    const mutated = clone(identityLeaseRefusedFixture);
    mutated.provider = "claude";
    mutated.profile_ref = "claude:automation-production";
    mutated.refusal_code = "workspace-mismatch";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });
});

describe("isolation exception binding", () => {
  it("rejects copied-credential-development isolation outside local-development or pr-reviewer", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.isolation = "copied-credential-development";
    expect(mutated.environment).toBe("production");
    expect(mutated.role).toBe("implementer");
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts copied-credential-development isolation in local-development", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.isolation = "copied-credential-development";
    mutated.environment = "local-development";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("accepts copied-credential-development isolation for the pr-reviewer role", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.isolation = "copied-credential-development";
    mutated.role = "pr-reviewer";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects unproven isolation for a resolved status", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.isolation = "unproven";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });
});

describe("status attribution", () => {
  it("rejects a requested lease with a non-null attribution field", () => {
    const mutated = clone(identityLeaseRefusedFixture);
    mutated.status = "requested";
    mutated.refusal_code = null;
    mutated.worker_identity = "worker:controller-01";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a refused lease without a refusal_code", () => {
    const mutated = clone(identityLeaseRefusedFixture);
    mutated.refusal_code = null;
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a refused lease with a reason_code", () => {
    const mutated = clone(identityLeaseRefusedFixture);
    mutated.reason_code = "operator-revoked";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects an active lease with a null execution_handle", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.execution_handle = null;
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects an active lease carrying a refusal_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.refusal_code = "profile-not-ready";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a closed lease with a non-execution_handle-null value", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "closed";
    mutated.reason_code = "completed";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts a closed lease with a closed reason_code and null execution_handle", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "closed";
    mutated.execution_handle = null;
    mutated.reason_code = "completed";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects a closed lease using an expired reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "closed";
    mutated.execution_handle = null;
    mutated.reason_code = "lease-expired";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects an expired lease using a revoked reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "expired";
    mutated.execution_handle = null;
    mutated.reason_code = "operator-revoked";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts an expired lease using an expired reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "expired";
    mutated.execution_handle = null;
    mutated.reason_code = "lease-expired";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects a revoked lease using a closed reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "revoked";
    mutated.execution_handle = null;
    mutated.reason_code = "completed";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts a revoked lease using a revoked reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "revoked";
    mutated.execution_handle = null;
    mutated.reason_code = "heartbeat-lost";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects an error lease using a closed reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "error";
    mutated.execution_handle = null;
    mutated.reason_code = "completed";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts an error lease using an error reason_code", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.status = "error";
    mutated.execution_handle = null;
    mutated.reason_code = "internal-error";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects a resolved status with expires_at not after issued_at", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.expires_at = mutated.issued_at;
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a resolved status where maximum_expires_at is before expires_at", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.maximum_expires_at = "2026-08-21T10:14:59Z";
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts maximum_expires_at exactly equal to expires_at (at-or-before, not strict)", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.maximum_expires_at = mutated.expires_at;
    expect(ctxlaneIdentityLeaseSchema.safeParse(mutated).success).toBe(true);
  });
});

describe("invalid calendar and minute values", () => {
  const invalidTimestamps = [
    "2026-02-30T00:00:00Z", // Feb 30 never exists
    "2025-02-29T00:00:00Z", // 2025 is not a leap year
    "2026-13-01T00:00:00Z", // month 13
    "2026-00-01T00:00:00Z", // month 0
    "2026-01-32T00:00:00Z", // day 32
    "2026-01-00T00:00:00Z", // day 0
    "2026-04-31T00:00:00Z", // April has 30 days
    "2026-08-21T24:00:00Z", // hour 24
    "2026-08-21T10:60:00Z", // minute 60
    "2026-08-21T10:99:00Z", // minute 99, in-range for the loose [0-9]{2} regex shape
    "0000-08-21T10:00:00Z", // year 0000 is excluded
  ];

  for (const timestamp of invalidTimestamps) {
    it(`rejects the invalid timestamp ${timestamp}`, () => {
      const mutated = clone(workOrderAuthorizationFixture);
      mutated.not_before = timestamp;
      expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
    });
  }

  it("accepts the leap day in a leap year", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.not_before = "2028-02-29T00:00:00Z";
    // Keep the signed interval equal to maximum_session_seconds (14400s = 4h)
    // so only the calendar validity of the leap day is under test here.
    mutated.expires_at = "2028-02-29T04:00:00Z";
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(true);
  });

  it("accepts minute 59 and rejects minute 60 explicitly via isCanonicalUtcTimestamp behavior", () => {
    expect(() => utcTimestampOrderKey("2026-08-21T10:59:00Z")).not.toThrow();
    expect(() => utcTimestampOrderKey("2026-08-21T10:60:00Z")).toThrow(RangeError);
  });
});

describe("sub-millisecond fractional-second ordering", () => {
  it("orders two timestamps that differ only past millisecond precision", () => {
    const earlier = "2026-08-21T10:00:00.000000001Z";
    const later = "2026-08-21T10:00:00.000000002Z";
    expect(isStrictlyBeforeUtc(earlier, later)).toBe(true);
    expect(isStrictlyBeforeUtc(later, earlier)).toBe(false);
    expect(utcTimestampOrderKey(later) - utcTimestampOrderKey(earlier)).toBe(1n);
  });

  it("does not collapse sub-millisecond differences the way Date.parse would", () => {
    // Both fractions round/truncate to the same 0ms mark under `Date.parse`
    // regardless of whether the runtime truncates or rounds extra digits,
    // since both are well under the 0.5ms rounding boundary.
    const earlier = "2026-08-21T10:00:00.0001Z";
    const later = "2026-08-21T10:00:00.0002Z";
    expect(Date.parse(earlier)).toBe(Date.parse(later));
    expect(isStrictlyBeforeUtc(earlier, later)).toBe(true);
  });

  it("treats 1 through 9 fractional digits as valid and pads to nanoseconds consistently", () => {
    expect(utcTimestampOrderKey("2026-08-21T10:00:00.1Z")).toBe(
      utcTimestampOrderKey("2026-08-21T10:00:00.100000000Z"),
    );
    expect(utcTimestampOrderKey("2026-08-21T10:00:00Z")).toBe(
      utcTimestampOrderKey("2026-08-21T10:00:00.000000000Z"),
    );
  });

  it("rejects 10 or more fractional digits", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.not_before = "2026-08-21T10:00:00.1234567890Z";
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
  });

  it("computes at-or-before correctly at nanosecond precision", () => {
    const a = "2026-08-21T10:00:00.000000001Z";
    const b = "2026-08-21T10:00:00.000000002Z";
    expect(isAtOrBeforeUtc(a, a)).toBe(true);
    expect(isAtOrBeforeUtc(a, b)).toBe(true);
    expect(isAtOrBeforeUtc(b, a)).toBe(false);
  });

  it("computes an exact nanosecond delta including negative durations", () => {
    const a = "2026-08-21T10:00:00.000000001Z";
    const b = "2026-08-21T10:00:00.000000002Z";
    expect(utcTimestampNanosecondDelta(a, b)).toBe(1n);
    expect(utcTimestampNanosecondDelta(b, a)).toBe(-1n);
    expect(utcTimestampNanosecondDelta(a, a)).toBe(0n);
  });
});

describe("years below 100 without Date.UTC coercion", () => {
  it("parses a four-digit year below 100 as a canonical timestamp", () => {
    expect(() => utcTimestampOrderKey("0050-01-01T00:00:00Z")).not.toThrow();
    expect(() => utcTimestampOrderKey("0001-01-01T00:00:00Z")).not.toThrow();
    expect(() => utcTimestampOrderKey("9999-12-31T23:59:59Z")).not.toThrow();
  });

  it("orders a year below 100 strictly before the Unix epoch, not coerced into 19xx", () => {
    const year0050 = "0050-01-01T00:00:00Z";
    const epoch = "1970-01-01T00:00:00Z";
    const year1950 = "1950-01-01T00:00:00Z";
    expect(isStrictlyBeforeUtc(year0050, epoch)).toBe(true);
    // If `Date.UTC`'s two-digit-year coercion leaked in, "0050" would land on
    // 1950 and this would report the two timestamps as equal in order.
    expect(utcTimestampOrderKey(year0050)).not.toBe(utcTimestampOrderKey(year1950));
  });

  it("computes the exact epoch-second value for a year below 100 from first principles", () => {
    // 0050-01-01T00:00:00Z is 1920 years before 1970-01-01T00:00:00Z.
    // Proleptic Gregorian days in [0050-01-01, 1970-01-01): count leap years
    // in that half-open span using the standard Gregorian rule.
    let leapDays = 0;
    for (let year = 50; year < 1970; year += 1) {
      if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) leapDays += 1;
    }
    const totalDays = 1920 * 365 + leapDays;
    const expectedSeconds = -BigInt(totalDays) * 86_400n;
    expect(utcTimestampOrderKey("0050-01-01T00:00:00Z")).toBe(expectedSeconds * 1_000_000_000n);
  });

  it("accepts a two-digit-looking year below 100 in a full contract object", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.not_before = "0099-01-01T00:00:00Z";
    // Keep the signed interval equal to maximum_session_seconds (14400s = 4h).
    mutated.expires_at = "0099-01-01T04:00:00Z";
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(true);
  });
});

describe("TTL, session, and signed-interval bounds", () => {
  it("rejects maximum_ttl_seconds exceeding maximum_session_seconds", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.maximum_ttl_seconds = 900;
    mutated.maximum_session_seconds = 899;
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts maximum_ttl_seconds exactly equal to maximum_session_seconds", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.maximum_ttl_seconds = 900;
    mutated.maximum_session_seconds = 900;
    mutated.expires_at = "2026-08-21T10:15:00Z";
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects maximum_session_seconds outliving the signed not_before/expires_at interval", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    // not_before..expires_at spans exactly 4 hours (14400s); demand a longer session.
    mutated.maximum_ttl_seconds = 900;
    mutated.maximum_session_seconds = 14_401;
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts maximum_session_seconds exactly equal to the signed interval", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.maximum_ttl_seconds = 900;
    mutated.maximum_session_seconds = 14_400;
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects expires_at not strictly after not_before", () => {
    const mutated = clone(workOrderAuthorizationFixture);
    mutated.expires_at = mutated.not_before;
    expect(ctxlaneWorkOrderAuthorizationSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects requested_ttl_seconds exceeding work_order_authorization.maximum_ttl_seconds", () => {
    const mutated = clone(identityLeaseRequestFixture);
    const authorization = mutated.work_order_authorization as Record<string, unknown>;
    authorization.maximum_ttl_seconds = 300;
    mutated.requested_ttl_seconds = 301;
    expect(ctxlaneIdentityLeaseRequestSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects requested_ttl_seconds exceeding work_order_authorization.maximum_session_seconds", () => {
    const mutated = clone(identityLeaseRequestFixture);
    const authorization = mutated.work_order_authorization as Record<string, unknown>;
    // maximum_ttl_seconds equals maximum_session_seconds here so
    // maximum_ttl_seconds <= maximum_session_seconds still holds and the
    // signed interval (4h = 14400s) still covers the session bound; only the
    // requested_ttl_seconds <= maximum_session_seconds check should fail.
    authorization.maximum_ttl_seconds = 500;
    authorization.maximum_session_seconds = 500;
    mutated.requested_ttl_seconds = 501;
    expect(ctxlaneIdentityLeaseRequestSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts requested_ttl_seconds at or below both maxima", () => {
    const mutated = clone(identityLeaseRequestFixture);
    mutated.requested_ttl_seconds = 900;
    expect(ctxlaneIdentityLeaseRequestSchema.safeParse(mutated).success).toBe(true);
  });
});

describe("automation-error operation/code binding", () => {
  const commonCodes = [
    "invalid-request",
    "unsupported-schema",
    "caller-unauthenticated",
    "caller-unauthorized",
    "rate-limited",
    "service-recovering",
    "unsupported-platform",
    "store-unavailable",
    "internal-error",
  ];

  it("accepts every common error code for every operation, with a null lease_id", () => {
    const operations = [
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
    ];
    for (const operation of operations) {
      for (const code of commonCodes) {
        const mutated = clone(automationErrorFixture);
        mutated.operation = operation;
        mutated.code = code;
        mutated.lease_id = null;
        expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(true);
      }
    }
  });

  it("rejects a common code paired with a non-null lease_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.code = "invalid-request";
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts idempotency-conflict, which is specific to lease-acquire", () => {
    const mutated = clone(automationErrorFixture);
    mutated.code = "idempotency-conflict";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects idempotency-conflict for an operation other than lease-acquire", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "lease-inspect";
    mutated.code = "idempotency-conflict";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts lease-not-found for lease-inspect with a non-null lease_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "lease-inspect";
    mutated.code = "lease-not-found";
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects lease-not-found for lease-inspect with a null lease_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "lease-inspect";
    mutated.code = "lease-not-found";
    mutated.lease_id = null;
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts session-limit-reached for execution-start with a non-null lease_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "execution-start";
    mutated.code = "session-limit-reached";
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects session-limit-reached for lease-close, which does not permit it", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "lease-close";
    mutated.code = "session-limit-reached";
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("accepts a null client_request_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.client_request_id = null;
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(true);
  });

  it("rejects an empty-string client_request_id", () => {
    const mutated = clone(automationErrorFixture);
    mutated.client_request_id = "";
    expect(ctxlaneAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });
});

describe("lease-acquire automation-error narrowing", () => {
  it("accepts every common error code and idempotency-conflict", () => {
    for (const code of [
      "invalid-request",
      "unsupported-schema",
      "caller-unauthenticated",
      "caller-unauthorized",
      "rate-limited",
      "service-recovering",
      "unsupported-platform",
      "store-unavailable",
      "internal-error",
      "idempotency-conflict",
    ]) {
      const mutated = clone(automationErrorFixture);
      mutated.code = code;
      expect(ctxlaneLeaseAcquireAutomationErrorSchema.safeParse(mutated).success).toBe(true);
    }
  });

  it("rejects an operation other than lease-acquire", () => {
    const mutated = clone(automationErrorFixture);
    mutated.operation = "lease-inspect";
    mutated.code = "lease-not-found";
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneLeaseAcquireAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a code that is legal for another operation but not lease-acquire", () => {
    const mutated = clone(automationErrorFixture);
    mutated.code = "lease-not-found";
    expect(ctxlaneLeaseAcquireAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });

  it("rejects a non-null lease_id, which lease-acquire errors never carry", () => {
    const mutated = clone(automationErrorFixture);
    mutated.lease_id = "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(ctxlaneLeaseAcquireAutomationErrorSchema.safeParse(mutated).success).toBe(false);
  });
});

describe("regression: rejects old invented Runmill projection fields in identity-lease-request", () => {
  it("rejects an identity-lease-request with invented 'tenant' field instead of 'tenant_id'", () => {
    const mutated = clone(identityLeaseRequestFixture);
    // Introduce the old invented field
    mutated.tenant = "tenant-acme";
    const result = ctxlaneIdentityLeaseRequestSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("rejects an identity-lease-request with invented 'requested_profile' field instead of 'profile_ref'", () => {
    const mutated = clone(identityLeaseRequestFixture);
    mutated.requested_profile = "codex:automation-production";
    const result = ctxlaneIdentityLeaseRequestSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("rejects an identity-lease-request with invented 'requested_duration_ms' field instead of 'requested_ttl_seconds'", () => {
    const mutated = clone(identityLeaseRequestFixture);
    mutated.requested_duration_ms = 900_000;
    const result = ctxlaneIdentityLeaseRequestSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("accepts canonical identity-lease-request with profile_ref, requested_ttl_seconds, and policy_digest", () => {
    const result = ctxlaneIdentityLeaseRequestSchema.safeParse(identityLeaseRequestFixture);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    if (result.data) {
      expect(result.data.profile_ref).toBe("codex:automation-production");
      expect(result.data.requested_ttl_seconds).toBe(900);
      expect(result.data.policy_digest).toBeNull();
    }
  });
});

describe("regression: validates canonical identity-lease response fields", () => {
  it("requires principal_ref in active lease (resolved status)", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.principal_ref = null;
    const result = ctxlaneIdentityLeaseSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("requires effective_policy_digest in active lease (resolved status)", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.effective_policy_digest = null;
    const result = ctxlaneIdentityLeaseSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("accepts canonical active lease with profile_ref, principal_ref, and effective_policy_digest", () => {
    const result = ctxlaneIdentityLeaseSchema.safeParse(identityLeaseActiveFixture);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    if (result.data) {
      expect(result.data.profile_ref).toBe("codex:automation-production");
      expect(result.data.principal_ref).toBe("service-account:automation-worker");
      expect(result.data.effective_policy_digest).toBe(
        "sha256:bb42590da6d8c5c0c0103b67572979c60d3c44a5a5a2cfa74f469e8cd7cf3d12",
      );
    }
  });

  it("rejects active lease with invented camelCase 'policyDigest' field", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.policyDigest = "sha256:bb42590da6d8c5c0c0103b67572979c60d3c44a5a5a2cfa74f469e8cd7cf3d12";
    const result = ctxlaneIdentityLeaseSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });

  it("rejects active lease with invented 'principalRef' camelCase field", () => {
    const mutated = clone(identityLeaseActiveFixture);
    mutated.principalRef = "service-account:automation-worker";
    const result = ctxlaneIdentityLeaseSchema.safeParse(mutated);
    expect(result.success).toBe(false);
  });
});
