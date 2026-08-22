import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Clock } from "../platform/clock.js";
import {
  AsfControlRequestAuthenticator,
  AsfControlRequestSigner,
  type AsfControlAuthenticationKey,
} from "./control-auth.js";

export const ASF_CONTROL_AUTH_ENV = {
  controllerId: "RUNMILL_ASF_CONTROL_CONTROLLER_ID",
  keyId: "RUNMILL_ASF_CONTROL_KEY_ID",
  keyFile: "RUNMILL_ASF_CONTROL_KEY_FILE",
} as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`ASF control authentication requires ${name}`);
  }
  return value;
}

export function loadAsfControlAuthenticationKey(
  env: NodeJS.ProcessEnv = process.env,
): AsfControlAuthenticationKey {
  const controllerId = required(env, ASF_CONTROL_AUTH_ENV.controllerId);
  const keyId = required(env, ASF_CONTROL_AUTH_ENV.keyId);
  const keyFile = required(env, ASF_CONTROL_AUTH_ENV.keyFile);
  if (!isAbsolute(keyFile) || /[\u0000-\u001f\u007f]/u.test(keyFile)) {
    throw new Error("ASF control key file must be an absolute non-control path");
  }
  let secret: string;
  let descriptor: number | undefined;
  try {
    if (typeof process.getuid !== "function" || lstatSync(keyFile).isSymbolicLink()) {
      throw new Error("unsupported or symlinked key path");
    }
    // Resolve trusted platform aliases such as macOS /var -> /private/var,
    // then open the canonical final component with O_NOFOLLOW.
    const canonicalKeyFile = realpathSync(keyFile);
    const currentUid = process.getuid();
    const parent = lstatSync(dirname(canonicalKeyFile));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.uid !== 0 && parent.uid !== currentUid) ||
      (parent.mode & 0o022) !== 0
    ) {
      throw new Error("unsafe key directory");
    }

    descriptor = openSync(canonicalKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.uid !== 0 && stat.uid !== currentUid) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 32 ||
      stat.size > 4_096
    ) {
      throw new Error("unsafe key file");
    }
    secret = readFileSync(descriptor, "utf8").replace(/\r?\n$/u, "");
    const afterRead = fstatSync(descriptor);
    if (
      afterRead.dev !== stat.dev ||
      afterRead.ino !== stat.ino ||
      afterRead.size !== stat.size ||
      afterRead.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error("key changed while being read");
    }
  } catch {
    throw new Error("ASF control key file is missing or not a private regular file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("ASF control key file does not contain a 32-byte key");
  }
  return { controllerId, keyId, secret };
}

export function loadAsfControlRequestSigner(
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
): AsfControlRequestSigner {
  return new AsfControlRequestSigner({
    key: loadAsfControlAuthenticationKey(env),
    clock,
  });
}

export function loadAsfControlRequestAuthenticator(
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
): AsfControlRequestAuthenticator {
  return new AsfControlRequestAuthenticator({
    keys: [loadAsfControlAuthenticationKey(env)],
    clock,
  });
}
