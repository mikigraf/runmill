import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitMock, tryGitMock } = vi.hoisted(() => ({ gitMock: vi.fn(), tryGitMock: vi.fn() }));
vi.mock("../../src/platform/git.js", () => ({ git: gitMock, tryGit: tryGitMock }));

const { GitHubForgeAdapter } = await import("../../src/pr/github.js");

const token = "github_pat_private-test/value";
const encodedToken = Buffer.from(token).toString("base64");
const encodedBasicCredential = Buffer.from(`x-access-token:${token}`).toString("base64");

function push(adapter = new GitHubForgeAdapter({ token })): Promise<void> {
  return adapter.push({
    repo: "acme/widget",
    branch: "runmill/LIN-42",
    workspacePath: "/worktree",
  });
}

async function expectRemoved(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
  await expect(access(dirname(path))).rejects.toThrow();
}

beforeEach(() => {
  tryGitMock.mockReset();
});

describe("GitHub push credentials", () => {
  it("keeps every token representation out of Git argv and removes the private askpass helper", async () => {
    let askpassPath = "";
    tryGitMock.mockImplementation(async (_cwd: string, args: string[], options: any) => {
      const gitArgv = ["git", ...args];
      const renderedArgv = gitArgv.join("\0");
      expect(renderedArgv).not.toContain(token);
      expect(renderedArgv).not.toContain(encodeURIComponent(token));
      expect(renderedArgv).not.toContain(encodedToken);
      expect(renderedArgv).not.toContain(encodedBasicCredential);
      expect(renderedArgv).not.toContain("http.extraheader");
      expect(renderedArgv).toContain("credential.helper=");
      expect(renderedArgv).toContain("core.hooksPath=/dev/null");
      expect(renderedArgv).toContain("--no-verify");
      expect(renderedArgv).toContain("https://github.com/acme/widget.git");

      askpassPath = options.env.GIT_ASKPASS;
      const helper = await readFile(askpassPath, "utf8");
      expect(helper).not.toContain(token);
      expect(helper).not.toContain(encodedToken);
      expect(helper).not.toContain(encodedBasicCredential);
      expect((await stat(askpassPath)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(askpassPath))).mode & 0o777).toBe(0o700);
      expect(options.env.RUNMILL_GIT_ASKPASS_PASSWORD).toBe(token);
      expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");

      return { ok: true, stdout: "", stderr: "", code: 0 };
    });

    await push();

    expect(askpassPath).not.toBe("");
    await expectRemoved(askpassPath);
  });

  it("derives an Enterprise clone URL without putting credentials in it", async () => {
    let argv: string[] = [];
    let askpassPath = "";
    tryGitMock.mockImplementation(async (_cwd: string, args: string[], options: any) => {
      argv = ["git", ...args];
      askpassPath = options.env.GIT_ASKPASS;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });

    await push(
      new GitHubForgeAdapter({
        token,
        baseUrl: "https://github.enterprise.example/scm/api/v3/",
      }),
    );

    expect(argv).toContain("https://github.enterprise.example/scm/acme/widget.git");
    expect(argv.join("\0")).not.toContain(token);
    await expectRemoved(askpassPath);
  });

  it("redacts failed-push diagnostics and cleans the helper", async () => {
    let askpassPath = "";
    tryGitMock.mockImplementation(async (_cwd: string, _args: string[], options: any) => {
      askpassPath = options.env.GIT_ASKPASS;
      return {
        ok: false,
        stdout: "",
        stderr: `remote rejected ${token} ${encodedToken} ${encodedBasicCredential}`,
        code: 1,
      };
    });

    const failure = await push().then(
      () => {
        throw new Error("expected push to fail");
      },
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain("push failed");
    expect(failure.message).not.toContain(token);
    expect(failure.message).not.toContain(encodedToken);
    expect(failure.message).not.toContain(encodedBasicCredential);
    await expectRemoved(askpassPath);
  });

  it("cleans the helper and redacts diagnostics when Git execution is cancelled", async () => {
    let askpassPath = "";
    tryGitMock.mockImplementation(async (_cwd: string, _args: string[], options: any) => {
      askpassPath = options.env.GIT_ASKPASS;
      throw new Error(`cancelled while using ${token} (${encodedBasicCredential})`);
    });

    const failure = await push().then(
      () => {
        throw new Error("expected push to fail");
      },
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain("cancelled");
    expect(failure.message).not.toContain(token);
    expect(failure.message).not.toContain(encodedBasicCredential);
    await expectRemoved(askpassPath);
  });
});
