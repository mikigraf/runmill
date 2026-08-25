import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { sha256Digest } from "../asf/canonical-json.js";
import type {
  CredentialFreeProductionSandbox,
  CredentialFreeSandboxExecution,
  ToolResourceLimits,
} from "../agent/tool-gateway.js";
import type { Clock } from "../platform/clock.js";
import {
  runControlledProcess,
  type ControlledProcessResult,
} from "../platform/process.js";
import { run } from "../platform/process.js";
import type { SandboxResult } from "./sandbox.js";

export const ASF_BUBBLEWRAP_QUALIFICATION_SCHEMA =
  "asf.bubblewrap-qualification/v1" as const;
export const ASF_BUBBLEWRAP_EXECUTION_SCHEMA = "asf.bubblewrap-execution/v1" as const;
/**
 * Relative path used only by the planted qualification fixture.  It is not a
 * production ctxlane endpoint: the host-side probe creates a socket here and
 * verifies that the worker namespace cannot resolve it.
 */
export const ASF_BUBBLEWRAP_CTXLANE_CONTROL_SOCKET_CANARY =
  "host-run/ctxlane/control.sock" as const;

const GIT_SHA = /^[a-f0-9]{40}$/u;
const SAFE_ENV_KEYS = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);
const DEFAULT_PATH = "/usr/bin:/bin";
const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_QUALIFICATION_OUTPUT = 1024 * 1024;
const SYSTEM_EXECUTABLE_ROOTS = ["/usr", "/bin", "/sbin"] as const;
const SYSTEM_READ_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64"] as const;

type AsfBubblewrapRefusalReason =
  | "unsupported-host"
  | "unsafe-host"
  | "missing-control"
  | "qualification-failed"
  | "contract-mismatch"
  | "workspace-refused"
  | "candidate-mismatch"
  | "candidate-dirty"
  | "binary-changed"
  | "resource-limit-refused";

export class AsfBubblewrapRefusalError extends Error {
  readonly code = "RM-ASF-BWRAP-REFUSED";
  readonly reason: AsfBubblewrapRefusalReason;

  constructor(reason: AsfBubblewrapRefusalReason, summary: string) {
    super(`ASF bubblewrap execution refused: ${summary}`);
    this.name = "AsfBubblewrapRefusalError";
    this.reason = reason;
  }
}

function refuse(reason: AsfBubblewrapRefusalReason, summary: string): never {
  throw new AsfBubblewrapRefusalError(reason, summary);
}

function rawDigest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function insideOrEqual(parent: string, candidate: string): boolean {
  return parent === candidate || inside(parent, candidate);
}

