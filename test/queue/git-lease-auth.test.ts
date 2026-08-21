import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitMock, tryGitMock } = vi.hoisted(() => ({ gitMock: vi.fn(), tryGitMock: vi.fn() }));
vi.mock("../../src/platform/git.js", () => ({ git: gitMock, tryGit: tryGitMock }));

const { GitHubGitCredential } = await import("../../src/platform/github-git-credential.js");
const { GitRefLease } = await import("../../src/queue/git-lease.js");
const { FakeClock } = await import("../../src/testing/fake-clock.js");

beforeEach(() => {
  gitMock.mockReset();
  tryGitMock.mockReset();
});

describe("Git-ref lease GitHub authentication", () => {
  it("uses the resolved token through askpass for the exact repository URL", async () => {
    const token = "github_pat_lease/private-value";
    const encoded = Buffer.from(token).toString("base64");
    const encodedBasic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const credential = new GitHubGitCredential({ token });
    let helper = "";

    gitMock.mockImplementation(async (_cwd: string, args: string[], options: any) => {
      if (args.includes("commit-tree")) return "a".repeat(40);
      if (args.includes("push")) {
        helper = options.env.GIT_ASKPASS;
        const argv = ["git", ...args].join("\0");
        expect(argv).toContain("https://github.com/acme/widget.git");
        expect(argv).toContain("credential.helper=");
        expect(argv).toContain("core.hooksPath=/dev/null");
        expect(argv).not.toContain(token);
        expect(argv).not.toContain(encodeURIComponent(token));
        expect(argv).not.toContain(encoded);
        expect(argv).not.toContain(encodedBasic);
        expect(await readFile(helper, "utf8")).not.toContain(token);
        expect(options.env.RUNMILL_GIT_ASKPASS_PASSWORD).toBe(token);
        return "";
      }
      return "";
    });

    const lease = new GitRefLease({
      cwd: "/source",
      runId: "run_1",
      clock: new FakeClock("2026-08-21T12:00:00Z"),
      ttlMinutes: 20,
      hostId: "host",
      pid: 42,
      remote: credential.repositoryUrl("acme/widget"),
      credential,
    });

    await lease.acquire("ENG-42");

    expect(helper).not.toBe("");
    await expect(access(helper)).rejects.toThrow();
    await expect(access(dirname(helper))).rejects.toThrow();
  });

  it("does not expose the token when an authenticated lease operation fails", async () => {
    const token = "github_pat_lease-failure";
    const encoded = Buffer.from(token).toString("base64");
    const credential = new GitHubGitCredential({ token });

    gitMock.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args.includes("commit-tree")) return "b".repeat(40);
      if (args.includes("ls-remote")) return "";
      throw new Error(`remote denied ${token} ${encoded}`);
    });

    const lease = new GitRefLease({
      cwd: "/source",
      runId: "run_2",
      clock: new FakeClock("2026-08-21T12:00:00Z"),
      ttlMinutes: 20,
      hostId: "host",
      pid: 42,
      remote: credential.repositoryUrl("acme/widget"),
      credential,
    });

    const failure = await lease.acquire("ENG-43").then(
      () => new Error("expected lease acquisition to fail"),
      (error: unknown) => error as Error,
    );

    expect(failure.message).not.toContain(token);
    expect(failure.message).not.toContain(encoded);
  });
});
