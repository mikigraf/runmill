import { platform } from "node:os";
import { RunmillError } from "../errors/runmill-error.js";
import { run, runWithInput } from "../platform/process.js";

export type CredentialName = "linear" | "github" | "runmill-policy";

const SERVICE = "runmill";
const CREDENTIAL_PROCESS_TIMEOUT_MS = 15_000;

/**
 * Credential storage.
 *
 * Secrets live in the OS keychain, never in repository files and never in a
 * task packet. The worker sandbox denies the keychain outright, so a credential
 * read here can only ever happen in the orchestrator process.
 *
 * Environment variables are honoured as a fallback because CI-like and
 * headless hosts have no keychain — but they are read only by the control
 * plane, and the sandbox strips them from every child environment.
 */
export class CredentialStore {
  readonly #envOverrides: Readonly<Record<CredentialName, string>>;

  constructor(
    envOverrides: Readonly<Record<CredentialName, string>> = {
      linear: "LINEAR_API_KEY",
      github: "GITHUB_TOKEN",
      "runmill-policy": "RUNMILL_POLICY_KEY",
    },
  ) {
    this.#envOverrides = envOverrides;
  }

  async get(name: CredentialName): Promise<string | undefined> {
    const envName = this.#envOverrides[name];
    const fromEnv = process.env[envName];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

    if (platform() === "darwin") {
      const keychain = await run(
        "security",
        ["find-generic-password", "-s", `${SERVICE}:${name}`, "-w"],
        { timeoutMs: CREDENTIAL_PROCESS_TIMEOUT_MS },
      );
      if (keychain.ok) {
        const value = keychain.stdout.trim();
        if (value !== "") return value;
        throw new Error(`macOS keychain returned an empty ${name} credential`);
      }
      // errSecItemNotFound is the only definitive absence. A locked keychain,
      // timeout, denial, or I/O error must not silently select a lower-priority
      // credential belonging to a different account.
      if (keychain.code !== 44) {
        const reason =
          keychain.code === null ? "timed out or could not start" : `exited ${keychain.code}`;
        throw new Error(`could not read ${name} from the macOS keychain (${reason})`);
      }
    }

    // GitHub has a well-known local source that is already authenticated.
    if (name === "github") {
      const gh = await run("gh", ["auth", "token"], {
        timeoutMs: CREDENTIAL_PROCESS_TIMEOUT_MS,
      });
      if (gh.ok) {
        const value = gh.stdout.trim();
        if (value !== "") return value;
        throw new Error("`gh auth token` succeeded without returning a GitHub credential");
      }
      const detail = `${gh.stderr}\n${gh.stdout}`;
      const definitivelyAbsent =
        (gh.code === 1 &&
          /not logged|not authenticated|no (?:oauth )?token|no accounts?/iu.test(detail)) ||
        (gh.code === null && /\bENOENT\b|not found/iu.test(detail));
      if (!definitivelyAbsent) {
        const reason = gh.code === null ? "timed out or could not start" : `exited ${gh.code}`;
        throw new Error(`could not read GitHub credential from \`gh auth token\` (${reason})`);
      }
    }

    return undefined;
  }

  async require(name: CredentialName): Promise<string> {
    const value = await this.get(name);
    if (value === undefined) {
      throw RunmillError.fromCatalog("RM-AUTH-003", {
        whatHappened:
          `No credential found for "${name}".\n` +
          `Looked in: $${this.#envOverrides[name]}, the OS keychain` +
          (name === "github" ? ", and `gh auth token`" : "") +
          ".",
      });
    }
    return value;
  }

  async set(name: CredentialName, value: string): Promise<void> {
    if (platform() !== "darwin") {
      throw new Error(
        `keychain storage is only implemented on macOS; set $${this.#envOverrides[name]} instead`,
      );
    }
    if (value === "" || /[\0\r\n]/u.test(value)) {
      throw new Error("keychain credentials must be non-empty and contain no line break or NUL byte");
    }

    // `security -w <value>` exposes the value in the process argument list.
    // With -w last it prompts twice; a detached child has no controlling TTY,
    // so both answers arrive only through this private stdin pipe.
    const result = await runWithInput("security", [
      "add-generic-password",
      "-U",
      "-s",
      `${SERVICE}:${name}`,
      "-a",
      SERVICE,
      "-w",
    ], `${value}\n${value}\n`, {
      detached: true,
      // A locked keychain can otherwise leave setup waiting on an OS prompt
      // that this deliberately non-interactive child can never answer.
      timeoutMs: CREDENTIAL_PROCESS_TIMEOUT_MS,
    });
    if (!result.ok) {
      const rawDetail =
        result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
      let detail = rawDetail;
      for (const representation of new Set([
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
        Buffer.from(`x-access-token:${value}`).toString("base64"),
      ])) {
        detail = detail.split(representation).join("<redacted>");
      }
      throw new Error(`could not store ${name} in the macOS keychain: ${detail}`);
    }
  }

  async remove(name: CredentialName): Promise<void> {
    const envName = this.#envOverrides[name];
    if (process.env[envName] !== undefined && process.env[envName] !== "") {
      throw new Error(
        `the active ${name} credential is supplied by $${envName}; unset $${envName} before logout`,
      );
    }
    if (platform() !== "darwin") {
      throw new Error(
        `keychain removal is only implemented on macOS; unset $${envName} instead`,
      );
    }
    // Deleting is idempotent: nothing stored is not an error.
    const result = await run("security", ["delete-generic-password", "-s", `${SERVICE}:${name}`], {
      timeoutMs: CREDENTIAL_PROCESS_TIMEOUT_MS,
    });
    if (result.ok || result.code === 44) return;
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`could not remove ${name} from the macOS keychain: ${detail}`);
  }
}