function immutableExecutable(path: string, label: string): ExecutableObservation {
  let resolved: string;
  try {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("not absolute");
    accessSync(path, constants.X_OK);
    resolved = realpathSync(path);
  } catch {
    refuse("missing-control", `${label} is unavailable at its configured absolute path`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    refuse("unsafe-host", `${label} is not a root-owned, non-writable regular executable`);
  }
  return {
    path: resolved,
    sha256: rawDigest(readFileSync(resolved)),
    device: String(stat.dev),
    inode: String(stat.ino),
    size_bytes: stat.size,
  };
}

function findExecutable(explicit: string | undefined, candidates: readonly string[], label: string) {
  if (explicit !== undefined) return immutableExecutable(explicit, label);
  for (const path of candidates) {
    try {
      return immutableExecutable(path, label);
    } catch (error) {
      if (!(error instanceof AsfBubblewrapRefusalError)) throw error;
    }
  }
  refuse("missing-control", `${label} was not found in a trusted system location`);
}

function sameExecutable(expected: ExecutableObservation): boolean {
  try {
    const current = immutableExecutable(expected.path, "qualified executable");
    return (
      current.path === expected.path &&
      current.sha256 === expected.sha256 &&
      current.device === expected.device &&
      current.inode === expected.inode &&
      current.size_bytes === expected.size_bytes
    );
  } catch {
    return false;
  }
}

interface ExecutableObservation {
  readonly path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly size_bytes: number;
}

export interface AsfWorkspaceCandidateProof {
  readonly workspace_path_digest: string;
  readonly candidate_sha: string;
  readonly head_sha: string;
  readonly tree_sha: string;
  readonly clean: boolean;
  readonly status_digest: string;
  readonly git_directory: "self-contained";
}

export interface AsfBubblewrapQualificationObservation {
  readonly schema: typeof ASF_BUBBLEWRAP_QUALIFICATION_SCHEMA;
  readonly observed_at: string;
  readonly platform: "linux";
  readonly kernel_release: string;
  readonly uid: number;
  readonly workspace_parent_digest: string;
  readonly executables: {
    readonly bubblewrap: ExecutableObservation & { readonly version_digest: string };
    readonly prlimit: ExecutableObservation & { readonly version_digest: string };
    readonly git: ExecutableObservation & { readonly version_digest: string };
    readonly unshare: ExecutableObservation & { readonly version_digest: string };
  };
  readonly probes: {
    readonly namespace_ids_changed: readonly ["mount", "network", "pid", "user"];
    readonly network_interfaces: readonly ["lo"];
    readonly workspace_read: true;
    readonly workspace_write: true;
    readonly root_write_denied: true;
    readonly system_runtime_write_denied: true;
    readonly git_metadata_write_denied: true;
    readonly sibling_read_denied: true;
    readonly credential_read_denied: true;
    readonly host_socket_path_denied: true;
    /** The synthetic ctxlane-shaped control socket was absent in the worker namespace. */
    readonly ctxlane_control_socket_path: typeof ASF_BUBBLEWRAP_CTXLANE_CONTROL_SOCKET_CANARY;
    readonly ctxlane_control_socket_path_denied: true;
    readonly nested_user_namespace_denied: true;
    readonly cloud_metadata_route_absent: true;
    readonly environment_keys: readonly string[];
    readonly limits: {
      readonly cpu_seconds: number;
      readonly address_space_bytes: number;
      readonly processes: number;
      readonly file_size_bytes: number;
      readonly report_digest: string;
    };
  };
  readonly controls: {
    readonly root_filesystem: "empty-read-only";
    readonly system_runtime: "read-only";
    readonly base_repository: "not-mounted";
    readonly workspace: "single-disposable-bind";
    readonly network: "new-namespace-no-interfaces";
    readonly environment: "clear-then-allowlist";
    readonly capabilities: "all-dropped";
    readonly nested_user_namespaces: "disabled";
    readonly downgrade: "refused";
  };
  readonly qualification_digest: string;
}

export interface AsfBubblewrapExecutionObservation {
  readonly schema: typeof ASF_BUBBLEWRAP_EXECUTION_SCHEMA;
  readonly qualification_digest: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly candidate_before: AsfWorkspaceCandidateProof;
  readonly candidate_after: AsfWorkspaceCandidateProof;
  readonly writable_workspace: boolean;
  readonly limits: {
    readonly requested_cpu_millis: number;
    readonly enforced_cpu_seconds: number;
    readonly memory_bytes: number;
    readonly processes: number;
    readonly file_size_bytes: number;
    readonly wall_time_millis: number;
    readonly captured_output_bytes: number;
  };
  readonly result: {
    readonly outcome: SandboxResult["outcome"];
    readonly exit_code: number | null;
    readonly signal: string | null;
    readonly stdout_digest: string;
    readonly stderr_digest: string;
  };
  readonly observation_digest: string;
}

export interface AsfBubblewrapProductionSandboxOptions {
  readonly clock: Clock;
  /** Runmill-owned parent containing disposable, per-run clone workspaces. */
  readonly workspaceParent: string;
  readonly bwrapPath?: string | undefined;
  readonly prlimitPath?: string | undefined;
  readonly gitPath?: string | undefined;
  /** Trusted executable output retained before the gateway applies its narrower request ceiling. */
  readonly maxCapturedOutputBytes?: number | undefined;
  readonly onObservation?:
    | ((observation: AsfBubblewrapExecutionObservation) => void | Promise<void>)
    | undefined;
}

export interface AsfBubblewrapArgumentInput {
  readonly workspaceRoot: string;
  readonly writableWorkspace: boolean;
  readonly protectedPaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly command: string;
  readonly args: readonly string[];
}

/** Build the exact fail-closed namespace and mount contract used in production. */
export function buildAsfBubblewrapArgs(input: AsfBubblewrapArgumentInput): string[] {
  const args = [
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/etc",
    "--dir",
    "/home",
  ];

  for (const root of SYSTEM_READ_ROOTS) args.push("--ro-bind-try", root, root);
  for (const file of ["/etc/ld.so.cache", "/etc/localtime"]) {
    args.push("--ro-bind-try", file, file);
  }

  // Lock the otherwise-empty namespace root before adding the two disposable
  // writable mounts. No host root, home, /run, /var, or workspace parent is
  // ever bound into the namespace.
  args.push(
    "--remount-ro",
    "/",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--dir",
    "/home/runmill",
  );
  args.push(
    input.writableWorkspace ? "--bind" : "--ro-bind",
    input.workspaceRoot,
    input.workspaceRoot,
  );
  for (const path of input.protectedPaths) args.push("--ro-bind", path, path);

  args.push("--chdir", input.workspaceRoot, "--clearenv");
  const environment = {
    HOME: "/home/runmill",
    TMPDIR: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...input.environment,
  };
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("--setenv", key, value);
  }
  args.push(input.command, ...input.args);
  return args;
}

