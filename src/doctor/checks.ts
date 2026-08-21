import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../platform/process.js";
import { Sandbox, detectMechanism } from "../workspace/sandbox.js";
import { CLAUDE_DIALECT, CODEX_DIALECT, CliProviderAdapter } from "../agent/cli-provider.js";
import type { AuthStatus, ProviderInstallation } from "../agent/adapter.js";
import type { ProviderExecutionStatus } from "../agent/cli-provider.js";
import { loadConfig } from "../config/load.js";
import { RunmillError, errorMessage } from "../errors/runmill-error.js";
import { loadChecksManifest } from "../verification/manifest.js";
import { CredentialStore, type CredentialName } from "../credentials/store.js";
import { validateInstalledDependencies } from "../workspace/dependencies.js";
import { GitHubGitCredential } from "../platform/github-git-credential.js";
import { repositoryIdentity as resolveRepositoryIdentity } from "../workspace/repository-identity.js";
import {
  fetchTrustedBase as fetchRemoteTrustedBase,
  type TrustedBase,
} from "../workspace/manager.js";
import {
  createCandidateCommit,
  git as runGit,
  resolveCandidateCommitProvenance,
  type CandidateCommitProvenance,
} from "../platform/git.js";

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
  readonly backlogProvider?: "linear" | undefined;
  /** Injectable boundaries keep credential probes deterministic in tests. */
  readonly credentials?: Pick<CredentialStore, "get"> | undefined;
  readonly request?: typeof fetch | undefined;
  /** Tests can bind local remotes without weakening the production identity proof. */
  readonly repositoryIdentity?: ((repoRoot: string) => Promise<string | undefined>) | undefined;
  readonly fetchTrustedBase?:
    | ((
        sourceRepo: string,
        baseBranch: string,
        remote?: string,
        credential?: GitHubGitCredential,
      ) => Promise<TrustedBase>)
    | undefined;
  /** Avoid running (and charging for) checks outside a scoped doctor request. */
  readonly checkPrefix?: string | undefined;
  /** Tests inject local fakes so readiness never dispatches a real model request. */
  readonly providerAdapterFactory?:
    | ((target: ProviderCheckTarget) => ProviderDoctorAdapter)
    | undefined;
}

export interface ProviderCheckTarget {
  readonly implementation: string;
  /** Undefined means the provider CLI's default model. */
  readonly model?: string | undefined;
}

/** The CLI-only proofs doctor needs beyond the runtime adapter contract. */
export interface ProviderDoctorAdapter {
  detect(): Promise<ProviderInstallation>;
  sandboxAuthStatus(): Promise<AuthStatus>;
  sandboxExecutionStatus(): Promise<ProviderExecutionStatus>;
}

export function checkConfiguration(ctx: DoctorContext): CheckResult {
  if (ctx.configPath === undefined) {
    return {
      id: "configuration",
      status: "fail",
      code: "RM-CONFIG-003",
      observed: "no operator-policy path supplied",
      expected: "an existing, valid operator policy",
      remediation: "runmill init",
    };
  }
  try {
    loadConfig(ctx.configPath, { repoRoot: ctx.repoRoot });
    return {
      id: "configuration",
      status: "pass",
      observed: ctx.configPath,
      expected: "an existing, valid operator policy",
    };
  } catch (error) {
    return {
      id: "configuration",
      status: "fail",
      code: error instanceof RunmillError ? error.code : "RM-CONFIG-001",
      observed: errorMessage(error).split("\n")[0] ?? "configuration invalid",
      expected: "an existing, valid operator policy",
      remediation: "runmill config validate",
    };
  }
}

