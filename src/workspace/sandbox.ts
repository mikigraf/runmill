import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  opendirSync,
  readdirSync,
  mkdirSync,
  chmodSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  type Stats,
} from "node:fs";
import { arch, tmpdir, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import {
  runControlledProcess,
} from "../platform/process.js";

export type SandboxMechanism = "seatbelt" | "bubblewrap" | "none";

export interface SandboxPolicy {
  /** Directories the child may write to. Everything else is read-only or denied. */
  readonly writablePaths: readonly string[];
  /** Existing individual files the child may update without owning their parent directory. */
  readonly writableFiles?: readonly string[];
  /** Additional read-only paths beyond the platform baseline. */
  readonly readablePaths?: readonly string[];
  /**
   * Existing paths nested inside a writable path that must remain read-only.
   *
   * Unlike `readablePaths`, these mounts/rules are emitted after broad write
   * grants and are mandatory: a missing source refuses to start the sandbox.
   */
  readonly protectedPaths?: readonly string[];
  readonly allowNetwork: boolean;
  /** Controls the operator has knowingly accepted as unenforceable here. */
  readonly allowUnenforced?: readonly string[];
}

export interface SandboxResult {
  readonly outcome: "exited" | "signaled" | "timeout" | "aborted" | "sandbox-denied";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SandboxRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly policy: SandboxPolicy;
  readonly timeoutMs: number;
  /** Extra variables to add on top of the allowlist. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Exact subprocess commands the caller authorizes this invocation to launch. */
  readonly subprocesses?: readonly string[] | undefined;
  /** Immutable, previously-qualified dependency trees required by this invocation. */
  readonly preparedDependencyPaths?: readonly string[] | undefined;
  /** Aggregate retained/observed stdout+stderr ceiling. */
  readonly maxOutputBytes?: number | undefined;
  readonly onStdout?: ((chunk: Buffer) => void) | undefined;
  readonly onStderr?: ((chunk: Buffer) => void) | undefined;
}

export interface SandboxRuntimeIdentity {
  readonly os: NodeJS.Platform;
  readonly arch: string;
  readonly libc: "darwin" | "glibc" | "musl" | "unknown";
  readonly nodeAbi: string;
}

export interface SandboxExecutableIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly uid: number;
  readonly mode: number;
}

export interface SandboxQualification {
  readonly mechanism: Exclude<SandboxMechanism, "none">;
  readonly runtime: SandboxRuntimeIdentity;
  readonly executable: SandboxExecutableIdentity;
  readonly executableIdentities: readonly SandboxExecutableIdentity[];
  /** Logical guest PATH. Native execution materializes an equivalent private shim directory. */
  readonly sanitizedPath: string;
  /** Digest of executable/runtime identities only; it is not policy evidence. */
  readonly runtimeDigest: string;
  /** Present on start(): digest of the complete effective policy and layout. */
  readonly policyDigest?: string | undefined;
  /** Trusted sandbox launcher identity revalidated immediately before spawn. */
  readonly launcher?: SandboxExecutableIdentity | undefined;
  /** Complete immutable execution snapshot, absent from source qualification. */
  readonly snapshotManifest?: readonly SandboxSnapshotManifestEntry[] | undefined;
}

export interface SandboxRuntimeMount {
  /** Immutable qualified/snapshotted object on the host. */
  readonly hostPath: string;
  /** Original canonical installation path visible in the empty guest root. */
  readonly guestPath: string;
  /** Descriptor number inherited by bubblewrap (3+), never part of policy evidence. */
  readonly childFd?: number | undefined;
}

export interface SandboxSnapshotManifestEntry {
  readonly sourcePath: string;
  readonly guestPath: string;
  readonly snapshot: SandboxExecutableIdentity;
}

export interface SandboxPathMount {
  readonly hostPath: string;
  readonly guestPath: string;
  readonly access: "read-only" | "read-write" | "write-file";
  readonly purpose: "workspace" | "provider-home" | "temporary" | "output" | "dependency" | "runtime";
}

export interface SandboxPathLayout {
  readonly cwd: { readonly hostPath: string; readonly guestPath: string };
  readonly home: { readonly hostPath: string; readonly guestPath: string };
  readonly temporary: { readonly hostPath: string; readonly guestPath: string };
  readonly mounts: readonly SandboxPathMount[];
}

export interface SandboxExecution {
  readonly layout: SandboxPathLayout;
  /** Original installed executable/runtime evidence returned by qualify(). */
  readonly originalQualification: SandboxQualification;
  /** Effective immutable execution and policy evidence. */
  readonly qualification: SandboxQualification;
  readonly result: Promise<SandboxResult>;
  /** Awaited and idempotent. Resolves only after backend completion and cleanup. */
  abort(): Promise<void>;
}

export interface SandboxBackend {
  readonly mechanism: SandboxMechanism;
  readonly runtime: SandboxRuntimeIdentity;
  /** Doctor may certify only an explicitly production-qualified backend. */
  readonly productionQualified?: boolean | undefined;
  qualify(input: {
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly subprocesses?: readonly string[] | undefined;
  }): Promise<SandboxQualification>;
  start(input: SandboxRunInput): Promise<SandboxExecution>;
  run(input: SandboxRunInput): Promise<SandboxResult>;
  prepareDisposableHome(): { readonly path: string; cleanup(): void };
  prepareDependencyCheckout(path: string): { readonly path: string; readonly runtime: SandboxRuntimeIdentity };
}

export interface NativeSandboxOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly path?: string | undefined;
}

/**
 * Variables that are safe to pass through.
 *
 * Deny-by-default. The environment is constructed from empty rather than
 * filtered from the parent, because filtering requires enumerating every
 * dangerous variable and the list is open-ended: `NODE_OPTIONS` force-loads a
 * script into every node process (including the check runner), `LD_PRELOAD`
 * and `DYLD_INSERT_LIBRARIES` inject shared objects, `BASH_ENV` and
 * `PYTHONSTARTUP` run code at interpreter start, and `SSH_AUTH_SOCK` hands
 * over the agent socket.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
  // How this host is configured to trust and reach the network. The agent has
  // to talk to its own API, and on any machine with a custom CA bundle or a
  // TLS-inspecting proxy -- which is most managed laptops, and this one --
  // dropping these turns every request into "invalid peer certificate:
  // UnknownIssuer" from inside the sandbox and works fine outside it.
  //
  // These are read from the operator's own environment, exactly like PATH.
  // NODE_EXTRA_CA_CERTS stays denied: it loads an additional CA on top of the
  // system set, where these name the trust configuration already in use.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
];

/** Never inherited, even if somehow allowlisted. Defence in depth. */
const ENV_DENYLIST = [
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "NPM_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];

const PROXY_ENV_KEYS = new Set([
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
]);

/**
 * Output retained per stream.
 *
 * The detectors (zero-tests, focused execution, skip counts) all read summary
 * lines at the tail, so the tail is what is kept.
 */
const MAX_CAPTURED_OUTPUT = 512 * 1024;

/** Paths denied inside the sandbox regardless of policy. */
const CREDENTIAL_PATHS = [
  ".ssh",
  ".aws",
  ".kube",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".config/gh",
  // Provider sessions use a disposable HOME. These denials protect the real
  // provider state if a HOME-based toolchain grant would otherwise expose it.
  ".codex",
  ".claude",
  ".config/claude",
];

export function buildEnvironment(
  extra: Readonly<Record<string, string>> = {},
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  for (const key of ENV_DENYLIST) {
    delete env[key];
  }
  // A proxy URL can itself be a credential. Passing
  // http://user:password@proxy to the provider hands that secret to every tool
  // process even though the usual API-key variables are stripped. Credential-
  // free proxy addresses remain supported; authenticated proxies need the
  // future host-side network broker.
  for (const key of PROXY_ENV_KEYS) {
    if (env[key]?.includes("@") === true) delete env[key];
  }
  return env;
}

/** Resolve symlinks; fall back to the input when the path does not exist yet. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function detectMechanism(): SandboxMechanism {
  return "none";
}

/**
 * A temporary directory of the child's own.
 *
 * TMPDIR is on the environment allowlist, so the sandbox handed the child a
 * path and then denied it. node, npm, compilers, test runners and both agent
 * CLIs write there, and the Claude CLI could not start at all without it.
 *
 * Granting the shared TMPDIR would have been the easy fix and the wrong one:
 * every run's workspace lives under it during tests, so it would have made
 * "outside the workspace" writable. A fresh directory per invocation keeps the
 * grant to something nothing else is using.
 */
export function createPrivateTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "runmill-child-tmp-")));
}

/** Directories holding the CA bundle this environment points at, if any. */
export function trustStoreReadPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [key, value] of [
    ["SSL_CERT_FILE", env["SSL_CERT_FILE"]],
    ["SSL_CERT_DIR", env["SSL_CERT_DIR"]],
  ] as const) {
    if (value === undefined || value === "") continue;
    try {
      out.add(realpathSync(key === "SSL_CERT_DIR" ? value : dirname(value)));
    } catch {
      // Pointing at something absent grants nothing; the TLS stack will
      // report it far better than a sandbox rule could.
    }
  }
  return [...out];
}

function findOnPath(command: string, entries: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      found.push(candidate);
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return found;
}

