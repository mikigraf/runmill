import { z } from "zod";
import { sha256Digest, type JsonValue } from "./canonical-json.js";

export const ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA =
  "asf.identity-lease-attribution/v1" as const;

export const ASF_REQUIRED_IDENTITY_ROLES = [
  "implementer",
  "local-reviewer",
  "pr-reviewer",
] as const;

export type AsfRequiredIdentityRole = (typeof ASF_REQUIRED_IDENTITY_ROLES)[number];

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "must not contain control characters",
  );
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const asfIdentityLeaseAttributionSchema = z
  .object({
    schema: z.literal(ASF_IDENTITY_LEASE_ATTRIBUTION_SCHEMA),
    role: z.enum(ASF_REQUIRED_IDENTITY_ROLES),
    provider: identifierSchema,
    principal_id: identifierSchema,
    profile: identifierSchema,
    fencing_generation: z.number().int().positive().safe(),
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    lease_attribution_digest: digestSchema,
  })
  .strict();

export type AsfIdentityLeaseAttribution = z.infer<
  typeof asfIdentityLeaseAttributionSchema
>;

export interface AsfIdentityAttributionBinding {
  readonly run_id: string;
  readonly work_order_id: string;
  readonly attempt_id: string;
  readonly policy_digest: string;
  readonly fencing_generation: number;
  readonly candidate_sha: null;
}

type UnsignedAttribution = Omit<
  AsfIdentityLeaseAttribution,
  "lease_attribution_digest"
>;

/**
 * Bind public identity attribution without hashing or serializing the broker's
 * sensitive lease ID or execution handle.
 */
export function identityLeaseAttributionDigest(
  binding: AsfIdentityAttributionBinding,
  attribution: UnsignedAttribution,
): string {
  return sha256Digest({
    binding: binding as unknown as JsonValue,
    attribution: attribution as unknown as JsonValue,
  });
}

export function assertIdentityLeaseAttribution(
  binding: AsfIdentityAttributionBinding,
  raw: unknown,
): AsfIdentityLeaseAttribution {
  const attribution = asfIdentityLeaseAttributionSchema.parse(raw);
  const { lease_attribution_digest: claimed, ...unsigned } = attribution;
  if (identityLeaseAttributionDigest(binding, unsigned) !== claimed) {
    throw new Error("identity lease attribution digest is internally contradictory");
  }
  if (Date.parse(attribution.issued_at) >= Date.parse(attribution.expires_at)) {
    throw new Error("identity lease attribution lifetime is contradictory");
  }
  return attribution;
}

export function identityAttributionsDigest(
  attributions: readonly AsfIdentityLeaseAttribution[],
): string {
  return sha256Digest(attributions);
}
