/**
 * Host checks.
 *
 * These decide whether a run is allowed to start at all, so the interesting
 * cases are the ones where a check could wrongly report success — a missing
 * binary read as present, a sandbox assumed rather than proven, an unsupported
 * platform sailing through.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkGit,
  checkGitProvenance,
  checkRepository,
  checkRemote,
  checkConfiguration,
  checkVerificationDependencies,
  checkVerificationPolicy,
  checkGitHubCredential,
  checkLinearCredential,
  checkProvider,
  checkProviderExecution,
  checkProviderCredentialIsolation,
  checkSandbox,
  checkCiEnvironment,
  runAllChecks,
  worstStatus,
} from "../../src/doctor/checks.js";
import type { ProviderDoctorAdapter } from "../../src/doctor/checks.js";

let dir: string;

function writeInstalledNodeProject(
  options: { stale?: boolean; install?: boolean; version?: string } = {},
): void {
  const version = options.version ?? "1.0.0";
  const installedVersion = options.stale === true ? "2.0.0" : version;
  const lock = {
    name: "doctor-fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "doctor-fixture", dependencies: { tiny: version } },
      "node_modules/tiny": { version, integrity: "sha512-fixture" },
    },
  };
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "doctor-fixture", dependencies: { tiny: version } })}\n`,
  );
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(lock)}\n`);
  if (options.install === false) return;

  mkdirSync(join(dir, "node_modules/tiny"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules/tiny/package.json"),
    `${JSON.stringify({ name: "tiny", version: installedVersion })}\n`,
  );
  writeFileSync(
    join(dir, "node_modules/.package-lock.json"),
    `${JSON.stringify({
      name: "doctor-fixture",
      lockfileVersion: 3,
      packages: {
        "node_modules/tiny": {
          version: installedVersion,
          integrity: "sha512-fixture",
        },
      },
    })}\n`,
  );
}

function fakeProvider(
  options: {
    installed?: boolean;
    authenticated?: boolean;
    executed?: boolean;
  } = {},
): ProviderDoctorAdapter {
  return {
    detect: async () => ({
      installed: options.installed !== false,
      version: options.installed === false ? undefined : "fake-cli 1.0.0",
    }),
    sandboxAuthStatus: async () => ({
      authenticated: options.authenticated !== false,
      detail: options.authenticated === false ? "authentication failed inside sandbox" : undefined,
    }),
    sandboxExecutionStatus: async () => ({
      executed: options.executed !== false,
      detail: options.executed === false
        ? "minimal request failed inside sandbox (failure; auth)"
        : "one-turn provider request completed inside sandbox (small, potentially billable token usage)",
    }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkGit", () => {
  it("passes on a host with git and reports the version it found", async () => {
    const r = await checkGit();
    expect(r.id).toBe("git");
    expect(r.status).toBe("pass");
    expect(r.observed).toMatch(/git version/);
  });
});

describe("checkGitProvenance", () => {
  function configureIdentity(name = "Verified Operator", email = "operator@example.com"): void {
    execFileSync("git", ["config", "--local", "user.name", name], { cwd: dir });
    execFileSync("git", ["config", "--local", "user.email", email], { cwd: dir });
  }

  beforeEach(() => {
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
  });

  it("creates a disposable candidate with the source checkout identity", async () => {
    configureIdentity();
    execFileSync("git", ["config", "--local", "commit.gpgSign", "false"], { cwd: dir });

    const result = await checkGitProvenance({ repoRoot: dir });

    expect(result).toMatchObject({ id: "git:provenance", status: "pass" });
    expect(result.observed).toContain("Verified Operator <operator@example.com>");
    expect(result.observed).toMatch(/signing is not required/i);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  it("refuses the placeholder identity before a first run", async () => {
    configureIdentity("runmill", "runmill@localhost");

    const result = await checkGitProvenance({ repoRoot: dir });

    expect(result).toMatchObject({
      id: "git:provenance",
      status: "fail",
      code: "RM-WORKSPACE-004",
    });
    expect(result.observed).toMatch(/runmill@localhost/);
    expect(result.remediation).toContain("git:provenance");
  });

  it("proves configured SSH signing with a real signature", async () => {
    configureIdentity();
    const key = join(dir, "operator-signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    execFileSync("git", ["config", "--local", "commit.gpgSign", "true"], { cwd: dir });
    execFileSync("git", ["config", "--local", "gpg.format", "ssh"], { cwd: dir });
    execFileSync("git", ["config", "--local", "gpg.ssh.program", "ssh-keygen"], { cwd: dir });
    execFileSync("git", ["config", "--local", "user.signingKey", key], { cwd: dir });

    const result = await checkGitProvenance({ repoRoot: dir });

    expect(result.status).toBe("pass");
    expect(result.observed).toMatch(/ssh-signed candidate commit created/i);
  });

  it("fails when signing is configured but its key is unavailable", async () => {
    configureIdentity();
    execFileSync("git", ["config", "--local", "commit.gpgSign", "true"], { cwd: dir });
    execFileSync("git", ["config", "--local", "gpg.format", "ssh"], { cwd: dir });
    execFileSync("git", ["config", "--local", "gpg.ssh.program", "ssh-keygen"], { cwd: dir });
    execFileSync("git", ["config", "--local", "user.signingKey", join(dir, "missing-key")], {
      cwd: dir,
    });

    const result = await checkGitProvenance({ repoRoot: dir });

    expect(result).toMatchObject({ status: "fail", code: "RM-WORKSPACE-004" });
    expect(result.observed).toMatch(/signing could not create/i);
    expect(result.observed).not.toContain(dir);
  });

  it("removes its disposable repository after both success and refusal", async () => {
    configureIdentity();
    const before = (await import("node:fs")).readdirSync(tmpdir()).filter((name) =>
      name.startsWith("runmill-git-provenance-"),
    );

    await checkGitProvenance({ repoRoot: dir });
    execFileSync("git", ["config", "--local", "user.email", "runmill@localhost"], { cwd: dir });
    await checkGitProvenance({ repoRoot: dir });

    const after = (await import("node:fs")).readdirSync(tmpdir()).filter((name) =>
      name.startsWith("runmill-git-provenance-"),
    );
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});

describe("checkRemote", () => {
  /**
   * The first thing a run does is `git ls-remote origin` to take the issue
   * lease. Without a remote that fails deep inside the daemon, as a raw git
   * message, after the run is already claimed — and one quarantine is enough to
   * trip the breaker. doctor is the place to say so, before any of that.
   */
  it("fails when the repository has no origin remote", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.id).toBe("repository:remote");
    expect(r.status).toBe("fail");
    expect(r.observed).toContain("no origin remote");
  });

  it("names the command that fixes it", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.remediation).toContain("git remote add origin");
  });

  it("explains that leases live on the remote, not just that a remote is missing", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.expected).toMatch(/lease/i);
  });

  it("reports the remote url when one is configured", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/acme/x.git"], {
      cwd: dir,
    });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.observed).toContain("https://example.invalid/acme/x.git");
  });

  it("never prints credentials embedded in an origin URL", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://alice:ghp_SYNTHETIC_SECRET@example.invalid/acme/x.git"],
      { cwd: dir },
    );

    const r = await checkRemote({ repoRoot: dir });
    expect(r.observed).not.toContain("ghp_SYNTHETIC_SECRET");
    expect(r.observed).toContain("<redacted>@example.invalid");
  });

  it("does not fail the check merely because the remote is unreachable", async () => {
    // doctor runs on laptops, planes, and locked-down networks. An unreachable
    // remote is worth flagging, but it is not the same defect as not having
    // configured one at all, and it must not be reported as if it were.
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/acme/x.git"], {
      cwd: dir,
    });

    const r = await checkRemote({ repoRoot: dir });

    expect(r.status).not.toBe("fail");
  });

  it("cannot block forever on a remote that wants to ask a question", async () => {
    // `doctor` is what an operator runs when something is already wrong, often
    // against a remote whose credential has expired. git would happily sit on
    // a username prompt or an unknown-host prompt forever, and a diagnostic
    // command that hangs is worse than one that reports a failure.
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://user@10.255.255.1/private.git"],
      { cwd: dir },
    );

    const started = Date.now();
    const r = await checkRemote({ repoRoot: dir });

    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.status).not.toBe("pass");
  }, 30_000);

  it("is part of the standard doctor run", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const results = await runAllChecks(
      { repoRoot: dir, providerAdapterFactory: () => fakeProvider() },
      ["codex"],
    );

    expect(results.map((c) => c.id)).toContain("repository:remote");
  });
});