const MAX_SHEBANG_DEPTH = 4;
const MAX_PACKAGE_EXECUTABLES = 512;
const MAX_PACKAGE_TRAVERSAL_ENTRIES = 1_024;
const MAX_EXECUTABLE_INSPECTION_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNTIME_SNAPSHOT_ENTRIES = 10_000;
const MAX_RUNTIME_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_ELF_CLOSURE_FILES = 512;
const MAX_ELF_CLOSURE_EDGES = 4_096;
const MAX_ELF_CLOSURE_INSPECTED_BYTES = 1024 * 1024 * 1024;
const LOGICAL_SANITIZED_PATH = "/runmill/runtime/bin";

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sandboxFailure(detail: string): RunmillError {
  return RunmillError.fromCatalog("RM-SANDBOX-001", { whatHappened: detail });
}

interface InspectedFile {
  readonly canonical: string;
  readonly descriptor: number;
  readonly info: Stats;
}

function openInspectedFile(
  path: string,
  label: string,
  maximumBytes: number,
  requireExecutable = false,
  followFinalSymlink = true,
): InspectedFile {
  const openPath = followFinalSymlink ? realpathSync(path) : path;
  const before = lstatSync(openPath);
  if (before.isSymbolicLink()) throw sandboxFailure(`${label} is a symbolic link: ${openPath}.`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      openPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(descriptor);
    if (info.dev !== before.dev || info.ino !== before.ino) {
      throw sandboxFailure(`${label} changed before its no-follow descriptor was opened: ${openPath}.`);
    }
    const canonical = realpathSync(openPath);
    const current = lstatSync(canonical);
    if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) {
      throw sandboxFailure(`${label} pathname changed during no-follow inspection: ${openPath}.`);
    }
    if (!info.isFile()) throw sandboxFailure(`${label} is not a regular file: ${canonical}.`);
    if (requireExecutable && (info.mode & 0o111) === 0) {
      throw sandboxFailure(`${label} is not executable: ${canonical}.`);
    }
    if (!Number.isSafeInteger(info.size) || info.size > maximumBytes) {
      throw sandboxFailure(
        `${label} exceeds its inspection byte limit of ${String(maximumBytes)}: ${canonical}.`,
      );
    }
    return { canonical, descriptor, info };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function sha256Descriptor(descriptor: number, size: number): string {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (count <= 0) throw sandboxFailure("Executable changed while its bytes were inspected.");
    digest.update(chunk.subarray(0, count));
    offset += count;
  }
  return digest.digest("hex");
}

function inspectExecutable(path: string): {
  readonly identity: SandboxExecutableIdentity;
  readonly declaration: readonly string[] | undefined;
} {
  const opened = openInspectedFile(
    path,
    "Sandbox executable inspection byte limit",
    MAX_EXECUTABLE_INSPECTION_BYTES,
    true,
  );
  try {
    const sha256 = sha256Descriptor(opened.descriptor, opened.info.size);
    const prefix = Buffer.alloc(Math.min(4096, opened.info.size));
    const prefixCount = prefix.length === 0
      ? 0
      : readSync(opened.descriptor, prefix, 0, prefix.length, 0);
    const bytes = prefix.subarray(0, prefixCount).toString("utf8");
    let declaration: readonly string[] | undefined;
    if (bytes.startsWith("#!")) {
      const line = bytes.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? "";
      const parts = line.split(/\s+/).filter((part) => part !== "");
      if (parts.length === 0 || !isAbsolute(parts[0] ?? "")) {
        throw sandboxFailure(`Executable ${opened.canonical} has an unprovable shebang.`);
      }
      declaration = parts;
    }
    const after = fstatSync(opened.descriptor);
    if (
      after.dev !== opened.info.dev ||
      after.ino !== opened.info.ino ||
      after.size !== opened.info.size ||
      after.mtimeMs !== opened.info.mtimeMs ||
      after.ctimeMs !== opened.info.ctimeMs
    ) {
      throw sandboxFailure(`Sandbox executable changed during inspection: ${opened.canonical}.`);
    }
    return {
      identity: {
        path: opened.canonical,
        sha256,
        device: after.dev,
        inode: after.ino,
        size: after.size,
        uid: after.uid,
        mode: after.mode & 0o7777,
      },
      declaration,
    };
  } finally {
    closeSync(opened.descriptor);
  }
}

function executableIdentity(path: string): SandboxExecutableIdentity {
  return inspectExecutable(path).identity;
}

function exactExecutable(command: string, searchPath: string, cwd = process.cwd()): string {
  const candidates = command.includes(sep)
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : findOnPath(command, searchPath.split(delimiter).filter((entry) => entry !== ""));
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw sandboxFailure(`Cannot resolve exact sandbox executable ${JSON.stringify(command)}.`);
  }
  try {
    return executableIdentity(candidate).path;
  } catch (error) {
    if (error instanceof RunmillError) throw error;
    throw sandboxFailure(
      `Cannot prove exact sandbox executable ${JSON.stringify(command)}: ${errorMessage(error)}`,
    );
  }
}

function nearestPackageRoot(entrypoint: string): string | undefined {
  let current = dirname(entrypoint);
  const root = resolve(sep);
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(join(current, "package.json"))) return realpathSync(current);
    if (current === root) return undefined;
    current = dirname(current);
  }
  throw sandboxFailure(`Package boundary for ${entrypoint} exceeds the supported depth.`);
}

function owningNodeModules(packageRoot: string): string | undefined {
  let current = dirname(packageRoot);
  for (let depth = 0; depth < 32; depth += 1) {
    if (basename(current) === "node_modules") return current;
    const next = dirname(current);
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}

function installedOptionalPackageRoots(packageRoot: string): string[] {
  let manifest: { readonly optionalDependencies?: Readonly<Record<string, string>> };
  try {
    const opened = openInspectedFile(
      join(packageRoot, "package.json"),
      "Provider package manifest byte limit",
      MAX_PACKAGE_MANIFEST_BYTES,
      false,
      false,
    );
    try {
      manifest = JSON.parse(readFileSync(opened.descriptor, "utf8")) as typeof manifest;
      const after = fstatSync(opened.descriptor);
      if (
        after.dev !== opened.info.dev || after.ino !== opened.info.ino ||
        after.size !== opened.info.size || after.mtimeMs !== opened.info.mtimeMs ||
        after.ctimeMs !== opened.info.ctimeMs
      ) {
        throw sandboxFailure(`Provider package manifest changed during inspection: ${opened.canonical}.`);
      }
    } finally {
      closeSync(opened.descriptor);
    }
  } catch (error) {
    if (error instanceof RunmillError) throw error;
    throw sandboxFailure(`Cannot prove provider package manifest at ${packageRoot}: ${errorMessage(error)}`);
  }
  const modules = owningNodeModules(packageRoot);
  if (modules === undefined) return [];
  const roots: string[] = [];
  for (const name of Object.keys(manifest.optionalDependencies ?? {}).sort(bytewiseCompare)) {
    const candidate = resolve(modules, ...name.split("/"));
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const rel = relative(modules, canonical);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw sandboxFailure(`Provider dependency ${name} escapes its node_modules directory.`);
    }
    roots.push(canonical);
  }
  return roots;
}

function packageExecutables(root: string): string[] {
  const executables: string[] = [];
  let entries = 0;
  const visit = (path: string, depth: number): void => {
    entries += 1;
    if (entries > MAX_PACKAGE_TRAVERSAL_ENTRIES) {
      throw sandboxFailure(`Provider package traversal entry limit exceeded: ${root}`);
    }
    if (depth > 16 || executables.length > MAX_PACKAGE_EXECUTABLES) {
      throw sandboxFailure(`Provider package executable closure is too large: ${root}`);
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const canonical = realpathSync(path);
      const rel = relative(root, canonical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw sandboxFailure(`Provider package symlink escapes its package: ${path}`);
      }
      return;
    }
    if (info.isDirectory()) {
      const directory = opendirSync(path);
      const names: string[] = [];
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          names.push(entry.name);
          if (entries + names.length > MAX_PACKAGE_TRAVERSAL_ENTRIES) {
            throw sandboxFailure(`Provider package traversal entry limit exceeded: ${root}`);
          }
        }
      } finally {
        directory.closeSync();
      }
      for (const name of names.sort(bytewiseCompare)) visit(join(path, name), depth + 1);
      return;
    }
    if (info.isFile() && (info.mode & 0o111) !== 0) executables.push(realpathSync(path));
  };
  visit(root, 0);
  return executables;
}

function runtimeIdentity(os: NodeJS.Platform): SandboxRuntimeIdentity {
  if (os !== "darwin" && os !== "linux") {
    throw sandboxFailure(`No native sandbox backend is implemented for ${os}.`);
  }
  return {
    os,
    arch: arch(),
    libc: os === "darwin" ? "darwin" : "unknown",
    nodeAbi: process.versions.modules,
  };
}

const LINUX_RUNTIME_FILES = [
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
  "/etc/ssl/certs",
  "/usr/share/zoneinfo",
] as const;

interface ElfMetadata {
  readonly interpreter?: string | undefined;
  readonly needed: readonly string[];
  readonly searchPaths: readonly string[];
}

interface ElfClosureBudget {
  files: number;
  edges: number;
  inspectedBytes: number;
}

