import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { asfDaemonRuntimePaths, type RuntimePaths } from "../daemon/control.js";
import {
  AsfWorkerHost,
  AsfWorkerHostReadinessError,
  type AsfWorkerHostOptions,
  type AsfWorkerHostService,
} from "./worker-host.js";

export const ASF_WORKER_RUNTIME_MODULE_ENV = "RUNMILL_ASF_RUNTIME_MODULE" as const;

const MAX_RUNTIME_PATH_BYTES = 4_096;
const MAX_RUNTIME_MODULE_BYTES = 1024 * 1024;
const FACTORY_EXPORT = "createAsfWorkerHostOptions";
const ALLOWED_MODULE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts"]);
const HOST_OPTION_KEYS: ReadonlySet<string> = new Set([
  "mode",
  "service",
  "repoRoot",
  "configPath",
  "startedAt",
  "paths",
  "controlAuthentication",
  "readiness",
  "onBackgroundError",
]);
const REQUIRED_SERVICE_METHODS = [
  "submitWorkOrder",
  "getRun",
  "listRunEvents",
  "getEvidence",
  "requestCancellation",
  "recordApproval",
  "requestReconciliation",
  "acknowledgeOutcome",
  "health",
  "recover",
  "requestStop",
] as const;

export interface AsfWorkerRuntimeFactoryContext {
  readonly mode: "asf-worker";
  readonly startedAt: string;
  readonly runtimePaths: RuntimePaths;
}

export interface StartAsfWorkerFromRuntimeOptions {
  readonly mode: "asf-worker";
  readonly runtimeModulePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Supplied by the trusted caller's injected clock. */
  readonly startedAt: string;
}

/** A stable, public-safe reason for refusing an untrusted composition module. */
export class AsfWorkerRuntimeConfigurationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`ASF worker runtime refused: ${reason}`);
    this.name = "AsfWorkerRuntimeConfigurationError";
    this.reason = reason;
  }
}

interface TrustedModuleFile {
  readonly descriptor: number;
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly identity: Stats;
}

function refuse(reason: string): never {
  throw new AsfWorkerRuntimeConfigurationError(reason);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function configuredRuntimeModulePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const ambient = env[ASF_WORKER_RUNTIME_MODULE_ENV];
  const hasExplicit = explicit !== undefined && explicit.trim() !== "";
  const hasAmbient = ambient !== undefined && ambient.trim() !== "";
  if (hasExplicit && hasAmbient && explicit !== ambient) {
    return refuse("runtime-module-path-conflict");
  }
  const selected = hasExplicit ? explicit : hasAmbient ? ambient : undefined;
  if (selected === undefined) return refuse("runtime-module-required");
  return selected;
}