describe("checkRepository", () => {
  it("reports the repository root when inside one", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const r = await checkRepository({ repoRoot: dir });
    expect(r.status).toBe("pass");
    // macOS symlinks /var to /private/var, so compare on the basename.
    expect(r.observed).toContain(dir.split("/").pop() as string);
  });

  it("fails outside a repository rather than assuming the cwd will do", async () => {
    const r = await checkRepository({ repoRoot: tmpdir() });
    // tmpdir is not a repository on any supported platform.
    if (r.status === "pass") {
      // Someone has a repo at tmpdir; the assertion would be meaningless.
      expect(r.observed).toBeTruthy();
      return;
    }
    expect(r.status).toBe("fail");
    expect(r.observed).toBe("not a git repository");
    expect(r.remediation).toMatch(/git repository/);
  });
});

describe("checkConfiguration", () => {
  it("fails when the operator policy is missing", () => {
    const result = checkConfiguration({
      repoRoot: dir,
      configPath: join(dir, "missing-policy.yaml"),
    });
    expect(result.status).toBe("fail");
    expect(result.code).toBe("RM-CONFIG-003");
    expect(result.remediation).toBe("runmill config validate");
  });

  it("passes a valid operator policy", () => {
    const path = join(dir, "policy.yaml");
    const quickstart = readFileSync(join(process.cwd(), "examples", "quickstart", "runmill.yaml"), "utf8");
    writeFileSync(path, quickstart);
    const result = checkConfiguration({ repoRoot: dir, configPath: path });
    expect(result.status).toBe("pass");
    expect(result.observed).toBe(path);
  });
});