function parseElfMetadata(path: string, budget: ElfClosureBudget): ElfMetadata | undefined {
  const opened = openInspectedFile(
    path,
    "ELF inspection byte limit",
    MAX_EXECUTABLE_INSPECTION_BYTES,
  );
  try {
    budget.files += 1;
    budget.inspectedBytes += opened.info.size;
    if (budget.files > MAX_ELF_CLOSURE_FILES) {
      throw sandboxFailure(`ELF closure file limit exceeded at ${path}.`);
    }
    if (
      !Number.isSafeInteger(budget.inspectedBytes) ||
      budget.inspectedBytes > MAX_ELF_CLOSURE_INSPECTED_BYTES
    ) {
      throw sandboxFailure(`ELF closure inspected-byte limit exceeded at ${path}.`);
    }
    const finish = <T>(value: T): T => {
      const after = fstatSync(opened.descriptor);
      if (
        after.dev !== opened.info.dev || after.ino !== opened.info.ino ||
        after.size !== opened.info.size || after.mtimeMs !== opened.info.mtimeMs ||
        after.ctimeMs !== opened.info.ctimeMs
      ) {
        throw sandboxFailure(`ELF runtime input changed during inspection: ${opened.canonical}.`);
      }
      return value;
    };
    const malformed = (): never => {
      throw sandboxFailure(`Malformed ELF runtime metadata in ${path}.`);
    };
    const readAt = (offset: number, length: number, maximum: number): Buffer => {
      if (
        !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 0 || length > maximum ||
        offset > opened.info.size || length > opened.info.size - offset
      ) {
        return malformed();
      }
      const result = Buffer.allocUnsafe(length);
      let received = 0;
      while (received < length) {
        const count = readSync(
          opened.descriptor,
          result,
          received,
          length - received,
          offset + received,
        );
        if (count <= 0) return malformed();
        received += count;
      }
      return result;
    };
    if (opened.info.size < 4) return finish(undefined);
    const prefix = readAt(0, Math.min(64, opened.info.size), 64);
    if (!prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return finish(undefined);
    }
    const elfClass = prefix[4];
    const encoding = prefix[5];
    if ((elfClass !== 1 && elfClass !== 2) || (encoding !== 1 && encoding !== 2)) malformed();
    const minimumHeader = elfClass === 1 ? 52 : 64;
    if (prefix.length < minimumHeader) malformed();
    const little = encoding === 1;
    const numberFrom = (source: Buffer, offset: number, width: 2 | 4 | 8): number => {
      if (offset < 0 || offset + width > source.length) malformed();
      const value = width === 2
        ? little ? source.readUInt16LE(offset) : source.readUInt16BE(offset)
        : width === 4
          ? little ? source.readUInt32LE(offset) : source.readUInt32BE(offset)
          : Number(little ? source.readBigUInt64LE(offset) : source.readBigUInt64BE(offset));
      if (!Number.isSafeInteger(value)) malformed();
      return value;
    };
    const phoff = numberFrom(prefix, elfClass === 1 ? 28 : 32, elfClass === 1 ? 4 : 8);
    const phentsize = numberFrom(prefix, elfClass === 1 ? 42 : 54, 2);
    const phnum = numberFrom(prefix, elfClass === 1 ? 44 : 56, 2);
    const minimumProgramHeader = elfClass === 1 ? 32 : 56;
    if (phnum > 4096 || phentsize < minimumProgramHeader || phentsize > 256) malformed();
    const tableLength = phnum * phentsize;
    if (!Number.isSafeInteger(tableLength) || tableLength > 1024 * 1024) malformed();
    const table = readAt(phoff, tableLength, 1024 * 1024);
    const segments: Array<{
      type: number;
      offset: number;
      address: number;
      fileSize: number;
      memorySize: number;
    }> = [];
    for (let index = 0; index < phnum; index += 1) {
      const base = index * phentsize;
      segments.push({
        type: numberFrom(table, base, 4),
        offset: numberFrom(table, base + (elfClass === 1 ? 4 : 8), elfClass === 1 ? 4 : 8),
        address: numberFrom(table, base + (elfClass === 1 ? 8 : 16), elfClass === 1 ? 4 : 8),
        fileSize: numberFrom(table, base + (elfClass === 1 ? 16 : 32), elfClass === 1 ? 4 : 8),
        memorySize: numberFrom(table, base + (elfClass === 1 ? 20 : 40), elfClass === 1 ? 4 : 8),
      });
    }
    const readCString = (offset: number, boundary = opened.info.size): string => {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= 64 * 1024) {
        const available = Math.min(opened.info.size, boundary) - (offset + total);
        if (available <= 0) malformed();
        const chunk = readAt(offset + total, Math.min(4096, available), 4096);
        const end = chunk.indexOf(0);
        if (end >= 0) {
          if (total + end > 64 * 1024) malformed();
          chunks.push(chunk.subarray(0, end));
          return Buffer.concat(chunks, total + end).toString("utf8");
        }
        chunks.push(chunk);
        total += chunk.length;
      }
      return malformed();
    };
    const interpreterSegment = segments.find((segment) => segment.type === 3);
    if (interpreterSegment !== undefined && interpreterSegment.fileSize > 64 * 1024) malformed();
    const interpreter = interpreterSegment === undefined
      ? undefined
      : readCString(interpreterSegment.offset, interpreterSegment.offset + interpreterSegment.fileSize);
    const dynamic = segments.find((segment) => segment.type === 2);
    if (dynamic === undefined) return finish({ interpreter, needed: [], searchPaths: [] });
    if (dynamic.fileSize > 1024 * 1024) malformed();
    const dynamicBytes = readAt(dynamic.offset, dynamic.fileSize, 1024 * 1024);
    const word = elfClass === 1 ? 4 : 8;
    const entryWidth = word * 2;
    const neededOffsets: number[] = [];
    const searchOffsets: number[] = [];
    let stringAddress: number | undefined;
    for (let offset = 0; offset + entryWidth <= dynamicBytes.length; offset += entryWidth) {
      const tag = numberFrom(dynamicBytes, offset, word);
      const value = numberFrom(dynamicBytes, offset + word, word);
      if (tag === 0) break;
      if (tag === 1) neededOffsets.push(value);
      else if (tag === 5) stringAddress = value;
      else if (tag === 15 || tag === 29) searchOffsets.push(value);
      if (neededOffsets.length + searchOffsets.length > MAX_PACKAGE_TRAVERSAL_ENTRIES) malformed();
    }
    if (neededOffsets.length === 0 && searchOffsets.length === 0) {
      return finish({ interpreter, needed: [], searchPaths: [] });
    }
    if (stringAddress === undefined) return malformed();
    const provenStringAddress = stringAddress;
    const load = segments.find(
      (segment) => segment.type === 1 &&
        provenStringAddress >= segment.address &&
        provenStringAddress < segment.address + segment.memorySize,
    );
    if (load === undefined) return malformed();
    const stringOffset = load.offset + provenStringAddress - load.address;
    const stringBoundary = load.offset + load.fileSize;
    const offsets = [...neededOffsets, ...searchOffsets];
    if (offsets.some((offset) => offset < 0 || stringOffset + offset >= stringBoundary)) malformed();
    return finish({
      interpreter,
      needed: neededOffsets.map((offset) => readCString(stringOffset + offset, stringBoundary)),
      searchPaths: searchOffsets.flatMap((offset) =>
        readCString(stringOffset + offset, stringBoundary).split(":")),
    });
  } finally {
    closeSync(opened.descriptor);
  }
}

interface ElfRuntimePath {
  readonly sourcePath: string;
  readonly guestPath: string;
}

/** Pure ELF metadata inspection: reads bytes and never executes the inspected target. */
function inspectElfRuntimeMounts(executablePaths: readonly string[]): ElfRuntimePath[] {
  const paths = new Map<string, ElfRuntimePath>();
  const addPath = (sourcePath: string, guestPath = sourcePath): void => {
    paths.set(`${guestPath}\0${sourcePath}`, { sourcePath, guestPath });
  };
  for (const candidate of LINUX_RUNTIME_FILES) {
    if (existsSync(candidate)) addPath(realpathSync(candidate), candidate);
  }
  const triplet = arch() === "x64" ? "x86_64-linux-gnu" : arch() === "arm64" ? "aarch64-linux-gnu" : undefined;
  const pending = executablePaths.map((path) => realpathSync(path));
  const visited = new Set<string>();
  const budget: ElfClosureBudget = {
    files: 0,
    edges: pending.length,
    inspectedBytes: 0,
  };
  if (budget.edges > MAX_ELF_CLOSURE_EDGES) {
    throw sandboxFailure("ELF closure pending-edge limit exceeded.");
  }
  const enqueue = (path: string): void => {
    budget.edges += 1;
    if (budget.edges > MAX_ELF_CLOSURE_EDGES) {
      throw sandboxFailure(`ELF closure pending-edge limit exceeded at ${path}.`);
    }
    pending.push(path);
  };
  while (pending.length > 0) {
    const executable = pending.shift();
    if (executable === undefined || visited.has(executable)) continue;
    visited.add(executable);
    const metadata = parseElfMetadata(executable, budget);
    if (metadata === undefined) continue;
    const interpreter = metadata.interpreter;
    if (interpreter !== undefined) {
      if (!isAbsolute(interpreter) || !existsSync(interpreter)) {
        throw sandboxFailure(`ELF interpreter is not an exact existing path: ${interpreter}.`);
      }
      const canonical = realpathSync(interpreter);
      addPath(canonical, interpreter);
      enqueue(canonical);
    }
    const declaredSearch = metadata.searchPaths.map((entry) => {
      if (!isAbsolute(entry) || entry.includes("$")) {
        throw sandboxFailure(`ELF runtime search path is not absolute and bounded: ${entry}.`);
      }
      return entry;
    });
    const search = [
      ...declaredSearch,
      ...(interpreter === undefined ? [] : [dirname(interpreter)]),
      ...(triplet === undefined ? [] : [`/lib/${triplet}`, `/usr/lib/${triplet}`]),
      "/lib64",
      "/usr/lib64",
      "/lib",
      "/usr/lib",
    ];
    for (const needed of metadata.needed) {
      const candidates = needed.includes("/")
        ? [needed]
        : search.map((directory) => join(directory, needed));
      const found = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
      if (found === undefined) {
        throw sandboxFailure(`Dynamic library closure is incomplete for ${executable}: ${needed}.`);
      }
      const canonical = realpathSync(found);
      addPath(canonical, found);
      enqueue(canonical);
    }
  }
  return [...paths.values()].sort((a, b) =>
    bytewiseCompare(a.guestPath, b.guestPath) || bytewiseCompare(a.sourcePath, b.sourcePath));
}

