import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionResumeUnsupportedError, type AgentRunRequest } from "../../src/agent/adapter.js";
import { FakeProviderAdapter } from "../../src/testing/fake-provider.js";

function request(): AgentRunRequest & { readonly sessionId: string } {
  return {
    runId: "run_fake_resume",
    issueId: "ENG-1",
    role: "implementer",
    attempt: 1,
    workingDirectory: "/workspace-that-must-not-be-opened",
    taskPacketPath: "/workspace-that-must-not-be-opened/task.json",
    allowedPaths: [],
    forbiddenPaths: [],
    allowedCommands: [],
    network: "none",
    maxTurns: 1,
    timeoutMs: 1_000,
    sessionId: "session-1",
  };
}

describe("FakeProviderAdapter", () => {
  it("is no more permissive than production about session resume", async () => {
    const provider = new FakeProviderAdapter();

    expect((await provider.capabilities()).sessionResume).toBe(false);
    await expect(provider.resume(request())).rejects.toBeInstanceOf(
      SessionResumeUnsupportedError,
    );
    expect(provider.startedRequests).toHaveLength(0);
  });

  it("cancels a pre-aborted request before observing workspace state", async () => {
    const provider = new FakeProviderAdapter();
    const controller = new AbortController();
    controller.abort();
    const { sessionId: _sessionId, ...base } = request();

    const session = await provider.start({ ...base, signal: controller.signal });

    await expect(session.result).resolves.toMatchObject({ status: "cancelled", events: [] });
    expect(provider.startedRequests).toHaveLength(0);
  });

  it("enforces the production structured-output ceiling", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "runmill-fake-provider-"));
    const provider = new FakeProviderAdapter({
      outputByRole: { "local-reviewer": { payload: "x".repeat(1024 * 1024 + 1) } },
    });
    try {
      const session = await provider.start({
        ...request(),
        role: "local-reviewer",
        workingDirectory: workspace,
        taskPacketPath: join(workspace, ".runmill", "run", "task.json"),
      });

      await expect(session.result).resolves.toMatchObject({
        status: "failure",
        outputRef: undefined,
        error: { class: "provider_internal", retryable: false },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
