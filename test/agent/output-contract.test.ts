import { describe, expect, it } from "vitest";
import { outputContractFor, outputPathFor } from "../../src/agent/output-contract.js";
import { CliProviderAdapter, CODEX_DIALECT, CLAUDE_DIALECT, defaultPrompt } from "../../src/agent/cli-provider.js";
import type { AgentRunRequest } from "../../src/agent/adapter.js";

function request(role: AgentRunRequest["role"]): AgentRunRequest {
  return {
    runId: "run_1",
    issueId: "ENG-1",
    role,
    attempt: 1,
    workingDirectory: "/tmp/ws",
    taskPacketPath: "/tmp/ws/.runmill/run/task.json",
    allowedPaths: ["src/**"],
    forbiddenPaths: [".runmill/**"],
    allowedCommands: [],
    network: "proxy",
    maxTurns: 10,
    timeoutMs: 1000,
  };
}

describe("output contract", () => {
  it("declares structured output for reviewer roles only", () => {
    expect(outputContractFor("local-reviewer")).toBeDefined();
    expect(outputContractFor("pr-reviewer")).toBeDefined();
    expect(outputContractFor("implementer")).toBeUndefined();
    expect(outputContractFor("fixer")).toBeUndefined();
  });

  it("resolves the same path for every adapter", () => {
    // The bug this guards: the real adapter gated outputRef on a request flag
    // the orchestrator never set, while the fake wrote output regardless. Every
    // review-gated test passed and every real run would have quarantined.
    const path = outputPathFor("/tmp/ws", "local-reviewer");
    expect(path).toBe("/tmp/ws/.runmill/run/local-reviewer-output.json");
    expect(outputPathFor("/tmp/ws", "implementer")).toBeUndefined();
  });

  it("tells the agent in its prompt where output must go and that malformed is not a pass", () => {
    const prompt = defaultPrompt(request("local-reviewer"));
    expect(prompt).toContain("local-reviewer-output.json");
    expect(prompt).toContain("review-findings@1");
    expect(prompt).toMatch(/malformed output is not a pass/i);
  });

  it("says nothing about output for roles that produce none", () => {
    expect(defaultPrompt(request("implementer"))).not.toContain("structured output");
  });
});

describe("provider capability parity", () => {
  it("reads capabilities from the dialect rather than switching on a name", async () => {
    const codex = await new CliProviderAdapter({ dialect: CODEX_DIALECT }).capabilities();
    const claude = await new CliProviderAdapter({ dialect: CLAUDE_DIALECT }).capabilities();
    expect(codex.sessionResume).toBe(false);
    expect(claude.sessionResume).toBe(true);
    expect(claude.costReporting).toBe(true);
  });

  it("the claude dialect maps usage rather than parsing and discarding it", () => {
    const event = CLAUDE_DIALECT.mapLine({
      type: "usage",
      usage: { input_tokens: 120, output_tokens: 45 },
      total_cost_usd: 0.31,
    });
    expect(event).toMatchObject({ type: "usage.updated", inputTokens: 120, costUsd: 0.31 });
  });

  it("a dialect that declares cost reporting must actually emit usage", () => {
    // Otherwise the cost circuit breaker measures a constant zero in
    // production while being fully exercised by the fake.
    for (const dialect of [CODEX_DIALECT, CLAUDE_DIALECT]) {
      if (!dialect.capabilities.costReporting) continue;
      const emitted = dialect.mapLine({
        type: "usage",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.01,
      });
      expect(emitted, `${dialect.name} declares costReporting`).toMatchObject({
        type: "usage.updated",
      });
    }
  });
});