export function buildAsfPrlimitArgs(
  input: Pick<ToolResourceLimits, "cpuMillis" | "memoryMib" | "processes" | "fileSizeBytes">,
  bwrapPath: string,
  bwrapArgs: readonly string[],
): { readonly args: string[]; readonly cpuSeconds: number; readonly memoryBytes: number } {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse("resource-limit-refused", `${label} is not a positive safe integer`);
    }
  }
  const cpuSeconds = Math.floor(input.cpuMillis / 1_000);
  if (cpuSeconds < 1) {
    refuse(
      "resource-limit-refused",
      "sub-second CPU budgets cannot be enforced by RLIMIT_CPU without widening authority",
    );
  }
  const memoryBytes = input.memoryMib * 1024 * 1024;
  if (!Number.isSafeInteger(memoryBytes)) {
    refuse("resource-limit-refused", "memory byte limit is outside the safe integer range");
  }
  return {
    args: [
      `--cpu=${String(cpuSeconds)}:${String(cpuSeconds)}`,
      `--as=${String(memoryBytes)}:${String(memoryBytes)}`,
      `--nproc=${String(input.processes)}:${String(input.processes)}`,
      `--fsize=${String(input.fileSizeBytes)}:${String(input.fileSizeBytes)}`,
      "--",
      bwrapPath,
      ...bwrapArgs,
    ],
    cpuSeconds,
    memoryBytes,
  };
}

const HOST_GIT_ENV: Readonly<Record<string, string>> = {
  PATH: DEFAULT_PATH,
  LANG: "C",
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

async function gitObservation(gitPath: string, cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(
    gitPath,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, env: HOST_GIT_ENV, timeoutMs: 10_000 },
  );
  if (!result.ok) refuse("workspace-refused", "trusted Git workspace observation failed");
  return result.stdout.replace(/\r?\n$/u, "");
}

/** Observe and, when requested, require a clean checkout at the exact candidate. */
export async function proveAsfWorkspaceCandidate(input: {
  readonly workspaceRoot: string;
  readonly candidateSha: string;
  readonly requireClean: boolean;
  readonly gitPath?: string | undefined;
}): Promise<AsfWorkspaceCandidateProof> {
  if (!GIT_SHA.test(input.candidateSha)) {
    refuse("candidate-mismatch", "candidate SHA is malformed");
  }
  let workspace: string;
  try {
    workspace = realpathSync(input.workspaceRoot);
  } catch {
    refuse("workspace-refused", "workspace does not exist");
  }
  if (workspace !== input.workspaceRoot || !lstatSync(workspace).isDirectory()) {
    refuse("workspace-refused", "workspace path must be a canonical directory, not a symlink");
  }
  const dotGit = join(workspace, ".git");
  if (!existsSync(dotGit) || !lstatSync(dotGit).isDirectory() || !inside(workspace, realpathSync(dotGit))) {
    refuse("workspace-refused", "workspace Git metadata is not a self-contained directory");
  }

  const gitPath = input.gitPath ?? "/usr/bin/git";
  const top = await gitObservation(gitPath, workspace, ["rev-parse", "--show-toplevel"]);
  let canonicalTop: string;
  try {
    canonicalTop = realpathSync(top);
  } catch {
    refuse("workspace-refused", "Git top-level observation is not a canonical path");
  }
  if (canonicalTop !== workspace) refuse("workspace-refused", "Git top-level is not the workspace root");

  const head = await gitObservation(gitPath, workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== input.candidateSha) {
    refuse("candidate-mismatch", "workspace HEAD does not equal the exact authorized candidate");
  }
  const tree = await gitObservation(gitPath, workspace, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const status = await gitObservation(gitPath, workspace, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  const clean = status === "";
  if (input.requireClean && !clean) {
    refuse("candidate-dirty", "fresh-candidate execution requires an exactly clean Git tree");
  }
  return {
    workspace_path_digest: rawDigest(workspace),
    candidate_sha: input.candidateSha,
    head_sha: head,
    tree_sha: tree,
    clean,
    status_digest: rawDigest(status),
    git_directory: "self-contained",
  };
}

function sanitizedEnvironment(raw: Readonly<Record<string, string>> | undefined) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!SAFE_ENV_KEYS.has(key) || key.includes("\0") || /[\0\r\n]/u.test(value)) {
      refuse("contract-mismatch", "sandbox environment is not strictly allowlisted");
    }
    if (key === "PATH") {
      const entries = value.split(":");
      if (
        entries.length === 0 ||
        entries.some(
          (entry) =>
            entry === "" ||
            !isAbsolute(entry) ||
            !SYSTEM_EXECUTABLE_ROOTS.some((root) => insideOrEqual(root, entry)),
        )
      ) {
        refuse("contract-mismatch", "PATH contains a non-system or ambiguous entry");
      }
    }
    environment[key] = value;
  }
  environment["PATH"] ??= DEFAULT_PATH;
  return Object.freeze(environment);
}

function canonicalProtectedPaths(workspace: string, raw: readonly string[]): readonly string[] {
  const paths = raw.map((path) => {
    if (!isAbsolute(path) || !existsSync(path)) {
      refuse("contract-mismatch", "a mandatory protected path is absent or non-absolute");
    }
    const resolved = realpathSync(path);
    if (!inside(workspace, resolved)) {
      refuse("contract-mismatch", "protected paths may only narrow the selected workspace");
    }
    return resolved;
  });
  for (const mandatory of [join(workspace, ".git"), join(workspace, ".runmill")]) {
    if (!paths.includes(realpathSync(mandatory))) {
      refuse("contract-mismatch", "Git metadata and .runmill inputs must both be read-only");
    }
  }
  return [...new Set(paths)].sort();
}

