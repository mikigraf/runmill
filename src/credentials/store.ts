import { platform } from "node:os";
import { RunmillError } from "../errors/runmill-error.js";
import { run } from "../platform/process.js";

export type CredentialName = "linear" | "github" | "runmill-policy";

const SERVICE = "runmill";

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
      const keychain = await run("security", [
        "find-generic-password",
        "-s",
        `${SERVICE}:${name}`,
        "-w",
      ]);
      if (keychain.ok && keychain.stdout.trim() !== "") return keychain.stdout.trim();
    }

    // GitHub has a well-known local source that is already authenticated.
    if (name === "github") {
      const gh = await run("gh", ["auth", "token"]);
      if (gh.ok && gh.stdout.trim() !== "") return gh.stdout.trim();
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
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      `${SERVICE}:${name}`,
      "-a",
      SERVICE,
      "-w",
      value,
    ]);
  }

  async remove(name: CredentialName): Promise<void> {
    if (platform() !== "darwin") return;
    // Deleting is idempotent: nothing stored is not an error.
    await run("security", ["delete-generic-password", "-s", `${SERVICE}:${name}`]);
  }
}
