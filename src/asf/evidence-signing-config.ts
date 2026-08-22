import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const ASF_EVIDENCE_SIGNING_ENV = {
  keyId: "RUNMILL_ASF_EVIDENCE_SIGNING_KEY_ID",
  keyFile: "RUNMILL_ASF_EVIDENCE_SIGNING_KEY_FILE",
  validFrom: "RUNMILL_ASF_EVIDENCE_SIGNING_KEY_VALID_FROM",
  validUntil: "RUNMILL_ASF_EVIDENCE_SIGNING_KEY_VALID_UNTIL",
} as const;

export interface AsfEvidenceSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** Inclusive signing-time boundary. */
  readonly validFrom: string;
  /** Exclusive signing-time boundary. */
  readonly validUntil: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_KEY_BYTES = 16 * 1_024;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`ASF evidence signing requires ${name}`);
  }
  return value;
}

function parseInstant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`ASF evidence signing requires a valid ${name}`);
  }
  return parsed;
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

function assertSafeParent(path: string, currentUid: number): void {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.uid !== 0 && parent.uid !== currentUid) ||
    (parent.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe ASF evidence signing key directory");
  }
}

function assertPrivateFile(stat: Stats, currentUid: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.uid !== 0 && stat.uid !== currentUid) ||
    (stat.mode & 0o177) !== 0 ||
    (stat.mode & 0o400) === 0 ||
    stat.size < MINIMUM_KEY_BYTES ||
    stat.size > MAXIMUM_KEY_BYTES
  ) {
    throw new Error("unsafe ASF evidence signing key file");
  }
}

/**
 * Load the ASF-only worker-attestation key without following the final path
 * component. This module has no ambient initialization: standalone startup
 * never reads these variables unless an ASF composition root calls this
 * function explicitly.
 */
export function loadAsfEvidenceSigningKey(
  env: NodeJS.ProcessEnv,
): AsfEvidenceSigningKey {
  const keyId = required(env, ASF_EVIDENCE_SIGNING_ENV.keyId);
  const keyFile = required(env, ASF_EVIDENCE_SIGNING_ENV.keyFile);
  const validFrom = required(env, ASF_EVIDENCE_SIGNING_ENV.validFrom);
  const validUntil = required(env, ASF_EVIDENCE_SIGNING_ENV.validUntil);
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("ASF evidence signing key id is invalid");
  }
  if (!isAbsolute(keyFile) || /[\u0000-\u001f\u007f]/u.test(keyFile)) {
    throw new Error("ASF evidence signing key file must be an absolute non-control path");
  }
  const validFromMs = parseInstant(validFrom, ASF_EVIDENCE_SIGNING_ENV.validFrom);
  const validUntilMs = parseInstant(validUntil, ASF_EVIDENCE_SIGNING_ENV.validUntil);
  if (validFromMs >= validUntilMs) {
    throw new Error("ASF evidence signing key validity window is contradictory");
  }
  if (typeof process.getuid !== "function" || constants.O_NOFOLLOW === undefined) {
    throw new Error("ASF evidence signing requires ownership and no-follow file support");
  }

  let descriptor: number | undefined;
  let keyBytes: Buffer | undefined;
  try {
    const currentUid = process.getuid();
    const requestedStat = lstatSync(keyFile);
    if (requestedStat.isSymbolicLink()) {
      throw new Error("symlinked ASF evidence signing key path");
    }
    const canonicalKeyFile = realpathSync(keyFile);
    const canonicalStat = lstatSync(canonicalKeyFile);
    if (canonicalStat.isSymbolicLink() || !sameFile(requestedStat, canonicalStat)) {
      throw new Error("ASF evidence signing key path changed during resolution");
    }
    assertSafeParent(canonicalKeyFile, currentUid);
    assertPrivateFile(canonicalStat, currentUid);

    descriptor = openSync(canonicalKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor);
    assertPrivateFile(openedStat, currentUid);
    if (!sameFile(canonicalStat, openedStat)) {
      throw new Error("ASF evidence signing key changed before open");
    }
    keyBytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    if (!unchanged(openedStat, afterRead) || keyBytes.byteLength !== openedStat.size) {
      throw new Error("ASF evidence signing key changed while being read");
    }

    const privateKey = createPrivateKey(keyBytes);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("ASF evidence signing key must be a private Ed25519 key");
    }
    return {
      keyId,
      privateKey,
      publicKey: createPublicKey(privateKey),
      validFrom,
      validUntil,
    };
  } catch {
    throw new Error(
      "ASF evidence signing key is missing, malformed, or not a private regular Ed25519 key",
    );
  } finally {
    keyBytes?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
