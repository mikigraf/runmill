import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig, validateConfig } from "../../src/config/load.js";
import {
  createConfiguration,
  renderCreatedConfig,
  type ConfigAnswers,
  type DiscoveredSetup,
} from "../../src/config/create.js";

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

const DISCOVERED_WITHOUT_SERVICE_CREDENTIALS: DiscoveredSetup = {
  repository: "acme/platform",
  baseBranch: "main",
  repositories: [{ repo: "acme/platform", baseBranch: "main" }],
  providers: [
    { implementation: "codex", installed: true, authenticated: true },
    { implementation: "claude", installed: false, authenticated: false },
  ],
  linearTeams: [],
  linearCredential: false,
  githubAuthenticated: false,
};

function scriptedPrompter(answers: readonly string[]): {
  readonly prompts: string[];
  readonly prompter: {
    question(prompt: string): Promise<string>;
    close(): void;
  };
  readonly closed: () => boolean;
} {
  const remaining = [...answers];
  const prompts: string[] = [];
  let isClosed = false;
  return {
    prompts,
    prompter: {
      question: async (prompt) => {
        prompts.push(prompt);
        return remaining.shift() ?? "";
      },
      close: () => {
        isClosed = true;
      },
    },
    closed: () => isClosed,
  };
}

describe("configuration creator", () => {
  it("renders a valid configuration with conservative defaults", () => {
    const source = renderCreatedConfig(ANSWERS);
    const config = parseConfig(source);
    expect(validateConfig(config)).toEqual({ valid: true, errors: [] });
    expect(config.autonomy).toBe("pr-only");
    expect(config.github.draftPr).toBe(true);
    expect(config.workspace.gitIsolation).toBe("clone");
    expect(config.verification.failOnMissingCheck).toBe(true);
    expect(config.verification.failOnSkippedCheck).toBe(false);
    expect(source).not.toMatch(
      /blocked_state|delete_branch|clean_untracked_files|^context:/m,
    );
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

  it("does not turn a merge-mode selection into its own safety acknowledgement", () => {
    const source = renderCreatedConfig({
      ...ANSWERS,
      autonomy: "guarded-merge",
    });
    expect(source).not.toContain("automatic_merge");
    expect(validateConfig(parseConfig(source)).valid).toBe(false);
  });

  it("writes the experimental gate only after a separate acknowledgement", () => {
    const source = renderCreatedConfig({
      ...ANSWERS,
      autonomy: "guarded-merge",
      automaticMergeAcknowledged: true,
    });
    expect(source).toContain("automatic_merge: true");
    const config = parseConfig(source);
    expect(config.verification.failOnSkippedCheck).toBe(true);
    expect(validateConfig(config)).toEqual({ valid: true, errors: [] });
  });

  it("uses only workflow states returned for the discovered Linear team", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-config-linear-"));
    const discovered: DiscoveredSetup = {
      ...DISCOVERED_WITHOUT_SERVICE_CREDENTIALS,
      linearCredential: true,
      linearTeams: [
        {
          key: "PLAT",
          name: "Platform",
          states: ["Queue", "Building", "Under review", "Shipped"],
          stateTypes: {
            Queue: "unstarted",
            Building: "started",
            "Under review": "started",
            Shipped: "completed",
          },
        },
      ],
    };
    try {
      const created = await createConfiguration({
        root: directory,
        path: join(directory, "policy.yaml"),
        defaults: true,
        credentials: { get: async () => undefined },
        discover: async () => discovered,
      });
      const config = parseConfig(created.config);
      expect(config.backlog).toMatchObject({
        team: "PLAT",
        eligibleStates: ["Queue"],
        claimState: "Building",
        deliveredState: "Under review",
        completedState: "Shipped",
      });
      expect(created.config).not.toContain("REPLACE_WITH_LINEAR");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never asks an interactive terminal for GitHub or Linear secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-config-secure-"));
    const terminal = scriptedPrompter(Array.from({ length: 11 }, () => ""));
    const output: string[] = [];
    const runInteractive = vi.fn(() => ({ status: 0 }));
    try {
      const created = await createConfiguration({
        root: directory,
        path: join(directory, "policy.yaml"),
        credentials: { get: async () => undefined },
        discover: async () => DISCOVERED_WITHOUT_SERVICE_CREDENTIALS,
        prompter: terminal.prompter,
        writeOutput: (message) => output.push(message),
        runInteractive,
      });

      expect(terminal.prompts.join("\n")).not.toMatch(
        /token|api key|credential|password|secret/i,
      );
      expect(runInteractive).not.toHaveBeenCalled();
      expect(output.join("")).toContain("This wizard never asks for tokens");
      expect(output.join("")).toContain("export GITHUB_TOKEN");
      expect(output.join("")).toContain(
        "printenv GITHUB_TOKEN | runmill auth login github",
      );
      expect(output.join("")).toContain("Export LINEAR_API_KEY");
      expect(output.join("")).toContain(
        "printenv LINEAR_API_KEY | runmill auth login linear",
      );
      expect(created.config).toContain("REPLACE_WITH_LINEAR_TEAM");
      expect(created.config).not.toMatch(/team: ENG|\[Todo, Ready\]|claim_state: In Progress/);
      expect(terminal.closed()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("can delegate GitHub sign-in to gh and then re-run discovery without handling a token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-config-gh-"));
    const terminal = scriptedPrompter([
      "2",
      ...Array.from({ length: 10 }, () => ""),
    ]);
    const authenticated: DiscoveredSetup = {
      ...DISCOVERED_WITHOUT_SERVICE_CREDENTIALS,
      githubAuthenticated: true,
    };
    let discoveries = 0;
    const runInteractive = vi.fn(() => ({ status: 0 }));
    try {
      await createConfiguration({
        root: directory,
        path: join(directory, "policy.yaml"),
        credentials: { get: async () => undefined },
        discover: async () => {
          discoveries += 1;
          return discoveries === 1
            ? DISCOVERED_WITHOUT_SERVICE_CREDENTIALS
            : authenticated;
        },
        prompter: terminal.prompter,
        writeOutput: () => undefined,
        runInteractive,
      });

      expect(runInteractive).toHaveBeenCalledTimes(1);
      expect(runInteractive).toHaveBeenCalledWith("gh", ["auth", "login"]);
      expect(JSON.stringify(runInteractive.mock.calls)).not.toMatch(
        /ghp_|github_pat_|token=/i,
      );
      expect(discoveries).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails safely when delegated gh sign-in does not complete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runmill-config-gh-fail-"));
    const terminal = scriptedPrompter(["2"]);
    try {
      await expect(
        createConfiguration({
          root: directory,
          path: join(directory, "policy.yaml"),
          credentials: { get: async () => undefined },
          discover: async () => DISCOVERED_WITHOUT_SERVICE_CREDENTIALS,
          prompter: terminal.prompter,
          writeOutput: () => undefined,
          runInteractive: () => ({ status: 1 }),
        }),
      ).rejects.toThrow(/gh auth login did not complete successfully/);
      expect(terminal.prompts.join("\n")).not.toMatch(
        /token|api key|credential|password|secret/i,
      );
      expect(terminal.closed()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
