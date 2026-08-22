import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../asf/canonical-json.js";
import type { Clock } from "../platform/clock.js";
import {
  POLICY_DIGEST_PATTERN,
  type IdentityExecutionHandle,
  type IdentityLease,
  type IdentityLeaseId,
} from "./broker.js";

export const PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA =
  "runmill.protected-identity-lease-registry/v1" as const;
export const SEALED_IDENTITY_LEASE_FILE_SCHEMA =
  "runmill.sealed-identity-lease-file/v1" as const;

const MAX_SEALED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEALED_FILES = 4_096;
const SEALED_FILE_NAME_PATTERN = /^([a-f0-9]{64})\.identity-sealed$/u;
const REQUIRED_ROLES = [
  "implementer",
  "local-reviewer",
  "pr-reviewer",
] as const;
const ALL_ROLES = [
  "implementer",
  "local-reviewer",
  "fixer",
  "pr-reviewer",
  "retrospective",
] as const;

export type ProtectedIdentityLeaseRole = (typeof REQUIRED_ROLES)[number];
export type ProtectedIdentityLeasePhase =
  | "acquiring"
  | "active"
  | "revoking"
  | "retired"
  | "failed";

export interface ProtectedIdentityLeaseBinding {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly fencingGeneration: number;
}

export interface ProtectedIdentityProfiles {
  readonly implementer: string;
  readonly localReviewer: string;
  readonly prReviewer: string;
}

export interface ProtectedIdentityLeaseEntry {
  readonly leaseDigest: string;
  readonly lease: IdentityLease;
  /** The required-role slot currently using this exact snapshot, if any. */
  readonly currentRole: ProtectedIdentityLeaseRole | null;
  /** True only after the broker acknowledged retirement or supersession. */
  readonly retired: boolean;
}

export interface ProtectedIdentityLeasePendingOperation {
  readonly kind: "acquire" | "renew" | "revoke";
  readonly role: ProtectedIdentityLeaseRole;
  /** Null only while acquisition has not returned a lease snapshot. */
  readonly leaseDigest: string | null;
}

/**
 * Sensitive controller state. Implementations must never serialize this value
 * outside protected storage or include it in public errors, events, evidence,
 * prompts, tool environments, or support output.
 */
export interface ProtectedIdentityLeaseSnapshot {
  readonly schema: typeof PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA;
  readonly binding: ProtectedIdentityLeaseBinding;
  readonly profiles: ProtectedIdentityProfiles;
  readonly phase: ProtectedIdentityLeasePhase;
  readonly leases: readonly ProtectedIdentityLeaseEntry[];
  readonly pendingOperations: readonly ProtectedIdentityLeasePendingOperation[];
  readonly acquisitionObservation: JsonValue | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly recordDigest: string;
}

/**
 * A compare-and-swap protected store. `expectedRevision` is null only when the
 * exact binding must not already exist. The store, not the caller, increments
 * the revision and binds it to its injected wall clock.
 */
export interface ProtectedIdentityLeaseRegistry {
  load(
    binding: ProtectedIdentityLeaseBinding,
  ): Promise<ProtectedIdentityLeaseSnapshot | null>;
  /**
   * Load every authenticated snapshot for the exact immutable attempt scope.
   *
   * The generation remains part of every returned snapshot's authenticated
   * binding. This method exists only so a newly fenced owner can detect a
   * unique immediate predecessor, contradictory live history, or a snapshot
   * from the future. Implementations must return a stable, complete view or
   * fail closed; they must never select a snapshot on the caller's behalf.
   */
  loadLineage(
    binding: ProtectedIdentityLeaseBinding,
  ): Promise<readonly ProtectedIdentityLeaseSnapshot[]>;
  save(
    snapshot: Omit<
      ProtectedIdentityLeaseSnapshot,
      "revision" | "updatedAt" | "recordDigest"
    >,
    expectedRevision: number | null,
  ): Promise<ProtectedIdentityLeaseSnapshot>;
}

export class ProtectedIdentityLeaseRegistryError extends Error {
  constructor(
    message = "protected identity lease state is unavailable or contradictory",
  ) {
    super(message);
    this.name = "ProtectedIdentityLeaseRegistryError";
  }
}

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
    "must be a bounded printable identifier",
  );
const digestSchema = z.string().regex(POLICY_DIGEST_PATTERN);
const timestampSchema = z.iso.datetime({ offset: true });
const roleSchema = z.enum(ALL_ROLES);
const requiredRoleSchema = z.enum(REQUIRED_ROLES);

