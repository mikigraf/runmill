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
  delivered_state: In Review
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

  it("rejects linked-worktree isolation because its Git metadata is outside the sandbox", () => {
    expect(() =>
      parseConfig(`${MINIMAL}\nworkspace:\n  git_isolation: separate-git-dir\n`),
    ).toThrow(/Configuration is invalid/);
  });

  it("rejects the unimplemented container sandbox backend", () => {
    expect(() => parseConfig(`${MINIMAL}\nworkspace:\n  sandbox: container\n`)).toThrow(
      /Configuration is invalid/,
    );
  });

  it("rejects backlog providers without a live adapter", () => {
    expect(() =>
      parseConfig(MINIMAL.replace("provider: linear", "provider: github-issues")),
    ).toThrow(/Configuration is invalid/);
  });

  it("requires pr-only delivery to move the issue out of the eligible queue", () => {
    const config = parseConfig(MINIMAL.replace("  delivered_state: In Review\n", ""));
    expect(validateConfig(config).errors.join("\n")).toMatch(
      /pr-only requires backlog\.delivered_state/i,
    );
  });

  it.each([
    ["claim_state", "  claim_state: In Progress", "  claim_state: Todo"],
    ["delivered_state", "  delivered_state: In Review", "  delivered_state: Ready"],
    ["completed_state", "  delivered_state: In Review", "  delivered_state: In Review\n  completed_state: todo"],
  ])("rejects %s when it overlaps an eligible state", (_key, before, after) => {
    const config = parseConfig(MINIMAL.replace(before, after));
    expect(validateConfig(config).errors.join("\n")).toMatch(/must not overlap.*eligible_states/i);
  });

  it("rejects duplicate eligible state names without relying on case", () => {
    const config = parseConfig(MINIMAL.replace("[Todo, Ready]", "[Todo, todo]"));
    expect(validateConfig(config).errors.join("\n")).toMatch(/same Linear state more than once/i);
  });

  it("rejects dollar caps that a configured provider cannot report", () => {
    const cfg = parseConfig(`${MINIMAL}\nbudgets:\n  max_cost_usd_per_issue: 1\n`);
    expect(validateConfig(cfg).errors.join("\n")).toMatch(/Codex adapter does not/i);
  });

  it("rejects a dollar cap explicitly paired with wall-only enforcement", () => {
    const source = MINIMAL.replace("implementation: codex", "implementation: claude") +
      "\nbudgets:\n  max_cost_usd_per_issue: 1\n  cost_enforcement: wall-and-invocations-only\n";
    expect(validateConfig(parseConfig(source)).errors.join("\n")).toMatch(/cannot be combined/i);
  });

  it("rejects a daily dollar cap when a configured provider cannot report cost", () => {
    const cfg = parseConfig(`${MINIMAL}\nbudgets:\n  daily_cost_usd: 1\n`);
    expect(validateConfig(cfg).errors.join("\n")).toMatch(/Codex adapter does not/i);
  });

  it("rejects a daily dollar cap paired with wall-only enforcement", () => {
    const source = MINIMAL.replace("implementation: codex", "implementation: claude") +
      "\nbudgets:\n  daily_cost_usd: 1\n  cost_enforcement: wall-and-invocations-only\n";
    expect(validateConfig(parseConfig(source)).errors.join("\n")).toMatch(/cannot be combined/i);
  });

  it("tolerates a yaml-language-server schema header", () => {
    const cfg = parseConfig(
      `# yaml-language-server: $schema=https://raw.githubusercontent.com/mikigraf/runmill/main/runmill.schema.json\n${MINIMAL}`,
    );
    expect(cfg.version).toBe(1);
  });

  it("rejects misspelled authority and risk keys instead of defaulting them away", () => {
    const source = MINIMAL
      .replace("  claim_state: In Progress", "  claim_state: In Progress\n  include_label: [agent-ready]") +
      "\nrisk:\n  manual_approval:\n    path: [src/auth/**]\n";
    try {
      parseConfig(source);
      expect.unreachable("unknown policy keys must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RunmillError);
      const detail = (error as RunmillError).whatHappened;
      expect(detail).toContain("backlog.include_label");
      expect(detail).toContain("risk.manual_approval.path");
    }
  });

  it("rejects the wrong type rather than coercing it to a permissive default", () => {
    try {
      parseConfig(
        MINIMAL.replace(
          "  claim_state: In Progress",
          "  claim_state: In Progress\n  include_labels: agent-ready",
        ),
      );
      expect.unreachable("a scalar include_labels value must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RunmillError);
      expect((error as RunmillError).whatHappened).toMatch(/include_labels.*array/i);
    }
  });

  it.each([
    {
      key: "context",
      source: `${MINIMAL}\ncontext:\n  entry_files: [AGENTS.md]\n`,
    },
    {
      key: "blocked_state",
      source: MINIMAL.replace(
        "  claim_state: In Progress",
        "  claim_state: In Progress\n  blocked_state: Blocked",
      ),
    },
    {
      key: "delete_branch",
      source: MINIMAL.replace(
        "      base_branch: main",
        "      base_branch: main\n  merge:\n    delete_branch: true",
      ),
    },
    {
      key: "clean_untracked_files",
      source: `${MINIMAL}\nworkspace:\n  clean_untracked_files: true\n`,
    },
    {
      key: "changed_area_rules",
      source:
        `${MINIMAL}\nverification:\n  changed_area_rules:\n` +
        "    src/**:\n      additional_checks: [integration]\n",
    },
    {
      key: "stack_dependency_chains",
      source: MINIMAL.replace(
        "  repositories:",
        "  stack_dependency_chains: true\n  repositories:",
      ),
    },
    {
      key: "stack_max_depth",
      source: MINIMAL.replace(
        "  repositories:",
        "  stack_max_depth: 4\n  repositories:",
      ),
    },
  ])("rejects the unsupported $key setting instead of pretending to enforce it", ({ key, source }) => {
    try {
      parseConfig(source);
      expect.unreachable(`${key} must fail strict schema validation`);
    } catch (error) {
      expect(error).toBeInstanceOf(RunmillError);
      expect((error as RunmillError).whatHappened).toContain(key);
    }
  });
});