describe("checkVerificationPolicy", () => {
  it("fails closed when setup could not infer any project check", () => {
    const path = join(dir, "policy.yaml");
    const quickstart = readFileSync(
      join(process.cwd(), "examples", "quickstart", "runmill.yaml"),
      "utf8",
    );
    writeFileSync(
      path,
      quickstart.replace(
        /\n# This fixture has no application[\s\S]*$/u,
        "\nverification:\n  commands: []\n",
      ),
    );
    mkdirSync(join(dir, ".runmill"), { recursive: true });
    writeFileSync(join(dir, ".runmill/checks.yaml"), "checks: []\n");

    const result = checkVerificationPolicy({ repoRoot: dir, configPath: path });

    expect(result).toMatchObject({
      id: "verification",
      status: "fail",
      code: "RM-VERIFY-001",
    });
    expect(result.observed).toMatch(/declares no checks/i);
    expect(result.remediation).toContain("checks.yaml");
  });

  it("passes only after a real command is declared", () => {
    const path = join(dir, "policy.yaml");
    const quickstart = readFileSync(
      join(process.cwd(), "examples", "quickstart", "runmill.yaml"),
      "utf8",
    );
    writeFileSync(path, quickstart);
    mkdirSync(join(dir, ".runmill"), { recursive: true });
    writeFileSync(
      join(dir, ".runmill/checks.yaml"),
      "checks:\n  - id: unit\n    run: npm test\n",
    );

    const result = checkVerificationPolicy({ repoRoot: dir, configPath: path });

    expect(result.status).toBe("pass");
    expect(result.observed).toContain("unit");
  });
});

