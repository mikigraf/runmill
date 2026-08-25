import { z } from "zod";
import {
  ASF_REFERENCE_COMPOSITION_CLASSIFICATION,
  ASF_REFERENCE_COMPOSITION_PRODUCTION_QUALIFIED,
  ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS,
  ASF_REFERENCE_COMPOSITION_SCHEMA,
  type AsfReferenceCompositionPortId,
} from "./reference-composition.js";

/**
 * Declarative description of the shipped ASF integration boundary.
 *
 * This is deliberately not an executable dependency graph.  It is the
 * package-owned contract that a future first-party composition loader must
 * satisfy.  Keeping the manifest explicit lets operators and tooling inspect
 * the gap without turning an incomplete graph into startup authority.
 */
export const ASF_FIRST_PARTY_COMPOSITION_MANIFEST_SCHEMA =
  "runmill.asf-first-party-composition/v1" as const;
export const ASF_FIRST_PARTY_COMPOSITION_AVAILABILITY =
  "runtime-module-required" as const;
export const ASF_FIRST_PARTY_COMPOSITION_REFUSAL_REASON =
  "first-party-composition-unavailable" as const;

/**
 * Closed, package-owned reasons the first-party graph cannot be started yet.
 *
 * These are diagnostic facts, not readiness or production authority. Keeping
 * them versioned in the manifest makes the missing upstream/deployment
 * boundaries visible without smuggling a fake provider or transport into the
 * composition.
 */
export const ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS = Object.freeze([
  "executable-composition-not-shipped",
  "ctxlane-authenticated-transport-not-published",
  "ctxlane-authority-lifecycle-channel-not-published",
  "provider-harness-not-shipped",
  "live-production-qualification-incomplete",
] as const);
export type AsfFirstPartyCompositionBlockingReason =
  (typeof ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS)[number];

export interface AsfFirstPartyCompositionManifest {
  readonly schema: typeof ASF_FIRST_PARTY_COMPOSITION_MANIFEST_SCHEMA;
  readonly composition: typeof ASF_REFERENCE_COMPOSITION_SCHEMA;
  readonly classification: typeof ASF_REFERENCE_COMPOSITION_CLASSIFICATION;
  readonly productionQualified: false;
  readonly availability: typeof ASF_FIRST_PARTY_COMPOSITION_AVAILABILITY;
  readonly requiredPorts: readonly AsfReferenceCompositionPortId[];
  readonly blockingReasons: readonly AsfFirstPartyCompositionBlockingReason[];
}

const manifestSchema = z
  .object({
    schema: z.literal(ASF_FIRST_PARTY_COMPOSITION_MANIFEST_SCHEMA),
    composition: z.literal(ASF_REFERENCE_COMPOSITION_SCHEMA),
    classification: z.literal(ASF_REFERENCE_COMPOSITION_CLASSIFICATION),
    productionQualified: z.literal(false),
    availability: z.literal(ASF_FIRST_PARTY_COMPOSITION_AVAILABILITY),
    requiredPorts: z.array(z.string().min(1)).min(1),
    blockingReasons: z
      .array(z.enum(ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS))
      .min(1),
  })
  .strict();

/** A stable, package-owned description of the current first-party gap. */
export const ASF_FIRST_PARTY_COMPOSITION_MANIFEST = Object.freeze({
  schema: ASF_FIRST_PARTY_COMPOSITION_MANIFEST_SCHEMA,
  composition: ASF_REFERENCE_COMPOSITION_SCHEMA,
  classification: ASF_REFERENCE_COMPOSITION_CLASSIFICATION,
  productionQualified: ASF_REFERENCE_COMPOSITION_PRODUCTION_QUALIFIED,
  availability: ASF_FIRST_PARTY_COMPOSITION_AVAILABILITY,
  requiredPorts: Object.freeze([...ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS]),
  blockingReasons: ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS,
}) satisfies AsfFirstPartyCompositionManifest;

export class AsfFirstPartyCompositionManifestError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`ASF first-party composition manifest is invalid: ${reason}`);
    this.name = "AsfFirstPartyCompositionManifestError";
    this.reason = reason;
  }
}

/** Public-safe refusal raised when declarative startup has no executable graph. */
export class AsfFirstPartyCompositionUnavailableError extends Error {
  readonly reason = ASF_FIRST_PARTY_COMPOSITION_REFUSAL_REASON;
  readonly manifest: AsfFirstPartyCompositionManifest;
  readonly blockingReasons: readonly AsfFirstPartyCompositionBlockingReason[];

  constructor(manifest: AsfFirstPartyCompositionManifest) {
    super(
      "ASF first-party composition unavailable: an operator runtime module " +
        "must provide every declared dependency",
    );
    this.name = "AsfFirstPartyCompositionUnavailableError";
    this.manifest = manifest;
    this.blockingReasons = manifest.blockingReasons;
  }
}

function freezeManifest(
  manifest: AsfFirstPartyCompositionManifest,
): AsfFirstPartyCompositionManifest {
  return Object.freeze({
    ...manifest,
    requiredPorts: Object.freeze([...manifest.requiredPorts]),
    blockingReasons: Object.freeze([...manifest.blockingReasons]),
  });
}

/**
 * Parse a manifest supplied by an external diagnostic or packaging tool.
 * Unknown fields, changed port order, and changed port membership all fail
 * closed so an incomplete manifest cannot be mistaken for the reference
 * composition contract.
 */
export function parseAsfFirstPartyCompositionManifest(
  raw: unknown,
): AsfFirstPartyCompositionManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AsfFirstPartyCompositionManifestError(detail);
  }
  const requiredPorts = parsed.data.requiredPorts;
  if (
    requiredPorts.length !== ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS.length ||
    requiredPorts.some(
      (port, index) => port !== ASF_REFERENCE_COMPOSITION_REQUIRED_PORTS[index],
    )
  ) {
    throw new AsfFirstPartyCompositionManifestError(
      "requiredPorts must exactly match the reference composition port contract",
    );
  }
  const blockingReasons = parsed.data.blockingReasons;
  if (
    blockingReasons.length !== ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS.length ||
    blockingReasons.some(
      (reason, index) => reason !== ASF_FIRST_PARTY_COMPOSITION_BLOCKING_REASONS[index],
    )
  ) {
    throw new AsfFirstPartyCompositionManifestError(
      "blockingReasons must exactly match the current first-party composition blockers",
    );
  }
  return freezeManifest({
    ...parsed.data,
    requiredPorts: requiredPorts as AsfReferenceCompositionPortId[],
    blockingReasons,
  });
}

/**
 * Return the package manifest after passing through the same parser used for
 * external copies.  This is intentionally a pure diagnostic operation.
 */
export function inspectAsfFirstPartyComposition(): AsfFirstPartyCompositionManifest {
  return parseAsfFirstPartyCompositionManifest(ASF_FIRST_PARTY_COMPOSITION_MANIFEST);
}

/**
 * Refuse declarative startup until a complete first-party executable graph is
 * shipped.  The advanced runtime-module path remains available separately.
 */
export function requireAsfFirstPartyComposition(): never {
  throw new AsfFirstPartyCompositionUnavailableError(
    inspectAsfFirstPartyComposition(),
  );
}
