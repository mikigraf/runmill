import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { run } from "../platform/process.js";

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
  const bin = implementation === "claude" ? "claude" : "codex";
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

  if (os === "darwin") {
    const present = existsSync("/usr/bin/sandbox-exec");
    if (!present) {
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

    const dir = mkdtempSync(join(tmpdir(), "runmill-probe-"));
    const profile = join(dir, "probe.sb");
    // Deny everything, then allow only what a probe needs to run at all.
    writeFileSync(
      profile,
      [
        "(version 1)",
        "(deny default)",
        "(allow process-exec)",
        "(allow process-fork)",
        "(allow sysctl-read)",
        `(allow file-read* (subpath "/usr/bin") (subpath "/bin") (subpath "/System") (subpath "/usr/lib"))`,
      ].join("\n"),
    );

    const results: CheckResult[] = [
      {
        id: "sandbox:mechanism",
        status: "pass",
        observed: "sandbox-exec (Seatbelt)",
        expected: "Seatbelt available",
      },
    ];

    // Negative probe: reading a credential path must be denied.
    const denied = await tryRun("/usr/bin/sandbox-exec", [
      "-f",
      profile,
      "/bin/cat",
      join(homedir(), ".ssh", "id_rsa"),
    ]);
    results.push({
      id: "sandbox:deny-credential-read",
      status: denied.ok ? "fail" : "pass",
      code: denied.ok ? "RM-SANDBOX-002" : undefined,
      observed: denied.ok ? "read was PERMITTED" : "read denied",
      expected: "reading ~/.ssh is denied inside the sandbox",
      remediation: denied.ok ? "Do not run runmill on this host until the probe fails" : undefined,
    });

    rmSync(dir, { recursive: true, force: true });

    // Seatbelt has no network namespace, so `network: proxy` is the only
    // enforceable option on macOS. Surface it rather than hiding it.
    results.push({
      id: "sandbox:network",
      status: "warn",
      observed: "Seatbelt cannot scope network by host",
      expected: "network egress via the runmill proxy",
      remediation: "workspace.network must be `proxy` on macOS; `none` is all-or-nothing",
    });

    return results;
  }

  // Linux
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

  const userns = await tryRun("bwrap", ["--dev-bind", "/", "/", "true"]);
  return [
    {
      id: "sandbox:mechanism",
      status: "pass",
      observed: bwrap.out,
      expected: "bubblewrap available",
    },
    {
      id: "sandbox:userns",
      status: userns.ok ? "pass" : "fail",
      code: userns.ok ? undefined : "RM-SANDBOX-001",
      observed: userns.ok ? "user namespaces usable" : userns.out.split("\n")[0] ?? "unavailable",
      expected: "unprivileged user namespaces enabled",
      remediation: userns.ok
        ? undefined
        : "sudo sysctl -w kernel.unprivileged_userns_clone=1",
    },
  ];
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
  providerImplementation = "codex",
): Promise<CheckResult[]> {
  // Every probe is independent, so wall time is the slowest one rather than
  // the sum. Promise.all preserves order, so the rendered output is identical.
  const [git, repository, github, provider, sandbox] = await Promise.all([
    checkGit(),
    checkRepository(ctx),
    checkGitHubCli(),
    checkProvider(providerImplementation),
    checkSandbox(),
  ]);
  return [checkCiEnvironment(), git, repository, github, provider, ...sandbox];
}

export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
