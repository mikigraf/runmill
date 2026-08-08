import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { orchestratorRunner, prepareRepository } from "../../src/eval/orchestrator-runner.js";
import type { EvalTask } from "../../src/eval/suite.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runmill-eval-runner-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "history-replay",
    kind: "bug-fix",
    split: "development",
    issue: {
      identifier: "ENG-1",
      title: "Fix the fixture",
      description:
        "The current fixture demonstrates the historical behavior and needs a bounded correction.\n\n" +
        "Acceptance criteria:\n- the fixture is fixed",
      labels: [],
    },
    expected: "deliver",
    ...overrides,
  };
}

function makeRepository(): { source: string; first: string } {
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main", ".");
  git(source, "config", "user.email", "test@runmill.local");
  git(source, "config", "user.name", "runmill test");
  writeFileSync(join(source, "version.txt"), "one\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "first");
  const first = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "version.txt"), "two\n");
  git(source, "commit", "-q", "-am", "second");
  return { source, first };
}

describe("evaluation repository preparation", () => {
  it("clones a normal Git repository without copying a broken root .git directory", () => {
    const { source } = makeRepository();
    const prepared = prepareRepository(task({ repoPath: source }), join(root, "work"), undefined);
    expect(git(prepared, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(readFileSync(join(prepared, "version.txt"), "utf8")).toBe("two\n");
  });

  it("preserves source history and checks out the requested base commit", () => {
    const { source, first } = makeRepository();
    const prepared = prepareRepository(
      task({ repoPath: source, baseCommit: first }),
      join(root, "work"),
      undefined,
    );
    expect(git(prepared, "rev-parse", "HEAD")).toBe(first);
    expect(readFileSync(join(prepared, "version.txt"), "utf8")).toBe("one\n");
  });

  it("excludes a root .git entry when copying a non-repository fixture", () => {
    const source = join(root, "plain-fixture");
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, ".git", "incomplete"), "not metadata\n");
    writeFileSync(join(source, "README.md"), "fixture\n");
    const prepared = prepareRepository(task({ repoPath: source }), join(root, "work"), undefined);
    expect(git(prepared, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(existsSync(join(prepared, ".git", "incomplete"))).toBe(false);
  });
});

describe("live replay evidence", () => {
  it("reports the paths the agent actually changed", async () => {
    const { source } = makeRepository();
    const config = parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer: { implementation: codex }
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo]
  claim_state: In Progress
github:
  repositories:
    - match: { team: ENG }
      repo: acme/eval
      base_branch: main
workspace:
  git_isolation: clone
`);
    const attempt = await orchestratorRunner({ config, defaultRepoPath: source, demo: true })(
      task({ allowedPaths: ["src/"] }),
      1,
    );
    expect(attempt.changedPaths, JSON.stringify(attempt)).toBeDefined();
    expect(attempt.changedPaths).toContain("RUNMILL_DEMO.md");
    expect(attempt.changedPaths?.some((path) => path.startsWith(".runmill/run/"))).toBe(false);
  }, 60_000);
});
