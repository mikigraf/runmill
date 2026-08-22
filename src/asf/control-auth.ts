import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { ControlRequest } from "../daemon/control.js";
import type { Clock } from "../platform/clock.js";
import { canonicalJson, sha256Digest, type JsonValue } from "./canonical-json.js";

export const ASF_CONTROL_AUTH_SCHEMA = "asf.control-authentication/v1" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const nonceSchema = z.string().regex(/^base64url:[A-Za-z0-9_-]{22,128}$/u);
const signatureSchema = z.string().regex(/^base64url:[A-Za-z0-9_-]{43}$/u);

export const asfControlAuthenticationSchema = z
  .object({
    schema: z.literal(ASF_CONTROL_AUTH_SCHEMA),
    controller_id: identifierSchema,
    key_id: identifierSchema,
    issued_at: timestampSchema,
    expires_at: timestampSchema,
    nonce: nonceSchema,
    request_digest: digestSchema,
    signature: signatureSchema,
  })
  .strict();

export type AsfControlAuthentication = z.infer<typeof asfControlAuthenticationSchema>;

export interface AsfControlAuthenticationProvider {
  authenticate(request: ControlRequest): AsfControlAuthentication;
}

export interface AsfControlAuthenticationVerifier {
  verify(request: ControlRequest, rawAuthentication: unknown): void | Promise<void>;
}

export interface AsfControlAuthenticationKey {
  readonly controllerId: string;
  readonly keyId: string;
  /** Dedicated high-entropy local control key. Never a provider or ASF signing key. */
  readonly secret: string | Uint8Array;
}

export type AsfControlAuthenticationRefusal =
  | "malformed"
  | "untrusted-controller"
  | "invalid-time"
  | "binding-mismatch"
  | "invalid-signature"
  | "replay"
  | "replay-capacity";

export class AsfControlAuthenticationError extends Error {
  readonly reason: AsfControlAuthenticationRefusal;

  constructor(reason: AsfControlAuthenticationRefusal) {
    super(`ASF control authentication refused: ${reason}`);
    this.name = "AsfControlAuthenticationError";
    this.reason = reason;
  }
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  const bytes =
    typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (bytes.byteLength < 32) {
    throw new Error("ASF control authentication keys must contain at least 32 bytes");
  }
  return bytes;
}

function keyCoordinate(controllerId: string, keyId: string): string {
  return `${controllerId}\u0000${keyId}`;
}

function signingPayload(
  authentication: Omit<AsfControlAuthentication, "signature">,
): string {
  return canonicalJson(authentication);
}