describe("validateConfig", () => {
  it("requires an automation identity when unassigned issues are excluded", () => {
    const cfg = parseConfig(
      MINIMAL.replace("  claim_state: In Progress", "  claim_state: In Progress\n  allow_unassigned: false"),
    );
    expect(validateConfig(cfg)).toMatchObject({ valid: false });
    expect(validateConfig(cfg).errors.join("\n")).toMatch(/claim_assignee/);
  });

  it("accepts a valid configuration", () => {
    expect(validateConfig(parseConfig(MINIMAL)).valid).toBe(true);
  });

  it("rejects an unknown autonomy mode", () => {
    const result = validateConfig({ ...parseConfig(MINIMAL), autonomy: "yolo" } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/autonomy/);
  });

  it("requires a second explicit gate for automatic merge modes", () => {
    const cfg = parseConfig(MINIMAL);
    const closed = validateConfig({ ...cfg, autonomy: "guarded-merge" });
    expect(closed.valid).toBe(false);
    expect(closed.errors.join(" ")).toMatch(/experimental\.automatic_merge/);

    const optedIn = validateConfig({
      ...cfg,
      autonomy: "guarded-merge",
      experimental: { automaticMerge: true },
    });
    expect(optedIn.valid).toBe(true);
  });

  it("requires proven local coverage in automatic-merge modes", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      autonomy: "guarded-merge",
      experimental: { automaticMerge: true },
      verification: { ...cfg.verification, failOnSkippedCheck: false },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/fail_on_skipped_check.*unproven/i);
  });

  it("rejects a network allowlist until hostname filtering is enforceable", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      workspace: { ...cfg.workspace, networkAllowlist: ["api.openai.com"] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/network_allowlist.*not enforceable/);
  });

  it("rejects network:none for a live delivery mode", () => {
    const cfg = parseConfig(`${MINIMAL}\nworkspace:\n  network: none\n`);
    const result = validateConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/network.*none.*observe/i);
  });

  it("accepts network:none only when observe means no provider runs", () => {
    const cfg = parseConfig(
      `${MINIMAL.replace("autonomy: pr-only", "autonomy: observe")}\nworkspace:\n  network: none\n`,
    );
    expect(validateConfig(cfg).valid).toBe(true);
  });

  it("rejects unknown or empty risk policy values before a run starts", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      risk: {
        default: "unknown" as never,
        manualApproval: {
          paths: [""],
          labels: [""],
          conditions: ["future_condition"],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/risk\.default/);
    expect(result.errors.join(" ")).toMatch(/manual_approval\.conditions/);
    expect(result.errors.join(" ")).toMatch(/manual_approval\.paths/);
    expect(result.errors.join(" ")).toMatch(/manual_approval\.labels/);
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

  it("rejects operator report declarations the verification engine cannot consume", () => {
    const cfg = parseConfig(MINIMAL);
    const result = validateConfig({
      ...cfg,
      verification: {
        ...cfg.verification,
        commands: [
          {
            id: "unit",
            run: "npm test",
            report: { path: "../outside.json", format: "made-up" },
          },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/report\.path.*inside/i);
    expect(result.errors.join(" ")).toMatch(/report\.format.*junit, tap, go-json/i);
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

  it("rejects routes to more than one repository from a single local checkout", () => {
    const cfg = parseConfig(
      MINIMAL.replace(
        "      base_branch: main",
        "      base_branch: main\n    - match: { project: mobile }\n      repo: acme/mobile\n      base_branch: main",
      ),
    );
    expect(validateConfig(cfg).errors.join("\n")).toMatch(/same owner\/name/i);
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
