import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { run } from "../platform/process.js";
import { Sandbox, detectMechanism } from "../workspace/sandbox.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly code?: string | undefined;
  readonly observed: string;
  readonly expected: string;
  readonly remediation?: string | undefined;
}

export interface DoctorContext {
  readonly repoRoot: string;
  readonly configPath?: string | undefined;
}

async function tryRun(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const result = await run(cmd, args, cwd === undefined ? {} : { cwd });
  return {
    ok: result.ok,
    out: (result.ok ? result.stdout : result.stderr || result.stdout).trim(),
  };
}

export async function checkGit(): Promise<CheckResult> {
  const r = await tryRun("git", ["--version"]);
  return {
    id: "git",
    status: r.ok ? "pass" : "fail",
    observed: r.ok ? r.out : "not found",
    expected: "git >= 2.30",
    remediation: r.ok ? undefined : "Install git",
  };
}

export async function checkRepository(ctx: DoctorContext): Promise<CheckResult> {
  const r = await tryRun("git", ["rev-parse", "--show-toplevel"], ctx.repoRoot);
  return {
    id: "repository",
    status: r.ok ? "pass" : "fail",
    observed: r.ok ? r.out : "not a git repository",
    expected: "a git repository",
    remediation: r.ok ? undefined : "Run runmill from inside a git repository",
  };
}

/**
 * A usable `origin`.
 *
 * The issue lease is a git ref on the remote, so `git ls-remote origin` is the
 * very first thing a run does after selecting an issue. Without a remote that
 * surfaces as a raw git error from inside the daemon, after the issue is
 * already claimed, and a single quarantine is enough to open the breaker and
 * stop the loop. Checking it here costs one spawn and turns a confusing
 * mid-run stop into a sentence at setup time.
 */
/** How long the one networked probe in `doctor` may take before it gives up. */
const REMOTE_PROBE_TIMEOUT_MS = 10_000;

export async function checkRemote(ctx: DoctorContext): Promise<CheckResult> {
  const expected = "an origin remote, where runmill keeps its issue leases";
  const url = await tryRun("git", ["remote", "get-url", "origin"], ctx.repoRoot);
  if (!url.ok) {
    return {
      id: "repository:remote",
      status: "fail",
      observed: "no origin remote",
      expected,
      remediation: "git remote add origin <url>",
    };
  }

  // Reachability is a separate question from configuration. A laptop offline
  // in a tunnel should not be told its repository is misconfigured, so an
  // unreachable remote warns and says which of the two it is.
  //
  // This is the only check that touches the network, and it runs when
  // something is already wrong — very often an expired credential. Left to
  // itself git would sit on a username prompt or an unknown-host prompt with
  // no output and no deadline, so the probe is made non-interactive and
  // bounded. A diagnostic that hangs is worse than one that reports a failure.
  const reachable = await run("git", ["ls-remote", "--exit-code", "origin", "HEAD"], {
    cwd: ctx.repoRoot,
    timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5",
    },
  });
  return {
    id: "repository:remote",
    status: reachable.ok ? "pass" : "warn",
    observed: reachable.ok ? url.out : `${url.out} (unreachable)`,
    expected,
    remediation: reachable.ok
      ? undefined
      : "Check network access and credentials for this remote; runmill cannot take a lease without it",
  };
}

export async function checkGitHubCli(): Promise<CheckResult> {
  // `gh auth status` already fails informatively when gh is absent, so a
  // separate presence probe would just be one more spawn.
  const auth = await tryRun("gh", ["auth", "status"]);
  return {
    id: "github-auth",
    status: auth.ok ? "pass" : "fail",
    code: auth.ok ? undefined : "RM-AUTH-003",
    observed: auth.ok ? "authenticated" : "not authenticated",
    expected: "authenticated gh",
    remediation: auth.ok ? undefined : "gh auth login",
  };
}

