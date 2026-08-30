import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitMock, tryGitMock } = vi.hoisted(() => ({
  gitMock: vi.fn(),
  tryGitMock: vi.fn(),
}));
vi.mock("../../src/platform/git.js", () => ({ git: gitMock, tryGit: tryGitMock }));

const { FakeForgeAdapter } = await import("../../src/testing/fake-forge.js");

const input = {
  repo: "acme/widget",
  branch: "runmill/ENG-1",
  workspacePath: "/workspace",
};

beforeEach(() => {
  gitMock.mockReset();
  tryGitMock.mockReset();
});

describe("FakeForgeAdapter push", () => {
  it("does not record a branch or candidate head when Git rejects the push", async () => {
    gitMock.mockResolvedValue("candidate-sha");
    tryGitMock.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "remote rejected the update",
      code: 1,
    });
    const adapter = new FakeForgeAdapter();

    await expect(adapter.push(input)).rejects.toMatchObject({
      name: "ForgeError",
      retryable: false,
    });

    expect(adapter.wasPushed(input.repo, input.branch)).toBe(false);
    await expect(
      adapter.openPullRequest({
        repo: input.repo,
        branch: input.branch,
        baseBranch: "main",
        title: "test",
        body: "test",
        draft: true,
      }),
    ).rejects.toThrow(/before .* is confirmed on the remote/u);

    const pushArgs = tryGitMock.mock.calls[0]?.[1] as string[];
    expect(pushArgs).toContain("--no-verify");
    expect(pushArgs).not.toContain("--force");
  });

  it("records the applied state before simulating a lost push response", async () => {
    gitMock.mockResolvedValue("candidate-sha");
    tryGitMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
    const adapter = new FakeForgeAdapter({ applyThenTimeout: new Set(["push"]) });

    await expect(adapter.push(input)).rejects.toMatchObject({
      name: "ForgeError",
      retryable: true,
    });

    expect(adapter.wasPushed(input.repo, input.branch)).toBe(true);
    const pullRequest = await adapter.openPullRequest({
      repo: input.repo,
      branch: input.branch,
      baseBranch: "main",
      title: "test",
      body: "test",
      draft: true,
    });
    expect(pullRequest.headSha).toBe("candidate-sha");
  });
});