export function inspectElfRuntimePaths(executablePaths: readonly string[]): string[] {
  return [...new Set(inspectElfRuntimeMounts(executablePaths).map((entry) => entry.sourcePath))]
    .sort(bytewiseCompare);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function canonicalExisting(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw sandboxFailure(`${label} does not exist or cannot be canonicalized: ${path} (${errorMessage(error)})`);
  }
}

function assertGrantIsBounded(grant: string, cwd: string, operatorHome: string | undefined): void {
  if (grant === resolve(sep)) throw sandboxFailure(`Refusing over-broad sandbox grant ${grant}.`);
  if (grant !== cwd && within(grant, cwd)) {
    throw sandboxFailure(`Refusing sandbox grant ${grant}: it is an ancestor of workspace ${cwd}.`);
  }
  if (operatorHome !== undefined) {
    const home = realPath(operatorHome);
    if (grant === home || within(grant, home)) {
      throw sandboxFailure(`Refusing sandbox grant ${grant}: it is the operator home or its ancestor.`);
    }
    for (const credential of CREDENTIAL_PATHS) {
      const path = join(home, credential);
      if (grant === path || within(grant, path)) {
        throw sandboxFailure(`Refusing sandbox grant ${grant}: it contains credential path ${path}.`);
      }
    }
  }
}

function assertRegularMountSource(path: string, label: string, directoryOnly: boolean): void {
  const info = statSync(path);
  if (directoryOnly ? !info.isDirectory() : !info.isDirectory() && !info.isFile()) {
    throw sandboxFailure(
      `${label} must be ${directoryOnly ? "a regular directory" : "a regular file or directory"}: ${path}.`,
    );
  }
}

interface NormalizedPolicy {
  readonly writablePaths: readonly string[];
  readonly writableFiles: readonly string[];
  readonly readablePaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly preparedDependencyPaths: readonly string[];
  readonly allowNetwork: boolean;
}

function normalizePolicy(input: SandboxRunInput, childTmp: string): NormalizedPolicy {
  const cwd = canonicalExisting(input.cwd, "Sandbox working directory");
  const writablePaths = input.policy.writablePaths.map((path) => canonicalExisting(path, "Writable path"));
  const writableFiles = (input.policy.writableFiles ?? []).map((path) => canonicalExisting(path, "Writable file"));
  const readablePaths = (input.policy.readablePaths ?? []).map((path) => canonicalExisting(path, "Readable path"));
  const protectedPaths = (input.policy.protectedPaths ?? []).map((path) => canonicalExisting(path, "Protected path"));
  const preparedDependencyPaths = (input.preparedDependencyPaths ?? []).map((path) =>
    canonicalExisting(path, "Prepared dependency checkout"),
  );
  for (const grant of [
    ...writablePaths,
    ...writableFiles,
    ...readablePaths,
    ...protectedPaths,
    ...preparedDependencyPaths,
  ]) {
    assertGrantIsBounded(grant, cwd, process.env["HOME"]);
  }
  for (const path of protectedPaths) assertRegularMountSource(path, "Protected path", false);
  for (const path of preparedDependencyPaths) {
    assertRegularMountSource(path, "Prepared dependency checkout", true);
    if (path === cwd) {
      throw sandboxFailure(`Prepared dependency checkout cannot be the workspace itself: ${path}.`);
    }
  }
  const modes = new Map<string, string>();
  for (const [mode, paths] of [
    ["read-write", writablePaths],
    ["write-file", writableFiles],
    ["read-only", readablePaths],
  ] as const) {
    for (const path of paths) {
      const prior = modes.get(path);
      if (prior !== undefined) {
        throw sandboxFailure(`Duplicate or conflicting sandbox mount ${path}: ${prior} and ${mode}.`);
      }
      modes.set(path, mode);
    }
  }
  const rejectOverlaps = (paths: readonly string[], label: string): void => {
    for (let left = 0; left < paths.length; left += 1) {
      for (let right = left + 1; right < paths.length; right += 1) {
        const a = paths[left];
        const b = paths[right];
        if (a !== undefined && b !== undefined && (within(a, b) || within(b, a))) {
          throw sandboxFailure(`Overlapping ${label} sandbox mounts ${a} and ${b}.`);
        }
      }
    }
  };
  rejectOverlaps(writablePaths, "writable");
  rejectOverlaps(writableFiles, "writable-file");
  rejectOverlaps(readablePaths, "readable");
  rejectOverlaps(protectedPaths, "protected");
  rejectOverlaps(preparedDependencyPaths, "prepared dependency");
  for (const writable of writablePaths) {
    for (const readable of readablePaths) {
      if (within(writable, readable) || within(readable, writable)) {
        throw sandboxFailure(`Overlapping writable/read-only sandbox mounts ${writable} and ${readable}.`);
      }
    }
  }
  for (const file of writableFiles) {
    if (writablePaths.some((path) => within(path, file) || within(file, path))) {
      throw sandboxFailure(`Writable file mount ${file} overlaps a writable directory mount.`);
    }
  }
  for (const path of preparedDependencyPaths) {
    if (!protectedPaths.includes(path)) {
      throw sandboxFailure(
        `Prepared dependency checkout ${path} must also be a mandatory protected path.`,
      );
    }
  }
  return {
    writablePaths: [...writablePaths, childTmp],
    writableFiles,
    readablePaths,
    protectedPaths,
    preparedDependencyPaths,
    allowNetwork: input.policy.allowNetwork,
  };
}

/** Generate a Seatbelt profile: deny by default, then grant the minimum. */
export function buildSeatbeltProfile(
  policy: SandboxPolicy & {
    readonly executablePaths?: readonly string[] | undefined;
    readonly executableSubpaths?: readonly string[] | undefined;
  },
  home: string,
): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    "(allow file-read-metadata)",
    // Toolchains and system libraries. `/private/var/db/dyld` and the root
    // literal are load-bearing: without them the dynamic loader aborts with
    // SIGABRT before the target binary ever starts, so every command appears
    // to "fail" and the sandbox looks broken rather than restrictive.
    // /etc, /var and /tmp are symlinks into /private, and Seatbelt matches on
    // the resolved path, so a rule naming the symlink grants nothing at all.
    // `(subpath "/etc")` read as covering the system configuration for years
    // while denying every file in it, and the visible symptom was that
    // /private/etc/ssl/cert.pem was unreadable: certificate validation failed
    // and no agent could reach its own API from inside the sandbox.
    '(allow file-read* (subpath "/System") (subpath "/usr/lib")',
    '                  (subpath "/private/var/select") (subpath "/private/var/db/dyld")',
    // /etc/localtime is a symlink into /private/var/db/timezone, so a process
    // that formats a local time reads there. Denying it is not a restriction
    // anyone chose: it takes out `date`, every logger with a timestamp, and
    // the Claude CLI, which exits with a bare "internal error (EPERM)".
    '                  (subpath "/private/etc/ssl") (literal "/private/etc/hosts")',
    '                  (literal "/private/etc/resolv.conf") (literal "/dev/null")',
    '                  (literal "/dev/random") (literal "/dev/urandom")',
    '                  (subpath "/private/var/db/timezone") (literal "/"))',
    '(allow file-write* (subpath "/dev/null") (subpath "/dev/dtracehelper"))',
  ];

  for (const p of policy.executablePaths ?? []) {
    lines.push(`(allow process-exec (literal ${JSON.stringify(p)}))`);
    lines.push(`(allow file-read* (literal ${JSON.stringify(p)}))`);
  }
  for (const p of policy.executableSubpaths ?? []) {
    lines.push(`(allow process-exec (subpath ${JSON.stringify(p)}))`);
  }

  for (const p of policy.writablePaths) {
    lines.push(`(allow file-read* file-write* (subpath ${JSON.stringify(p)}))`);
  }
  for (const p of policy.writableFiles ?? []) {
    lines.push(`(allow file-read* file-write* (literal ${JSON.stringify(p)}))`);
  }
  for (const p of policy.readablePaths ?? []) {
    const matcher = (() => {
      try {
        return statSync(p).isDirectory() ? "subpath" : "literal";
      } catch {
        return "literal";
      }
    })();
    lines.push(`(allow file-read* (${matcher} ${JSON.stringify(p)}))`);
  }

  // A broad writable workspace contains `.git`, but the worker must not own
  // the ref, index, config, or hooks that define the candidate. Denials are
  // deliberately after grants so the narrow read-only boundary wins.
  for (const p of policy.protectedPaths ?? []) {
    lines.push(
      `(deny file-write* (literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)}))`,
    );
  }

  // Credential paths are denied last so they win over any broader grant.
  for (const rel of CREDENTIAL_PATHS) {
    lines.push(`(deny file-read* file-write* (subpath ${JSON.stringify(join(home, rel))}))`);
  }
  // The keychain is a Mach service, not a socket; a file rule does not block it.
  lines.push('(deny mach-lookup (global-name "com.apple.SecurityServer"))');

  if (policy.allowNetwork) {
    lines.push("(allow network-outbound)");
    lines.push("(allow network-inbound (local ip))");
  }

  return lines.join("\n");
}

