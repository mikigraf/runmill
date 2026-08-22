import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import { canonicalJson } from "../asf/canonical-json.js";
import type { AsfEvidencePredicate } from "./asf-bundle.js";
import type { AsfEvidenceArtifactResolver } from "./asf-validator.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const LOCATION = /^cas:\/\/sha256\/([a-f0-9]{64})$/u;
const PRIVATE_MODE_MASK = 0o077;
const METADATA_LIMIT_BYTES = 16 * 1_024;

const metadataSchema = z
  .object({
    schema: z.literal("runmill.filesystem-cas-metadata/v1"),
    digest: z.string().regex(DIGEST),
    size_bytes: z.number().int().nonnegative(),
    media_type: z.string().min(3).max(256),
    kind: z.enum([
      "work-order-envelope",
      "effective-policy",
      "normalized-diff",
      "agent-outcome",
      "verification",
      "ci-observation",
      "review",
      "side-effect",
      "approval",
      "runtime-manifest",
    ]),
    retention_class: z.enum(["portable", "protected", "restricted"]),
    privacy_class: z.enum([
      "structured-evidence",
      "prompt",
      "model-transcript",
      "raw-source-archive",
    ]),
    created_at: z.iso.datetime({ offset: true }),
    retain_until: z.iso.datetime({ offset: true }),
  })
  .strict();

type ArtifactDeclaration = AsfEvidencePredicate["artifacts"][number];
type ArtifactKind = ArtifactDeclaration["kind"];
export type AsfArtifactRetentionClass = ArtifactDeclaration["retention_class"];
export type AsfArtifactPrivacyClass = z.infer<typeof metadataSchema>["privacy_class"];

export interface FilesystemAsfArtifactStoreOptions {
  /** Dedicated private directory. It is created when absent, but may not be a symlink. */
  readonly rootDirectory: string;
  readonly clock: Clock;
  readonly maxArtifactBytes: number;
  readonly retentionMs: Readonly<Record<AsfArtifactRetentionClass, number>>;
}

export interface PutAsfArtifactInput {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly retentionClass: AsfArtifactRetentionClass;
  readonly privacyClass: AsfArtifactPrivacyClass;
  readonly bytes: Uint8Array;
  /** Optional caller-known digest. A contradiction is refused before writing. */
  readonly expectedDigest?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AsfEvidenceArtifactWriter {
  put(input: PutAsfArtifactInput): Promise<ArtifactDeclaration>;
}

export class FilesystemAsfArtifactStoreError extends Error {
  constructor(message: string) {
    super(`filesystem ASF artifact store refused operation: ${message}`);
    this.name = "FilesystemAsfArtifactStoreError";
  }
}

function refuse(message: string): never {
  throw new FilesystemAsfArtifactStoreError(message);
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) refuse(`${label} must be a positive safe integer`);
}

function normalizedMediaType(value: string): string {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)) {
    refuse("media type is invalid or non-canonical");
  }
  return value;
}

function normalizedArtifactId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    refuse("artifact id is invalid");
  }
  return value;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) refuse("operation was cancelled");
}

function assertPrivacy(
  privacyClass: AsfArtifactPrivacyClass,
  retentionClass: AsfArtifactRetentionClass,
  mediaType: string,
  bytes: Uint8Array,
): void {
  if (retentionClass === "portable" && privacyClass !== "structured-evidence") {
    refuse(`${privacyClass} artifacts cannot be portable`);
  }
  if (retentionClass === "portable" && mediaType !== "application/json") {
    refuse("portable artifacts must use application/json structured evidence");
  }

  const text = Buffer.from(bytes).toString("utf8");
  // Credential material never belongs in evidence, even under a restricted
  // retention label. This catches common raw tokens before content is made
  // addressable; structured-key checks below cover less recognizable values.
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u.test(text) ||
    /\bAKIA[A-Z0-9]{16}\b/u.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu.test(text)
  ) {
    refuse("artifact body appears to contain credential material");
  }

  if (mediaType !== "application/json") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("application/json artifact body is not valid JSON");
  }
  const credentialKeys = new Set([
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "private_key",
    "provider_token",
    "secret",
    "session_token",
    "token",
  ]);
  const protectedKeys = new Set([
    "model_transcript",
    "prompt",
    "raw_source_archive",
    "reasoning",
    "transcript",
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [rawKey, item] of Object.entries(value)) {
      const key = rawKey.toLowerCase().replaceAll("-", "_");
      if (credentialKeys.has(key)) refuse(`artifact contains forbidden credential field ${JSON.stringify(rawKey)}`);
      if (retentionClass === "portable" && protectedKeys.has(key)) {
        refuse(`portable artifact contains protected field ${JSON.stringify(rawKey)}`);
      }
      visit(item);
    }
  };
  visit(parsed);
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    refuse(`${label} must be a real directory`);
  }
  if ((stat.mode & PRIVATE_MODE_MASK) !== 0) {
    refuse(`${label} must not grant group or other permissions`);
  }
}