const bindingSchema = z
  .object({
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    policyDigest: digestSchema,
    fencingGeneration: z.number().int().positive().safe(),
  })
  .strict();

const profilesSchema = z
  .object({
    implementer: identifierSchema,
    localReviewer: identifierSchema,
    prReviewer: identifierSchema,
  })
  .strict();

const ctxlaneAttributionSchema = z
  .object({
    clientRequestId: identifierSchema,
    requestedTtlSeconds: z.number().int().min(1).max(86_400),
    tenantId: identifierSchema,
    workOrderDigest: digestSchema,
    profileUid: identifierSchema,
    callerSubject: identifierSchema,
    hostIdentity: identifierSchema,
    workerIdentity: identifierSchema.nullable(),
    workspaceId: identifierSchema,
    environment: identifierSchema,
    repository: identifierSchema,
    workspaceRef: identifierSchema.nullable(),
    authMode: identifierSchema.nullable(),
    isolation: identifierSchema.nullable(),
    fencingGeneration: z.number().int().positive().safe().nullable(),
    effectivePolicyDigest: digestSchema.nullable(),
    maximumExpiresAt: timestampSchema.nullable(),
    status: identifierSchema,
  })
  .strict();

const leaseSchema = z
  .object({
    leaseId: identifierSchema,
    executionHandle: identifierSchema,
    runId: identifierSchema,
    workOrderId: identifierSchema,
    attemptId: identifierSchema,
    role: roleSchema,
    policyDigest: digestSchema,
    provider: identifierSchema,
    principal: identifierSchema,
    profile: identifierSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    fencingGeneration: z.number().int().positive().safe(),
    ctxlane: ctxlaneAttributionSchema.optional(),
  })
  .strict();

const leaseEntrySchema = z
  .object({
    leaseDigest: digestSchema,
    lease: leaseSchema,
    currentRole: requiredRoleSchema.nullable(),
    retired: z.boolean(),
  })
  .strict();

const pendingOperationSchema = z
  .object({
    kind: z.enum(["acquire", "renew", "revoke"]),
    role: requiredRoleSchema,
    leaseDigest: digestSchema.nullable(),
  })
  .strict();

const snapshotSchema = z
  .object({
    schema: z.literal(PROTECTED_IDENTITY_LEASE_REGISTRY_SCHEMA),
    binding: bindingSchema,
    profiles: profilesSchema,
    phase: z.enum(["acquiring", "active", "revoking", "retired", "failed"]),
    leases: z.array(leaseEntrySchema).max(64),
    pendingOperations: z.array(pendingOperationSchema).max(64),
    acquisitionObservation: z.unknown().nullable(),
    revision: z.number().int().positive().safe(),
    updatedAt: timestampSchema,
    recordDigest: digestSchema,
  })
  .strict();