/** A valid policy with no executable checks is not ready to deliver code. */
export function checkVerificationPolicy(ctx: DoctorContext): CheckResult {
  const expected = "at least one explicit local verification command";
  if (ctx.configPath === undefined) {
    return {
      id: "verification",
      status: "fail",
      code: "RM-VERIFY-001",
      observed: "no operator-policy path supplied",
      expected,
      remediation: "runmill init",
    };
  }
  try {
    const config = loadConfig(ctx.configPath, { repoRoot: ctx.repoRoot }).config;
    const manifest = loadChecksManifest({
      repoRoot: ctx.repoRoot,
      manifestPath: config.verification.manifest,
    });
    const ids = new Set([
      ...config.verification.commands.map((check) => check.id),
      ...(manifest?.checks.map((check) => check.id) ?? []),
    ]);
    if (ids.size === 0) {
      return {
        id: "verification",
        status: "fail",
        code: "RM-VERIFY-001",
        observed: `${config.verification.manifest} declares no checks`,
        expected,
        remediation:
          `Add the repository's real commands to ${config.verification.manifest}, then run ` +
          "`runmill doctor --check verification`",
      };
    }
    return {
      id: "verification",
      status: "pass",
      observed: `${ids.size} explicit check${ids.size === 1 ? "" : "s"}: ${[...ids].join(", ")}`,
      expected,
    };
  } catch (error) {
    return {
      id: "verification",
      status: "fail",
      code: error instanceof RunmillError ? error.code : "RM-VERIFY-004",
      observed: errorMessage(error).split("\n")[0] ?? "verification policy is invalid",
      expected,
      remediation: "runmill config validate",
    };
  }
}