describe("checkVerificationDependencies", () => {
  function configureRemoteProject(): { policy: string; origin: string } {
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    execFileSync("git", ["config", "user.email", "doctor@test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Doctor"], { cwd: dir });
    writeInstalledNodeProject();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\norigin.git/\nupdater/\n");
    mkdirSync(join(dir, ".runmill"), { recursive: true });
    writeFileSync(
      join(dir, ".runmill/checks.yaml"),
      "checks:\n  - id: unit\n    run: npm test\n",
    );
    execFileSync(
      "git",
      ["add", "package.json", "package-lock.json", ".gitignore", ".runmill/checks.yaml"],
      { cwd: dir },
    );
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });

    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });

    const policy = join(dir, "policy.yaml");
    writeFileSync(
      policy,
      readFileSync(join(process.cwd(), "examples", "quickstart", "runmill.yaml"), "utf8"),
    );
    return { policy, origin };
  }

  const exactRemoteContext = (policy: string) => ({
    repoRoot: dir,
    configPath: policy,
    repositoryIdentity: async () => "acme/platform",
    credentials: { get: async () => undefined },
  });

  it("passes a lockfile-matching npm install without creating cache state", async () => {
    writeInstalledNodeProject();
    const before = readFileSync(join(dir, "node_modules/.package-lock.json"), "utf8");

    const result = await checkVerificationDependencies({ repoRoot: dir });

    expect(result).toMatchObject({
      id: "verification:dependencies",
      status: "pass",
    });
    expect(readFileSync(join(dir, "node_modules/.package-lock.json"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toContain("doctor-fixture");
  });

  it("fails before claim when a locked npm project has no installed tree", async () => {
    writeInstalledNodeProject({ install: false });

    const result = await checkVerificationDependencies({ repoRoot: dir });

    expect(result).toMatchObject({
      id: "verification:dependencies",
      status: "fail",
      code: "RM-VERIFY-005",
    });
    expect(result.observed).toMatch(/no npm-installed node_modules tree/i);
    expect(result.remediation).toContain("npm ci");
  });

  it("fails before claim when node_modules is stale for the committed lock", async () => {
    writeInstalledNodeProject({ stale: true });

    const result = await checkVerificationDependencies({ repoRoot: dir });

    expect(result).toMatchObject({
      id: "verification:dependencies",
      status: "fail",
      code: "RM-VERIFY-005",
    });
    expect(result.observed).toMatch(/does not match package-lock\.json/i);
  });

  it("refuses a locally ahead install that does not match the freshly fetched base", async () => {
    const { policy } = configureRemoteProject();
    const remoteBase = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    writeInstalledNodeProject({ version: "2.0.0" });
    execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "local ahead"], { cwd: dir });

    const result = await checkVerificationDependencies(exactRemoteContext(policy));

    expect(result).toMatchObject({ status: "fail", code: "RM-VERIFY-005" });
    expect(result.observed).toMatch(/differ from the exact base commit/i);
    expect(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: dir, encoding: "utf8" }).trim())
      .not.toBe(remoteBase);
    expect(execFileSync("git", ["rev-parse", "origin/main"], { cwd: dir, encoding: "utf8" }).trim())
      .toBe(remoteBase);
  });

  it("refuses a locally stale install after the configured remote base advances", async () => {
    const { policy, origin } = configureRemoteProject();
    const updater = join(dir, "updater");
    execFileSync("git", ["clone", "-q", origin, updater]);
    execFileSync("git", ["config", "user.email", "remote@test"], { cwd: updater });
    execFileSync("git", ["config", "user.name", "Remote"], { cwd: updater });
    writeFileSync(
      join(updater, "package.json"),
      readFileSync(join(updater, "package.json"), "utf8").replaceAll("1.0.0", "2.0.0"),
    );
    writeFileSync(
      join(updater, "package-lock.json"),
      readFileSync(join(updater, "package-lock.json"), "utf8").replaceAll("1.0.0", "2.0.0"),
    );
    execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: updater });
    execFileSync("git", ["commit", "-q", "-m", "remote advances"], { cwd: updater });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: updater });
    const remoteBase = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: updater,
      encoding: "utf8",
    }).trim();

    const result = await checkVerificationDependencies(exactRemoteContext(policy));

    expect(result).toMatchObject({ status: "fail", code: "RM-VERIFY-005" });
    expect(result.observed).toMatch(/differ from the exact base commit/i);
    expect(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: dir, encoding: "utf8" }).trim())
      .not.toBe(remoteBase);
    const fetchedBases = execFileSync(
      "git",
      ["for-each-ref", "--format=%(objectname)", "refs/runmill/bases"],
      { cwd: dir, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(fetchedBases).toContain(remoteBase);
  });
});

