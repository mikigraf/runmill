import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, accessSync, constants } from "node:fs";
import { tmpdir, platform } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
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
  /**
   * The child's OWN credential, exempt from the denylist.
   *
   * The denylist exists so an agent cannot read credentials that are not its
   * business. A provider's own API key is the one credential that is: without
   * it the provider cannot authenticate, and stripping it made the documented
   * "or API keys" path silently impossible. Passed only by the caller that
   * owns the boundary -- check runs never set it -- and never inherited from
   * the parent environment, which is still filtered as before.
   */
  readonly credentialEnv?: Readonly<Record<string, string>> | undefined;
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

/**
 * Directories a sandboxed command needs in order to load itself.
 *
 * Every policy here denies by default and then grants the system prefixes,
 * which is enough only when the toolchain happens to live in one of them. It
 * frequently does not: codex installed through bun lives in ~/.bun/bin, node
 * through nvm or volta lives under ~/.nvm or ~/.volta, and pipx, cargo and
 * `npm --prefix ~/.local` all land in ~/.local/bin. On those machines the
 * sandbox denied the binary itself, so the process never started and the run
 * failed in milliseconds with no output at all.
 *
 * The grant is read-only and bounded to two things: the directories already on
 * PATH, which are by definition where this machine looks for executables, and
 * the tree that actually holds the resolved command. Writes are unaffected, and
 * the credential denials are emitted after every grant, so they still win.
 */
export function toolchainReadPaths(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out = new Set<string>();
  const add = (path: string | undefined): void => {
    if (path === undefined || path === "") return;
    try {
      out.add(realpathSync(path));
    } catch {
      // A PATH entry that is not there grants nothing. Skipping it keeps the
      // profile to paths that exist, which is also what bwrap requires.
    }
  };

  const entries = (env["PATH"] ?? "").split(delimiter).filter((e) => e !== "");
  for (const entry of entries) add(entry);

  // Follow the command to where it really lives. ~/.bun/bin/codex is a symlink
  // into ../install/global/node_modules/@openai/codex/bin/codex.js, so granting
  // only the PATH directory grants a link whose target is still denied.
  //
  // Every candidate on PATH is resolved, not just the first, because wrappers
  // re-resolve through PATH: the codex on ~/.superset/bin is a shell script
  // that searches PATH for the next codex and execs that. Stopping at the first
  // match grants the wrapper and denies the program it exists to run.
  const candidates = command.includes(sep) ? [command] : findOnPath(command, entries);
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    // A package needs its siblings, not just its own bin directory: the entry
    // script immediately requires dependencies from the same node_modules tree.
    const marker = `${sep}node_modules${sep}`;
    const index = real.indexOf(marker);
    add(index === -1 ? dirname(real) : real.slice(0, index));
  }

  return [...out];
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
    // /etc, /var and /tmp are symlinks into /private, and Seatbelt matches on
    // the resolved path, so a rule naming the symlink grants nothing at all.
    // `(subpath "/etc")` read as covering the system configuration for years
    // while denying every file in it, and the visible symptom was that
    // /private/etc/ssl/cert.pem was unreadable: certificate validation failed
    // and no agent could reach its own API from inside the sandbox.
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin")',
    '                  (subpath "/System") (subpath "/Library") (subpath "/opt")',
    '                  (subpath "/private/var/select") (subpath "/private/var/db/dyld")',
    // /etc/localtime is a symlink into /private/var/db/timezone, so a process
    // that formats a local time reads there. Denying it is not a restriction
    // anyone chose: it takes out `date`, every logger with a timestamp, and
    // the Claude CLI, which exits with a bare "internal error (EPERM)".
    '                  (subpath "/private/etc") (subpath "/etc") (subpath "/dev")',
    '                  (subpath "/private/var/db/timezone") (literal "/"))',
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

/**
 * System directories that hold the runtime linker and shared objects.
 *
 * Which of these exist depends on the architecture and on how merged-/usr the
 * distribution is: /lib64 carries the ELF interpreter on x86-64 and does not
 * exist at all on arm64, and /sbin is a symlink or absent on merged images.
 * They are bound with the -try form because a plain --ro-bind on a missing
 * source makes bwrap exit before the child ever starts.
 */
const OPTIONAL_SYSTEM_PATHS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64"];

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
    // /usr and /etc exist on every supported distribution, so a missing one is
    // a broken host rather than a portability case, and should fail loudly.
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
  ];
  for (const p of OPTIONAL_SYSTEM_PATHS) args.push("--ro-bind-try", p, p);
  if (!policy.allowNetwork) args.push("--unshare-net");
  // Read-only binds are emitted BEFORE the writable ones, because bwrap applies
  // mounts in order and the last one wins. The two sets overlap in practice --
  // the toolchain grant can name a directory that is also the workspace -- and
  // when the read-only bind landed last it remounted the workspace read-only,
  // leaving the agent unable to write the tree it had just been told to change.
  //
  // The -try form is used because an absent path is normal here: a developer
  // who runs only Codex has no ~/.claude, and vice versa. That means "this
  // provider is not installed", not "refuse to start the sandbox".
  for (const p of policy.readablePaths ?? []) args.push("--ro-bind-try", p, p);
  for (const p of policy.writablePaths) args.push("--bind", p, p);
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
    credentialEnv?: Readonly<Record<string, string>> | undefined;
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
    const childTmp = createPrivateTempDir();
    // The child is told to use it, so the grant and the environment agree.
    // The credential is applied after buildEnvironment, which is what makes it
    // an exemption rather than a hole: the parent environment is still
    // filtered, and only what the caller explicitly hands over survives.
    const env = {
      ...buildEnvironment(input.env),
      ...(input.credentialEnv ?? {}),
      TMPDIR: childTmp,
    };
    const policy: SandboxPolicy = {
      ...input.policy,
      writablePaths: [...input.policy.writablePaths.map(realPath), childTmp],
      readablePaths: [
        ...(input.policy.readablePaths ?? []).map(realPath),
        // Resolved against the PATH the child will actually see, not this
        // process's, so the grant matches what it will try to execute. Without
        // this a toolchain installed under the user's home is denied and the
        // command dies before it produces a single byte.
        ...toolchainReadPaths(input.command, env),
        // The trust store the environment points at. /etc/ssl/cert.pem is
        // covered by the system grant, but SSL_CERT_FILE may name a bundle
        // anywhere, and naming it without granting it reads as no trust at all.
        ...trustStoreReadPaths(env),
      ],
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
        cleanup: () => {
          rmSync(profileDir, { recursive: true, force: true });
          rmSync(childTmp, { recursive: true, force: true });
        },
      };
    }

    return {
      command: "bwrap",
      args: [...buildBubblewrapArgs(policy, home), input.command, ...input.args],
      cwd,
      env,
      cleanup: () => rmSync(childTmp, { recursive: true, force: true }),
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