async function checkoutTrustedCommit(repoRoot: string, commit: string): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "runmill-doctor-base-"));
  const checkout = join(parent, "checkout");
  try {
    // Keep this aligned with WorkspaceManager: a self-contained local clone,
    // then an exact detached checkout of the fetched commit.
    await runGit(repoRoot, [
      "clone",
      "--no-hardlinks",
      "--quiet",
      "--no-checkout",
      repoRoot,
      checkout,
    ]);
    await runGit(checkout, ["checkout", "--quiet", "--detach", commit]);
    return checkout;
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

/** Prove locked dependencies are ready before an issue can be claimed. */
export async function checkVerificationDependencies(ctx: DoctorContext): Promise<CheckResult> {
  const expected =
    "an npm-installed dependency tree matching the freshly fetched exact remote base";
  const check = (
    trustedCheckout: string,
  ): ReturnType<typeof validateInstalledDependencies> =>
    validateInstalledDependencies({
      trustedCheckout,
      installedSource: ctx.repoRoot,
    });
  try {
    // The standalone function remains useful to init embedders that have not
    // supplied a policy yet. Normal doctor/init calls always have configPath
    // and take the exact-remote path below.
    if (ctx.configPath === undefined) {
      const dependencies = check(ctx.repoRoot);
      return dependencies === undefined
        ? {
            id: "verification:dependencies",
            status: "pass",
            observed: "no package-lock.json; no npm dependency tree needs materialization",
            expected,
          }
        : {
            id: "verification:dependencies",
            status: "pass",
            observed: `npm dependencies match the local committed lockfile (${dependencies.identity.slice(0, 12)})`,
            expected,
          };
    }

    const config = loadConfig(ctx.configPath, { repoRoot: ctx.repoRoot }).config;
    const identity = await (ctx.repositoryIdentity ?? resolveRepositoryIdentity)(ctx.repoRoot);
    if (identity === undefined) {
      throw RunmillError.fromCatalog("RM-VERIFY-005", {
        whatHappened:
          "the source origin is not a GitHub owner/name repository, so doctor cannot bind " +
          "dependency readiness to the base a live workspace will fetch",
      });
    }
    const targets = [
      ...new Map(
        config.github.repositories
          .filter((target) => target.repo.toLowerCase() === identity.toLowerCase())
          .map((target) => [target.baseBranch, target] as const),
      ).values(),
    ];
    if (targets.length === 0) {
      throw RunmillError.fromCatalog("RM-VERIFY-005", {
        whatHappened:
          `the source origin is ${identity}, but no configured repository route targets it; ` +
          "doctor cannot prove the base a live workspace would use",
      });
    }

    const token = await resolveCredential(ctx, "github");
    const credential = token === undefined ? undefined : new GitHubGitCredential({ token });
    const fetchBase = ctx.fetchTrustedBase ?? fetchRemoteTrustedBase;
    const observations: string[] = [];

    for (const target of targets) {
      const base = await fetchBase(
        ctx.repoRoot,
        target.baseBranch,
        credential?.repositoryUrl(target.repo) ?? "origin",
        credential,
      );

      // Use the same immutable SHA for repository verification policy and the
      // dependency checkout. This prevents doctor from blessing local policy
      // while the first live workspace immediately consumes newer remote
      // package metadata.
      const manifest = loadChecksManifest({
        repoRoot: ctx.repoRoot,
        manifestPath: config.verification.manifest,
        baseRef: base.commit,
      });
      const effectiveIds = new Set([
        ...config.verification.commands.map((item) => item.id),
        ...(manifest?.checks.map((item) => item.id) ?? []),
      ]);
      if (effectiveIds.size === 0) {
        throw RunmillError.fromCatalog("RM-VERIFY-001", {
          whatHappened:
            `the effective verification check union at ${identity}@${base.commit} is empty`,
        });
      }

      const checkout = await checkoutTrustedCommit(ctx.repoRoot, base.commit);
      try {
        const dependencies = check(checkout);
        observations.push(
          dependencies === undefined
            ? `${identity}@${base.commit.slice(0, 12)} (${target.baseBranch}) has no package-lock.json`
            : `${identity}@${base.commit.slice(0, 12)} (${target.baseBranch}) matches npm install ${dependencies.identity.slice(0, 12)}`,
        );
      } finally {
        rmSync(dirname(checkout), { recursive: true, force: true });
      }
    }

    return {
      id: "verification:dependencies",
      status: "pass",
      observed: observations.join("; "),
      expected,
    };
  } catch (error) {
    return {
      id: "verification:dependencies",
      status: "fail",
      code: error instanceof RunmillError ? error.code : "RM-VERIFY-005",
      observed:
        error instanceof RunmillError
          ? error.whatHappened
          : (errorMessage(error).split("\n")[0] ?? "verification dependencies are not ready"),
      expected,
      remediation:
        "Run `npm ci` in the source checkout, then rerun " +
        "`runmill doctor --check verification:dependencies`",
    };
  }
}

async function tryRun(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const result = await run(cmd, args, cwd === undefined ? {} : { cwd });
  return {
    ok: result.ok,
    out: (result.ok ? result.stdout : result.stderr || result.stdout).trim(),
  };
}

function safeRemote(value: string): string {
  return value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    (_match, scheme: string) => `${scheme}<redacted>@`,
  );
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

const GIT_PROVENANCE_PROBE_TIMEOUT_MS = 15_000;

function provenanceFailure(
  error: unknown,
  provenance: CandidateCommitProvenance | undefined,
): string {
  const message = errorMessage(error);
  if (/runmill@localhost/iu.test(message)) {
    return "source Git identity still uses the runmill@localhost placeholder";
  }
  if (/explicit Git user\.(?:name|email)/iu.test(message)) {
    return message.split(";")[0] ?? "source Git identity is incomplete";
  }
  if (provenance?.signing.enabled === true) {
    return `configured ${provenance.signing.format} signing could not create a candidate commit`;
  }
  if (/gpg\.format/iu.test(message)) {
    return "source Git signing format is invalid";
  }
  return "candidate commit identity could not be resolved from source Git config";
}

/**
 * Prove candidate authorship before a run claims anything.
 *
 * Resolving config alone cannot prove that a signing key/agent is usable. The
 * probe creates and validates a real commit in a disposable repository through
 * the exact helper WorkspaceManager calls, leaving the source checkout clean.
 */
export async function checkGitProvenance(ctx: DoctorContext): Promise<CheckResult> {
  let probe: string | undefined;
  let provenance: CandidateCommitProvenance | undefined;
  try {
    probe = mkdtempSync(join(tmpdir(), "runmill-git-provenance-"));
    provenance = await resolveCandidateCommitProvenance(ctx.repoRoot);
    await runGit(probe, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(probe, "probe.txt"), "runmill candidate provenance probe\n", {
      mode: 0o600,
    });
    await runGit(probe, ["add", "--", "probe.txt"]);
    await createCandidateCommit(probe, "runmill doctor: candidate provenance probe", provenance, {
      timeoutMs: GIT_PROVENANCE_PROBE_TIMEOUT_MS,
    });
    return {
      id: "git:provenance",
      status: "pass",
      observed:
        `${provenance.name} <${provenance.email}>; ` +
        (provenance.signing.enabled
          ? `${provenance.signing.format}-signed candidate commit created`
          : "signing is not required by effective Git config"),
      expected: "an explicit non-placeholder identity and any configured signer can create a candidate commit",
    };
  } catch (error) {
    return {
      id: "git:provenance",
      status: "fail",
      code: "RM-WORKSPACE-004",
      observed:
        probe === undefined
          ? "could not create a disposable repository for the candidate provenance probe"
          : provenanceFailure(error, provenance),
      expected: "an explicit non-placeholder identity and any configured signer can create a candidate commit",
      remediation:
        "Configure verified user.name/user.email and a non-interactive signer in this checkout, then run `runmill doctor --check git:provenance`",
    };
  } finally {
    if (probe !== undefined) rmSync(probe, { recursive: true, force: true });
  }
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
    observed: reachable.ok ? safeRemote(url.out) : `${safeRemote(url.out)} (unreachable)`,
    expected,
    remediation: reachable.ok
      ? undefined
      : "Check network access and credentials for this remote; runmill cannot take a lease without it",
  };
}