describe("checkProvider", () => {
  it("refuses an unknown implementation instead of quietly probing codex", async () => {
    // Anything that was not exactly "claude" fell through to codex, so a typo
    // in runmill.yaml produced a PASSING check for a provider nobody chose.
    const r = await checkProvider("cluade");
    expect(r.status).toBe("fail");
    expect(r.observed).toMatch(/unknown provider/);
    expect(r.remediation).toBe("runmill config validate");
  });

  it("distinguishes a missing provider from auth that fails inside the sandbox", async () => {
    // Installation is only the first gate. A provider present on PATH can
    // still be unusable when its credentials are outside Runmill's sandbox.
    const r = await checkProvider("claude", fakeProvider({ installed: false }));
    expect(r.id).toBe("provider:claude");
    expect(r.status).toBe("fail");
    expect(r.observed).toMatch(/not found/i);
    expect(r.remediation).toMatch(/Install/);
  });

  it("names the provider in the check id, so --check can target it", async () => {
    const r = await checkProvider("claude", fakeProvider());
    expect(r.id).toBe("provider:claude");
  });

  it("does not mistake authenticated status for a working provider request", async () => {
    const adapter = fakeProvider({ authenticated: true, executed: false });
    expect((await checkProvider("codex", adapter)).status).toBe("pass");

    const execution = await checkProviderExecution("codex", adapter);
    expect(execution.id).toBe("provider:codex:request");
    expect(execution.status).toBe("fail");
    expect(execution.observed).toMatch(/minimal request failed/);
  });

  it("reports a completed one-turn sandbox request independently from auth", async () => {
    const execution = await checkProviderExecution("codex", fakeProvider());
    expect(execution.status).toBe("pass");
    expect(execution.observed).toMatch(/one-turn provider request/);
  });

  it("does not spend a provider request after installation or authentication fails", async () => {
    let requests = 0;
    const adapter = fakeProvider({ authenticated: false });
    const guarded: ProviderDoctorAdapter = {
      ...adapter,
      sandboxExecutionStatus: async () => {
        requests += 1;
        return adapter.sandboxExecutionStatus();
      },
    };
    execFileSync("git", ["init", "-q", "."], { cwd: dir });

    const results = await runAllChecks(
      { repoRoot: dir, providerAdapterFactory: () => guarded },
      "codex",
    );

    expect(results.find((result) => result.id === "provider:codex")?.status).toBe("fail");
    expect(results.some((result) => result.id === "provider:codex:request")).toBe(false);
    expect(requests).toBe(0);
  }, 60_000);
});

