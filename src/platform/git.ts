import { run, runOrThrow, type RunResult } from "./process.js";

/**
 * Identity used only for internal lease-ref objects.
 *
 * Fixed dates keep a lease record's object id deterministic. This identity
 * must never be used for a candidate commit delivered to a pull request.
 */
export const RUNMILL_LEASE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "runmill",
  GIT_AUTHOR_EMAIL: "runmill@localhost",
  GIT_COMMITTER_NAME: "runmill",
  GIT_COMMITTER_EMAIL: "runmill@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

export interface GitOptions {
  /** Use the fixed identity and dates for an internal lease object only. */
  readonly deterministicLeaseIdentity?: boolean | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export type GitSigningFormat = "openpgp" | "x509" | "ssh";

/** Trusted host-side settings used when Runmill authors a candidate commit. */
export interface CandidateCommitProvenance {
  readonly name: string;
  readonly email: string;
  readonly signing: {
    readonly enabled: boolean;
    readonly key?: string | undefined;
    readonly format: GitSigningFormat;
    /** Selected effective Git settings; never copied into the run clone. */
    readonly programs: Readonly<Record<string, string>>;
  };
}

/**
 * Inherited `GIT_*` variables that would change what a command sees.
 *
 * `treeHash` is the freshness proof the verification contract rests on; an
 * ambient GIT_DIR or GIT_INDEX_FILE could quietly change its answer.
 */
const STRIPPED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  // Identity and dates are authority-bearing commit inputs. Callers must set
  // them deliberately instead of inheriting a daemon supervisor's ambient
  // environment. The deterministic lease option below adds its own values
  // back after this removal.
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
];

function envFor(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED) delete env[key];
  // `git -c` is encoded through these variables. Inheriting a half-present or
  // supervisor-supplied tuple can inject config after the orchestrator has
  // resolved its trusted inputs.
  delete env["GIT_CONFIG_COUNT"];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete env[key];
  }
  return {
    ...env,
    ...(options.deterministicLeaseIdentity === true ? RUNMILL_LEASE_GIT_ENV : {}),
    ...(options.env ?? {}),
  };
}

/** Run git in `cwd` and return trimmed stdout. Throws on a non-zero exit. */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return runOrThrow("git", args, {
    cwd,
    env: envFor(options),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Run git without throwing, for probes where failure is an expected answer. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<RunResult> {
  return run("git", args, {
    cwd,
    env: envFor(options),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function configValue(output: string): string {
  return output.replace(/\r?\n$/, "");
}

async function optionalConfig(cwd: string, key: string): Promise<string | undefined> {
  const result = await tryGit(cwd, ["config", "--get", key]);
  if (!result.ok) {
    if (result.code === 1 && result.stderr.trim() === "") return undefined;
    throw new Error(
      `could not read effective Git setting ${key}: ${result.stderr.trim() || "git config failed"}`,
    );
  }
  return configValue(result.stdout);
}

async function optionalBooleanConfig(cwd: string, key: string): Promise<boolean | undefined> {
  const result = await tryGit(cwd, ["config", "--bool", "--get", key]);
  if (!result.ok) {
    if (result.code === 1 && result.stderr.trim() === "") return undefined;
    throw new Error(
      `could not read effective Git boolean ${key}: ${result.stderr.trim() || "invalid value"}`,
    );
  }
  return configValue(result.stdout) === "true";
}

function requiredIdentityPart(value: string | undefined, key: "user.name" | "user.email"): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `candidate commits require an explicit Git ${key}; configure it in the source repository ` +
        `or the operator's Git config with \`git config ${key} <value>\``,
    );
  }
  if (/[\0\r\n<>]/u.test(value)) {
    throw new Error(`Git ${key} contains characters that are unsafe in a commit identity`);
  }
  // Git canonicalizes surrounding whitespace when it writes an ident. Store
  // the same semantic value so the exact post-commit check below agrees.
  return value.trim();
}

function safeConfigValue(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`Git ${key} contains an unsafe line break or NUL byte`);
  }
  return value;
}

/**
 * Resolve the identity and signing policy Git would use in the trusted source
 * checkout. The result is held by the orchestrator; it is not written into the
 * agent-visible clone and no signing secret is passed to the agent process.
 */
