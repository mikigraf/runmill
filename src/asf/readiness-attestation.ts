import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as signSignature,
  verify as verifySignature,
  type KeyLike,
} from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  sha256Digest,
} from "./canonical-json.js";
import {
  asfReadinessObservationSchema,
  type AsfReadinessObservation,
} from "./production-readiness.js";

/** Signed live-readiness evidence exchanged by the explicit ASF doctor seam. */
export const ASF_SIGNED_READINESS_OBSERVATION_SCHEMA =
  "asf.signed-production-readiness-observation/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const signatureSchema = z.string().regex(/^base64url:[A-Za-z0-9_-]+$/u);

export const signedAsfReadinessObservationSchema = z
  .object({
    schema: z.literal(ASF_SIGNED_READINESS_OBSERVATION_SCHEMA),
    key_id: identifierSchema,
    algorithm: z.literal("EdDSA"),
    observation_digest: digestSchema,
    observation: asfReadinessObservationSchema,
    signature: signatureSchema,
  })
  .strict();

export type SignedAsfReadinessObservation = z.infer<
  typeof signedAsfReadinessObservationSchema
>;

export interface SignAsfReadinessObservationInput {
  readonly observation: AsfReadinessObservation;
  readonly keyId: string;
  readonly privateKey: KeyLike;
}

export type AsfReadinessObservationVerificationReason =
  | "malformed"
  | "untrusted-key"
  | "digest-mismatch"
  | "invalid-signature";

export class AsfReadinessObservationVerificationError extends Error {
  readonly reason: AsfReadinessObservationVerificationReason;

  constructor(
    reason: AsfReadinessObservationVerificationReason,
    detail: string,
  ) {
    super(`ASF readiness observation verification refused: ${detail}`);
    this.name = "AsfReadinessObservationVerificationError";
    this.reason = reason;
  }
}

function asKeyObject(key: KeyLike, kind: "private" | "public"): KeyObject {
  const resolved =
    key instanceof KeyObject
      ? key
      : kind === "private"
        ? createPrivateKey(key)
        : createPublicKey(key);
  if (resolved.type !== kind || resolved.asymmetricKeyType !== "ed25519") {
    throw new Error(`ASF readiness signing requires an Ed25519 ${kind} key`);
  }
  return resolved;
}

/** Canonical bytes covered by the readiness observation signature. */
export function asfReadinessObservationSigningPayload(
  envelope: SignedAsfReadinessObservation,
): string {
  const { signature: _signature, ...unsigned } = envelope;
  return canonicalJson(unsigned);
}

/** Sign a complete, schema-valid live-readiness observation. */
export function signAsfReadinessObservation(
  input: SignAsfReadinessObservationInput,
): SignedAsfReadinessObservation {
  const observation = asfReadinessObservationSchema.parse(input.observation);
  const unsigned = {
    schema: ASF_SIGNED_READINESS_OBSERVATION_SCHEMA,
    key_id: identifierSchema.parse(input.keyId),
    algorithm: "EdDSA" as const,
    observation_digest: sha256Digest(observation),
    observation,
  };
  const key = asKeyObject(input.privateKey, "private");
  const signature = signSignature(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    key,
  ).toString("base64url");
  return signedAsfReadinessObservationSchema.parse({
    ...unsigned,
    signature: `base64url:${signature}`,
  });
}

/**
 * Verify a signed observation against one explicitly trusted evaluator key.
 * The expected key id is supplied out-of-band so a copied observation cannot
 * choose its own trust root.
 */
export function verifySignedAsfReadinessObservation(
  raw: unknown,
  options: { readonly keyId: string; readonly publicKey: KeyLike },
): SignedAsfReadinessObservation {
  const parsed = signedAsfReadinessObservationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AsfReadinessObservationVerificationError(
      "malformed",
      "the signed envelope is malformed or contains unknown fields",
    );
  }
  if (parsed.data.key_id !== identifierSchema.parse(options.keyId)) {
    throw new AsfReadinessObservationVerificationError(
      "untrusted-key",
      `the observation key ${JSON.stringify(parsed.data.key_id)} is not the configured evaluator key`,
    );
  }
  if (parsed.data.observation_digest !== sha256Digest(parsed.data.observation)) {
    throw new AsfReadinessObservationVerificationError(
      "digest-mismatch",
      "the observation digest does not match its signed observation",
    );
  }
  const encoded = parsed.data.signature.slice("base64url:".length);
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== encoded) {
    throw new AsfReadinessObservationVerificationError(
      "invalid-signature",
      "the signature is not canonical base64url",
    );
  }
  try {
    const publicKey = asKeyObject(options.publicKey, "public");
    if (
      !verifySignature(
        null,
        Buffer.from(asfReadinessObservationSigningPayload(parsed.data), "utf8"),
        publicKey,
        signature,
      )
    ) {
      throw new Error("signature verification returned false");
    }
  } catch (cause) {
    throw new AsfReadinessObservationVerificationError(
      "invalid-signature",
      `signature verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parsed.data;
}
