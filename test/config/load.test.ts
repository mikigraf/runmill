import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig, parseConfig } from "../../src/config/load.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

let dir: string;

const MINIMAL = `
version: 1
autonomy: pr-only
providers:
  implementer:
    implementation: codex
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
github:
  repositories:
    - match: { team: ENG }
      repo: acme/platform
      base_branch: main
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("parseConfig", () => {
  it("parses a minimal valid configuration", () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.autonomy).toBe("pr-only");
    expect(cfg.github.repositories[0]?.repo).toBe("acme/platform");
  });

  it("applies documented defaults rather than leaving values undefined", () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.github.branchTemplate).toContain("{attempt}");
    expect(cfg.workspace.sandbox).toBe("native");
    expect(cfg.workspace.gitIsolation).toBe("clone");
    expect(cfg.budgets.maxAgentInvocations.total).toBeGreaterThan(0);
  });

  it("defaults git isolation to the mode WorkspaceManager considers safe", () => {
    // These two defaults drifted apart: WorkspaceManager documents `clone` as
    // the default and explains why (a linked worktree shares `.git` with the
    // parent, so granting write access hands the agent `.git/hooks/pre-commit`
    // and code execution in the orchestrator's context). parseConfig defaulted
    // to `separate-git-dir` and the orchestrator passed it through, so the safe
    // default never applied to a single real run.
    const fromConfig = parseConfig(MINIMAL).workspace.gitIsolation;
    expect(fromConfig).toBe("clone");

    const manager = readFileSync("src/workspace/manager.ts", "utf8");
    const managerDefault = manager.match(/input\.isolation \?\? "([a-z-]+)"/)?.[1];
    expect(fromConfig, "config default must match WorkspaceManager's").toBe(managerDefault);
  });

  it("tolerates a yaml-language-server schema header", () => {
    const cfg = parseConfig(
      `# yaml-language-server: $schema=https://raw.githubusercontent.com/mikigraf/runmill/main/runmill.schema.json\n${MINIMAL}`,
    );
    expect(cfg.version).toBe(1);
  });
});