function effectiveLimits(input: CredentialFreeSandboxExecution) {
  const { limits, sandbox } = input;
  for (const [label, value] of Object.entries({ ...limits, wallTimeMs: sandbox.timeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse("resource-limit-refused", `${label} is not a positive safe integer`);
    }
  }
  if (
    input.stdin !== undefined &&
    Buffer.byteLength(input.stdin, "utf8") > input.limits.fileSizeBytes
  ) {
    refuse("resource-limit-refused", "stdin exceeds the enforced per-file byte ceiling");
  }
  return limits;
}

interface ValidatedExecution {
  readonly workspace: string;
  readonly writable: boolean;
  readonly protectedPaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workspaceIdentity: string;
}

function validateExecutionContract(
  input: CredentialFreeSandboxExecution,
  workspaceParent: string,
): ValidatedExecution {
  const { sandbox, isolation } = input;
  if (
    isolation.inheritEnvironment !== false ||
    isolation.providerCredentials !== "denied" ||
    isolation.hostCredentialPaths !== "denied" ||
    isolation.hostSockets !== "denied" ||
    isolation.otherWorkspaces !== "denied" ||
    isolation.network !== "disabled" ||
    sandbox.policy.allowNetwork !== false ||
    (sandbox.policy.allowUnenforced?.length ?? 0) !== 0 ||
    (sandbox.policy.writableFiles?.length ?? 0) !== 0
  ) {
    refuse("contract-mismatch", "requested execution weakens the production isolation contract");
  }
  if (
    !isAbsolute(sandbox.command) ||
    sandbox.command.includes("\0") ||
    sandbox.args.some((argument) => argument.includes("\0"))
  ) {
    refuse("contract-mismatch", "command must be an absolute NUL-free direct invocation");
  }
  let command: string;
  try {
    command = realpathSync(sandbox.command);
  } catch {
    refuse("contract-mismatch", "command does not resolve to a trusted executable");
  }
  if (!SYSTEM_EXECUTABLE_ROOTS.some((root) => insideOrEqual(root, command))) {
    refuse("contract-mismatch", "command is outside the read-only trusted system toolchain");
  }

  let workspace: string;
  try {
    workspace = realpathSync(sandbox.cwd);
  } catch {
    refuse("workspace-refused", "workspace path does not exist");
  }
  if (
    workspace !== sandbox.cwd ||
    !inside(workspaceParent, workspace) ||
    SYSTEM_READ_ROOTS.some((root) => insideOrEqual(root, workspace))
  ) {
    refuse("workspace-refused", "workspace is not a canonical disposable child of the configured root");
  }
  const stat = lstatSync(workspace);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    refuse("workspace-refused", "workspace ownership or write permissions are unsafe");
  }
  if (!existsSync(join(workspace, ".runmill")) || !lstatSync(join(workspace, ".runmill")).isDirectory()) {
    refuse("workspace-refused", "workspace lacks its orchestrator-owned .runmill input directory");
  }

  const readable = (sandbox.policy.readablePaths ?? []).map((path) => realpathSync(path));
  if (readable.length !== 1 || readable[0] !== workspace) {
    refuse("contract-mismatch", "only the selected workspace may be added as a readable host path");
  }
  const writablePaths = sandbox.policy.writablePaths.map((path) => realpathSync(path));
  if (writablePaths.length > 1 || (writablePaths.length === 1 && writablePaths[0] !== workspace)) {
    refuse("contract-mismatch", "only the selected disposable workspace may be writable");
  }

  effectiveLimits(input);
  return {
    workspace,
    writable: writablePaths.length === 1,
    protectedPaths: canonicalProtectedPaths(workspace, sandbox.policy.protectedPaths ?? []),
    environment: sanitizedEnvironment(sandbox.env),
    workspaceIdentity: `${String(stat.dev)}:${String(stat.ino)}`,
  };
}

