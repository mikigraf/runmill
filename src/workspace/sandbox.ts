import { spawn, type ChildProcess } from "node:child_process";
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
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { arch, tmpdir, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import {
  armKillTimer,
  BoundedCapture,
  run as runProcess,
  terminateTree,
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
}

export interface SandboxQualification {
  readonly mechanism: Exclude<SandboxMechanism, "none">;
  readonly runtime: SandboxRuntimeIdentity;
  readonly executable: SandboxExecutableIdentity;
  readonly executableIdentities: readonly SandboxExecutableIdentity[];
  /** Logical guest PATH. Native execution materializes an equivalent private shim directory. */
  readonly sanitizedPath: string;
  readonly digest: string;
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
  readonly qualification: SandboxQualification;
  readonly result: Promise<SandboxResult>;
  /** Awaited and idempotent. Resolves only after backend completion and cleanup. */
  abort(): Promise<void>;
}

export interface SandboxBackend {
  readonly mechanism: SandboxMechanism;
  readonly runtime: SandboxRuntimeIdentity;
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
  const os = platform();
  if (os === "darwin") return "seatbelt";
  if (os === "linux") return "bubblewrap";
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
const LOGICAL_SANITIZED_PATH = "/runmill/runtime/bin";

function sandboxFailure(detail: string): RunmillError {
  return RunmillError.fromCatalog("RM-SANDBOX-001", { whatHappened: detail });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableIdentity(path: string): SandboxExecutableIdentity {
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw sandboxFailure(`Sandbox executable is not a regular executable file: ${canonical}`);
  }
  return {
    path: canonical,
    sha256: sha256File(canonical),
    device: info.dev,
    inode: info.ino,
    size: info.size,
  };
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

function shebang(path: string): readonly string[] | undefined {
  const bytes = readFileSync(path).subarray(0, 4096).toString("utf8");
  if (!bytes.startsWith("#!")) return undefined;
  const line = bytes.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? "";
  const parts = line.split(/\s+/).filter((part) => part !== "");
  if (parts.length === 0 || !isAbsolute(parts[0] ?? "")) {
    throw sandboxFailure(`Executable ${path} has an unprovable shebang.`);
  }
  return parts;
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
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as typeof manifest;
  } catch (error) {
    throw sandboxFailure(`Cannot prove provider package manifest at ${packageRoot}: ${errorMessage(error)}`);
  }
  const modules = owningNodeModules(packageRoot);
  if (modules === undefined) return [];
  const roots: string[] = [];
  for (const name of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
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
  const visit = (path: string, depth: number): void => {
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
      for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
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
  "/etc/ld.so.cache",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
  "/etc/ssl/certs",
  "/usr/share/zoneinfo",
] as const;

async function linuxRuntimeClosure(
  executables: readonly SandboxExecutableIdentity[],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const candidate of LINUX_RUNTIME_FILES) {
    if (existsSync(candidate)) paths.add(realpathSync(candidate));
  }
  for (const executable of executables) {
    const header = readFileSync(executable.path).subarray(0, 4);
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    const observation = await runProcess("/usr/bin/ldd", [executable.path], {
      timeoutMs: 10_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    if (/\bnot found\b/.test(`${observation.stdout}\n${observation.stderr}`)) {
      throw sandboxFailure(`Dynamic library closure is incomplete for ${executable.path}.`);
    }
    if (!observation.ok && !/statically linked|not a dynamic executable/i.test(observation.stderr)) {
      throw sandboxFailure(
        `Cannot qualify dynamic libraries for ${executable.path}: ${observation.stderr.trim()}`,
      );
    }
    for (const line of observation.stdout.split("\n")) {
      const matches = line.match(/\/[^\s()]+/g) ?? [];
      for (const match of matches) {
        const value = match.replace(/:$/, "");
        if (!existsSync(value)) {
          throw sandboxFailure(`Qualified dynamic library disappeared: ${value}`);
        }
        paths.add(realpathSync(value));
      }
    }
  }
  return [...paths].sort();
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
  for (const grant of [...writablePaths, ...writableFiles, ...readablePaths]) {
    assertGrantIsBounded(grant, cwd, process.env["HOME"]);
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

export function buildBubblewrapArgs(policy: SandboxPolicy, home: string): string[] {
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
  readonly executable: string;
  readonly readablePaths: readonly string[];
  readonly shimTargets: ReadonlyMap<string, string>;
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
  readonly #searchPath: string;

  constructor(os: "darwin" | "linux", searchPath: string) {
    this.mechanism = os === "darwin" ? "seatbelt" : "bubblewrap";
    this.runtime = runtimeIdentity(os);
    this.#searchPath = searchPath;
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
    return { path: canonicalExisting(path, "Prepared dependency checkout"), runtime: this.runtime };
  }

  async #resolveClosure(input: {
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly subprocesses?: readonly string[] | undefined;
  }): Promise<ResolvedRuntimeClosure> {
    const executable = exactExecutable(input.command, this.#searchPath, input.cwd);
    const identities = new Map<string, SandboxExecutableIdentity>();
    const readable = new Set<string>();
    const shims = new Map<string, string>();

    const addExecutable = (path: string, shimName?: string): string => {
      const identity = executableIdentity(path);
      identities.set(identity.path, identity);
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

    addExecutable(executable, basename(input.command));
    if (this.runtime.os === "darwin" && executable === "/bin/sh") {
      const bash = exactExecutable("/bin/bash", this.#searchPath, input.cwd);
      addExecutable(bash);
      readable.add(bash);
    }
    let current = executable;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_SHEBANG_DEPTH; depth += 1) {
      if (visited.has(current)) throw sandboxFailure(`Executable shebang cycle at ${current}.`);
      visited.add(current);
      const declaration = shebang(current);
      if (declaration === undefined) break;
      const interpreter = addExecutable(declaration[0] ?? "");
      if (interpreter === "/usr/bin/env") {
        const name = declaration[1];
        if (name === undefined || name.startsWith("-")) {
          throw sandboxFailure(`Executable ${current} uses an unprovable env shebang.`);
        }
        current = addExecutable(exactExecutable(name, this.#searchPath, input.cwd), name);
      } else {
        current = interpreter;
        shims.set(basename(interpreter), interpreter);
        if (this.runtime.os === "darwin" && interpreter === "/bin/sh") {
          const bash = exactExecutable("/bin/bash", this.#searchPath, input.cwd);
          addExecutable(bash);
          readable.add(bash);
        }
      }
      if (depth === MAX_SHEBANG_DEPTH - 1 && shebang(current) !== undefined) {
        throw sandboxFailure(`Executable shebang chain exceeds ${MAX_SHEBANG_DEPTH} entries.`);
      }
    }

    const packageRoot = nearestPackageRoot(executable);
    if (packageRoot !== undefined && packageRoot.split(sep).includes("node_modules")) {
      readable.add(packageRoot);
      for (const dependencyRoot of installedOptionalPackageRoots(packageRoot)) {
        readable.add(dependencyRoot);
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
      // On macOS, the kernel launches /bin/bash as the implementation variant
      // for a script whose declared interpreter is /bin/sh. Seatbelt checks
      // that variant separately, so qualify the one exact OS-owned executable
      // instead of widening process-exec to a directory or arbitrary process.
      if (this.runtime.os === "darwin" && path === "/bin/sh") {
        const bash = exactExecutable("/bin/bash", this.#searchPath, input.cwd);
        addExecutable(bash);
        readable.add(bash);
      }
      const root = nearestPackageRoot(path);
      readable.add(root?.split(sep).includes("node_modules") === true ? root : path);
    }

    const orderedIdentities = [...identities.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (this.runtime.os === "linux") {
      for (const path of await linuxRuntimeClosure(orderedIdentities)) readable.add(path);
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          mechanism: this.mechanism,
          runtime: this.runtime,
          identities: orderedIdentities,
          readable: [...readable].sort(),
        }),
      )
      .digest("hex");
    return {
      executable,
      readablePaths: [...readable].sort(),
      shimTargets: shims,
      qualification: {
        mechanism: this.mechanism,
        runtime: this.runtime,
        executable: executableIdentity(executable),
        executableIdentities: orderedIdentities,
        sanitizedPath: LOGICAL_SANITIZED_PATH,
        digest,
      },
    };
  }

  async start(input: SandboxRunInput): Promise<SandboxExecution> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw sandboxFailure("Sandbox timeout must be a positive safe integer.");
    }
    const maxOutputBytes = input.maxOutputBytes ?? MAX_CAPTURED_OUTPUT * 2;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw sandboxFailure("Sandbox output limit must be a positive safe integer.");
    }

    const closure = await this.#resolveClosure({
      command: input.command,
      cwd: input.cwd,
      subprocesses: input.subprocesses,
    });
    const childTmp = createPrivateTempDir();
    const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "runmill-runtime-bin-")));
    for (const [name, target] of closure.shimTargets) symlinkSync(target, join(shimDir, name));
    let profileDir: string | undefined;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (profileDir !== undefined) rmSync(profileDir, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
      rmSync(childTmp, { recursive: true, force: true });
    };

    let normalized: NormalizedPolicy;
    try {
      normalized = normalizePolicy(input, childTmp);
    } catch (error) {
      cleanup();
      throw error;
    }

    const cwd = canonicalExisting(input.cwd, "Sandbox working directory");
    const homePath = input.env?.["HOME"] ?? process.env["HOME"] ?? childTmp;
    const home = realPath(homePath);
    const inheritedEnvironment = buildEnvironment(input.env, {
      ...process.env,
      PATH: this.#searchPath,
    });
    const configuredTrustRoots = trustStoreReadPaths(inheritedEnvironment);
    for (const path of configuredTrustRoots) {
      assertGrantIsBounded(path, cwd, process.env["HOME"]);
    }
    const runtimeReadable = [...new Set([
      ...closure.readablePaths,
      ...configuredTrustRoots,
      ...(this.mechanism === "seatbelt" ? [shimDir] : []),
    ])];
    const policy: SandboxPolicy & {
      readonly executablePaths: readonly string[];
      readonly executableSubpaths: readonly string[];
    } = {
      writablePaths: normalized.writablePaths,
      writableFiles: normalized.writableFiles,
      readablePaths: [...normalized.readablePaths, ...runtimeReadable],
      protectedPaths: normalized.protectedPaths,
      allowNetwork: normalized.allowNetwork,
      executablePaths: closure.qualification.executableIdentities.map((entry) => entry.path),
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
        ...runtimeReadable.map((path): SandboxPathMount => ({
          hostPath: path,
          guestPath: path,
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

    let command: string;
    let args: string[];
    try {
      if (this.mechanism === "seatbelt") {
        profileDir = mkdtempSync(join(tmpdir(), "runmill-sb-"));
        const profile = join(profileDir, "policy.sb");
        writeFileSync(profile, buildSeatbeltProfile(policy, process.env["HOME"] ?? tmpdir()));
        command = "/usr/bin/sandbox-exec";
        args = ["-f", profile, closure.executable, ...input.args];
      } else {
        command = exactExecutable("bwrap", this.#searchPath, cwd);
        args = [
          ...buildBubblewrapArgs(policy, process.env["HOME"] ?? tmpdir()),
          "--ro-bind", shimDir, LOGICAL_SANITIZED_PATH,
          closure.executable,
          ...input.args,
        ];
      }
    } catch (error) {
      cleanup();
      throw error;
    }

    const started = Date.now();
    const stdout = new BoundedCapture(maxOutputBytes);
    const stderr = new BoundedCapture(maxOutputBytes);
    let observed = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimited = false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      cleanup();
      throw sandboxFailure(`Sandbox process could not start: ${errorMessage(error)}`);
    }

    const observe = (
      capture: BoundedCapture,
      callback: ((chunk: Buffer) => void) | undefined,
      chunk: Buffer,
    ): void => {
      observed += chunk.length;
      capture.push(chunk);
      if (observed <= maxOutputBytes) callback?.(chunk);
      if (observed > maxOutputBytes && !outputLimited) {
        outputLimited = true;
        terminateTree(child);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => observe(stdout, input.onStdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => observe(stderr, input.onStderr, chunk));
    const cancelTimer = armKillTimer(child, input.timeoutMs, () => {
      timedOut = true;
    });

    const result = new Promise<SandboxResult>((resolveResult) => {
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code, signal) => {
        cancelTimer();
        const outcome: SandboxResult["outcome"] = aborted
          ? "aborted"
          : timedOut
            ? "timeout"
            : outputLimited || spawnError !== undefined
              ? "sandbox-denied"
              : signal !== null
                ? "signaled"
                : "exited";
        const value: SandboxResult = {
          outcome,
          exitCode: code,
          signal: aborted ? "ABORT" : signal,
          stdout: stdout.text(),
          stderr: [stderr.text(), spawnError?.message, outputLimited ? "sandbox output limit exceeded" : undefined]
            .filter((part): part is string => part !== undefined && part !== "")
            .join("\n"),
          durationMs: Date.now() - started,
        };
        cleanup();
        resolveResult(value);
      });
    });
    let abortPromise: Promise<void> | undefined;
    const abort = (): Promise<void> => {
      if (abortPromise !== undefined) return abortPromise;
      aborted = true;
      terminateTree(child);
      abortPromise = result.then(() => undefined);
      return abortPromise;
    };

    return {
      layout,
      qualification: closure.qualification,
      result,
      abort,
    };
  }

  async run(input: SandboxRunInput): Promise<SandboxResult> {
    return (await this.start(input)).result;
  }
}

class DisabledSandboxBackend implements SandboxBackend {
  readonly mechanism = "none" as const;
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
  if (os !== "darwin" && os !== "linux") {
    throw sandboxFailure(`The native sandbox backend is not implemented for ${os}.`);
  }
  return new NativeSandboxBackend(os, options.path ?? process.env["PATH"] ?? "");
}