describe("validateConfig", () => {
  it("accepts a valid configuration", () => {
    expect(validateConfig(parseConfig(MINIMAL)).valid).toBe(true);
  });

  it("rejects an unknown autonomy mode", () => {
    const result = validateConfig({ ...parseConfig(MINIMAL), autonomy: "yolo" } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/autonomy/);
  });

  it("rejects a branch template without {attempt}", () => {
    // Without it a retry reuses the prior run's branch and silently adopts
    // that run's pull request via GitHub's 422 duplicate path.
    const cfg = parseConfig(MINIMAL);
    const broken = {
      ...cfg,
      github: { ...cfg.github, branchTemplate: "runmill/{issue_identifier}" },
    };
    const result = validateConfig(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/attempt/);
  });

  it("rejects an empty repository rule list", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({ ...cfg, github: { ...cfg.github, repositories: [] } });
    expect(result.valid).toBe(false);
  });

  it("rejects max_fix_iterations exceeding the fixer invocation budget", () => {
    // A cross-field constraint the schema alone cannot express: the fix loop
    // would exhaust its budget mid-flight.
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      review: { ...cfg.review, maxFixIterations: 99 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/max_fix_iterations|fixer/i);
  });

  it("rejects a repository rule set with conflicting rules", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      github: {
        ...cfg.github,
        repositories: [
          { match: { team: "ENG" }, repo: "acme/a", baseBranch: "main" },
          { match: { team: "ENG" }, repo: "acme/b", baseBranch: "main" },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/identical match/i);
  });

  it("reports every violation, not just the first", () => {
    const result = validateConfig({
      ...parseConfig(MINIMAL),
      autonomy: "nope",
      version: 99,
    } as never);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe("loadConfig", () => {
  it("loads and validates from disk", () => {
    const path = write("runmill.yaml", MINIMAL);
    const { config } = loadConfig(path, { repoRoot: dir });
    expect(config.backlog.team).toBe("ENG");
  });

  it("throws RM-CONFIG-001 with the violations for an invalid file", () => {
    const path = write("runmill.yaml", "version: 1\nautonomy: nope\n");
    try {
      loadConfig(path, { repoRoot: dir });
      expect.unreachable("should reject an invalid config");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      expect((err as RunmillError).code).toBe("RM-CONFIG-001");
      expect((err as RunmillError).whatHappened).toMatch(/autonomy/);
    }
  });

  it("throws RM-CONFIG-002 when a referenced review skill is missing", () => {
    // FR-22: this must fail at load, not at LOCAL_REVIEW after real spend.
    const path = write(
      "runmill.yaml",
      `${MINIMAL}\nreview:\n  local_review_skill: .runmill/skills/code-review.md\n`,
    );
    try {
      loadConfig(path, { repoRoot: dir });
      expect.unreachable("should reject a missing referenced file");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      expect((err as RunmillError).code).toBe("RM-CONFIG-002");
      expect((err as RunmillError).whatHappened).toMatch(/code-review\.md/);
    }
  });

  it("distinguishes no-config-at-all from a bad reference inside one", () => {
    // The very first error a new developer can hit. It was reported as
    // RM-CONFIG-002 ("referenced file does not exist"), whose remedies —
    // `runmill skills eject`, `runmill config validate` — cannot possibly
    // help when there is no config yet. Wrong advice on first contact is
    // more expensive than any later error.
    try {
      loadConfig(join(dir, "absent.yaml"), { repoRoot: dir });
      expect.unreachable("should reject a missing config file");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      const e = err as RunmillError;
      expect(e.code).toBe("RM-CONFIG-003");
      expect(e.fixes.some((f) => f.command === "runmill init")).toBe(true);
    }
  });

  it("accepts a referenced review skill that exists", () => {
    mkdirSync(join(dir, ".runmill", "skills"), { recursive: true });
    writeFileSync(join(dir, ".runmill", "skills", "code-review.md"), "---\nname: x\n---\n");
    const path = write(
      "runmill.yaml",
      `${MINIMAL}\nreview:\n  local_review_skill: .runmill/skills/code-review.md\n`,
    );
    expect(() => loadConfig(path, { repoRoot: dir })).not.toThrow();
  });

  it("reports every missing referenced path at once", () => {
    const path = write(
      "runmill.yaml",
      `${MINIMAL}\nreview:\n  local_review_skill: a.md\n  pr_review_skill: b.md\n`,
    );
    try {
      loadConfig(path, { repoRoot: dir });
      expect.unreachable();
    } catch (err) {
      expect((err as RunmillError).whatHappened).toMatch(/a\.md/);
      expect((err as RunmillError).whatHappened).toMatch(/b\.md/);
    }
  });
});

describe("the providers block", () => {
  it("defaults the reviewer to inherit", () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.providers.implementer.implementation).toBe("codex");
    expect(cfg.providers.reviewer.implementation).toBe("inherit");
  });

  it("reads a model for each role independently", () => {
    const cfg = parseConfig(
      MINIMAL.replace(
        "providers:\n  implementer:\n    implementation: codex",
        [
          "providers:",
          "  implementer:",
          "    implementation: codex",
          "    model: fast",
          "  reviewer:",
          "    implementation: inherit",
          "    model: strong",
        ].join("\n"),
      ),
    );
    expect(cfg.providers.implementer.model).toBe("fast");
    expect(cfg.providers.reviewer.model).toBe("strong");
  });

  it("keeps max_turns and timeout_minutes shared by both roles", () => {
    const cfg = parseConfig(
      MINIMAL.replace("providers:", "providers:\n  max_turns: 12\n  timeout_minutes: 5"),
    );
    expect(cfg.providers.maxTurns).toBe(12);
    expect(cfg.providers.timeoutMinutes).toBe(5);
  });

  it("rejects `inherit` for the implementer, which has nothing to inherit from", () => {
    const cfg = parseConfig(MINIMAL);
    const broken = {
      ...cfg,
      providers: { ...cfg.providers, implementer: { implementation: "inherit" as never } },
    };
    expect(validateConfig(broken).valid).toBe(false);
  });

  it("names the replacement when it finds the old provider/review.provider shape", () => {
    // Parsing an old file to all-defaults would silently run codex on
    // everything, which is the worst kind of migration: it looks like it worked.
    try {
      // The old shape: a `provider:` key and no `providers:`.
      parseConfig(
        MINIMAL.replace(
          "providers:\n  implementer:\n    implementation: codex",
          "provider:\n  implementation: claude",
        ),
      );
      expect.unreachable("should reject the old shape");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      const e = err as RunmillError;
      expect(e.whatHappened).toContain("providers:");
      expect(e.whatHappened).toContain("implementer:");
      expect(e.whatHappened).toContain("reviewer:");
    }
  });
});