async function resolveCredential(
  ctx: DoctorContext,
  name: CredentialName,
): Promise<string | undefined> {
  return (ctx.credentials ?? new CredentialStore()).get(name);
}

export async function checkGitHubCredential(ctx: DoctorContext = { repoRoot: process.cwd() }): Promise<CheckResult> {
  const expected =
    "the exact GitHub credential Runmill will use can read each configured base branch and push to its repository";
  try {
    const token = await resolveCredential(ctx, "github");
    if (token === undefined) {
      return {
        id: "github-auth",
        status: "fail",
        code: "RM-AUTH-003",
        observed: "no GitHub credential resolved from environment, keychain, or gh",
        expected,
        remediation:
          "Run `gh auth login`, set GITHUB_TOKEN, or pipe it without putting it in argv: " +
          "`printenv GITHUB_TOKEN | runmill auth login github`",
      };
    }
    if (ctx.configPath === undefined) {
      return {
        id: "github-auth",
        status: "fail",
        code: "RM-AUTH-003",
        observed: "no operator policy was supplied, so repository access was not guessed",
        expected,
        remediation: "Pass the configured policy to doctor, or run `runmill doctor` from the repository",
      };
    }

    const config = loadConfig(ctx.configPath, { repoRoot: ctx.repoRoot }).config;
    const targets = [...new Map(
      config.github.repositories.map((rule) => [
        `${rule.repo}\0${rule.baseBranch}`,
        { repo: rule.repo, baseBranch: rule.baseBranch },
      ]),
    ).values()];
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "runmill-doctor",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    for (const target of targets) {
      const [owner, repo, extra] = target.repo.split("/");
      if (owner === undefined || repo === undefined || extra !== undefined) {
        throw new Error("configured GitHub repository is not owner/name");
      }
      const repositoryUrl =
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const repository = await (ctx.request ?? fetch)(repositoryUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!repository.ok) {
        return {
          id: "github-auth",
          status: "fail",
          code: "RM-AUTH-003",
          observed: `${target.repo} could not be read (GitHub API HTTP ${repository.status})`,
          expected,
          remediation: "Grant the resolved GitHub credential access to this configured repository, then rerun doctor",
        };
      }
      const metadata = (await repository.json()) as { permissions?: { push?: boolean } };
      if (metadata.permissions?.push !== true) {
        return {
          id: "github-auth",
          status: "fail",
          code: "RM-AUTH-003",
          observed: `${target.repo} is readable, but GitHub does not report push permission`,
          expected,
          remediation:
            "Grant the resolved GitHub credential repository contents write access, then rerun doctor",
        };
      }

      const branch = await (ctx.request ?? fetch)(
        `${repositoryUrl}/branches/${encodeURIComponent(target.baseBranch)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!branch.ok) {
        return {
          id: "github-auth",
          status: "fail",
          code: "RM-AUTH-003",
          observed:
            `${target.repo} reports push permission, but base branch ` +
            `${target.baseBranch} could not be read (GitHub API HTTP ${branch.status})`,
          expected,
          remediation: "Correct github.repositories[].base_branch or grant access, then rerun doctor",
        };
      }
    }

    return {
      id: "github-auth",
      status: "pass",
      observed:
        `resolved credential can read and push to ${targets.length} configured ` +
        `repositor${targets.length === 1 ? "y" : "ies"}; every configured base branch exists`,
      expected,
    };
  } catch {
    return {
      id: "github-auth",
      status: "fail",
      code: "RM-AUTH-003",
      observed: "resolved GitHub credential could not be verified",
      expected,
      remediation: "Check GitHub connectivity and refresh the credential, then rerun doctor",
    };
  }
}

export async function checkLinearCredential(ctx: DoctorContext): Promise<CheckResult> {
  const expected =
    "the exact Linear credential can read the configured team and every configured workflow state";
  try {
    const token = await resolveCredential(ctx, "linear");
    if (token === undefined) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-AUTH-003",
        observed: "no Linear credential resolved from environment or keychain",
        expected,
        remediation:
          "Set LINEAR_API_KEY, or pipe it without putting it in argv: " +
          "`printenv LINEAR_API_KEY | runmill auth login linear`",
      };
    }
    if (ctx.configPath === undefined) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-CONFIG-001",
        observed: "no operator policy was supplied, so a Linear team and workflow were not guessed",
        expected,
        remediation: "Pass the configured policy to doctor, or run `runmill doctor` from the repository",
      };
    }

    let config: ReturnType<typeof loadConfig>["config"];
    try {
      config = loadConfig(ctx.configPath, { repoRoot: ctx.repoRoot }).config;
    } catch (error) {
      return {
        id: "linear-auth",
        status: "fail",
        code: error instanceof RunmillError ? error.code : "RM-CONFIG-001",
        observed: "the operator policy could not provide a valid Linear workflow",
        expected,
        remediation: "Fix `runmill config validate`, then rerun doctor",
      };
    }

    const requiredStates = [
      ...config.backlog.eligibleStates,
      config.backlog.claimState,
      config.backlog.deliveredState,
      config.backlog.completedState,
    ].filter((state): state is string => state !== undefined);
    const response = await (ctx.request ?? fetch)("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "query RunmillDoctor($teamKey: String!) { " +
          "viewer { id } " +
          "teams(first: 2, filter: { key: { eq: $teamKey } }) { " +
          "nodes { id key states(first: 100) { nodes { name } pageInfo { hasNextPage } } } " +
          "pageInfo { hasNextPage } } }",
        variables: { teamKey: config.backlog.team },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-AUTH-003",
        observed: `Linear API rejected the credential or query (HTTP ${response.status})`,
        expected,
        remediation: "Refresh LINEAR_API_KEY or the stored Linear credential, then rerun doctor",
      };
    }

    const body = (await response.json()) as {
      data?: {
        viewer?: { id?: string };
        teams?: {
          nodes?: {
            id?: string;
            key?: string;
            states?: {
              nodes?: { name?: string }[];
              pageInfo?: { hasNextPage?: boolean };
            };
          }[];
          pageInfo?: { hasNextPage?: boolean };
        };
      };
      errors?: unknown[];
    };
    if (
      typeof body.data?.viewer?.id !== "string" ||
      (body.errors !== undefined && body.errors.length > 0)
    ) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-AUTH-003",
        observed: "Linear did not accept the resolved credential and workflow query",
        expected,
        remediation: "Refresh the Linear credential and verify its workspace access, then rerun doctor",
      };
    }

    const teams = body.data.teams;
    const team = teams?.nodes?.[0];
    if (
      teams?.pageInfo?.hasNextPage !== false ||
      teams.nodes?.length !== 1 ||
      team?.key !== config.backlog.team
    ) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-CONFIG-001",
        observed: `configured Linear team "${config.backlog.team}" does not resolve uniquely`,
        expected,
        remediation: "Choose an exact team key returned by Linear, update backlog.team, then rerun doctor",
      };
    }
    if (team.states?.pageInfo?.hasNextPage !== false) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-CONFIG-001",
        observed: `Linear did not return a complete workflow-state inventory for ${config.backlog.team}`,
        expected,
        remediation: "Reduce or repair the team's Linear workflow, then rerun doctor",
      };
    }
    const availableStates = new Set(
      (team.states.nodes ?? [])
        .map((state) => state.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const missingStates = [...new Set(requiredStates)].filter(
      (state) => !availableStates.has(state),
    );
    if (missingStates.length > 0) {
      return {
        id: "linear-auth",
        status: "fail",
        code: "RM-CONFIG-001",
        observed:
          `Linear team ${config.backlog.team} is missing configured state` +
          `${missingStates.length === 1 ? "" : "s"}: ${missingStates.join(", ")}`,
        expected,
        remediation:
          "Use exact state names from the configured Linear team for eligible_states, " +
          "claim_state, delivered_state, and completed_state, then rerun doctor",
      };
    }
    return {
      id: "linear-auth",
      status: "pass",
      observed:
        `resolved credential can read Linear team ${config.backlog.team}; ` +
        `${new Set(requiredStates).size} configured workflow state(s) exist`,
      expected,
    };
  } catch {
    return {
      id: "linear-auth",
      status: "fail",
      code: "RM-AUTH-003",
      observed: "resolved Linear credential could not be verified",
      expected,
      remediation: "Check Linear connectivity and refresh the credential, then rerun doctor",
    };
  }
}

function normalizeProviderTarget(target: string | ProviderCheckTarget): ProviderCheckTarget {
  return typeof target === "string" ? { implementation: target } : target;
}

function providerCheckId(target: ProviderCheckTarget): string {
  return `provider:${target.implementation}${target.model === undefined ? "" : `:${target.model}`}`;
}

function createProviderDoctorAdapter(target: ProviderCheckTarget): ProviderDoctorAdapter {
  const dialect = target.implementation === "claude" ? CLAUDE_DIALECT : CODEX_DIALECT;
  return new CliProviderAdapter({
    dialect,
    ...(target.model === undefined ? {} : { model: target.model }),
  });
}

export async function checkProvider(
  input: string | ProviderCheckTarget,
  injectedAdapter?: ProviderDoctorAdapter,
): Promise<CheckResult> {
  const target = normalizeProviderTarget(input);
  const { implementation } = target;
  const id = providerCheckId(target);
  // An unrecognised implementation used to fall through to codex, so a typo in
  // the operator policy produced a PASSING check for a provider nobody asked for.
  if (implementation !== "codex" && implementation !== "claude") {
    return {
      id,
      status: "fail",
      code: "RM-CONFIG-001",
      observed: `unknown provider "${implementation}"`,
      expected: "provider.implementation is codex or claude",
      remediation: "runmill config validate",
    };
  }
  const dialect = implementation === "claude" ? CLAUDE_DIALECT : CODEX_DIALECT;
  const adapter = injectedAdapter ?? createProviderDoctorAdapter(target);
  const installation = await adapter.detect();
  if (!installation.installed) {
    return {
      id,
      status: "fail",
      code: "RM-AUTH-003",
      observed: `${dialect.binary} not found`,
      expected: `${dialect.binary} installed and authenticated inside the Runmill sandbox`,
      remediation: `Install ${dialect.binary} and authenticate it`,
    };
  }
  const auth = await adapter.sandboxAuthStatus();
  return {
    id,
    status: auth.authenticated ? "pass" : "fail",
    code: auth.authenticated ? undefined : "RM-AUTH-003",
    observed: auth.authenticated
      ? `${installation.version ?? dialect.binary}; authenticated inside sandbox`
      : auth.detail ?? "authentication failed inside sandbox",
    expected: `${dialect.binary} installed and authenticated inside the Runmill sandbox`,
    remediation: auth.authenticated
      ? undefined
      : `Authenticate ${dialect.binary} with a sandbox-compatible subscription session`,
  };
}

/**
 * A successful auth-status command does not prove the configured model can run.
 * Keep the billable one-turn request as a separate line so operators can tell
 * which of the two gates failed without exposing the provider's response.
 */
export async function checkProviderExecution(
  input: string | ProviderCheckTarget,
  adapter?: ProviderDoctorAdapter,
): Promise<CheckResult> {
  const target = normalizeProviderTarget(input);
  const id = `${providerCheckId(target)}:request`;
  if (target.implementation !== "codex" && target.implementation !== "claude") {
    return {
      id,
      status: "fail",
      code: "RM-CONFIG-001",
      observed: `unknown provider "${target.implementation}"`,
      expected: "a supported provider and model",
      remediation: "runmill config validate",
    };
  }

  const execution = await (adapter ?? createProviderDoctorAdapter(target)).sandboxExecutionStatus();
  return {
    id,
    status: execution.executed ? "pass" : "fail",
    observed: execution.detail,
    expected: "one minimal provider request completes inside the actual Runmill sandbox",
    remediation: execution.executed
      ? undefined
      : `Check ${target.implementation} model access, account limits, network access, and sandbox compatibility; then rerun doctor`,
  };
}

/**
 * Authentication working is not the same as credential isolation.
 *
 * The provider CLI and its tool children currently share one OS sandbox. Each
 * invocation gets a private copy of the provider config as HOME, so writes are
 * discarded and cannot alter the operator's real config. Seatbelt and
 * bubblewrap still cannot grant the copied token to only the provider parent:
 * a tool child may read or exfiltrate it. Keep this visible until a host-side
 * broker removes provider credentials from the boundary entirely.
 */
export function checkProviderCredentialIsolation(implementation: string): CheckResult {
  return {
    id: `provider:${implementation}:credential-isolation`,
    status: "warn",
    observed:
      "a disposable provider-config copy is readable by the CLI and its tool subprocesses; writes are discarded, but the copied subscription credential remains exposed inside the sandbox",
    expected: "provider credentials remain outside the agent sandbox",
    remediation:
      "Use a dedicated subscription, stay in pr-only, and treat the provider credential as exposed until a host-side credential broker ships",
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
      // Ubuntu 23.10 and later restrict unprivileged user namespaces through
      // AppArmor rather than the old Debian sysctl, and on those hosts
      // `kernel.unprivileged_userns_clone` does not exist at all — so the
      // remediation runmill used to print failed with "cannot stat" and left
      // the operator no better off. Name both knobs, newest first.
      remediation: userns.ok
        ? undefined
        : "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 " +
          "(Ubuntu 23.10+), or sudo sysctl -w kernel.unprivileged_userns_clone=1 (older Debian)",
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

  // The schema reserves a future proxy mode, but no hostname-filtering proxy
  // ships yet. `allowNetwork: true` is unrestricted outbound on both
  // mechanisms. Say so on every host rather than presenting a parsed but
  // unused allowlist as enforcement.
  results.push({
    id: "sandbox:network",
    status: "warn",
    observed: "provider egress is unrestricted when workspace.network is proxy",
    expected: "hostname-scoped provider egress",
    remediation:
      "Keep workspace.network_allowlist empty, use a dedicated provider session, and stay in pr-only until the network proxy ships",
  });

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
  providersToCheck:
    | string
    | ProviderCheckTarget
    | readonly (string | ProviderCheckTarget)[] = ["codex"],
): Promise<CheckResult[]> {
  const requested = Array.isArray(providersToCheck) ? providersToCheck : [providersToCheck];
  const targets = [
    ...new Map(
      requested.map((value) => {
        const target = normalizeProviderTarget(value);
        return [`${target.implementation}\0${target.model ?? ""}`, target] as const;
      }),
    ).values(),
  ];
  const wants = (id: string): boolean =>
    ctx.checkPrefix === undefined ||
    id.startsWith(ctx.checkPrefix) ||
    ctx.checkPrefix.startsWith(`${id}:`);
  const selectedTargets = targets.filter((target) => wants(providerCheckId(target)));
  // Every probe is independent, so wall time is the slowest one rather than
  // the sum. Promise.all preserves order, so the rendered output is identical.
  const [
    configuration,
    verification,
    verificationDependencies,
    git,
    provenance,
    repository,
    remote,
    github,
    linear,
    providers,
    sandbox,
  ] = await Promise.all([
    Promise.resolve(wants("configuration") ? checkConfiguration(ctx) : undefined),
    Promise.resolve(wants("verification") ? checkVerificationPolicy(ctx) : undefined),
    Promise.resolve(
      wants("verification:dependencies") ? checkVerificationDependencies(ctx) : undefined,
    ),
    wants("git") ? checkGit() : Promise.resolve(undefined),
    wants("git:provenance") ? checkGitProvenance(ctx) : Promise.resolve(undefined),
    wants("repository") ? checkRepository(ctx) : Promise.resolve(undefined),
    wants("repository:remote") ? checkRemote(ctx) : Promise.resolve(undefined),
    wants("github-auth") ? checkGitHubCredential(ctx) : Promise.resolve(undefined),
    !wants("linear-auth") ? Promise.resolve(undefined) : checkLinearCredential(ctx),
    Promise.all(selectedTargets.map(async (target) => {
      const known = target.implementation === "codex" || target.implementation === "claude";
      const adapter = known
        ? (ctx.providerAdapterFactory?.(target) ?? createProviderDoctorAdapter(target))
        : undefined;
      const auth = await checkProvider(target, adapter);
      if (auth.status !== "pass" || adapter === undefined) return [auth];
      return [auth, await checkProviderExecution(target, adapter)];
    })),
    wants("sandbox") ? checkSandbox() : Promise.resolve([]),
  ]);
  const isolationWarnings = new Set<string>();
  const providerChecks = providers.flatMap((results, index) => {
    const target = selectedTargets[index];
    if (target === undefined || results[0]?.status !== "pass") return results;
    if (isolationWarnings.has(target.implementation)) return results;
    isolationWarnings.add(target.implementation);
    return [...results, checkProviderCredentialIsolation(target.implementation)];
  });
  return [
    ...(wants("environment") ? [checkCiEnvironment()] : []),
    ...(configuration === undefined ? [] : [configuration]),
    ...(verification === undefined ? [] : [verification]),
    ...(verificationDependencies === undefined ? [] : [verificationDependencies]),
    ...(git === undefined ? [] : [git]),
    ...(provenance === undefined ? [] : [provenance]),
    ...(repository === undefined ? [] : [repository]),
    ...(remote === undefined ? [] : [remote]),
    ...(github === undefined ? [] : [github]),
    ...(linear === undefined ? [] : [linear]),
    ...providerChecks,
    ...sandbox,
  ];
}

export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
