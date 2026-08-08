/**
 * Credential resolution.
 *
 * The precedence order is the interesting part: an operator who exports a
 * variable to override a stale keychain entry must actually get the override,
 * and a run must never silently proceed with a credential the operator did not
 * intend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platform } from "node:os";

const runMock = vi.fn();
vi.mock("../../src/platform/process.js", () => ({ run: runMock }));

const { CredentialStore } = await import("../../src/credentials/store.js");
const { RunmillError } = await import("../../src/errors/runmill-error.js");

const ENV_KEYS = ["LINEAR_API_KEY", "GITHUB_TOKEN", "RUNMILL_POLICY_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Default: nothing found anywhere.
  runMock.mockResolvedValue({ ok: false, stdout: "", stderr: "", code: 1 });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
});

describe("get", () => {
  it("prefers an environment variable over the keychain", async () => {
    // An operator exporting a variable is making an explicit, immediate
    // decision; a keychain entry is ambient state that may be stale.
    process.env["LINEAR_API_KEY"] = "lin_api_from_env";
    runMock.mockResolvedValue({ ok: true, stdout: "lin_api_from_keychain", stderr: "", code: 0 });

    expect(await new CredentialStore().get("linear")).toBe("lin_api_from_env");
    expect(runMock).not.toHaveBeenCalled();
  });

  it("ignores an empty environment variable rather than treating it as a credential", async () => {
    // `export LINEAR_API_KEY=` is the shape of a mistake, not a secret.
    process.env["LINEAR_API_KEY"] = "";
    runMock.mockResolvedValue({ ok: true, stdout: "from_keychain", stderr: "", code: 0 });
    const value = await new CredentialStore().get("linear");
    expect(value).not.toBe("");
  });

  it("reads the keychain when no variable is set", async () => {
    if (platform() !== "darwin") return;
    runMock.mockResolvedValue({ ok: true, stdout: "  secret-value  \n", stderr: "", code: 0 });
    expect(await new CredentialStore().get("linear")).toBe("secret-value");
    expect(runMock.mock.calls[0]?.[0]).toBe("security");
    expect(runMock.mock.calls[0]?.[1]).toContain("runmill:linear");
  });

  it("falls back to `gh auth token` for github only", async () => {
    // gh is a well-known local source that is already authenticated. No other
    // credential has an equivalent, and inventing one would be a guess.
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { ok: true, stdout: "gho_token\n", stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "", code: 1 };
    });

    expect(await new CredentialStore().get("github")).toBe("gho_token");
    expect(await new CredentialStore().get("linear")).toBeUndefined();
  });

  it("returns undefined rather than an empty string when nothing resolves", async () => {
    expect(await new CredentialStore().get("linear")).toBeUndefined();
  });

  it("does not treat a successful command with empty output as a credential", async () => {
    runMock.mockResolvedValue({ ok: true, stdout: "   \n", stderr: "", code: 0 });
    expect(await new CredentialStore().get("linear")).toBeUndefined();
  });

  it("honours custom environment variable names", async () => {
    process.env["MY_LINEAR"] = "custom";
    try {
      const store = new CredentialStore({
        linear: "MY_LINEAR",
        github: "MY_GH",
        "runmill-policy": "MY_POLICY",
      });
      expect(await store.get("linear")).toBe("custom");
    } finally {
      delete process.env["MY_LINEAR"];
    }
  });
});

describe("require", () => {
  it("returns the value when one resolves", async () => {
    process.env["GITHUB_TOKEN"] = "ghp_x";
    expect(await new CredentialStore().require("github")).toBe("ghp_x");
  });

  it("raises RM-AUTH-003 naming every place it looked", async () => {
    // "No credential" without saying where it looked leaves the operator
    // guessing which of three sources they were supposed to populate.
    try {
      await new CredentialStore().require("linear");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      const e = err as InstanceType<typeof RunmillError>;
      expect(e.code).toBe("RM-AUTH-003");
      expect(e.whatHappened).toContain("LINEAR_API_KEY");
      expect(e.whatHappened).toContain("keychain");
    }
  });

  it("mentions gh only for the github credential", async () => {
    const store = new CredentialStore();
    const linearError = await store.require("linear").catch((e: unknown) => e);
    const githubError = await store.require("github").catch((e: unknown) => e);

    expect((githubError as InstanceType<typeof RunmillError>).whatHappened).toContain("gh auth token");
    expect((linearError as InstanceType<typeof RunmillError>).whatHappened).not.toContain("gh auth token");
  });
});

describe("set", () => {
  it("stores into the keychain on macOS with an update flag", async () => {
    if (platform() !== "darwin") return;
    runMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
    await new CredentialStore().set("linear", "lin_api_new");

    const [cmd, args] = runMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("security");
    expect(args).toContain("add-generic-password");
    // Without -U a second `auth login` fails instead of replacing the entry.
    expect(args).toContain("-U");
    expect(args).toContain("runmill:linear");
  });

  it("refuses on a platform with no keychain, and says what to do instead", async () => {
    if (platform() === "darwin") return;
    await expect(new CredentialStore().set("linear", "x")).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe("remove", () => {
  it("is idempotent — nothing stored is not an error", async () => {
    runMock.mockResolvedValue({ ok: false, stdout: "", stderr: "not found", code: 44 });
    await expect(new CredentialStore().remove("linear")).resolves.toBeUndefined();
  });

  it("targets the same service key that set uses", async () => {
    if (platform() !== "darwin") return;
    runMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
    await new CredentialStore().remove("github");
    expect(runMock.mock.calls[0]?.[1]).toContain("runmill:github");
  });
});

describe("what the store never does", () => {
  it("never passes a secret value as a shell string", async () => {
    // Every call is argv-form. A shell string containing a token would leak it
    // into process listings and shell history.
    if (platform() !== "darwin") return;
    runMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
    await new CredentialStore().set("linear", "secret with spaces && rm -rf /");
    for (const call of runMock.mock.calls) {
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[0]).not.toContain("secret");
    }
  });
});
