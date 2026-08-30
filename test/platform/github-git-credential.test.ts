import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitMock, tryGitMock } = vi.hoisted(() => ({
  gitMock: vi.fn(),
  tryGitMock: vi.fn(),
}));

vi.mock("../../src/platform/git.js", () => ({
  git: gitMock,
  tryGit: tryGitMock,
}));

const { GitHubGitCredential } = await import(
  "../../src/platform/github-git-credential.js"
);

const missingConfig = { ok: false, stdout: "", stderr: "", code: 1 } as const;

beforeEach(() => {
  gitMock.mockReset();
  tryGitMock.mockReset();
});

describe("GitHubGitCredential transport boundary", () => {
  it("refuses empty credentials and plaintext enterprise endpoints", () => {
    expect(() => new GitHubGitCredential({ token: "" })).toThrow(/non-empty/u);
    expect(
      () =>
        new GitHubGitCredential({
          token: "github_pat_private",
          baseUrl: "http://github.enterprise.example/api/v3",
        }),
    ).toThrow(/HTTPS API base URL/u);
  });

  it("refuses a same-protocol URL rewrite before exposing the credential", async () => {
    tryGitMock.mockImplementation(async (_cwd: string, args: readonly string[]) => {
      if (args[0] !== "config") throw new Error("credentialed Git execution was reached");
      if (args[1] === "--local") {
        return {
          ok: true,
          stdout:
            "url.https://attacker.invalid/.insteadof https://github.com/\n",
          stderr: "",
          code: 0,
        };
      }
      return missingConfig;
    });
    const credential = new GitHubGitCredential({ token: "github_pat_private" });

    await expect(
      credential.tryGit("/repo", [
        "fetch",
        credential.repositoryUrl("acme/widget"),
        "refs/heads/main",
      ]),
    ).rejects.toThrow(/refuses a URL affected by url\.\*\.insteadOf policy/u);
    expect(tryGitMock.mock.calls.some((call) => call[1].includes("fetch"))).toBe(false);
  });

  it("allows an unrelated rewrite and keeps the credential out of argv", async () => {
    const token = "github_pat_private";
    tryGitMock.mockImplementation(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "config") {
        return args[1] === "--global"
          ? {
              ok: true,
              stdout: "url.ssh://git@gitlab.example/.insteadof https://gitlab.example/\n",
              stderr: "",
              code: 0,
            }
          : missingConfig;
      }
      expect(args.join("\0")).not.toContain(token);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    const credential = new GitHubGitCredential({ token });

    await expect(
      credential.tryGit("/repo", [
        "push",
        credential.repositoryUrl("acme/widget"),
        "HEAD:refs/heads/runmill/test",
      ]),
    ).resolves.toMatchObject({ ok: true });
    expect(tryGitMock.mock.calls.some((call) => call[1].includes("push"))).toBe(true);
  });

  it("refuses to attach the credential to a named or foreign remote", async () => {
    const credential = new GitHubGitCredential({ token: "github_pat_private" });

    await expect(credential.git("/repo", ["fetch", "origin", "main"]))
      .rejects.toThrow(/requires one exact HTTPS URL/u);
    await expect(credential.git("/repo", ["fetch", "https://example.invalid/x/y.git", "main"]))
      .rejects.toThrow(/requires one exact HTTPS URL/u);
    expect(tryGitMock).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
  });
});