function sandboxResult(result: ControlledProcessResult, durationMs: number): SandboxResult {
  switch (result.outcome) {
    case "exited":
      return {
        outcome: "exited",
        exitCode: result.exitCode,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
    case "timeout":
      return {
        outcome: "timeout",
        exitCode: null,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
    case "aborted":
      return {
        outcome: "signaled",
        exitCode: null,
        signal: "ABORT",
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
    case "signaled":
      return {
        outcome: "signaled",
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
    case "output-limit":
      return {
        outcome: "sandbox-denied",
        exitCode: null,
        signal: "OUTPUT_LIMIT",
        stdout: result.stdout,
        stderr: [result.stderr, "trusted process output ceiling exceeded"].filter(Boolean).join("\n"),
        durationMs,
      };
    case "spawn-error":
      return {
        outcome: "sandbox-denied",
        exitCode: null,
        signal: null,
        stdout: result.stdout,
        stderr: "trusted sandbox process could not start",
        durationMs,
      };
  }
}

function parseNetworkInterfaces(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .slice(2)
    .map((line) => line.split(":", 1)[0]?.trim() ?? "")
    .filter((name) => name !== "")
    .sort();
}

function parseLimitReport(output: string) {
  const limits = new Map<string, { soft: number; hard: number; units: string }>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\S+)\s+.*?\s+(\d+)\s+(\d+)\s+(\S+)$/u);
    if (match === null) continue;
    limits.set(match[1] ?? "", {
      soft: Number(match[2]),
      hard: Number(match[3]),
      units: match[4] ?? "",
    });
  }
  return limits;
}

async function executableVersion(executable: ExecutableObservation, label: string): Promise<string> {
  const result = await run(executable.path, ["--version"], {
    env: { PATH: DEFAULT_PATH, LANG: "C" },
    timeoutMs: 5_000,
  });
  if (!result.ok || result.stdout.trim() === "") {
    refuse("qualification-failed", `${label} version probe failed`);
  }
  return rawDigest(result.stdout.trim());
}

interface QualificationContext {
  readonly clock: Clock;
  readonly workspaceParent: string;
  readonly bwrap: ExecutableObservation;
  readonly prlimit: ExecutableObservation;
  readonly git: ExecutableObservation;
  readonly unshare: ExecutableObservation;
}

async function qualify(context: QualificationContext): Promise<AsfBubblewrapQualificationObservation> {
  const probeRoot = mkdtempSync(join(context.workspaceParent, ".asf-bwrap-qualify-"));
  const workspace = join(probeRoot, "workspace");
  const outside = join(probeRoot, "other-workspace-secret");
  const homeSecret = join(probeRoot, "host-home", ".ssh", "id_probe");
  const socketCanary = join(probeRoot, "host-run", "docker.sock");
  const ctxlaneSocketCanary = join(probeRoot, ASF_BUBBLEWRAP_CTXLANE_CONTROL_SOCKET_CANARY);
  mkdirSync(join(workspace, ".git"), { recursive: true, mode: 0o700 });
  mkdirSync(join(workspace, ".runmill"), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(homeSecret), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(socketCanary), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(ctxlaneSocketCanary), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "readable"), "workspace-visible", { mode: 0o600 });
  writeFileSync(outside, "other-workspace-secret", { mode: 0o600 });
  writeFileSync(homeSecret, "credential-secret", { mode: 0o600 });
  const socketServer = createServer((connection) => connection.destroy());
  const ctxlaneSocketServer = createServer((connection) => connection.destroy());

  const qualificationLimits = {
    cpuMillis: 30_000,
    memoryMib: 512,
    processes: 4_096,
    fileSizeBytes: 1_048_576,
  } as const;
  const environment = Object.freeze({ PATH: DEFAULT_PATH, LANG: "C" });
  const protectedPaths = [join(workspace, ".git"), join(workspace, ".runmill")];
  const signal = new AbortController().signal;

  const probe = async (command: string, args: readonly string[]): Promise<ControlledProcessResult> => {
    const bwrapArgs = buildAsfBubblewrapArgs({
      workspaceRoot: workspace,
      writableWorkspace: true,
      protectedPaths,
      environment,
      command,
      args,
    });
    const limited = buildAsfPrlimitArgs(qualificationLimits, context.bwrap.path, bwrapArgs);
    return runControlledProcess({
      command: context.prlimit.path,
      args: limited.args,
      cwd: workspace,
      env: { PATH: DEFAULT_PATH, LANG: "C" },
      timeoutMs: 10_000,
      maxOutputBytes: MAX_QUALIFICATION_OUTPUT,
      signal,
    });
  };

  const requireExit = (result: ControlledProcessResult, label: string): ControlledProcessResult => {
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      refuse("qualification-failed", `${label} probe did not complete inside bubblewrap`);
    }
    return result;
  };
  const requireDenied = (result: ControlledProcessResult, secret: string, label: string): void => {
    if (
      result.outcome !== "exited" ||
      result.exitCode === 0 ||
      (secret !== "" && result.stdout.includes(secret)) ||
      (secret !== "" && result.stderr.includes(secret))
    ) {
      refuse("qualification-failed", `${label} was not denied by the observed namespace`);
    }
  };

  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        socketServer.once("error", reject);
        socketServer.listen(socketCanary, () => {
          socketServer.removeListener("error", reject);
          resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        ctxlaneSocketServer.once("error", reject);
        ctxlaneSocketServer.listen(ctxlaneSocketCanary, () => {
          ctxlaneSocketServer.removeListener("error", reject);
          resolve();
        });
      }),
    ]);
    const read = requireExit(await probe("/usr/bin/cat", [join(workspace, "readable")]), "workspace read");
    if (read.stdout.trim() !== "workspace-visible") {
      refuse("qualification-failed", "workspace read probe returned contradictory bytes");
    }
    requireExit(await probe("/usr/bin/touch", [join(workspace, "writable")]), "workspace write");
    if (!existsSync(join(workspace, "writable"))) {
      refuse("qualification-failed", "workspace write probe produced no host observation");
    }

    requireDenied(await probe("/usr/bin/touch", ["/etc/runmill-forbidden"]), "", "root write");
    requireDenied(
      await probe("/usr/bin/touch", ["/usr/runmill-forbidden"]),
      "",
      "system runtime write",
    );
    requireDenied(await probe("/usr/bin/touch", [join(workspace, ".git", "forbidden")]), "", "Git metadata write");
    requireDenied(await probe("/usr/bin/cat", [outside]), "other-workspace-secret", "sibling read");
    requireDenied(await probe("/usr/bin/cat", [homeSecret]), "credential-secret", "credential read");
    // `readlink -e` succeeds for a real socket inode but must fail when the
    // host path is absent from the worker namespace. Reading a regular file
    // would only prove file-content denial and would not exercise the socket
    // path boundary required by CTX-SEC-002.
    requireDenied(await probe("/usr/bin/readlink", ["-e", socketCanary]), "", "host socket path");
    // Keep this canary deliberately synthetic.  The production endpoint is
    // operator-configured and is never copied into a worker; this proves the
    // specific ctxlane-shaped control-socket path cannot cross the boundary.
    requireDenied(
      await probe("/usr/bin/readlink", ["-e", ctxlaneSocketCanary]),
      "",
      "ctxlane control socket path",
    );
    requireDenied(
      await probe(context.unshare.path, ["--user", "--map-root-user", "/usr/bin/true"]),
      "",
      "nested user namespace",
    );

    const envProbe = requireExit(await probe("/usr/bin/env", []), "environment");
    const environmentKeys = envProbe.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.split("=", 1)[0] ?? "")
      .sort();
    const expectedEnvironment = [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_OPTIONAL_LOCKS",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ].sort();
    if (environmentKeys.join("\0") !== expectedEnvironment.join("\0")) {
      refuse("qualification-failed", "clear-environment probe observed an inherited variable");
    }

    const namespaces = requireExit(
      await probe("/usr/bin/readlink", [
        "/proc/self/ns/mnt",
        "/proc/self/ns/net",
        "/proc/self/ns/pid",
        "/proc/self/ns/user",
      ]),
      "namespace",
    ).stdout.trim().split(/\r?\n/u);
    const hostNamespaces = ["mnt", "net", "pid", "user"].map((name) =>
      readlinkSync(`/proc/self/ns/${name}`),
    );
    if (
      namespaces.length !== 4 ||
      namespaces.some((namespace, index) => namespace === hostNamespaces[index])
    ) {
      refuse("qualification-failed", "one or more mandatory namespaces were not actually changed");
    }

    const network = requireExit(await probe("/usr/bin/cat", ["/proc/net/dev"]), "network");
    const interfaces = parseNetworkInterfaces(network.stdout);
    if (interfaces.length !== 1 || interfaces[0] !== "lo") {
      refuse("qualification-failed", "network namespace exposes a non-loopback interface");
    }
    const routes = requireExit(await probe("/usr/bin/cat", ["/proc/net/route"]), "network route")
      .stdout.split(/\r?\n/u)
      .slice(1)
      .filter((line) => line.trim() !== "");
    if (routes.length !== 0) {
      refuse("qualification-failed", "network namespace contains a route to host or metadata networks");
    }

    const limitProbe = requireExit(
      await probe(context.prlimit.path, [
        "--cpu",
        "--as",
        "--nproc",
        "--fsize",
        "--output=RESOURCE,SOFT,HARD,UNITS",
        "--noheadings",
      ]),
      "resource limits",
    );
    const reported = parseLimitReport(limitProbe.stdout);
    const expected = {
      CPU: 30,
      AS: 512 * 1024 * 1024,
      NPROC: 4_096,
      FSIZE: 1_048_576,
    } as const;
    for (const [resource, value] of Object.entries(expected)) {
      const observed = reported.get(resource);
      if (observed === undefined || observed.soft !== value || observed.hard !== value) {
        refuse("qualification-failed", `${resource} limit was not observed at the exact requested value`);
      }
    }

    const bwrapVersion = await executableVersion(context.bwrap, "bubblewrap");
    const prlimitVersion = await executableVersion(context.prlimit, "prlimit");
    const gitVersion = await executableVersion(context.git, "Git");
    const unshareVersion = await executableVersion(context.unshare, "unshare");
    const unsigned = {
      schema: ASF_BUBBLEWRAP_QUALIFICATION_SCHEMA,
      observed_at: context.clock.now().toISOString(),
      platform: "linux" as const,
      kernel_release: release(),
      uid: process.getuid?.() ?? -1,
      workspace_parent_digest: rawDigest(context.workspaceParent),
      executables: {
        bubblewrap: { ...context.bwrap, version_digest: bwrapVersion },
        prlimit: { ...context.prlimit, version_digest: prlimitVersion },
        git: { ...context.git, version_digest: gitVersion },
        unshare: { ...context.unshare, version_digest: unshareVersion },
      },
      probes: {
        namespace_ids_changed: ["mount", "network", "pid", "user"] as const,
        network_interfaces: ["lo"] as const,
        workspace_read: true as const,
        workspace_write: true as const,
        root_write_denied: true as const,
        system_runtime_write_denied: true as const,
        git_metadata_write_denied: true as const,
        sibling_read_denied: true as const,
        credential_read_denied: true as const,
        host_socket_path_denied: true as const,
        ctxlane_control_socket_path: ASF_BUBBLEWRAP_CTXLANE_CONTROL_SOCKET_CANARY,
        ctxlane_control_socket_path_denied: true as const,
        nested_user_namespace_denied: true as const,
        cloud_metadata_route_absent: true as const,
        environment_keys: environmentKeys,
        limits: {
          cpu_seconds: expected.CPU,
          address_space_bytes: expected.AS,
          processes: expected.NPROC,
          file_size_bytes: expected.FSIZE,
          report_digest: rawDigest(limitProbe.stdout),
        },
      },
      controls: {
        root_filesystem: "empty-read-only" as const,
        system_runtime: "read-only" as const,
        base_repository: "not-mounted" as const,
        workspace: "single-disposable-bind" as const,
        network: "new-namespace-no-interfaces" as const,
        environment: "clear-then-allowlist" as const,
        capabilities: "all-dropped" as const,
        nested_user_namespaces: "disabled" as const,
        downgrade: "refused" as const,
      },
    };
    return { ...unsigned, qualification_digest: sha256Digest(unsigned) };
  } finally {
    if (socketServer.listening) {
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    }
    if (ctxlaneSocketServer.listening) {
      await new Promise<void>((resolve) => ctxlaneSocketServer.close(() => resolve()));
    }
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Production-only Linux bubblewrap executor.
 *
 * Construction is asynchronous because a type label is not qualification:
 * every instance first runs planted-resource, namespace, environment, and
 * resource-limit probes through the exact bwrap+prlimit chain it will use.
 */
export class AsfBubblewrapProductionSandbox implements CredentialFreeProductionSandbox {
  readonly mechanism = "bubblewrap" as const;
  readonly enforcement = "production-credential-free" as const;
  readonly #clock: Clock;
  readonly #workspaceParent: string;
  readonly #bwrap: ExecutableObservation;
  readonly #prlimit: ExecutableObservation;
  readonly #git: ExecutableObservation;
  readonly #maxOutputBytes: number;
  readonly #onObservation:
    | ((observation: AsfBubblewrapExecutionObservation) => void | Promise<void>)
    | undefined;
  readonly qualification: AsfBubblewrapQualificationObservation;

  private constructor(input: {
    readonly options: AsfBubblewrapProductionSandboxOptions;
    readonly workspaceParent: string;
    readonly bwrap: ExecutableObservation;
    readonly prlimit: ExecutableObservation;
    readonly git: ExecutableObservation;
    readonly maxOutputBytes: number;
    readonly qualification: AsfBubblewrapQualificationObservation;
  }) {
    this.#clock = input.options.clock;
    this.#workspaceParent = input.workspaceParent;
    this.#bwrap = input.bwrap;
    this.#prlimit = input.prlimit;
    this.#git = input.git;
    this.#maxOutputBytes = input.maxOutputBytes;
    this.#onObservation = input.options.onObservation;
    this.qualification = input.qualification;
  }

  static async create(
    options: AsfBubblewrapProductionSandboxOptions,
  ): Promise<AsfBubblewrapProductionSandbox> {
    if (platform() !== "linux") {
      refuse("unsupported-host", "production ASF sandboxing requires Linux");
    }
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0) {
      refuse("unsafe-host", "production ASF sandboxing requires a non-root Unix worker account");
    }
    let workspaceParent: string;
    try {
      workspaceParent = realpathSync(options.workspaceParent);
    } catch {
      refuse("workspace-refused", "configured workspace parent does not exist");
    }
    const parentStat = lstatSync(workspaceParent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== uid ||
      (parentStat.mode & 0o077) !== 0
    ) {
      refuse("workspace-refused", "workspace parent must be a private directory owned by the worker");
    }
    const maxOutputBytes = options.maxCapturedOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > DEFAULT_OUTPUT_LIMIT) {
      refuse("resource-limit-refused", "trusted capture ceiling is outside the production bound");
    }

    const bwrap = findExecutable(options.bwrapPath, ["/usr/bin/bwrap", "/bin/bwrap"], "bubblewrap");
    const prlimit = findExecutable(
      options.prlimitPath,
      ["/usr/bin/prlimit", "/bin/prlimit"],
      "prlimit",
    );
    const git = findExecutable(options.gitPath, ["/usr/bin/git", "/bin/git"], "Git");
    const unshare = findExecutable(undefined, ["/usr/bin/unshare", "/bin/unshare"], "unshare");
    const qualification = await qualify({
      clock: options.clock,
      workspaceParent,
      bwrap,
      prlimit,
      git,
      unshare,
    });
    return new AsfBubblewrapProductionSandbox({
      options,
      workspaceParent,
      bwrap,
      prlimit,
      git,
      maxOutputBytes,
      qualification,
    });
  }

  async execute(input: CredentialFreeSandboxExecution): Promise<SandboxResult> {
    return (await this.executeObserved(input)).result;
  }

  async executeObserved(input: CredentialFreeSandboxExecution): Promise<{
    readonly result: SandboxResult;
    readonly observation: AsfBubblewrapExecutionObservation;
  }> {
    if (!sameExecutable(this.#bwrap) || !sameExecutable(this.#prlimit) || !sameExecutable(this.#git)) {
      refuse("binary-changed", "a qualified trusted executable changed after startup");
    }
    const validated = validateExecutionContract(input, this.#workspaceParent);
    if (input.signal.aborted) {
      const empty: SandboxResult = {
        outcome: "signaled",
        exitCode: null,
        signal: "ABORT",
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
      const proof = await proveAsfWorkspaceCandidate({
        workspaceRoot: validated.workspace,
        candidateSha: input.isolation.candidate,
        requireClean: input.isolation.freshCandidate,
        gitPath: this.#git.path,
      });
      return this.#observed(input, validated, proof, proof, empty, 0, 0);
    }

    const before = await proveAsfWorkspaceCandidate({
      workspaceRoot: validated.workspace,
      candidateSha: input.isolation.candidate,
      requireClean: input.isolation.freshCandidate,
      gitPath: this.#git.path,
    });
    const bwrapArgs = buildAsfBubblewrapArgs({
      workspaceRoot: validated.workspace,
      writableWorkspace: validated.writable,
      protectedPaths: validated.protectedPaths,
      environment: validated.environment,
      command: input.sandbox.command,
      args: input.sandbox.args,
    });
    const limited = buildAsfPrlimitArgs(input.limits, this.#bwrap.path, bwrapArgs);
    const startedAt = this.#clock.now().toISOString();
    const startedMonotonic = this.#clock.monotonicMs();
    const controlled = await runControlledProcess({
      command: this.#prlimit.path,
      args: limited.args,
      cwd: validated.workspace,
      env: { PATH: DEFAULT_PATH, LANG: "C" },
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      timeoutMs: input.sandbox.timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      signal: input.signal,
    });
    const durationMs = Math.max(0, this.#clock.monotonicMs() - startedMonotonic);
    const result = sandboxResult(controlled, durationMs);

    const workspaceStat = lstatSync(validated.workspace);
    if (`${String(workspaceStat.dev)}:${String(workspaceStat.ino)}` !== validated.workspaceIdentity) {
      refuse("workspace-refused", "workspace identity changed during sandbox execution");
    }
    const after = await proveAsfWorkspaceCandidate({
      workspaceRoot: validated.workspace,
      candidateSha: input.isolation.candidate,
      requireClean: input.isolation.freshCandidate,
      gitPath: this.#git.path,
    });
    return this.#observed(
      input,
      validated,
      before,
      after,
      result,
      controlled.outputBytesObserved,
      limited.cpuSeconds,
      startedAt,
    );
  }

  async #observed(
    input: CredentialFreeSandboxExecution,
    validated: ValidatedExecution,
    before: AsfWorkspaceCandidateProof,
    after: AsfWorkspaceCandidateProof,
    result: SandboxResult,
    outputBytes: number,
    cpuSeconds: number,
    startedAt = this.#clock.now().toISOString(),
  ): Promise<{
    readonly result: SandboxResult;
    readonly observation: AsfBubblewrapExecutionObservation;
  }> {
    const unsigned = {
      schema: ASF_BUBBLEWRAP_EXECUTION_SCHEMA,
      qualification_digest: this.qualification.qualification_digest,
      started_at: startedAt,
      completed_at: this.#clock.now().toISOString(),
      candidate_before: { ...before },
      candidate_after: { ...after },
      writable_workspace: validated.writable,
      limits: {
        requested_cpu_millis: input.limits.cpuMillis,
        enforced_cpu_seconds: cpuSeconds,
        memory_bytes: input.limits.memoryMib * 1024 * 1024,
        processes: input.limits.processes,
        file_size_bytes: input.limits.fileSizeBytes,
        wall_time_millis: input.sandbox.timeoutMs,
        captured_output_bytes: outputBytes,
      },
      result: {
        outcome: result.outcome,
        exit_code: result.exitCode,
        signal: result.signal,
        stdout_digest: rawDigest(result.stdout),
        stderr_digest: rawDigest(result.stderr),
      },
    };
    const observation = {
      ...unsigned,
      observation_digest: sha256Digest(unsigned),
    } satisfies AsfBubblewrapExecutionObservation;
    await this.#onObservation?.(observation);
    return { result, observation };
  }
}
