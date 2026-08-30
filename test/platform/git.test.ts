import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const runBytesMock = vi.fn();
const runOrThrowMock = vi.fn();

vi.mock("../../src/platform/process.js", () => ({
  run: runMock,
  runBytes: runBytesMock,
  runOrThrow: runOrThrowMock,
}));

const { git, tryGit, tryGitBytes } = await import("../../src/platform/git.js");

beforeEach(() => {
  vi.clearAllMocks();
  runOrThrowMock.mockResolvedValue("ok");
  runMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
  runBytesMock.mockResolvedValue({
    ok: true,
    stdout: Buffer.alloc(0),
    stderr: "",
    code: 0,
  });
});

describe("Git process boundary", () => {
  it("prefixes every shared wrapper before caller config and subcommands", async () => {
    const callerArgs = ["-c", "core.hooksPath=/dev/null", "status", "--short"];

    await git("/repo", callerArgs);
    await tryGit("/repo", callerArgs);
    await tryGitBytes("/repo", callerArgs, 1_024);

    for (const mock of [runOrThrowMock, runMock, runBytesMock]) {
      expect(mock.mock.calls[0]?.[1]).toEqual([
        "--no-lazy-fetch",
        "--no-replace-objects",
        ...callerArgs,
      ]);
    }
  });
});
