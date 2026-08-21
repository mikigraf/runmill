import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RunmillError } from "../errors/runmill-error.js";

const CACHE_SCHEMA = 1;
const PACKAGE_JSON = "package.json";
const PACKAGE_LOCK = "package-lock.json";
const NODE_MODULES = "node_modules";
const HIDDEN_LOCK = ".package-lock.json";

interface LockPackage {
  readonly version?: string | undefined;
  readonly resolved?: string | undefined;
  readonly integrity?: string | undefined;
  readonly optional?: boolean | undefined;
  readonly link?: boolean | undefined;
  readonly os?: readonly string[] | undefined;
  readonly cpu?: readonly string[] | undefined;
}

interface NpmLock {
  readonly lockfileVersion?: number | undefined;
  readonly packages?: Readonly<Record<string, LockPackage>> | undefined;
}

interface CacheReceipt {
  readonly schema: 1;
  readonly identity: string;
  readonly packageJsonHash: string;
  readonly packageLockHash: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeModulesAbi: string;
  readonly treeFingerprint: string;
}

export interface PreparedDependencies {
  readonly manager: "npm";
  /** Cache directory containing the immutable node_modules tree and receipt. */
  readonly cachePath: string;
  readonly identity: string;
}

export interface PrepareDependenciesInput {
  /** Exact trusted base/candidate checkout whose lockfiles govern verification. */
  readonly trustedCheckout: string;
  /** Operator checkout containing the result of an explicit npm ci/install. */
  readonly installedSource: string;
  /** Runmill-owned machine-local cache. */
  readonly cacheRoot: string;
}

export interface ValidateInstalledDependenciesInput {
  /** Exact trusted base checkout whose lockfiles govern verification. */
  readonly trustedCheckout: string;
  /** Operator checkout containing the result of an explicit npm ci/install. */
  readonly installedSource: string;
}

export interface ValidatedDependencies {
  readonly manager: "npm";
  readonly identity: string;
}

