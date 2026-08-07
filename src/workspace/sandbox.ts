import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import { armKillTimer, BoundedCapture } from "../platform/process.js";

export type SandboxMechanism = "seatbelt" | "bubblewrap" | "none";

export interface SandboxPolicy {
  /** Directories the child may write to. Everything else is read-only or denied. */
  readonly writablePaths: readonly string[];
  /** Additional read-only paths beyond the platform baseline. */
  readonly readablePaths?: readonly string[];
  readonly allowNetwork: boolean;
  /** Controls the operator has knowingly accepted as unenforceable here. */
  readonly allowUnenforced?: readonly string[];
}

export interface SandboxResult {
  readonly outcome: "exited" | "signaled" | "timeout" | "sandbox-denied";
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
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "USER", "SHELL"];

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

/** Generate a Seatbelt profile: deny by default, then grant the minimum. */
export function buildSeatbeltProfile(policy: SandboxPolicy, home: string): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    "(allow file-read-metadata)",
    // Toolchains and system libraries. `/private/var/db/dyld` and the root
    // literal are load-bearing: without them the dynamic loader aborts with
    // SIGABRT before the target binary ever starts, so every command appears
    // to "fail" and the sandbox looks broken rather than restrictive.
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin")',
    '                  (subpath "/System") (subpath "/Library") (subpath "/opt")',
    '                  (subpath "/private/var/select") (subpath "/private/var/db/dyld")',
    '                  (subpath "/etc") (subpath "/dev") (literal "/"))',
    '(allow file-write* (subpath "/dev/null") (subpath "/dev/dtracehelper"))',
  ];

  for (const p of policy.writablePaths) {
    lines.push(`(allow file-read* file-write* (subpath ${JSON.stringify(p)}))`);
  }
  for (const p of policy.readablePaths ?? []) {
    lines.push(`(allow file-read* (subpath ${JSON.stringify(p)}))`);
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
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/etc", "/etc",
  ];
  if (!policy.allowNetwork) args.push("--unshare-net");
  for (const p of policy.writablePaths) args.push("--bind", p, p);
  for (const p of policy.readablePaths ?? []) args.push("--ro-bind", p, p);
  // Mask credential directories so even a broad bind cannot reach them.
  for (const rel of CREDENTIAL_PATHS) args.push("--tmpfs", join(home, rel));
  return args;
}

/**
 * Run a command under OS isolation.
 *
 * Mandatory: when a mechanism cannot be constructed the run does not start.
 * There is no silent downgrade, because a silent downgrade turns every
 * isolation claim in the credential table into a false statement.
 */
export class Sandbox {
  readonly #mechanism: SandboxMechanism;

  constructor(mechanism: SandboxMechanism = detectMechanism()) {
    this.#mechanism = mechanism;
  }

  get mechanism(): SandboxMechanism {
    return this.#mechanism;
  }

  /**
   * Wrap a command in this platform's sandbox.
   *
   * The single primitive every child process goes through. Returns the
   * rewritten command plus a cleanup handle for the generated profile.
   */
  wrap(input: {
    command: string;
    args: readonly string[];
    cwd: string;
    policy: SandboxPolicy;
    env?: Readonly<Record<string, string>> | undefined;
  }): {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cleanup: () => void;
  } {
    if (this.#mechanism === "none") {
      throw RunmillError.fromCatalog("RM-SANDBOX-001", {
        whatHappened: `No sandbox mechanism available on ${platform()}.`,
      });
    }

    const home = process.env["HOME"] ?? tmpdir();
    const env = buildEnvironment(input.env);
    const policy: SandboxPolicy = {
      ...input.policy,
      writablePaths: input.policy.writablePaths.map(realPath),
      readablePaths: (input.policy.readablePaths ?? []).map(realPath),
    };
    const cwd = realPath(input.cwd);

    if (this.#mechanism === "seatbelt") {
      const profileDir = mkdtempSync(join(tmpdir(), "runmill-sb-"));
      const profile = join(profileDir, "policy.sb");
      writeFileSync(profile, buildSeatbeltProfile(policy, home));
      return {
        command: "/usr/bin/sandbox-exec",
        args: ["-f", profile, input.command, ...input.args],
        cwd,
        env,
        cleanup: () => rmSync(profileDir, { recursive: true, force: true }),
      };
    }

    return {
      command: "bwrap",
      args: [...buildBubblewrapArgs(policy, home), input.command, ...input.args],
      cwd,
      env,
      cleanup: () => undefined,
    };
  }

  async run(input: SandboxRunInput): Promise<SandboxResult> {
    const wrapped = this.wrap(input);
    const started = Date.now();
    try {
      return await this.#spawn(
        wrapped.command,
        wrapped.args,
        { ...input, cwd: wrapped.cwd },
        wrapped.env,
        started,
      );
    } finally {
      wrapped.cleanup();
    }
  }

  #spawn(
    command: string,
    args: readonly string[],
    input: SandboxRunInput,
    env: Record<string, string>,
    started: number,
  ): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve) => {
      // `detached` puts the child in its own process group so a timeout can
      // kill the whole tree. An agent spawns `npm test`, which spawns workers;
      // signalling only the direct child leaves grandchildren holding file
      // handles in the worktree, and cleanup then fails.
      const child = spawn(command, [...args], {
        cwd: input.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const out = new BoundedCapture(MAX_CAPTURED_OUTPUT);
      const err = new BoundedCapture(MAX_CAPTURED_OUTPUT);
      let timedOut = false;

      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));

      const cancelTimer = armKillTimer(child, input.timeoutMs, () => {
        timedOut = true;
      });

      child.on("error", (spawnError) => {
        cancelTimer();
        resolve({
          outcome: "sandbox-denied",
          exitCode: null,
          signal: null,
          stdout: out.text(),
          stderr: `${err.text()}${errorMessage(spawnError)}`,
          durationMs: Date.now() - started,
        });
      });

      child.on("close", (code, signal) => {
        cancelTimer();
        resolve({
          outcome: timedOut ? "timeout" : signal !== null ? "signaled" : "exited",
          exitCode: code,
          signal,
          stdout: out.text(),
          stderr: err.text(),
          durationMs: Date.now() - started,
        });
      });
    });
  }
}