describe("service credentials", () => {
  function writePolicy(): string {
    const path = join(dir, "policy.yaml");
    writeFileSync(
      path,
      readFileSync(join(process.cwd(), "examples", "quickstart", "runmill.yaml"), "utf8"),
    );
    return path;
  }

  function linearWorkflowResponse(
    states: readonly string[],
    team: string | null = "ENG",
  ): Response {
    return Response.json({
      data: {
        viewer: { id: "viewer-1" },
        teams: {
          nodes:
            team === null
              ? []
              : [
                  {
                    id: "team-1",
                    key: team,
                    states: {
                      nodes: states.map((name) => ({ name })),
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
          pageInfo: { hasNextPage: false },
        },
      },
    });
  }

  it("proves the resolved token against the exact configured repository and base branch", async () => {
    const seen: string[] = [];
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer stored-github-token");
      const url = String(input);
      seen.push(url);
      if (url === "https://api.github.com/repos/acme/platform") {
        return Response.json({ permissions: { push: true } });
      }
      if (url === "https://api.github.com/repos/acme/platform/branches/main") {
        return Response.json({ name: "main" });
      }
      return new Response("not found", { status: 404 });
    };
    const result = await checkGitHubCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async (name) => (name === "github" ? "stored-github-token" : undefined) },
      request,
    });
    expect(result.status).toBe("pass");
    expect(seen).toEqual([
      "https://api.github.com/repos/acme/platform",
      "https://api.github.com/repos/acme/platform/branches/main",
    ]);
    expect(seen).not.toContain("https://api.github.com/user");
  });

  it("fails closed when the configured repository does not report push permission", async () => {
    const result = await checkGitHubCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async () => "read-only-github-token" },
      request: async () => Response.json({ permissions: { push: false } }),
    });

    expect(result).toMatchObject({ status: "fail", code: "RM-AUTH-003" });
    expect(result.observed).toMatch(/does not report push permission/);
  });

  it("fails closed when the configured base branch cannot be read", async () => {
    let requests = 0;
    const result = await checkGitHubCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async () => "wrong-repository-token" },
      request: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ permissions: { push: true } })
          : new Response("not found", { status: 404 });
      },
    });

    expect(result).toMatchObject({ status: "fail", code: "RM-AUTH-003" });
    expect(result.observed).toMatch(/base branch main could not be read/);
  });

  it("refuses to substitute a generic user probe when no policy is supplied", async () => {
    let requests = 0;
    const result = await checkGitHubCredential({
      repoRoot: dir,
      credentials: { get: async () => "stored-github-token" },
      request: async () => {
        requests += 1;
        return Response.json({ login: "someone" });
      },
    });

    expect(result.status).toBe("fail");
    expect(requests).toBe(0);
    expect(result.observed).toMatch(/repository access was not guessed/);
  });

  it("fails when the exact Linear token is expired instead of passing on its presence", async () => {
    const result = await checkLinearCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async (name) => (name === "linear" ? "expired-linear-token" : undefined) },
      request: async () => new Response('{"errors":[{"message":"Authentication required"}]}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });
    expect(result.status).toBe("fail");
    expect(result.code).toBe("RM-AUTH-003");
  });

  it("proves the exact configured Linear team and every lifecycle state", async () => {
    let requestBody: unknown;
    const result = await checkLinearCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async (name) => (name === "linear" ? "linear-token" : undefined) },
      request: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return linearWorkflowResponse(["Todo", "Ready", "In Progress", "In Review", "Done"]);
      },
    });

    expect(result).toMatchObject({ id: "linear-auth", status: "pass" });
    expect(requestBody).toMatchObject({ variables: { teamKey: "ENG" } });
    expect(JSON.stringify(requestBody)).not.toContain("linear-token");
  });

  it("fails when the configured Linear team does not exist", async () => {
    const result = await checkLinearCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async () => "linear-token" },
      request: async () => linearWorkflowResponse([], null),
    });

    expect(result).toMatchObject({ status: "fail", code: "RM-CONFIG-001" });
    expect(result.observed).toMatch(/team "ENG" does not resolve uniquely/);
  });

  it("fails when any configured Linear state is absent from that team", async () => {
    const result = await checkLinearCredential({
      repoRoot: dir,
      configPath: writePolicy(),
      credentials: { get: async () => "linear-token" },
      request: async () => linearWorkflowResponse(["Todo", "Ready", "In Progress", "Done"]),
    });

    expect(result).toMatchObject({ status: "fail", code: "RM-CONFIG-001" });
    expect(result.observed).toMatch(/missing configured state: In Review/);
  });

  it("does not guess a Linear team when doctor has no policy", async () => {
    let requests = 0;
    const result = await checkLinearCredential({
      repoRoot: dir,
      credentials: { get: async () => "linear-token" },
      request: async () => {
        requests += 1;
        return linearWorkflowResponse([]);
      },
    });

    expect(result).toMatchObject({ status: "fail", code: "RM-CONFIG-001" });
    expect(result.observed).toMatch(/workflow were not guessed/);
    expect(requests).toBe(0);
  });
});