async function writePrivateTemporary(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (
    stat === undefined ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & PRIVATE_MODE_MASK) !== 0
  ) {
    refuse(`${label} must be a private, single-link regular file`);
  }
}

async function boundedRead(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > maxBytes) refuse("artifact exceeds its bounded read limit");
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    assertNotAborted(signal);
    const remaining = maxBytes + 1 - position;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position > maxBytes) refuse("artifact grew beyond its bounded read limit");
  return Buffer.concat(chunks, position);
}

/**
 * Private local content-addressed storage for evidence artifacts. Body and
 * metadata files are installed with hard-link based create-if-absent writes;
 * existing content is validated and never replaced.
 */
export class FilesystemAsfArtifactStore
  implements AsfEvidenceArtifactResolver, AsfEvidenceArtifactWriter
{
  readonly #rootDirectory: string;
  readonly #objectsDirectory: string;
  readonly #temporaryDirectory: string;
  readonly #options: FilesystemAsfArtifactStoreOptions;

  constructor(options: FilesystemAsfArtifactStoreOptions) {
    if (!isAbsolute(options.rootDirectory)) refuse("root directory must be absolute");
    positiveSafeInteger(options.maxArtifactBytes, "maximum artifact bytes");
    for (const retentionClass of ["portable", "protected", "restricted"] as const) {
      positiveSafeInteger(options.retentionMs[retentionClass], `${retentionClass} retention`);
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#objectsDirectory = join(this.#rootDirectory, "sha256");
    this.#temporaryDirectory = join(this.#rootDirectory, ".tmp");
    this.#options = options;
  }

  async #ensureLayout(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.#rootDirectory, "artifact root");
    await mkdir(this.#objectsDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await mkdir(this.#temporaryDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await assertPrivateDirectory(this.#objectsDirectory, "artifact object directory");
    await assertPrivateDirectory(this.#temporaryDirectory, "artifact temporary directory");
  }

  #paths(digest: string): { readonly body: string; readonly metadata: string } {
    if (!DIGEST.test(digest)) refuse("digest is invalid or non-canonical");
    const hex = digest.slice("sha256:".length);
    return {
      body: join(this.#objectsDirectory, hex),
      metadata: join(this.#objectsDirectory, `${hex}.metadata.json`),
    };
  }

  async #installNoOverwrite(target: string, bytes: Uint8Array): Promise<boolean> {
    const temporary = join(this.#temporaryDirectory, randomUUID());
    await writePrivateTemporary(temporary, bytes);
    try {
      try {
        await link(temporary, target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #readMetadata(path: string): Promise<z.infer<typeof metadataSchema>> {
    await assertPrivateRegularFile(path, "artifact metadata");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      bytes = await boundedRead(handle, METADATA_LIMIT_BYTES, undefined);
      const stat = await handle.stat();
      if (stat.nlink !== 1 || (stat.mode & PRIVATE_MODE_MASK) !== 0) {
        refuse("opened artifact metadata is not a private, single-link file");
      }
    } finally {
      await handle.close();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return refuse("artifact metadata is malformed JSON");
    }
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success) refuse("artifact metadata is malformed");
    return parsed.data;
  }

  async put(input: PutAsfArtifactInput): Promise<ArtifactDeclaration> {
    assertNotAborted(input.signal);
    await this.#ensureLayout();
    normalizedArtifactId(input.artifactId);
    const mediaType = normalizedMediaType(input.mediaType);
    if (!(input.bytes instanceof Uint8Array)) refuse("artifact body must be bytes");
    if (input.bytes.byteLength > this.#options.maxArtifactBytes) {
      refuse("artifact exceeds the configured write limit");
    }
    assertPrivacy(input.privacyClass, input.retentionClass, mediaType, input.bytes);
    const digest = digestBytes(input.bytes);
    if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
      refuse("artifact body contradicts the caller-provided digest");
    }
    const now = this.#options.clock.now();
    const nowMs = now.getTime();
    const retainUntilMs = nowMs + this.#options.retentionMs[input.retentionClass];
    if (!Number.isSafeInteger(retainUntilMs) || retainUntilMs <= nowMs) {
      refuse("artifact retention deadline is invalid");
    }
    const metadata = metadataSchema.parse({
      schema: "runmill.filesystem-cas-metadata/v1",
      digest,
      size_bytes: input.bytes.byteLength,
      media_type: mediaType,
      kind: input.kind,
      retention_class: input.retentionClass,
      privacy_class: input.privacyClass,
      created_at: now.toISOString(),
      retain_until: new Date(retainUntilMs).toISOString(),
    });
    const paths = this.#paths(digest);
    const installedBody = await this.#installNoOverwrite(paths.body, input.bytes);
    try {
      await assertPrivateRegularFile(paths.body, "artifact body");
      const installedMetadata = await this.#installNoOverwrite(
        paths.metadata,
        Buffer.from(canonicalJson(metadata), "utf8"),
      );
      const durableMetadata = await this.#readMetadata(paths.metadata);
      const durableDeclaration = {
        digest: durableMetadata.digest,
        size_bytes: durableMetadata.size_bytes,
        media_type: durableMetadata.media_type,
        kind: durableMetadata.kind,
        retention_class: durableMetadata.retention_class,
        privacy_class: durableMetadata.privacy_class,
      };
      const requestedDeclaration = {
        digest: metadata.digest,
        size_bytes: metadata.size_bytes,
        media_type: metadata.media_type,
        kind: metadata.kind,
        retention_class: metadata.retention_class,
        privacy_class: metadata.privacy_class,
      };
      if (canonicalJson(durableDeclaration) !== canonicalJson(requestedDeclaration)) {
        refuse("existing artifact metadata contradicts the requested declaration");
      }
      if (!installedMetadata && installedBody) {
        refuse("artifact metadata existed before its content-addressed body");
      }
    } catch (error) {
      if (installedBody) await unlink(paths.body).catch(() => undefined);
      throw error;
    }
    const verified = await this.read({
      locationRef: `cas://sha256/${digest.slice("sha256:".length)}`,
      expectedDigest: digest,
      maxBytes: this.#options.maxArtifactBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (verified.byteLength !== input.bytes.byteLength) refuse("stored artifact size changed");
    return {
      artifact_id: input.artifactId,
      kind: input.kind,
      size_bytes: input.bytes.byteLength,
      media_type: mediaType,
      digest,
      retention_class: input.retentionClass,
      location_ref: `cas://sha256/${digest.slice("sha256:".length)}`,
    };
  }

  async read(input: {
    readonly locationRef: string;
    readonly expectedDigest: string;
    readonly maxBytes: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<Uint8Array> {
    assertNotAborted(input.signal);
    positiveSafeInteger(input.maxBytes, "bounded read limit");
    if (input.maxBytes > this.#options.maxArtifactBytes) {
      refuse("bounded read limit exceeds the store policy");
    }
    const match = LOCATION.exec(input.locationRef);
    if (match === null) refuse("location must be a canonical cas://sha256 URI");
    const digest = `sha256:${match[1] ?? ""}`;
    if (input.expectedDigest !== digest || !DIGEST.test(input.expectedDigest)) {
      refuse("location and expected digest do not match exactly");
    }
    await this.#ensureLayout();
    const paths = this.#paths(digest);
    await assertPrivateRegularFile(paths.body, "artifact body");
    const metadata = await this.#readMetadata(paths.metadata);
    if (metadata.digest !== digest || metadata.size_bytes > input.maxBytes) {
      refuse("artifact metadata contradicts the requested digest or read limit");
    }
    const retainUntil = Date.parse(metadata.retain_until);
    if (!Number.isFinite(retainUntil) || retainUntil <= this.#options.clock.now().getTime()) {
      refuse("artifact retention has expired");
    }
    const handle = await open(paths.body, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      bytes = await boundedRead(handle, input.maxBytes, input.signal);
      const stat = await handle.stat();
      if (stat.nlink !== 1 || (stat.mode & PRIVATE_MODE_MASK) !== 0) {
        refuse("opened artifact is not a private, single-link file");
      }
    } finally {
      await handle.close();
    }
    if (bytes.byteLength !== metadata.size_bytes || digestBytes(bytes) !== digest) {
      refuse("artifact body contradicts its immutable metadata or digest");
    }
    return bytes;
  }
}
