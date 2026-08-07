import { run, runOrThrow, type RunResult } from "./process.js";

/**
 * Identity used for every commit and ref runmill authors.
 *
 * Fixed dates keep lease-ref object ids deterministic for a given record, so
 * the ref content is reproducible and auditable.
 */
export const RUNMILL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "runmill",
  GIT_AUTHOR_EMAIL: "runmill@localhost",
  GIT_COMMITTER_NAME: "runmill",
  GIT_COMMITTER_EMAIL: "runmill@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

export interface GitOptions {
  /** Use the fixed runmill identity and deterministic dates. */
  readonly runmillIdentity?: boolean | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

function envFor(options: GitOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.runmillIdentity === true ? RUNMILL_GIT_ENV : {}),
    ...(options.env ?? {}),
  };
}

/** Run git in `cwd` and return trimmed stdout. Throws on a non-zero exit. */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return runOrThrow("git", args, { cwd, env: envFor(options) });
}

/** Run git without throwing, for probes where failure is an expected answer. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<RunResult> {
  return run("git", args, { cwd, env: envFor(options) });
}
