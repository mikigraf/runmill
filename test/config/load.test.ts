import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig, parseConfig } from "../../src/config/load.js";
import { RunmillError } from "../../src/errors/runmill-error.js";

let dir: string;

const MINIMAL = `
version: 1
autonomy: pr-only
provider:
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
    expect(cfg.workspace.gitIsolation).toBe("separate-git-dir");
    expect(cfg.budgets.maxAgentInvocations.total).toBeGreaterThan(0);
  });

  it("tolerates a yaml-language-server schema header", () => {
    const cfg = parseConfig(
      `# yaml-language-server: $schema=https://runmill.dev/runmill.schema.json\n${MINIMAL}`,
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