export async function checkProvider(implementation: string): Promise<CheckResult> {
  // An unrecognised implementation used to fall through to codex, so a typo in
  // runmill.yaml produced a PASSING check for a provider nobody asked for.
  if (implementation !== "codex" && implementation !== "claude") {
    return {
      id: `provider:${implementation}`,
      status: "fail",
      code: "RM-CONFIG-001",
      observed: `unknown provider "${implementation}"`,
      expected: "provider.implementation is codex or claude",
      remediation: "runmill config validate",
    };
  }
  const bin = implementation;
  const r = await tryRun(bin, ["--version"]);
  return {
    id: `provider:${implementation}`,
    status: r.ok ? "pass" : "fail",
    observed: r.ok ? r.out.split("\n")[0] ?? r.out : `${bin} not found`,
    expected: `${bin} installed and authenticated`,
    remediation: r.ok ? undefined : `Install ${bin} and authenticate it`,
  };
}

/**
 * Positive AND negative sandbox probes.
 *
 * A capability check that only asks "is the mechanism present" proves nothing.
 * These attempt operations that MUST fail, and treat success as a failure of
 * the isolation guarantee.
 */
export async function checkSandbox(): Promise<CheckResult[]> {
  const os = platform();
  const results: CheckResult[] = [];

  // -- is a mechanism there at all ---------------------------------------
  if (os === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) {
      return [
        {
          id: "sandbox:mechanism",
          status: "fail",
          code: "RM-SANDBOX-001",
          observed: "sandbox-exec not found",
          expected: "Seatbelt (sandbox-exec) available",
          remediation: "runmill requires sandbox-exec on macOS",
        },
      ];
    }
    results.push({
      id: "sandbox:mechanism",
      status: "pass",
      observed: "sandbox-exec (Seatbelt)",
      expected: "Seatbelt available",
    });
  } else if (os === "linux") {
    const bwrap = await tryRun("bwrap", ["--version"]);
    if (!bwrap.ok) {
      return [
        {
          id: "sandbox:mechanism",
          status: "fail",
          code: "RM-SANDBOX-001",
          observed: "bwrap not found",
          expected: "bubblewrap installed",
          remediation: "Install bubblewrap (apt install bubblewrap)",
        },
      ];
    }
    results.push({
      id: "sandbox:mechanism",
      status: "pass",
      observed: bwrap.out,
      expected: "bubblewrap available",
    });

    const userns = await tryRun("bwrap", ["--dev-bind", "/", "/", "true"]);
    results.push({
      id: "sandbox:userns",
      status: userns.ok ? "pass" : "fail",
      code: userns.ok ? undefined : "RM-SANDBOX-001",
      observed: userns.ok ? "user namespaces usable" : userns.out.split("\n")[0] ?? "unavailable",
      expected: "unprivileged user namespaces enabled",
      remediation: userns.ok ? undefined : "sudo sysctl -w kernel.unprivileged_userns_clone=1",
    });
    if (!userns.ok) return results;
  } else {
    return [
      {
        id: "sandbox:mechanism",
        status: "fail",
        code: "RM-SANDBOX-001",
        observed: `unsupported platform: ${os}`,
        expected: "macOS or Linux",
        remediation: "runmill supports macOS (Seatbelt) and Linux (bubblewrap) only",
      },
    ];
  }

  results.push(await probeCredentialDenial());

  if (os === "darwin") {
    // Seatbelt has no network namespace, so `network: proxy` is the only
    // enforceable option on macOS. Surface it rather than hiding it.
    results.push({
      id: "sandbox:network",
      status: "warn",
      observed: "Seatbelt cannot scope network by host",
      expected: "network egress via the runmill proxy",
      remediation: "workspace.network must be `proxy` on macOS; `none` is all-or-nothing",
    });
  }

  return results;
}