describe("provider credential isolation", () => {
  it("does not call sandbox authentication proof credential isolation", () => {
    const result = checkProviderCredentialIsolation("codex");
    expect(result.status).toBe("warn");
    expect(result.observed).toMatch(/tool subprocesses/);
    expect(result.remediation).toMatch(/credential broker/);
  });
});

describe("checkCiEnvironment", () => {
  const original = process.env["CI"];
  afterEach(() => {
    if (original === undefined) delete process.env["CI"];
    else process.env["CI"] = original;
  });

  it("fails under CI, because runmill is local-first in this release", () => {
    process.env["CI"] = "true";
    const r = checkCiEnvironment();
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/local-first/);
  });

  it("passes on an interactive host", () => {
    delete process.env["CI"];
    expect(checkCiEnvironment().status).toBe("pass");
  });

  it("treats CI=1 the same as CI=true", () => {
    process.env["CI"] = "1";
    expect(checkCiEnvironment().status).toBe("fail");
  });

  it("does not treat an arbitrary CI value as CI", () => {
    process.env["CI"] = "false";
    expect(checkCiEnvironment().status).toBe("pass");
  });
});

describe("checkSandbox", () => {
  it("reports a mechanism appropriate to this platform", async () => {
    const results = await checkSandbox();
    const mechanism = results.find((r) => r.id === "sandbox:mechanism");
    expect(mechanism).toBeDefined();
    if (platform() === "darwin") {
      expect(mechanism?.observed).toMatch(/Seatbelt/);
    } else if (platform() === "linux") {
      expect(mechanism?.observed).toMatch(/bubblewrap/);
    } else {
      expect(mechanism?.status).toBe("fail");
    }
  }, 30_000);

  it("PROVES credential denial on every supported platform", async () => {
    // This probe only existed on the macOS path, so on Linux doctor asked
    // whether a sandbox existed — exactly what it claims not to do.
    if (platform() !== "darwin" && platform() !== "linux") return;
    const results = await checkSandbox();
    const probe = results.find((r) => r.id === "sandbox:deny-credential-read");
    expect(probe, "no credential-denial probe ran").toBeDefined();
    expect(probe?.status).toBe("pass");
    expect(probe?.observed).toBe("read denied");
  }, 30_000);

  it("does not leave its probe secret behind", async () => {
    await checkSandbox();
    const leftovers = (await import("node:fs")).readdirSync(tmpdir());
    expect(leftovers.filter((f) => f.startsWith("runmill-probe-home-"))).toEqual([]);
  }, 30_000);

  it("surfaces unrestricted provider egress on every supported platform", async () => {
    if (platform() !== "darwin" && platform() !== "linux") return;
    const results = await checkSandbox();
    const network = results.find((r) => r.id === "sandbox:network");
    expect(network?.status).toBe("warn");
    expect(network?.observed).toMatch(/unrestricted/);
    expect(network?.remediation).toMatch(/proxy/);
  }, 30_000);

  it("checks user namespaces on Linux, where the sandbox depends on them", async () => {
    if (platform() !== "linux") return;
    const results = await checkSandbox();
    expect(results.some((r) => r.id === "sandbox:userns")).toBe(true);
  }, 30_000);
});

