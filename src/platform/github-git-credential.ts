import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, tryGit, type GitOptions } from "./git.js";
import type { RunResult } from "./process.js";

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$RUNMILL_GIT_ASKPASS_USERNAME" ;;
  *Password*) printf '%s\\n' "$RUNMILL_GIT_ASKPASS_PASSWORD" ;;
  *) exit 1 ;;
esac
`;
const CREDENTIAL_CONFIG_TIMEOUT_MS = 15_000;
const URL_REWRITE_PATTERN = "^url\\..*\\.insteadof$";
const GIT_CONFIG_SCOPES = ["system", "global", "local", "worktree"] as const;

function cloneBaseUrl(apiBaseUrl: string | undefined): string {
  if (apiBaseUrl === undefined) return "https://github.com";

  const api = new URL(apiBaseUrl);
  if (api.hostname === "api.github.com") return "https://github.com";
  if (api.protocol !== "https:") {
    throw new Error("GitHub Enterprise credentials require an HTTPS API base URL");
  }

  // GitHub Enterprise's REST endpoint conventionally ends in /api/v3 while
  // HTTPS clone URLs live at the same host (and optional reverse-proxy prefix).
  const prefix = api.pathname.replace(/\/+$/u, "").replace(/\/api\/v3$/u, "");
  return `${api.origin}${prefix}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Short-lived, non-argv GitHub authentication for host-owned Git commands.
 *
 * The credential is supplied only to a private askpass process through its
 * environment. The helper itself contains no secret, configured credential
 * managers are disabled, and repository hooks cannot inherit the environment.
 */
export class GitHubGitCredential {
  readonly #token: string;
  readonly #cloneBaseUrl: string;

  constructor(options: { token: string; baseUrl?: string | undefined }) {
    if (options.token === "" || /[\0\r\n]/u.test(options.token)) {
      throw new Error("GitHub credentials must be non-empty and contain no line break or NUL byte");
    }
    this.#token = options.token;
    this.#cloneBaseUrl = cloneBaseUrl(options.baseUrl);
  }

  repositoryUrl(repo: string): string {
    return `${this.#cloneBaseUrl}/${repo}.git`;
  }

  redact(message: string): string {
    const representations = [
      this.#token,
      encodeURIComponent(this.#token),
      Buffer.from(this.#token).toString("base64"),
      Buffer.from(`x-access-token:${this.#token}`).toString("base64"),
    ].filter((value) => value !== "");

    let redacted = message;
    for (const representation of new Set(representations)) {
      redacted = redacted.split(representation).join("<redacted>");
    }
    return redacted;
  }

  async git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
    await this.#assertExactCredentialTarget(cwd, args, options.timeoutMs);
    return this.#withAskpass(async (authArgs, authEnv) => {
      try {
        const output = await git(cwd, [...authArgs, ...args], {
          ...options,
          env: { ...options.env, ...authEnv },
        });
        return this.redact(output);
      } catch (error) {
        throw new Error(this.redact(messageOf(error)));
      }
    });
  }

  async tryGit(
    cwd: string,
    args: readonly string[],
    options: GitOptions = {},
  ): Promise<RunResult> {
    await this.#assertExactCredentialTarget(cwd, args, options.timeoutMs);
    return this.#withAskpass(async (authArgs, authEnv) => {
      try {
        const result = await tryGit(cwd, [...authArgs, ...args], {
          ...options,
          env: { ...options.env, ...authEnv },
        });
        return {
          ...result,
          stdout: this.redact(result.stdout),
          stderr: this.redact(result.stderr),
        };
      } catch (error) {
        throw new Error(this.redact(messageOf(error)));
      }
    });
  }

  #credentialOwnedUrl(value: string): boolean {
    try {
      const base = new URL(this.#cloneBaseUrl);
      const candidate = new URL(value);
      if (
        candidate.protocol !== "https:" ||
        candidate.origin !== base.origin ||
        candidate.username !== "" ||
        candidate.password !== "" ||
        candidate.search !== "" ||
        candidate.hash !== ""
      ) {
        return false;
      }
      const prefix = `${base.pathname.replace(/\/+$/u, "")}/`;
      if (!candidate.pathname.startsWith(prefix)) return false;
      const repository = candidate.pathname.slice(prefix.length);
      return /^[^/]+\/[^/]+\.git$/u.test(repository);
    } catch {
      return false;
    }
  }

  async #assertExactCredentialTarget(
    cwd: string,
    args: readonly string[],
    requestedTimeoutMs: number | undefined,
  ): Promise<void> {
    const targets = args.filter((arg) => this.#credentialOwnedUrl(arg));
    if (targets.length !== 1) {
      throw new Error(
        "credentialed Git operation requires one exact HTTPS URL owned by this GitHub credential",
      );
    }
    const target = targets[0] as string;
    const timeoutMs =
      requestedTimeoutMs !== undefined && requestedTimeoutMs > 0
        ? Math.min(requestedTimeoutMs, CREDENTIAL_CONFIG_TIMEOUT_MS)
        : CREDENTIAL_CONFIG_TIMEOUT_MS;
    for (const scope of GIT_CONFIG_SCOPES) {
      const result = await tryGit(
        cwd,
        ["config", `--${scope}`, "--get-regexp", URL_REWRITE_PATTERN],
        { timeoutMs },
      );
      if (!result.ok) {
        if (result.code === 1 && result.stderr.trim() === "") continue;
        throw new Error(`could not verify ${scope} Git URL rewrite policy`);
      }
      for (const line of result.stdout.split(/\r?\n/u).filter((value) => value !== "")) {
        const match = line.match(/^[^\t ]+[\t ](.*)$/u);
        if (match?.[1] === undefined) {
          throw new Error(`could not parse ${scope} Git URL rewrite policy`);
        }
        if (target.startsWith(match[1])) {
          throw new Error(
            "credentialed Git operation refuses a URL affected by url.*.insteadOf policy",
          );
        }
      }
    }
  }

  async #withAskpass<T>(
    action: (configArgs: readonly string[], env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "runmill-git-askpass-"));
    const helper = join(directory, "askpass.sh");
    try {
      await chmod(directory, 0o700);
      await writeFile(helper, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
      return await action(
        [
          "-c",
          "credential.helper=",
          "-c",
          "core.hooksPath=/dev/null",
        ],
        {
          GIT_ASKPASS: helper,
          GIT_TERMINAL_PROMPT: "0",
          RUNMILL_GIT_ASKPASS_USERNAME: "x-access-token",
          RUNMILL_GIT_ASKPASS_PASSWORD: this.#token,
          // Keep Git's localized prompt stable for the deliberately tiny
          // helper, and deny ambient traces that could copy auth traffic.
          LC_ALL: "C",
          GIT_TRACE: "0",
          GIT_TRACE2: "0",
          GIT_TRACE_CURL: "0",
          GIT_CURL_VERBOSE: "0",
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