const sealedFileSchema = z
  .object({
    schema: z.literal(SEALED_IDENTITY_LEASE_FILE_SCHEMA),
    key_id: identifierSchema,
    binding_digest: digestSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z
      .string()
      .min(1)
      .max(MAX_SEALED_FILE_BYTES * 2)
      .regex(/^[A-Za-z0-9_-]+$/u),
    authentication_tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function sameBinding(
  left: ProtectedIdentityLeaseBinding,
  right: ProtectedIdentityLeaseBinding,
): boolean {
  return (
    left.runId === right.runId &&
    left.workOrderId === right.workOrderId &&
    left.attemptId === right.attemptId &&
    left.policyDigest === right.policyDigest &&
    left.fencingGeneration === right.fencingGeneration
  );
}

export function protectedIdentityLeaseBindingDigest(
  binding: ProtectedIdentityLeaseBinding,
): string {
  return sha256Digest(
    asJson({
      schema: "runmill.protected-identity-lease-binding/v1",
      binding,
    }),
  );
}

export function protectedIdentityLeaseDigest(lease: IdentityLease): string {
  return sha256Digest(
    asJson({
      schema: "runmill.protected-identity-lease-snapshot/v1",
      lease,
    }),
  );
}

function unsignedSnapshot(
  snapshot: Omit<ProtectedIdentityLeaseSnapshot, "recordDigest">,
): JsonValue {
  return asJson(snapshot);
}

function snapshotRecordDigest(
  snapshot: Omit<ProtectedIdentityLeaseSnapshot, "recordDigest">,
): string {
  return sha256Digest(unsignedSnapshot(snapshot));
}

function freezeLease(raw: z.infer<typeof leaseSchema>): IdentityLease {
  const { ctxlane, ...lease } = raw;
  return Object.freeze({
    ...lease,
    leaseId: raw.leaseId as IdentityLeaseId,
    executionHandle: raw.executionHandle as IdentityExecutionHandle,
    ...(ctxlane === undefined
      ? {}
      : { ctxlane: Object.freeze({ ...ctxlane }) }),
  });
}

function parseSnapshot(raw: unknown): ProtectedIdentityLeaseSnapshot {
  const parsed = snapshotSchema.parse(raw);
  const leases = parsed.leases.map((entry) =>
    Object.freeze({
      ...entry,
      lease: freezeLease(entry.lease),
    }),
  );
  const snapshotWithoutDigest = {
    schema: parsed.schema,
    binding: Object.freeze({ ...parsed.binding }),
    profiles: Object.freeze({ ...parsed.profiles }),
    phase: parsed.phase,
    leases: Object.freeze(leases),
    pendingOperations: Object.freeze(
      parsed.pendingOperations.map((operation) =>
        Object.freeze({ ...operation }),
      ),
    ),
    acquisitionObservation: parsed.acquisitionObservation as JsonValue | null,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  };
  if (snapshotRecordDigest(snapshotWithoutDigest) !== parsed.recordDigest) {
    throw new ProtectedIdentityLeaseRegistryError();
  }

  const leaseDigests = new Set<string>();
  const currentRoles = new Set<ProtectedIdentityLeaseRole>();
  for (const entry of leases) {
    if (protectedIdentityLeaseDigest(entry.lease) !== entry.leaseDigest) {
      throw new ProtectedIdentityLeaseRegistryError();
    }
    if (leaseDigests.has(entry.leaseDigest)) {
      throw new ProtectedIdentityLeaseRegistryError();
    }
    leaseDigests.add(entry.leaseDigest);
    if (entry.currentRole !== null) {
      if (entry.retired || currentRoles.has(entry.currentRole)) {
        throw new ProtectedIdentityLeaseRegistryError();
      }
      currentRoles.add(entry.currentRole);
    }
  }
  const pendingKeys = new Set<string>();
  for (const operation of parsed.pendingOperations) {
    if (operation.kind === "acquire" && operation.leaseDigest !== null) {
      throw new ProtectedIdentityLeaseRegistryError();
    }
    if (operation.kind !== "acquire") {
      if (
        operation.leaseDigest === null ||
        !leaseDigests.has(operation.leaseDigest)
      ) {
        throw new ProtectedIdentityLeaseRegistryError();
      }
    }
    const key = `${operation.kind}\u0000${operation.role}\u0000${operation.leaseDigest ?? ""}`;
    if (pendingKeys.has(key)) throw new ProtectedIdentityLeaseRegistryError();
    pendingKeys.add(key);
  }
  if (
    parsed.phase === "active" &&
    (parsed.acquisitionObservation === null ||
      currentRoles.size !== REQUIRED_ROLES.length ||
      REQUIRED_ROLES.some((role) => !currentRoles.has(role)))
  ) {
    throw new ProtectedIdentityLeaseRegistryError();
  }
  if (
    parsed.phase === "retired" &&
    (parsed.pendingOperations.length !== 0 ||
      leases.some((entry) => !entry.retired) ||
      currentRoles.size !== 0)
  ) {
    throw new ProtectedIdentityLeaseRegistryError();
  }

  return Object.freeze({
    ...snapshotWithoutDigest,
    recordDigest: parsed.recordDigest,
  });
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new ProtectedIdentityLeaseRegistryError();
  }
  return decoded;
}

function safeError(): ProtectedIdentityLeaseRegistryError {
  return new ProtectedIdentityLeaseRegistryError();
}

export interface EncryptedFileIdentityLeaseRegistryOptions {
  /** Existing host-protected directory, outside repository-controlled state. */
  readonly directory: string;
  readonly keyId: string;
  /** Exactly 32 bytes of controller-owned AES-256 key material. */
  readonly key: Uint8Array;
  readonly clock: Clock;
}

/**
 * AES-256-GCM sealed, atomic file registry for restart recovery.
 *
 * The filename is only a digest of public binding coordinates. Lease IDs,
 * execution handles, profiles, and attribution are encrypted. Reads and
 * writes reject symlinks, hard links, ownership changes, permissive modes,
 * malformed ciphertext, key mismatches, and compare-and-swap contradictions.
 */
export class EncryptedFileIdentityLeaseRegistry
  implements ProtectedIdentityLeaseRegistry
{
  readonly #directory: string;
  readonly #keyId: string;
  readonly #key: Buffer;
  readonly #clock: Clock;

  constructor(options: EncryptedFileIdentityLeaseRegistryOptions) {
    if (
      !isAbsolute(options.directory) ||
      /[\u0000-\u001f\u007f]/u.test(options.directory) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.keyId) ||
      options.key.byteLength !== 32 ||
      typeof process.getuid !== "function" ||
      constants.O_NOFOLLOW === undefined
    ) {
      throw safeError();
    }
    this.#directory = this.#assertSafeDirectory(options.directory);
    this.#keyId = options.keyId;
    this.#key = Buffer.from(options.key);
    this.#clock = options.clock;
  }

  async load(
    binding: ProtectedIdentityLeaseBinding,
  ): Promise<ProtectedIdentityLeaseSnapshot | null> {
    const parsedBinding = bindingSchema.safeParse(binding);
    if (!parsedBinding.success) throw safeError();
    this.#assertSafeDirectory(this.#directory);
    const bindingDigest = protectedIdentityLeaseBindingDigest(
      parsedBinding.data,
    );
    const path = this.#path(bindingDigest);
    let descriptor: number | undefined;
    let sealedBytes: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const pathStat = lstatSync(path);
      if (pathStat.isSymbolicLink()) throw safeError();
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(descriptor);
      this.#assertPrivateFile(before);
      if (!sameFile(pathStat, before)) throw safeError();
      sealedBytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (!unchanged(before, after) || sealedBytes.byteLength !== before.size) {
        throw safeError();
      }
      const sealed = sealedFileSchema.parse(
        JSON.parse(sealedBytes.toString("utf8")),
      );
      if (
        sealed.key_id !== this.#keyId ||
        sealed.binding_digest !== bindingDigest
      ) {
        throw safeError();
      }
      const nonce = decodeBase64Url(sealed.nonce);
      const ciphertext = decodeBase64Url(sealed.ciphertext);
      const tag = decodeBase64Url(sealed.authentication_tag);
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw safeError();
      const aad = Buffer.from(
        canonicalJson(
          asJson({
            schema: sealed.schema,
            key_id: sealed.key_id,
            binding_digest: sealed.binding_digest,
          }),
        ),
        "utf8",
      );
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const snapshot = parseSnapshot(JSON.parse(plaintext.toString("utf8")));
      if (!sameBinding(snapshot.binding, parsedBinding.data)) throw safeError();
      return snapshot;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw safeError();
    } finally {
      plaintext?.fill(0);
      sealedBytes?.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  async loadLineage(
    binding: ProtectedIdentityLeaseBinding,
  ): Promise<readonly ProtectedIdentityLeaseSnapshot[]> {
    const parsedBinding = bindingSchema.safeParse(binding);
    if (!parsedBinding.success) throw safeError();
    this.#assertSafeDirectory(this.#directory);

    // Read twice. A filename-only comparison would miss an atomic replacement
    // of an existing generation while recovery is deciding which lease set to
    // retire. Comparing authenticated record digests detects both replacement
    // and membership races without weakening each snapshot's exact binding.
    const first = this.#readLineagePass(parsedBinding.data);
    const second = this.#readLineagePass(parsedBinding.data);
    if (
      first.length !== second.length ||
      first.some((entry, index) => {
        const repeated = second[index];
        return (
          repeated === undefined ||
          entry.binding.fencingGeneration !==
            repeated.binding.fencingGeneration ||
          entry.revision !== repeated.revision ||
          entry.recordDigest !== repeated.recordDigest
        );
      })
    ) {
      throw safeError();
    }
    return Object.freeze(second);
  }

  async save(
    snapshot: Omit<
      ProtectedIdentityLeaseSnapshot,
      "revision" | "updatedAt" | "recordDigest"
    >,
    expectedRevision: number | null,
  ): Promise<ProtectedIdentityLeaseSnapshot> {
    const parsedBinding = bindingSchema.safeParse(snapshot.binding);
    if (
      !parsedBinding.success ||
      (expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
    ) {
      throw safeError();
    }
    this.#assertSafeDirectory(this.#directory);
    const bindingDigest = protectedIdentityLeaseBindingDigest(
      parsedBinding.data,
    );
    const lock = this.#acquireWriteLock(bindingDigest);
    try {
      return await this.#saveWhileLocked(
        snapshot,
        parsedBinding.data,
        bindingDigest,
        expectedRevision,
      );
    } finally {
      this.#releaseWriteLock(lock);
    }
  }

  async #saveWhileLocked(
    snapshot: Omit<
      ProtectedIdentityLeaseSnapshot,
      "revision" | "updatedAt" | "recordDigest"
    >,
    parsedBinding: ProtectedIdentityLeaseBinding,
    bindingDigest: string,
    expectedRevision: number | null,
  ): Promise<ProtectedIdentityLeaseSnapshot> {
    const current = await this.load(parsedBinding);
    if (
      (current === null && expectedRevision !== null) ||
      (current !== null && current.revision !== expectedRevision)
    ) {
      throw safeError();
    }
    const revision = (expectedRevision ?? 0) + 1;
    const withoutDigest = {
      ...snapshot,
      binding: Object.freeze({ ...snapshot.binding }),
      profiles: Object.freeze({ ...snapshot.profiles }),
      leases: Object.freeze(
        snapshot.leases.map((entry) =>
          Object.freeze({
            ...entry,
            lease: Object.freeze({ ...entry.lease }),
          }),
        ),
      ),
      pendingOperations: Object.freeze(
        snapshot.pendingOperations.map((operation) =>
          Object.freeze({ ...operation }),
        ),
      ),
      revision,
      updatedAt: this.#clock.now().toISOString(),
    };
    const complete = parseSnapshot({
      ...withoutDigest,
      recordDigest: snapshotRecordDigest(withoutDigest),
    });
    if (!sameBinding(complete.binding, parsedBinding)) throw safeError();

    this.#assertSafeDirectory(this.#directory);
    if (
      protectedIdentityLeaseBindingDigest(complete.binding) !== bindingDigest
    ) {
      throw safeError();
    }
    const path = this.#path(bindingDigest);
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let plaintext: Buffer | undefined;
    let output: Buffer | undefined;
    let descriptor: number | undefined;
    try {
      const nonce = randomBytes(12);
      const aadValue = {
        schema: SEALED_IDENTITY_LEASE_FILE_SCHEMA,
        key_id: this.#keyId,
        binding_digest: bindingDigest,
      } as const;
      const aad = Buffer.from(canonicalJson(asJson(aadValue)), "utf8");
      plaintext = Buffer.from(canonicalJson(asJson(complete)), "utf8");
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const sealed = {
        ...aadValue,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authentication_tag: cipher.getAuthTag().toString("base64url"),
      };
      output = Buffer.from(`${canonicalJson(asJson(sealed))}\n`, "utf8");
      if (output.byteLength > MAX_SEALED_FILE_BYTES) throw safeError();
      descriptor = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, output);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      const directoryDescriptor = openSync(this.#directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      return complete;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file either never existed or was already atomically renamed.
      }
      throw safeError();
    } finally {
      plaintext?.fill(0);
      output?.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #acquireWriteLock(bindingDigest: string): {
    readonly path: string;
    readonly descriptor: number;
    readonly stat: Stats;
  } {
    const path = join(
      this.#directory,
      `${bindingDigest.slice("sha256:".length)}.identity-lock`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, "locked\n", "utf8");
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
        throw safeError();
      }
      this.#fsyncDirectory();
      return { path, descriptor, stat };
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The registry remains fail-closed if the descriptor cannot be closed.
        }
        try {
          unlinkSync(path);
          this.#fsyncDirectory();
        } catch {
          // A surviving lock intentionally blocks later mutation.
        }
      }
      throw safeError();
    }
  }

  #releaseWriteLock(lock: {
    readonly path: string;
    readonly descriptor: number;
    readonly stat: Stats;
  }): void {
    try {
      const pathStat = lstatSync(lock.path);
      const descriptorStat = fstatSync(lock.descriptor);
      if (
        pathStat.isSymbolicLink() ||
        !sameFile(pathStat, descriptorStat) ||
        !sameFile(lock.stat, descriptorStat)
      ) {
        throw safeError();
      }
      unlinkSync(lock.path);
      this.#fsyncDirectory();
    } catch {
      throw safeError();
    } finally {
      closeSync(lock.descriptor);
    }
  }

  #fsyncDirectory(): void {
    const directoryDescriptor = openSync(this.#directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  #path(bindingDigest: string): string {
    return join(
      this.#directory,
      `${bindingDigest.slice("sha256:".length)}.identity-sealed`,
    );
  }

  #readLineagePass(
    binding: ProtectedIdentityLeaseBinding,
  ): ProtectedIdentityLeaseSnapshot[] {
    let names: string[];
    try {
      names = readdirSync(this.#directory)
        .filter((name) => SEALED_FILE_NAME_PATTERN.test(name))
        .sort();
    } catch {
      throw safeError();
    }
    if (names.length > MAX_SEALED_FILES) throw safeError();

    const snapshots: ProtectedIdentityLeaseSnapshot[] = [];
    for (const name of names) {
      const match = SEALED_FILE_NAME_PATTERN.exec(name);
      if (match?.[1] === undefined) throw safeError();
      const expectedBindingDigest = `sha256:${match[1]}`;
      const snapshot = this.#readSealedSnapshot(
        join(this.#directory, name),
        expectedBindingDigest,
      );
      if (
        snapshot.binding.runId === binding.runId &&
        snapshot.binding.workOrderId === binding.workOrderId &&
        snapshot.binding.attemptId === binding.attemptId &&
        snapshot.binding.policyDigest === binding.policyDigest
      ) {
        snapshots.push(snapshot);
      }
    }
    return snapshots.sort(
      (left, right) =>
        left.binding.fencingGeneration - right.binding.fencingGeneration,
    );
  }

  #readSealedSnapshot(
    path: string,
    expectedBindingDigest: string,
  ): ProtectedIdentityLeaseSnapshot {
    let descriptor: number | undefined;
    let sealedBytes: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const pathStat = lstatSync(path);
      if (pathStat.isSymbolicLink()) throw safeError();
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(descriptor);
      this.#assertPrivateFile(before);
      if (!sameFile(pathStat, before)) throw safeError();
      sealedBytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (!unchanged(before, after) || sealedBytes.byteLength !== before.size) {
        throw safeError();
      }
      const sealed = sealedFileSchema.parse(
        JSON.parse(sealedBytes.toString("utf8")),
      );
      if (
        sealed.key_id !== this.#keyId ||
        sealed.binding_digest !== expectedBindingDigest
      ) {
        throw safeError();
      }
      const nonce = decodeBase64Url(sealed.nonce);
      const ciphertext = decodeBase64Url(sealed.ciphertext);
      const tag = decodeBase64Url(sealed.authentication_tag);
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw safeError();
      const aad = Buffer.from(
        canonicalJson(
          asJson({
            schema: sealed.schema,
            key_id: sealed.key_id,
            binding_digest: sealed.binding_digest,
          }),
        ),
        "utf8",
      );
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const snapshot = parseSnapshot(JSON.parse(plaintext.toString("utf8")));
      if (
        protectedIdentityLeaseBindingDigest(snapshot.binding) !==
        expectedBindingDigest
      ) {
        throw safeError();
      }
      return snapshot;
    } catch {
      throw safeError();
    } finally {
      plaintext?.fill(0);
      sealedBytes?.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #assertSafeDirectory(requested: string): string {
    try {
      const currentUid = process.getuid?.();
      if (currentUid === undefined) throw safeError();
      const requestedStat = lstatSync(requested);
      if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory())
        throw safeError();
      const canonical = realpathSync(requested);
      const canonicalStat = lstatSync(canonical);
      if (
        canonicalStat.isSymbolicLink() ||
        !canonicalStat.isDirectory() ||
        !sameFile(requestedStat, canonicalStat) ||
        (canonicalStat.uid !== 0 && canonicalStat.uid !== currentUid) ||
        (canonicalStat.mode & 0o077) !== 0
      ) {
        throw safeError();
      }
      const parent = lstatSync(dirname(canonical));
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (parent.uid !== 0 && parent.uid !== currentUid) ||
        (parent.mode & 0o022) !== 0
      ) {
        throw safeError();
      }
      return canonical;
    } catch {
      throw safeError();
    }
  }

  #assertPrivateFile(stat: Stats): void {
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.uid !== 0 && stat.uid !== currentUid) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > MAX_SEALED_FILE_BYTES
    ) {
      throw safeError();
    }
  }
}