interface TrustedDependencyIdentity {
  readonly packageJson: Buffer;
  readonly packageLock: Buffer;
  readonly lockPath: string;
  readonly receipt: CacheReceipt;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function dependencyError(detail: string): RunmillError {
  return RunmillError.fromCatalog("RM-VERIFY-005", { whatHappened: detail });
}

function parseJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw dependencyError(`${label} is not valid JSON: ${detail}`);
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function safePackagePath(root: string, packagePath: string): string {
  if (
    packagePath === "" ||
    isAbsolute(packagePath) ||
    packagePath.includes("\\") ||
    packagePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !packagePath.startsWith(`${NODE_MODULES}/`)
  ) {
    throw dependencyError(`package-lock.json contains unsafe package path ${JSON.stringify(packagePath)}`);
  }
  const path = resolve(root, ...packagePath.split("/"));
  if (!inside(root, path)) {
    throw dependencyError(`package-lock.json package path escapes the project: ${packagePath}`);
  }
  return path;
}

function constraintAllowsCurrent(values: readonly string[] | undefined, current: string): boolean {
  if (values === undefined || values.length === 0) return true;
  if (values.includes(`!${current}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

function requiredHere(pkg: LockPackage): boolean {
  return (
    pkg.optional !== true &&
    constraintAllowsCurrent(pkg.os, platform()) &&
    constraintAllowsCurrent(pkg.cpu, arch())
  );
}

function compareLockEntry(path: string, trusted: LockPackage, installed: LockPackage): void {
  for (const key of ["version", "resolved", "integrity"] as const) {
    const expected = trusted[key];
    if (expected !== undefined && installed[key] !== expected) {
      throw dependencyError(
        `installed ${path} does not match package-lock.json (${key} differs); run npm ci`,
      );
    }
  }
}

/**
 * Prove that npm, rather than an arbitrary directory copy, produced the tree
 * being imported. This is deliberately structural: the operator establishes
 * the first trusted install with npm ci; Runmill then fingerprints its exact
 * bytes and refuses any later cache mutation.
 */
function validateInstalledTree(projectRoot: string, trustedLock: NpmLock): void {
  const trustedPackages = trustedLock.packages;
  if (
    trustedLock.lockfileVersion === undefined ||
    trustedLock.lockfileVersion < 2 ||
    trustedPackages === undefined
  ) {
    throw dependencyError(
      "package-lock.json must use npm lockfileVersion 2 or 3 with a packages inventory",
    );
  }

  const modules = join(projectRoot, NODE_MODULES);
  const hiddenPath = join(modules, HIDDEN_LOCK);
  if (!existsSync(modules) || !statSync(modules).isDirectory() || !existsSync(hiddenPath)) {
    throw dependencyError(
      "the trusted project uses package-lock.json but has no npm-installed node_modules tree; " +
        "run npm ci in the source checkout before starting Runmill",
    );
  }

  const installedLock = parseJson<NpmLock>(hiddenPath, "node_modules/.package-lock.json");
  const installedPackages = installedLock.packages;
  if (installedPackages === undefined || installedLock.lockfileVersion !== trustedLock.lockfileVersion) {
    throw dependencyError(
      "node_modules/.package-lock.json does not match the trusted npm lockfile format; run npm ci",
    );
  }

  for (const [packagePath, installed] of Object.entries(installedPackages)) {
    if (packagePath === "") continue;
    const trusted = trustedPackages[packagePath];
    if (trusted === undefined) {
      throw dependencyError(
        `installed dependency ${packagePath} is absent from package-lock.json; run npm ci`,
      );
    }
    if (trusted.link === true || installed.link === true) {
      throw dependencyError(
        `linked npm workspace dependency ${packagePath} is not supported by the verification cache yet`,
      );
    }
    compareLockEntry(packagePath, trusted, installed);

    const packageJsonPath = join(safePackagePath(projectRoot, packagePath), PACKAGE_JSON);
    const installedManifest = parseJson<{ version?: string }>(
      packageJsonPath,
      `${packagePath}/package.json`,
    );
    if (trusted.version !== undefined && installedManifest.version !== trusted.version) {
      throw dependencyError(
        `installed ${packagePath}/package.json has version ${JSON.stringify(installedManifest.version)} ` +
          `instead of ${JSON.stringify(trusted.version)}; run npm ci`,
      );
    }
  }

  for (const [packagePath, trusted] of Object.entries(trustedPackages)) {
    if (packagePath === "" || !requiredHere(trusted)) continue;
    if (trusted.link === true) {
      throw dependencyError(
        `linked npm workspace dependency ${packagePath} is not supported by the verification cache yet`,
      );
    }
    if (installedPackages[packagePath] === undefined) {
      throw dependencyError(
        `required dependency ${packagePath} is missing from node_modules; run npm ci`,
      );
    }
  }
}

/** Hash names, executable bits and bytes without following links. */
function fingerprintTree(root: string): string {
  const hash = createHash("sha256");
  const canonicalRoot = realpathSync(root);

  const visit = (path: string, label: string): void => {
    const stat = lstatSync(path);
    // Write bits are deliberately omitted: the imported cache has them
    // removed after this fingerprint, while executable bits are meaningful.
    hash.update(`${label}\0${stat.mode & 0o111}\0`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const lexical = resolve(dirname(path), target);
      let canonical: string;
      try {
        canonical = realpathSync(path);
      } catch {
        throw dependencyError(`dependency tree contains broken symlink ${label}`);
      }
      if (!inside(root, lexical) || !inside(canonicalRoot, canonical)) {
        throw dependencyError(`dependency tree symlink ${label} escapes node_modules`);
      }
      hash.update(`link\0${target}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    throw dependencyError(`dependency tree contains unsupported filesystem entry ${label}`);
  };

  visit(root, ".");
  return hash.digest("hex");
}

function makeReadOnly(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) makeReadOnly(join(path, name));
  }
  chmodSync(path, stat.mode & ~0o222);
}

function makeRemovable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  }
}

/**
 * Materialize directory entries while sharing immutable file inodes.
 *
 * The cache and run checkout are siblings under Runmill's data directory, so
 * they are on one filesystem. Hard links make each verification attempt O(file
 * count) rather than O(dependency bytes); the nested sandbox protection keeps
 * the shared files and their directory entries read-only to check code.
 */
