import { describe, expect, it } from "vitest";
import { parseConfig, validateConfig } from "../../src/config/load.js";
import { renderCreatedConfig, type ConfigAnswers } from "../../src/config/create.js";

const ANSWERS: ConfigAnswers = {
  autonomy: "pr-only",
  implementer: "codex",
  reviewer: "inherit",
  team: "ENG",
  eligibleStates: ["Todo", "Ready"],
  claimState: "In Progress",
  deliveredState: "In Review",
  completedState: "Done",
  repository: "acme/platform",
  baseBranch: "main",
  includeLabels: ["agent-ready"],
  excludeLabels: ["needs-design", "no-agent"],
  mergeMethod: "squash",
  maxWallMinutes: 240,
};

describe("configuration creator", () => {
  it("renders a valid configuration with conservative defaults", () => {
    const source = renderCreatedConfig(ANSWERS);
    const config = parseConfig(source);
    expect(validateConfig(config)).toEqual({ valid: true, errors: [] });
    expect(config.autonomy).toBe("pr-only");
    expect(config.github.draftPr).toBe(true);
    expect(config.workspace.gitIsolation).toBe("clone");
    expect(config.verification.failOnMissingCheck).toBe(true);
  });

  it("writes provider choices and models without writing credentials", () => {
    const source = renderCreatedConfig({
      ...ANSWERS,
      implementer: "claude",
      implementerModel: "sonnet",
      reviewer: "codex",
      reviewerModel: "review-model",
    });
    expect(source).toContain("implementation: claude");
    expect(source).toContain("model: sonnet");
    expect(source).toContain("implementation: codex");
    expect(source).not.toMatch(/api[_-]?key|token:/i);
  });
});