export async function resolveCandidateCommitProvenance(
  sourceRepo: string,
): Promise<CandidateCommitProvenance> {
  const name = requiredIdentityPart(await optionalConfig(sourceRepo, "user.name"), "user.name");
  const email = requiredIdentityPart(await optionalConfig(sourceRepo, "user.email"), "user.email");
  if (email.toLowerCase() === "runmill@localhost") {
    throw new Error(
      "candidate commits refuse the placeholder identity runmill@localhost; configure a verified " +
        "operator or bot email in the source repository",
    );
  }

  const signingEnabled = (await optionalBooleanConfig(sourceRepo, "commit.gpgsign")) ?? false;
  if (!signingEnabled) {
    return {
      name,
      email,
      signing: { enabled: false, format: "openpgp", programs: {} },
    };
  }

  const rawFormat = safeConfigValue(await optionalConfig(sourceRepo, "gpg.format"), "gpg.format");
  const format = rawFormat === undefined || rawFormat === "" ? "openpgp" : rawFormat.toLowerCase();
  if (format !== "openpgp" && format !== "x509" && format !== "ssh") {
    throw new Error(
      `Git gpg.format must be openpgp, x509, or ssh for candidate commits; got ${JSON.stringify(rawFormat)}`,
    );
  }

  const programs: Record<string, string> = {};
  for (const key of [
    "gpg.program",
    "gpg.openpgp.program",
    "gpg.x509.program",
    "gpg.ssh.program",
    "gpg.ssh.defaultKeyCommand",
  ]) {
    const value = safeConfigValue(await optionalConfig(sourceRepo, key), key);
    if (value !== undefined && value !== "") programs[key] = value;
  }

  return {
    name,
    email,
    signing: {
      enabled: true,
      key: safeConfigValue(await optionalConfig(sourceRepo, "user.signingkey"), "user.signingKey"),
      format,
      programs,
    },
  };
}

/** Options that bind author and committer to the already-resolved host identity. */
export function candidateCommitOptions(provenance: CandidateCommitProvenance): GitOptions {
  return {
    env: {
      GIT_AUTHOR_NAME: provenance.name,
      GIT_AUTHOR_EMAIL: provenance.email,
      GIT_COMMITTER_NAME: provenance.name,
      GIT_COMMITTER_EMAIL: provenance.email,
      // The source checkout's selected provenance settings were captured
      // above. Do not re-read mutable user/system config at commit time; an
      // invalid lower-precedence value can otherwise defeat even an explicit
      // `-c`, and a changed value can silently alter signing behavior.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      // Candidate creation runs unattended in the daemon. A signing setup
      // that requires a terminal prompt is not usable there and must fail the
      // same way during doctor.
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
    },
  };
}

/** Command prefix reproducing the source checkout's selected signing settings. */
export function candidateSigningArgs(provenance: CandidateCommitProvenance): string[] {
  const args = ["-c", `gpg.format=${provenance.signing.format}`];
  if (provenance.signing.key !== undefined && provenance.signing.key !== "") {
    args.push("-c", `user.signingKey=${provenance.signing.key}`);
  }
  for (const [key, value] of Object.entries(provenance.signing.programs)) {
    args.push("-c", `${key}=${value}`);
  }
  return args;
}

export interface CreateCandidateCommitOptions {
  /** Bound signing-program or signing-agent stalls. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Create and validate an orchestrator-owned candidate commit.
 *
 * WorkspaceManager and doctor intentionally share this exact path: readiness
 * is evidence only if it exercises the operation a real run will perform.
 */
export async function createCandidateCommit(
  cwd: string,
  message: string,
  provenance: CandidateCommitProvenance,
  options: CreateCandidateCommitOptions = {},
): Promise<string> {
  const signingFlag = provenance.signing.enabled ? "--gpg-sign" : "--no-gpg-sign";
  await git(
    cwd,
    [...candidateSigningArgs(provenance), "commit", "--quiet", signingFlag, "-m", message],
    {
      ...candidateCommitOptions(provenance),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );

  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  const metadata = await git(cwd, [
    "show",
    "-s",
    "--format=%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct",
    sha,
  ]);
  const [authorName, authorEmail, committerName, committerEmail, authorTime, committerTime] =
    metadata.split("\0");
  if (
    authorName !== provenance.name ||
    authorEmail !== provenance.email ||
    committerName !== provenance.name ||
    committerEmail !== provenance.email
  ) {
    throw new Error("candidate commit identity does not match the trusted operator Git identity");
  }

  const earliestPlausibleTimestamp = Date.UTC(2000, 0, 1) / 1_000;
  const authorTimestamp = Number(authorTime);
  const committerTimestamp = Number(committerTime);
  if (
    !Number.isFinite(authorTimestamp) ||
    !Number.isFinite(committerTimestamp) ||
    authorTimestamp < earliestPlausibleTimestamp ||
    committerTimestamp < earliestPlausibleTimestamp
  ) {
    throw new Error("candidate commit has an implausible author or committer timestamp");
  }

  const rawCommit = await git(cwd, ["cat-file", "commit", sha]);
  // SHA-256 repositories may use the transition header while SHA-1
  // repositories use `gpgsig`; both are Git-owned signature headers.
  const hasSignature = /^gpgsig(?:-sha256)? /mu.test(rawCommit);
  if (provenance.signing.enabled !== hasSignature) {
    throw new Error(
      provenance.signing.enabled
        ? "candidate commit signing was required but the commit has no signature"
        : "candidate commit was signed even though source Git configuration disabled signing",
    );
  }
  return sha;
}