function hardLinkTree(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    // Populate with owner write permission, then restore the immutable cache
    // mode after every child exists.
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source)) {
      hardLinkTree(join(source, name), join(target, name));
    }
    chmodSync(target, stat.mode & 0o777);
    return;
  }
  if (stat.isFile()) {
    linkSync(source, target);
    return;
  }
  throw dependencyError("dependency cache contains an unsupported filesystem entry");
}

/** Only directories need write permission for recursive unlink. */
function makeMaterializationRemovable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const name of readdirSync(path)) makeMaterializationRemovable(join(path, name));
}

function readReceipt(cachePath: string): CacheReceipt {
  return parseJson<CacheReceipt>(join(cachePath, "receipt.json"), "dependency cache receipt");
}

function validateCache(cachePath: string, expected: CacheReceipt): PreparedDependencies {
  const receipt = readReceipt(cachePath);
  for (const key of [
    "schema",
    "identity",
    "packageJsonHash",
    "packageLockHash",
    "platform",
    "arch",
    "nodeModulesAbi",
  ] as const) {
    if (receipt[key] !== expected[key]) {
      throw dependencyError(`dependency cache receipt mismatch (${key}); refusing stale dependencies`);
    }
  }
  const modules = join(cachePath, NODE_MODULES);
  if (!existsSync(modules) || !statSync(modules).isDirectory()) {
    throw dependencyError("dependency cache is incomplete: node_modules is missing");
  }
  const fingerprint = fingerprintTree(modules);
  if (fingerprint !== receipt.treeFingerprint) {
    throw dependencyError("dependency cache bytes changed after preparation; refusing verification");
  }
  return { manager: "npm", cachePath, identity: receipt.identity };
}

function receiptFor(packageJson: Buffer, packageLock: Buffer): CacheReceipt {
  const packageJsonHash = sha256(packageJson);
  const packageLockHash = sha256(packageLock);
  const nodeModulesAbi = process.versions.modules ?? "unknown";
  const identity = sha256(
    [
      `schema:${CACHE_SCHEMA}`,
      `package-json:${packageJsonHash}`,
      `package-lock:${packageLockHash}`,
      `platform:${platform()}`,
      `arch:${arch()}`,
      `node-abi:${nodeModulesAbi}`,
    ].join("\n"),
  );
  return {
    schema: CACHE_SCHEMA,
    identity,
    packageJsonHash,
    packageLockHash,
    platform: platform(),
    arch: arch(),
    nodeModulesAbi,
    treeFingerprint: "",
  };
}

function readTrustedDependencyIdentity(
  trustedCheckout: string,
): TrustedDependencyIdentity | undefined {
  const packagePath = join(trustedCheckout, PACKAGE_JSON);
  const lockPath = join(trustedCheckout, PACKAGE_LOCK);
  if (!existsSync(lockPath)) return undefined;
  if (!existsSync(packagePath)) {
    throw dependencyError("package-lock.json exists without package.json in the trusted commit");
  }
  const packageJson = readFileSync(packagePath);
  const packageLock = readFileSync(lockPath);
  return {
    packageJson,
    packageLock,
    lockPath,
    receipt: receiptFor(packageJson, packageLock),
  };
}

function validateInstalledDependencySource(
  installedSource: string,
  trusted: TrustedDependencyIdentity,
): string {
  const sourcePackagePath = join(installedSource, PACKAGE_JSON);
  const sourceLockPath = join(installedSource, PACKAGE_LOCK);
  if (!existsSync(sourcePackagePath) || !existsSync(sourceLockPath)) {
    throw dependencyError(
      "the operator checkout does not contain package.json and package-lock.json for the trusted commit",
    );
  }
  if (
    !readFileSync(sourcePackagePath).equals(trusted.packageJson) ||
    !readFileSync(sourceLockPath).equals(trusted.packageLock)
  ) {
    throw dependencyError(
      "the operator checkout package.json/package-lock.json differ from the exact base commit; " +
        "update the checkout and run npm ci before starting Runmill",
    );
  }

  const trustedLock = parseJson<NpmLock>(trusted.lockPath, "package-lock.json");
  validateInstalledTree(installedSource, trustedLock);
  return fingerprintTree(join(installedSource, NODE_MODULES));
}