export function buildBubblewrapArgs(
  policy: SandboxPolicy,
  home: string,
  runtimeMounts: readonly SandboxRuntimeMount[] = [],
): string[] {
  const args = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  if (!policy.allowNetwork) args.push("--unshare-net");
  // Read-only binds are emitted BEFORE the writable ones, because bwrap applies
  // mounts in order and the last one wins. The two sets overlap in practice --
  // the toolchain grant can name a directory that is also the workspace -- and
  // when the read-only bind landed last it remounted the workspace read-only,
  // leaving the agent unable to write the tree it had just been told to change.
  //
  // Qualification canonicalizes every source before this builder runs.
  // Required closure mounts therefore use plain binds: a source disappearing
  // between qualification and launch is a refusal, never an optional omission.
  for (const mount of runtimeMounts) {
    if (mount.childFd === undefined) {
      if (mount.hostPath !== mount.guestPath) {
        throw sandboxFailure(
          `Immutable runtime snapshot requires descriptor binding: ${mount.guestPath}.`,
        );
      }
      args.push("--ro-bind", mount.hostPath, mount.guestPath);
    } else {
      args.push("--ro-bind-fd", String(mount.childFd), mount.guestPath);
    }
  }
  for (const p of policy.readablePaths ?? []) args.push("--ro-bind", p, p);
  for (const p of policy.writablePaths) args.push("--bind", p, p);
  // A reviewer receives the source tree read-only and one pre-created output
  // file writable. A nested file bind lets that file remain writable without
  // granting its parent directory (and therefore task/evidence files) writes.
  for (const p of policy.writableFiles ?? []) args.push("--bind", p, p);
  // These are not `-try` mounts. Silently omitting a missing `.git` overlay
  // would turn the whole workspace bind back into writable Git metadata.
  for (const p of policy.protectedPaths ?? []) args.push("--ro-bind", p, p);
  // Bubblewrap starts from an empty root. The operator home is not bound at
  // all, so adding credential-path masks would create paths rather than remove
  // authority. Provider authentication lives only in the explicitly mounted
  // disposable HOME and must remain visible to the provider.
  void home;
  return args;
}

interface ResolvedRuntimeClosure {
  readonly qualification: SandboxQualification;
  readonly executableGuestPath: string;
  readonly launcherExecutable: string;
  readonly snapshotExecutableIdentities: readonly SandboxExecutableIdentity[];
  readonly runtimeMounts: readonly SandboxRuntimeMount[];
  readonly snapshotManifest: readonly SandboxSnapshotManifestEntry[];
  readonly shimTargets: ReadonlyMap<string, string>;
}

interface SnapshotBudget {
  entries: number;
  bytes: number;
}

function runtimeSnapshotPath(root: string, source: string): string {
  const absolute = resolve(source);
  if (!isAbsolute(absolute) || absolute === resolve(sep)) {
    throw sandboxFailure(`Runtime snapshot source is not a bounded absolute path: ${source}.`);
  }
  return join(root, "root", absolute.slice(1));
}

function chargeSnapshot(budget: SnapshotBudget, size: number, source: string): void {
  budget.entries += 1;
  budget.bytes += size;
  if (budget.entries > MAX_RUNTIME_SNAPSHOT_ENTRIES) {
    throw sandboxFailure(`Runtime snapshot entry limit exceeded at ${source}.`);
  }
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_RUNTIME_SNAPSHOT_BYTES) {
    throw sandboxFailure(`Runtime snapshot byte limit exceeded at ${source}.`);
  }
}

function copySnapshotFileFromDescriptor(
  opened: InspectedFile,
  sourcePath: string,
  guestPath: string,
  target: string,
  budget: SnapshotBudget,
  expectedSha256?: string,
): SandboxSnapshotManifestEntry {
  chargeSnapshot(budget, opened.info.size, sourcePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let destination: number | undefined;
  try {
    destination = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.info.size)));
    let offset = 0;
    while (offset < opened.info.size) {
      const count = readSync(
        opened.descriptor,
        chunk,
        0,
        Math.min(chunk.length, opened.info.size - offset),
        offset,
      );
      if (count <= 0) {
        throw sandboxFailure(`Runtime snapshot source changed while it was copied: ${sourcePath}.`);
      }
      digest.update(chunk.subarray(0, count));
      let written = 0;
      while (written < count) {
        const countWritten = writeSync(destination, chunk, written, count - written, offset + written);
        if (countWritten <= 0) throw sandboxFailure(`Runtime snapshot write failed: ${target}.`);
        written += countWritten;
      }
      offset += count;
    }
    const sourceAfter = fstatSync(opened.descriptor);
    const destinationAfter = fstatSync(destination);
    if (
      sourceAfter.dev !== opened.info.dev || sourceAfter.ino !== opened.info.ino ||
      sourceAfter.size !== opened.info.size || sourceAfter.mtimeMs !== opened.info.mtimeMs ||
      sourceAfter.ctimeMs !== opened.info.ctimeMs || !destinationAfter.isFile() ||
      destinationAfter.size !== opened.info.size
    ) {
      throw sandboxFailure(`Runtime snapshot source changed while it was copied: ${sourcePath}.`);
    }
    const sha256 = digest.digest("hex");
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw sandboxFailure(`Qualified executable bytes changed before snapshot: ${sourcePath}.`);
    }
    fchmodSync(destination, (opened.info.mode & 0o111) === 0 ? 0o400 : 0o500);
    fsyncSync(destination);
    const immutable = fstatSync(destination);
    return {
      sourcePath,
      guestPath,
      snapshot: {
        path: realpathSync(target),
        sha256,
        device: immutable.dev,
        inode: immutable.ino,
        size: immutable.size,
        uid: immutable.uid,
        mode: immutable.mode & 0o7777,
      },
    };
  } catch (error) {
    if (destination !== undefined) closeSync(destination);
    destination = undefined;
    rmSync(target, { force: true });
    throw error;
  } finally {
    if (destination !== undefined) closeSync(destination);
  }
}

function copySnapshotFile(
  source: string,
  guestPath: string,
  target: string,
  budget: SnapshotBudget,
  expectedSha256?: string,
): SandboxSnapshotManifestEntry {
  const opened = openInspectedFile(
    source,
    "Runtime snapshot file",
    MAX_EXECUTABLE_INSPECTION_BYTES,
    false,
    false,
  );
  try {
    return copySnapshotFileFromDescriptor(
      opened,
      source,
      guestPath,
      target,
      budget,
      expectedSha256,
    );
  } finally {
    closeSync(opened.descriptor);
  }
}

function directoryUnchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function openAnchoredDirectory(path: string): number {
  const absolute = resolve(path);
  if (!isAbsolute(absolute)) throw sandboxFailure(`Runtime tree is not absolute: ${path}.`);
  let descriptor = openSync(
    resolve(sep),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    for (const component of absolute.split(sep).filter((part) => part !== "")) {
      const next = openSync(
        join(`/proc/self/fd/${String(descriptor)}`, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      closeSync(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

/**
 * Snapshot a tree through held no-follow directory descriptors. `/proc/self/fd`
 * keeps every child lookup anchored to the proven parent object even if an
 * attacker renames or replaces the source pathname during traversal.
 */
function copySnapshotTree(
  sourceRoot: string,
  guestRoot: string,
  targetRoot: string,
  budget: SnapshotBudget,
  expectedDigests: ReadonlyMap<string, string>,
): readonly SandboxSnapshotManifestEntry[] {
  const manifest: SandboxSnapshotManifestEntry[] = [];
  const visit = (
    descriptor: number,
    sourcePath: string,
    guestPath: string,
    targetPath: string,
    depth: number,
  ): void => {
    if (depth > 32) throw sandboxFailure(`Runtime snapshot depth limit exceeded: ${sourcePath}.`);
    const before = fstatSync(descriptor);
    if (!before.isDirectory()) throw sandboxFailure(`Runtime snapshot source is not a directory: ${sourcePath}.`);
    chargeSnapshot(budget, 0, sourcePath);
    mkdirSync(targetPath, { recursive: true, mode: 0o700 });
    const anchor = `/proc/self/fd/${String(descriptor)}`;
    const names = readdirSync(anchor, { encoding: "buffer" })
      .map((raw) => {
        const name = raw.toString("utf8");
        if (!Buffer.from(name, "utf8").equals(raw)) {
          throw sandboxFailure(`Runtime snapshot contains a non-UTF-8 entry: ${sourcePath}.`);
        }
        return name;
      })
      .sort(bytewiseCompare);
    if (budget.entries + names.length > MAX_RUNTIME_SNAPSHOT_ENTRIES) {
      throw sandboxFailure(`Runtime snapshot entry limit exceeded at ${sourcePath}.`);
    }
    for (const name of names) {
      if (name === "." || name === ".." || name.includes(sep)) {
        throw sandboxFailure(`Runtime snapshot contains an invalid entry name: ${sourcePath}.`);
      }
      const anchoredPath = join(anchor, name);
      const logicalSource = join(sourcePath, name);
      const logicalGuest = join(guestPath, name);
      const target = join(targetPath, name);
      const observed = lstatSync(anchoredPath);
      if (observed.isSymbolicLink()) {
        throw sandboxFailure(`Runtime snapshot refuses symbolic links inside a qualified tree: ${logicalSource}.`);
      }
      if (observed.isDirectory()) {
        const child = openSync(
          anchoredPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = fstatSync(child);
          if (opened.dev !== observed.dev || opened.ino !== observed.ino) {
            throw sandboxFailure(`Runtime snapshot directory changed before open: ${logicalSource}.`);
          }
          visit(child, logicalSource, logicalGuest, target, depth + 1);
        } finally {
          closeSync(child);
        }
        continue;
      }
      if (!observed.isFile()) {
        throw sandboxFailure(`Runtime snapshot refuses a special filesystem object: ${logicalSource}.`);
      }
      const child = openSync(
        anchoredPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(child);
        if (opened.dev !== observed.dev || opened.ino !== observed.ino || !opened.isFile()) {
          throw sandboxFailure(`Runtime snapshot file changed before open: ${logicalSource}.`);
        }
        manifest.push(copySnapshotFileFromDescriptor(
          { canonical: logicalSource, descriptor: child, info: opened },
          logicalSource,
          logicalGuest,
          target,
          budget,
          expectedDigests.get(logicalSource),
        ));
      } finally {
        closeSync(child);
      }
    }
    const after = fstatSync(descriptor);
    if (!directoryUnchanged(before, after)) {
      throw sandboxFailure(`Runtime snapshot directory changed during traversal: ${sourcePath}.`);
    }
    chmodSync(targetPath, 0o500);
  };

  const root = openAnchoredDirectory(sourceRoot);
  try {
    visit(root, sourceRoot, guestRoot, targetRoot, 0);
  } finally {
    closeSync(root);
  }
  return manifest.sort((a, b) =>
    bytewiseCompare(a.guestPath, b.guestPath) || bytewiseCompare(a.sourcePath, b.sourcePath));
}

function sameExecutableIdentity(
  expected: SandboxExecutableIdentity,
  actual: SandboxExecutableIdentity,
): boolean {
  return expected.path === actual.path &&
    expected.sha256 === actual.sha256 &&
    expected.device === actual.device &&
    expected.inode === actual.inode &&
    expected.size === actual.size &&
    expected.uid === actual.uid &&
    expected.mode === actual.mode;
}

function assertExecutableIdentityCurrent(identity: SandboxExecutableIdentity, label: string): void {
  let current: SandboxExecutableIdentity;
  try {
    current = executableIdentity(identity.path);
  } catch (error) {
    throw sandboxFailure(`${label} disappeared before sandbox launch: ${errorMessage(error)}`);
  }
  if (!sameExecutableIdentity(identity, current)) {
    throw sandboxFailure(`${label} changed after qualification: ${identity.path}.`);
  }
}

function openRuntimeMountDescriptor(
  path: string,
  expected?: SandboxExecutableIdentity,
): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
    throw sandboxFailure(`Runtime mount is not a regular no-follow source: ${path}.`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      (after.isFile() !== before.isFile()) || (after.isDirectory() !== before.isDirectory())
    ) {
      throw sandboxFailure(`Runtime mount changed before its descriptor was acquired: ${path}.`);
    }
    if (
      expected !== undefined &&
      (after.dev !== expected.device || after.ino !== expected.inode ||
        after.size !== expected.size || after.uid !== expected.uid ||
        (after.mode & 0o7777) !== expected.mode)
    ) {
      throw sandboxFailure(`Qualified runtime object changed before descriptor binding: ${path}.`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function isTrustedImmutableSystemExecutable(identity: SandboxExecutableIdentity): boolean {
  return identity.uid === 0 && (identity.mode & 0o022) === 0 && [
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/System",
  ].some((root) => identity.path === root || within(root, identity.path));
}

/**
 * Lifecycle-owning native backend used by production composition.
 *
 * Callers receive only lifecycle operations; no wrapper command is exposed,
 * so process ownership and cleanup cannot escape the backend.
 */
class NativeSandboxBackend implements SandboxBackend {
  readonly mechanism: Exclude<SandboxMechanism, "none">;
  readonly runtime: SandboxRuntimeIdentity;
  readonly productionQualified = false;
  readonly #searchPath: string;

  constructor(os: "darwin" | "linux", searchPath: string) {
    this.mechanism = os === "darwin" ? "seatbelt" : "bubblewrap";
    this.runtime = runtimeIdentity(os);
    this.#searchPath = searchPath;
  }

  #launcherIdentity(): SandboxExecutableIdentity {
    let identity: SandboxExecutableIdentity;
    if (this.mechanism === "seatbelt") {
      identity = executableIdentity("/usr/bin/sandbox-exec");
    } else {
      const candidate = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
      if (candidate === undefined) {
        throw sandboxFailure("No trusted bubblewrap launcher exists at /usr/bin/bwrap or /bin/bwrap.");
      }
      identity = executableIdentity(candidate);
    }
    if (identity.uid !== 0 || (identity.mode & 0o022) !== 0 ||
        (this.mechanism === "bubblewrap" && (identity.mode & 0o6000) !== 0)) {
      throw sandboxFailure(
        `Sandbox launcher must be root-owned, rootless (non-setuid), and not group/other writable: ${identity.path}.`,
      );
    }
    return identity;
  }

  async qualify(input: {
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly subprocesses?: readonly string[] | undefined;
  }): Promise<SandboxQualification> {
    return (await this.#resolveClosure(input)).qualification;
  }

  prepareDisposableHome(): { readonly path: string; cleanup(): void } {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "runmill-provider-home-")));
    let cleaned = false;
    return {
      path,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(path, { recursive: true, force: true });
      },
    };
  }

  prepareDependencyCheckout(path: string): {
    readonly path: string;
    readonly runtime: SandboxRuntimeIdentity;
  } {
    const canonical = canonicalExisting(path, "Prepared dependency checkout");
    assertGrantIsBounded(canonical, resolve(sep, "runmill-unrelated-workspace"), process.env["HOME"]);
    assertRegularMountSource(canonical, "Prepared dependency checkout", true);
    return { path: canonical, runtime: this.runtime };
  }

  async #resolveClosure(input: {
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly subprocesses?: readonly string[] | undefined;
  }, snapshotRoot?: string): Promise<ResolvedRuntimeClosure> {
    const executable = exactExecutable(input.command, this.#searchPath, input.cwd);
    const identities = new Map<string, SandboxExecutableIdentity>();
    const readable = new Set<string>();
    const runtimeGuestPaths = new Map<string, Set<string>>();
    const snapshotTrees = new Set<string>();
    const shims = new Map<string, string>();
    const declarations = new Map<string, readonly string[] | undefined>();

    const addExecutable = (path: string, shimName?: string): string => {
      const inspected = inspectExecutable(path);
      const identity = inspected.identity;
      identities.set(identity.path, identity);
      declarations.set(identity.path, inspected.declaration);
      if (shimName !== undefined && shimName !== "") {
        const previous = shims.get(shimName);
        if (previous !== undefined && previous !== identity.path) {
          throw sandboxFailure(
            `Runtime closure maps ${shimName} to both ${previous} and ${identity.path}.`,
          );
        }
        shims.set(shimName, identity.path);
      }
      return identity.path;
    };

    const addMacShellVariant = (path: string): void => {
      if (this.runtime.os !== "darwin" || path !== "/bin/sh") return;
      const bash = exactExecutable("/bin/bash", this.#searchPath, input.cwd);
      addExecutable(bash);
      readable.add(bash);
    };
    const addShebangClosure = (entrypoint: string): void => {
      let current = entrypoint;
      const visited = new Set<string>();
      for (let depth = 0; depth < MAX_SHEBANG_DEPTH; depth += 1) {
        if (visited.has(current)) throw sandboxFailure(`Executable shebang cycle at ${current}.`);
        visited.add(current);
        addMacShellVariant(current);
        const declaration = declarations.get(current);
        if (declaration === undefined) break;
        let interpreter = addExecutable(declaration[0] ?? "");
        if (interpreter === "/usr/bin/env") {
          const name = declaration[1];
          if (name === undefined || name.startsWith("-")) {
            throw sandboxFailure(`Executable ${current} uses an unprovable env shebang.`);
          }
          interpreter = addExecutable(exactExecutable(name, this.#searchPath, input.cwd), name);
        } else {
          shims.set(basename(interpreter), interpreter);
        }
        current = interpreter;
        if (depth === MAX_SHEBANG_DEPTH - 1 && declarations.get(current) !== undefined) {
          throw sandboxFailure(`Executable shebang chain exceeds ${MAX_SHEBANG_DEPTH} entries.`);
        }
      }
    };

    addExecutable(executable, basename(input.command));
    addShebangClosure(executable);

    const packageRoot = nearestPackageRoot(executable);
    if (packageRoot !== undefined && packageRoot.split(sep).includes("node_modules")) {
      readable.add(packageRoot);
      snapshotTrees.add(packageRoot);
      for (const dependencyRoot of installedOptionalPackageRoots(packageRoot)) {
        readable.add(dependencyRoot);
        snapshotTrees.add(dependencyRoot);
        for (const path of packageExecutables(dependencyRoot)) addExecutable(path);
      }
    } else {
      readable.add(executable);
    }

    for (const command of input.subprocesses ?? []) {
      if (command.trim() === "" || /\s/.test(command)) {
        throw sandboxFailure(`Sandbox subprocess must be one executable name: ${JSON.stringify(command)}.`);
      }
      const path = exactExecutable(command, this.#searchPath, input.cwd);
      addExecutable(path, basename(command));
      addShebangClosure(path);
      // On macOS, the kernel launches /bin/bash as the implementation variant
      // for a script whose declared interpreter is /bin/sh. Seatbelt checks
      // that variant separately, so qualify the one exact OS-owned executable
      // instead of widening process-exec to a directory or arbitrary process.
      addMacShellVariant(path);
      const root = nearestPackageRoot(path);
      if (root?.split(sep).includes("node_modules") === true) {
        readable.add(root);
        snapshotTrees.add(root);
      } else {
        readable.add(path);
      }
    }

    const orderedIdentities = [...identities.values()].sort((a, b) => bytewiseCompare(a.path, b.path));
    if (this.runtime.os === "linux") {
      for (const identity of orderedIdentities) {
        const alreadyCovered = [...readable].some((path) => {
          try {
            return statSync(path).isDirectory() && within(path, identity.path);
          } catch {
            return false;
          }
        });
        if (!alreadyCovered) readable.add(identity.path);
      }
      for (const mount of inspectElfRuntimeMounts(
        orderedIdentities.map((identity) => identity.path),
      )) {
        readable.add(mount.sourcePath);
        const guests = runtimeGuestPaths.get(mount.sourcePath) ?? new Set<string>();
        guests.add(mount.guestPath);
        runtimeGuestPaths.set(mount.sourcePath, guests);
      }
    }
    const launcher = this.#launcherIdentity();
    const runtimeDigest = createHash("sha256")
      .update(
        JSON.stringify({
          mechanism: this.mechanism,
          runtime: this.runtime,
          identities: orderedIdentities,
          readable: [...readable].sort(bytewiseCompare),
          launcher,
        }),
      )
      .digest("hex");
    const qualification: SandboxQualification = {
      mechanism: this.mechanism,
      runtime: this.runtime,
      executable: identities.get(executable) ?? executableIdentity(executable),
      executableIdentities: orderedIdentities,
      sanitizedPath: LOGICAL_SANITIZED_PATH,
      runtimeDigest,
      launcher,
    };
    if (snapshotRoot === undefined) {
      return {
        executableGuestPath: executable,
        launcherExecutable: launcher.path,
        snapshotExecutableIdentities: orderedIdentities,
        runtimeMounts: [...readable].sort(bytewiseCompare).map((path) => ({ hostPath: path, guestPath: path })),
        snapshotManifest: [],
        shimTargets: shims,
        qualification,
      };
    }

    const budget: SnapshotBudget = { entries: 0, bytes: 0 };
    const runtimeMounts: SandboxRuntimeMount[] = [];
    const snapshotManifest: SandboxSnapshotManifestEntry[] = [];
    const snapshotPaths = new Map<string, string>();
    const expectedDigests = new Map(
      orderedIdentities.map((identity) => [identity.path, identity.sha256]),
    );
    const copiedTrees = [...snapshotTrees].sort((a, b) => a.length - b.length);
    const addRuntimeMounts = (hostPath: string, sourcePath: string): void => {
      const guests = runtimeGuestPaths.get(sourcePath) ?? new Set([sourcePath]);
      for (const guestPath of [...guests].sort(bytewiseCompare)) runtimeMounts.push({ hostPath, guestPath });
    };
    for (const source of [...readable].sort(bytewiseCompare)) {
      const coveredTree = copiedTrees.find((root) => source === root || within(root, source));
      if (coveredTree !== undefined && source !== coveredTree) continue;
      const sourceIdentity = orderedIdentities.find((identity) => identity.path === source);
      if (sourceIdentity !== undefined && isTrustedImmutableSystemExecutable(sourceIdentity)) {
        snapshotPaths.set(source, source);
        addRuntimeMounts(source, source);
        continue;
      }
      const target = runtimeSnapshotPath(snapshotRoot, source);
      if (snapshotTrees.has(source)) {
        const entries = copySnapshotTree(
          source,
          source,
          target,
          budget,
          expectedDigests,
        );
        snapshotManifest.push(...entries);
        for (const entry of entries) snapshotPaths.set(entry.sourcePath, entry.snapshot.path);
        addRuntimeMounts(target, source);
      } else if (!lstatSync(source).isDirectory()) {
        const entry = copySnapshotFile(
          source,
          source,
          target,
          budget,
          expectedDigests.get(source),
        );
        snapshotManifest.push(entry);
        snapshotPaths.set(source, entry.snapshot.path);
        addRuntimeMounts(entry.snapshot.path, source);
      } else {
        // Runtime data directories (timezone/cert stores) are not executable
        // objects. They remain exact read-only mounts; executable and library
        // bytes are always snapshotted below.
        addRuntimeMounts(source, source);
      }
    }

    for (const identity of orderedIdentities) {
      if (snapshotPaths.has(identity.path)) continue;
      if (isTrustedImmutableSystemExecutable(identity)) {
        snapshotPaths.set(identity.path, identity.path);
        if (!runtimeMounts.some((mount) => mount.guestPath === identity.path)) {
          addRuntimeMounts(identity.path, identity.path);
        }
        continue;
      }
      const target = runtimeSnapshotPath(snapshotRoot, identity.path);
      const entry = copySnapshotFile(
        identity.path,
        identity.path,
        target,
        budget,
        identity.sha256,
      );
      snapshotManifest.push(entry);
      snapshotPaths.set(identity.path, entry.snapshot.path);
      addRuntimeMounts(entry.snapshot.path, identity.path);
    }

    const snapshotExecutableIdentities = orderedIdentities
      .map((identity) =>
        snapshotManifest.find((entry) => entry.sourcePath === identity.path)?.snapshot ?? identity)
      .sort((a, b) => bytewiseCompare(a.path, b.path));
    return {
      executableGuestPath: executable,
      launcherExecutable: launcher.path,
      snapshotExecutableIdentities,
      runtimeMounts: runtimeMounts.sort((a, b) =>
        bytewiseCompare(a.guestPath, b.guestPath) || bytewiseCompare(a.hostPath, b.hostPath)),
      snapshotManifest: snapshotManifest.sort((a, b) =>
        bytewiseCompare(a.guestPath, b.guestPath) || bytewiseCompare(a.sourcePath, b.sourcePath)),
      // Shims point at original guest paths. No private host snapshot pathname
      // is meaningful inside bubblewrap's empty root.
      shimTargets: shims,
      qualification,
    };
  }

  async start(input: SandboxRunInput): Promise<SandboxExecution> {
    if (!this.productionQualified) {
      throw sandboxFailure(
        `${this.mechanism} is a policy-qualification test harness only; execution remains disabled ` +
          "until backend-empty lifecycle acknowledgement is implemented.",
      );
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw sandboxFailure("Sandbox timeout must be a positive safe integer.");
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_CAPTURED_OUTPUT * 2;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw sandboxFailure("Sandbox output limit must be a positive safe integer.");
    }

    const acquiredPaths: string[] = [];
    const acquiredDescriptors: number[] = [];
    let cleaned = false;
    const acquire = (prefix: string): string => {
      const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      acquiredPaths.push(path);
      return path;
    };
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      for (const descriptor of acquiredDescriptors.splice(0).reverse()) closeSync(descriptor);
      for (const path of [...acquiredPaths].reverse()) {
        rmSync(path, { recursive: true, force: true });
      }
    };

    try {
      const runtimeSnapshot = acquire("runmill-runtime-snapshot-");
      const closure = await this.#resolveClosure({
        command: input.command,
        cwd: input.cwd,
        subprocesses: input.subprocesses,
      }, this.runtime.os === "linux" ? runtimeSnapshot : undefined);
      const childTmp = acquire("runmill-child-tmp-");
      const shimDir = acquire("runmill-runtime-bin-");
      for (const [name, target] of closure.shimTargets) symlinkSync(target, join(shimDir, name));
      const normalized = normalizePolicy(input, childTmp);

      const cwd = canonicalExisting(input.cwd, "Sandbox working directory");
      const homePath = input.env?.["HOME"] ?? process.env["HOME"] ?? childTmp;
      const home = realPath(homePath);
      const inheritedEnvironment = buildEnvironment(input.env, {
        ...process.env,
        PATH: this.#searchPath,
      });
      const configuredTrustRoots = trustStoreReadPaths(inheritedEnvironment);
      for (const path of configuredTrustRoots) assertGrantIsBounded(path, cwd, process.env["HOME"]);
      const runtimeMounts = [
        ...closure.runtimeMounts,
        ...configuredTrustRoots.map((path) => ({ hostPath: path, guestPath: path })),
      ].sort((a, b) =>
        bytewiseCompare(a.guestPath, b.guestPath) || bytewiseCompare(a.hostPath, b.hostPath));
      const policy: SandboxPolicy & {
        readonly executablePaths: readonly string[];
        readonly executableSubpaths: readonly string[];
      } = {
        writablePaths: normalized.writablePaths,
        writableFiles: normalized.writableFiles,
        readablePaths: [
          ...normalized.readablePaths,
          ...(this.mechanism === "seatbelt"
            ? [...runtimeMounts.map((mount) => mount.hostPath), shimDir]
            : []),
        ],
        protectedPaths: normalized.protectedPaths,
        allowNetwork: normalized.allowNetwork,
        executablePaths: this.mechanism === "seatbelt"
          ? closure.qualification.executableIdentities.map((entry) => entry.path)
          : [],
        executableSubpaths: normalized.preparedDependencyPaths,
      };
      const env = {
        ...inheritedEnvironment,
        PATH: this.mechanism === "bubblewrap" ? LOGICAL_SANITIZED_PATH : shimDir,
        TMPDIR: childTmp,
        GIT_OPTIONAL_LOCKS: "0",
      };
      const layout: SandboxPathLayout = {
        cwd: { hostPath: cwd, guestPath: cwd },
        home: { hostPath: home, guestPath: home },
        temporary: { hostPath: childTmp, guestPath: childTmp },
        mounts: [
          ...normalized.writablePaths.map((path): SandboxPathMount => ({
            hostPath: path,
            guestPath: path,
            access: "read-write",
            purpose: path === cwd ? "workspace" : path === childTmp ? "temporary" : "provider-home",
          })),
          ...normalized.writableFiles.map((path): SandboxPathMount => ({
            hostPath: path,
            guestPath: path,
            access: "write-file",
            purpose: "output",
          })),
          ...normalized.readablePaths.map((path): SandboxPathMount => ({
            hostPath: path,
            guestPath: path,
            access: "read-only",
            purpose: normalized.preparedDependencyPaths.includes(path) ? "dependency" : "workspace",
          })),
          ...runtimeMounts.map((mount): SandboxPathMount => ({
            ...mount,
            access: "read-only",
            purpose: "runtime",
          })),
          ...(this.mechanism === "bubblewrap"
            ? [{
                hostPath: shimDir,
                guestPath: LOGICAL_SANITIZED_PATH,
                access: "read-only" as const,
                purpose: "runtime" as const,
              }]
            : []),
        ],
      };

      const launcher = closure.qualification.launcher;
      if (launcher === undefined) throw sandboxFailure("Sandbox launcher identity is missing.");
      const policyDigest = createHash("sha256").update(JSON.stringify({
        mechanism: this.mechanism,
        runtime: this.runtime,
        runtimeDigest: closure.qualification.runtimeDigest,
        launcher,
        snapshotExecutableIdentities: closure.snapshotExecutableIdentities,
        snapshotManifest: closure.snapshotManifest,
        layout,
        protectedPaths: normalized.protectedPaths,
        preparedDependencyPaths: normalized.preparedDependencyPaths,
        allowNetwork: normalized.allowNetwork,
        limits: { timeoutMs: input.timeoutMs, maxOutputBytes },
      })).digest("hex");
      const qualification: SandboxQualification = {
        ...closure.qualification,
        executable: closure.snapshotManifest.find(
          (entry) => entry.sourcePath === closure.qualification.executable.path,
        )?.snapshot ?? closure.qualification.executable,
        executableIdentities: closure.snapshotExecutableIdentities,
        snapshotManifest: closure.snapshotManifest,
        policyDigest,
      };

      let command: string;
      let args: string[];
      if (this.mechanism === "seatbelt") {
        const profileDir = acquire("runmill-sb-");
        const profile = join(profileDir, "policy.sb");
        writeFileSync(profile, buildSeatbeltProfile(policy, home));
        command = closure.launcherExecutable;
        args = ["-f", profile, closure.executableGuestPath, ...input.args];
      } else {
        const descriptorMounts = [
          ...runtimeMounts,
          { hostPath: shimDir, guestPath: LOGICAL_SANITIZED_PATH },
        ].map((mount, index): SandboxRuntimeMount => {
          const expected = closure.snapshotExecutableIdentities.find(
            (identity) => identity.path === mount.hostPath,
          );
          const descriptor = openRuntimeMountDescriptor(mount.hostPath, expected);
          acquiredDescriptors.push(descriptor);
          return { ...mount, childFd: 3 + index };
        });
        command = closure.launcherExecutable;
        args = [
          ...buildBubblewrapArgs(policy, home, descriptorMounts),
          closure.executableGuestPath,
          ...input.args,
        ];
      }

      for (const identity of closure.snapshotExecutableIdentities) {
        assertExecutableIdentityCurrent(identity, "Sandbox executable snapshot");
      }
      assertExecutableIdentityCurrent(launcher, "Sandbox launcher");

      const started = Date.now();
      const controller = new AbortController();
      const controlled = runControlledProcess({
        command,
        args,
        cwd,
        env,
        timeoutMs: input.timeoutMs,
        maxOutputBytes,
        signal: controller.signal,
        // Neither Seatbelt nor the current bwrap monitor provides a proven
        // backend-empty acknowledgement. These explicitly named test
        // harnesses exercise mechanism policy only, never lifecycle claims.
        containment: "process-group",
        ...(acquiredDescriptors.length === 0
          ? {}
          : { inheritedFileDescriptors: [...acquiredDescriptors] }),
        ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
        ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
      });
      // spawn() duplicates these into the child synchronously. Parent copies
      // are no longer needed and must not leak until result cleanup.
      for (const descriptor of acquiredDescriptors.splice(0)) closeSync(descriptor);
      const result = controlled.then((completed): SandboxResult => {
        if (!completed.containmentConfirmed) {
          // Keep every private resource quarantined and reject completion. An
          // awaited abort may not resolve while backend teardown is unproven.
          throw sandboxFailure(
            completed.stderr || "bubblewrap containment teardown could not be proven",
          );
        }
        const outcome: SandboxResult["outcome"] =
          completed.outcome === "output-limit" || completed.outcome === "spawn-error"
            ? "sandbox-denied"
            : completed.outcome;
        const value: SandboxResult = {
          outcome,
          exitCode: completed.exitCode,
          signal: completed.signal,
          stdout: completed.stdout,
          stderr: [
            completed.stderr,
            completed.outcome === "output-limit" ? "sandbox output limit exceeded" : undefined,
          ].filter((part): part is string => part !== undefined && part !== "").join("\n"),
          durationMs: Date.now() - started,
        };
        cleanup();
        return value;
      }, (error: unknown) => {
        cleanup();
        throw error;
      });
      let abortPromise: Promise<void> | undefined;
      const abort = (): Promise<void> => {
        if (abortPromise !== undefined) return abortPromise;
        controller.abort();
        abortPromise = result.then(() => undefined);
        return abortPromise;
      };

      return {
        layout,
        originalQualification: closure.qualification,
        qualification,
        result,
        abort,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async run(input: SandboxRunInput): Promise<SandboxResult> {
    return (await this.start(input)).result;
  }
}

class DisabledSandboxBackend implements SandboxBackend {
  readonly mechanism = "none" as const;
  readonly productionQualified = false;
  readonly runtime: SandboxRuntimeIdentity = {
    os: platform(),
    arch: arch(),
    libc: platform() === "darwin" ? "darwin" : "unknown",
    nodeAbi: process.versions.modules,
  };

  #refuse(): never {
    throw sandboxFailure(
      "The configured none backend is non-executing and is permitted only for observe mode.",
    );
  }

  async qualify(): Promise<SandboxQualification> {
    return this.#refuse();
  }

  async start(): Promise<SandboxExecution> {
    return this.#refuse();
  }

  async run(): Promise<SandboxResult> {
    return this.#refuse();
  }

  prepareDisposableHome(): { readonly path: string; cleanup(): void } {
    return this.#refuse();
  }

  prepareDependencyCheckout(): {
    readonly path: string;
    readonly runtime: SandboxRuntimeIdentity;
  } {
    return this.#refuse();
  }
}

export function createNativeSandboxBackend(
  selection: "native" | "none" | "docker",
  options: NativeSandboxOptions = {},
): SandboxBackend {
  if (selection === "none") return new DisabledSandboxBackend();
  if (selection === "docker") {
    throw sandboxFailure(
      "The Docker sandbox backend is not implemented in this release.",
    );
  }
  const os = options.platform ?? platform();
  if (os === "darwin") {
    throw sandboxFailure(
      "The macOS Seatbelt mechanism cannot contain descendants that create a new session; " +
        "no lifecycle-owning native sandbox backend is available on Darwin.",
    );
  }
  if (os !== "linux") {
    throw sandboxFailure(`The native sandbox backend is not implemented for ${os}.`);
  }
  throw sandboxFailure(
    "The Linux bubblewrap backend is pending complete descriptor-bound runtime and policy " +
      "closure qualification; native execution fails closed.",
  );
}

export function assertSandboxSelection(
  selection: "native" | "none" | "docker",
  backend: SandboxBackend,
): SandboxBackend {
  const actual = backend.mechanism === "none" ? "none" : "native";
  if (selection !== actual) {
    throw sandboxFailure(
      `Configured sandbox ${selection} does not match the injected ${actual} backend.`,
    );
  }
  return backend;
}

/**
 * Test-only Seatbelt mechanism harness.
 *
 * Seatbelt policy tests remain valuable, but this object must never be wired
 * into production composition: a child can create a new session and escape
 * process-group lifecycle ownership on Darwin.
 */
export function createTestSeatbeltSandboxBackend(
  options: Omit<NativeSandboxOptions, "platform"> = {},
): SandboxBackend {
  if (platform() !== "darwin") {
    throw sandboxFailure("The Seatbelt mechanism test harness requires Darwin.");
  }
  return new NativeSandboxBackend("darwin", options.path ?? process.env["PATH"] ?? "");
}

/** Test-only bubblewrap mechanism harness; production native selection refuses. */
export function createTestBubblewrapSandboxBackend(
  options: Omit<NativeSandboxOptions, "platform"> = {},
): SandboxBackend {
  if (platform() !== "linux") {
    throw sandboxFailure("The bubblewrap mechanism test harness requires Linux.");
  }
  return new NativeSandboxBackend("linux", options.path ?? process.env["PATH"] ?? "");
}

/** Test-only current-host mechanism selection; never use in production composition. */
export function createTestSandboxBackend(options: NativeSandboxOptions = {}): SandboxBackend {
  return platform() === "darwin"
    ? createTestSeatbeltSandboxBackend(options.path === undefined ? {} : { path: options.path })
    : createTestBubblewrapSandboxBackend(options.path === undefined ? {} : { path: options.path });
}