function hmac(secret: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function encodeSignature(bytes: Uint8Array): string {
  return `base64url:${Buffer.from(bytes).toString("base64url")}`;
}

function decodeSignature(value: string): Buffer {
  return Buffer.from(value.slice("base64url:".length), "base64url");
}

export interface AsfControlRequestSignerOptions {
  readonly key: AsfControlAuthenticationKey;
  readonly clock: Clock;
  readonly lifetimeMs?: number | undefined;
  readonly nonce?: (() => string) | undefined;
}

/** Creates short-lived, one-request capabilities for the trusted ASF controller. */
export class AsfControlRequestSigner implements AsfControlAuthenticationProvider {
  readonly #controllerId: string;
  readonly #keyId: string;
  readonly #secret: Uint8Array;
  readonly #clock: Clock;
  readonly #lifetimeMs: number;
  readonly #nonce: () => string;

  constructor(options: AsfControlRequestSignerOptions) {
    this.#controllerId = identifierSchema.parse(options.key.controllerId);
    this.#keyId = identifierSchema.parse(options.key.keyId);
    this.#secret = secretBytes(options.key.secret);
    this.#clock = options.clock;
    this.#lifetimeMs = options.lifetimeMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.#lifetimeMs) ||
      this.#lifetimeMs < 1 ||
      this.#lifetimeMs > 30_000
    ) {
      throw new Error("ASF control authentication lifetime must be between 1 and 30000 ms");
    }
    this.#nonce =
      options.nonce ?? (() => `base64url:${randomBytes(24).toString("base64url")}`);
  }

  authenticate(request: ControlRequest): AsfControlAuthentication {
    const issuedAt = this.#clock.now();
    const unsigned = {
      schema: ASF_CONTROL_AUTH_SCHEMA,
      controller_id: this.#controllerId,
      key_id: this.#keyId,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.#lifetimeMs).toISOString(),
      nonce: nonceSchema.parse(this.#nonce()),
      request_digest: controlRequestDigest(request),
    } as const;
    return asfControlAuthenticationSchema.parse({
      ...unsigned,
      signature: encodeSignature(hmac(this.#secret, signingPayload(unsigned))),
    });
  }
}

export interface AsfControlRequestAuthenticatorOptions {
  readonly keys: readonly AsfControlAuthenticationKey[];
  readonly clock: Clock;
  readonly maximumLifetimeMs?: number | undefined;
  readonly maximumClockSkewMs?: number | undefined;
  readonly maximumLiveNonces?: number | undefined;
}

/** Strict verifier with a bounded in-memory nonce replay fence. */
export class AsfControlRequestAuthenticator implements AsfControlAuthenticationVerifier {
  readonly #keys = new Map<string, Uint8Array>();
  readonly #clock: Clock;
  readonly #maximumLifetimeMs: number;
  readonly #maximumClockSkewMs: number;
  readonly #maximumLiveNonces: number;
  readonly #nonces = new Map<string, number>();

  constructor(options: AsfControlRequestAuthenticatorOptions) {
    if (options.keys.length === 0) {
      throw new Error("ASF control authentication requires a trusted controller key");
    }
    for (const key of options.keys) {
      const controllerId = identifierSchema.parse(key.controllerId);
      const keyId = identifierSchema.parse(key.keyId);
      const coordinate = keyCoordinate(controllerId, keyId);
      if (this.#keys.has(coordinate)) {
        throw new Error("ASF control authentication keys must have unique coordinates");
      }
      this.#keys.set(coordinate, secretBytes(key.secret));
    }
    this.#clock = options.clock;
    this.#maximumLifetimeMs = options.maximumLifetimeMs ?? 5_000;
    this.#maximumClockSkewMs = options.maximumClockSkewMs ?? 1_000;
    this.#maximumLiveNonces = options.maximumLiveNonces ?? 10_000;
    for (const value of [
      this.#maximumLifetimeMs,
      this.#maximumClockSkewMs,
      this.#maximumLiveNonces,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("ASF control authentication bounds must be positive safe integers");
      }
    }
    if (this.#maximumLifetimeMs > 30_000 || this.#maximumClockSkewMs > 30_000) {
      throw new Error("ASF control authentication time bounds exceed 30000 ms");
    }
  }

  verify(request: ControlRequest, rawAuthentication: unknown): void {
    const parsed = asfControlAuthenticationSchema.safeParse(rawAuthentication);
    if (!parsed.success) throw new AsfControlAuthenticationError("malformed");
    const authentication = parsed.data;
    const secret = this.#keys.get(
      keyCoordinate(authentication.controller_id, authentication.key_id),
    );
    if (secret === undefined) {
      throw new AsfControlAuthenticationError("untrusted-controller");
    }

    const nowMs = this.#clock.now().getTime();
    const issuedAtMs = Date.parse(authentication.issued_at);
    const expiresAtMs = Date.parse(authentication.expires_at);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs > nowMs + this.#maximumClockSkewMs ||
      expiresAtMs < nowMs - this.#maximumClockSkewMs ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > this.#maximumLifetimeMs
    ) {
      throw new AsfControlAuthenticationError("invalid-time");
    }
    if (authentication.request_digest !== controlRequestDigest(request)) {
      throw new AsfControlAuthenticationError("binding-mismatch");
    }

    const { signature, ...unsigned } = authentication;
    const expected = hmac(secret, signingPayload(unsigned));
    const actual = decodeSignature(signature);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new AsfControlAuthenticationError("invalid-signature");
    }

    for (const [nonce, expiry] of this.#nonces) {
      if (expiry < nowMs - this.#maximumClockSkewMs) this.#nonces.delete(nonce);
    }
    const replayCoordinate = `${authentication.controller_id}\u0000${authentication.key_id}\u0000${authentication.nonce}`;
    if (this.#nonces.has(replayCoordinate)) {
      throw new AsfControlAuthenticationError("replay");
    }
    if (this.#nonces.size >= this.#maximumLiveNonces) {
      throw new AsfControlAuthenticationError("replay-capacity");
    }
    this.#nonces.set(replayCoordinate, expiresAtMs);
  }
}

function controlRequestDigest(request: ControlRequest): string {
  // Every request crosses parseControlRequest before verification. Its nested
  // Work Order is intentionally typed as unknown until the admission service,
  // but the wire value is still canonical JSON at this boundary.
  return sha256Digest(request as unknown as JsonValue);
}