describe("runAllChecks", () => {
  it("returns the environment check first, then the host and sandbox checks", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks({
      repoRoot: dir,
      providerAdapterFactory: () => fakeProvider(),
    });
    expect(results[0]?.id).toBe("environment");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("git");
    expect(ids).toContain("git:provenance");
    expect(ids).toContain("repository");
    expect(ids).toContain("verification:dependencies");
    expect(ids).toContain("github-auth");
    expect(ids.some((i) => i.startsWith("provider:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("sandbox:"))).toBe(true);
  }, 60_000);

  it("honours the configured provider implementation", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks(
      { repoRoot: dir, providerAdapterFactory: () => fakeProvider() },
      "claude",
    );
    expect(results.some((r) => r.id === "provider:claude")).toBe(true);
    expect(results.some((r) => r.id === "provider:claude:request")).toBe(true);
  }, 60_000);

  it("does not dispatch a billable provider request for an unrelated scoped check", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    let providerFactories = 0;
    const results = await runAllChecks({
      repoRoot: dir,
      checkPrefix: "sandbox",
      providerAdapterFactory: () => {
        providerFactories += 1;
        return fakeProvider();
      },
    });

    expect(providerFactories).toBe(0);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.id.startsWith("sandbox"))).toBe(true);
  }, 60_000);

  it("probes an independently configured reviewer as well as the implementer", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const results = await runAllChecks(
      { repoRoot: dir, providerAdapterFactory: () => fakeProvider() },
      ["codex", "claude"],
    );
    expect(results.some((r) => r.id === "provider:codex")).toBe(true);
    expect(results.some((r) => r.id === "provider:claude")).toBe(true);
    expect(results.some((r) => r.id === "provider:codex:request")).toBe(true);
    expect(results.some((r) => r.id === "provider:claude:request")).toBe(true);
  }, 60_000);

  it("probes each distinct configured model rather than only the provider binary", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const targets: string[] = [];
    const results = await runAllChecks(
      {
        repoRoot: dir,
        providerAdapterFactory: (target) => {
          targets.push(`${target.implementation}:${target.model ?? "default"}`);
          return fakeProvider();
        },
      },
      [
        { implementation: "codex", model: "fast" },
        { implementation: "codex", model: "review" },
      ],
    );

    expect(targets).toEqual(["codex:fast", "codex:review"]);
    expect(results.some((result) => result.id === "provider:codex:fast:request")).toBe(true);
    expect(results.some((result) => result.id === "provider:codex:review:request")).toBe(true);
  }, 60_000);

  it("gives every check a unique id, so --check <id> is unambiguous", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    const ids = (await runAllChecks({
      repoRoot: dir,
      providerAdapterFactory: () => fakeProvider(),
    })).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);
});

describe("worstStatus", () => {
  it("is fail if anything failed", () => {
    expect(
      worstStatus([
        { id: "a", status: "pass", observed: "", expected: "" },
        { id: "b", status: "warn", observed: "", expected: "" },
        { id: "c", status: "fail", observed: "", expected: "" },
      ]),
    ).toBe("fail");
  });

  it("is warn when there are warnings but no failures", () => {
    expect(
      worstStatus([
        { id: "a", status: "pass", observed: "", expected: "" },
        { id: "b", status: "warn", observed: "", expected: "" },
      ]),
    ).toBe("warn");
  });

  it("is pass only when everything passed", () => {
    expect(worstStatus([{ id: "a", status: "pass", observed: "", expected: "" }])).toBe("pass");
  });

  it("is pass for an empty list, which callers must not treat as verified", () => {
    // `doctor --check <unknown>` once matched nothing and reported PASS, telling
    // a developer their setup was fine when nothing had been checked. The fix
    // lives in the CLI, which refuses an empty match; this documents that
    // worstStatus alone cannot carry that meaning.
    expect(worstStatus([])).toBe("pass");
  });
});

describe("a check that plants files cleans up after itself", () => {
  it("leaves no runmill-probe directories in tmp", async () => {
    // Guards against the probe leaking a directory per doctor invocation.
    const before = (await import("node:fs")).readdirSync(tmpdir()).filter((f) => f.startsWith("runmill-probe"));
    await checkSandbox();
    const after = (await import("node:fs")).readdirSync(tmpdir()).filter((f) => f.startsWith("runmill-probe"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  }, 30_000);
});

describe("DoctorContext with a config path", () => {
  it("accepts an explicit config path without failing the repository check", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "runmill.yaml"), "version: 1\n");
    const r = await checkRepository({ repoRoot: dir, configPath: join(dir, "runmill.yaml") });
    expect(r.status).toBe("pass");
  });
});