/**
 * Try to read a credential from inside a real sandbox, and fail if it works.
 *
 * Two things this deliberately does not do.
 *
 * It does not hand-roll a probe profile. It builds the sandbox through the same
 * `Sandbox` the orchestrator uses, so what is proven here is the configuration
 * that will actually confine the agent — a bespoke probe profile can pass while
 * the real one leaks, which is the only outcome that would matter.
 *
 * It does not read the developer's real `~/.ssh/id_rsa`. That file is often
 * absent, and then `cat` fails because there is nothing to read: the probe
 * reports "denied" having proven nothing at all. Instead it plants a secret in
 * a temporary HOME, confirms the secret IS readable outside the sandbox, and
 * only then treats a failed read inside as evidence of denial.
 */
async function probeCredentialDenial(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), "runmill-probe-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "runmill-probe-home-"));
  const realHome = process.env["HOME"];
  const secret = join(fakeHome, ".ssh", "id_rsa");
  const marker = "RUNMILL-PROBE-SECRET";

  try {
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(secret, `${marker}\n`, { mode: 0o600 });
    process.env["HOME"] = fakeHome;

    // Control: if this is not readable unsandboxed, the probe cannot conclude
    // anything from a failure inside.
    if (!readFileSync(secret, "utf8").includes(marker)) {
      return {
        id: "sandbox:deny-credential-read",
        status: "warn",
        observed: "probe could not plant a readable secret, so denial is unproven",
        expected: "a readable secret outside the sandbox, denied inside",
        remediation: "Check that the temp directory is writable",
      };
    }

    const sandbox = new Sandbox(detectMechanism());
    const attempt = await sandbox.run({
      command: "/bin/cat",
      args: [secret],
      cwd: dir,
      policy: { writablePaths: [dir], allowNetwork: false },
      timeoutMs: 15_000,
    });

    const leaked = attempt.exitCode === 0 || attempt.stdout.includes(marker);
    return {
      id: "sandbox:deny-credential-read",
      status: leaked ? "fail" : "pass",
      code: leaked ? "RM-SANDBOX-002" : undefined,
      observed: leaked ? "read was PERMITTED" : "read denied",
      expected: "reading a credential path is denied inside the sandbox",
      remediation: leaked ? "Do not run runmill on this host until the probe fails" : undefined,
    };
  } catch (err) {
    // Constructing the sandbox at all failed. That is a sandbox failure, not a
    // reason to report the isolation guarantee as satisfied.
    return {
      id: "sandbox:deny-credential-read",
      status: "fail",
      code: "RM-SANDBOX-001",
      observed: `probe could not run: ${err instanceof Error ? err.message : String(err)}`,
      expected: "a sandbox that can be constructed and denies credential reads",
      remediation: "runmill doctor --explain sandbox",
    };
  } finally {
    if (realHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = realHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

export function checkCiEnvironment(): CheckResult {
  const inCi = process.env["CI"] === "true" || process.env["CI"] === "1";
  return {
    id: "environment",
    status: inCi ? "fail" : "pass",
    observed: inCi ? "CI=true" : "interactive host",
    expected: "a local developer machine",
    remediation: inCi
      ? "runmill is local-first; hosted/CI mode is not supported in this release"
      : undefined,
  };
}

export async function runAllChecks(
  ctx: DoctorContext,
  providerImplementations: string | readonly string[] = ["codex"],
): Promise<CheckResult[]> {
  const implementations = [
    ...new Set(
      typeof providerImplementations === "string"
        ? [providerImplementations]
        : providerImplementations,
    ),
  ];
  // Every probe is independent, so wall time is the slowest one rather than
  // the sum. Promise.all preserves order, so the rendered output is identical.
  const [git, repository, remote, github, providers, sandbox] = await Promise.all([
    checkGit(),
    checkRepository(ctx),
    checkRemote(ctx),
    checkGitHubCli(),
    Promise.all(implementations.map((implementation) => checkProvider(implementation))),
    checkSandbox(),
  ]);
  return [checkCiEnvironment(), git, repository, remote, github, ...providers, ...sandbox];
}

export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