function openTrustedRuntimeModule(path: string): TrustedModuleFile {
  if (
    !isAbsolute(path) ||
    hasControlCharacters(path) ||
    Buffer.byteLength(path, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    !ALLOWED_MODULE_EXTENSIONS.has(extname(path))
  ) {
    return refuse("runtime-module-path-invalid");
  }
  if (typeof process.getuid !== "function") {
    return refuse("runtime-module-platform-unsupported");
  }

  let descriptor: number | undefined;
  let transferred = false;
  try {
    const requested = lstatSync(path);
    if (requested.isSymbolicLink()) return refuse("runtime-module-file-unsafe");
    const canonicalPath = realpathSync(path);
    if (Buffer.byteLength(canonicalPath, "utf8") > MAX_RUNTIME_PATH_BYTES) {
      return refuse("runtime-module-path-invalid");
    }

    const currentUid = process.getuid();
    const parent = lstatSync(dirname(canonicalPath));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.uid !== 0 && parent.uid !== currentUid) ||
      (parent.mode & 0o022) !== 0
    ) {
      return refuse("runtime-module-directory-unsafe");
    }

    descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor);
    const canonicalEntry = lstatSync(canonicalPath);
    if (
      !identity.isFile() ||
      !canonicalEntry.isFile() ||
      canonicalEntry.isSymbolicLink() ||
      identity.nlink !== 1 ||
      (identity.uid !== 0 && identity.uid !== currentUid) ||
      (identity.mode & 0o022) !== 0 ||
      identity.size < 1 ||
      identity.size > MAX_RUNTIME_MODULE_BYTES ||
      !sameFile(identity, requested) ||
      !sameFile(identity, canonicalEntry)
    ) {
      return refuse("runtime-module-file-unsafe");
    }
    transferred = true;
    return { descriptor, requestedPath: path, canonicalPath, identity };
  } catch (error) {
    if (error instanceof AsfWorkerRuntimeConfigurationError) throw error;
    return refuse("runtime-module-file-unavailable");
  } finally {
    if (descriptor !== undefined && !transferred) closeSync(descriptor);
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function assertModuleUnchanged(file: TrustedModuleFile): void {
  try {
    const descriptor = fstatSync(file.descriptor);
    const requested = lstatSync(file.requestedPath);
    const entry = lstatSync(file.canonicalPath);
    if (
      !requested.isFile() ||
      requested.isSymbolicLink() ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !sameFile(file.identity, descriptor) ||
      !sameFile(file.identity, requested) ||
      !sameFile(file.identity, entry)
    ) {
      return refuse("runtime-module-changed-during-load");
    }
  } catch (error) {
    if (error instanceof AsfWorkerRuntimeConfigurationError) throw error;
    return refuse("runtime-module-changed-during-load");
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    isAbsolute(value) &&
    !hasControlCharacters(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_RUNTIME_PATH_BYTES
  );
}

function pathsMatch(left: RuntimePaths, right: RuntimePaths): boolean {
  return (
    left.directory === right.directory &&
    left.registry === right.registry &&
    left.socket === right.socket
  );
}

function validRuntimePaths(value: unknown): value is RuntimePaths {
  const paths = asObject(value);
  return (
    paths !== undefined &&
    Object.keys(paths).length === 3 &&
    validAbsolutePath(paths["directory"]) &&
    validAbsolutePath(paths["registry"]) &&
    validAbsolutePath(paths["socket"])
  );
}

function assertFactoryOptions(
  raw: unknown,
  context: AsfWorkerRuntimeFactoryContext,
): AsfWorkerHostOptions {
  const options = asObject(raw);
  if (options === undefined) return refuse("runtime-module-options-invalid");
  const prototype = Object.getPrototypeOf(options) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return refuse("runtime-module-options-invalid");
  }
  const ownKeys = Reflect.ownKeys(options);
  if (
    ownKeys.some((key) => typeof key !== "string" || !HOST_OPTION_KEYS.has(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(options)).some(
      (descriptor) => !("value" in descriptor),
    )
  ) {
    return refuse("runtime-module-options-invalid");
  }

  const service = asObject(options["service"]);
  const authentication = asObject(options["controlAuthentication"]);
  if (
    options["mode"] !== "asf-worker" ||
    options["startedAt"] !== context.startedAt ||
    !validAbsolutePath(options["repoRoot"]) ||
    !validAbsolutePath(options["configPath"]) ||
    service === undefined ||
    REQUIRED_SERVICE_METHODS.some((method) => typeof service[method] !== "function") ||
    authentication === undefined ||
    typeof authentication["verify"] !== "function" ||
    typeof options["readiness"] !== "function" ||
    (options["onBackgroundError"] !== undefined &&
      typeof options["onBackgroundError"] !== "function")
  ) {
    return refuse("runtime-module-options-invalid");
  }

  const suppliedPaths = options["paths"];
  if (
    suppliedPaths !== undefined &&
    (!validRuntimePaths(suppliedPaths) || !pathsMatch(suppliedPaths, context.runtimePaths))
  ) {
    return refuse("runtime-module-control-path-conflict");
  }

  // These fields are process-owned even though the trusted module must return
  // matching evidence. Writing them last closes accidental spread/override
  // paths and guarantees the literal ASF mode and isolated control endpoint.
  return {
    ...(options as unknown as AsfWorkerHostOptions),
    mode: "asf-worker",
    startedAt: context.startedAt,
    paths: context.runtimePaths,
    service: service as unknown as AsfWorkerHostService,
  };
}

async function loadFactoryOptions(
  path: string,
  context: AsfWorkerRuntimeFactoryContext,
): Promise<AsfWorkerHostOptions> {
  const file = openTrustedRuntimeModule(path);
  try {
    const identity = file.identity;
    const cacheKey = `${identity.dev}-${identity.ino}-${identity.size}-${identity.mtimeMs}`;
    let namespace: Record<string, unknown>;
    try {
      namespace = (await import(
        `${pathToFileURL(file.canonicalPath).href}?runmill_asf_runtime=${encodeURIComponent(cacheKey)}`
      )) as Record<string, unknown>;
    } catch {
      return refuse("runtime-module-load-failed");
    }
    assertModuleUnchanged(file);
    const factory = namespace[FACTORY_EXPORT];
    if (typeof factory !== "function") return refuse("runtime-module-factory-required");

    let raw: unknown;
    try {
      raw = await (factory as (input: AsfWorkerRuntimeFactoryContext) => unknown)(context);
    } catch {
      return refuse("runtime-module-factory-failed");
    }
    assertModuleUnchanged(file);
    try {
      return assertFactoryOptions(raw, context);
    } catch (error) {
      if (error instanceof AsfWorkerRuntimeConfigurationError) throw error;
      return refuse("runtime-module-options-invalid");
    }
  } finally {
    closeSync(file.descriptor);
  }
}

/** Load a trusted deployment composition and start the production-gated host. */
export async function startAsfWorkerFromRuntime(
  input: StartAsfWorkerFromRuntimeOptions,
): Promise<AsfWorkerHost> {
  if ((input as { readonly mode?: unknown }).mode !== "asf-worker") {
    return refuse("explicit-asf-worker-mode-required");
  }
  const env = input.env ?? process.env;
  const path = configuredRuntimeModulePath(input.runtimeModulePath, env);
  const startedAt = input.startedAt;
  if (
    typeof startedAt !== "string" ||
    !Number.isFinite(Date.parse(startedAt))
  ) {
    return refuse("started-at-invalid");
  }
  const runtimePaths = asfDaemonRuntimePaths(env);
  if (!validRuntimePaths(runtimePaths)) return refuse("runtime-control-path-invalid");
  const context: AsfWorkerRuntimeFactoryContext = Object.freeze({
    mode: "asf-worker",
    startedAt,
    runtimePaths: Object.freeze(runtimePaths),
  });
  const options = await loadFactoryOptions(path, context);
  try {
    return await AsfWorkerHost.start(options);
  } catch (error) {
    if (error instanceof AsfWorkerHostReadinessError) throw error;
    return refuse("host-start-failed");
  }
}