/**
 * Prove that the source checkout can supply exact locked dependencies.
 *
 * This is the read-only half of dependency preparation used by doctor and
 * init. It executes no command, contacts no registry, and does not create or
 * warm Runmill's cache.
 */
export function validateInstalledDependencies(
  input: ValidateInstalledDependenciesInput,
): ValidatedDependencies | undefined {
  const trusted = readTrustedDependencyIdentity(input.trustedCheckout);
  if (trusted === undefined) return undefined;
  validateInstalledDependencySource(input.installedSource, trusted);
  return { manager: "npm", identity: trusted.receipt.identity };
}

/**
 * Import or reuse npm dependencies for exact-commit verification.
 *
 * No command is executed here. In particular, verification never turns a
 * repository-controlled string into a bootstrap shell and never contacts a
 * registry. The operator prepares the source tree explicitly with npm ci;
 * Runmill validates it against the trusted commit, copies it into machine
 * state, fingerprints it, and only ever reuses that exact read-only cache.
 */
export function prepareDependencies(
  input: PrepareDependenciesInput,
): PreparedDependencies | undefined {
  const trusted = readTrustedDependencyIdentity(input.trustedCheckout);
  if (trusted === undefined) return undefined;
  const expected = trusted.receipt;
  const cachePath = join(input.cacheRoot, `npm-${expected.identity}`);

  if (existsSync(cachePath)) return validateCache(cachePath, expected);
  const before = validateInstalledDependencySource(input.installedSource, trusted);

  mkdirSync(input.cacheRoot, { recursive: true, mode: 0o700 });
  const temporary = join(input.cacheRoot, `.npm-${expected.identity}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  const sourceModules = join(input.installedSource, NODE_MODULES);
  const temporaryModules = join(temporary, NODE_MODULES);

  try {
    cpSync(sourceModules, temporaryModules, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const after = fingerprintTree(sourceModules);
    const copied = fingerprintTree(temporaryModules);
    if (before !== after || before !== copied) {
      throw dependencyError(
        "node_modules changed while Runmill was importing it; refusing a torn dependency cache",
      );
    }

    const receipt: CacheReceipt = { ...expected, treeFingerprint: copied };
    writeFileSync(join(temporary, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o400,
    });
    // Keep the temporary directory itself writable until the atomic rename.
    // macOS refuses to rename a directory after its owner write bit is
    // removed, even though the parent is writable. Its contents are already
    // immutable and the temporary name is never exposed to verification.
    for (const name of readdirSync(temporary)) makeReadOnly(join(temporary, name));

    try {
      renameSync(temporary, cachePath);
      const cacheMode = lstatSync(cachePath).mode;
      chmodSync(cachePath, cacheMode & ~0o222);
    } catch (error) {
      // Another Runmill process may have prepared the same content-keyed tree
      // concurrently. Its fully validated result is equivalent; anything else
      // remains an error rather than silently replacing cache state.
      if (!existsSync(cachePath)) throw error;
      makeRemovable(temporary);
      rmSync(temporary, { recursive: true, force: true });
    }
    return validateCache(cachePath, expected);
  } catch (error) {
    if (existsSync(temporary)) {
      makeRemovable(temporary);
      rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Hard-link a prepared immutable tree into an ignored, verification-only path. */
export function materializeDependencies(prepared: PreparedDependencies, checkout: string): string {
  const source = join(prepared.cachePath, NODE_MODULES);
  const target = join(checkout, NODE_MODULES);
  if (existsSync(target)) {
    throw dependencyError(
      "the candidate commit already materializes node_modules; refusing to overlay verification inputs",
    );
  }
  const receipt = readReceipt(prepared.cachePath);
  if (receipt.identity !== prepared.identity) {
    throw dependencyError("dependency cache identity changed before materialization");
  }
  hardLinkTree(source, target);
  return target;
}

/** Restore owner permissions only so the orchestrator can remove its checkout. */
export function releaseMaterializedDependencies(checkout: string): void {
  const target = join(checkout, NODE_MODULES);
  if (existsSync(target)) makeMaterializationRemovable(target);
}
